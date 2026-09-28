// Watches whether Google Meet captions are on. It does not turn them on:
// forcing CC changed what everyone in the call saw on screen, for a fallback
// transcript the collaborator may not want. When the user enables captions we
// read them (src/content/transcript-capture.js), and their labels name remote
// speakers; when they don't, live transcription still works on its own.

(function () {
  const ns = (window.MeetVcon = window.MeetVcon || {});
  if (ns.captionsWatchdog) return;

  const { log, selectors } = ns;
  const INTERVAL_MS = 5_000;

  const state = {
    intervalId: null,
    lastStatus: null,
    listeners: new Set(),
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

  function tick() {
    if (!selectors.isInCall()) return notify("idle");
    notify(selectors.areCaptionsActive() ? "active" : "off");
  }

  function start() {
    if (state.intervalId) return;
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
