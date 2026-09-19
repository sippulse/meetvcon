// Configuration comes from two places, per field: Chrome policy (pushed from
// admin.google.com, read through chrome.storage.managed) and local settings
// saved on the options page. Policy always wins and locks the field.
//
// No endpoint is built in: this is an open-source extension and each
// organization points it at its own vCon store and providers.
//
// Fields:
// - EndpointUrl + HmacSecret: the vCon store that receives the final vCon,
//   signed with X-MeetVcon-Signature (HMAC-SHA256 of the body).
// - AllowedEmailDomains: who may capture and receive the email.
// - TranscriptionProvider ("deepgram" | "sippulse_ai") + TranscriptionUrl +
//   TranscriptionApiKey: live transcription over the /v1/listen WebSocket.
// - SipPulseAiUrl + SipPulseAiApiKey: meeting notes (OpenAI-compatible
//   /v1/openai/chat/completions).
// - TypeSafeUrl + TypeSafeApiKey: Jev inline classification (/v1/systemone).
// - CaptureEnabled: policy-only kill switch the collaborator cannot override.

(function (root) {
  const ns = (root.MeetVcon = root.MeetVcon || {});
  if (ns.config) return;

  // Streaming model choices per provider live in src/lib/transcription.js.
  const TRANSCRIPTION_PROVIDERS = Object.freeze(["deepgram", "sippulse_ai"]);
  const ANALYSIS = Object.freeze({
    provider: "sippulse_ai",
    model: "deepseek-v4.1-flash",
    liveModel: "deepseek-v4.1-flash",
    liveIntervalMs: 60_000,
  });
  // Per-utterance intent, sentiment, and action-item classification.
  const CLASSIFICATION = Object.freeze({
    provider: "typesafe",
    model: "jev-latest",
  });
  const DEFAULTS = Object.freeze({
    transcriptionProvider: "deepgram",
    captureEnabled: true,
    allowedEmailDomains: ["sippulse.com"],
  });

  const LOCAL_FIELDS = Object.freeze([
    "EndpointUrl",
    "HmacSecret",
    "AllowedEmailDomains",
    "TranscriptionProvider",
    "TranscriptionUrl",
    "TranscriptionApiKey",
    "SipPulseAiUrl",
    "SipPulseAiApiKey",
    "TypeSafeUrl",
    "TypeSafeApiKey",
  ]);
  const SECRET_FIELDS = Object.freeze(["HmacSecret", "TranscriptionApiKey", "SipPulseAiApiKey", "TypeSafeApiKey"]);
  const URL_FIELDS = Object.freeze(["EndpointUrl", "TranscriptionUrl", "SipPulseAiUrl", "TypeSafeUrl"]);

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

  // Configured URLs must be HTTPS without credentials; returns the parsed URL
  // or null.
  function httpsUrl(value) {
    try {
      const url = new URL(text(value));
      return url.protocol === "https:" && !url.username && !url.password ? url : null;
    } catch {
      return null;
    }
  }

  // "https://host/base/" -> "https://host/base"
  function base(url) {
    return url.href.replace(/\/+$/, "");
  }

  // Origin patterns that need host permission: fetch from extension pages to
  // servers without CORS. The transcription WebSocket needs none.
  function originsFor(config) {
    const origins = new Set();
    for (const value of [config.endpointUrl, config.transcriptionUrl, config.sippulseAiUrl, config.typesafeUrl]) {
      const url = httpsUrl(value);
      if (url) origins.add(`${url.origin}/*`);
    }
    return [...origins];
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

  function normalize(raw = {}) {
    const errors = {};
    for (const field of URL_FIELDS) {
      if (isSet(raw[field]) && !httpsUrl(raw[field])) errors[field] = `${field} must be an https:// URL`;
    }
    const provider = text(raw.TranscriptionProvider) || DEFAULTS.transcriptionProvider;
    if (!TRANSCRIPTION_PROVIDERS.includes(provider)) {
      errors.TranscriptionProvider = `TranscriptionProvider must be one of ${TRANSCRIPTION_PROVIDERS.join(", ")}`;
    }
    const stream = httpsUrl(raw.TranscriptionUrl);
    const transcriptionApiKey = text(raw.TranscriptionApiKey);
    const store = httpsUrl(raw.EndpointUrl);
    const sippulse = httpsUrl(raw.SipPulseAiUrl);
    const typesafe = httpsUrl(raw.TypeSafeUrl);
    const hmacSecret = text(raw.HmacSecret);
    const sippulseAiApiKey = text(raw.SipPulseAiApiKey);
    const typesafeApiKey = text(raw.TypeSafeApiKey);
    const configured = !!store && !!hmacSecret;

    const config = {
      endpointUrl: store ? store.href : "",
      hmacSecret,
      transcriptionUrl: stream ? base(stream) : "",
      transcriptionApiKey,
      sippulseAiUrl: sippulse ? base(sippulse) : "",
      sippulseAiApiKey,
      typesafeUrl: typesafe ? base(typesafe) : "",
      typesafeApiKey,
      captureEnabled:
        raw.CaptureEnabled === undefined ? DEFAULTS.captureEnabled : raw.CaptureEnabled === true,
      allowedEmailDomains: normalizeDomains(raw.AllowedEmailDomains),
      configured,
      error:
        errors.EndpointUrl ||
        (configured ? "" : "Configure the vCon store endpoint and HMAC secret in Google Admin or in Settings"),
      errors,
      liveTranscriptionReady: !!stream && !!transcriptionApiKey && !errors.TranscriptionProvider,
      analysisReady: !!sippulse && !!sippulseAiApiKey,
      classificationReady: !!typesafe && !!typesafeApiKey,
      transcription: {
        provider,
        apiBase: stream ? base(stream) : "",
        streamBase: stream ? base(stream).replace(/^https:/, "wss:") : "",
      },
      analysis: { ...ANALYSIS, apiBase: sippulse ? `${base(sippulse)}/v1` : "" },
      classification: { ...CLASSIFICATION, apiBase: typesafe ? `${base(typesafe)}/v1` : "" },
    };
    config.origins = originsFor(config);
    return config;
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
    DEFAULTS,
    TRANSCRIPTION_PROVIDERS,
    ANALYSIS,
    CLASSIFICATION,
    LOCAL_FIELDS,
    SECRET_FIELDS,
    URL_FIELDS,
    merge,
    normalize,
    originsFor,
    readManaged,
    get,
    isAllowedEmail,
  };
})(typeof self !== "undefined" ? self : window);
