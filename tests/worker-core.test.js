const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLibraries } = require("./helpers");
const { createFakeChrome, createFakeSecureStore, createFakeFetch } = require("./fake-chrome");

const LIBS = [
  "src/lib/logger.js",
  "src/lib/config.js",
  "src/lib/storage.js",
  "src/lib/vcon.js",
  "src/lib/retry-policy.js",
];
const ENDPOINT = "https://api.sippulse.com/v1/meet-captures";
const T0 = Date.parse("2026-09-04T12:00:00.000Z");

async function setup({ fetchResponder, chromeOptions } = {}) {
  const { createWorkerCore, STALE_MEETING_MS, UPLOAD_GRACE_MS, DISCARD_TTL_MS } = await import(
    "../src/background/worker-core.mjs"
  );
  const chrome = createFakeChrome(chromeOptions);
  await chrome.storage.managed.set({ EndpointUrl: ENDPOINT, BearerToken: "pilot-token" });
  await chrome.storage.local.set({ consent: { accepted: true } });
  const lib = loadLibraries(LIBS, { chrome });
  lib.log = { debug() {}, info() {}, warn() {}, error() {} };
  const secureStore = createFakeSecureStore();
  const fetch = createFakeFetch(fetchResponder);
  const clock = { now: T0 };
  const core = createWorkerCore({
    chrome,
    secureStore,
    lib,
    fetch,
    now: () => clock.now,
    version: "test",
  });
  return { core, chrome, secureStore, fetch, clock, STALE_MEETING_MS, UPLOAD_GRACE_MS, DISCARD_TTL_MS };
}

function record(meetingId = "abc-defg-hij", utterances = [{ speaker: "Ana", text: "Olá", start: "2026-09-04T12:00:01.000Z", duration: 1 }]) {
  return {
    uuid: `uuid-${meetingId}`,
    meetingId,
    meetingUrl: `https://meet.google.com/${meetingId}`,
    subject: "Weekly sync",
    startedAt: "2026-09-04T12:00:00.000Z",
    captionsEnabled: true,
    utterances,
  };
}

const send = (core, message) => core.handleMessage(message);
const status = async (chrome) => (await chrome.storage.local.get("deliveryStatus")).deliveryStatus;
const queue = async (chrome) => (await chrome.storage.local.get("queue")).queue || [];

test("failed final delivery is queued, the active record is removed, and the caller is told it was handled", async () => {
  const { core, chrome, secureStore, fetch } = await setup({ fetchResponder: () => ({ status: 503 }) });
  await send(core, { type: "active_meeting_put", record: record() });

  const result = await send(core, { type: "call_ended", meetingId: "abc-defg-hij" });

  assert.equal(result.ok, false);
  assert.equal(result.queued, true);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].init.headers["X-SipPulse-Delivery"], "final");
  assert.equal(fetch.calls[0].init.headers["X-SipPulse-Transcription-Source"], "google_captions");
  assert.equal(await secureStore.get("active:abc-defg-hij"), null);
  const items = await queue(chrome);
  assert.equal(items.length, 1);
  assert.equal(items[0].state, "queued");
  assert.ok(secureStore._records.has(`queue:${items[0].id}`), "encrypted payload retained");
  assert.ok(chrome.alarms._alarms.has(`retry:${items[0].id}`), "retry alarm scheduled");
  assert.equal((await status(chrome)).state, "queued");
});

test("a call with no captions is closed without delivery and leaves no active record", async () => {
  const { core, chrome, fetch } = await setup();
  await send(core, { type: "active_meeting_put", record: record("abc-defg-hij", []) });

  const result = await send(core, { type: "call_ended", meetingId: "abc-defg-hij" });

  assert.equal(result.ok, false);
  assert.equal(fetch.calls.length, 0);
  const index = (await chrome.storage.local.get("activeMeetingIndex")).activeMeetingIndex;
  assert.deepEqual(index, {});
  assert.equal((await status(chrome)).state, "needs_attention");
});

test("successful delivery stores a local copy of the last transcript", async () => {
  const { core, chrome } = await setup();
  await send(core, { type: "active_meeting_put", record: record() });
  await send(core, { type: "call_ended", meetingId: "abc-defg-hij" });

  const last = await send(core, { type: "get_last_transcript" });
  assert.equal(last.document.uuid, "uuid-abc-defg-hij");
  const popup = await send(core, { type: "get_popup_state" });
  assert.equal(popup.lastTranscript.uuid, "uuid-abc-defg-hij");
  assert.equal((await status(chrome)).state, "delivered");
});

test("stop-and-discard is sticky for the call until the collaborator leaves", async () => {
  const { core, chrome, clock, DISCARD_TTL_MS } = await setup();
  await send(core, { type: "active_meeting_put", record: record() });

  await send(core, { type: "capture_cancelled", meetingId: "abc-defg-hij" });

  assert.equal((await send(core, { type: "meeting_discarded_get", meetingId: "abc-defg-hij" })).discarded, true);
  await assert.rejects(send(core, { type: "active_meeting_put", record: record() }), /discarded/);
  const blocked = await send(core, { type: "start_ai_capture", meetingId: "abc-defg-hij", tabId: 7 });
  assert.equal(blocked.ok, false);
  assert.equal((await status(chrome)).state, "disabled_for_call");
  assert.deepEqual((await send(core, { type: "get_popup_state" })).discardedMeetingIds, ["abc-defg-hij"]);

  await send(core, { type: "call_left", meetingId: "abc-defg-hij" });
  assert.equal((await send(core, { type: "meeting_discarded_get", meetingId: "abc-defg-hij" })).discarded, false);

  // Recurring meeting codes: a marker that was never cleared expires.
  await send(core, { type: "capture_cancelled", meetingId: "abc-defg-hij" });
  clock.now = T0 + DISCARD_TTL_MS + 1;
  assert.equal((await send(core, { type: "meeting_discarded_get", meetingId: "abc-defg-hij" })).discarded, false);
});

test("discarding the last outbox item clears the global status", async () => {
  const { core, chrome } = await setup({ fetchResponder: () => ({ status: 500 }) });
  await send(core, { type: "active_meeting_put", record: record() });
  await send(core, { type: "call_ended", meetingId: "abc-defg-hij" });
  const [item] = await queue(chrome);

  await send(core, { type: "discard_queue_item", id: item.id });

  assert.deepEqual(await queue(chrome), []);
  assert.equal((await status(chrome)).state, "idle");
  assert.ok(!chrome.alarms._alarms.has(`retry:${item.id}`));
});

test("automatic retries exhaust into needs_attention and keep the payload; manual retry can still deliver", async () => {
  let failures = 0;
  const { core, chrome, secureStore, clock } = await setup({
    fetchResponder: () => (failures++ < 7 ? { status: 502 } : { status: 200 }),
  });
  await send(core, { type: "active_meeting_put", record: record() });
  await send(core, { type: "call_ended", meetingId: "abc-defg-hij" });
  const [item] = await queue(chrome);

  for (let i = 0; i < 6; i++) {
    clock.now += 24 * 60 * 60_000;
    await core.handleAlarm({ name: `retry:${item.id}` });
  }
  let [current] = await queue(chrome);
  assert.equal(current.state, "needs_attention");
  assert.equal(current.nextAttemptAt, null);
  assert.ok(secureStore._records.has(`queue:${item.id}`));
  assert.equal((await status(chrome)).state, "needs_attention");

  const downloaded = await send(core, { type: "get_queue_item_document", id: item.id });
  assert.equal(downloaded.document.uuid, "uuid-abc-defg-hij");

  const retried = await send(core, { type: "retry_queue_item", id: item.id });
  assert.equal(retried.ok, true);
  assert.deepEqual(await queue(chrome), []);
  assert.equal((await status(chrome)).state, "delivered");
});

test("connection test uses a contract-valid source and the test delivery kind", async () => {
  const { core, fetch } = await setup();
  const result = await send(core, { type: "test_connection" });
  assert.equal(result.ok, true);
  assert.equal(fetch.calls[0].init.headers["X-SipPulse-Delivery"], "test");
  assert.equal(fetch.calls[0].init.headers["X-SipPulse-Transcription-Source"], "google_captions");
  assert.equal(fetch.calls[0].init.headers.Authorization, "Bearer pilot-token");
});

test("SipPulse AI capture obtains the tab stream in the worker, starts the recorder, and tells the Meet tab", async () => {
  const { core, chrome } = await setup();
  await send(core, { type: "active_meeting_put", record: record() });

  const result = await send(core, { type: "start_ai_capture", meetingId: "abc-defg-hij", tabId: 42 });

  assert.equal(result.ok, true);
  const start = chrome.runtime._messages.find((m) => m.type === "ai_capture_start");
  assert.equal(start.streamId, "stream-for-tab-42");
  assert.equal(start.target, "offscreen");
  assert.equal(chrome._state.offscreenOpen, true);
  assert.deepEqual(chrome.tabs._messages[0], {
    tabId: 42,
    message: { type: "ai_capture_state", meetingId: "abc-defg-hij", active: true },
  });
  const popup = await send(core, { type: "get_popup_state" });
  assert.deepEqual(popup.aiMeetingIds, ["abc-defg-hij"]);
  assert.equal(popup.status.source, "sippulse_ai");
});

test("a microphone permission failure from the recorder is surfaced with its code and leaves no session", async () => {
  const { core, chrome } = await setup({
    chromeOptions: {
      onRuntimeMessage: (message) =>
        message.type === "ai_capture_start"
          ? { ok: false, error: "no mic", code: "microphone_permission" }
          : { ok: true },
    },
  });
  await send(core, { type: "active_meeting_put", record: record() });

  const result = await send(core, { type: "start_ai_capture", meetingId: "abc-defg-hij", tabId: 42 });

  assert.equal(result.ok, false);
  assert.equal(result.code, "microphone_permission");
  assert.deepEqual((await send(core, { type: "get_popup_state" })).aiMeetingIds, []);
  assert.equal(chrome._state.offscreenOpen, false);
});

test("AI call end hands off to the recorder, then the upload result finalizes without a duplicate caption delivery", async () => {
  const { core, chrome, fetch } = await setup();
  await send(core, { type: "active_meeting_put", record: record() });
  await send(core, { type: "start_ai_capture", meetingId: "abc-defg-hij", tabId: 42 });

  const ended = await send(core, { type: "call_ended", meetingId: "abc-defg-hij" });
  assert.equal(ended.ok, true);
  assert.equal(ended.pending, true);
  const stop = chrome.runtime._messages.find((m) => m.type === "ai_capture_stop");
  assert.equal(stop.vcon.attachments[0].body.transcription_source, "google_captions_fallback");
  assert.equal((await status(chrome)).state, "uploading");
  // A second call_ended while uploading (tab unload + recovery) is a no-op.
  assert.equal((await send(core, { type: "call_ended", meetingId: "abc-defg-hij" })).pending, true);

  await send(core, { type: "ai_upload_result", meetingId: "abc-defg-hij", result: { ok: true, requestId: "req-1" } });

  assert.equal(fetch.calls.length, 0, "no caption vCon posted after a successful audio upload");
  assert.equal((await status(chrome)).state, "processing");
  assert.deepEqual((await send(core, { type: "get_popup_state" })).activeMeetingIds, []);
  assert.deepEqual(chrome.tabs._messages.at(-1).message, { type: "ai_capture_state", meetingId: "abc-defg-hij", active: false });
});

test("a failed audio upload falls back to the Google-caption vCon", async () => {
  const { core, chrome, fetch } = await setup();
  await send(core, { type: "active_meeting_put", record: record() });
  await send(core, { type: "start_ai_capture", meetingId: "abc-defg-hij", tabId: 42 });
  await send(core, { type: "call_ended", meetingId: "abc-defg-hij" });

  await send(core, { type: "ai_upload_result", meetingId: "abc-defg-hij", result: { ok: false, error: "HTTP 502" } });

  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].init.headers["X-SipPulse-Transcription-Source"], "google_captions_fallback");
  assert.equal((await status(chrome)).state, "delivered");
});

test("recovery finalizes only stale meetings and gives a pending upload a grace period", async () => {
  const { core, chrome, fetch, clock, STALE_MEETING_MS, UPLOAD_GRACE_MS } = await setup();
  await send(core, { type: "active_meeting_put", record: record("aaa-bbbb-ccc") });
  await send(core, { type: "active_meeting_put", record: record("ddd-eeee-fff") });
  clock.now = T0 + STALE_MEETING_MS + 1;
  await send(core, { type: "active_meeting_put", record: record("ddd-eeee-fff") });

  await core.recoverStaleMeetings();

  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].init.headers["X-SipPulse-Delivery"], "recovered");
  assert.deepEqual((await send(core, { type: "get_popup_state" })).activeMeetingIds, ["ddd-eeee-fff"]);

  await send(core, { type: "start_ai_capture", meetingId: "ddd-eeee-fff", tabId: 9 });
  await send(core, { type: "call_ended", meetingId: "ddd-eeee-fff" });
  clock.now += UPLOAD_GRACE_MS - 1;
  await core.recoverStaleMeetings();
  assert.equal(fetch.calls.length, 1, "upload still within grace period");
  clock.now += 2;
  await core.recoverStaleMeetings();
  assert.equal(fetch.calls.length, 2, "stuck upload falls back to captions");
  assert.deepEqual((await send(core, { type: "get_popup_state" })).activeMeetingIds, []);
});

test("delivery is refused when the Chrome profile domain is not allowed by policy", async () => {
  const { core, chrome, fetch } = await setup({ chromeOptions: { email: "someone@gmail.com" } });
  await send(core, { type: "active_meeting_put", record: record() });
  const result = await send(core, { type: "call_ended", meetingId: "abc-defg-hij" });
  assert.equal(result.ok, false);
  assert.equal(fetch.calls.length, 0);
  assert.equal((await status(chrome)).state, "needs_attention");
});
