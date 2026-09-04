// SipPulse-managed configuration. Employees never enter endpoints or secrets.

(function (root) {
  const ns = (root.MeetVcon = root.MeetVcon || {});
  if (ns.config) return;

  const API_ORIGIN = "https://api.sippulse.com";
  const DEFAULTS = Object.freeze({
    endpointUrl: `${API_ORIGIN}/v1/meet-captures`,
    bearerToken: "",
    captureEnabled: true,
    preferredTranscription: "sippulse_ai",
  });

  function normalize(raw = {}) {
    const hasManagedEndpoint =
      typeof raw.EndpointUrl === "string" && raw.EndpointUrl.trim() !== "";
    const endpointUrl = hasManagedEndpoint ? raw.EndpointUrl : DEFAULTS.endpointUrl;
    let endpoint;
    try {
      endpoint = new URL(endpointUrl);
    } catch {
      return { ...DEFAULTS, configured: false, error: "Invalid managed endpoint" };
    }

    if (endpoint.origin !== API_ORIGIN || endpoint.protocol !== "https:") {
      return {
        ...DEFAULTS,
        configured: false,
        error: "Managed endpoint must be hosted on api.sippulse.com",
      };
    }

    return {
      endpointUrl: endpoint.href,
      bearerToken: raw.BearerToken || "",
      captureEnabled:
        raw.CaptureEnabled === undefined
          ? DEFAULTS.captureEnabled
          : raw.CaptureEnabled === true,
      preferredTranscription:
        raw.PreferredTranscription === "google_captions"
          ? "google_captions"
          : "sippulse_ai",
      configured: hasManagedEndpoint && !!raw.BearerToken,
      error:
        hasManagedEndpoint && raw.BearerToken
          ? ""
          : "SipPulse administrator must configure the endpoint and authentication",
    };
  }

  async function get() {
    let managed = {};
    try {
      managed = await chrome.storage.managed.get(null);
    } catch {
      // Unmanaged development profiles use safe SipPulse-only defaults.
    }
    return normalize(managed);
  }

  ns.config = { API_ORIGIN, DEFAULTS, normalize, get };
})(typeof self !== "undefined" ? self : window);
