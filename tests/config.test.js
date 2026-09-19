const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLibrary } = require("./helpers");

test("managed configuration fails closed without endpoint and auth", () => {
  const { config } = loadLibrary("src/lib/config.js");
  const result = config.normalize({});
  assert.equal(result.configured, false);
});

test("managed configuration accepts only authenticated api.sippulse.com endpoints", () => {
  const { config } = loadLibrary("src/lib/config.js");
  const result = config.normalize({
    EndpointUrl: "https://api.sippulse.com/v1/meet-captures",
    BearerToken: "managed-pilot-token",
  });
  assert.equal(result.configured, true);

  const external = config.normalize({
    EndpointUrl: "https://example.com/collect",
    BearerToken: "token",
  });
  assert.equal(external.configured, false);
});

test("collaborator domain defaults to sippulse.com and follows managed policy", () => {
  const { config } = loadLibrary("src/lib/config.js");
  const internal = config.normalize({});
  assert.equal(config.isAllowedEmail("ana@sippulse.com", internal), true);
  assert.equal(config.isAllowedEmail("ana@SipPulse.com", internal), true);
  assert.equal(config.isAllowedEmail("ana@gmail.com", internal), false);
  assert.equal(config.isAllowedEmail("evil@sippulse.com.attacker.io", internal), false);

  const external = config.normalize({ AllowedEmailDomains: ["@Example.com", ""] });
  assert.equal(config.isAllowedEmail("bob@example.com", external), true);
  assert.equal(config.isAllowedEmail("ana@sippulse.com", external), false);
  assert.deepEqual([...config.normalize({ AllowedEmailDomains: [] }).allowedEmailDomains], ["sippulse.com"]);
});

test("provider keys come from policy and gate live transcription, notes, and classification", () => {
  const { config } = loadLibrary("src/lib/config.js");
  const bare = config.normalize({
    EndpointUrl: "https://api.sippulse.com/v1/meet-captures",
    BearerToken: "managed-pilot-token",
  });
  assert.equal(bare.liveTranscriptionReady, false);
  assert.equal(bare.analysisReady, false);
  assert.equal(bare.classificationReady, false);

  const full = config.normalize({
    EndpointUrl: "https://api.sippulse.com/v1/meet-captures",
    BearerToken: "managed-pilot-token",
    SipPulseAiApiKey: " sp-key ",
    TypeSafeApiKey: "ts-key",
  });
  assert.equal(full.sippulseAiApiKey, "sp-key");
  assert.equal(full.liveTranscriptionReady, true);
  assert.equal(full.analysisReady, true);
  assert.equal(full.classificationReady, true);
  assert.equal(full.transcription.streamBase, "wss://api.dev.sippulse.ai");
  assert.equal(full.transcription.model, "pulse-stt-streaming-v1");
  assert.equal(full.transcription.sampleRate, 8000);
  assert.equal(full.analysis.apiBase, "https://api.dev.sippulse.ai/v1");
  assert.equal(full.analysis.model, "deepseek-v4.1-flash");
  assert.equal(full.classification.model, "jev-latest");

  // A rejected storage endpoint keeps the keys so the options page can report them.
  const external = config.normalize({ EndpointUrl: "https://example.com", SipPulseAiApiKey: "sp" });
  assert.equal(external.configured, false);
  assert.equal(external.liveTranscriptionReady, true);
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
