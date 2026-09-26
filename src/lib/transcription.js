// Live-transcription helpers shared by the offscreen recorder, the service
// worker, the Meet content script, and unit tests. Pure functions only: the
// WebSockets live in src/offscreen/offscreen.js.
//
// Transcription is the SipPulse AI streaming gateway, over a /v1/listen
// WebSocket (mono only). The recorder opens one stream per source: channel 0
// is the collaborator's microphone, channel 1 is the Meet tab (every remote
// participant). The gateway does not diarize, so remote segments are named
// one by one from Google Meet captions.

(function (root) {
  const ns = (root.MeetVcon = root.MeetVcon || {});
  if (ns.transcription) return;

  const MIC_CHANNEL = 0;
  const TAB_CHANNEL = 1;
  const CHANNELS = [MIC_CHANNEL, TAB_CHANNEL];
  const UNKNOWN_REMOTE = "Participant";
  // Rough speaking rate, used only when the gateway sends no timing.
  const SECONDS_PER_WORD = 0.4;
  const MERGE_GAP_SEC = 1.2;
  // The gateway sometimes cuts a sentence in two with no pause between the
  // halves; rejoin those even when the voice is unknown.
  const SPLIT_GAP_SEC = 0.3;
  const MERGE_MAX_SEC = 45;
  // Meet's own caption label for the local participant, by UI language.
  const SELF_CAPTION_LABELS = new Set(["you", "você", "voce", "tú", "tu", "usted", "vous", "du", "sie"]);

  // Everything about the gateway except its URL, which is configured.
  const PROFILE = Object.freeze({
    provider: "sippulse_ai",
    label: "SipPulse AI streaming, Portuguese",
    model: "pulse-stt-streaming-v1",
    // The model is multilingual, but the gateway accepts only pt-BR|pt.
    language: "pt-BR",
    sampleRate: 8_000,
    // Only parameters the gateway documents; it clamps endpointing to
    // [560, 1500] ms and rejects unknown languages.
    params: Object.freeze({ endpointing: "700" }),
  });

  function listenUrl(streamBase) {
    const params = new URLSearchParams({
      model: PROFILE.model,
      language: PROFILE.language,
      encoding: "linear16",
      sample_rate: String(PROFILE.sampleRate),
      channels: "1",
      interim_results: "true",
      ...PROFILE.params,
    });
    return `${streamBase}/v1/listen?${params}`;
  }

  // Key check for the options page. Only 401 means the key itself is wrong.
  async function checkKey(fetchImpl, { apiBase, apiKey }) {
    if (!apiKey || !apiBase) return { ok: false, error: "Not configured" };
    try {
      const response = await fetchImpl(`${apiBase}/v1/openai/models`, { headers: { "api-key": apiKey } });
      if (response.status === 401) return { ok: false, status: 401, error: "Key rejected" };
      return response.ok
        ? { ok: true, status: response.status }
        : { ok: false, status: response.status, error: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  // The X-SipPulse-Transcription-Source value, and the delivery status.
  const sourceLabel = ({ recovered = false } = {}) =>
    recovered ? `${PROFILE.provider}_live_recovered` : `${PROFILE.provider}_live`;

  function mostCommon(values) {
    const counts = new Map();
    let best = null;
    for (const value of values) {
      if (!value) continue;
      const count = (counts.get(value) || 0) + 1;
      counts.set(value, count);
      if (!best || count > counts.get(best)) best = value;
    }
    return best;
  }

  function speakerOf(word) {
    return Number.isInteger(word?.speaker) ? word.speaker : null;
  }

  function wordsToSegment(words, channel, offsetSec) {
    const text = words.map((word) => word.punctuated_word || word.word).join(" ").trim();
    const confidence =
      words.reduce((sum, word) => sum + (Number(word.confidence) || 0), 0) / words.length;
    return {
      channel,
      speaker: speakerOf(words[0]),
      text,
      start: round(offsetSec + words[0].start),
      end: round(offsetSec + words[words.length - 1].end),
      confidence: round(confidence),
      language: mostCommon(words.map((word) => word.language)) || null,
    };
  }

  function round(value) {
    return Math.round(value * 1000) / 1000;
  }

  // Interpret one server message for the stream carrying `channel`.
  // offsetSec is the audio position at which the current connection started,
  // so segments keep one timeline across reconnects; nowSec is the current
  // audio position, used to place a final that arrives without timing.
  function parseMessage(message, { channel, offsetSec = 0, nowSec = offsetSec } = {}) {
    if (!message || message.type !== "Results") {
      return { kind: message?.type === "UtteranceEnd" ? "utterance_end" : "ignored" };
    }
    const alternative = message.channel?.alternatives?.[0] || {};
    const transcript = (alternative.transcript || "").trim();
    if (!message.is_final) {
      return { kind: "interim", channel, text: transcript };
    }
    const words = (Array.isArray(alternative.words) ? alternative.words : []).filter(
      (word) => Number.isFinite(word.start) && Number.isFinite(word.end)
    );
    if (!words.length) {
      if (!transcript) return { kind: "final", channel, segments: [] };
      const timed = Number.isFinite(message.start) && Number.isFinite(message.duration);
      const end = timed ? offsetSec + message.start + message.duration : nowSec;
      const start = timed
        ? offsetSec + message.start
        : Math.max(offsetSec, end - transcript.split(/\s+/).length * SECONDS_PER_WORD);
      return {
        kind: "final",
        channel,
        segments: [
          {
            channel,
            speaker: null,
            text: transcript,
            start: round(start),
            end: round(end),
            confidence: Number.isFinite(alternative.confidence) ? round(alternative.confidence) : null,
            language: null,
          },
        ],
      };
    }
    const segments = [];
    let run = [];
    for (const word of words) {
      if (run.length && speakerOf(run[run.length - 1]) !== speakerOf(word)) {
        segments.push(wordsToSegment(run, channel, offsetSec));
        run = [];
      }
      run.push(word);
    }
    if (run.length) segments.push(wordsToSegment(run, channel, offsetSec));
    return { kind: "final", channel, segments: segments.filter((segment) => segment.text) };
  }

  // Append a final segment, merging it into the latest segment from the same
  // voice when the pause is short. Returns the stored (possibly merged)
  // segment; ids are stable so the in-call view can upsert.
  function appendSegment(list, segment, nextId) {
    for (let i = list.length - 1; i >= 0; i--) {
      const previous = list[i];
      if (previous.channel !== segment.channel) continue;
      // Undiarized remote speech may be a different person each time, unless
      // it continues a sentence the previous segment left unfinished.
      const gap = segment.start - previous.end;
      const unfinished = !/[.!?…]$/.test(previous.text);
      const sameVoice =
        previous.speaker === segment.speaker &&
        (segment.channel === MIC_CHANNEL || segment.speaker !== null || (unfinished && gap <= SPLIT_GAP_SEC));
      const closeEnough = gap <= MERGE_GAP_SEC;
      const shortEnough = segment.end - previous.start <= MERGE_MAX_SEC;
      // Only the most recent segment of this channel may absorb new speech,
      // and only if nothing from the other channel was said in between.
      const interrupted = list.slice(i + 1).some((other) => other.start < segment.start);
      if (sameVoice && closeEnough && shortEnough && !interrupted) {
        previous.text = `${previous.text} ${segment.text}`.trim();
        previous.end = segment.end;
        if (Number.isFinite(previous.confidence) && Number.isFinite(segment.confidence)) {
          previous.confidence = round((previous.confidence + segment.confidence) / 2);
        }
        previous.language = previous.language || segment.language;
        return previous;
      }
      break;
    }
    const stored = { id: nextId, ...segment };
    list.push(stored);
    return stored;
  }

  // Without diarization each remote segment is its own voice to name.
  function speakerKey(segment) {
    if (segment.channel === MIC_CHANNEL) return "mic";
    return segment.speaker === null ? `segment:${segment.id ?? segment.start}` : `tab:${segment.speaker}`;
  }

  function normalizeWords(text) {
    return String(text || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length > 1);
  }

  function similarity(a, b) {
    const left = new Set(normalizeWords(a));
    const right = new Set(normalizeWords(b));
    if (!left.size || !right.size) return 0;
    let shared = 0;
    for (const word of left) if (right.has(word)) shared++;
    return shared / Math.min(left.size, right.size);
  }

  // Without headphones, remote speech leaks from the speakers into the
  // microphone. Drop microphone segments that repeat overlapping tab speech.
  function dropEcho(segments) {
    const tab = segments.filter((segment) => segment.channel === TAB_CHANNEL);
    return segments.filter((segment) => {
      if (segment.channel !== MIC_CHANNEL) return true;
      return !tab.some(
        (other) =>
          other.start < segment.end + 1 &&
          segment.start < other.end + 1 &&
          similarity(segment.text, other.text) >= 0.6
      );
    });
  }

  // Vote remote voices (or single segments) onto Google Meet caption names
  // by time overlap. captions: [{ speaker, start (ISO), duration (s) }].
  function resolveSpeakerNames(segments, captions, streamStartedAtMs) {
    const votes = new Map();
    const usable = (captions || [])
      .filter((caption) => caption.speaker && caption.speaker !== "unknown")
      .filter((caption) => !SELF_CAPTION_LABELS.has(caption.speaker.trim().toLowerCase()))
      .map((caption) => {
        const start = Date.parse(caption.start);
        // Captions render ~1 s after speech begins.
        return {
          name: caption.speaker,
          start: start - 1500,
          end: start + Math.max(1, Number(caption.duration) || 0) * 1000,
        };
      })
      .filter((caption) => Number.isFinite(caption.start));

    for (const segment of segments) {
      if (segment.channel !== TAB_CHANNEL) continue;
      const key = speakerKey(segment);
      const start = streamStartedAtMs + segment.start * 1000;
      const end = streamStartedAtMs + segment.end * 1000;
      for (const caption of usable) {
        const overlap = Math.min(end, caption.end) - Math.max(start, caption.start);
        if (overlap <= 0) continue;
        const tally = votes.get(key) || new Map();
        tally.set(caption.name, (tally.get(caption.name) || 0) + overlap);
        votes.set(key, tally);
      }
    }

    const names = new Map();
    for (const [key, tally] of votes) {
      const total = [...tally.values()].reduce((sum, value) => sum + value, 0);
      const [bestName, bestScore] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
      if (bestScore / total >= 0.4) names.set(key, bestName);
    }
    return names;
  }

  function displayNameFromEmail(email) {
    const local = String(email || "").split("@")[0];
    if (!local) return "Me";
    return local
      .split(/[._-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  // Turn stream-relative segments into the named, absolute-time utterances
  // that vcon.assemble() and the analysis prompt consume.
  function toUtterances(segments, { streamStartedAt, captions = [], collaborator = null } = {}) {
    const startedMs = Date.parse(streamStartedAt);
    if (!Number.isFinite(startedMs)) return [];
    const cleaned = dropEcho([...(segments || [])].sort((a, b) => a.start - b.start));
    const names = resolveSpeakerNames(cleaned, captions, startedMs);
    const selfName = displayNameFromEmail(collaborator?.email);
    const anonymous = new Map();
    const nameFor = (segment) => {
      const key = speakerKey(segment);
      if (key === "mic") return selfName;
      if (names.has(key)) return names.get(key);
      if (segment.speaker === null) return UNKNOWN_REMOTE;
      if (!anonymous.has(key)) anonymous.set(key, `Speaker ${anonymous.size + 1}`);
      return anonymous.get(key);
    };
    return cleaned.map((segment) => {
      const utterance = {
        segment_id: segment.id ?? null,
        speaker: nameFor(segment),
        text: segment.text,
        start: new Date(startedMs + segment.start * 1000).toISOString(),
        duration: round(Math.max(0, segment.end - segment.start)),
        channel: segment.channel === MIC_CHANNEL ? "microphone" : "meeting",
      };
      if (segment.channel === MIC_CHANNEL && collaborator?.email) utterance.email = collaborator.email;
      if (segment.language) utterance.language = segment.language;
      if (Number.isFinite(segment.confidence)) utterance.confidence = segment.confidence;
      return utterance;
    });
  }

  // Talk-time analytics per speaker, comparable to read.ai's speaker stats.
  // Unnamed remote speech is excluded: it may be several people.
  function speakerStats(utterances) {
    const bySpeaker = new Map();
    let total = 0;
    let previous = null;
    for (const utterance of utterances || []) {
      const name = utterance.speaker || "unknown";
      if (name === UNKNOWN_REMOTE) continue;
      const seconds = Math.max(0, Number(utterance.duration) || 0);
      const words = normalizeWords(utterance.text).length;
      const entry = bySpeaker.get(name) || {
        speaker: name,
        talk_seconds: 0,
        words: 0,
        turns: 0,
        longest_turn_seconds: 0,
        questions: 0,
        _run: 0,
      };
      entry.talk_seconds += seconds;
      entry.words += words;
      entry.questions += (String(utterance.text).match(/\?/g) || []).length;
      if (previous !== name) {
        entry.turns++;
        entry._run = 0;
      }
      entry._run += seconds;
      entry.longest_turn_seconds = Math.max(entry.longest_turn_seconds, entry._run);
      bySpeaker.set(name, entry);
      total += seconds;
      previous = name;
    }
    return [...bySpeaker.values()]
      .map(({ _run, ...entry }) => ({
        ...entry,
        talk_seconds: round(entry.talk_seconds),
        longest_turn_seconds: round(entry.longest_turn_seconds),
        talk_share: total ? round(entry.talk_seconds / total) : 0,
        words_per_minute: entry.talk_seconds ? Math.round((entry.words / entry.talk_seconds) * 60) : 0,
      }))
      .sort((a, b) => b.talk_seconds - a.talk_seconds);
  }

  function clock(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  // "[mm:ss] Name: text" lines, relative to the meeting start.
  function transcriptText(utterances, meetingStartedAt) {
    const base = Date.parse(meetingStartedAt || utterances?.[0]?.start);
    return (utterances || [])
      .filter((utterance) => utterance.text)
      .map((utterance) => {
        const offset = (Date.parse(utterance.start) - base) / 1000;
        return `[${clock(Number.isFinite(offset) ? offset : 0)}] ${utterance.speaker}: ${utterance.text}`;
      })
      .join("\n");
  }

  ns.transcription = {
    CHANNELS,
    MIC_CHANNEL,
    TAB_CHANNEL,
    UNKNOWN_REMOTE,
    PROFILE,
    listenUrl,
    checkKey,
    sourceLabel,
    parseMessage,
    appendSegment,
    dropEcho,
    resolveSpeakerNames,
    displayNameFromEmail,
    toUtterances,
    speakerStats,
    transcriptText,
    clock,
  };
})(typeof self !== "undefined" ? self : window);
