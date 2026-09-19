const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLibrary } = require("./helpers");

test("nothing is built in: without configured endpoints every feature is off", () => {
  const { config } = loadLibrary("src/lib/config.js");
  const result = config.normalize({ HmacSecret: "s", SipPulseAiApiKey: "k", TypeSafeApiKey: "t" });
  assert.equal(result.configured, false);
  assert.match(result.error, /vCon store endpoint/);
  assert.equal(result.liveTranscriptionReady, false);
  assert.equal(result.classificationReady, false);
  assert.deepEqual([...result.origins], []);
  assert.equal(JSON.stringify(result).includes("sippulse.ai"), false);
  assert.equal(JSON.stringify(result).includes("typesafe.ai"), false);
});

test("endpoints come from configuration, must be https, and derive the provider bases and host permissions", () => {
  const { config } = loadLibrary("src/lib/config.js");
  const result = config.normalize({
    EndpointUrl: "https://crm.example.com/api/vcons/ingest",
    HmacSecret: "secret",
    TranscriptionUrl: "https://stt.example.com/",
    TranscriptionApiKey: "d",
    SipPulseAiUrl: "https://llm.example.com",
    SipPulseAiApiKey: "k",
    TypeSafeUrl: "https://ts.example.com",
    TypeSafeApiKey: "t",
  });
  assert.equal(result.configured, true);
  assert.equal(result.transcription.provider, "deepgram", "provider type defaults to deepgram");
  assert.equal(result.transcription.streamBase, "wss://stt.example.com");
  assert.equal(result.transcription.apiBase, "https://stt.example.com");
  assert.equal(result.analysis.apiBase, "https://llm.example.com/v1");
  assert.equal(result.classification.apiBase, "https://ts.example.com/v1");
  assert.deepEqual([...result.origins], [
    "https://crm.example.com/*",
    "https://stt.example.com/*",
    "https://llm.example.com/*",
    "https://ts.example.com/*",
  ]);

  const insecure = config.normalize({ EndpointUrl: "http://crm.example.com/ingest", HmacSecret: "s", SipPulseAiUrl: "ftp://x" });
  assert.equal(insecure.configured, false);
  assert.match(insecure.errors.EndpointUrl, /https/);
  assert.match(insecure.errors.SipPulseAiUrl, /https/);
  assert.equal(config.normalize({ EndpointUrl: "https://user:pw@crm.example.com/x", HmacSecret: "s" }).configured, false);
});

test("transcription and notes are configured independently; the provider type must be known", () => {
  const { config } = loadLibrary("src/lib/config.js");
  const notesOnly = config.normalize({ SipPulseAiUrl: "https://api.sippulse.ai", SipPulseAiApiKey: "k" });
  assert.equal(notesOnly.analysisReady, true);
  assert.equal(notesOnly.liveTranscriptionReady, false);

  const sippulseStream = config.normalize({
    TranscriptionProvider: "sippulse_ai",
    TranscriptionUrl: "https://api.dev.sippulse.ai",
    TranscriptionApiKey: "k",
  });
  assert.equal(sippulseStream.liveTranscriptionReady, true);
  assert.equal(sippulseStream.transcription.provider, "sippulse_ai");

  const unknown = config.normalize({ TranscriptionProvider: "whisper", TranscriptionUrl: "https://x.example.com", TranscriptionApiKey: "k" });
  assert.equal(unknown.liveTranscriptionReady, false);
  assert.match(unknown.errors.TranscriptionProvider, /deepgram, sippulse_ai/);
  assert.equal(config.normalize({}).analysis.model, "deepseek-v4.1-flash");
  assert.equal(config.normalize({}).classification.model, "jev-latest");
});

test("policy and local settings merge per field, policy first", () => {
  const { config } = loadLibrary("src/lib/config.js");
  const { raw, sources } = config.merge(
    { SipPulseAiApiKey: "policy-key", AllowedEmailDomains: [], CaptureEnabled: false },
    { SipPulseAiApiKey: "local-key", TypeSafeApiKey: "local-ts", AllowedEmailDomains: ["example.com"], CaptureEnabled: true }
  );
  assert.equal(raw.SipPulseAiApiKey, "policy-key");
  assert.equal(raw.TypeSafeApiKey, "local-ts");
  assert.deepEqual([...raw.AllowedEmailDomains], ["example.com"], "an empty policy list does not lock the field");
  assert.equal(raw.CaptureEnabled, false, "the kill switch is policy-only");
  assert.equal(sources.SipPulseAiApiKey, "policy");
  assert.equal(sources.TypeSafeApiKey, "local");
  assert.equal(sources.EndpointUrl, "default");
});
