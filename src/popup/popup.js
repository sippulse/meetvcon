const elements = {
  dot: document.getElementById("dot"),
  status: document.getElementById("status"),
  detail: document.getElementById("detail"),
  startAi: document.getElementById("startAi"),
  setup: document.getElementById("setup"),
  aiHint: document.getElementById("aiHint"),
  message: document.getElementById("message"),
  email: document.getElementById("email"),
  outbox: document.getElementById("outbox"),
  queue: document.getElementById("queue"),
  settings: document.getElementById("settings"),
};

let state = null;
let activeTab = null;

function meetingIdFromUrl(url) {
  try {
    return new URL(url).pathname.match(/^\/([a-z]{3,4}-[a-z]{4}-[a-z]{3,4})/i)?.[1] || null;
  } catch {
    return null;
  }
}

function statusCopy(status) {
  const states = {
    idle: ["Ready", "Open a Google Meet to begin."],
    capturing: [
      status.source === "sippulse_ai" ? "High-quality capture active" : "Google captions active",
      status.source === "sippulse_ai"
        ? "Audio will be transcribed after the call."
        : "Start SipPulse AI for better accuracy.",
    ],
    processing: ["SipPulse AI is processing", "CRM storage and email are in progress."],
    delivered: ["Delivered", "Saved to CRM and sent for email delivery."],
    queued: ["Delivery queued", status.error || "SipPulse will retry automatically."],
    needs_attention: ["Delivery needs attention", status.error || "Retry from the outbox below."],
    disabled_for_call: ["Disabled for this call", "No transcript from this call will be delivered."],
  };
  return states[status.state] || ["Ready", "Open a Google Meet to begin."];
}

function renderQueue(queue) {
  elements.outbox.classList.toggle("hidden", queue.length === 0);
  elements.queue.replaceChildren();
  for (const item of queue) {
    const row = document.createElement("div");
    row.className = "queue-row";
    const label = document.createElement("span");
    label.textContent = `${item.deliveryKind} · ${item.lastError || "pending"}`;
    const retry = document.createElement("button");
    retry.textContent = "Retry";
    retry.addEventListener("click", () => queueAction("retry_queue_item", item.id));
    const discard = document.createElement("button");
    discard.textContent = "Discard";
    discard.className = "danger";
    discard.addEventListener("click", () => queueAction("discard_queue_item", item.id));
    row.append(label, retry, discard);
    elements.queue.append(row);
  }
}

async function refresh() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state = await chrome.runtime.sendMessage({ type: "get_popup_state" });
  if (!state?.ok) throw new Error(state?.error || "Status unavailable");

  elements.email.textContent = state.collaboratorEmail || "Company email unavailable";
  const [title, detail] = statusCopy(state.status);
  elements.status.textContent = title;
  elements.detail.textContent = detail;
  elements.dot.className = `dot dot--${state.status.state || "idle"}`;

  const inMeet = activeTab?.url?.startsWith("https://meet.google.com/");
  const activeMeetingId = meetingIdFromUrl(activeTab?.url);
  const meetingId = state.activeMeetingIds.includes(activeMeetingId)
    ? activeMeetingId
    : null;
  const aiActive = meetingId && state.aiMeetingIds.includes(meetingId);
  const validEmail = state.collaboratorEmail
    ?.toLowerCase()
    .endsWith("@sippulse.com");
  const canStartAi =
    state.consented &&
    validEmail &&
    state.config.captureEnabled &&
    state.config.preferredTranscription === "sippulse_ai" &&
    inMeet &&
    meetingId &&
    !aiActive;

  elements.setup.classList.toggle("hidden", state.consented && validEmail);
  elements.startAi.classList.toggle("hidden", !canStartAi);
  elements.aiHint.classList.toggle("hidden", !canStartAi);
  renderQueue(state.queue);
  if (canStartAi) {
    chrome.runtime.sendMessage({ type: "prepare_ai_capture" }).catch(() => {});
  }
}

async function startAiCapture() {
  const candidate = meetingIdFromUrl(activeTab?.url);
  const meetingId = state?.activeMeetingIds?.includes(candidate) ? candidate : null;
  if (!meetingId || !activeTab?.id) return;
  elements.startAi.disabled = true;
  elements.message.textContent = "Requesting audio access…";

  try {
    // This must be the first awaited operation in the click handler so Chrome
    // can associate tabCapture with the user's action.
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: activeTab.id,
    });
    await chrome.runtime.sendMessage({ type: "prepare_ai_capture" });
    const result = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "ai_capture_start",
      streamId,
      meetingId,
    });
    if (!result?.ok) throw new Error(result?.error || "Audio capture failed");
    await chrome.runtime.sendMessage({ type: "ai_capture_started", meetingId });
    elements.message.textContent = "SipPulse AI capture started.";
    await refresh();
  } catch (error) {
    elements.message.textContent = error.message || String(error);
    elements.startAi.disabled = false;
  }
}

async function queueAction(type, id) {
  elements.message.textContent = type.startsWith("retry") ? "Retrying…" : "Discarding…";
  const result = await chrome.runtime.sendMessage({ type, id });
  elements.message.textContent = result?.ok ? "Done." : result?.error || "Action failed";
  await refresh();
}

elements.startAi.addEventListener("click", startAiCapture);
elements.setup.addEventListener("click", () => chrome.runtime.openOptionsPage());
elements.settings.addEventListener("click", () => chrome.runtime.openOptionsPage());

refresh().catch((error) => {
  elements.status.textContent = "Status unavailable";
  elements.detail.textContent = error.message;
});
