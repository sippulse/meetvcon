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
  "src/lib/transcription.js",
  "src/lib/analysis.js",
  "src/lib/classification.js",
];
const ENDPOINT = "https://api.sippulse.com/v1/meet-captures";
const T0 = Date.parse("2026-09-04T12:00:00.000Z");

async function setup({ fetchResponder, chromeOptions, policy = {} } = {}) {
  const { createWorkerCore, STALE_MEETING_MS, FINALIZE_GRACE_MS, DISCARD_TTL_MS } = await import(
    "../src/background/worker-core.mjs"
  );
  const chrome = createFakeChrome(chromeOptions);
  await chrome.storage.managed.set({
    EndpointUrl: ENDPOINT,
    BearerToken: "pilot-token",
    SipPulseAiApiKey: "sp-key",
    TypeSafeApiKey: "ts-key",
    ...policy,
  });
  await chrome.storage.local.set({ consent: { accepted: true, version: 2 } });
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
  return { core, chrome, secureStore, fetch, clock, STALE_MEETING_MS, FINALIZE_GRACE_MS, DISCARD_TTL_MS };
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

test("connection test uses a contract-valid source and also checks the SipPulse AI and TypeSafe keys", async () => {
  const { core, fetch } = await setup();
  const result = await send(core, { type: "test_connection" });
  assert.equal(result.ok, true);
  const storageCall = fetch.calls.find((call) => call.url === ENDPOINT);
  assert.equal(storageCall.init.headers["X-SipPulse-Delivery"], "test");
  assert.equal(storageCall.init.headers["X-SipPulse-Transcription-Source"], "google_captions");
  assert.equal(storageCall.init.headers.Authorization, "Bearer pilot-token");
  const sippulse = fetch.calls.find((call) => call.url.startsWith("https://api.dev.sippulse.ai/"));
  assert.equal(sippulse.init.headers["api-key"], "sp-key");
  const typesafe = fetch.calls.find((call) => call.url.startsWith("https://api.typesafe.ai/"));
  assert.equal(typesafe.init.headers.Authorization, "Bearer ts-key");
  assert.equal(result.services.sippulseAi.ok, true);
  assert.equal(result.services.typesafe.ok, true);
});

const LIVE_RESULT = {
  ok: true,
  streamStartedAt: "2026-09-04T12:00:00.500Z",
  transcription: { provider: "sippulse_ai", model: "pulse-stt-streaming-v1", language: "pt-BR" },
  utterances: [
    { segment_id: 1, speaker: "Ana", email: "ana@sippulse.com", text: "Envio a proposta.", start: "2026-09-04T12:00:02.000Z", duration: 2, channel: "microphone" },
    { segment_id: 2, speaker: "Bruno Lima", text: "Combinado.", start: "2026-09-04T12:00:05.000Z", duration: 1, channel: "meeting" },
  ],
  classifications: { 1: { intent: "commitment", intent_confidence: 0.99, sentiment: 0.5, action_item: 0.98 } },
  classificationModel: "jev-1.13.0",
  stats: [
    { speaker: "Ana", talk_seconds: 2, talk_share: 0.667, turns: 1 },
    { speaker: "Bruno Lima", talk_seconds: 1, talk_share: 0.333, turns: 1 },
  ],
  analysis: {
    summary: "Ana envia a proposta.",
    key_points: [],
    topics: [],
    intents: [{ speaker: "Ana", intent: "commitment", detail: "Envio a proposta.", at: "00:02", confidence: 0.99 }],
    action_items: [{ owner: "Ana", task: "Enviar proposta", due: "" }],
    decisions: [],
    open_questions: [],
    sentiment: [{ speaker: "Ana", label: "positive", score: 0.5, note: "1 classified utterance" }],
  },
  analysisModel: "deepseek-v4.1-flash",
  analysisError: "",
};

async function startLive(core, meetingId = "abc-defg-hij", tabId = 42) {
  await send(core, { type: "active_meeting_put", record: record(meetingId) });
  return send(core, { type: "start_ai_capture", meetingId, tabId });
}

test("live capture obtains the tab stream in the worker, hands the recorder its keys and endpoints, and tells the Meet tab", async () => {
  const { core, chrome } = await setup({
    chromeOptions: {
      onRuntimeMessage: (message) =>
        message.type === "ai_capture_start" ? { ok: true, streamStartedAt: "2026-09-04T12:00:00.500Z" } : { ok: true },
    },
  });

  const result = await startLive(core);

  assert.equal(result.ok, true);
  const start = chrome.runtime._messages.find((m) => m.type === "ai_capture_start");
  assert.equal(start.streamId, "stream-for-tab-42");
  assert.equal(start.target, "offscreen");
  assert.equal(start.config.sippulseAiApiKey, "sp-key");
  assert.equal(start.config.typesafeApiKey, "ts-key");
  assert.equal(start.config.transcription.model, "pulse-stt-streaming-v1");
  assert.equal(start.config.transcription.streamBase, "wss://api.dev.sippulse.ai");
  assert.equal(start.config.analysis.model, "deepseek-v4.1-flash");
  assert.equal(start.config.classification.model, "jev-latest");
  assert.equal(start.collaborator.email, "ana@sippulse.com");
  assert.equal(start.captions[0].speaker, "Ana");
  assert.equal(chrome._state.offscreenOpen, true);
  assert.deepEqual(chrome.tabs._messages[0], {
    tabId: 42,
    message: {
      type: "ai_capture_state",
      meetingId: "abc-defg-hij",
      active: true,
      streamStartedAt: "2026-09-04T12:00:00.500Z",
      analysisEnabled: true,
      classificationEnabled: true,
    },
  });
  const popup = await send(core, { type: "get_popup_state" });
  assert.deepEqual(popup.aiMeetingIds, ["abc-defg-hij"]);
  assert.deepEqual(popup.liveSessions, { "abc-defg-hij": { streamStartedAt: "2026-09-04T12:00:00.500Z" } });
  assert.equal(popup.status.source, "sippulse_ai_live");
});

test("live capture is refused when the SipPulse AI key is not configured", async () => {
  const { core, chrome } = await setup({ policy: { SipPulseAiApiKey: "" } });
  const result = await startLive(core);
  assert.equal(result.ok, false);
  assert.match(result.error, /not configured/);
  assert.equal(chrome._state.offscreenOpen, false);
});

test("live updates from the recorder are relayed to the Meet tab, and captions are forwarded for speaker names", async () => {
  const { core, chrome } = await setup();
  await startLive(core);
  const update = { kind: "segment", segment: { id: 1, channel: 1, speaker: null, text: "Oi", start: 1, end: 2 } };

  const relayed = await send(core, { type: "live_update", meetingId: "abc-defg-hij", update });
  await send(core, { type: "active_meeting_put", record: record() });

  assert.equal(relayed.ok, true);
  assert.deepEqual(chrome.tabs._messages.at(-1), {
    tabId: 42,
    message: { type: "live_update", meetingId: "abc-defg-hij", update },
  });
  const forwarded = chrome.runtime._messages.filter((m) => m.type === "ai_captions");
  assert.equal(forwarded.at(-1).captions[0].speaker, "Ana");
  assert.equal((await send(core, { type: "live_update", meetingId: "zzz-zzzz-zzz", update })).ok, false);
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

  const result = await startLive(core);

  assert.equal(result.ok, false);
  assert.equal(result.code, "microphone_permission");
  assert.deepEqual((await send(core, { type: "get_popup_state" })).aiMeetingIds, []);
  assert.equal(chrome._state.offscreenOpen, false);
});

test("call end hands off to the recorder, then its result delivers one live vCon with the report and Jev classifications", async () => {
  const { core, chrome, fetch } = await setup();
  await startLive(core);

  const ended = await send(core, { type: "call_ended", meetingId: "abc-defg-hij" });
  assert.equal(ended.ok, true);
  assert.equal(ended.pending, true);
  const stop = chrome.runtime._messages.find((m) => m.type === "ai_capture_stop");
  assert.equal(stop.captions[0].speaker, "Ana");
  assert.equal(stop.collaborator.email, "ana@sippulse.com");
  assert.equal((await status(chrome)).state, "finalizing");
  // A second call_ended while finalizing (tab unload + recovery) is a no-op.
  assert.equal((await send(core, { type: "call_ended", meetingId: "abc-defg-hij" })).pending, true);
  assert.equal(fetch.calls.length, 0);

  await send(core, { type: "ai_session_result", meetingId: "abc-defg-hij", result: LIVE_RESULT });

  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].init.headers["X-SipPulse-Transcription-Source"], "sippulse_ai_live");
  const document = JSON.parse(fetch.calls[0].init.body);
  assert.equal(document.uuid, "uuid-abc-defg-hij");
  assert.deepEqual(document.parties, [{ name: "Ana", mailto: "ana@sippulse.com" }, { name: "Bruno Lima" }]);
  assert.deepEqual(document.analysis.map((entry) => entry.type), [
    "summary",
    "meeting_insights",
    "speaker_analytics",
    "utterance_classification",
  ]);
  assert.equal(document.analysis[1].body.action_items[0].task, "Enviar proposta");
  assert.equal(document.analysis[1].body.intents[0].intent, "commitment");
  assert.deepEqual(document.analysis[3].body, [
    { dialog: 0, intent: "commitment", intent_confidence: 0.99, sentiment: 0.5, action_item: 0.98 },
  ]);
  assert.equal(document.analysis[3].product, "jev-1.13.0");
  assert.equal(document.attachments[0].body.transcription.model, "pulse-stt-streaming-v1");
  assert.equal((await status(chrome)).state, "delivered");
  assert.deepEqual((await send(core, { type: "get_popup_state" })).activeMeetingIds, []);
  assert.equal((await send(core, { type: "get_popup_state" })).lastTranscript.hasReport, true);
  assert.deepEqual(chrome.tabs._messages.at(-1).message, { type: "ai_capture_state", meetingId: "abc-defg-hij", active: false });
});

test("a failed recorder result falls back to the live segments and classifications saved during the call", async () => {
  const { core, fetch } = await setup();
  await startLive(core);
  await send(core, {
    type: "active_meeting_put",
    record: {
      ...record(),
      liveStreamStartedAt: "2026-09-04T12:00:00.000Z",
      liveSegments: [{ id: 1, channel: 1, speaker: null, text: "Proposta até sexta.", start: 1, end: 3, confidence: 0.9 }],
      liveClassifications: { 1: { intent: "commitment", intent_confidence: 0.95, sentiment: 0, action_item: 0.9 } },
      liveAnalysis: { summary: "Notas ao vivo.", key_points: [], topics: [], action_items: [], decisions: [], open_questions: [] },
    },
  });
  await send(core, { type: "call_ended", meetingId: "abc-defg-hij" });

  await send(core, { type: "ai_session_result", meetingId: "abc-defg-hij", result: { ok: false, error: "socket lost" } });

  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].init.headers["X-SipPulse-Transcription-Source"], "sippulse_ai_live_recovered");
  const document = JSON.parse(fetch.calls[0].init.body);
  assert.equal(document.dialog[0].body, "Proposta até sexta.");
  assert.equal(document.analysis[0].body, "Notas ao vivo.");
  assert.equal(document.analysis[1].body.intents[0].intent, "commitment");
  assert.equal(document.analysis.at(-1).type, "utterance_classification");
  assert.match(document.attachments[0].body.analysis_error, /live notes/);
});

test("with no live transcript at all, the Google-caption vCon is delivered", async () => {
  const { core, chrome, fetch } = await setup();
  await startLive(core);
  await send(core, { type: "call_ended", meetingId: "abc-defg-hij" });

  await send(core, { type: "ai_session_result", meetingId: "abc-defg-hij", result: { ok: false, error: "Live transcription returned no speech" } });

  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].init.headers["X-SipPulse-Transcription-Source"], "google_captions_fallback");
  assert.equal((await status(chrome)).state, "delivered");
});

test("recovery finalizes only stale meetings and gives a finalizing recorder a grace period", async () => {
  const { core, fetch, clock, STALE_MEETING_MS, FINALIZE_GRACE_MS } = await setup();
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
  clock.now += FINALIZE_GRACE_MS - 1;
  await core.recoverStaleMeetings();
  assert.equal(fetch.calls.length, 1, "recorder still within grace period");
  clock.now += 2;
  await core.recoverStaleMeetings();
  assert.equal(fetch.calls.length, 2, "stuck recorder falls back to captions");
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

const OPTIONS = { url: "chrome-extension://test/src/options/options.html" };

test("local settings fill what Google Admin policy leaves unset, and policy fields stay locked", async () => {
  const { core, chrome } = await setup({
    policy: { EndpointUrl: "", BearerToken: "", SipPulseAiApiKey: "", TypeSafeApiKey: "" },
  });
  assert.equal((await send(core, { type: "get_popup_state" })).config.configured, false);

  const saved = await core.handleMessage(
    {
      type: "save_settings",
      settings: {
        EndpointUrl: ENDPOINT,
        BearerToken: "local-token",
        SipPulseAiApiKey: "local-sp-key-1234",
        AllowedEmailDomains: "sippulse.com, example.com",
      },
    },
    OPTIONS
  );

  assert.equal(saved.ok, true);
  assert.deepEqual(saved.fields.SipPulseAiApiKey, {
    source: "local",
    locked: false,
    value: "••••1234",
    localValue: "••••1234",
  });
  assert.deepEqual(saved.fields.AllowedEmailDomains.value, ["sippulse.com", "example.com"]);
  assert.equal(saved.fields.TypeSafeApiKey.source, "default");
  const stored = JSON.stringify(await chrome.storage.local.get(null));
  assert.equal(stored.includes("local-sp-key"), false, "keys are only in the encrypted store");

  const popup = await send(core, { type: "get_popup_state" });
  assert.equal(popup.config.configured, true);
  assert.equal(popup.config.liveTranscriptionReady, true);
  assert.equal(popup.config.classificationReady, false);
  const started = await startLive(core);
  assert.equal(started.ok, true);
  const start = chrome.runtime._messages.find((m) => m.type === "ai_capture_start");
  assert.equal(start.config.sippulseAiApiKey, "local-sp-key-1234");
});

test("policy wins over local settings, and saving never overrides a policy field", async () => {
  const { core, chrome } = await setup();
  await core.handleMessage(
    { type: "save_settings", settings: { SipPulseAiApiKey: "local-key", TypeSafeApiKey: "local-ts" } },
    OPTIONS
  );
  const settings = await core.handleMessage({ type: "get_settings" }, OPTIONS);
  assert.equal(settings.fields.SipPulseAiApiKey.source, "policy");
  assert.equal(settings.fields.SipPulseAiApiKey.locked, true);
  assert.equal(settings.fields.SipPulseAiApiKey.localValue, "", "locked fields are not stored locally");

  await startLive(core);
  const start = chrome.runtime._messages.find((m) => m.type === "ai_capture_start");
  assert.equal(start.config.sippulseAiApiKey, "sp-key");
  assert.equal(start.config.typesafeApiKey, "ts-key");
});

test("an empty secret keeps the stored one, remove clears it, and bad endpoints are refused", async () => {
  const { core } = await setup({ policy: { SipPulseAiApiKey: "", EndpointUrl: "", BearerToken: "" } });
  await core.handleMessage({ type: "save_settings", settings: { SipPulseAiApiKey: "keep-me-9999" } }, OPTIONS);
  let result = await core.handleMessage({ type: "save_settings", settings: { SipPulseAiApiKey: "" } }, OPTIONS);
  assert.equal(result.fields.SipPulseAiApiKey.value, "••••9999");
  result = await core.handleMessage({ type: "save_settings", remove: ["SipPulseAiApiKey"] }, OPTIONS);
  assert.equal(result.fields.SipPulseAiApiKey.source, "default");

  const refused = await core.handleMessage(
    { type: "save_settings", settings: { EndpointUrl: "https://collector.example.com/vcon" } },
    OPTIONS
  );
  assert.equal(refused.ok, false);
  assert.match(refused.error, /api\.sippulse\.com/);
});

test("settings can only be read or changed from the extension's options page", async () => {
  const { core } = await setup();
  const meetTab = { url: "https://meet.google.com/abc-defg-hij", tab: { id: 4 } };
  assert.equal((await core.handleMessage({ type: "get_settings" }, meetTab)).ok, false);
  assert.equal((await core.handleMessage({ type: "save_settings", settings: { SipPulseAiApiKey: "x" } }, meetTab)).ok, false);
  assert.equal((await core.handleMessage({ type: "get_settings" })).ok, false);
});
