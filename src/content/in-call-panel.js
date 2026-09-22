// Visible consent, capture control, and live meeting view inside Google Meet:
// a live transcript with inline intent tags (Jev), AI notes (summary, action
// items, topics), and speaker talk time with sentiment. All transcript and model text is written
// with textContent, never innerHTML.

(function () {
  const ns = (window.MeetVcon = window.MeetVcon || {});
  if (ns.inCallPanel) return;

  const { transcription, classification } = ns;
  const ACTION_ITEM_THRESHOLD = 0.7;
  const INTENT_LABELS = {
    commitment: "commitment",
    decision: "decision",
    question: "question",
    objection: "objection",
    purchase_interest: "buying signal",
    problem_report: "problem",
    scheduling: "scheduling",
  };
  const PANEL_ID = "meetvcon-panel";
  const MAX_LINES = 300;
  const TABS = [
    ["transcript", "Transcript"],
    ["notes", "Notes"],
    ["speakers", "Speakers"],
  ];

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
  let activeTab = "transcript";
  let collapsed = false;
  let renderQueued = false;
  let refreshTimer = null;
  let unsubscribe = [];
  let dom = null;

  const STATES = {
    active: ["meetvcon-dot--green", "Capturing Google captions"],
    enabling: ["meetvcon-dot--amber", "Enabling Google captions…"],
    discarded: ["meetvcon-dot--grey", "Stopped. Nothing from this call will be delivered"],
    setup_required: ["meetvcon-dot--amber", "Consent is required before capture"],
    identity_required: ["meetvcon-dot--amber", "Sign in to Chrome with an allowed account"],
    managed_disabled: ["meetvcon-dot--grey", "Capture is not configured yet"],
    state_unavailable: ["meetvcon-dot--grey", "The extension could not be reached; reload the tab"],
    capture_error: ["meetvcon-dot--grey", "Capture could not start"],
    idle: ["meetvcon-dot--grey", "Waiting for the meeting"],
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function capturing() {
    return currentStatus === "active" || currentStatus === "enabling";
  }

  function statusLine() {
    if (audioActive && capturing()) {
      const stream = ns.transcriptCapture?.getLive?.().status?.transcription_status;
      if (stream?.state === "reconnecting" || stream?.state === "error") {
        return ["meetvcon-dot--amber", "Reconnecting to live transcription…"];
      }
      return ["meetvcon-dot--red", "Live transcription on (tab audio + microphone)"];
    }
    return STATES[currentStatus] || STATES.capture_error;
  }

  function actionFor() {
    if (capturing()) return ["discard", "Stop and discard this call"];
    if (["setup_required", "identity_required", "managed_disabled"].includes(currentStatus)) {
      return ["setup", "Review setup"];
    }
    return null;
  }

  // ---- data ----------------------------------------------------------------

  function liveUtterances() {
    const capture = ns.transcriptCapture;
    const live = capture?.getLive?.();
    if (live?.streamStartedAt && live.segments.length) {
      return transcription.toUtterances(live.segments, {
        streamStartedAt: live.streamStartedAt,
        captions: capture.getCaptionUtterances(),
        collaborator,
      });
    }
    return capture?.getCaptionUtterances?.() || [];
  }

  function meetingStart() {
    return ns.transcriptCapture?.getMeeting?.()?.startedAt;
  }

  function classifications() {
    return ns.transcriptCapture?.getLive?.().classifications || {};
  }

  function classificationSummary(utterances) {
    return classification.summarize(utterances, classifications(), {
      meetingStartedAt: meetingStart(),
      clock: transcription.clock,
    });
  }

  function tagsFor(utterance) {
    const entry = classifications()[utterance.segment_id];
    if (!entry) return null;
    const tags = el("span", "meetvcon-tags");
    if (classification.NOTABLE.has(entry.intent) && entry.intent_confidence >= 0.6) {
      tags.append(el("span", `meetvcon-tag meetvcon-tag--${entry.intent}`, INTENT_LABELS[entry.intent]));
    }
    if (entry.action_item >= ACTION_ITEM_THRESHOLD && entry.intent !== "commitment") {
      tags.append(el("span", "meetvcon-tag meetvcon-tag--commitment", "action item"));
    }
    const mood = classification.sentimentLabel(entry.sentiment);
    if (mood !== "neutral") tags.append(el("span", `meetvcon-tag meetvcon-tag--${mood}`, mood));
    return tags.childElementCount ? tags : null;
  }

  // ---- skeleton --------------------------------------------------------------

  function build() {
    const panel = el("aside", "meetvcon-panel");
    panel.id = PANEL_ID;
    panel.setAttribute("aria-label", "SipPulse Meet Capture");

    const header = el("div", "meetvcon-header");
    const dot = el("span", "meetvcon-dot");
    const titles = el("div", "meetvcon-titles");
    const title = el("span", "meetvcon-title", "SipPulse Meet Capture");
    const status = el("span", "meetvcon-status");
    status.setAttribute("aria-live", "polite");
    titles.append(title, status);
    const toggle = el("button", "meetvcon-icon-btn", "–");
    toggle.type = "button";
    toggle.addEventListener("click", () => {
      collapsed = !collapsed;
      render();
    });
    header.append(dot, titles, toggle);

    const tabs = el("div", "meetvcon-tabs");
    tabs.setAttribute("role", "tablist");
    const tabButtons = {};
    for (const [id, label] of TABS) {
      const button = el("button", "meetvcon-tab", label);
      button.type = "button";
      button.setAttribute("role", "tab");
      button.addEventListener("click", () => {
        activeTab = id;
        render();
      });
      tabButtons[id] = button;
      tabs.append(button);
    }

    const body = el("div", "meetvcon-body");
    const footer = el("div", "meetvcon-footer");
    const consent = el("div", "meetvcon-consent");
    const actions = el("div", "meetvcon-actions");
    footer.append(consent, actions);

    panel.append(header, tabs, body, footer);
    document.body.appendChild(panel);
    dom = { panel, dot, status, toggle, tabs, tabButtons, body, consent, actions, pinned: true };
    body.addEventListener("scroll", () => {
      dom.pinned = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    });
  }

  // ---- views -----------------------------------------------------------------

  function renderTranscript(container) {
    const utterances = liveUtterances();
    const base = Date.parse(meetingStart() || utterances[0]?.start);
    if (!utterances.length) {
      container.append(
        el(
          "p",
          "meetvcon-empty",
          audioActive
            ? "Listening… the transcript appears as people speak."
            : "No speech captured yet. For live transcription and AI notes, click the SipPulse extension button and start live transcription."
        )
      );
    }
    let previous = null;
    for (const utterance of utterances.slice(-MAX_LINES)) {
      const line = el("div", "meetvcon-line");
      if (utterance.speaker !== previous) {
        const who = el("div", "meetvcon-who");
        who.append(el("span", "meetvcon-speaker", utterance.speaker));
        const offset = (Date.parse(utterance.start) - base) / 1000;
        if (Number.isFinite(offset)) who.append(el("span", "meetvcon-time", transcription.clock(offset)));
        line.append(who);
      }
      const text = el("div", "meetvcon-text", utterance.text);
      const tags = tagsFor(utterance);
      if (tags) text.append(tags);
      line.append(text);
      container.append(line);
      previous = utterance.speaker;
    }
    const interim = ns.transcriptCapture?.getLive?.().interim || {};
    for (const [channel, text] of Object.entries(interim)) {
      if (!text) continue;
      const line = el("div", "meetvcon-line meetvcon-line--interim");
      const label = Number(channel) === transcription.MIC_CHANNEL ? transcription.displayNameFromEmail(collaborator?.email) : "…";
      line.append(el("div", "meetvcon-text", `${label}: ${text}`));
      container.append(line);
    }
  }

  function section(container, title, items, format) {
    if (!items?.length) return;
    container.append(el("h4", "meetvcon-h", title));
    const list = el("ul", "meetvcon-list");
    for (const item of items) list.append(el("li", "", format(item)));
    container.append(list);
  }

  function renderIntents(container) {
    const { intents } = classificationSummary(liveUtterances());
    section(container, "Intents", intents.slice(-12), (i) =>
      `${i.at ? `${i.at} · ` : ""}${i.speaker}: ${INTENT_LABELS[i.intent] || i.intent} — ${i.detail}`
    );
  }

  function renderNotes(container) {
    const live = ns.transcriptCapture?.getLive?.();
    const notes = live?.analysis;
    if (!notes) {
      const message = !audioActive
        ? "AI notes need live transcription. Click the SipPulse extension button to start it."
        : !analysisEnabled
        ? "AI notes are not configured. The transcript is still captured."
        : liveAnalysis
        ? "Notes appear about a minute after people start talking."
        : "Notes, action items and intents are written when the call ends, and go to the vCon and your email.";
      container.append(el("p", "meetvcon-empty", message));
      const error = live?.status?.analysis_status?.error;
      if (error && audioActive) container.append(el("p", "meetvcon-muted", `Last attempt: ${error}`));
      if (classificationEnabled && liveAnalysis) renderIntents(container);
      return;
    }
    if (notes.summary) {
      container.append(el("h4", "meetvcon-h", "Summary"));
      container.append(el("p", "meetvcon-summary", notes.summary));
    }
    section(container, "Action items", notes.action_items, (a) =>
      `${a.task}${a.owner ? ` — ${a.owner}` : ""}${a.due ? ` (${a.due})` : ""}`
    );
    section(container, "Key points", notes.key_points, (p) => p);
    section(container, "Decisions", notes.decisions, (d) => d);
    section(container, "Topics", notes.topics, (t) => `${t.start ? `${t.start} · ` : ""}${t.title}`);
    renderIntents(container);
    section(container, "Open questions", notes.open_questions, (q) => q);
    if (live.analysisAt) {
      const at = new Date(live.analysisAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      container.append(el("p", "meetvcon-muted", `Updated ${at} · refreshes every minute`));
    }
  }

  function renderSpeakers(container) {
    const utterances = liveUtterances();
    const stats = transcription.speakerStats(utterances);
    if (!stats.length) {
      container.append(el("p", "meetvcon-empty", "Talk time appears once people speak."));
      return;
    }
    const sentiment = new Map(classificationSummary(utterances).sentiment.map((entry) => [entry.speaker, entry]));
    for (const entry of stats) {
      const row = el("div", "meetvcon-speaker-row");
      const top = el("div", "meetvcon-speaker-top");
      top.append(el("span", "meetvcon-speaker", entry.speaker));
      const mood = sentiment.get(entry.speaker);
      const share = `${Math.round(entry.talk_share * 100)}%`;
      top.append(el("span", "meetvcon-time", mood ? `${share} · ${mood.label}` : share));
      const bar = el("div", "meetvcon-bar");
      const fill = el("div", `meetvcon-bar-fill${mood ? ` meetvcon-bar-fill--${mood.label}` : ""}`);
      fill.style.width = share;
      bar.append(fill);
      row.append(top, bar);
      row.title = `${Math.round(entry.talk_seconds)} s talking · ${entry.turns} turns · ${entry.words_per_minute} wpm`;
      container.append(row);
    }
  }

  // ---- render ----------------------------------------------------------------

  function render() {
    renderQueued = false;
    if (!dom || !document.body.contains(dom.panel)) build();
    const [dotClass, statusText] = statusLine();
    dom.dot.className = `meetvcon-dot ${dotClass}`;
    dom.status.textContent = statusDetail ? `${statusText} — ${statusDetail}` : statusText;
    dom.panel.classList.toggle("meetvcon-panel--collapsed", collapsed);
    dom.toggle.textContent = collapsed ? "+" : "–";
    dom.toggle.setAttribute("aria-label", collapsed ? "Expand panel" : "Collapse panel");

    const showViews = capturing() || audioActive;
    dom.tabs.hidden = !showViews;
    dom.body.hidden = !showViews;
    for (const [id, button] of Object.entries(dom.tabButtons)) {
      button.classList.toggle("meetvcon-tab--active", id === activeTab);
      button.setAttribute("aria-selected", String(id === activeTab));
    }
    if (showViews && !collapsed) {
      const pinned = dom.pinned;
      const scrollTop = dom.body.scrollTop;
      dom.body.replaceChildren();
      if (activeTab === "notes") renderNotes(dom.body);
      else if (activeTab === "speakers") renderSpeakers(dom.body);
      else renderTranscript(dom.body);
      dom.body.scrollTop = activeTab === "transcript" && pinned ? dom.body.scrollHeight : scrollTop;
    }

    dom.consent.textContent = audioActive
      ? "Audio is transcribed live, notes are written by SipPulse AI, and each line is classified by TypeSafe. The transcript goes to your organization's vCon store and your email."
      : "Transcript goes to your organization's vCon store and the collaborator's email.";
    const action = actionFor();
    dom.actions.replaceChildren();
    if (action) {
      const button = el("button", "meetvcon-btn", action[1]);
      button.type = "button";
      button.addEventListener("click", async () => {
        button.disabled = true;
        if (action[0] === "discard") await handlers.onDiscard?.();
        else handlers.onOpenSetup?.();
      });
      dom.actions.append(button);
    }
  }

  // Coalesce bursts of transcript updates into one paint.
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  }

  // Terminal states (discarded, prerequisites) must not be overwritten by
  // later captions-watchdog status changes.
  function lock(status, detail = "") {
    locked = true;
    currentStatus = status;
    statusDetail = detail;
    render();
  }

  function onWatchdogStatus(status) {
    if (locked) return;
    currentStatus = status;
    statusDetail = "";
    scheduleRender();
  }

  function setAudioActive(active, options = {}) {
    audioActive = !!active;
    if ("analysisEnabled" in options) analysisEnabled = !!options.analysisEnabled;
    if ("liveAnalysis" in options) liveAnalysis = !!options.liveAnalysis;
    if ("classificationEnabled" in options) classificationEnabled = !!options.classificationEnabled;
    if (document.getElementById(PANEL_ID)) scheduleRender();
  }

  function init(nextHandlers = {}) {
    handlers = nextHandlers;
    collaborator = nextHandlers.collaborator || null;
    locked = false;
    audioActive = false;
    currentStatus = "idle";
    statusDetail = "";
    unsubscribe.forEach((fn) => fn());
    unsubscribe = [
      ns.captionsWatchdog.onStatusChange(onWatchdogStatus),
      ns.transcriptCapture.onLiveChange(scheduleRender),
    ];
    // Caption-only mode has no push events; repaint periodically.
    if (!refreshTimer) refreshTimer = setInterval(scheduleRender, 2_000);
    render();
  }

  function destroy() {
    clearInterval(refreshTimer);
    refreshTimer = null;
    unsubscribe.forEach((fn) => fn());
    unsubscribe = [];
    locked = false;
    audioActive = false;
    document.getElementById(PANEL_ID)?.remove();
    dom = null;
  }

  ns.inCallPanel = { init, destroy, render, lock, setAudioActive };
})();
