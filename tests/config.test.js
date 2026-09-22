const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLibrary } = require("./helpers");

test("the SipPulse AI key and the vCon store are the only required settings", () => {
  const { config } = loadLibrary("src/lib/config.js");
  const empty = config.normalize({});
  assert.equal(empty.configured, false);
  assert.match(empty.error, /vCon store endpoint, the vCon store HMAC secret, the SipPulse AI key/);

  const minimal = config.normalize({
    SipPulseAiApiKey: "sp",
    EndpointUrl: "https://crm.example.com/api/vcons/ingest",
    HmacSecret: "secret",
  });
  assert.equal(minimal.configured, true);
  assert.equal(minimal.error, "");
  assert.equal(minimal.liveTranscriptionReady, true);
  assert.equal(minimal.analysisReady, true);
  assert.equal(minimal.transcription.streamBase, "wss://api.sippulse.ai", "SipPulse AI's public API is the one default");
  assert.equal(minimal.analysis.apiBase, "https://api.sippulse.ai/v1");
  assert.equal(minimal.classificationReady, false, "TypeSafe stays optional and has no default");
  assert.deepEqual([...minimal.origins], ["https://crm.example.com/*", "https://api.sippulse.ai/*"]);
  assert.equal(JSON.stringify(minimal).includes("typesafe.ai"), false);

  // An invalid SipPulse AI URL is reported, not silently replaced.
  const invalid = config.normalize({ ...{ SipPulseAiApiKey: "sp", EndpointUrl: "https://crm.example.com/i", HmacSecret: "s" }, SipPulseAiUrl: "http://api.sippulse.ai" });
  assert.match(invalid.error, /SipPulseAiUrl must be an https/);
  assert.equal(invalid.analysisReady, false);
});

test("endpoints come from configuration, must be https, and derive the provider bases and host permissions", () => {
  const { config } = loadLibrary("src/lib/config.js");
  const result = config.normalize({
    EndpointUrl: "https://crm.example.com/api/vcons/ingest",
    HmacSecret: "secret",
    AllowedEmailDomains: ["example.com"],
    TranscriptionUrl: "https://stt.example.com/",
    TranscriptionApiKey: "d",
    SipPulseAiUrl: "https://llm.example.com",
    SipPulseAiApiKey: "k",
    TypeSafeUrl: "https://ts.example.com",
    TypeSafeApiKey: "t",
  });
  assert.equal(result.configured, true);
  assert.equal(result.transcription.provider, "sippulse_ai", "provider type defaults to SipPulse streaming");
  assert.equal(result.transcription.streamBase, "wss://stt.example.com");
  assert.equal(result.transcription.apiBase, "https://stt.example.com");
  assert.equal(result.transcription.apiKey, "d", "the key travels with the transcription settings");
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

test("one SipPulse AI key covers transcription and notes; other providers override it", () => {
  const { config } = loadLibrary("src/lib/config.js");
  const onlySipPulse = config.normalize({ SipPulseAiUrl: "https://api.sippulse.ai", SipPulseAiApiKey: "sp" });
  assert.equal(onlySipPulse.liveTranscriptionReady, true, "transcription inherits the SipPulse AI URL and key");
  assert.equal(onlySipPulse.analysisReady, true);
  assert.equal(onlySipPulse.transcription.provider, "sippulse_ai");
  assert.equal(onlySipPulse.transcription.streamBase, "wss://api.sippulse.ai");
  assert.equal(onlySipPulse.transcription.apiKey, "sp");
  assert.deepEqual([...onlySipPulse.origins], ["https://api.sippulse.ai/*"], "one host, not two");

  const override = config.normalize({
    SipPulseAiUrl: "https://api.sippulse.ai",
    SipPulseAiApiKey: "sp",
    TranscriptionProvider: "deepgram",
    TranscriptionUrl: "https://api.deepgram.com",
    TranscriptionApiKey: "dg",
  });
  assert.equal(override.transcription.streamBase, "wss://api.deepgram.com");
  assert.equal(override.transcription.apiKey, "dg");
  assert.equal(override.analysis.apiBase, "https://api.sippulse.ai/v1", "notes stay on SipPulse AI");
});

test("transcription and notes are configured independently; the provider type must be known", () => {
  const { config } = loadLibrary("src/lib/config.js");
  const nothing = config.normalize({});
  assert.equal(nothing.analysisReady, false);
  assert.equal(nothing.liveTranscriptionReady, false);

  const sippulseStream = config.normalize({
    TranscriptionUrl: "https://api.sippulse.ai",
    TranscriptionApiKey: "k",
  });
  assert.equal(sippulseStream.liveTranscriptionReady, true);
  assert.equal(sippulseStream.transcription.provider, "sippulse_ai", "the default provider is SipPulse streaming");

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

test("allowed email domains are optional: unset allows any signed-in profile, set restricts to them", () => {
  const { config } = loadLibrary("src/lib/config.js");
  const noDomains = config.normalize({ EndpointUrl: "https://crm.example.com/i", HmacSecret: "s", SipPulseAiApiKey: "sp" });
  assert.equal(noDomains.configured, true);
  assert.deepEqual([...noDomains.allowedEmailDomains], [], "no organization is built in");
  assert.equal(config.isAllowedEmail("ana@anything.com", noDomains), true);
  assert.equal(config.isAllowedEmail("", noDomains), false, "a signed-in profile email is still required");

  const withDomains = config.normalize({ AllowedEmailDomains: "example.com, @partner.com" });
  assert.equal(config.isAllowedEmail("ana@partner.com", withDomains), true);
  assert.equal(config.isAllowedEmail("ana@other.com", withDomains), false);
});

test("a delivery target only needs an https endpoint and a secret", () => {
  const { config } = loadLibrary("src/lib/config.js");
  assert.equal(config.deliveryTarget("https://crm.example.com/i", "s").ok, true);
  assert.match(config.deliveryTarget("http://crm.example.com/i", "s").error, /https/);
  assert.match(config.deliveryTarget("https://crm.example.com/i", "").error, /secret/);
});
