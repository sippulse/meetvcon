const { storage } = window.MeetVcon;

const elements = {
  accept: document.getElementById("accept"),
  revoke: document.getElementById("revoke"),
  test: document.getElementById("test"),
  email: document.getElementById("email"),
  configuration: document.getElementById("configuration"),
  captureStatus: document.getElementById("captureStatus"),
  provider: document.getElementById("provider"),
  notes: document.getElementById("notes"),
  classification: document.getElementById("classification"),
  message: document.getElementById("message"),
  settingsForm: document.getElementById("settingsForm"),
  clearSettings: document.getElementById("clearSettings"),
  settingsMessage: document.getElementById("settingsMessage"),
  access: document.getElementById("access"),
  accessText: document.getElementById("accessText"),
  grantAccess: document.getElementById("grantAccess"),
};

let missingOrigins = [];

const { config: configLib, transcription } = self.MeetVcon;
const SECRET_FIELDS = new Set(configLib.SECRET_FIELDS);

const SOURCE_LABELS = {
  policy: "set by Google Admin",
  local: "saved on this computer",
  default: "not set",
};

// Secrets come back masked: the input stays empty and the placeholder shows
// what is stored, so saving an empty field keeps the stored value.
function renderSettings(fields) {
  for (const [name, field] of Object.entries(fields)) {
    const input = elements.settingsForm.elements[name];
    const label = elements.settingsForm.querySelector(`[data-source="${name}"]`);
    label.textContent = `(${SOURCE_LABELS[field.source] || field.source})`;
    input.disabled = field.locked;
    const shown = Array.isArray(field.value) ? field.value.join(", ") : field.value || "";
    if (SECRET_FIELDS.has(name)) {
      input.value = "";
      input.placeholder = shown ? `Stored ${shown}` : "Not set";
    } else {
      input.value = shown;
    }
  }
}

// The extension has no built-in hosts: Chrome must grant each configured
// one, and only during a click.
function renderAccess(origins) {
  missingOrigins = origins || [];
  elements.access.classList.toggle("hidden", missingOrigins.length === 0);
  elements.accessText.textContent = `Chrome has not allowed the extension to reach ${missingOrigins
    .map((origin) => origin.replace("/*", ""))
    .join(", ")}. `;
}

function originsInForm() {
  const fields = Object.fromEntries(
    configLib.URL_FIELDS.map((field) => [field, elements.settingsForm.elements[field].value.trim()])
  );
  // normalize() applies the defaults (e.g. the SipPulse AI URL) before the
  // hosts are derived, so an empty field still asks for the right host.
  return configLib.normalize(fields).origins;
}

async function requestAccess(origins) {
  if (!origins.length) return true;
  try {
    return await chrome.permissions.request({ origins });
  } catch (error) {
    elements.settingsMessage.textContent = error.message;
    return false;
  }
}

async function loadSettings() {
  const result = await chrome.runtime.sendMessage({ type: "get_settings" });
  if (!result?.ok) throw new Error(result?.error || "Could not load settings");
  renderSettings(result.fields);
  renderAccess(result.missingOrigins);
}

async function saveSettings(message) {
  elements.settingsMessage.textContent = "Saving…";
  const result = await chrome.runtime.sendMessage({ type: "save_settings", ...message });
  if (!result?.ok) {
    elements.settingsMessage.textContent = result?.error || "Could not save settings";
    return;
  }
  renderSettings(result.fields);
  renderAccess(result.missingOrigins);
  elements.settingsMessage.textContent = result.missingOrigins?.length
    ? "Saved, but some hosts are not allowed yet."
    : "Saved.";
  await refresh();
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "get_popup_state" });
  if (!state?.ok) throw new Error(state?.error || "Could not load status");

  elements.email.textContent = state.collaboratorEmail || "your company email";
  elements.configuration.textContent = state.config.configured
    ? "Ready (see Settings for where each value comes from)"
    : state.config.error || "Not configured";
  elements.captureStatus.textContent = state.consented
    ? state.config.captureEnabled
      ? "Enabled"
      : "Disabled by administrator"
    : "Waiting for your consent";
  elements.provider.textContent =
    state.config.transcriptionSource === "google_captions"
      ? "Google captions, turned on automatically (no audio leaves the tab)"
      : state.config.liveTranscriptionReady
      ? `${transcription.PROFILE.label} (Google captions fallback)`
      : "Google captions only (SipPulse AI URL and key not configured)";
  const when = state.config.analysisMode === "live" ? "during the call" : "when the call ends";
  elements.notes.textContent = state.config.analysisReady
    ? `SipPulse AI, ${when}`
    : "Off (SipPulse AI URL and key not configured)";
  elements.classification.textContent = state.config.classificationReady
    ? `TypeSafe Jev (intent, sentiment, action items), ${when}`
    : "Off (TypeSafe URL and key not configured)";
  elements.accept.classList.toggle("hidden", state.consented);
  elements.revoke.classList.toggle("hidden", !state.consented);
  elements.test.disabled = !state.config.configured;
}

elements.accept.addEventListener("click", async () => {
  await storage.setConsent(true);
  elements.message.textContent = "Capture enabled.";
  await refresh();
});

elements.revoke.addEventListener("click", async () => {
  await storage.setConsent(false);
  elements.message.textContent = "Future meeting capture disabled.";
  await refresh();
});

elements.test.addEventListener("click", async () => {
  elements.test.disabled = true;
  elements.message.textContent = "Testing…";
  const result = await chrome.runtime.sendMessage({ type: "test_connection" });
  const describe = (label, check) =>
    `${label}: ${check?.ok ? "OK" : check?.error || (check?.status ? `HTTP ${check.status}` : "failed")}`;
  const services = result?.services;
  elements.message.textContent = services
    ? [
        describe("CRM vCon store", services.storage),
        describe("Transcription", services.transcription),
        describe("SipPulse AI", services.sippulseAi),
        describe("TypeSafe", services.typesafe),
      ].join(" · ")
    : `Connection failed: ${result?.error || "unknown error"}`;
  elements.test.disabled = false;
});

elements.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const settings = {};
  for (const input of elements.settingsForm.querySelectorAll("input, select")) {
    if (!input.disabled) settings[input.name] = input.value;
  }
  // Ask first, while the click still counts as a user gesture.
  await requestAccess([...new Set([...originsInForm(), ...missingOrigins])]);
  await saveSettings({ settings });
});

elements.grantAccess.addEventListener("click", async () => {
  await requestAccess(missingOrigins);
  await loadSettings();
  await refresh();
});

elements.clearSettings.addEventListener("click", () => {
  const remove = [...elements.settingsForm.querySelectorAll("input, select")].map((input) => input.name);
  saveSettings({ remove });
});

refresh().catch((error) => {
  elements.message.textContent = error.message;
});
loadSettings().catch((error) => {
  elements.settingsMessage.textContent = error.message;
});
