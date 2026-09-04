// SipPulse Meet Capture service worker: encrypted crash recovery, fixed
// SipPulse delivery, retry scheduling, and SipPulse AI audio orchestration.

import "../lib/logger.js";
import "../lib/config.js";
import "../lib/storage.js";
import "../lib/vcon.js";
import "../lib/retry-policy.js";
import {
  getSecureRecord,
  putSecureRecord,
  removeSecureRecord,
} from "./secure-store.js";

const { log, storage, vcon, retryPolicy } = self.MeetVcon;
const VERSION = "0.2.0";
const ACTIVE_INDEX_KEY = "activeMeetingIndex";
const AI_SESSIONS_KEY = "aiSessions";
const RECOVERY_ALARM = "recovery-scan";
const OFFSCREEN_CLEANUP_ALARM = "offscreen-cleanup";
const STALE_MEETING_MS = 90_000;
const FETCH_TIMEOUT_MS = 30_000;
const OFFSCREEN_PATH = "src/offscreen/offscreen.html";
const finalizationTasks = new Map();

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
  migrateLegacyStorage()
    .then(initialize)
    .catch((error) => log.error("initialization failed", error));
});

chrome.runtime.onStartup.addListener(() => {
  initialize().catch((error) => log.error("startup failed", error));
});

initialize().catch((error) => log.error("worker initialization failed", error));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type || message.target === "offscreen") return false;

  let task;
  switch (message.type) {
    case "active_meeting_get":
      task = getActiveMeeting(message.meetingId).then((record) => ({ ok: true, record }));
      break;
    case "active_meeting_put":
      task = putActiveMeeting(message.record).then(() => ({ ok: true }));
      break;
    case "active_meeting_remove":
      task = removeActiveMeeting(message.meetingId).then(() => ({ ok: true }));
      break;
    case "call_ended":
      task = finalizeMeeting(message.meetingId, "final");
      break;
    case "capture_cancelled":
      task = cancelMeeting(message.meetingId).then(() => ({ ok: true }));
      break;
    case "prepare_ai_capture":
      task = prepareAiCapture(sender).then(() => ({ ok: true }));
      break;
    case "ai_capture_started":
      task = markAiCapture(message.meetingId, true).then(() => ({ ok: true }));
      break;
    case "retry_queue_item":
      task = retryQueueItem(message.id, true);
      break;
    case "discard_queue_item":
      task = discardQueueItem(message.id).then(() => ({ ok: true }));
      break;
    case "test_connection":
      task = handleTestConnection();
      break;
    case "get_popup_state":
      task = getPopupState();
      break;
    default:
      return false;
  }

  task
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  const task = alarm.name.startsWith("retry:")
    ? retryQueueItem(alarm.name.slice("retry:".length), false)
    : alarm.name === RECOVERY_ALARM
    ? recoverStaleMeetings()
    : alarm.name === OFFSCREEN_CLEANUP_ALARM
    ? closeOffscreenIfIdle()
    : null;
  task?.catch((error) => log.error("alarm failed", alarm.name, error));
});

async function initialize() {
  chrome.alarms.create(RECOVERY_ALARM, { periodInMinutes: 1 });
  const queue = await storage.getQueue();
  for (const item of queue) {
    if (item.state !== "queued") continue;
    const delayMs = Math.max(0, Date.parse(item.nextAttemptAt) - Date.now());
    chrome.alarms.create(retryAlarmName(item.id), {
      delayInMinutes: Math.max(0.5, delayMs / 60_000),
    });
  }
}

async function migrateLegacyStorage() {
  const legacy = await chrome.storage.local.get([
    "storageSchemaVersion",
    "config",
    "meetings",
    "queue",
  ]);
  if ((legacy.storageSchemaVersion || 0) >= 2) return;

  // v0.1 stored credentials and transcript bodies as plaintext. They cannot
  // be carried into the SipPulse-only security model.
  await chrome.storage.local.remove(["config", "meetings"]);
  if (legacy.queue?.some((item) => item.vcon || item.url)) {
    await chrome.storage.local.set({ queue: [] });
  }
  await chrome.storage.local.set({ storageSchemaVersion: 2 });
}

async function readMap(key) {
  const result = await chrome.storage.local.get(key);
  return result[key] || {};
}

async function writeMap(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

async function putActiveMeeting(record) {
  if (!record?.meetingId || !record?.uuid) throw new Error("Invalid meeting record");
  await putSecureRecord(`active:${record.meetingId}`, record);
  const index = await readMap(ACTIVE_INDEX_KEY);
  index[record.meetingId] = {
    uuid: record.uuid,
    updatedAt: new Date().toISOString(),
  };
  await writeMap(ACTIVE_INDEX_KEY, index);
  await storage.setDeliveryStatus({
    state: "capturing",
    source: (await isAiCaptureActive(record.meetingId))
      ? "sippulse_ai"
      : "google_captions",
  });
}

async function getActiveMeeting(meetingId) {
  if (!meetingId) return null;
  return getSecureRecord(`active:${meetingId}`);
}

async function removeActiveMeeting(meetingId) {
  if (!meetingId) return;
  await removeSecureRecord(`active:${meetingId}`);
  const index = await readMap(ACTIVE_INDEX_KEY);
  delete index[meetingId];
  await writeMap(ACTIVE_INDEX_KEY, index);
}

function finalizeMeeting(meetingId, deliveryKind) {
  if (finalizationTasks.has(meetingId)) return finalizationTasks.get(meetingId);
  const task = handleCallEnded(meetingId, deliveryKind).finally(() => {
    finalizationTasks.delete(meetingId);
  });
  finalizationTasks.set(meetingId, task);
  return task;
}

async function handleCallEnded(meetingId, deliveryKind) {
  if (!meetingId) return { ok: false, error: "Missing meeting id" };
  const record = await getActiveMeeting(meetingId);
  if (!record) return { ok: false, error: "Meeting record not found" };
  const config = await storage.getConfig();
  if (!config.captureEnabled) {
    await cancelMeeting(meetingId);
    return { ok: false, error: "Capture was disabled by SipPulse" };
  }

  const aiActive = await isAiCaptureActive(meetingId);
  const profile = await getProfileUser();
  if (!isSipPulseEmail(profile?.email)) {
    await storage.setDeliveryStatus({
      state: "needs_attention",
      error: "Sign in to Chrome with a @sippulse.com account",
    });
    return { ok: false, error: "SipPulse collaborator email unavailable" };
  }
  const fallback = assembleVcon(
    record,
    deliveryKind,
    aiActive ? "google_captions_fallback" : "google_captions",
    profile
  );

  if (aiActive) {
    let upload;
    if (!config.configured) {
      await chrome.runtime
        .sendMessage({
          target: "offscreen",
          type: "ai_capture_cancel",
          meetingId,
        })
        .catch(() => {});
      upload = { ok: false, error: config.error };
    } else {
      try {
        upload = await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "ai_capture_stop",
          meetingId,
          endpointUrl: config.endpointUrl,
          bearerToken: config.bearerToken,
          vcon: fallback,
          deliveryKind,
        });
      } catch (error) {
        upload = { ok: false, error: error.message || String(error) };
      }
    }
    await markAiCapture(meetingId, false);
    await closeOffscreenIfIdle();
    if (upload?.ok) {
      await removeQueuedForMeeting(fallback.uuid);
      await removeActiveMeeting(meetingId);
      await storage.setDeliveryStatus({
        state: "processing",
        source: "sippulse_ai",
        requestId: upload.requestId || null,
        lastSuccessAt: new Date().toISOString(),
      });
      return upload;
    }
    log.warn("SipPulse AI upload failed; sending Google captions", upload?.error);
  }

  if (!record.utterances?.length) {
    await removeActiveMeeting(meetingId);
    await storage.setDeliveryStatus({
      state: "needs_attention",
      error: "No audio or Google captions were captured",
    });
    return { ok: false, error: "No transcript captured" };
  }

  const result = await deliverVcon(fallback, deliveryKind);
  await removeActiveMeeting(meetingId);
  return result;
}

function assembleVcon(record, deliveryKind, transcriptionSource, profile) {
  return vcon.assemble(record, {
    capturedBy: `SipPulse Meet Capture/${VERSION}`,
    deliveryKind,
    transcriptionSource,
    capturedByUser: profile,
  });
}

async function deliverRecord(record, deliveryKind, source) {
  const profile = await getProfileUser();
  if (!isSipPulseEmail(profile?.email)) {
    const error = "Sign in to Chrome with a @sippulse.com account";
    await storage.setDeliveryStatus({ state: "needs_attention", error });
    return { ok: false, error };
  }
  return deliverVcon(
    assembleVcon(record, deliveryKind, source, profile),
    deliveryKind
  );
}

async function deliverVcon(vconDocument, deliveryKind) {
  const config = await storage.getConfig();
  const result = await postVcon(
    vconDocument,
    config.endpointUrl,
    config.bearerToken,
    deliveryKind
  );
  if (result.ok) {
    await removeQueuedForMeeting(vconDocument.uuid);
    await storage.setDeliveryStatus({
      state: "delivered",
      source: vconDocument.attachments?.[0]?.body?.transcription_source,
      lastSuccessAt: new Date().toISOString(),
      error: "",
    });
    return result;
  }

  await enqueue(vconDocument, config.endpointUrl, deliveryKind, result.error);
  return { ok: false, queued: true, error: result.error };
}

async function postVcon(document, endpointUrl, bearerToken, deliveryKind) {
  const config = self.MeetVcon.config.normalize({
    EndpointUrl: endpointUrl,
    BearerToken: bearerToken,
  });
  if (!config.configured) return { ok: false, error: config.error };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const headers = {
    "Content-Type": "application/vcon+json",
    "X-SipPulse-Delivery": deliveryKind,
    "X-SipPulse-Transcription-Source":
      document.attachments?.[0]?.body?.transcription_source || "google_captions",
  };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;

  try {
    const response = await fetch(endpointUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(document),
      signal: controller.signal,
    });
    if (response.ok) return { ok: true, status: response.status };
    return { ok: false, error: `HTTP ${response.status}`, status: response.status };
  } catch (error) {
    return {
      ok: false,
      error: error.name === "AbortError" ? "Request timed out" : error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function enqueue(document, endpointUrl, deliveryKind, error) {
  const queue = await storage.getQueue();
  const obsolete = queue.filter((item) => item.uuid === document.uuid);
  for (const item of obsolete) {
    await removeSecureRecord(`queue:${item.id}`);
    await chrome.alarms.clear(retryAlarmName(item.id));
  }
  queue.splice(
    0,
    queue.length,
    ...queue.filter((item) => !obsolete.some((old) => old.id === item.id))
  );

  const id = vcon.uuidv4();
  await putSecureRecord(`queue:${id}`, { document, endpointUrl });
  const item = {
    id,
    uuid: document.uuid,
    deliveryKind,
    attempts: 0,
    state: "queued",
    nextAttemptAt: new Date(
      Date.now() + retryPolicy.DELAYS_MINUTES[0] * 60_000
    ).toISOString(),
    lastError: error,
  };
  queue.push(item);
  await storage.setQueue(queue);
  chrome.alarms.create(retryAlarmName(id), {
    delayInMinutes: retryPolicy.DELAYS_MINUTES[0],
  });
  await storage.setDeliveryStatus({ state: "queued", error });
}

async function retryQueueItem(id, manual) {
  const queue = await storage.getQueue();
  const item = queue.find((candidate) => candidate.id === id);
  if (!item) return { ok: false, error: "Queue item not found" };
  const payload = await getSecureRecord(`queue:${id}`);
  if (!payload) return { ok: false, error: "Encrypted payload not found" };

  const config = await storage.getConfig();
  const result = await postVcon(
    payload.document,
    payload.endpointUrl,
    config.bearerToken,
    item.deliveryKind
  );
  if (result.ok) {
    await removeSecureRecord(`queue:${id}`);
    await storage.setQueue(queue.filter((candidate) => candidate.id !== id));
    await storage.setDeliveryStatus({
      state: "delivered",
      lastSuccessAt: new Date().toISOString(),
      error: "",
    });
    return result;
  }

  item.lastError = result.error;
  if (manual) {
    item.state = "needs_attention";
    item.nextAttemptAt = null;
    await storage.setQueue(queue);
    await storage.setDeliveryStatus({
      state: "needs_attention",
      error: result.error,
    });
    return { ok: false, error: result.error };
  }

  const next = retryPolicy.afterFailure(item.attempts);
  Object.assign(item, next);
  if (item.state === "needs_attention") {
    await storage.setDeliveryStatus({ state: "needs_attention", error: result.error });
  } else {
    const delayMs = Math.max(0, Date.parse(item.nextAttemptAt) - Date.now());
    chrome.alarms.create(retryAlarmName(id), {
      delayInMinutes: Math.max(0.5, delayMs / 60_000),
    });
  }
  await storage.setQueue(queue);
  return { ok: false, error: result.error };
}

async function discardQueueItem(id) {
  const queue = await storage.getQueue();
  await storage.setQueue(queue.filter((item) => item.id !== id));
  await removeSecureRecord(`queue:${id}`);
  await chrome.alarms.clear(retryAlarmName(id));
}

async function removeQueuedForMeeting(uuid) {
  const queue = await storage.getQueue();
  const obsolete = queue.filter((item) => item.uuid === uuid);
  for (const item of obsolete) {
    await removeSecureRecord(`queue:${item.id}`);
    await chrome.alarms.clear(retryAlarmName(item.id));
  }
  if (obsolete.length) {
    await storage.setQueue(
      queue.filter((item) => !obsolete.some((old) => old.id === item.id))
    );
  }
}

async function recoverStaleMeetings() {
  const index = await readMap(ACTIVE_INDEX_KEY);
  for (const [meetingId, metadata] of Object.entries(index)) {
    if (Date.now() - Date.parse(metadata.updatedAt) < STALE_MEETING_MS) continue;
    const record = await getActiveMeeting(meetingId);
    const aiActive = await isAiCaptureActive(meetingId);
    if (record && (record.utterances?.length || aiActive)) {
      const result = await finalizeMeeting(meetingId, "recovered");
      if (!result.ok && !result.queued) continue;
    } else if (aiActive) {
      await chrome.runtime
        .sendMessage({
          target: "offscreen",
          type: "ai_capture_cancel",
          meetingId,
        })
        .catch(() => {});
    }
    await markAiCapture(meetingId, false);
    await removeActiveMeeting(meetingId);
  }
}

async function cancelMeeting(meetingId) {
  if (await isAiCaptureActive(meetingId)) {
    await chrome.runtime
      .sendMessage({
        target: "offscreen",
        type: "ai_capture_cancel",
        meetingId,
      })
      .catch(() => {});
  }
  await markAiCapture(meetingId, false);
  await closeOffscreenIfIdle();
  await removeActiveMeeting(meetingId);
  await storage.setDeliveryStatus({ state: "disabled_for_call", error: "" });
}

async function prepareAiCapture() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA"],
    justification: "Record a user-approved Meet call for SipPulse AI transcription",
  });
  chrome.alarms.create(OFFSCREEN_CLEANUP_ALARM, { delayInMinutes: 1 });
}

async function markAiCapture(meetingId, active) {
  const sessions = await readMap(AI_SESSIONS_KEY);
  if (active) sessions[meetingId] = { startedAt: new Date().toISOString() };
  else delete sessions[meetingId];
  await writeMap(AI_SESSIONS_KEY, sessions);
  if (active) {
    await chrome.alarms.clear(OFFSCREEN_CLEANUP_ALARM);
    await storage.setDeliveryStatus({ state: "capturing", source: "sippulse_ai" });
  }
}

async function closeOffscreenIfIdle() {
  const sessions = await readMap(AI_SESSIONS_KEY);
  if (Object.keys(sessions).length) return;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  if (contexts.length) await chrome.offscreen.closeDocument();
}

async function isAiCaptureActive(meetingId) {
  const sessions = await readMap(AI_SESSIONS_KEY);
  return !!sessions[meetingId];
}

async function getPopupState() {
  const [consent, config, status, queue, activeMeetings, aiSessions, profile] =
    await Promise.all([
      storage.getConsent(),
      storage.getConfig(),
      storage.getDeliveryStatus(),
      storage.getQueue(),
      readMap(ACTIVE_INDEX_KEY),
      readMap(AI_SESSIONS_KEY),
      getProfileUser(),
    ]);
  return {
    ok: true,
    consented: !!consent?.accepted,
    config: {
      configured: config.configured,
      captureEnabled: config.captureEnabled,
      preferredTranscription: config.preferredTranscription,
      error: config.error,
    },
    status,
    queue,
    activeMeetingIds: Object.keys(activeMeetings),
    aiMeetingIds: Object.keys(aiSessions),
    collaboratorEmail: profile?.email || "",
  };
}

async function handleTestConnection() {
  const profile = await getProfileUser();
  if (!isSipPulseEmail(profile?.email)) {
    return { ok: false, error: "Sign in to Chrome with a @sippulse.com account" };
  }
  const now = new Date().toISOString();
  const document = assembleVcon(
    {
      uuid: vcon.uuidv4(),
      meetingId: "connection-test",
      meetingUrl: "https://meet.google.com/connection-test",
      subject: "SipPulse connection test",
      startedAt: now,
      captionsEnabled: true,
      utterances: [
        { speaker: "SipPulse", text: "Connection test", start: now, duration: 1 },
      ],
    },
    "test",
    "synthetic",
    profile
  );
  const config = await storage.getConfig();
  return postVcon(document, config.endpointUrl, config.bearerToken, "test");
}

let profileCache;
async function getProfileUser() {
  if (profileCache !== undefined) return profileCache;
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
    profileCache = info?.email ? { email: info.email, id: info.id || null } : null;
  } catch (error) {
    log.warn("profile lookup failed", error);
    profileCache = null;
  }
  return profileCache;
}

const retryAlarmName = (id) => `retry:${id}`;
const isSipPulseEmail = (email) =>
  typeof email === "string" && email.toLowerCase().endsWith("@sippulse.com");
