// Content-script orchestrator. Runs on every meet.google.com page.
// Lifecycle:
//   - On load: start watchdog + capture machinery (idle until in a call).
//   - Detect in-call transitions by polling selectors.isInCall().
//   - On false→true: start a meeting record + transcript capture +
//     notify the service worker.
//   - On true→false: end the meeting + notify the service worker
//     (which assembles the final vCon and POSTs).

(function () {
  const ns = (window.MeetVcon = window.MeetVcon || {});
  const { log, selectors, captionsWatchdog, transcriptCapture, inCallPanel } = ns;

  if (!captionsWatchdog || !inCallPanel || !transcriptCapture) {
    console.error(
      "[MeetVcon] init failed — content script modules missing.",
      Object.keys(ns)
    );
    return;
  }

  log.info("content script loaded on", location.href);

  inCallPanel.init();
  captionsWatchdog.start();
  transcriptCapture.start();

  let inCall = false;

  async function checkCallTransition() {
    const now = selectors.isInCall();
    if (now && !inCall) {
      inCall = true;
      log.info("call entered");
      await transcriptCapture.startMeeting();
    } else if (!now && inCall) {
      inCall = false;
      log.info("call exited");
      await transcriptCapture.endMeeting();
    }
  }

  setInterval(checkCallTransition, 2_000);
  checkCallTransition();

  // Also handle tab close while in a call. We can't await async work in
  // beforeunload, but persistence runs every 5s, so the latest record is
  // already in chrome.storage.session — the service worker can find it
  // there on next wake-up if we don't get to send the call_ended message.
  window.addEventListener("beforeunload", () => {
    if (inCall) {
      try {
        chrome.runtime.sendMessage({
          type: "call_ended",
          meetingId: transcriptCapture.getMeeting()?.meetingId,
          reason: "tab_closed",
        });
      } catch (e) {
        // Ignore — service worker may already be evicted.
      }
    }
    captionsWatchdog.stop();
    transcriptCapture.stop();
    inCallPanel.destroy();
  });
})();
