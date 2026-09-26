// Live meeting capture, started only by an explicit user action. The
// collaborator's microphone (channel 0) and the Meet tab audio (channel 1)
// each stream as mono linear16 over their own /v1/listen WebSocket to the
// SipPulse AI streaming gateway; no audio is
// stored. Final transcript segments and periodic
// SipPulse AI notes are sent to the service worker as "live_update" messages,
// which it relays to the Meet tab. When the meeting ends, the final transcript
// and report are reported back as "ai_session_result", so the worker never
// has to stay alive while the streams flush or the analysis runs.

const { transcription, analysis, classification } = self.MeetVcon;
const CLOSE_STREAM = JSON.stringify({ type: "CloseStream" });

const MAX_PENDING_BUFFERS = 600; // ~60 s of audio while reconnecting
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];
const CLOSE_TIMEOUT_MS = 10_000;
const LIVE_MIN_NEW_WORDS = 25;
const FINAL_ANALYSIS_ATTEMPTS = 2;
// Merged segments keep growing; classify once the speaker pauses.
const CLASSIFY_DEBOUNCE_MS = 900;
const CLASSIFY_CONCURRENCY = 4;
const CLASSIFY_DRAIN_MS = 8_000;
// "final" mode classifies the whole meeting at once: ~300 ms per line, four
// at a time, so an hour of talk fits well inside this.
const CLASSIFY_FINAL_MS = 120_000;

let session = null;

function post(type, payload) {
  return chrome.runtime.sendMessage({ type, ...payload }).catch((error) => {
    console.warn("[SipPulse Meet] could not reach the service worker", type, error?.message);
  });
}

function emit(current, update) {
  post("live_update", { meetingId: current.meetingId, update });
}

async function openStreams(streamId) {
  let tabStream;
  try {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false,
    });
  } catch (error) {
    return { error: { ok: false, error: `Tab audio capture failed: ${error.message}`, code: "tab_capture" } };
  }

  // Offscreen documents cannot show permission prompts. The popup opens
  // src/permissions/microphone.html first so this call finds an existing grant.
  try {
    const microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    return { tabStream, microphoneStream };
  } catch (error) {
    tabStream.getTracks().forEach((track) => track.stop());
    const denied = error.name === "NotAllowedError" || error.name === "SecurityError";
    return {
      error: {
        ok: false,
        error: denied
          ? "Microphone access has not been granted to SipPulse Meet Capture"
          : `Microphone unavailable: ${error.message}`,
        code: denied ? "microphone_permission" : "microphone",
      },
    };
  }
}

async function buildAudioGraph(current) {
  // tabCapture mutes the tab; play remote audio back at full quality through
  // a separate context so the 8 kHz capture context does not degrade it.
  current.playback = new AudioContext();
  current.playback.createMediaStreamSource(current.tabStream).connect(current.playback.destination);

  const { sampleRate } = current.profile;
  const context = new AudioContext({ sampleRate });
  await context.audioWorklet.addModule("pcm-worklet.js");
  const merger = context.createChannelMerger(transcription.CHANNELS.length);
  context.createMediaStreamSource(current.microphoneStream).connect(merger, 0, transcription.MIC_CHANNEL);
  context.createMediaStreamSource(current.tabStream).connect(merger, 0, transcription.TAB_CHANNEL);
  const encoder = new AudioWorkletNode(context, "pcm-encoder", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: transcription.CHANNELS.length,
    channelCountMode: "explicit",
    channelInterpretation: "discrete",
    processorOptions: { framesPerBuffer: sampleRate / 10 },
  });
  merger.connect(encoder);
  encoder.port.onmessage = (event) => {
    sendAudio(current, current.streams[transcription.MIC_CHANNEL], event.data.mic);
    sendAudio(current, current.streams[transcription.TAB_CHANNEL], event.data.tab);
  };
  current.context = context;
  current.encoder = encoder;
}

// ---- transcription streams (one per channel) -------------------------------

function framesIn(buffer) {
  return buffer.byteLength / 2;
}

function positionSec(current, stream) {
  return stream.framesSent / current.profile.sampleRate;
}

function sendAudio(current, stream, buffer) {
  if (stream.socket?.readyState === WebSocket.OPEN) {
    stream.socket.send(buffer);
    stream.framesSent += framesIn(buffer);
    return;
  }
  stream.pending.push(buffer);
  if (stream.pending.length > MAX_PENDING_BUFFERS) {
    // Dropped audio still advances the timeline so later speech keeps its time.
    stream.framesSent += framesIn(stream.pending.shift());
  }
}

function connect(current, stream) {
  const socket = new WebSocket(transcription.listenUrl(current.config.transcription.streamBase), [
    "token",
    current.config.transcription.apiKey,
  ]);
  socket.binaryType = "arraybuffer";
  stream.socket = socket;
  let offsetSec = 0;

  socket.addEventListener("open", () => {
    offsetSec = positionSec(current, stream);
    stream.failures = 0;
    emitStatus(current, stream, "connected");
    while (stream.pending.length) {
      const buffer = stream.pending.shift();
      socket.send(buffer);
      stream.framesSent += framesIn(buffer);
    }
    if (current.stopping || current.tabEnded) socket.send(CLOSE_STREAM);
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    const result = transcription.parseMessage(message, {
      channel: stream.channel,
      offsetSec,
      nowSec: positionSec(current, stream),
    });
    handleResult(current, result);
  });

  socket.addEventListener("close", (event) => {
    if (stream.socket !== socket) return;
    stream.socket = null;
    if (current.stopping || current.tabEnded) {
      stream.closed?.();
      return;
    }
    const delay = RECONNECT_DELAYS_MS[Math.min(stream.failures, RECONNECT_DELAYS_MS.length - 1)];
    stream.failures++;
    emitStatus(
      current,
      stream,
      stream.failures >= 3 ? "error" : "reconnecting",
      event.reason || `Transcription connection closed (${event.code})`
    );
    stream.reconnectTimer = setTimeout(() => {
      if (session === current && !current.stopping) connect(current, stream);
    }, delay);
  });
}

// The panel shows one status: the worst of the two streams.
function emitStatus(current, stream, state, error = "") {
  stream.state = state;
  const states = Object.values(current.streams).map((entry) => entry.state);
  const worst = ["error", "reconnecting", "connected"].find((candidate) => states.includes(candidate));
  emit(current, { kind: "transcription_status", state: worst, error });
}

function handleResult(current, result) {
  if (result.kind === "interim") {
    emit(current, { kind: "interim", channel: result.channel, text: result.text });
    return;
  }
  if (result.kind !== "final") return;
  for (const segment of result.segments) {
    const stored = transcription.appendSegment(current.segments, segment, current.nextId);
    if (stored.id === current.nextId) current.nextId++;
    current.words += segment.text.split(/\s+/).length;
    emit(current, { kind: "segment", segment: stored });
    // In "final" mode nothing is classified until the call ends.
    if (current.config.analysis.mode === "live") scheduleClassification(current, stored.id);
  }
  emit(current, { kind: "interim", channel: result.channel, text: "" });
}

function closeStream(current, stream) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
    stream.closed = () => {
      clearTimeout(timer);
      resolve();
    };
    clearTimeout(stream.reconnectTimer);
    const socket = stream.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(CLOSE_STREAM);
    } else if (!socket && stream.pending.length && !current.tabEnded) {
      // Audio buffered during an outage: one last connection to flush it.
      connect(current, stream);
    } else if (!socket) {
      clearTimeout(timer);
      resolve();
    }
    // A socket still connecting sends CloseStream from its open handler.
  });
}

function closeStreams(current) {
  return Promise.all(Object.values(current.streams).map((stream) => closeStream(current, stream)));
}

// ---- inline classification (Jev) --------------------------------------------

function scheduleClassification(current, id) {
  if (!current.config.typesafeApiKey) return;
  clearTimeout(current.classifyTimers.get(id));
  current.classifyTimers.set(
    id,
    setTimeout(() => {
      current.classifyTimers.delete(id);
      if (!current.classifyQueue.includes(id)) current.classifyQueue.push(id);
      pumpClassification(current);
    }, CLASSIFY_DEBOUNCE_MS)
  );
}

// During the call remote voices have no name yet; at the end they do, and
// Jev reads better with the real name in the state.
function speakerHint(current, segment) {
  const resolved = current.namesBySegment?.[segment.id];
  if (resolved) return resolved;
  return segment.channel === transcription.MIC_CHANNEL
    ? transcription.displayNameFromEmail(current.collaborator?.email)
    : transcription.UNKNOWN_REMOTE;
}

function pumpClassification(current) {
  while (current.classifyInFlight < CLASSIFY_CONCURRENCY && current.classifyQueue.length) {
    const id = current.classifyQueue.shift();
    const index = current.segments.findIndex((segment) => segment.id === id);
    if (index === -1) continue;
    const segment = current.segments[index];
    const previous = current.segments[index - 1];
    const text = segment.text;
    current.classifyInFlight++;
    classification
      .classify({
        fetch: (...args) => fetch(...args),
        apiBase: current.config.classification.apiBase,
        apiKey: current.config.typesafeApiKey,
        model: current.config.classification.model,
        speaker: speakerHint(current, segment),
        text,
        previous: previous && { speaker: speakerHint(current, previous), text: previous.text },
      })
      .then((result) => {
        // A newer classification of the grown segment is already queued.
        if (!result.ok || segment.text !== text) return;
        current.classifications[id] = result.classification;
        emit(current, { kind: "classification", id, classification: result.classification });
      })
      .catch((error) => console.warn("[SipPulse Meet] classification", error))
      .finally(() => {
        current.classifyInFlight--;
        pumpClassification(current);
        if (!current.classifyInFlight && !current.classifyQueue.length) current.classifyIdle?.();
      });
  }
}

// At the end of the call: classify what is still waiting ("live" mode) or
// every line at once ("final" mode, the default). Bounded in time either way.
function drainClassification(current, { all = false, budgetMs = CLASSIFY_DRAIN_MS } = {}) {
  if (!current.config.typesafeApiKey) return Promise.resolve();
  for (const [id, timer] of current.classifyTimers) {
    clearTimeout(timer);
    if (!current.classifyQueue.includes(id)) current.classifyQueue.push(id);
  }
  current.classifyTimers.clear();
  if (all) {
    for (const segment of current.segments) {
      if (current.classifications[segment.id]) continue;
      if (!current.classifyQueue.includes(segment.id)) current.classifyQueue.push(segment.id);
    }
  }
  pumpClassification(current);
  if (!current.classifyInFlight && !current.classifyQueue.length) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, budgetMs);
    current.classifyIdle = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

// ---- analysis --------------------------------------------------------------

function utterancesFor(current) {
  return transcription.toUtterances(current.segments, {
    streamStartedAt: current.streamStartedAt,
    captions: current.captions,
    collaborator: current.collaborator,
  });
}

function analysisInput(current, utterances) {
  const stats = transcription.speakerStats(utterances);
  return {
    transcript: transcription.transcriptText(utterances, current.meetingStartedAt),
    subject: current.subject,
    participants: stats.map((entry) => entry.speaker),
    stats,
  };
}

function analyze(current, kind, input) {
  return analysis.analyze({
    fetch: (...args) => fetch(...args),
    apiBase: current.config.analysis.apiBase,
    apiKey: current.config.sippulseAiApiKey,
    model: kind === "live" ? current.config.analysis.liveModel : current.config.analysis.model,
    kind,
    ...input,
  });
}

async function runLiveAnalysis(current) {
  if (current.analysisInFlight || current.stopping) return;
  if (current.words - current.analyzedWords < LIVE_MIN_NEW_WORDS) return;
  current.analysisInFlight = true;
  const words = current.words;
  try {
    const utterances = utterancesFor(current);
    const result = await analyze(current, "live", {
      previous: current.liveAnalysis,
      ...analysisInput(current, utterances),
    });
    if (session !== current || current.stopping) return;
    if (result.ok) {
      current.liveAnalysis = result.analysis;
      current.analyzedWords = words;
      emit(current, { kind: "analysis", analysis: result.analysis, at: new Date().toISOString() });
    } else {
      emit(current, { kind: "analysis_status", error: result.error });
    }
  } finally {
    current.analysisInFlight = false;
  }
}

async function runFinalAnalysis(current, utterances) {
  let last = { ok: false, error: "Analysis not attempted" };
  for (let attempt = 0; attempt < FINAL_ANALYSIS_ATTEMPTS; attempt++) {
    last = await analyze(current, "final", analysisInput(current, utterances));
    const status = last.status || 0;
    if (last.ok || (status >= 400 && status < 500 && status !== 429)) break;
  }
  return last;
}

// ---- lifecycle -------------------------------------------------------------

async function startCapture(message) {
  if (session) {
    return { ok: false, error: "Another meeting is already being captured", code: "busy" };
  }
  if (!message.config?.transcription?.apiKey || !message.config?.transcription?.streamBase) {
    return { ok: false, error: "Live transcription is not configured", code: "not_configured" };
  }
  const streams = await openStreams(message.streamId);
  if (streams.error) return streams.error;

  const current = {
    meetingId: message.meetingId,
    config: message.config,
    subject: message.subject || "",
    meetingStartedAt: message.meetingStartedAt || null,
    collaborator: message.collaborator || null,
    captions: message.captions || [],
    tabStream: streams.tabStream,
    microphoneStream: streams.microphoneStream,
    profile: transcription.PROFILE,
    streamStartedAt: new Date().toISOString(),
    streams: Object.fromEntries(
      transcription.CHANNELS.map((channel) => [
        channel,
        { channel, socket: null, pending: [], framesSent: 0, failures: 0, state: null },
      ])
    ),
    segments: [],
    nextId: 1,
    classifications: {},
    classifyTimers: new Map(),
    classifyQueue: [],
    classifyInFlight: 0,
    words: 0,
    analyzedWords: 0,
    liveAnalysis: null,
    analysisInFlight: false,
    stopping: false,
  };
  try {
    await buildAudioGraph(current);
  } catch (error) {
    await releaseAudio(current);
    return { ok: false, error: `Audio pipeline failed: ${error.message}`, code: "audio_graph" };
  }
  session = current;
  for (const stream of Object.values(current.streams)) connect(current, stream);

  // If the Meet tab closes or crashes, flush both streams, stop reconnecting,
  // and tell the worker: the tab's own call_ended may never have been sent.
  current.tabStream.getAudioTracks().forEach((track) => {
    track.addEventListener("ended", () => {
      if (session !== current || current.stopping) return;
      current.tabEnded = true;
      current.encoder.port.onmessage = null;
      for (const stream of Object.values(current.streams)) {
        clearTimeout(stream.reconnectTimer);
        if (stream.socket?.readyState === WebSocket.OPEN) stream.socket.send(CLOSE_STREAM);
      }
      post("ai_tab_ended", { meetingId: current.meetingId });
    });
  });

  if (current.config.sippulseAiApiKey && current.config.analysis.mode === "live") {
    current.analysisTimer = setInterval(
      () => runLiveAnalysis(current).catch((error) => console.warn("[SipPulse Meet] live analysis", error)),
      current.config.analysis.liveIntervalMs
    );
  }
  return { ok: true, streamStartedAt: current.streamStartedAt };
}

async function releaseAudio(current) {
  if (current.encoder) current.encoder.port.onmessage = null;
  current.tabStream?.getTracks().forEach((track) => track.stop());
  current.microphoneStream?.getTracks().forEach((track) => track.stop());
  await current.context?.close().catch(() => {});
  await current.playback?.close().catch(() => {});
}

async function finish(current) {
  await closeStreams(current);
  const live = current.config.analysis.mode === "live";
  current.namesBySegment = Object.fromEntries(
    utterancesFor(current).map((utterance) => [utterance.segment_id, utterance.speaker])
  );
  await drainClassification(current, live ? {} : { all: true, budgetMs: CLASSIFY_FINAL_MS });
  const utterances = utterancesFor(current);
  if (!utterances.length) {
    return { ok: false, error: "Live transcription returned no speech" };
  }
  const stats = transcription.speakerStats(utterances);
  const result = {
    ok: true,
    streamStartedAt: current.streamStartedAt,
    transcription: {
      provider: current.config.transcription.provider,
      model: current.profile.model,
      language: current.profile.language,
    },
    utterances,
    stats,
    classifications: current.classifications,
    classificationModel: current.config.classification.model,
    analysis: null,
    analysisModel: current.config.analysis.model,
    analysisError: "",
  };
  let report = null;
  if (current.config.sippulseAiApiKey) {
    const final = await runFinalAnalysis(current, utterances);
    if (final.ok) {
      report = final.analysis;
    } else {
      // Keep the latest live notes rather than delivering no analysis at all.
      report = current.liveAnalysis;
      result.analysisError = final.error;
    }
  }
  const summary = Object.keys(current.classifications).length
    ? classification.summarize(utterances, current.classifications, {
        meetingStartedAt: current.meetingStartedAt,
        clock: transcription.clock,
      })
    : null;
  result.analysis = analysis.withClassification(report, summary);
  return result;
}

async function stopCapture(message) {
  if (!session || session.meetingId !== message.meetingId) {
    return { ok: false, error: "No matching live capture" };
  }
  const current = session;
  session = null;
  current.stopping = true;
  clearInterval(current.analysisTimer);
  current.captions = message.captions || current.captions;
  current.collaborator = message.collaborator || current.collaborator;
  current.subject = message.subject || current.subject;
  await releaseAudio(current);

  // Acknowledge immediately; the result arrives as a separate message.
  finish(current)
    .catch((error) => ({ ok: false, error: error.message || String(error) }))
    .then((result) => post("ai_session_result", { meetingId: current.meetingId, result }));
  return { ok: true, pending: true };
}

async function cancelCapture(meetingId) {
  if (!session || session.meetingId !== meetingId) return;
  const current = session;
  session = null;
  current.stopping = true;
  clearInterval(current.analysisTimer);
  current.classifyTimers.forEach((timer) => clearTimeout(timer));
  current.classifyQueue = [];
  for (const stream of Object.values(current.streams)) {
    clearTimeout(stream.reconnectTimer);
    stream.pending = [];
    stream.socket?.close();
  }
  await releaseAudio(current);
}

function updateCaptions(message) {
  if (session?.meetingId === message.meetingId && Array.isArray(message.captions)) {
    session.captions = message.captions;
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  const task =
    message.type === "ai_capture_start"
      ? startCapture(message)
      : message.type === "ai_capture_stop"
      ? stopCapture(message)
      : message.type === "ai_capture_cancel"
      ? cancelCapture(message.meetingId).then(() => ({ ok: true }))
      : message.type === "ai_captions"
      ? Promise.resolve(updateCaptions(message))
      : Promise.resolve({ ok: false, error: "Unknown offscreen message" });

  task.then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});
