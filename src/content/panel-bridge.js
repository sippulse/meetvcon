// The Meet page owns the live transcript, but the user interface is Chrome's
// side panel, which is a separate document. This is the bridge: it keeps the
// capture status, serializes a snapshot of everything the panel shows, and
// pushes it over a port the side panel opens (src/sidepanel/). No panel is
// drawn inside the Meet page.

(function () {
  const ns = (window.MeetVcon = window.MeetVcon || {});
  if (ns.panelBridge) return;

  const { transcription } = ns;
  const PORT_NAME = "meetvcon-panel";
  const PUSH_INTERVAL_MS = 800;

  let handlers = {};
  let currentStatus = "idle";
  // The exact reason behind a blocked status (config error, failed lookup).
  let statusDetail = "";
  let locked = false;
  let audioActive = false;
  let analysisEnabled = false;
  // "live": notes refresh during the call and lines get tags. Otherwise
  // everything is written once, when the call ends.
  let liveAnalysis = false;
  let classificationEnabled = false;
  let collaborator = null;
  // The call is being captured. Independent of whether Google captions happen
  // to be on, which is what the watchdog status reports.
  let captureRunning = false;
  const ports = new Set();
  let unsubscribe = [];
  let refreshTimer = null;
  let pushTimer = null;
  let lastPush = 0;

  function utterances() {
    const capture = ns.transcriptCapture;
    const live = capture?.getLive?.();
    if (live?.streamStartedAt && live.segments.length) {
      return transcription.toUtterances(live.segments, {
        streamStartedAt: live.streamStartedAt,
        captions: capture.getCaptionUtterances(),
        speaking: ns.activeSpeaker?.getEvents() || [],
        collaborator,
      });
    }
    return capture?.getCaptionUtterances?.() || [];
  }

  // Everything the side panel needs, as plain JSON: it cannot reach into the
  // page for the rest.
  function snapshot() {
    const live = ns.transcriptCapture?.getLive?.() || {};
    const meeting = ns.transcriptCapture?.getMeeting?.();
    return {
      status: currentStatus,
      statusDetail,
      captureRunning,
      captionsOn: currentStatus === "active",
      audioActive,
      analysisEnabled,
      liveAnalysis,
      classificationEnabled,
      collaborator,
      meetingId: meeting?.meetingId || null,
      meetingStartedAt: meeting?.startedAt || null,
      utterances: utterances(),
      classifications: live.classifications || {},
      interim: live.interim || {},
      analysis: live.analysis || null,
      analysisAt: live.analysisAt || null,
      analysisError: live.status?.analysis_status?.error || "",
      transcriptionState: live.status?.transcription_status?.state || "",
      speakerDetection: ns.activeSpeaker?.diagnostics() || null,
    };
  }

  function push() {
    if (!ports.size) return;
    lastPush = Date.now();
    const state = snapshot();
    for (const port of ports) {
      try {
        port.postMessage({ type: "panel_state", snapshot: state });
      } catch {
        ports.delete(port);
      }
    }
  }

  // Bursts of transcript updates become one push.
  function schedulePush() {
    if (!ports.size || pushTimer) return;
    const wait = Math.max(0, PUSH_INTERVAL_MS - (Date.now() - lastPush));
    pushTimer = setTimeout(() => {
      pushTimer = null;
      push();
    }, wait);
  }

  async function onPanelMessage(message) {
    if (message?.type === "discard") await handlers.onDiscard?.();
    else if (message?.type === "refresh") push();
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    ports.add(port);
    port.onMessage.addListener(onPanelMessage);
    port.onDisconnect.addListener(() => ports.delete(port));
    port.postMessage({ type: "panel_state", snapshot: snapshot() });
  });

  function onWatchdogStatus(status) {
    if (locked) return;
    currentStatus = status;
    statusDetail = "";
    schedulePush();
  }

  // Terminal states (discarded, prerequisites) must not be overwritten by
  // later captions-watchdog status changes.
  function lock(status, detail = "") {
    locked = true;
    currentStatus = status;
    statusDetail = detail;
    push();
  }

  function setCaptureRunning(running) {
    captureRunning = !!running;
    push();
  }

  function setAudioActive(isActive, options = {}) {
    audioActive = !!isActive;
    if ("analysisEnabled" in options) analysisEnabled = !!options.analysisEnabled;
    if ("liveAnalysis" in options) liveAnalysis = !!options.liveAnalysis;
    if ("classificationEnabled" in options) classificationEnabled = !!options.classificationEnabled;
    push();
  }

  function init(nextHandlers = {}) {
    handlers = nextHandlers;
    collaborator = nextHandlers.collaborator || null;
    locked = false;
    audioActive = false;
    captureRunning = false;
    currentStatus = "idle";
    statusDetail = "";
    unsubscribe.forEach((fn) => fn());
    unsubscribe = [
      ns.captionsWatchdog.onStatusChange(onWatchdogStatus),
      ns.transcriptCapture.onLiveChange(schedulePush),
    ];
    // Caption-only mode has no push events; refresh periodically.
    if (!refreshTimer) refreshTimer = setInterval(schedulePush, 2_000);
    push();
  }

  function destroy() {
    clearInterval(refreshTimer);
    refreshTimer = null;
    clearTimeout(pushTimer);
    pushTimer = null;
    unsubscribe.forEach((fn) => fn());
    unsubscribe = [];
    locked = false;
    audioActive = false;
    captureRunning = false;
    currentStatus = "idle";
    push();
  }

  ns.panelBridge = { init, destroy, lock, setCaptureRunning, setAudioActive, snapshot };
})();
