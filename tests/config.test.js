const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLibrary } = require("./helpers");

test("managed configuration fails closed without endpoint and auth", () => {
  const { config } = loadLibrary("src/lib/config.js");
  const result = config.normalize({});
  assert.equal(result.configured, false);
});

test("managed configuration accepts only authenticated api.sippulse.com endpoints", () => {
  const { config } = loadLibrary("src/lib/config.js");
  const result = config.normalize({
    EndpointUrl: "https://api.sippulse.com/v1/meet-captures",
    BearerToken: "managed-pilot-token",
  });
  assert.equal(result.configured, true);

  const external = config.normalize({
    EndpointUrl: "https://example.com/collect",
    BearerToken: "token",
  });
  assert.equal(external.configured, false);
});

test("collaborator domain defaults to sippulse.com and follows managed policy", () => {
  const { config } = loadLibrary("src/lib/config.js");
  const internal = config.normalize({});
  assert.equal(config.isAllowedEmail("ana@sippulse.com", internal), true);
  assert.equal(config.isAllowedEmail("ana@SipPulse.com", internal), true);
  assert.equal(config.isAllowedEmail("ana@gmail.com", internal), false);
  assert.equal(config.isAllowedEmail("evil@sippulse.com.attacker.io", internal), false);

  const external = config.normalize({ AllowedEmailDomains: ["@Example.com", ""] });
  assert.equal(config.isAllowedEmail("bob@example.com", external), true);
  assert.equal(config.isAllowedEmail("ana@sippulse.com", external), false);
  assert.deepEqual([...config.normalize({ AllowedEmailDomains: [] }).allowedEmailDomains], ["sippulse.com"]);
});
