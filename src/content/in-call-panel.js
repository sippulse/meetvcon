// Visible consent and capture control inside Google Meet.

(function () {
  const ns = (window.MeetVcon = window.MeetVcon || {});
  if (ns.inCallPanel) return;

  const PANEL_ID = "meetvcon-panel";
  let handlers = {};
  let currentStatus = "idle";
  let countTimer = null;
  let unsubscribe = null;

  const STATES = {
    active: ["meetvcon-dot--green", "Capturing Google captions"],
    enabling: ["meetvcon-dot--amber", "Enabling Google captions…"],
    opted_out: ["meetvcon-dot--grey", "Capture stopped for this call"],
    setup_required: ["meetvcon-dot--amber", "Consent is required before capture"],
    identity_required: ["meetvcon-dot--amber", "Sign in to Chrome with your SipPulse account"],
    managed_disabled: ["meetvcon-dot--grey", "Capture is disabled by SipPulse"],
    capture_error: ["meetvcon-dot--grey", "Capture could not start"],
    idle: ["meetvcon-dot--grey", "Waiting for the meeting"],
  };

  function actionFor(status) {
    if (status === "active" || status === "enabling") {
      return ["disable", "Stop and discard this call"];
    }
    if (status === "opted_out") return ["resume", "Resume capture"];
    if (status === "setup_required" || status === "identity_required") {
      return ["setup", "Review setup"];
    }
    return null;
  }

  function render(status) {
    currentStatus = status;
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("aside");
      panel.id = PANEL_ID;
      panel.className = "meetvcon-panel";
      panel.setAttribute("aria-live", "polite");
      document.body.appendChild(panel);
    }

    const [dotClass, statusText] = STATES[status] || STATES.capture_error;
    const action = actionFor(status);
    const count = ns.transcriptCapture?.getUtteranceCount?.() || 0;
    panel.innerHTML = `
      <div class="meetvcon-row">
        <span class="meetvcon-dot ${dotClass}"></span>
        <span class="meetvcon-title">SipPulse Meet Capture</span>
      </div>
      <div class="meetvcon-row meetvcon-status">${statusText}</div>
      <div class="meetvcon-row meetvcon-count">${count} caption segment${count === 1 ? "" : "s"}</div>
      <div class="meetvcon-row meetvcon-consent">Transcript goes to SipPulse CRM and the collaborator's email.</div>
      <div class="meetvcon-row meetvcon-actions">
        ${action ? `<button class="meetvcon-btn" data-action="${action[0]}">${action[1]}</button>` : ""}
      </div>
    `;

    panel.querySelector("[data-action]")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      const actionName = button.dataset.action;
      if (actionName === "disable") await handlers.onDisable?.();
      else if (actionName === "resume") await handlers.onResume?.();
      else if (actionName === "setup") handlers.onOpenSetup?.();
    });
  }

  function init(nextHandlers = {}) {
    handlers = nextHandlers;
    if (!countTimer) countTimer = setInterval(() => render(currentStatus), 2_000);
    unsubscribe?.();
    unsubscribe = ns.captionsWatchdog.onStatusChange(render);
    render("idle");
  }

  function destroy() {
    if (countTimer) clearInterval(countTimer);
    countTimer = null;
    unsubscribe?.();
    unsubscribe = null;
    document.getElementById(PANEL_ID)?.remove();
  }

  ns.inCallPanel = { init, destroy, render };
})();
