// MV3 service worker. Responsibilities:
//   - Receive call_started / call_ended messages from content scripts.
//   - Schedule periodic snapshot delivery (chrome.alarms) when delivery
//     mode is "periodic_snapshot".
//   - Assemble vCon docs from session-storage meeting records.
//   - POST to user-configured webhook with optional Bearer auth and
//     optional HMAC-SHA256 signature.
//   - On failure: enqueue with exponential backoff, retry via alarms.
//   - Log delivered meetings to chrome.storage.local.meetings.
//
// Imports below execute the lib files for their side effects (each
// attaches its API to self.MeetVcon).

import "../lib/logger.js";
import "../lib/storage.js";
import "../lib/vcon.js";

const { log, storage, vcon } = self.MeetVcon;
const VERSION = "0.1.0";
const USER_AGENT = `MeetVcon/${VERSION}`;

// Backoff schedule in minutes. Index = attempt number (0-based).
const BACKOFF_MIN = [0.5, 2, 10, 60, 360, 1440];

// chrome.storage.session defaults to TRUSTED_CONTEXTS (worker + extension
// pages only). The content script writes the in-flight meeting record there
// and the worker reads it back at call_ended / snapshot time — both sides
// must share access. Widen on every SW startup since the access level is
// per-session and not persisted across browser restarts.
chrome.storage.session
  .setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
  .catch((err) => log.warn("setAccessLevel failed", err));

// ---- lifecycle ------------------------------------------------------

self.addEventListener("install", () => {
  log.info("service worker installed", VERSION);
});

self.addEventListener("activate", () => {
  log.info("service worker activated");
});

// ---- message handling -----------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  log.debug("message", msg.type, msg);

  switch (msg.type) {
    case "call_started":
      handleCallStarted(msg.meetingId, msg.uuid)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    case "call_ended":
      handleCallEnded(msg.meetingId)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    case "test_webhook":
      handleTestWebhook()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    case "retry_queue_item":
      retryQueueItem(msg.id, /*manual=*/ true)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    case "discard_queue_item":
      discardQueueItem(msg.id)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    default:
      return false;
  }
});

// ---- call lifecycle -------------------------------------------------

async function handleCallStarted(meetingId, uuid) {
  if (!meetingId) return;
  const cfg = await storage.getConfig();
  if (cfg.deliveryMode === "periodic_snapshot") {
    const interval = clamp(cfg.snapshotIntervalMin || 5, 1, 60);
    chrome.alarms.create(snapshotAlarmName(meetingId), {
      periodInMinutes: interval,
      delayInMinutes: interval, // first fire after one full interval
    });
    log.info(
      "scheduled snapshot alarm for",
      meetingId,
      "every",
      interval,
      "min"
    );
  }
}

async function handleCallEnded(meetingId) {
  if (!meetingId) return;
  await chrome.alarms.clear(snapshotAlarmName(meetingId));
  const record = await storage.getMeeting(meetingId);
  if (!record) {
    log.warn("call_ended but no meeting record found", meetingId);
    return;
  }
  if (!record.utterances || record.utterances.length === 0) {
    log.info("skipping delivery: no utterances captured for", meetingId);
    await storage.appendMeetingLog({
      uuid: record.uuid,
      meetingId: record.meetingId,
      subject: record.subject,
      startedAt: record.startedAt,
      endedAt: new Date().toISOString(),
      utteranceCount: 0,
      status: "skipped_no_captions",
    });
    await storage.deleteMeeting(meetingId);
    return;
  }
  await deliverMeeting(record, "final");
  await storage.deleteMeeting(meetingId);
}

// ---- alarms ---------------------------------------------------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith("snapshot:")) {
    const meetingId = alarm.name.slice("snapshot:".length);
    await handleSnapshotAlarm(meetingId);
  } else if (alarm.name.startsWith("retry:")) {
    const id = alarm.name.slice("retry:".length);
    await retryQueueItem(id, /*manual=*/ false);
  }
});

async function handleSnapshotAlarm(meetingId) {
  const record = await storage.getMeeting(meetingId);
  if (!record || !record.utterances || record.utterances.length === 0) {
    log.debug("snapshot alarm: nothing to send for", meetingId);
    return;
  }
  await deliverMeeting(record, "snapshot");
}

const snapshotAlarmName = (id) => `snapshot:${id}`;
const retryAlarmName = (id) => `retry:${id}`;

// ---- delivery -------------------------------------------------------

async function deliverMeeting(record, deliveryKind) {
  const cfg = await storage.getConfig();
  if (!cfg.webhookUrl) {
    log.warn("no webhook URL configured; skipping", deliveryKind, record.meetingId);
    return;
  }

  const capturedByUser = cfg.includeCapturerEmail
    ? await getProfileUser()
    : null;

  const vConDoc = vcon.assemble(record, {
    capturedBy: USER_AGENT,
    deliveryKind,
    capturedByUser,
  });

  const result = await postWebhook(vConDoc, cfg, deliveryKind);
  if (result.ok) {
    log.info(
      "delivered",
      deliveryKind,
      record.meetingId,
      "→",
      cfg.webhookUrl,
      "status",
      result.status
    );
    if (deliveryKind === "final") {
      await storage.appendMeetingLog({
        uuid: record.uuid,
        meetingId: record.meetingId,
        subject: record.subject,
        startedAt: record.startedAt,
        endedAt: new Date().toISOString(),
        utteranceCount: record.utterances?.length || 0,
        status: "delivered",
      });
    }
    return;
  }

  log.warn("delivery failed", deliveryKind, record.meetingId, result.error);
  await enqueue({
    vcon: vConDoc,
    url: cfg.webhookUrl,
    deliveryKind,
    error: result.error,
  });
}

async function postWebhook(vConDoc, cfg, deliveryKind) {
  if (!/^https:\/\//i.test(cfg.webhookUrl)) {
    return { ok: false, error: "Webhook URL must use HTTPS" };
  }
  let host;
  try {
    host = new URL(cfg.webhookUrl).hostname;
  } catch {
    return { ok: false, error: "Invalid webhook URL" };
  }
  const has = await chrome.permissions.contains({
    origins: [`https://${host}/*`],
  });
  if (!has) {
    return {
      ok: false,
      error: `No host permission for ${host}. Open MeetVcon options and re-save the webhook URL to grant access.`,
    };
  }
  const body = JSON.stringify(vConDoc);
  const headers = {
    "Content-Type": "application/vcon+json",
    "X-MeetVcon-Version": VERSION,
    "X-MeetVcon-Delivery": deliveryKind,
  };
  // Note: the User-Agent header is set by Chrome and cannot be overridden
  // from a service worker fetch — we use X-MeetVcon-Version instead.
  if (cfg.bearerToken) {
    headers["Authorization"] = `Bearer ${cfg.bearerToken}`;
  }
  if (cfg.hmacSecret) {
    const sig = await hmacSha256Hex(cfg.hmacSecret, body);
    headers["X-MeetVcon-Signature"] = `sha256=${sig}`;
  }
  try {
    const resp = await fetch(cfg.webhookUrl, {
      method: "POST",
      headers,
      body,
    });
    if (resp.ok) return { ok: true, status: resp.status };
    return { ok: false, error: `HTTP ${resp.status}`, status: resp.status };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function hmacSha256Hex(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---- queue ----------------------------------------------------------

async function enqueue({ vcon: vConDoc, url, deliveryKind, error }) {
  const queue = await storage.getQueue();

  // Snapshot dedup: a newer snapshot for the same UUID supersedes any
  // earlier queued snapshot — no point retrying stale snapshots.
  let pruned = queue;
  if (deliveryKind === "snapshot") {
    pruned = queue.filter((q) => {
      if (q.deliveryKind !== "snapshot") return true;
      if (q.vcon?.uuid !== vConDoc.uuid) return true;
      // Cancel its retry alarm.
      chrome.alarms.clear(retryAlarmName(q.id));
      return false;
    });
  }

  const id = vcon.uuidv4();
  const attempts = 0;
  const delayMin = BACKOFF_MIN[0];
  const item = {
    id,
    vcon: vConDoc,
    url,
    deliveryKind,
    attempts,
    nextAttemptAt: new Date(Date.now() + delayMin * 60_000).toISOString(),
    lastError: error,
  };
  pruned.push(item);
  await storage.setQueue(pruned);
  chrome.alarms.create(retryAlarmName(id), { delayInMinutes: delayMin });
  log.info(
    "queued for retry",
    deliveryKind,
    "in",
    delayMin,
    "min (id:",
    id,
    ")"
  );
}

async function retryQueueItem(id, manual) {
  const queue = await storage.getQueue();
  const idx = queue.findIndex((q) => q.id === id);
  if (idx < 0) {
    log.debug("retry: item not found", id);
    return { ok: false, error: "not_found" };
  }
  const item = queue[idx];
  const cfg = await storage.getConfig();
  const result = await postWebhook(item.vcon, cfg, item.deliveryKind);
  if (result.ok) {
    queue.splice(idx, 1);
    await storage.setQueue(queue);
    log.info("queue retry succeeded", id);
    return { ok: true };
  }

  if (manual) {
    item.lastError = result.error;
    await storage.setQueue(queue);
    return { ok: false, error: result.error };
  }

  item.attempts += 1;
  item.lastError = result.error;
  if (item.attempts >= BACKOFF_MIN.length) {
    queue.splice(idx, 1);
    await storage.setQueue(queue);
    log.error("dropping queue item after max retries", id);
    return { ok: false, error: "max_retries" };
  }
  const delayMin = BACKOFF_MIN[item.attempts];
  item.nextAttemptAt = new Date(Date.now() + delayMin * 60_000).toISOString();
  await storage.setQueue(queue);
  chrome.alarms.create(retryAlarmName(id), { delayInMinutes: delayMin });
  log.info(
    "retry failed; rescheduling",
    id,
    "attempt",
    item.attempts,
    "in",
    delayMin,
    "min"
  );
  return { ok: false, error: result.error };
}

async function discardQueueItem(id) {
  const queue = await storage.getQueue();
  const next = queue.filter((q) => q.id !== id);
  await storage.setQueue(next);
  await chrome.alarms.clear(retryAlarmName(id));
}

// ---- test webhook ---------------------------------------------------

async function handleTestWebhook() {
  const cfg = await storage.getConfig();
  if (!cfg.webhookUrl) {
    return { ok: false, error: "No webhook URL configured" };
  }
  const now = new Date().toISOString();
  const testRecord = {
    uuid: vcon.uuidv4(),
    meetingId: "test-payload",
    meetingUrl: "https://meet.google.com/test-payload",
    subject: "MeetVcon test payload",
    startedAt: now,
    utterances: [
      {
        speaker: "MeetVcon",
        text: "This is a test payload from the MeetVcon options page.",
        start: now,
        duration: 1,
      },
    ],
    captionsEnabled: true,
  };
  const capturedByUser = cfg.includeCapturerEmail
    ? await getProfileUser()
    : null;
  const doc = vcon.assemble(testRecord, {
    capturedBy: USER_AGENT,
    deliveryKind: "test",
    capturedByUser,
  });
  return await postWebhook(doc, cfg, "test");
}

// Returns { email, id } for the Chrome profile signed into the browser,
// or null if no profile is signed in / identity API unavailable.
// Cached for the lifetime of the service worker (the profile rarely
// changes, and getProfileUserInfo is essentially free, but caching also
// lets us survive permission-removal edge cases gracefully).
let _profileUserCache = undefined;
async function getProfileUser() {
  if (_profileUserCache !== undefined) return _profileUserCache;
  if (!chrome.identity?.getProfileUserInfo) {
    _profileUserCache = null;
    return null;
  }
  return new Promise((resolve) => {
    try {
      chrome.identity.getProfileUserInfo(
        { accountStatus: "ANY" },
        (info) => {
          if (chrome.runtime.lastError) {
            log.warn("getProfileUserInfo error", chrome.runtime.lastError.message);
            _profileUserCache = null;
            resolve(null);
            return;
          }
          if (info && info.email) {
            _profileUserCache = { email: info.email, id: info.id || null };
          } else {
            _profileUserCache = null;
          }
          resolve(_profileUserCache);
        }
      );
    } catch (err) {
      log.warn("getProfileUserInfo threw", err);
      _profileUserCache = null;
      resolve(null);
    }
  });
}

// ---- helpers --------------------------------------------------------

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Number(n) || lo));
}
