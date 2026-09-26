const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLibrary } = require("./helpers");

const { transcription } = loadLibrary("src/lib/transcription.js");
const T0 = "2026-09-04T12:00:00.000Z";
// Library values come from a vm realm; compare them as plain JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

// Shape observed from the SipPulse AI dev gateway: words carry timing and
// punctuation, but no speaker and no punctuated_word.
function results(words, { isFinal = true, start = 0, duration = 5 } = {}) {
  return {
    type: "Results",
    channel_index: [0, 1],
    start,
    duration,
    is_final: isFinal,
    channel: {
      alternatives: [
        { transcript: words.map((w) => w.word).join(" "), confidence: 0.92, words },
      ],
    },
  };
}

const word = (text, start, end, extra = {}) => ({ word: text, start, end, confidence: 0.9, ...extra });

test("the SipPulse gateway gets only the parameters it documents", () => {
  const url = new URL(transcription.listenUrl("wss://api.dev.sippulse.ai"));
  assert.equal(url.origin + url.pathname, "wss://api.dev.sippulse.ai/v1/listen");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    model: "pulse-stt-streaming-v1",
    language: "pt-BR",
    encoding: "linear16",
    sample_rate: "8000",
    channels: "1",
    interim_results: "true",
    endpointing: "700",
  });
});

test("the key check accepts anything but a 401, and names the source of a transcript", async () => {
  const { createFakeFetch } = require("./fake-chrome");
  const fetch = createFakeFetch(() => ({ status: 401 }));
  const rejected = await transcription.checkKey(fetch, { apiBase: "https://api.dev.sippulse.ai", apiKey: "s" });
  assert.deepEqual([rejected.ok, rejected.error], [false, "Key rejected"]);
  assert.equal(fetch.calls[0].url, "https://api.dev.sippulse.ai/v1/openai/models");
  assert.equal(fetch.calls[0].init.headers["api-key"], "s");
  assert.deepEqual(plain(await transcription.checkKey(fetch, { apiBase: "", apiKey: "" })), {
    ok: false,
    error: "Not configured",
  });

  assert.equal(transcription.sourceLabel(), "sippulse_ai_live");
  assert.equal(transcription.sourceLabel({ recovered: true }), "sippulse_ai_live_recovered");
});

test("a final from the gateway becomes one undiarized segment on the stream's channel, shifted by the connection offset", () => {
  const parsed = transcription.parseMessage(
    results([word("Bom", 0.32, 0.56), word("dia,", 0.56, 0.88), word("pessoal.", 0.88, 1.4)]),
    { channel: 1, offsetSec: 100 }
  );
  assert.equal(parsed.kind, "final");
  assert.deepEqual(plain(parsed.segments), [
    { channel: 1, speaker: null, text: "Bom dia, pessoal.", start: 100.32, end: 101.4, confidence: 0.9, language: null },
  ]);

  const interim = transcription.parseMessage(results([word("Bom", 0.3, 0.5)], { isFinal: false }), { channel: 0 });
  assert.deepEqual(plain(interim), { kind: "interim", channel: 0, text: "Bom" });
  assert.equal(transcription.parseMessage({ type: "Metadata" }).kind, "ignored");
});

test("finals without word timing fall back to message timing, then to the audio position", () => {
  const timed = transcription.parseMessage(
    { type: "Results", is_final: true, start: 2, duration: 1.5, channel: { alternatives: [{ transcript: "Certo." }] } },
    { channel: 0, offsetSec: 10 }
  );
  assert.deepEqual([timed.segments[0].start, timed.segments[0].end], [12, 13.5]);

  const untimed = transcription.parseMessage(
    { type: "Results", is_final: true, channel: { alternatives: [{ transcript: "Pode ser amanhã" }] } },
    { channel: 0, offsetSec: 10, nowSec: 30 }
  );
  assert.deepEqual([untimed.segments[0].start, untimed.segments[0].end], [28.8, 30]);
});

test("diarized words still split by speaker if the gateway starts sending them", () => {
  const parsed = transcription.parseMessage(
    results([word("Oi", 0, 0.2, { speaker: 0 }), word("Olá", 0.5, 0.7, { speaker: 1 })]),
    { channel: 1 }
  );
  assert.deepEqual(plain(parsed.segments.map((s) => [s.speaker, s.text])), [
    [0, "Oi"],
    [1, "Olá"],
  ]);
});

test("the collaborator's speech merges across short pauses; undiarized remote speech merges only to finish a cut sentence", () => {
  const list = [];
  let id = 1;
  const add = (segment) => {
    const stored = transcription.appendSegment(list, segment, id);
    if (stored.id === id) id++;
    return stored;
  };
  add({ channel: 0, speaker: null, text: "Primeira parte", start: 0, end: 2, confidence: 0.9 });
  assert.equal(add({ channel: 0, speaker: null, text: "e a segunda.", start: 2.5, end: 4, confidence: 0.9 }).id, 1);
  assert.equal(list[0].text, "Primeira parte e a segunda.");

  add({ channel: 1, speaker: null, text: "Pergunta um.", start: 5, end: 6, confidence: 0.9 });
  add({ channel: 1, speaker: null, text: "Resposta de outra pessoa.", start: 6.2, end: 7, confidence: 0.9 });
  assert.deepEqual(plain(list.map((s) => s.id)), [1, 2, 3]);

  // Seen on the dev gateway: one sentence cut in two with no pause.
  add({ channel: 1, speaker: null, text: "mas acho que está muito alto para", start: 12.3, end: 18.38, confidence: 0.9 });
  add({ channel: 1, speaker: null, text: "nós.", start: 18.38, end: 19.34, confidence: 0.9 });
  assert.equal(list.at(-1).text, "mas acho que está muito alto para nós.");
  assert.equal(list.length, 4);
});

test("microphone echo of remote speech is dropped, the collaborator's own words are kept", () => {
  const kept = transcription.dropEcho([
    { channel: 1, speaker: null, text: "Vamos revisar o contrato amanhã", start: 10, end: 13 },
    { channel: 0, speaker: null, text: "vamos revisar o contrato amanhã", start: 10.2, end: 13.1 },
    { channel: 0, speaker: null, text: "Combinado, eu levo os números", start: 14, end: 16 },
  ]);
  assert.deepEqual(plain(kept.map((s) => s.text)), [
    "Vamos revisar o contrato amanhã",
    "Combinado, eu levo os números",
  ]);
});

test("each remote segment is named from the overlapping Meet caption; unmatched ones are Participant", () => {
  const segments = [
    { id: 1, channel: 1, speaker: null, text: "Bom dia a todos.", start: 5, end: 7, confidence: 0.9 },
    { id: 2, channel: 0, speaker: null, text: "Bom dia, Jane.", start: 8, end: 9, confidence: 0.9 },
    { id: 3, channel: 1, speaker: null, text: "Oi, tudo bem?", start: 10, end: 11, confidence: 0.9 },
    { id: 4, channel: 1, speaker: null, text: "Sem legenda aqui.", start: 30, end: 31, confidence: 0.9 },
  ];
  const captions = [
    { speaker: "Jane Doe", text: "Bom dia a todos.", start: "2026-09-04T12:00:05.800Z", duration: 1.5 },
    { speaker: "You", text: "Bom dia, Jane.", start: "2026-09-04T12:00:08.500Z", duration: 1 },
    { speaker: "Bruno Lima", text: "Oi, tudo bem?", start: "2026-09-04T12:00:10.600Z", duration: 1 },
  ];
  const utterances = transcription.toUtterances(segments, {
    streamStartedAt: T0,
    captions,
    collaborator: { email: "ana.souza@sippulse.com" },
  });
  assert.deepEqual(plain(utterances.map((u) => [u.segment_id, u.speaker, u.channel])), [
    [1, "Jane Doe", "meeting"],
    [2, "Ana Souza", "microphone"],
    [3, "Bruno Lima", "meeting"],
    [4, "Participant", "meeting"],
  ]);
  assert.equal(utterances[0].start, "2026-09-04T12:00:05.000Z");
  assert.equal(utterances[0].duration, 2);
  assert.equal(utterances[1].email, "ana.souza@sippulse.com");
});

test("speaker stats report talk time share and turns, leaving out unnamed remote speech", () => {
  const stats = transcription.speakerStats([
    { speaker: "Ana", text: "Podemos fechar hoje?", duration: 6 },
    { speaker: "Ana", text: "Tenho a proposta pronta.", duration: 3 },
    { speaker: "Bruno", text: "Sim.", duration: 1 },
    { speaker: "Participant", text: "Talvez.", duration: 4 },
    { speaker: "Ana", text: "Ótimo.", duration: 2 },
  ]);
  assert.deepEqual(
    plain(stats.map((s) => [s.speaker, s.talk_seconds, s.talk_share, s.turns, s.longest_turn_seconds, s.questions])),
    [
      ["Ana", 11, 0.917, 2, 9, 1],
      ["Bruno", 1, 0.083, 1, 1, 0],
    ]
  );
});

test("transcript text is relative to the meeting start", () => {
  const text = transcription.transcriptText(
    [
      { speaker: "Ana", text: "Oi", start: "2026-09-04T12:01:05.000Z" },
      { speaker: "Bruno", text: "Olá", start: "2026-09-04T13:00:10.000Z" },
    ],
    T0
  );
  assert.equal(text, "[01:05] Ana: Oi\n[1:00:10] Bruno: Olá");
});
