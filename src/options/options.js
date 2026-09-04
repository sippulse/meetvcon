const { storage } = window.MeetVcon;

const elements = {
  accept: document.getElementById("accept"),
  revoke: document.getElementById("revoke"),
  test: document.getElementById("test"),
  email: document.getElementById("email"),
  configuration: document.getElementById("configuration"),
  captureStatus: document.getElementById("captureStatus"),
  provider: document.getElementById("provider"),
  message: document.getElementById("message"),
};

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "get_popup_state" });
  if (!state?.ok) throw new Error(state?.error || "Could not load status");

  elements.email.textContent = state.collaboratorEmail || "your company email";
  elements.configuration.textContent = state.config.configured
    ? "Managed by SipPulse"
    : state.config.error || "Not configured";
  elements.captureStatus.textContent = state.consented
    ? state.config.captureEnabled
      ? "Enabled"
      : "Disabled by administrator"
    : "Waiting for your consent";
  elements.provider.textContent =
    state.config.preferredTranscription === "sippulse_ai"
      ? "SipPulse AI (Google captions fallback)"
      : "Google captions";
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
  elements.message.textContent = result?.ok
    ? `Connected (HTTP ${result.status}).`
    : `Connection failed: ${result?.error || "unknown error"}`;
  elements.test.disabled = false;
});

refresh().catch((error) => {
  elements.message.textContent = error.message;
});
