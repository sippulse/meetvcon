// Minimal in-call status panel — v0.1 scaffold.
// Shows: status indicator (active/enabling/off/opted_out), and a
// "Disable for this call" / "Try again" button depending on state.
//
// Per PRD §6.5 / §10, the panel must be visible during capture for
// consent transparency. Future iterations will add utterance count
// and webhook target hostname.

(function () {
  const ns = (window.MeetVcon = window.MeetVcon || {});
  if (ns.inCallPanel) return;

  const { log } = ns;

  const PANEL_ID = "meetvcon-panel";

  function render(status) {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = PANEL_ID;
      panel.className = "meetvcon-panel";
      document.body.appendChild(panel);
    }

    const dotClass =
      status === "active"
        ? "meetvcon-dot--green"
        : status === "enabling"
        ? "meetvcon-dot--amber"
        : "meetvcon-dot--grey";

    const statusText =
      status === "active"
        ? "Capturing captions"
        : status === "enabling"
        ? "Enabling captions…"
        : status === "opted_out"
        ? "Auto-enable disabled"
        : status === "idle"
        ? "Waiting for call"
        : "Captions are off";

    const actionHtml =
      status === "active"
        ? `<button class="meetvcon-btn" data-action="opt-out">Disable for this call</button>`
        : status === "opted_out"
        ? `<button class="meetvcon-btn" data-action="clear-opt-out">Re-enable</button>`
        : status === "idle"
        ? ""
        : `<button class="meetvcon-btn" data-action="try-again">Try again</button>`;

    panel.innerHTML = `
      <div class="meetvcon-row">
        <span class="meetvcon-dot ${dotClass}"></span>
        <span class="meetvcon-title">MeetVcon</span>
      </div>
      <div class="meetvcon-row meetvcon-status">${statusText}</div>
      <div class="meetvcon-row meetvcon-actions">${actionHtml}</div>
    `;

    panel.querySelectorAll("[data-action]").forEach((el) => {
      el.addEventListener("click", () => {
        const action = el.getAttribute("data-action");
        const wd = ns.captionsWatchdog;
        if (!wd) return;
        if (action === "opt-out") wd.optOut();
        else if (action === "clear-opt-out") wd.clearOptOut();
        else if (action === "try-again") wd.forceEnable();
      });
    });
  }

  function destroy() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.remove();
  }

  function init() {
    const wd = ns.captionsWatchdog;
    if (!wd) {
      log.error("captionsWatchdog not loaded — panel cannot init");
      return;
    }
    wd.onStatusChange((status) => {
      log.debug("status →", status);
      render(status);
    });
    render(wd.getStatus() || "idle");
  }

  ns.inCallPanel = { init, destroy, render };
})();
