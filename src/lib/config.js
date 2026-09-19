// Configuration comes from two places, per field: Chrome policy (pushed from
// admin.google.com, read through chrome.storage.managed) and local settings
// saved on the options page. Policy always wins and locks the field.
//
// Fields: vCon storage (EndpointUrl + BearerToken), who may capture and
// receive the email (AllowedEmailDomains), the SipPulse AI key (live
// transcription and meeting notes), and the TypeSafe key (Jev inline
// classification). CaptureEnabled is policy-only: a kill switch the
// collaborator cannot override.

(function (root) {
  const ns = (root.MeetVcon = root.MeetVcon || {});
  if (ns.config) return;

  const API_ORIGIN = "https://api.sippulse.com";
  // The streaming model is only deployed on the SipPulse AI dev (stage)
  // environment for now; production is api.sippulse.ai. The key must belong
  // to the same environment.
  const SIPPULSE_AI_HOST = "api.dev.sippulse.ai";
  // The model is multilingual (nemotron-asr derivative), but the dev gateway
  // accepts only language=pt-BR|pt; switch to multilingual when it does.
  const TRANSCRIPTION = Object.freeze({
    provider: "sippulse_ai",
    streamBase: `wss://${SIPPULSE_AI_HOST}`,
    model: "pulse-stt-streaming-v1",
    language: "pt-BR",
    sampleRate: 8_000,
    endpointing: 700,
  });
  const ANALYSIS = Object.freeze({
    provider: "sippulse_ai",
    apiBase: `https://${SIPPULSE_AI_HOST}/v1`,
    model: "deepseek-v4.1-flash",
    liveModel: "deepseek-v4.1-flash",
    liveIntervalMs: 60_000,
  });
  // Per-utterance intent, sentiment, and action-item classification.
  const CLASSIFICATION = Object.freeze({
    provider: "typesafe",
    apiBase: "https://api.typesafe.ai/v1",
    model: "jev-latest",
  });
  const DEFAULTS = Object.freeze({
    endpointUrl: `${API_ORIGIN}/v1/meet-captures`,
    bearerToken: "",
    captureEnabled: true,
    allowedEmailDomains: ["sippulse.com"],
    sippulseAiApiKey: "",
    typesafeApiKey: "",
  });

  const LOCAL_FIELDS = Object.freeze([
    "EndpointUrl",
    "BearerToken",
    "AllowedEmailDomains",
    "SipPulseAiApiKey",
    "TypeSafeApiKey",
  ]);
  const SECRET_FIELDS = Object.freeze(["BearerToken", "SipPulseAiApiKey", "TypeSafeApiKey"]);

  const text = (value) => (typeof value === "string" ? value.trim() : "");

  function isSet(value) {
    if (Array.isArray(value)) return value.some((entry) => text(entry));
    return text(value) !== "";
  }

  // Per-field precedence: policy, then local settings, then defaults.
  function merge(managed = {}, local = {}) {
    const raw = { ...managed };
    const sources = {};
    for (const field of LOCAL_FIELDS) {
      if (isSet(managed[field])) {
        sources[field] = "policy";
      } else if (isSet(local[field])) {
        raw[field] = local[field];
        sources[field] = "local";
      } else {
        sources[field] = "default";
      }
    }
    return { raw, sources };
  }

  function normalizeDomains(value) {
    const domains = (Array.isArray(value) ? value : [])
      .filter((domain) => typeof domain === "string")
      .map((domain) => domain.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean);
    return domains.length ? domains : DEFAULTS.allowedEmailDomains;
  }

  function isAllowedEmail(email, config = DEFAULTS) {
    if (typeof email !== "string" || !email.includes("@")) return false;
    const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
    return (config.allowedEmailDomains || DEFAULTS.allowedEmailDomains).includes(domain);
  }

  function withProviders(config, raw) {
    const sippulseAiApiKey = text(raw.SipPulseAiApiKey);
    const typesafeApiKey = text(raw.TypeSafeApiKey);
    return {
      ...config,
      sippulseAiApiKey,
      typesafeApiKey,
      liveTranscriptionReady: !!sippulseAiApiKey,
      analysisReady: !!sippulseAiApiKey,
      classificationReady: !!typesafeApiKey,
      transcription: TRANSCRIPTION,
      analysis: ANALYSIS,
      classification: CLASSIFICATION,
    };
  }

  function normalize(raw = {}) {
    const hasEndpoint = text(raw.EndpointUrl) !== "";
    const endpointUrl = hasEndpoint ? raw.EndpointUrl : DEFAULTS.endpointUrl;
    const allowedEmailDomains = normalizeDomains(raw.AllowedEmailDomains);
    let endpoint;
    try {
      endpoint = new URL(endpointUrl);
    } catch {
      return withProviders(
        { ...DEFAULTS, allowedEmailDomains, configured: false, error: "The vCon storage endpoint is not a valid URL" },
        raw
      );
    }

    if (endpoint.origin !== API_ORIGIN || endpoint.protocol !== "https:") {
      return withProviders(
        {
          ...DEFAULTS,
          allowedEmailDomains,
          configured: false,
          error: "The vCon storage endpoint must be on https://api.sippulse.com",
        },
        raw
      );
    }

    return withProviders(
      {
        endpointUrl: endpoint.href,
        bearerToken: raw.BearerToken || "",
        captureEnabled:
          raw.CaptureEnabled === undefined ? DEFAULTS.captureEnabled : raw.CaptureEnabled === true,
        allowedEmailDomains,
        configured: hasEndpoint && !!raw.BearerToken,
        error:
          hasEndpoint && raw.BearerToken
            ? ""
            : "Configure the vCon storage endpoint and token in Google Admin or in Settings",
      },
      raw
    );
  }

  async function readManaged() {
    try {
      return (await chrome.storage.managed.get(null)) || {};
    } catch {
      // Unmanaged profiles rely on local settings.
      return {};
    }
  }

  async function get(local = {}) {
    const { raw, sources } = merge(await readManaged(), local);
    return { ...normalize(raw), sources };
  }

  ns.config = {
    API_ORIGIN,
    SIPPULSE_AI_HOST,
    DEFAULTS,
    TRANSCRIPTION,
    ANALYSIS,
    CLASSIFICATION,
    LOCAL_FIELDS,
    SECRET_FIELDS,
    merge,
    normalize,
    readManaged,
    get,
    isAllowedEmail,
  };
})(typeof self !== "undefined" ? self : window);
