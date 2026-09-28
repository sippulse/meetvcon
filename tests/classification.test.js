const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLibraries } = require("./helpers");
const { createFakeFetch } = require("./fake-chrome");

const { classification, transcription } = loadLibraries(["src/lib/transcription.js", "src/lib/classification.js"]);
const plain = (value) => JSON.parse(JSON.stringify(value));
const API = "https://api.typesafe.ai/v1";

// Shape returned by the live Jev API (jev-1.13.0).
function jevAnswer(intent, sentimentScore, actionItem) {
  return {
    status: 200,
    body: {
      model: "jev-1.13.0",
      answers: {
        intent: { type: "choice", choice: intent, probabilities: { [intent]: 0.97 }, confidence: 0.99 },
        sentiment: { type: "score", score: sentimentScore, legend: {}, confidence: 0.8 },
        action_item: { type: "noul", noul: actionItem },
      },
      usage: { input_tokens: 580, output_tokens: 122 },
    },
  };
}

test("an utterance is classified with Bearer auth, the typed questions, and the previous line as context", async () => {
  const fetch = createFakeFetch(() => jevAnswer("commitment", 2, 0.98));
  const result = await classification.classify({
    fetch,
    apiBase: API,
    apiKey: "ts-key",
    model: "jev-latest",
    speaker: "Ana",
    text: "Eu envio a proposta até sexta-feira.",
    previous: { speaker: "Bruno", text: "Quem manda a proposta?" },
  });

  assert.deepEqual(plain(result), {
    ok: true,
    classification: { intent: "commitment", intent_confidence: 0.99, sentiment: 0, action_item: 0.98, model: "jev-1.13.0" },
  });
  assert.equal(fetch.calls[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(fetch.calls[0].init.headers.Authorization, "Bearer ts-key");
  const body = JSON.parse(fetch.calls[0].init.body);
  assert.equal(body.model, "jev-latest");
  assert.deepEqual(body.state, {
    speaker: "Ana",
    utterance: "Eu envio a proposta até sexta-feira.",
    previous_utterance: "Bruno: Quem manda a proposta?",
  });
  assert.deepEqual(Object.keys(body.questions), ["intent", "sentiment", "action_item"]);
  assert.equal(body.questions.intent.type, "choice");
  assert.equal(body.questions.sentiment.criteria.length, 5);
});

test("very short utterances, missing keys, and API errors are reported without throwing", async () => {
  const fetch = createFakeFetch(() => ({ status: 401, body: { detail: "Invalid API key" } }));
  assert.equal((await classification.classify({ fetch, apiKey: "k", text: "Sim." })).skipped, true);
  assert.equal((await classification.classify({ fetch, apiKey: "", text: "uma frase longa aqui" })).ok, false);
  const denied = await classification.classify({ fetch, apiBase: API, apiKey: "bad", model: "jev-latest", text: "uma frase longa aqui" });
  assert.deepEqual(plain(denied), { ok: false, status: 401, error: "Invalid API key" });
  assert.equal(fetch.calls.length, 1, "short utterances never reach the API");
});

test("the 0-4 sentiment score maps to -1..1 and to a label", () => {
  assert.deepEqual([0, 1, 2, 2.9, 4].map(classification.sentimentValue), [-1, -0.5, 0, 0.45, 1]);
  assert.deepEqual([-0.5, 0, 0.45].map(classification.sentimentLabel), ["negative", "neutral", "positive"]);
});

test("summaries list notable intents with times and average sentiment per speaker by talk time", () => {
  const utterances = [
    { segment_id: 1, speaker: "Ana", text: "Eu envio a proposta.", start: "2026-09-04T12:01:05.000Z", duration: 4 },
    { segment_id: 2, speaker: "Bruno", text: "Bom dia a todos.", start: "2026-09-04T12:01:10.000Z", duration: 1 },
    { segment_id: 3, speaker: "Ana", text: "Isso está caro demais.", start: "2026-09-04T12:01:12.000Z", duration: 1 },
    { segment_id: 4, speaker: "Bruno", text: "Talvez.", start: "2026-09-04T12:01:14.000Z", duration: 1 },
  ];
  const classifications = {
    1: { intent: "commitment", intent_confidence: 0.99, sentiment: 0.5, action_item: 0.98 },
    2: { intent: "small_talk", intent_confidence: 1, sentiment: 0.5, action_item: 0.03 },
    3: { intent: "objection", intent_confidence: 0.4, sentiment: -1, action_item: 0.02 },
  };
  const summary = classification.summarize(utterances, classifications, {
    meetingStartedAt: "2026-09-04T12:00:00.000Z",
    clock: transcription.clock,
  });
  assert.deepEqual(plain(summary.intents), [
    { speaker: "Ana", intent: "commitment", detail: "Eu envio a proposta.", at: "01:05", confidence: 0.99 },
  ]);
  assert.deepEqual(plain(summary.sentiment), [
    { speaker: "Ana", label: "neutral", score: 0.2, note: "2 classified utterances" },
    { speaker: "Bruno", label: "positive", score: 0.5, note: "1 classified utterance" },
  ]);
});

test("vCon classification entries point at dialog indexes", () => {
  const entries = classification.toVconAnalysis({
    utterances: [{ segment_id: 7 }, { segment_id: 8 }],
    classifications: { 8: { intent: "question", intent_confidence: 1, sentiment: 0, action_item: 0.03 } },
    model: "jev-1.13.0",
  });
  assert.deepEqual(plain(entries), [
    {
      type: "utterance_classification",
      dialog: [1],
      vendor: "typesafe.ai",
      product: "jev-1.13.0",
      schema: "sippulse-meet-classification/1",
      encoding: "json",
      body: [{ dialog: 1, intent: "question", intent_confidence: 1, sentiment: 0, action_item: 0.03 }],
    },
  ]);
  assert.deepEqual(plain(classification.toVconAnalysis({ utterances: [], classifications: {} })), []);
});
