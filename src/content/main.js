// Meet lifecycle controller. Capture fails closed until the employee accepts
// the disclosure and the SipPulse-managed policy enables the extension.

(function () {
  const ns = (window.MeetVcon = window.MeetVcon || {});
  const { log, selectors, storage, captionsWatchdog, activeSpeaker, transcriptCapture, panelBridge } = ns;

  if (!storage || !captionsWatchdog || !transcriptCapture || !panelBridge) {
    console.error("[SipPulse Meet] initialization failed", Object.keys(ns));
    return;
  }

  let inCall = false;
  let captureRunning = false;
  let transitionRunning = false;
  let currentMeetingId = null;

  async function capturePrerequisite(meetingId) {
    // A failed lookup is its own state: reporting it as "no consent yet"
    // sent people to a dialog that had nothing to accept.
    let state;
    try {
      state = await chrome.runtime.sendMessage({ type: "get_popup_state" });
    } catch (error) {
      log.error("could not read extension state", error);
      return { status: "state_unavailable", detail: error.message };
    }
    if (!state?.ok) {
      log.error("extension state unavailable", state?.error);
      return { status: "state_unavailable", detail: state?.error, state };
    }
    if (!state.consented) return { status: "setup_required", state };
    if (!state.collaboratorAuthorized) return { status: "identity_required", state };
    if (!state.config.configured || !state.config.captureEnabled) {
      return { status: "managed_disabled", state, detail: state.config.error };
    }
    if (meetingId && state.discardedMeetingIds?.includes(meetingId)) {
      return { status: "discarded", state };
    }
    return { status: "ready", state };
  }

  async function startCapture() {
    currentMeetingId = transcriptCapture.meetingIdFromUrl();
    const { status, state, detail } = await capturePrerequisite(currentMeetingId);
    if (status !== "ready") {
      panelBridge.lock(status, detail || "");
      return;
    }

    captionsWatchdog.start();
    activeSpeaker.start();
    transcriptCapture.start();
    const meeting = await transcriptCapture.startMeeting();
    captureRunning = !!meeting;
    panelBridge.setCaptureRunning(captureRunning);
    if (!meeting) {
      panelBridge.lock("capture_error");
      return;
    }
    const live = state.liveSessions?.[meeting.meetingId];
    if (live) transcriptCapture.startLive(live.streamStartedAt);
    panelBridge.setAudioActive(!!live, {
      analysisEnabled: state.config.analysisReady,
      classificationEnabled: state.config.classificationReady,
      liveAnalysis: state.config.analysisMode === "live",
    });
  }

  // "Stop and discard" is final for this call: the worker remembers the
  // meeting code so a reload or a second tab cannot resume capture.
  async function discardForCall() {
    if (!captureRunning) return;
    captureRunning = false;
    captionsWatchdog.stop();
    activeSpeaker.reset();
    transcriptCapture.stop();
    panelBridge.setCaptureRunning(false);
    panelBridge.setAudioActive(false);
    panelBridge.lock("discarded");
    await transcriptCapture.cancelMeeting();
  }

  async function enterCall() {
    const state = await chrome.runtime.sendMessage({ type: "get_popup_state" }).catch(() => null);
    panelBridge.init({
      onDiscard: discardForCall,
      collaborator: state?.collaboratorEmail ? { email: state.collaboratorEmail } : null,
    });
    await startCapture();
  }

  async function leaveCall() {
    const meetingId = currentMeetingId;
    try {
      // Stop the persist timer before finalizing so a late snapshot cannot
      // re-create the record the worker is about to remove.
      captionsWatchdog.stop();
      activeSpeaker.stop();
      transcriptCapture.stop();
      if (captureRunning) await transcriptCapture.endMeeting();
    } finally {
      captureRunning = false;
      currentMeetingId = null;
      panelBridge.destroy();
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
      if (inCall) panelBridge.lock("capture_error");
    } finally {
      transitionRunning = false;
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message?.meetingId || message.meetingId !== currentMeetingId || !captureRunning) return;
    if (message.type === "ai_capture_state") {
      if (message.active) transcriptCapture.startLive(message.streamStartedAt);
      panelBridge.setAudioActive(!!message.active, {
        analysisEnabled: message.analysisEnabled,
        classificationEnabled: message.classificationEnabled,
        liveAnalysis: message.liveAnalysis,
      });
    } else if (message.type === "live_update") {
      transcriptCapture.applyLiveUpdate(message.update);
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
