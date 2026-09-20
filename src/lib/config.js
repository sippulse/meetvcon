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
// - AllowedEmailDomains: who may capture and receive the email. Required:
//   there is no built-in domain, so capture stays off until it is set.
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
    allowedEmailDomains: [],
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

  // "https://host/base/" -> "https://host/base"; "" when unset or invalid.
  function withoutTrailingSlash(value) {
    const url = value instanceof URL ? value : httpsUrl(value);
    return url ? url.href.replace(/\/+$/, "") : "";
  }

  // Origin patterns that need host permission: fetch from extension pages to
  // servers without CORS. The transcription WebSocket needs none. `raw` is
  // keyed by the policy/settings field names (URL_FIELDS).
  function originsFor(raw = {}) {
    const origins = new Set();
    for (const field of URL_FIELDS) {
      const url = httpsUrl(raw[field]);
      if (url) origins.add(`${url.origin}/*`);
    }
    return [...origins];
  }

  function normalizeDomains(value) {
    return (Array.isArray(value) ? value : String(value || "").split(/[\s,;]+/))
      .filter((domain) => typeof domain === "string")
      .map((domain) => domain.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean);
  }

  // No domain configured means nobody is allowed: capture fails closed.
  function isAllowedEmail(email, config = DEFAULTS) {
    if (typeof email !== "string" || !email.includes("@")) return false;
    const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
    return (config.allowedEmailDomains || []).includes(domain);
  }

  // Is this pair usable as a delivery target? Narrower than normalize(),
  // which also decides whether capture may start at all.
  function deliveryTarget(endpointUrl, hmacSecret) {
    const url = withoutTrailingSlash(httpsUrl(endpointUrl));
    if (!url) return { ok: false, error: "The vCon store endpoint must be an https:// URL" };
    if (!text(hmacSecret)) return { ok: false, error: "The vCon store HMAC secret is not configured" };
    return { ok: true, url };
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
    const transcriptionApiKey = text(raw.TranscriptionApiKey);
    const store = withoutTrailingSlash(raw.EndpointUrl);
    const streamBase = withoutTrailingSlash(raw.TranscriptionUrl);
    const sippulse = withoutTrailingSlash(raw.SipPulseAiUrl);
    const typesafe = withoutTrailingSlash(raw.TypeSafeUrl);
    const allowedEmailDomains = normalizeDomains(raw.AllowedEmailDomains);
    const hmacSecret = text(raw.HmacSecret);
    const sippulseAiApiKey = text(raw.SipPulseAiApiKey);
    const typesafeApiKey = text(raw.TypeSafeApiKey);
    const configured = !!store && !!hmacSecret && allowedEmailDomains.length > 0;
    const missing = !store || !hmacSecret ? "the vCon store endpoint and HMAC secret" : "the allowed email domains";

    return {
      endpointUrl: store,
      hmacSecret,
      transcriptionUrl: streamBase,
      // The key travels with the rest of the transcription settings.
      transcriptionApiKey,
      sippulseAiUrl: sippulse,
      sippulseAiApiKey,
      typesafeUrl: typesafe,
      typesafeApiKey,
      captureEnabled:
        raw.CaptureEnabled === undefined ? DEFAULTS.captureEnabled : raw.CaptureEnabled === true,
      allowedEmailDomains,
      configured,
      error: errors.EndpointUrl || (configured ? "" : `Configure ${missing} in Google Admin or in Settings`),
      errors,
      liveTranscriptionReady: !!streamBase && !!transcriptionApiKey && !errors.TranscriptionProvider,
      analysisReady: !!sippulse && !!sippulseAiApiKey,
      classificationReady: !!typesafe && !!typesafeApiKey,
      transcription: {
        provider,
        apiBase: streamBase,
        streamBase: streamBase.replace(/^https:/, "wss:"),
        apiKey: transcriptionApiKey,
      },
      analysis: { ...ANALYSIS, apiBase: sippulse ? `${sippulse}/v1` : "" },
      classification: { ...CLASSIFICATION, apiBase: typesafe ? `${typesafe}/v1` : "" },
      origins: originsFor(raw),
    };
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
    deliveryTarget,
    normalize,
    originsFor,
    readManaged,
    get,
    isAllowedEmail,
  };
})(typeof self !== "undefined" ? self : window);
