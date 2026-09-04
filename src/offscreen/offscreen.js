// Record Meet audio only after an explicit user action. The audio remains in
// memory; when the meeting ends it is uploaded to SipPulse from here and the
// result is reported back to the service worker as an "ai_upload_result"
// message, so the worker never has to stay alive across a long upload.

let session = null;

const UPLOAD_TIMEOUT_MS = 120_000;
const UPLOAD_RETRY_DELAYS_MS = [0, 5_000, 20_000];

function supportedMimeType() {
  return (
    ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((type) =>
      MediaRecorder.isTypeSupported(type)
    ) || ""
  );
}

async function startCapture(streamId, meetingId) {
  if (session) {
    return { ok: false, error: "Another meeting is already being recorded", code: "busy" };
  }

  let tabStream;
  try {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
      },
      video: false,
    });
  } catch (error) {
    return { ok: false, error: `Tab audio capture failed: ${error.message}`, code: "tab_capture" };
  }

  // Offscreen documents cannot show permission prompts. The popup opens
  // src/permissions/microphone.html first so this call finds an existing grant.
  let microphoneStream;
  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (error) {
    tabStream.getTracks().forEach((track) => track.stop());
    const denied = error.name === "NotAllowedError" || error.name === "SecurityError";
    return {
      ok: false,
      error: denied
        ? "Microphone access has not been granted to SipPulse Meet Capture"
        : `Microphone unavailable: ${error.message}`,
      code: denied ? "microphone_permission" : "microphone",
    };
  }

  const context = new AudioContext();
  const mixed = context.createMediaStreamDestination();
  const tabSource = context.createMediaStreamSource(tabStream);
  const microphoneSource = context.createMediaStreamSource(microphoneStream);

  // tabCapture suppresses playback; reconnect only the remote tab audio.
  tabSource.connect(context.destination);
  tabSource.connect(mixed);
  microphoneSource.connect(mixed);

  const mimeType = supportedMimeType();
  const recorder = new MediaRecorder(
    mixed.stream,
    mimeType ? { mimeType, audioBitsPerSecond: 64_000 } : undefined
  );
  const chunks = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data?.size) chunks.push(event.data);
  });
  recorder.start(10_000);

  // If the Meet tab closes or crashes, keep what was recorded so the
  // worker's recovery pass can still upload it.
  tabStream.getAudioTracks().forEach((track) => {
    track.addEventListener("ended", () => {
      if (session?.recorder === recorder && recorder.state === "recording") recorder.stop();
    });
  });

  session = {
    meetingId,
    recorder,
    chunks,
    context,
    tabStream,
    microphoneStream,
    mimeType: recorder.mimeType || mimeType || "audio/webm",
  };
  return { ok: true };
}

function stopRecorder(recorder) {
  if (recorder.state === "inactive") return Promise.resolve();
  return new Promise((resolve) => {
    recorder.addEventListener("stop", resolve, { once: true });
    recorder.stop();
  });
}

async function release(current) {
  current.tabStream.getTracks().forEach((track) => track.stop());
  current.microphoneStream.getTracks().forEach((track) => track.stop());
  await current.context.close();
}

async function uploadOnce({ audio, endpointUrl, bearerToken, vcon, deliveryKind }) {
  const form = new FormData();
  form.append("audio", audio, `${vcon.uuid}.webm`);
  form.append("vcon_uuid", vcon.uuid);
  form.append("fallback_vcon", JSON.stringify(vcon));
  form.append("transcription_provider", "sippulse_ai");
  form.append("model", "pulse-telephony");
  form.append("response_format", "diarization");
  // No language field: SipPulse.ai performs automatic language detection.

  const headers = {
    "X-SipPulse-Delivery": deliveryKind || "final",
    Authorization: `Bearer ${bearerToken}`,
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(endpointUrl, {
      method: "POST",
      headers,
      body: form,
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, status: response.status, error: body.error || `HTTP ${response.status}` };
    }
    return { ok: true, status: response.status, requestId: body.request_id || null };
  } catch (error) {
    return {
      ok: false,
      error: error.name === "AbortError" ? "Audio upload timed out" : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// Retry transient failures (network, timeout, 5xx, 429). A 4xx is final.
async function uploadWithRetry(request) {
  let last = { ok: false, error: "Upload not attempted" };
  for (const delay of UPLOAD_RETRY_DELAYS_MS) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    last = await uploadOnce(request);
    if (last.ok) return last;
    const status = last.status || 0;
    if (status >= 400 && status < 500 && status !== 429) return last;
  }
  return last;
}

async function reportResult(meetingId, uuid, result) {
  try {
    await chrome.runtime.sendMessage({ type: "ai_upload_result", meetingId, result: { ...result, uuid } });
  } catch (error) {
    console.error("[SipPulse Meet] could not report upload result", error);
  }
}

async function stopAndUpload({ meetingId, endpointUrl, bearerToken, vcon, deliveryKind }) {
  if (!session || session.meetingId !== meetingId) {
    return { ok: false, error: "No matching SipPulse AI capture" };
  }
  const current = session;
  session = null;
  await stopRecorder(current.recorder);
  const audio = new Blob(current.chunks, { type: current.mimeType });
  await release(current);
  if (!audio.size) {
    return { ok: false, error: "No audio was recorded" };
  }

  // Acknowledge immediately; the result arrives as a separate message.
  uploadWithRetry({ audio, endpointUrl, bearerToken, vcon, deliveryKind })
    .then((result) => reportResult(meetingId, vcon.uuid, result))
    .catch((error) =>
      reportResult(meetingId, vcon.uuid, { ok: false, error: error.message || String(error) })
    );
  return { ok: true, pending: true };
}

async function cancelCapture(meetingId) {
  if (!session || session.meetingId !== meetingId) return;
  const current = session;
  session = null;
  await stopRecorder(current.recorder);
  await release(current);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  const task =
    message.type === "ai_capture_start"
      ? startCapture(message.streamId, message.meetingId)
      : message.type === "ai_capture_stop"
      ? stopAndUpload(message)
      : message.type === "ai_capture_cancel"
      ? cancelCapture(message.meetingId).then(() => ({ ok: true }))
      : Promise.resolve({ ok: false, error: "Unknown offscreen message" });

  task.then(sendResponse).catch((error) =>
    sendResponse({ ok: false, error: error.message || String(error) })
  );
  return true;
});
