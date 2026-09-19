// End-to-end check of the live pipeline against the real services: the
// actual offscreen recorder runs in Chromium, streams a synthetic two-voice
// Portuguese meeting to the SipPulse AI gateway, classifies each line with
// Jev, writes live notes and the final report, and prints the result.
//
// Needs SIPPULSE_DEV_API_KEY and TYPESAFE_AI_KEY in the environment or in
// .env. Keys are passed to the page and never printed.
//
//   npm run e2e:live

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const SAMPLE_RATE = 8000;
const TTS_URL = "https://api.dev.sippulse.ai/v1/openai/audio/speech";
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
  const keys = { sippulse: env.SIPPULSE_DEV_API_KEY, typesafe: env.TYPESAFE_AI_KEY };
  if (!keys.sippulse || !keys.typesafe) throw new Error("Set SIPPULSE_DEV_API_KEY and TYPESAFE_AI_KEY");
  return keys;
}

// 24 kHz PCM from TTS, averaged down to 8 kHz.
async function speak(apiKey, text, voice) {
  const response = await fetch(TTS_URL, {
    method: "POST",
    headers: { "api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai-tts", input: text, voice, response_format: "pcm" }),
  });
  if (!response.ok) throw new Error(`TTS HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const source = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
  const out = new Int16Array(Math.floor(source.length / 3));
  for (let i = 0; i < out.length; i++) out[i] = (source[3 * i] + source[3 * i + 1] + source[3 * i + 2]) / 3;
  return out;
}

async function buildMeeting(apiKey) {
  const clips = [];
  let cursor = SAMPLE_RATE;
  for (const [track, voice, text] of TURNS) {
    const pcm = await speak(apiKey, text, voice);
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
  const meeting = await buildMeeting(keys.sippulse);
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
    const started = await page.evaluate(
      async ({ keys, collaborator }) => {
        const { config } = window.MeetVcon;
        const response = await window.__send({
          type: "ai_capture_start",
          streamId: "e2e",
          meetingId: "e2e-test-meet",
          subject: "Proposta Vivanet",
          meetingStartedAt: new Date().toISOString(),
          collaborator,
          captions: [],
          config: {
            sippulseAiApiKey: keys.sippulse,
            typesafeApiKey: keys.typesafe,
            transcription: config.TRANSCRIPTION,
            // A short meeting still gets live notes.
            analysis: { ...config.ANALYSIS, liveIntervalMs: 15_000 },
            classification: config.CLASSIFICATION,
          },
        });
        window.__play();
        return response;
      },
      { keys, collaborator }
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
  if (result.analysis) {
    console.log(`summary: ${result.analysis.summary}`);
    for (const item of result.analysis.action_items) console.log(`  action: ${item.task} — ${item.owner} (${item.due})`);
    for (const decision of result.analysis.decisions) console.log(`  decision: ${decision}`);
  }
  const passed =
    result.ok &&
    result.utterances.some((u) => u.channel === "microphone") &&
    result.utterances.some((u) => u.speaker === "Bruno Lima") &&
    Object.keys(result.classifications || {}).length > 0 &&
    !!result.analysis?.summary;
  console.log(passed ? "PASS" : "FAIL");
  return passed;
}

main()
  .then((passed) => process.exit(passed ? 0 : 1))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
