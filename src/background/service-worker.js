// SipPulse Meet Capture service worker. All behavior lives in worker-core.js;
// this file only wires Chrome events to it.

import "../lib/logger.js";
import "../lib/config.js";
import "../lib/storage.js";
import "../lib/vcon.js";
import "../lib/retry-policy.js";
import "../lib/transcription.js";
import "../lib/analysis.js";
import "../lib/classification.js";
import { secureStore } from "./secure-store.js";
import { createWorkerCore, MESSAGE_TYPES } from "./worker-core.mjs";

const { log } = self.MeetVcon;

const core = createWorkerCore({
  chrome,
  secureStore,
  lib: self.MeetVcon,
  fetch: (...args) => fetch(...args),
  version: chrome.runtime.getManifest().version,
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
  core
    .migrateLegacyStorage()
    .then(() => core.initialize())
    .catch((error) => log.error("initialization failed", error));
});

chrome.runtime.onStartup.addListener(() => {
  core.initialize().catch((error) => log.error("startup failed", error));
});

core.initialize().catch((error) => log.error("worker initialization failed", error));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type || message.target === "offscreen" || !MESSAGE_TYPES.has(message.type)) {
    return false;
  }
  core
    .handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  core.handleAlarm(alarm)?.catch((error) => log.error("alarm failed", alarm.name, error));
});
