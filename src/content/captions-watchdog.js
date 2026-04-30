// Captions watchdog: ensures Google Meet captions are enabled while in a call.
//
// Strategy (PRD §6.1.1):
//   1. Click the captions toggle button (aria-label match).
//   2. Fallback: dispatch keyboard "c" event (Meet's built-in shortcut).
//   3. Watchdog: re-check every 10s while in call; re-enable if turned off.
//   4. Rate limit: max 3 enable attempts per minute (don't fight a user
//      who deliberately disables captions).
//   5. Hard opt-out: if the user clicks "Disable for this call" in the
//      MeetVcon panel, watchdog stops.

(function () {
  const ns = (window.MeetVcon = window.MeetVcon || {});
  if (ns.captionsWatchdog) return;

  const { log, selectors } = ns;

  const WATCHDOG_INTERVAL_MS = 10_000;
  const RATE_WINDOW_MS = 60_000;
  const RATE_MAX_ATTEMPTS = 3;

  const state = {
    intervalId: null,
    attemptTimestamps: [], // ms epochs of recent enable attempts
    optedOut: false,
    listeners: new Set(), // (status) => void
    lastStatus: null,
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
    state.attemptTimestamps = state.attemptTimestamps.filter(
      (t) => now - t < RATE_WINDOW_MS
    );
    return state.attemptTimestamps.length >= RATE_MAX_ATTEMPTS;
  }

  function recordAttempt() {
    state.attemptTimestamps.push(Date.now());
  }

  // Strategy 1: aria-label click.
  function tryClickToggle() {
    const btn = selectors.findCaptionsToggleButton();
    if (!btn) {
      log.debug("captions toggle button not found");
      return false;
    }
    log.debug("clicking captions toggle", btn.getAttribute("aria-label"));
    btn.click();
    return true;
  }

  // Strategy 2: keyboard "c" shortcut.
  function tryKeyboardShortcut() {
    log.debug("dispatching 'c' keydown to toggle captions");
    const init = {
      key: "c",
      code: "KeyC",
      keyCode: 67,
      which: 67,
      bubbles: true,
      cancelable: true,
    };
    document.body.dispatchEvent(new KeyboardEvent("keydown", init));
    document.body.dispatchEvent(new KeyboardEvent("keypress", init));
    document.body.dispatchEvent(new KeyboardEvent("keyup", init));
    return true;
  }

  function attemptEnable(reason) {
    if (state.optedOut) {
      log.debug("skip enable: user opted out");
      return false;
    }
    if (rateLimited()) {
      log.warn("skip enable: rate-limited (3 attempts/min)");
      return false;
    }
    log.info("attempting to enable captions:", reason);
    recordAttempt();

    if (tryClickToggle()) {
      // Verify after a short delay that it took effect.
      setTimeout(() => {
        if (!selectors.areCaptionsActive()) {
          log.warn("toggle click did not enable captions, trying keyboard");
          tryKeyboardShortcut();
        }
      }, 500);
      return true;
    }
    return tryKeyboardShortcut();
  }

  function tick() {
    if (!selectors.isInCall()) {
      // Out of call — emit "idle" status and skip.
      notify("idle");
      return;
    }
    if (selectors.areCaptionsActive()) {
      notify("active");
      return;
    }
    notify("enabling");
    attemptEnable("watchdog detected captions off");
  }

  function start() {
    if (state.intervalId) return;
    log.info("captions watchdog started");
    // Run a tick immediately, then on interval.
    tick();
    state.intervalId = setInterval(tick, WATCHDOG_INTERVAL_MS);
  }

  function stop() {
    if (!state.intervalId) return;
    clearInterval(state.intervalId);
    state.intervalId = null;
    log.info("captions watchdog stopped");
    notify("idle");
  }

  function optOut() {
    state.optedOut = true;
    notify("opted_out");
    log.info("user opted out of caption auto-enable for this call");
  }

  function clearOptOut() {
    state.optedOut = false;
    log.info("opt-out cleared");
  }

  function onStatusChange(fn) {
    state.listeners.add(fn);
    if (state.lastStatus) fn(state.lastStatus);
    return () => state.listeners.delete(fn);
  }

  // Manual one-shot, e.g. from a "Try again" button.
  function forceEnable() {
    state.attemptTimestamps = []; // reset rate limit on user request
    state.optedOut = false;
    return attemptEnable("manual user request");
  }

  ns.captionsWatchdog = {
    start,
    stop,
    optOut,
    clearOptOut,
    forceEnable,
    onStatusChange,
    getStatus: () => state.lastStatus,
  };
})();
