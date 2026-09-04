// Pure retry state transitions, kept separate so data-loss behavior is tested.

(function (root) {
  const ns = (root.MeetVcon = root.MeetVcon || {});
  if (ns.retryPolicy) return;

  const DELAYS_MINUTES = Object.freeze([0.5, 2, 10, 60, 360, 1440]);

  function afterFailure(currentAttempts, nowMs = Date.now()) {
    const attempts = currentAttempts + 1;
    if (attempts >= DELAYS_MINUTES.length) {
      return { attempts, state: "needs_attention", nextAttemptAt: null };
    }
    return {
      attempts,
      state: "queued",
      nextAttemptAt: new Date(
        nowMs + DELAYS_MINUTES[attempts] * 60_000
      ).toISOString(),
    };
  }

  ns.retryPolicy = { DELAYS_MINUTES, afterFailure };
})(typeof self !== "undefined" ? self : window);
