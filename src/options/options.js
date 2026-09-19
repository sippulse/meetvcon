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
};

const SECRET_FIELDS = new Set(["BearerToken", "SipPulseAiApiKey", "TypeSafeApiKey"]);
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

async function loadSettings() {
  const result = await chrome.runtime.sendMessage({ type: "get_settings" });
  if (!result?.ok) throw new Error(result?.error || "Could not load settings");
  renderSettings(result.fields);
}

async function saveSettings(message) {
  elements.settingsMessage.textContent = "Saving…";
  const result = await chrome.runtime.sendMessage({ type: "save_settings", ...message });
  if (!result?.ok) {
    elements.settingsMessage.textContent = result?.error || "Could not save settings";
    return;
  }
  renderSettings(result.fields);
  elements.settingsMessage.textContent = "Saved.";
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
  elements.provider.textContent = state.config.liveTranscriptionReady
    ? "SipPulse AI streaming, Portuguese (Google captions fallback)"
    : "Google captions only (SipPulse AI key not configured)";
  elements.notes.textContent = state.config.analysisReady
    ? "SipPulse AI"
    : "Off (SipPulse AI key not configured)";
  elements.classification.textContent = state.config.classificationReady
    ? "TypeSafe Jev (intent, sentiment, action items)"
    : "Off (TypeSafe key not configured)";
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
        describe("vCon storage", services.storage),
        describe("SipPulse AI", services.sippulseAi),
        describe("TypeSafe", services.typesafe),
      ].join(" · ")
    : `Connection failed: ${result?.error || "unknown error"}`;
  elements.test.disabled = false;
});

elements.settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const settings = {};
  for (const input of elements.settingsForm.querySelectorAll("input")) {
    if (!input.disabled) settings[input.name] = input.value;
  }
  saveSettings({ settings });
});

elements.clearSettings.addEventListener("click", () => {
  const remove = [...elements.settingsForm.querySelectorAll("input")].map((input) => input.name);
  saveSettings({ remove });
});

refresh().catch((error) => {
  elements.message.textContent = error.message;
});
loadSettings().catch((error) => {
  elements.settingsMessage.textContent = error.message;
});
