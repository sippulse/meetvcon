// chrome.storage helpers, shared by content scripts and the service worker.
//
// Schemas
// -------
// chrome.storage.local:
//   config: {
//     webhookUrl, bearerToken, hmacSecret,
//     deliveryMode: "end_of_call" | "periodic_snapshot",
//     snapshotIntervalMin: 1..60,
//     includeSpeakerEmail: boolean,
//   }
//   queue:    [ { id, vcon, url, deliveryKind, attempts, nextAttemptAt, lastError } ]
//   meetings: [ { uuid, meetingId, subject, startedAt, endedAt, status, ... } ]
//
// chrome.storage.session (cleared on browser restart):
//   meeting_<meetingId>: { uuid, meetingId, meetingUrl, subject, startedAt,
//                          utterances: [...], parties: [...] }

(function (root) {
  const ns = (root.MeetVcon = root.MeetVcon || {});
  if (ns.storage) return;

  const DEFAULT_CONFIG = {
    webhookUrl: "",
    bearerToken: "",
    hmacSecret: "",
    deliveryMode: "end_of_call",
    snapshotIntervalMin: 5,
    includeSpeakerEmail: false,
    includeCapturerEmail: true, // include Chrome profile email in vCon metadata
  };

  async function getConfig() {
    const { config } = await chrome.storage.local.get("config");
    return { ...DEFAULT_CONFIG, ...(config || {}) };
  }

  async function setConfig(patch) {
    const current = await getConfig();
    await chrome.storage.local.set({ config: { ...current, ...patch } });
  }

  const meetingKey = (id) => `meeting_${id}`;

  async function getMeeting(meetingId) {
    const k = meetingKey(meetingId);
    const data = await chrome.storage.session.get(k);
    return data[k] || null;
  }

  async function setMeeting(meetingId, record) {
    await chrome.storage.session.set({ [meetingKey(meetingId)]: record });
  }

  async function deleteMeeting(meetingId) {
    await chrome.storage.session.remove(meetingKey(meetingId));
  }

  async function getQueue() {
    const { queue } = await chrome.storage.local.get("queue");
    return queue || [];
  }

  async function setQueue(items) {
    await chrome.storage.local.set({ queue: items });
  }

  async function getMeetingsLog() {
    const { meetings } = await chrome.storage.local.get("meetings");
    return meetings || [];
  }

  async function appendMeetingLog(entry) {
    const log = await getMeetingsLog();
    log.unshift(entry);
    // Keep last 100 entries — older ones drop off.
    await chrome.storage.local.set({ meetings: log.slice(0, 100) });
  }

  ns.storage = {
    DEFAULT_CONFIG,
    getConfig,
    setConfig,
    meetingKey,
    getMeeting,
    setMeeting,
    deleteMeeting,
    getQueue,
    setQueue,
    getMeetingsLog,
    appendMeetingLog,
  };
})(typeof self !== "undefined" ? self : window);
