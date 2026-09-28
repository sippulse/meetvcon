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
    SipPulseAiUrl: "https://llm.example.com",
    SipPulseAiApiKey: "k",
    TypeSafeUrl: "https://ts.example.com",
    TypeSafeApiKey: "t",
  });
  assert.equal(result.configured, true);
  assert.equal(result.transcription.streamBase, "wss://llm.example.com");
  assert.equal(result.transcription.apiBase, "https://llm.example.com");
  assert.equal(result.transcription.apiKey, "k", "one SipPulse AI key, one host");
  assert.equal(result.analysis.apiBase, "https://llm.example.com/v1");
  assert.equal(result.classification.apiBase, "https://ts.example.com/v1");
  assert.deepEqual([...result.origins], [
    "https://crm.example.com/*",
    "https://llm.example.com/*",
    "https://ts.example.com/*",
  ]);

  const insecure = config.normalize({ EndpointUrl: "http://crm.example.com/ingest", HmacSecret: "s", SipPulseAiUrl: "ftp://x" });
  assert.equal(insecure.configured, false);
  assert.match(insecure.errors.EndpointUrl, /https/);
  assert.match(insecure.errors.SipPulseAiUrl, /https/);
  assert.equal(config.normalize({ EndpointUrl: "https://user:pw@crm.example.com/x", HmacSecret: "s" }).configured, false);
});

test("one SipPulse AI pair serves transcription and notes; there is no second provider to configure", () => {
  const { config } = loadLibrary("src/lib/config.js");
  const onlySipPulse = config.normalize({ SipPulseAiUrl: "https://api.sippulse.ai", SipPulseAiApiKey: "sp" });
  assert.equal(onlySipPulse.liveTranscriptionReady, true);
  assert.equal(onlySipPulse.analysisReady, true);
  assert.equal(onlySipPulse.transcription.streamBase, "wss://api.sippulse.ai");
  assert.equal(onlySipPulse.transcription.apiKey, "sp");
  assert.deepEqual([...onlySipPulse.origins], ["https://api.sippulse.ai/*"], "one host, not two");

  // Transcription overrides were removed with Deepgram: unknown fields are ignored.
  const legacy = config.normalize({
    SipPulseAiUrl: "https://api.sippulse.ai",
    SipPulseAiApiKey: "sp",
    TranscriptionProvider: "deepgram",
    TranscriptionUrl: "https://api.deepgram.com",
    TranscriptionApiKey: "dg",
  });
  assert.equal(legacy.transcription.streamBase, "wss://api.sippulse.ai");
  assert.equal(legacy.transcription.apiKey, "sp");
  assert.deepEqual([...legacy.origins], ["https://api.sippulse.ai/*"], "no host is asked for Deepgram");
  assert.deepEqual(
    [...config.LOCAL_FIELDS].filter((field) => field.startsWith("Transcription")),
    ["TranscriptionSource"],
    "the only transcription setting left is which source to use"
  );
});

test("the models are fixed, and nothing is ready without a key", () => {
  const { config } = loadLibrary("src/lib/config.js");
  const nothing = config.normalize({});
  assert.equal(nothing.analysisReady, false);
  assert.equal(nothing.liveTranscriptionReady, false, "the default URL alone is not enough");
  assert.equal(nothing.analysis.model, "deepseek-v4.1-flash");
  assert.equal(nothing.classification.model, "jev-latest");
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

test("the transcript source is configurable, and Google captions need nothing to start", () => {
  const { config } = loadLibrary("src/lib/config.js");
  const base = { SipPulseAiApiKey: "sp", EndpointUrl: "https://crm.example.com/i", HmacSecret: "s" };

  const streaming = config.normalize(base);
  assert.equal(streaming.transcriptionSource, "sippulse_ai", "call audio by default");
  assert.equal(streaming.liveTranscriptionReady, true);

  const captions = config.normalize({ ...base, TranscriptionSource: "google_captions" });
  assert.equal(captions.transcriptionSource, "google_captions");
  assert.equal(captions.configured, true, "captures without streaming anything");
  assert.equal(captions.liveTranscriptionReady, false, "there is no audio capture to start");
  assert.equal(captions.analysisReady, true, "the key still writes the report");

  const bogus = config.normalize({ ...base, TranscriptionSource: "whisper" });
  assert.match(bogus.errors.TranscriptionSource, /sippulse_ai, google_captions/);
  assert.equal(bogus.transcriptionSource, "sippulse_ai", "an unknown source falls back to the safe one");
});

test("analysis runs at the end of the call unless the mode says otherwise", () => {
  const { config } = loadLibrary("src/lib/config.js");
  assert.equal(config.normalize({}).analysis.mode, "final", "nothing calls the models during a call by default");
  assert.equal(config.normalize({ AnalysisMode: "live" }).analysis.mode, "live");

  const bogus = config.normalize({ AnalysisMode: "sometimes" });
  assert.match(bogus.errors.AnalysisMode, /final, live/);
  assert.equal(bogus.analysis.mode, "final", "an unknown mode falls back to the safe one");
});
