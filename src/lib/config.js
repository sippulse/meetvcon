// Configuration comes from two places, per field: Chrome policy (pushed from
// admin.google.com, read through chrome.storage.managed) and local settings
// saved on the options page. Policy always wins and locks the field.
//
// Required: SipPulseAiApiKey, plus the vCon store (EndpointUrl + HmacSecret).
// Everything else is optional. The only built-in endpoint is SipPulse AI's
// public API, the default for SipPulseAiUrl; the vCon store is always the
// organization's own.
//
// Fields:
// - EndpointUrl + HmacSecret (required): the vCon store that receives the
//   final vCon, signed with X-MeetVcon-Signature (HMAC-SHA256 of the body).
// - SipPulseAiApiKey (required) + SipPulseAiUrl (default DEFAULT_SIPPULSE_AI_URL):
//   live transcription (/v1/listen WebSocket) and meeting notes
//   (/v1/openai/chat/completions), one key for both.
// - AllowedEmailDomains (optional): restricts which Chrome profiles may
//   capture; unset, any signed-in profile may.
// - TypeSafeUrl + TypeSafeApiKey (optional): Jev inline classification.
// - CaptureEnabled: policy-only kill switch the collaborator cannot override.

(function (root) {
  const ns = (root.MeetVcon = root.MeetVcon || {});
  if (ns.config) return;

  // The streaming model and its parameters live in src/lib/transcription.js.
  // Where the transcript comes from. "sippulse_ai" streams the call audio to
  // the gateway. "google_captions" reads Meet's own captions instead, and is
  // the only mode that turns captions on, because then they are the source.
  const TRANSCRIPTION_SOURCES = Object.freeze(["sippulse_ai", "google_captions"]);
  // "final": notes and per-line classification run once, when the call ends.
  // "live": notes refresh during the call and each finished line is classified
  // as it lands (tags in the panel).
  const ANALYSIS_MODES = Object.freeze(["final", "live"]);
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
  const DEFAULT_SIPPULSE_AI_URL = "https://api.sippulse.ai";
  const DEFAULTS = Object.freeze({
    sippulseAiUrl: DEFAULT_SIPPULSE_AI_URL,
    analysisMode: "final",
    transcriptionSource: "sippulse_ai",
    captureEnabled: true,
    // Empty = no restriction on which signed-in profile may capture.
    allowedEmailDomains: [],
  });

  const LOCAL_FIELDS = Object.freeze([
    "EndpointUrl",
    "HmacSecret",
    "AllowedEmailDomains",
    "AnalysisMode",
    "TranscriptionSource",
    "SipPulseAiUrl",
    "SipPulseAiApiKey",
    "TypeSafeUrl",
    "TypeSafeApiKey",
  ]);
  const SECRET_FIELDS = Object.freeze(["HmacSecret", "SipPulseAiApiKey", "TypeSafeApiKey"]);
  const URL_FIELDS = Object.freeze(["EndpointUrl", "SipPulseAiUrl", "TypeSafeUrl"]);

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

  // A signed-in profile email is always required (it routes the vCon and the
  // email). With no domains configured, any such profile may capture; the
  // vCon store still decides whom it emails.
  function isAllowedEmail(email, config = DEFAULTS) {
    if (typeof email !== "string" || !email.includes("@")) return false;
    const domains = config.allowedEmailDomains || [];
    if (domains.length === 0) return true;
    return domains.includes(email.slice(email.lastIndexOf("@") + 1).toLowerCase());
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
    const analysisMode = text(raw.AnalysisMode) || DEFAULTS.analysisMode;
    if (!ANALYSIS_MODES.includes(analysisMode)) {
      errors.AnalysisMode = `AnalysisMode must be one of ${ANALYSIS_MODES.join(", ")}`;
    }
    const requested = text(raw.TranscriptionSource) || DEFAULTS.transcriptionSource;
    if (!TRANSCRIPTION_SOURCES.includes(requested)) {
      errors.TranscriptionSource = `TranscriptionSource must be one of ${TRANSCRIPTION_SOURCES.join(", ")}`;
    }
    const transcriptionSource = errors.TranscriptionSource ? DEFAULTS.transcriptionSource : requested;
    const store = withoutTrailingSlash(raw.EndpointUrl);
    // An invalid URL is reported, never silently replaced by the default.
    const sippulse = isSet(raw.SipPulseAiUrl) ? withoutTrailingSlash(raw.SipPulseAiUrl) : DEFAULTS.sippulseAiUrl;
    const typesafe = withoutTrailingSlash(raw.TypeSafeUrl);
    const allowedEmailDomains = normalizeDomains(raw.AllowedEmailDomains);
    const hmacSecret = text(raw.HmacSecret);
    const sippulseAiApiKey = text(raw.SipPulseAiApiKey);
    const typesafeApiKey = text(raw.TypeSafeApiKey);
    const missing = [
      !store && "the vCon store endpoint",
      !hmacSecret && "the vCon store HMAC secret",
      !sippulseAiApiKey && "the SipPulse AI key",
    ].filter(Boolean);
    const configured = missing.length === 0;

    return {
      endpointUrl: store,
      hmacSecret,
      sippulseAiUrl: sippulse,
      sippulseAiApiKey,
      typesafeUrl: typesafe,
      typesafeApiKey,
      captureEnabled:
        raw.CaptureEnabled === undefined ? DEFAULTS.captureEnabled : raw.CaptureEnabled === true,
      allowedEmailDomains,
      configured,
      error:
        errors.EndpointUrl ||
        errors.SipPulseAiUrl ||
        (configured ? "" : `Configure ${missing.join(", ")} in Google Admin or in Settings`),
      errors,
      transcriptionSource,
      // SipPulse AI serves streaming transcription and notes from one API
      // with one key. On google_captions there is nothing to start: Meet
      // writes the transcript and the key is only used for the report.
      liveTranscriptionReady:
        transcriptionSource === "sippulse_ai" && !!sippulse && !!sippulseAiApiKey,
      analysisReady: !!sippulse && !!sippulseAiApiKey,
      classificationReady: !!typesafe && !!typesafeApiKey,
      transcription: {
        apiBase: sippulse,
        streamBase: sippulse.replace(/^https:/, "wss:"),
        apiKey: sippulseAiApiKey,
      },
      analysisMode,
      analysis: {
        ...ANALYSIS,
        apiBase: sippulse ? `${sippulse}/v1` : "",
        mode: errors.AnalysisMode ? DEFAULTS.analysisMode : analysisMode,
      },
      classification: { ...CLASSIFICATION, apiBase: typesafe ? `${typesafe}/v1` : "" },
      // From the resolved URLs, so the default SipPulse AI host is included.
      origins: originsFor({ EndpointUrl: store, SipPulseAiUrl: sippulse, TypeSafeUrl: typesafe }),
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
    DEFAULT_SIPPULSE_AI_URL,
    ANALYSIS_MODES,
    TRANSCRIPTION_SOURCES,
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
