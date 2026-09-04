// Record Meet audio only after an explicit user action. The audio remains in
// memory and is uploaded to SipPulse when the meeting ends.

let session = null;

function supportedMimeType() {
  return (
    ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find(
      (type) => MediaRecorder.isTypeSupported(type)
    ) || ""
  );
}

async function startCapture(streamId, meetingId) {
  if (session) throw new Error("Another meeting is already being recorded");

  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  let microphoneStream;
  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (error) {
    tabStream.getTracks().forEach((track) => track.stop());
    throw new Error(`Microphone permission is required: ${error.message}`);
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

  session = {
    meetingId,
    recorder,
    chunks,
    context,
    tabStream,
    microphoneStream,
    mimeType: recorder.mimeType || mimeType || "audio/webm",
  };
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

async function stopAndUpload({
  meetingId,
  endpointUrl,
  bearerToken,
  vcon,
  deliveryKind,
}) {
  if (!session || session.meetingId !== meetingId) {
    return { ok: false, error: "No matching SipPulse AI capture" };
  }

  const current = session;
  session = null;
  await stopRecorder(current.recorder);
  const audio = new Blob(current.chunks, { type: current.mimeType });
  await release(current);

  const form = new FormData();
  form.append("audio", audio, `${vcon.uuid}.webm`);
  form.append("vcon_uuid", vcon.uuid);
  form.append("fallback_vcon", JSON.stringify(vcon));
  form.append("transcription_provider", "sippulse_ai");
  form.append("model", "pulse-telephony");
  form.append("response_format", "diarization");
  // No language field: SipPulse.ai performs automatic language detection.

  const headers = { "X-SipPulse-Delivery": deliveryKind || "final" };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(endpointUrl, {
      method: "POST",
      headers,
      body: form,
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, error: body.error || `HTTP ${response.status}` };
    }
    return {
      ok: true,
      status: response.status,
      requestId: body.request_id || null,
    };
  } catch (error) {
    return {
      ok: false,
      error: error.name === "AbortError" ? "Audio upload timed out" : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function cancelCapture(meetingId) {
  if (!session || session.meetingId !== meetingId) return;
  const current = session;
  session = null;
  await stopRecorder(current.recorder);
  await release(current);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "offscreen") return false;

  const task =
    message.type === "ai_capture_start"
      ? startCapture(message.streamId, message.meetingId).then(() => ({ ok: true }))
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
