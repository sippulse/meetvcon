// Service-worker orchestration with injected Chrome, crypto, and network
// dependencies so the delivery state machine can be exercised by Node tests
// (tests/worker-core.test.js) without a browser.

export const STALE_MEETING_MS = 10 * 60_000;
// The offscreen document flushes the live streams and runs the final analysis after
// the call; give it this long to report before falling back.
export const FINALIZE_GRACE_MS = 15 * 60_000;
export const DISCARD_TTL_MS = 4 * 60 * 60_000;
export const FETCH_TIMEOUT_MS = 30_000;
export const OFFSCREEN_PATH = "src/offscreen/offscreen.html";
export const RECOVERY_ALARM = "recovery-scan";
export const OFFSCREEN_CLEANUP_ALARM = "offscreen-cleanup";
export const LAST_TRANSCRIPT_ID = "last-transcript";
export const LOCAL_SETTINGS_ID = "local-settings";

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
  "ai_session_result",
  "ai_tab_ended",
  "live_update",
  "retry_queue_item",
  "discard_queue_item",
  "get_queue_item_document",
  "get_last_transcript",
  "test_connection",
  "get_popup_state",
  "get_settings",
  "save_settings",
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
  const { log, storage, vcon, retryPolicy, config: configLib, transcription, analysis, classification } = lib;
  const local = chrome.storage.local;
  const sessionArea = chrome.storage.session || chrome.storage.local;
  const finalizationTasks = new Map();
  let profileCache;

  const iso = (ms = now()) => new Date(ms).toISOString();
  const IDENTITY_ERROR = "Sign in to Chrome with your company account";

  // Policy (admin.google.com) merged with the encrypted local settings.
  async function getConfig() {
    return storage.getConfig(await readLocalSettings());
  }

  async function isAuthorizedEmail(email) {
    return configLib.isAllowedEmail(email, await getConfig());
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
      source: session ? "sippulse_ai_live" : "google_captions",
      error: "",
    });
    // Caption speaker names let the recorder label remote voices in its
    // live notes. Best effort: the final stop message carries them again.
    if (session?.state === "recording" && record.utterances?.length) {
      offscreenRequest({ type: "ai_captions", meetingId: record.meetingId, captions: record.utterances });
    }
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

  // ---- live transcription sessions ----------------------------------------

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

  async function sendToTab(tabId, message) {
    try {
      await chrome.tabs.sendMessage(tabId, message);
    } catch {
      // The Meet tab may already be closed.
    }
  }

  function notifyTab(tabId, meetingId, active, extra = {}) {
    return sendToTab(tabId, { type: "ai_capture_state", meetingId, active, ...extra });
  }

  // The offscreen document cannot message tabs; relay its live transcript
  // and notes to the Meet tab that owns the session.
  async function relayLiveUpdate(meetingId, update) {
    const session = await getAiSession(meetingId);
    if (!session?.tabId || session.state !== "recording") return { ok: false, error: "No live session" };
    await sendToTab(session.tabId, { type: "live_update", meetingId, update });
    return { ok: true };
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
      justification: "Stream a user-approved Meet call to live transcription",
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
    const config = await getConfig();
    if (!config.configured || !config.captureEnabled) {
      return { ok: false, error: config.error || "Capture is disabled by SipPulse" };
    }
    if (!config.liveTranscriptionReady) {
      return { ok: false, error: "Live transcription is not configured by SipPulse" };
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
    const result = await offscreenRequest({
      type: "ai_capture_start",
      streamId,
      meetingId,
      subject: record.subject || "",
      meetingStartedAt: record.startedAt,
      collaborator: profile,
      captions: record.utterances || [],
      config: {
        transcriptionApiKey: config.transcriptionApiKey,
        sippulseAiApiKey: config.sippulseAiApiKey,
        typesafeApiKey: config.typesafeApiKey,
        transcription: config.transcription,
        analysis: config.analysis,
        classification: config.classification,
      },
    });
    if (!result?.ok) {
      await closeOffscreenIfIdle();
      return {
        ok: false,
        error: result?.error || "Audio capture failed",
        code: result?.code || null,
      };
    }
    const streamStartedAt = result.streamStartedAt || iso();
    await setAiSession(meetingId, { state: "recording", startedAt: iso(), streamStartedAt, tabId });
    await chrome.alarms.clear(OFFSCREEN_CLEANUP_ALARM);
    await storage.setDeliveryStatus({ state: "capturing", source: "sippulse_ai_live", error: "" });
    await notifyTab(tabId, meetingId, true, {
      streamStartedAt,
      analysisEnabled: config.analysisReady,
      classificationEnabled: config.classificationReady,
    });
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
    const config = await getConfig();
    if (!config.captureEnabled) {
      await cancelMeeting(meetingId);
      return { ok: false, error: "Capture was disabled by SipPulse" };
    }
    const session = await getAiSession(meetingId);
    if (session?.state === "finalizing") {
      return { ok: true, pending: true, source: "sippulse_ai_live" };
    }
    const profile = await requireProfile();
    if (!profile) return { ok: false, error: "Collaborator email unavailable" };

    const fallback = assembleVcon(
      record,
      deliveryKind,
      session ? "google_captions_fallback" : "google_captions",
      profile
    );
    if (record.utterances?.length) await saveLastTranscript(fallback, record);

    if (session) {
      if (!config.configured) {
        await cancelAiCapture(meetingId, session);
      } else {
        const response = await offscreenRequest({
          type: "ai_capture_stop",
          meetingId,
          subject: record.subject || "",
          collaborator: profile,
          captions: record.utterances || [],
        });
        if (response?.ok) {
          await setAiSession(meetingId, {
            ...session,
            state: "finalizing",
            deliveryKind,
            finalizeStartedAt: iso(),
          });
          await storage.setDeliveryStatus({ state: "finalizing", source: "sippulse_ai_live", error: "" });
          return { ok: true, pending: true, source: "sippulse_ai_live" };
        }
        log.warn("live recorder unavailable; using the transcript saved during the call", response?.error);
        await clearAiSession(meetingId, session);
        return deliverFallback(record, meetingId, deliveryKind, profile, session);
      }
    }
    return deliverCaptions(record, fallback, meetingId, deliveryKind);
  }

  function liveVcon(record, deliveryKind, profile, live, transcriptionSource) {
    const utterances = live.utterances || [];
    const stats = live.stats || transcription.speakerStats(utterances);
    return vcon.assemble(
      { ...record, utterances },
      {
        capturedBy: `SipPulse Meet Capture/${version}`,
        deliveryKind,
        transcriptionSource,
        transcription: {
          provider: live.transcription?.provider || "sippulse_ai",
          model: live.transcription?.model || null,
          language: live.transcription?.language || null,
          stream_started_at: live.streamStartedAt || null,
        },
        analysis: [
          ...analysis.toVconAnalysis({
            analysis: live.analysis,
            model: live.analysisModel,
            stats,
            dialogCount: utterances.length,
            generatedAt: iso(),
          }),
          ...classification.toVconAnalysis({
            utterances,
            classifications: live.classifications,
            model: live.classificationModel,
          }),
        ],
        analysisError: live.analysisError || "",
        capturedByUser: profile,
      }
    );
  }

  async function deliverLive(record, meetingId, deliveryKind, profile, live, transcriptionSource) {
    const document = liveVcon(record, deliveryKind, profile, live, transcriptionSource);
    await saveLastTranscript(document, { ...record, utterances: live.utterances });
    const result = await deliverVcon(document, deliveryKind);
    await removeActiveMeeting(meetingId);
    return result;
  }

  // The recorder could not report: rebuild the transcript from the live
  // segments the Meet tab saved during the call, else use Google captions.
  async function deliverFallback(record, meetingId, deliveryKind, profile, session) {
    const streamStartedAt = record.liveStreamStartedAt || session?.streamStartedAt;
    const utterances = record.liveSegments?.length
      ? transcription.toUtterances(record.liveSegments, {
          streamStartedAt,
          captions: record.utterances || [],
          collaborator: profile,
        })
      : [];
    if (utterances.length) {
      const config = await getConfig();
      const classifications = record.liveClassifications || {};
      const summary = Object.keys(classifications).length
        ? classification.summarize(utterances, classifications, {
            meetingStartedAt: record.startedAt,
            clock: transcription.clock,
          })
        : null;
      return deliverLive(
        record,
        meetingId,
        deliveryKind,
        profile,
        {
          utterances,
          streamStartedAt,
          transcription: config.transcription,
          analysis: analysis.withClassification(record.liveAnalysis || null, summary),
          analysisModel: config.analysis.liveModel,
          classifications,
          classificationModel: config.classification.model,
          analysisError: record.liveAnalysis ? "Final report unavailable; live notes attached" : "",
        },
        "sippulse_ai_live_recovered"
      );
    }
    const fallback = assembleVcon(record, deliveryKind, "google_captions_fallback", profile);
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

  // The Meet tab closed or crashed while recording. Finalize now instead of
  // waiting for the stale-meeting pass; a call_ended that did arrive has
  // already moved the session to finalizing, which makes this a no-op.
  async function finalizeAfterTabEnded(meetingId) {
    const session = await getAiSession(meetingId);
    if (session?.state !== "recording") return { ok: true, ignored: true };
    return finalizeMeeting(meetingId, "final");
  }

  // Reported by the offscreen document once the streams have flushed and the
  // final analysis has run, so the worker never stays alive across either.
  async function completeAiSession(meetingId, result) {
    const session = await getAiSession(meetingId);
    if (!session) {
      log.warn("result for unknown live session", meetingId);
      return { ok: false, error: "No matching live session" };
    }
    const deliveryKind = session.deliveryKind || "final";
    await clearAiSession(meetingId, session);
    const record = await getActiveMeeting(meetingId);
    if (!record) return { ok: false, error: "Meeting record not found" };
    const profile = await requireProfile();
    if (!profile) return { ok: false, error: "Collaborator email unavailable" };
    if (result?.ok && result.utterances?.length) {
      return deliverLive(record, meetingId, deliveryKind, profile, result, "sippulse_ai_live");
    }
    log.warn("live transcript unavailable; falling back", result?.error);
    return deliverFallback(record, meetingId, deliveryKind, profile, session);
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

  async function saveLastTranscript(document, record) {
    await secureStore.put(LAST_TRANSCRIPT_ID, { document, savedAt: iso() });
    await local.set({
      [LAST_TRANSCRIPT_META_KEY]: {
        uuid: document.uuid,
        subject: record.subject || record.meetingId || "",
        savedAt: iso(),
        utteranceCount: record.utterances?.length || 0,
        source: document.attachments?.[0]?.body?.transcription_source || "google_captions",
        hasReport: (document.analysis || []).some((entry) => entry.type === "meeting_insights"),
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
    const config = await getConfig();
    const result = await postVcon(vconDocument, config.endpointUrl, config.hmacSecret, deliveryKind);
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

  // X-MeetVcon-Signature: sha256=<hex HMAC-SHA256 of the exact body>, as
  // verified by the CRM vCon store (sippulse-website src/lib/vcon-ingest.ts).
  async function sign(body, secret) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
    return `sha256=${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  async function signedPost(endpointUrl, hmacSecret, body, extraHeaders = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(endpointUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MeetVcon-Signature": await sign(body, hmacSecret),
          ...extraHeaders,
        },
        body,
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      return { ok: response.ok, status: response.status, payload };
    } catch (error) {
      return { ok: false, error: error.name === "AbortError" ? "Request timed out" : error.message };
    } finally {
      clearTimeout(timer);
    }
  }

  // 202 accepted, 200 duplicate (the store keeps the first copy of a uuid).
  async function postVcon(document, endpointUrl, hmacSecret, deliveryKind) {
    const config = configLib.normalize({ EndpointUrl: endpointUrl, HmacSecret: hmacSecret });
    if (!config.configured) return { ok: false, error: config.error };
    const result = await signedPost(endpointUrl, hmacSecret, JSON.stringify(document), {
      "X-SipPulse-Delivery": deliveryKind,
      "X-SipPulse-Transcription-Source":
        document.attachments?.[0]?.body?.transcription_source || "google_captions",
    });
    if (result.ok) {
      return { ok: true, status: result.status, duplicate: result.payload?.status === "duplicate" };
    }
    if (result.status) {
      return { ok: false, status: result.status, error: result.payload?.error || `HTTP ${result.status}` };
    }
    return { ok: false, error: result.error };
  }

  // The store has no test mode: any valid vCon is stored and emailed. Send a
  // signed body that is not a vCon instead. The store checks the signature
  // before parsing, so 400 proves the secret is right and nothing is stored.
  async function probeStorage(config) {
    if (!config.configured) return { ok: false, error: config.error };
    const result = await signedPost(config.endpointUrl, config.hmacSecret, JSON.stringify({ connection_test: true }));
    if (result.status === 400) return { ok: true, status: 400, detail: "Signature accepted" };
    if (result.status === 401) return { ok: false, status: 401, error: "HMAC secret rejected" };
    if (result.status === 503) return { ok: false, status: 503, error: "vCon store is not configured on the server" };
    if (result.status) return { ok: false, status: result.status, error: `HTTP ${result.status}` };
    return { ok: false, error: result.error };
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

    const config = await getConfig();
    const result = await postVcon(payload.document, payload.endpointUrl, config.hmacSecret, item.deliveryKind);
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
      if (session?.state === "finalizing") {
        if (now() - Date.parse(session.finalizeStartedAt) < FINALIZE_GRACE_MS) continue;
        log.warn("live recorder never reported back; using the saved transcript", meetingId);
        await completeAiSession(meetingId, { ok: false, error: "Live transcript did not complete" });
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

  // ---- local settings (options page) --------------------------------------

  async function readLocalSettings() {
    return (await secureStore.get(LOCAL_SETTINGS_ID))?.settings || {};
  }

  function mask(value) {
    const secret = String(value || "");
    return secret ? `••••${secret.slice(-4)}` : "";
  }

  // Secrets never leave the worker; the page sees only whether one is set.
  async function getSettings() {
    const [local, managed] = await Promise.all([readLocalSettings(), configLib.readManaged()]);
    const { sources } = configLib.merge(managed, local);
    const fields = {};
    for (const field of configLib.LOCAL_FIELDS) {
      const secret = configLib.SECRET_FIELDS.includes(field);
      const value = sources[field] === "policy" ? managed[field] : local[field];
      fields[field] = {
        source: sources[field],
        locked: sources[field] === "policy",
        value: secret ? mask(value) : value ?? "",
        localValue: secret ? mask(local[field]) : local[field] ?? "",
      };
    }
    const config = await getConfig();
    return { ok: true, fields, origins: config.origins, missingOrigins: await missingOrigins(config) };
  }

  // Configured hosts the user has not granted yet (optional host
  // permissions are requested from the options page).
  async function missingOrigins(config) {
    const missing = [];
    for (const origin of config.origins) {
      if (!(await chrome.permissions.contains({ origins: [origin] }))) missing.push(origin);
    }
    return missing;
  }

  // settings: new values (empty secret = keep); remove: fields to clear.
  async function saveSettings({ settings = {}, remove = [] }) {
    const managed = await configLib.readManaged();
    const next = { ...(await readLocalSettings()) };
    for (const field of configLib.LOCAL_FIELDS) {
      if (configLib.merge(managed, {}).sources[field] === "policy") continue;
      if (remove.includes(field)) {
        delete next[field];
        continue;
      }
      if (!(field in settings)) continue;
      const value = settings[field];
      if (field === "AllowedEmailDomains") {
        const domains = (Array.isArray(value) ? value : String(value || "").split(/[\s,;]+/))
          .map((domain) => domain.trim())
          .filter(Boolean);
        if (domains.length) next[field] = domains;
        else delete next[field];
      } else if (typeof value === "string" && value.trim()) {
        next[field] = value.trim();
      } else if (!configLib.SECRET_FIELDS.includes(field)) {
        delete next[field];
      }
    }
    const invalid = Object.values(configLib.normalize(next).errors);
    if (invalid.length) return { ok: false, error: invalid.join("; ") };
    await secureStore.put(LOCAL_SETTINGS_ID, { settings: next, savedAt: iso() });
    profileCache = undefined;
    return getSettings();
  }

  function fromOptionsPage(sender) {
    return !!sender?.url?.startsWith(chrome.runtime.getURL("src/options/"));
  }

  // ---- popup / options ---------------------------------------------------

  async function getPopupState() {
    const [consent, config, status, queue, activeMeetings, aiSessions, discarded, lastMeta, profile] =
      await Promise.all([
        storage.getConsent(),
        getConfig(),
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
        liveTranscriptionReady: config.liveTranscriptionReady,
        transcriptionProvider: config.transcription.provider,
        analysisReady: config.analysisReady,
        classificationReady: config.classificationReady,
        error: config.error,
      },
      status,
      queue,
      activeMeetingIds: Object.keys(activeMeetings),
      aiMeetingIds: Object.keys(aiSessions).filter((id) => aiSessions[id].state === "recording"),
      liveSessions: Object.fromEntries(
        Object.entries(aiSessions)
          .filter(([, session]) => session.state === "recording")
          .map(([id, session]) => [id, { streamStartedAt: session.streamStartedAt || null }])
      ),
      discardedMeetingIds: Object.keys(discarded),
      lastTranscript: lastMeta[LAST_TRANSCRIPT_META_KEY] || null,
      collaboratorEmail: profile?.email || "",
      collaboratorAuthorized: configLib.isAllowedEmail(profile?.email, config),
      missingOrigins: await missingOrigins(config),
    };
  }

  async function handleTestConnection() {
    const profile = await getProfileUser();
    if (!(await isAuthorizedEmail(profile?.email))) {
      return { ok: false, error: IDENTITY_ERROR };
    }
    const config = await getConfig();
    const missing = await missingOrigins(config);
    if (missing.length) {
      const error = `Allow access to ${missing.join(", ")} in Settings first`;
      return { ok: false, error, services: {} };
    }
    const [storageResult, transcriptionResult, sippulseAiResult, typesafeResult] = await Promise.all([
      probeStorage(config),
      transcription.checkKey(fetch, {
        provider: config.transcription.provider,
        apiBase: config.transcription.apiBase,
        apiKey: config.transcriptionApiKey,
      }),
      analysis.checkKey(fetch, config.analysis.apiBase, config.sippulseAiApiKey),
      classification.checkKey(fetch, config.classification.apiBase, config.typesafeApiKey),
    ]);
    return {
      ...storageResult,
      services: {
        storage: storageResult,
        transcription: transcriptionResult,
        sippulseAi: sippulseAiResult,
        typesafe: typesafeResult,
      },
    };
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

  async function handleMessage(message, sender) {
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
      case "ai_session_result":
        return completeAiSession(message.meetingId, message.result);
      case "ai_tab_ended":
        return finalizeAfterTabEnded(message.meetingId);
      case "live_update":
        return relayLiveUpdate(message.meetingId, message.update);
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
      case "get_settings":
        return fromOptionsPage(sender) ? getSettings() : { ok: false, error: "Not allowed" };
      case "save_settings":
        return fromOptionsPage(sender) ? saveSettings(message) : { ok: false, error: "Not allowed" };
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
