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
  lastTranscript: document.getElementById("lastTranscript"),
  lastTranscriptLabel: document.getElementById("lastTranscriptLabel"),
  downloadMd: document.getElementById("downloadMd"),
  downloadVcon: document.getElementById("downloadVcon"),
  settings: document.getElementById("settings"),
};

const MICROPHONE_PAGE = "src/permissions/microphone.html";
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
      status.source === "sippulse_ai_live" ? "Live transcription on" : "Google captions active",
      status.source === "sippulse_ai_live"
        ? "Transcript and AI notes update live in the Meet panel."
        : "Start live transcription for accuracy, speaker names, and AI notes.",
    ],
    finalizing: ["Preparing the meeting report", "Keep Chrome open for a minute while the report is written."],
    delivered: ["Delivered", "Saved to CRM and sent for email delivery."],
    queued: ["Delivery queued", status.error || "SipPulse will retry automatically."],
    needs_attention: ["Delivery needs attention", status.error || "Retry from the outbox below."],
    disabled_for_call: ["Discarded", "Nothing from that call was delivered."],
  };
  return states[status.state] || ["Ready", "Open a Google Meet to begin."];
}

function downloadText(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function downloadDocument(document_, format) {
  const base = `sippulse-meet-${document_.uuid || "transcript"}`;
  if (format === "md") {
    downloadText(`${base}.md`, self.MeetVcon.vcon.toMarkdown(document_), "text/markdown");
  } else {
    downloadText(`${base}.vcon.json`, JSON.stringify(document_, null, 2), "application/vcon+json");
  }
}

function renderQueue(queue) {
  elements.outbox.classList.toggle("hidden", queue.length === 0);
  elements.queue.replaceChildren();
  for (const item of queue) {
    const row = document.createElement("div");
    row.className = "queue-row";
    const label = document.createElement("span");
    const when = item.state === "queued" && item.nextAttemptAt
      ? `retry ${new Date(item.nextAttemptAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "needs attention";
    label.textContent = `${item.subject || item.deliveryKind} · ${item.lastError || "pending"} · ${when}`;
    const retry = document.createElement("button");
    retry.textContent = "Retry";
    retry.addEventListener("click", () => queueAction("retry_queue_item", item.id));
    const download = document.createElement("button");
    download.textContent = "Download";
    download.addEventListener("click", async () => {
      const result = await chrome.runtime.sendMessage({ type: "get_queue_item_document", id: item.id });
      if (result?.ok) downloadDocument(result.document, "md");
      else elements.message.textContent = result?.error || "Download failed";
    });
    const discard = document.createElement("button");
    discard.textContent = "Discard";
    discard.className = "danger";
    discard.addEventListener("click", () => queueAction("discard_queue_item", item.id));
    row.append(label, retry, download, discard);
    elements.queue.append(row);
  }
}

function renderLastTranscript(meta) {
  elements.lastTranscript.classList.toggle("hidden", !meta);
  if (!meta) return;
  const when = new Date(meta.savedAt).toLocaleString();
  const kind = meta.hasReport
    ? "transcript + report"
    : meta.source?.startsWith("sippulse_ai_live")
    ? "live transcript"
    : "Google captions copy";
  elements.lastTranscriptLabel.textContent = `${meta.subject || "Meeting"} · ${when} · ${kind}`;
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
  const meetingId = state.activeMeetingIds.includes(activeMeetingId) ? activeMeetingId : null;
  const aiActive = meetingId && state.aiMeetingIds.includes(meetingId);
  const validEmail = !!state.collaboratorAuthorized;
  const canStartAi =
    state.consented &&
    validEmail &&
    state.config.configured &&
    state.config.captureEnabled &&
    state.config.liveTranscriptionReady &&
    inMeet &&
    meetingId &&
    !aiActive;

  elements.setup.classList.toggle("hidden", state.consented && validEmail);
  elements.startAi.classList.toggle("hidden", !canStartAi);
  elements.aiHint.classList.toggle("hidden", !canStartAi);
  renderQueue(state.queue);
  renderLastTranscript(state.lastTranscript);
}

async function microphonePermission() {
  try {
    const status = await navigator.permissions.query({ name: "microphone" });
    return status.state;
  } catch {
    return "prompt";
  }
}

async function openMicrophonePage() {
  await chrome.tabs.create({ url: chrome.runtime.getURL(MICROPHONE_PAGE) });
}

async function startAiCapture() {
  const candidate = meetingIdFromUrl(activeTab?.url);
  const meetingId = state?.activeMeetingIds?.includes(candidate) ? candidate : null;
  if (!meetingId || !activeTab?.id) return;
  elements.startAi.disabled = true;

  try {
    if ((await microphonePermission()) !== "granted") {
      elements.message.textContent =
        "Allow microphone access in the new tab, then return to Meet and start again.";
      await openMicrophonePage();
      return;
    }
    elements.message.textContent = "Requesting audio access…";
    // The worker obtains the tab stream ID itself: IDs issued to the popup
    // cannot be redeemed by the offscreen recorder.
    const result = await chrome.runtime.sendMessage({
      type: "start_ai_capture",
      meetingId,
      tabId: activeTab.id,
    });
    if (!result?.ok) {
      if (result?.code === "microphone_permission") {
        elements.message.textContent = "Microphone access is required. Allow it in the new tab.";
        await openMicrophonePage();
        return;
      }
      throw new Error(result?.error || "Audio capture failed");
    }
    elements.message.textContent = "Live transcription started. Follow it in the Meet panel.";
    await refresh();
  } catch (error) {
    elements.message.textContent = error.message || String(error);
  } finally {
    elements.startAi.disabled = false;
  }
}

async function queueAction(type, id) {
  elements.message.textContent = type.startsWith("retry") ? "Retrying…" : "Discarding…";
  const result = await chrome.runtime.sendMessage({ type, id });
  elements.message.textContent = result?.ok ? "Done." : result?.error || "Action failed";
  await refresh();
}

async function downloadLast(format) {
  const result = await chrome.runtime.sendMessage({ type: "get_last_transcript" });
  if (!result?.ok || !result.document) {
    elements.message.textContent = result?.error || "No transcript stored locally";
    return;
  }
  downloadDocument(result.document, format);
}

elements.startAi.addEventListener("click", startAiCapture);
elements.setup.addEventListener("click", () => chrome.runtime.openOptionsPage());
elements.settings.addEventListener("click", () => chrome.runtime.openOptionsPage());
elements.downloadMd.addEventListener("click", () => downloadLast("md"));
elements.downloadVcon.addEventListener("click", () => downloadLast("vcon"));

refresh().catch((error) => {
  elements.status.textContent = "Status unavailable";
  elements.detail.textContent = error.message;
});
