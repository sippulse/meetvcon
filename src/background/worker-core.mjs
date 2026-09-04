// Service-worker orchestration with injected Chrome, crypto, and network
// dependencies so the delivery state machine can be exercised by Node tests
// (tests/worker-core.test.js) without a browser.

export const STALE_MEETING_MS = 10 * 60_000;
export const UPLOAD_GRACE_MS = 15 * 60_000;
export const DISCARD_TTL_MS = 4 * 60 * 60_000;
export const FETCH_TIMEOUT_MS = 30_000;
export const OFFSCREEN_PATH = "src/offscreen/offscreen.html";
export const RECOVERY_ALARM = "recovery-scan";
export const OFFSCREEN_CLEANUP_ALARM = "offscreen-cleanup";
export const LAST_TRANSCRIPT_ID = "last-transcript";

const ACTIVE_INDEX_KEY = "activeMeetingIndex";
const AI_SESSIONS_KEY = "aiSessions";
const DISCARDED_KEY = "discardedMeetings";
const LAST_TRANSCRIPT_META_KEY = "lastTranscript";

export const MESSAGE_TYPES = new Set([
  "active_meeting_get",
  "active_meeting_put",
  "active_meeting_remove",
  "meeting_discarded_get",
  "call_ended",
  "call_left",
  "capture_cancelled",
  "start_ai_capture",
  "ai_upload_result",
  "retry_queue_item",
  "discard_queue_item",
  "get_queue_item_document",
  "get_last_transcript",
  "test_connection",
  "get_popup_state",
]);

const retryAlarmName = (id) => `retry:${id}`;

export function createWorkerCore({
  chrome,
  secureStore,
  lib,
  fetch,
  now = () => Date.now(),
  version = "0.0.0",
}) {
  const { log, storage, vcon, retryPolicy, config: configLib } = lib;
  const local = chrome.storage.local;
  const sessionArea = chrome.storage.session || chrome.storage.local;
  const finalizationTasks = new Map();
  let profileCache;

  const iso = (ms = now()) => new Date(ms).toISOString();
  const IDENTITY_ERROR = "Sign in to Chrome with your company account";

  async function isAuthorizedEmail(email) {
    return configLib.isAllowedEmail(email, await storage.getConfig());
  }

  async function readMap(area, key) {
    const result = await area.get(key);
    return result[key] || {};
  }

  async function writeMap(area, key, value) {
    await area.set({ [key]: value });
  }

  // ---- active meeting records (encrypted) --------------------------------

  async function putActiveMeeting(record) {
    if (!record?.meetingId || !record?.uuid) throw new Error("Invalid meeting record");
    if (await isDiscarded(record.meetingId)) {
      throw new Error("This call was discarded; capture will not resume");
    }
    await secureStore.put(`active:${record.meetingId}`, record);
    const index = await readMap(local, ACTIVE_INDEX_KEY);
    index[record.meetingId] = { uuid: record.uuid, updatedAt: iso() };
    await writeMap(local, ACTIVE_INDEX_KEY, index);
    const session = await getAiSession(record.meetingId);
    await storage.setDeliveryStatus({
      state: "capturing",
      source: session ? "sippulse_ai" : "google_captions",
      error: "",
    });
  }

  async function getActiveMeeting(meetingId) {
    if (!meetingId) return null;
    return secureStore.get(`active:${meetingId}`);
  }

  async function removeActiveMeeting(meetingId) {
    if (!meetingId) return;
    await secureStore.remove(`active:${meetingId}`);
    const index = await readMap(local, ACTIVE_INDEX_KEY);
    delete index[meetingId];
    await writeMap(local, ACTIVE_INDEX_KEY, index);
  }

  // ---- per-call discard markers (session storage, expire) ----------------

  async function pruneDiscarded() {
    const markers = await readMap(sessionArea, DISCARDED_KEY);
    let changed = false;
    for (const [meetingId, at] of Object.entries(markers)) {
      if (now() - Date.parse(at) > DISCARD_TTL_MS) {
        delete markers[meetingId];
        changed = true;
      }
    }
    if (changed) await writeMap(sessionArea, DISCARDED_KEY, markers);
    return markers;
  }

  async function isDiscarded(meetingId) {
    if (!meetingId) return false;
    const markers = await pruneDiscarded();
    return !!markers[meetingId];
  }

  async function markDiscarded(meetingId) {
    const markers = await pruneDiscarded();
    markers[meetingId] = iso();
    await writeMap(sessionArea, DISCARDED_KEY, markers);
  }

  async function clearDiscarded(meetingId) {
    if (!meetingId) return;
    const markers = await readMap(sessionArea, DISCARDED_KEY);
    if (!(meetingId in markers)) return;
    delete markers[meetingId];
    await writeMap(sessionArea, DISCARDED_KEY, markers);
  }

  // ---- SipPulse AI sessions ----------------------------------------------

  async function getAiSession(meetingId) {
    const sessions = await readMap(local, AI_SESSIONS_KEY);
    return sessions[meetingId] || null;
  }

  async function setAiSession(meetingId, session) {
    const sessions = await readMap(local, AI_SESSIONS_KEY);
    sessions[meetingId] = session;
    await writeMap(local, AI_SESSIONS_KEY, sessions);
  }

  async function clearAiSession(meetingId, session) {
    const sessions = await readMap(local, AI_SESSIONS_KEY);
    delete sessions[meetingId];
    await writeMap(local, AI_SESSIONS_KEY, sessions);
    if (session?.tabId) await notifyTab(session.tabId, meetingId, false);
    await closeOffscreenIfIdle();
  }

  async function notifyTab(tabId, meetingId, active) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "ai_capture_state", meetingId, active });
    } catch {
      // The Meet tab may already be closed.
    }
  }

  async function ensureOffscreenDocument() {
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
  }

  async function closeOffscreenIfIdle() {
    const sessions = await readMap(local, AI_SESSIONS_KEY);
    if (Object.keys(sessions).length) return;
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
    });
    if (contexts.length) await chrome.offscreen.closeDocument();
  }

  async function offscreenRequest(message) {
    try {
      return await chrome.runtime.sendMessage({ target: "offscreen", ...message });
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  }

  // The stream ID must be obtained here, not in the popup: Chrome binds IDs
  // to the requesting renderer unless they come from the service worker.
  async function startAiCapture(meetingId, tabId) {
    if (!meetingId || !tabId) return { ok: false, error: "Missing meeting or tab" };
    if (await isDiscarded(meetingId)) return { ok: false, error: "This call was discarded" };
    const record = await getActiveMeeting(meetingId);
    if (!record) return { ok: false, error: "Capture has not started in this meeting yet" };
    if (await getAiSession(meetingId)) return { ok: true, alreadyActive: true };
    const config = await storage.getConfig();
    if (!config.configured || !config.captureEnabled) {
      return { ok: false, error: config.error || "Capture is disabled by SipPulse" };
    }
    const profile = await getProfileUser();
    if (!(await isAuthorizedEmail(profile?.email))) {
      return { ok: false, error: IDENTITY_ERROR };
    }

    let streamId;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (error) {
      return { ok: false, error: `Tab audio unavailable: ${error.message || error}` };
    }
    await ensureOffscreenDocument();
    const result = await offscreenRequest({ type: "ai_capture_start", streamId, meetingId });
    if (!result?.ok) {
      await closeOffscreenIfIdle();
      return {
        ok: false,
        error: result?.error || "Audio capture failed",
        code: result?.code || null,
      };
    }
    await setAiSession(meetingId, { state: "recording", startedAt: iso(), tabId });
    await chrome.alarms.clear(OFFSCREEN_CLEANUP_ALARM);
    await storage.setDeliveryStatus({ state: "capturing", source: "sippulse_ai", error: "" });
    await notifyTab(tabId, meetingId, true);
    return { ok: true };
  }

  async function cancelAiCapture(meetingId, session) {
    await offscreenRequest({ type: "ai_capture_cancel", meetingId });
    await clearAiSession(meetingId, session);
  }

  // ---- finalization ------------------------------------------------------

  function finalizeMeeting(meetingId, deliveryKind) {
    if (finalizationTasks.has(meetingId)) return finalizationTasks.get(meetingId);
    const task = handleCallEnded(meetingId, deliveryKind).finally(() => {
      finalizationTasks.delete(meetingId);
    });
    finalizationTasks.set(meetingId, task);
    return task;
  }

  async function requireProfile() {
    const profile = await getProfileUser();
    if (await isAuthorizedEmail(profile?.email)) return profile;
    await storage.setDeliveryStatus({ state: "needs_attention", error: IDENTITY_ERROR });
    return null;
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
    const session = await getAiSession(meetingId);
    if (session?.state === "uploading") {
      return { ok: true, pending: true, source: "sippulse_ai" };
    }
    const profile = await requireProfile();
    if (!profile) return { ok: false, error: "Collaborator email unavailable" };

    const fallback = assembleVcon(
      record,
      deliveryKind,
      session ? "google_captions_fallback" : "google_captions",
      profile
    );
    if (record.utterances?.length) await saveLastTranscript(fallback, record, !!session);

    if (session) {
      if (!config.configured) {
        await cancelAiCapture(meetingId, session);
      } else {
        const response = await offscreenRequest({
          type: "ai_capture_stop",
          meetingId,
          endpointUrl: config.endpointUrl,
          bearerToken: config.bearerToken,
          vcon: fallback,
          deliveryKind,
        });
        if (response?.ok) {
          await setAiSession(meetingId, {
            ...session,
            state: "uploading",
            deliveryKind,
            uploadStartedAt: iso(),
          });
          await storage.setDeliveryStatus({ state: "uploading", source: "sippulse_ai", error: "" });
          return { ok: true, pending: true, source: "sippulse_ai" };
        }
        log.warn("SipPulse AI recorder unavailable; sending Google captions", response?.error);
        await clearAiSession(meetingId, session);
      }
    }
    return deliverCaptions(record, fallback, meetingId, deliveryKind);
  }

  async function deliverCaptions(record, fallback, meetingId, deliveryKind) {
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

  // Reported by the offscreen document when its upload finishes, so the
  // service worker never has to stay alive across a multi-minute upload.
  async function completeAiUpload(meetingId, result) {
    const session = await getAiSession(meetingId);
    if (!session) {
      log.warn("upload result for unknown SipPulse AI session", meetingId);
      return { ok: false, error: "No matching SipPulse AI session" };
    }
    const deliveryKind = session.deliveryKind || "final";
    await clearAiSession(meetingId, session);
    const record = await getActiveMeeting(meetingId);
    if (result?.ok) {
      await removeQueuedForMeeting(record?.uuid || result.uuid);
      await removeActiveMeeting(meetingId);
      await storage.setDeliveryStatus({
        state: "processing",
        source: "sippulse_ai",
        requestId: result.requestId || null,
        lastSuccessAt: iso(),
        error: "",
      });
      return { ok: true };
    }
    log.warn("SipPulse AI upload failed; sending Google captions", result?.error);
    if (!record) return { ok: false, error: "Meeting record not found" };
    const profile = await requireProfile();
    if (!profile) return { ok: false, error: "Collaborator email unavailable" };
    const fallback = assembleVcon(record, deliveryKind, "google_captions_fallback", profile);
    return deliverCaptions(record, fallback, meetingId, deliveryKind);
  }

  async function cancelMeeting(meetingId) {
    if (!meetingId) return;
    await markDiscarded(meetingId);
    const session = await getAiSession(meetingId);
    if (session) await cancelAiCapture(meetingId, session);
    await removeActiveMeeting(meetingId);
    await storage.setDeliveryStatus({ state: "disabled_for_call", error: "" });
  }

  function assembleVcon(record, deliveryKind, transcriptionSource, profile) {
    return vcon.assemble(record, {
      capturedBy: `SipPulse Meet Capture/${version}`,
      deliveryKind,
      transcriptionSource,
      capturedByUser: profile,
    });
  }

  // ---- local escape hatch: last captured transcript ----------------------

  async function saveLastTranscript(document, record, audioAlsoRecorded) {
    await secureStore.put(LAST_TRANSCRIPT_ID, { document, savedAt: iso() });
    await local.set({
      [LAST_TRANSCRIPT_META_KEY]: {
        uuid: document.uuid,
        subject: record.subject || record.meetingId || "",
        savedAt: iso(),
        utteranceCount: record.utterances?.length || 0,
        captionsOnly: true,
        audioAlsoRecorded: !!audioAlsoRecorded,
      },
    });
  }

  async function getLastTranscript() {
    const stored = await secureStore.get(LAST_TRANSCRIPT_ID);
    return { ok: true, document: stored?.document || null, savedAt: stored?.savedAt || null };
  }

  async function getQueueItemDocument(id) {
    const payload = await secureStore.get(`queue:${id}`);
    if (!payload) return { ok: false, error: "Encrypted payload not found" };
    return { ok: true, document: payload.document };
  }

  // ---- delivery and retry queue -----------------------------------------

  async function deliverVcon(vconDocument, deliveryKind) {
    const config = await storage.getConfig();
    const result = await postVcon(vconDocument, config.endpointUrl, config.bearerToken, deliveryKind);
    if (result.ok) {
      await removeQueuedForMeeting(vconDocument.uuid);
      await storage.setDeliveryStatus({
        state: "delivered",
        source: vconDocument.attachments?.[0]?.body?.transcription_source,
        lastSuccessAt: iso(),
        error: "",
      });
      return result;
    }
    await enqueue(vconDocument, config.endpointUrl, deliveryKind, result.error);
    return { ok: false, queued: true, error: result.error };
  }

  async function postVcon(document, endpointUrl, bearerToken, deliveryKind) {
    const config = configLib.normalize({ EndpointUrl: endpointUrl, BearerToken: bearerToken });
    if (!config.configured) return { ok: false, error: config.error };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const headers = {
      "Content-Type": "application/vcon+json",
      "X-SipPulse-Delivery": deliveryKind,
      "X-SipPulse-Transcription-Source":
        document.attachments?.[0]?.body?.transcription_source || "google_captions",
      Authorization: `Bearer ${bearerToken}`,
    };
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
    await removeQueuedForMeeting(document.uuid);
    const queue = await storage.getQueue();
    const id = vcon.uuidv4();
    await secureStore.put(`queue:${id}`, { document, endpointUrl });
    queue.push({
      id,
      uuid: document.uuid,
      subject: document.subject || "",
      deliveryKind,
      attempts: 0,
      state: "queued",
      nextAttemptAt: iso(now() + retryPolicy.DELAYS_MINUTES[0] * 60_000),
      lastError: error,
    });
    await storage.setQueue(queue);
    chrome.alarms.create(retryAlarmName(id), { delayInMinutes: retryPolicy.DELAYS_MINUTES[0] });
    await storage.setDeliveryStatus({ state: "queued", error });
  }

  async function retryQueueItem(id, manual) {
    const queue = await storage.getQueue();
    const item = queue.find((candidate) => candidate.id === id);
    if (!item) return { ok: false, error: "Queue item not found" };
    const payload = await secureStore.get(`queue:${id}`);
    if (!payload) {
      await storage.setQueue(queue.filter((candidate) => candidate.id !== id));
      await refreshQueueStatus();
      return { ok: false, error: "Encrypted payload not found" };
    }

    const config = await storage.getConfig();
    const result = await postVcon(payload.document, payload.endpointUrl, config.bearerToken, item.deliveryKind);
    if (result.ok) {
      await secureStore.remove(`queue:${id}`);
      await chrome.alarms.clear(retryAlarmName(id));
      await storage.setQueue(queue.filter((candidate) => candidate.id !== id));
      await refreshQueueStatus({ lastSuccessAt: iso() });
      return result;
    }

    item.lastError = result.error;
    if (manual) {
      item.state = "needs_attention";
      item.nextAttemptAt = null;
      await chrome.alarms.clear(retryAlarmName(id));
    } else {
      Object.assign(item, retryPolicy.afterFailure(item.attempts, now()));
      if (item.state === "queued") {
        const delayMs = Math.max(0, Date.parse(item.nextAttemptAt) - now());
        chrome.alarms.create(retryAlarmName(id), {
          delayInMinutes: Math.max(0.5, delayMs / 60_000),
        });
      }
    }
    await storage.setQueue(queue);
    await refreshQueueStatus();
    return { ok: false, error: result.error };
  }

  async function discardQueueItem(id) {
    const queue = await storage.getQueue();
    await storage.setQueue(queue.filter((item) => item.id !== id));
    await secureStore.remove(`queue:${id}`);
    await chrome.alarms.clear(retryAlarmName(id));
    await refreshQueueStatus();
  }

  async function removeQueuedForMeeting(uuid) {
    if (!uuid) return;
    const queue = await storage.getQueue();
    const obsolete = queue.filter((item) => item.uuid === uuid);
    if (!obsolete.length) return;
    for (const item of obsolete) {
      await secureStore.remove(`queue:${item.id}`);
      await chrome.alarms.clear(retryAlarmName(item.id));
    }
    await storage.setQueue(queue.filter((item) => item.uuid !== uuid));
  }

  // Derive the global status from what is actually left in the outbox so the
  // popup never claims "needs attention" with nothing to act on.
  async function refreshQueueStatus(patch = {}) {
    const queue = await storage.getQueue();
    const stuck = queue.find((item) => item.state === "needs_attention");
    const pending = queue.find((item) => item.state === "queued");
    if (stuck) {
      await storage.setDeliveryStatus({ ...patch, state: "needs_attention", error: stuck.lastError || "" });
    } else if (pending) {
      await storage.setDeliveryStatus({ ...patch, state: "queued", error: pending.lastError || "" });
    } else {
      await storage.setDeliveryStatus({
        ...patch,
        state: patch.lastSuccessAt ? "delivered" : "idle",
        error: "",
      });
    }
  }

  // ---- recovery ----------------------------------------------------------

  async function recoverStaleMeetings() {
    await pruneDiscarded();
    const index = await readMap(local, ACTIVE_INDEX_KEY);
    for (const [meetingId, metadata] of Object.entries(index)) {
      const session = await getAiSession(meetingId);
      if (session?.state === "uploading") {
        if (now() - Date.parse(session.uploadStartedAt) < UPLOAD_GRACE_MS) continue;
        log.warn("SipPulse AI upload never reported back; using Google captions", meetingId);
        await completeAiUpload(meetingId, { ok: false, error: "Audio upload did not complete" });
        continue;
      }
      if (now() - Date.parse(metadata.updatedAt) < STALE_MEETING_MS) continue;
      const record = await getActiveMeeting(meetingId);
      if (record && (record.utterances?.length || session)) {
        const result = await finalizeMeeting(meetingId, "recovered");
        if (result.pending) continue;
        if (!result.ok && !result.queued) continue;
      } else if (session) {
        await cancelAiCapture(meetingId, session);
      }
      await removeActiveMeeting(meetingId);
    }
  }

  // ---- popup / options ---------------------------------------------------

  async function getPopupState() {
    const [consent, config, status, queue, activeMeetings, aiSessions, discarded, lastMeta, profile] =
      await Promise.all([
        storage.getConsent(),
        storage.getConfig(),
        storage.getDeliveryStatus(),
        storage.getQueue(),
        readMap(local, ACTIVE_INDEX_KEY),
        readMap(local, AI_SESSIONS_KEY),
        pruneDiscarded(),
        local.get(LAST_TRANSCRIPT_META_KEY),
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
      aiMeetingIds: Object.keys(aiSessions).filter((id) => aiSessions[id].state === "recording"),
      discardedMeetingIds: Object.keys(discarded),
      lastTranscript: lastMeta[LAST_TRANSCRIPT_META_KEY] || null,
      collaboratorEmail: profile?.email || "",
      collaboratorAuthorized: configLib.isAllowedEmail(profile?.email, config),
    };
  }

  async function handleTestConnection() {
    const profile = await getProfileUser();
    if (!(await isAuthorizedEmail(profile?.email))) {
      return { ok: false, error: IDENTITY_ERROR };
    }
    const at = iso();
    const document = assembleVcon(
      {
        uuid: vcon.uuidv4(),
        meetingId: "connection-test",
        meetingUrl: "https://meet.google.com/connection-test",
        subject: "SipPulse connection test",
        startedAt: at,
        captionsEnabled: true,
        utterances: [{ speaker: "SipPulse", text: "Connection test", start: at, duration: 1 }],
      },
      "test",
      "google_captions",
      profile
    );
    const config = await storage.getConfig();
    return postVcon(document, config.endpointUrl, config.bearerToken, "test");
  }

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

  // ---- lifecycle ---------------------------------------------------------

  async function initialize() {
    chrome.alarms.create(RECOVERY_ALARM, { periodInMinutes: 1 });
    await pruneDiscarded();
    const queue = await storage.getQueue();
    for (const item of queue) {
      if (item.state !== "queued") continue;
      const delayMs = Math.max(0, Date.parse(item.nextAttemptAt) - now());
      chrome.alarms.create(retryAlarmName(item.id), {
        delayInMinutes: Math.max(0.5, delayMs / 60_000),
      });
    }
  }

  async function migrateLegacyStorage() {
    const legacy = await local.get(["storageSchemaVersion", "config", "meetings", "queue"]);
    if ((legacy.storageSchemaVersion || 0) >= 2) return;
    // v0.1 stored credentials and transcript bodies as plaintext. They cannot
    // be carried into the SipPulse-only security model.
    await local.remove(["config", "meetings"]);
    if (legacy.queue?.some((item) => item.vcon || item.url)) {
      await local.set({ queue: [] });
    }
    await local.set({ storageSchemaVersion: 2 });
  }

  function handleAlarm(alarm) {
    if (alarm.name.startsWith("retry:")) {
      return retryQueueItem(alarm.name.slice("retry:".length), false);
    }
    if (alarm.name === RECOVERY_ALARM) return recoverStaleMeetings();
    if (alarm.name === OFFSCREEN_CLEANUP_ALARM) return closeOffscreenIfIdle();
    return null;
  }

  async function handleMessage(message) {
    switch (message?.type) {
      case "active_meeting_get":
        return { ok: true, record: await getActiveMeeting(message.meetingId) };
      case "active_meeting_put":
        await putActiveMeeting(message.record);
        return { ok: true };
      case "active_meeting_remove":
        await removeActiveMeeting(message.meetingId);
        return { ok: true };
      case "meeting_discarded_get":
        return { ok: true, discarded: await isDiscarded(message.meetingId) };
      case "call_ended":
        return finalizeMeeting(message.meetingId, "final");
      case "call_left":
        await clearDiscarded(message.meetingId);
        return { ok: true };
      case "capture_cancelled":
        await cancelMeeting(message.meetingId);
        return { ok: true };
      case "start_ai_capture":
        return startAiCapture(message.meetingId, message.tabId);
      case "ai_upload_result":
        return completeAiUpload(message.meetingId, message.result);
      case "retry_queue_item":
        return retryQueueItem(message.id, true);
      case "discard_queue_item":
        await discardQueueItem(message.id);
        return { ok: true };
      case "get_queue_item_document":
        return getQueueItemDocument(message.id);
      case "get_last_transcript":
        return getLastTranscript();
      case "test_connection":
        return handleTestConnection();
      case "get_popup_state":
        return getPopupState();
      default:
        return { ok: false, error: `Unknown message ${message?.type}` };
    }
  }

  return {
    handleMessage,
    handleAlarm,
    initialize,
    migrateLegacyStorage,
    recoverStaleMeetings,
    finalizeMeeting,
  };
}
