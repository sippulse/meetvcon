// Watches whether Google Meet captions are on, and turns them on only when
// they are the configured transcript source (TranscriptionSource:
// google_captions). On SipPulse AI it never touches the toggle: forcing CC
// changed what everyone in the call saw on screen for a fallback the
// collaborator may not want. Their labels name remote speakers either way.

(function () {
  const ns = (window.MeetVcon = window.MeetVcon || {});
  if (ns.captionsWatchdog) return;

  const { log, selectors } = ns;
  const INTERVAL_MS = 5_000;
  // Don't fight a user who keeps switching captions off.
  const RATE_WINDOW_MS = 60_000;
  const RATE_MAX_ATTEMPTS = 3;

  const state = {
    intervalId: null,
    lastStatus: null,
    listeners: new Set(),
    enable: false,
    attempts: [],
  };

  function notify(status) {
    if (status === state.lastStatus) return;
    state.lastStatus = status;
    for (const fn of state.listeners) {
      try {
        fn(status);
      } catch (err) {
        log.error("status listener threw", err);
      }
    }
  }

  function rateLimited() {
    const now = Date.now();
    state.attempts = state.attempts.filter((at) => now - at < RATE_WINDOW_MS);
    return state.attempts.length >= RATE_MAX_ATTEMPTS;
  }

  function pressKey() {
    const init = { key: "c", code: "KeyC", keyCode: 67, which: 67, bubbles: true, cancelable: true };
    for (const type of ["keydown", "keypress", "keyup"]) {
      document.body.dispatchEvent(new KeyboardEvent(type, init));
    }
  }

  function attemptEnable() {
    if (rateLimited()) return;
    state.attempts.push(Date.now());
    const button = selectors.findCaptionsToggleButton();
    if (!button) return pressKey();
    log.info("turning captions on: they are the configured transcript source");
    button.click();
    // The button is not always the real toggle; check and fall back.
    setTimeout(() => {
      if (!selectors.areCaptionsActive()) pressKey();
    }, 500);
  }

  function tick() {
    if (!selectors.isInCall()) return notify("idle");
    if (selectors.areCaptionsActive()) return notify("active");
    notify("off");
    if (state.enable) attemptEnable();
  }

  // enable: captions are the transcript source, so switch them on.
  function start({ enable = false } = {}) {
    state.enable = !!enable;
    if (state.intervalId) return;
    state.attempts = [];
    tick();
    state.intervalId = setInterval(tick, INTERVAL_MS);
  }

  function stop() {
    if (!state.intervalId) return;
    clearInterval(state.intervalId);
    state.intervalId = null;
    notify("idle");
  }

  function onStatusChange(fn) {
    state.listeners.add(fn);
    if (state.lastStatus) fn(state.lastStatus);
    return () => state.listeners.delete(fn);
  }

  ns.captionsWatchdog = { start, stop, onStatusChange, getStatus: () => state.lastStatus };
})();
