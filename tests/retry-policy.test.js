const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLibrary } = require("./helpers");

test("exhausted delivery remains recoverable", () => {
  const { retryPolicy } = loadLibrary("src/lib/retry-policy.js");
  const result = retryPolicy.afterFailure(
    retryPolicy.DELAYS_MINUTES.length - 1,
    Date.parse("2026-09-04T12:00:00.000Z")
  );
  assert.deepEqual(
    { ...result },
    {
      attempts: retryPolicy.DELAYS_MINUTES.length,
      state: "needs_attention",
      nextAttemptAt: null,
    }
  );
});
