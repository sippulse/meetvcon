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

  async function capturePrerequisite() {
    const state = await chrome.runtime.sendMessage({ type: "get_popup_state" });
    if (!state?.consented) return "setup_required";
    if (!state.collaboratorEmail?.toLowerCase().endsWith("@sippulse.com")) {
      return "identity_required";
    }
    if (!state.config.configured || !state.config.captureEnabled) {
      return "managed_disabled";
    }
    return "ready";
  }

  async function startCapture() {
    const prerequisite = await capturePrerequisite();
    if (prerequisite !== "ready") {
      inCallPanel.render(prerequisite);
      return;
    }

    captionsWatchdog.clearOptOut();
    captionsWatchdog.start();
    transcriptCapture.start();
    const meeting = await transcriptCapture.startMeeting();
    captureRunning = !!meeting;
    if (!meeting) inCallPanel.render("capture_error");
  }

  async function disableForCall() {
    if (!captureRunning) return;
    captionsWatchdog.optOut();
    captionsWatchdog.stop();
    transcriptCapture.stop();
    await transcriptCapture.cancelMeeting();
    captureRunning = false;
    inCallPanel.render("opted_out");
  }

  async function resumeForCall() {
    await startCapture();
  }

  async function enterCall() {
    inCallPanel.init({
      onDisable: disableForCall,
      onResume: resumeForCall,
      onOpenSetup: () => chrome.runtime.openOptionsPage(),
    });
    await startCapture();
  }

  async function leaveCall() {
    if (captureRunning) {
      await transcriptCapture.endMeeting();
      captureRunning = false;
    }
    captionsWatchdog.stop();
    transcriptCapture.stop();
    inCallPanel.destroy();
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
      inCallPanel.render("capture_error");
    } finally {
      transitionRunning = false;
    }
  }

  const lifecycleTimer = setInterval(checkCallTransition, 2_000);
  checkCallTransition();

  window.addEventListener("beforeunload", () => {
    clearInterval(lifecycleTimer);
    if (captureRunning) {
      chrome.runtime
        .sendMessage({
          type: "call_ended",
          meetingId: transcriptCapture.getMeeting()?.meetingId,
        })
        .catch(() => {});
    }
  });
})();
