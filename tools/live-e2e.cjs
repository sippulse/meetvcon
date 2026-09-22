// End-to-end check of the live pipeline against the real services: the
// actual offscreen recorder runs in Chromium, streams a synthetic two-voice
// Portuguese meeting to the configured transcription provider, classifies
// each line with Jev, writes live notes and the final report with SipPulse
// AI, and prints the result.
//
// Reads from the environment or .env (keys are passed to the page and never
// printed): TRANSCRIPTION_PROVIDER (deepgram | sippulse_ai), TRANSCRIPTION_URL,
// TRANSCRIPTION_API_KEY, SIPPULSE_AI_URL, SIPPULSE_AI_API_KEY (also used for
// the TTS that voices the meeting), TYPESAFE_URL, TYPESAFE_AI_KEY.
//
//   npm run e2e:live

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const SAMPLE_RATE = 8000;
const TURNS = [
  ["tab", "onyx", "Bom dia, Ana. Obrigado por entrar. Queria falar sobre a proposta da Vivanet."],
  ["mic", "nova", "Bom dia, Bruno. Claro. Qual é o volume de assinantes que eles querem contratar?"],
  ["tab", "onyx", "São vinte mil assinantes. Eles pediram um desconto de quinze por cento, mas acho que está muito alto para nós."],
  ["mic", "nova", "Eu consigo aprovar dez por cento. Eu envio a proposta revisada até sexta-feira."],
  ["tab", "onyx", "Perfeito. Então fechado, vamos com dez por cento e o piloto começa em outubro."],
  ["mic", "nova", "Combinado. Vou agendar a reunião de kickoff para a próxima segunda."],
];

function readKeys() {
  const env = { ...process.env };
  const file = path.join(ROOT, ".env");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const at = line.indexOf("=");
      if (at > 0 && !env[line.slice(0, at).trim()]) {
        env[line.slice(0, at).trim()] = line.slice(at + 1).trim().replace(/^["']|["']$/g, "");
      }
    }
  }
  const names = {
    transcriptionProvider: "TRANSCRIPTION_PROVIDER",
    transcriptionUrl: "TRANSCRIPTION_URL",
    transcription: "TRANSCRIPTION_API_KEY",
    sippulseUrl: "SIPPULSE_AI_URL",
    sippulse: "SIPPULSE_AI_API_KEY",
    typesafeUrl: "TYPESAFE_URL",
    typesafe: "TYPESAFE_AI_KEY",
  };
  const settings = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, env[name]]));
  // A Deepgram key kept under its usual name also works.
  if (!settings.transcription && settings.transcriptionProvider === "deepgram") {
    settings.transcription = env.DEEPGRAM_API_KEY;
  }
  const missing = Object.entries(names).filter(([key]) => !settings[key]).map(([, name]) => name);
  if (missing.length) throw new Error(`Set ${missing.join(", ")}`);
  return settings;
}

// 24 kHz PCM from TTS, averaged down to 8 kHz.
async function speak(keys, text, voice) {
  const response = await fetch(`${keys.sippulseUrl.replace(/\/+$/, "")}/v1/openai/audio/speech`, {
    method: "POST",
    headers: { "api-key": keys.sippulse, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai-tts", input: text, voice, response_format: "pcm" }),
  });
  if (!response.ok) throw new Error(`TTS HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const source = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
  const out = new Int16Array(Math.floor(source.length / 3));
  for (let i = 0; i < out.length; i++) out[i] = (source[3 * i] + source[3 * i + 1] + source[3 * i + 2]) / 3;
  return out;
}

async function buildMeeting(keys) {
  const clips = [];
  let cursor = SAMPLE_RATE;
  for (const [track, voice, text] of TURNS) {
    const pcm = await speak(keys, text, voice);
    clips.push({ track, text, pcm, at: cursor });
    cursor += pcm.length + SAMPLE_RATE;
  }
  const total = cursor + SAMPLE_RATE;
  const tracks = { tab: new Int16Array(total), mic: new Int16Array(total) };
  for (const clip of clips) tracks[clip.track].set(clip.pcm, clip.at);
  const timeline = clips.map((clip) => ({
    track: clip.track,
    text: clip.text,
    startSec: clip.at / SAMPLE_RATE,
    endSec: (clip.at + clip.pcm.length) / SAMPLE_RATE,
  }));
  return { tracks, timeline, seconds: total / SAMPLE_RATE };
}

async function main() {
  const keys = readKeys();
  const meeting = await buildMeeting(keys);
  const browser = await chromium.launch({
    // file:// origin: the extension bypasses CORS with host permissions.
    args: ["--disable-web-security", "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required"],
  });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => console.log("page error:", error.message));
    await page.goto(`file://${path.join(__dirname, "live-e2e.html")}`);
    await page.evaluate(
      ({ tab, mic, sampleRate }) => {
        const context = new AudioContext({ sampleRate });
        const track = (samples) => {
          const buffer = context.createBuffer(1, samples.length, sampleRate);
          const data = buffer.getChannelData(0);
          for (let i = 0; i < samples.length; i++) data[i] = samples[i] / 32768;
          const source = context.createBufferSource();
          source.buffer = buffer;
          const destination = context.createMediaStreamDestination();
          source.connect(destination);
          return { source, stream: destination.stream };
        };
        window.__tracks = { tab: track(tab), mic: track(mic) };
        window.__play = () => {
          context.resume();
          window.__tracks.tab.source.start();
          window.__tracks.mic.source.start();
        };
      },
      { tab: Array.from(meeting.tracks.tab), mic: Array.from(meeting.tracks.mic), sampleRate: SAMPLE_RATE }
    );

    const collaborator = { email: "ana.souza@sippulse.com" };
    // Default to the shipped mode: analyse once, when the call ends.
    const analysisMode = process.env.E2E_ANALYSIS_MODE === "live" ? "live" : "final";
    const started = await page.evaluate(
      async ({ keys, collaborator, analysisMode }) => {
        const config = window.MeetVcon.config.normalize({
          TranscriptionProvider: keys.transcriptionProvider,
          TranscriptionUrl: keys.transcriptionUrl,
          TranscriptionApiKey: keys.transcription,
          SipPulseAiUrl: keys.sippulseUrl,
          SipPulseAiApiKey: keys.sippulse,
          TypeSafeUrl: keys.typesafeUrl,
          TypeSafeApiKey: keys.typesafe,
        });
        const response = await window.__send({
          type: "ai_capture_start",
          streamId: "e2e",
          meetingId: "e2e-test-meet",
          subject: "Proposta Vivanet",
          meetingStartedAt: new Date().toISOString(),
          collaborator,
          captions: [],
          config: {
            transcriptionApiKey: keys.transcription,
            sippulseAiApiKey: keys.sippulse,
            typesafeApiKey: keys.typesafe,
            transcription: config.transcription,
            // A short meeting still gets live notes when asked for them.
            analysis: { ...config.analysis, mode: analysisMode, liveIntervalMs: 15_000 },
            classification: config.classification,
          },
        });
        window.__play();
        return response;
      },
      { keys, collaborator, analysisMode }
    );
    if (!started.ok) throw new Error(`start failed: ${started.error}`);

    await page.waitForTimeout(meeting.seconds * 1000 + 2500);
    // Meet captions for the remote voice, as the content script records them.
    const base = Date.parse(started.streamStartedAt);
    const captions = meeting.timeline
      .filter((turn) => turn.track === "tab")
      .map((turn) => ({
        speaker: "Bruno Lima",
        text: turn.text,
        start: new Date(base + (turn.startSec + 0.8) * 1000).toISOString(),
        duration: turn.endSec - turn.startSec,
      }));
    await page.evaluate(
      ({ captions, collaborator }) =>
        window.__send({ type: "ai_capture_stop", meetingId: "e2e-test-meet", subject: "Proposta Vivanet", collaborator, captions }),
      { captions, collaborator }
    );
    await page.waitForFunction(() => window.__messages.some((m) => m.type === "ai_session_result"), null, {
      timeout: 240_000,
    });
    const messages = await page.evaluate(() => window.__messages);
    return report(messages);
  } finally {
    await browser.close();
  }
}

function report(messages) {
  const first = messages[0]?.at || 0;
  const updates = messages.filter((m) => m.type === "live_update").map((m) => m.update.kind);
  const count = (kind) => updates.filter((entry) => entry === kind).length;
  const result = messages.find((m) => m.type === "ai_session_result").result;
  const done = ((messages.at(-1).at - first) / 1000).toFixed(1);
  console.log(`live updates: ${count("segment")} segments, ${count("classification")} classifications, ${count("analysis")} live notes`);
  console.log(`result after ${done}s: ok=${result.ok} ${result.error || ""}${result.analysisError ? ` analysisError=${result.analysisError}` : ""}`);
  for (const utterance of result.utterances || []) {
    const tag = result.classifications?.[utterance.segment_id]?.intent || "-";
    console.log(`  ${utterance.speaker.padEnd(11)} ${tag.padEnd(18)} ${utterance.text}`);
  }
  const analysis = result.analysis;
  if (analysis) {
    console.log(`headline: ${analysis.headline}`);
    console.log(`summary: ${analysis.summary}`);
    for (const item of analysis.action_items) console.log(`  action: ${item.task} — ${item.owner} (${item.due})`);
    for (const entry of analysis.decisions) console.log(`  decision: ${entry.decision}${entry.rationale ? ` (${entry.rationale})` : ""}`);
    for (const figure of analysis.numbers) console.log(`  figure: ${figure.label} = ${figure.value}`);
    for (const risk of analysis.risks) console.log(`  risk: ${risk}`);
    if (analysis.next_step) console.log(`next step: ${analysis.next_step}`);
  }
  const passed =
    result.ok &&
    result.utterances.some((u) => u.channel === "microphone") &&
    result.utterances.some((u) => u.speaker === "Bruno Lima") &&
    Object.keys(result.classifications || {}).length > 0 &&
    !!analysis?.summary &&
    !!analysis?.headline;
  console.log(passed ? "PASS" : "FAIL");
  return passed;
}

main()
  .then((passed) => process.exit(passed ? 0 : 1))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
