// Chrome side panel: the whole in-call interface. The Meet page keeps no UI of
// its own; it pushes snapshots over a port (src/content/panel-bridge.js) and
// this document renders them through the shared model (src/lib/panel-model.js).
// Every transcript and model string is written with textContent.

const { panelModel } = self.MeetVcon;

const PORT_NAME = "meetvcon-panel";
const MICROPHONE_PAGE = "src/permissions/microphone.html";
const MEET_URL = "https://meet.google.com/";
const TICK_MS = 2_000;
const WORKER_MS = 10_000;

const elements = {
  dot: document.getElementById("dot"),
  status: document.getElementById("status"),
  settings: document.getElementById("settings"),
  primary: document.getElementById("primary"),
  message: document.getElementById("message"),
  tabs: document.getElementById("tabs"),
  body: document.getElementById("body"),
  consent: document.getElementById("consent"),
};

let tab = null;
let port = null;
let snapshot = null;
// What the worker knows and the Meet page does not: whether the extension is
// configured at all.
let worker = null;
let activeTab = "transcript";
let pinned = true;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---- connection -------------------------------------------------------------

function connect() {
  port = null;
  snapshot = null;
  if (tab?.id) {
    port = chrome.tabs.connect(tab.id, { name: PORT_NAME });
    port.onMessage.addListener((message) => {
      snapshot = message.snapshot;
      render();
    });
    port.onDisconnect.addListener(() => {
      // No content script there yet, or the tab reloaded: the tick reconnects.
      void chrome.runtime.lastError;
      port = null;
      snapshot = null;
      render();
    });
  }
  render();
}

// One timer covers everything that can change behind our back: which tab is in
// front, and whether its content script is listening.
async function tick() {
  const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
  const next = current?.url?.startsWith(MEET_URL) ? current : null;
  const changed = next?.id !== tab?.id;
  tab = next;
  if (changed || (tab && !port)) connect();
}

async function refreshWorker() {
  worker = await chrome.runtime.sendMessage({ type: "get_popup_state" }).catch(() => null);
  render();
}

// The missing piece, in the panel's own words, whether or not a call is running.
function configError() {
  if (!worker?.ok) return "";
  if (!worker.config.configured) return worker.config.error || "The extension is not configured yet";
  if (!worker.config.captureEnabled) return "Capture is switched off by your administrator";
  if (worker.config.transcriptionSource === "google_captions") return "";
  if (!worker.config.liveTranscriptionReady) return "The SipPulse AI key is not set, so only Google captions are captured";
  return "";
}

// ---- actions ----------------------------------------------------------------

async function startLive(button) {
  button.disabled = true;
  try {
    const microphone = await navigator.permissions.query({ name: "microphone" }).catch(() => null);
    if (microphone?.state !== "granted") {
      elements.message.textContent = "Allow microphone access in the new tab, then start again.";
      await chrome.tabs.create({ url: chrome.runtime.getURL(MICROPHONE_PAGE) });
      return;
    }
    elements.message.textContent = "Requesting audio access…";
    // The worker obtains the tab stream ID itself: IDs issued to this page
    // cannot be redeemed by the offscreen recorder.
    const result = await chrome.runtime.sendMessage({
      type: "start_ai_capture",
      meetingId: snapshot.meetingId,
      tabId: tab.id,
    });
    if (!result?.ok && result?.code === "microphone_permission") {
      elements.message.textContent = "Microphone access is required. Allow it in the new tab.";
      await chrome.tabs.create({ url: chrome.runtime.getURL(MICROPHONE_PAGE) });
      return;
    }
    elements.message.textContent = result?.ok ? "Live transcription started." : result?.error || "Audio capture failed";
    await refreshWorker();
  } finally {
    button.disabled = false;
  }
}

// Stops the audio, keeps the transcript. Starting again continues the same one.
async function stopLive(button) {
  button.disabled = true;
  elements.message.textContent = "Stopping…";
  const result = await chrome.runtime.sendMessage({
    type: "stop_ai_capture",
    meetingId: snapshot.meetingId,
  });
  elements.message.textContent = result?.ok
    ? "Live transcription stopped. Start it again to continue this transcript."
    : result?.error || "Could not stop";
  button.disabled = false;
  await refreshWorker();
}

function button(className, label, onClick) {
  const node = el("button", className, label);
  node.type = "button";
  node.addEventListener("click", () => onClick(node));
  return node;
}

// ---- views ------------------------------------------------------------------

function renderPrimary(model) {
  elements.primary.replaceChildren();
  if (model.canStart) {
    const resuming = (snapshot?.utterances || []).length > 0;
    elements.primary.append(
      button("btn btn--primary", resuming ? "Resume live transcription" : "Start live transcription", startLive)
    );
    elements.primary.append(
      el("p", "hint", "Streams this tab's audio and your microphone for an accurate, speaker-labelled transcript.")
    );
  }
  if (model.canStop) {
    elements.primary.append(button("btn", "Stop live transcription", stopLive));
  }
  if (model.action) {
    const discard = model.action.id === "discard";
    elements.primary.append(
      button(`btn${discard ? " btn--danger" : ""}`, model.action.label, () => {
        if (discard) port?.postMessage({ type: "discard" });
        else chrome.runtime.openOptionsPage();
      })
    );
  }
}

function renderTabs() {
  elements.tabs.replaceChildren();
  for (const [id, label] of panelModel.TABS) {
    const node = button(`tab${id === activeTab ? " tab--active" : ""}`, label, () => {
      activeTab = id;
      pinned = true;
      render();
    });
    node.setAttribute("role", "tab");
    node.setAttribute("aria-selected", String(id === activeTab));
    elements.tabs.append(node);
  }
}

function renderTranscript(view) {
  if (view.empty) elements.body.append(el("p", "empty", view.empty));
  if (view.source) elements.body.append(el("p", "muted", view.source));
  for (const line of view.lines) {
    const node = el("div", `line${line.interim ? " line--interim" : ""}`);
    if (line.speaker) {
      const who = el("div", "who");
      who.append(el("span", "speaker", line.speaker));
      if (line.time) who.append(el("span", "time", line.time));
      node.append(who);
    }
    const text = el("div", "text", line.text);
    for (const tag of line.tags) text.append(el("span", `tag tag--${tag.kind}`, tag.label));
    node.append(text);
    elements.body.append(node);
  }
}

function renderNotes(view) {
  if (view.empty) elements.body.append(el("p", "empty", view.empty));
  if (view.error) elements.body.append(el("p", "muted", view.error));
  if (view.summary) elements.body.append(el("h4", "h", "Summary"), el("p", "summary", view.summary));
  for (const section of view.sections) {
    elements.body.append(el("h4", "h", section.title));
    const list = el("ul", "list");
    for (const item of section.items) list.append(el("li", "", item));
    elements.body.append(list);
  }
  if (view.updated) elements.body.append(el("p", "muted", view.updated));
}

function renderSpeakers(view) {
  if (view.empty) elements.body.append(el("p", "empty", view.empty));
  for (const row of view.rows) {
    const node = el("div", "speaker-row");
    const top = el("div", "speaker-top");
    top.append(el("span", "speaker", row.speaker), el("span", "time", row.right));
    const fill = el("div", `bar-fill${row.mood ? ` bar-fill--${row.mood}` : ""}`);
    fill.style.width = `${row.percent}%`;
    const bar = el("div", "bar");
    bar.append(fill);
    node.append(top, bar);
    node.title = row.title;
    elements.body.append(node);
  }
}

function render() {
  const problem = configError();
  if (!tab && !problem) {
    elements.dot.className = "dot dot--grey";
    elements.status.textContent = "Open a Google Meet to begin";
    elements.primary.replaceChildren();
    elements.body.replaceChildren();
    elements.tabs.hidden = elements.body.hidden = true;
    elements.consent.textContent = "";
    return;
  }
  const model = panelModel.build({
    ...(snapshot || { status: tab && port ? "idle" : "state_unavailable" }),
    configError: problem,
    liveReady: worker?.ok ? worker.config.liveTranscriptionReady : undefined,
    captionsMode: worker?.ok && worker.config.transcriptionSource === "google_captions",
  });
  elements.dot.className = `dot dot--${model.header.tone}`;
  elements.status.textContent = model.header.text;
  elements.consent.textContent = model.consent;
  renderPrimary(model);
  elements.tabs.hidden = elements.body.hidden = !model.showViews;
  if (!model.showViews) return;

  renderTabs();
  const wasPinned = pinned;
  const scrollTop = elements.body.scrollTop;
  elements.body.replaceChildren();
  if (activeTab === "notes") renderNotes(model.notes);
  else if (activeTab === "speakers") renderSpeakers(model.speakers);
  else renderTranscript(model.transcript);
  elements.body.scrollTop = activeTab === "transcript" && wasPinned ? elements.body.scrollHeight : scrollTop;
}

elements.body.addEventListener("scroll", () => {
  pinned = elements.body.scrollHeight - elements.body.scrollTop - elements.body.clientHeight < 24;
});
elements.settings.addEventListener("click", () => chrome.runtime.openOptionsPage());

setInterval(tick, TICK_MS);
setInterval(refreshWorker, WORKER_MS);
tick();
refreshWorker();
