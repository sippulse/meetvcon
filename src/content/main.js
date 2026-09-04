// Meet lifecycle controller. Capture fails closed until the employee accepts
// the disclosure and the SipPulse-managed policy enables the extension.

(function () {
  const ns = (window.MeetVcon = window.MeetVcon || {});
  const { log, selectors, storage, captionsWatchdog, transcriptCapture, inCallPanel } = ns;

  if (!storage || !captionsWatchdog || !transcriptCapture || !inCallPanel) {
    console.error("[SipPulse Meet] initialization failed", Object.keys(ns));
    return;
  }

  let inCall = false;
  let captureRunning = false;
  let transitionRunning = false;
  let currentMeetingId = null;

  async function capturePrerequisite(meetingId) {
    const state = await chrome.runtime.sendMessage({ type: "get_popup_state" });
    if (!state?.consented) return { status: "setup_required", state };
    if (!state.collaboratorAuthorized) return { status: "identity_required", state };
    if (!state.config.configured || !state.config.captureEnabled) {
      return { status: "managed_disabled", state };
    }
    if (meetingId && state.discardedMeetingIds?.includes(meetingId)) {
      return { status: "discarded", state };
    }
    return { status: "ready", state };
  }

  async function startCapture() {
    currentMeetingId = transcriptCapture.meetingIdFromUrl();
    const { status, state } = await capturePrerequisite(currentMeetingId);
    if (status !== "ready") {
      inCallPanel.lock(status);
      return;
    }

    captionsWatchdog.clearOptOut();
    captionsWatchdog.start();
    transcriptCapture.start();
    const meeting = await transcriptCapture.startMeeting();
    captureRunning = !!meeting;
    if (!meeting) {
      inCallPanel.lock("capture_error");
      return;
    }
    inCallPanel.setAudioActive(state.aiMeetingIds?.includes(meeting.meetingId) || false);
  }

  // "Stop and discard" is final for this call: the worker remembers the
  // meeting code so a reload or a second tab cannot resume capture.
  async function discardForCall() {
    if (!captureRunning) return;
    captureRunning = false;
    captionsWatchdog.optOut();
    captionsWatchdog.stop();
    transcriptCapture.stop();
    inCallPanel.setAudioActive(false);
    inCallPanel.lock("discarded");
    await transcriptCapture.cancelMeeting();
  }

  async function enterCall() {
    inCallPanel.init({
      onDiscard: discardForCall,
      onOpenSetup: () => chrome.runtime.openOptionsPage(),
    });
    await startCapture();
  }

  async function leaveCall() {
    const meetingId = currentMeetingId;
    try {
      // Stop the persist timer before finalizing so a late snapshot cannot
      // re-create the record the worker is about to remove.
      captionsWatchdog.stop();
      transcriptCapture.stop();
      if (captureRunning) await transcriptCapture.endMeeting();
    } finally {
      captureRunning = false;
      currentMeetingId = null;
      inCallPanel.destroy();
      if (meetingId) {
        chrome.runtime.sendMessage({ type: "call_left", meetingId }).catch(() => {});
      }
    }
  }

  async function checkCallTransition() {
    if (transitionRunning) return;
    const next = selectors.isInCall();
    if (next === inCall) return;
    transitionRunning = true;
    try {
      inCall = next;
      if (inCall) await enterCall();
      else await leaveCall();
    } catch (error) {
      log.error("call transition failed", error);
      if (inCall) inCallPanel.lock("capture_error");
    } finally {
      transitionRunning = false;
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "ai_capture_state" && message.meetingId === currentMeetingId) {
      inCallPanel.setAudioActive(!!message.active);
    }
  });

  const lifecycleTimer = setInterval(checkCallTransition, 2_000);
  checkCallTransition();

  window.addEventListener("beforeunload", () => {
    clearInterval(lifecycleTimer);
    if (captureRunning) {
      chrome.runtime
        .sendMessage({ type: "call_ended", meetingId: transcriptCapture.getMeeting()?.meetingId })
        .catch(() => {});
    }
  });
})();
