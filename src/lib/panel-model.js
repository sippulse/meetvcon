// What the side panel shows, as plain data. The Meet page owns the live
// transcript; it serializes a snapshot (src/content/panel-bridge.js) and the
// side panel (src/sidepanel/) turns this model into DOM. Keeping the decisions
// here — which status, which tags, which sections, what to say when a view is
// empty — means they are unit tested without a browser, and the renderer only
// has to append nodes.

(function (root) {
  const ns = (root.MeetVcon = root.MeetVcon || {});
  if (ns.panelModel) return;

  const { transcription, classification } = ns;

  const ACTION_ITEM_THRESHOLD = 0.7;
  const MAX_LINES = 300;
  const INTENT_LABELS = {
    commitment: "commitment",
    decision: "decision",
    question: "question",
    objection: "objection",
    purchase_interest: "buying signal",
    problem_report: "problem",
    scheduling: "scheduling",
  };
  const TABS = [
    ["transcript", "Transcript"],
    ["notes", "Notes"],
    ["speakers", "Speakers"],
  ];

  const STATES = {
    active: ["green", "Capturing Google captions"],
    enabling: ["amber", "Enabling Google captions…"],
    discarded: ["grey", "Stopped. Nothing from this call will be delivered"],
    setup_required: ["amber", "Consent is required before capture"],
    identity_required: ["amber", "Sign in to Chrome with an allowed account"],
    managed_disabled: ["grey", "Capture is not configured yet"],
    state_unavailable: ["grey", "The extension could not be reached; reload the tab"],
    capture_error: ["grey", "Capture could not start"],
    idle: ["grey", "Waiting for the meeting"],
  };

  const list = (value) => (Array.isArray(value) ? value : []);

  function capturing(status) {
    return status === "active" || status === "enabling";
  }

  function header(snapshot) {
    // A missing key or endpoint is worth saying before the meeting starts, not
    // after someone waits for a transcript that was never going to come.
    if (snapshot.configError) return { tone: "amber", text: snapshot.configError };
    if (snapshot.audioActive && capturing(snapshot.status)) {
      const stream = snapshot.transcriptionState;
      if (stream === "reconnecting" || stream === "error") {
        return { tone: "amber", text: "Reconnecting to live transcription…" };
      }
      return { tone: "red", text: "Live transcription on (tab audio + microphone)" };
    }
    const [tone, text] = STATES[snapshot.status] || STATES.capture_error;
    return { tone, text: snapshot.statusDetail ? `${text} — ${snapshot.statusDetail}` : text };
  }

  function action(snapshot) {
    if (snapshot.configError) return { id: "setup", label: "Open settings" };
    if (capturing(snapshot.status)) return { id: "discard", label: "Stop and discard this call" };
    if (["setup_required", "identity_required", "managed_disabled"].includes(snapshot.status)) {
      return { id: "setup", label: "Review setup" };
    }
    return null;
  }

  function tagsFor(entry) {
    const tags = [];
    if (!entry) return tags;
    if (classification.NOTABLE.has(entry.intent) && entry.intent_confidence >= 0.6) {
      tags.push({ kind: entry.intent, label: INTENT_LABELS[entry.intent] || entry.intent });
    }
    if (entry.action_item >= ACTION_ITEM_THRESHOLD && entry.intent !== "commitment") {
      tags.push({ kind: "commitment", label: "action item" });
    }
    const mood = classification.sentimentLabel(entry.sentiment);
    if (mood !== "neutral") tags.push({ kind: mood, label: mood });
    return tags;
  }

  function transcriptView(snapshot) {
    const utterances = list(snapshot.utterances);
    const base = Date.parse(snapshot.meetingStartedAt || utterances[0]?.start);
    const lines = [];
    let previous = null;
    for (const utterance of utterances.slice(-MAX_LINES)) {
      const offset = (Date.parse(utterance.start) - base) / 1000;
      lines.push({
        // Only the first line of a turn repeats the name.
        speaker: utterance.speaker === previous ? null : utterance.speaker,
        time: utterance.speaker === previous || !Number.isFinite(offset) ? "" : transcription.clock(offset),
        text: utterance.text,
        tags: tagsFor((snapshot.classifications || {})[utterance.segment_id]),
        interim: false,
      });
      previous = utterance.speaker;
    }
    for (const [channel, text] of Object.entries(snapshot.interim || {})) {
      if (!text) continue;
      const who =
        Number(channel) === transcription.MIC_CHANNEL
          ? transcription.displayNameFromEmail(snapshot.collaborator?.email)
          : "…";
      lines.push({ speaker: null, time: "", text: `${who}: ${text}`, tags: [], interim: true });
    }
    return {
      empty: lines.length
        ? ""
        : snapshot.audioActive
        ? "Listening… the transcript appears as people speak."
        : "No speech captured yet. Start live transcription for accuracy, speaker names, and AI notes.",
      lines,
    };
  }

  function intentSection(snapshot) {
    const { intents } = classification.summarize(list(snapshot.utterances), snapshot.classifications || {}, {
      meetingStartedAt: snapshot.meetingStartedAt,
      clock: transcription.clock,
    });
    if (!intents.length) return null;
    return {
      title: "Intents",
      items: intents
        .slice(-12)
        .map(
          (i) =>
            `${i.at ? `${i.at} · ` : ""}${i.speaker}: ${INTENT_LABELS[i.intent] || i.intent} — ${i.detail}`
        ),
    };
  }

  function section(title, items, format) {
    const rows = list(items).map(format).filter(Boolean);
    return rows.length ? { title, items: rows } : null;
  }

  function notesView(snapshot) {
    const notes = snapshot.analysis;
    if (!notes) {
      const message = !snapshot.audioActive
        ? "AI notes need live transcription. Start it above."
        : !snapshot.analysisEnabled
        ? "AI notes are not configured. The transcript is still captured."
        : snapshot.liveAnalysis
        ? "Notes appear about a minute after people start talking."
        : "Notes, action items and intents are written when the call ends, and go to the vCon and your email.";
      const sections = [];
      if (snapshot.classificationEnabled && snapshot.liveAnalysis) {
        const intents = intentSection(snapshot);
        if (intents) sections.push(intents);
      }
      return {
        empty: message,
        error: snapshot.audioActive && snapshot.analysisError ? `Last attempt: ${snapshot.analysisError}` : "",
        summary: "",
        sections,
        updated: "",
      };
    }
    const sections = [
      section("Action items", notes.action_items, (a) =>
        a?.task ? `${a.task}${a.owner ? ` — ${a.owner}` : ""}${a.due ? ` (${a.due})` : ""}` : ""
      ),
      notes.next_step ? { title: "Next step", items: [notes.next_step] } : null,
      section("Key points", notes.key_points, (p) => p),
      // Decisions were plain strings before the report carried a rationale.
      section("Decisions", notes.decisions, (d) =>
        typeof d === "string" ? d : d?.decision ? `${d.decision}${d.rationale ? ` (${d.rationale})` : ""}` : ""
      ),
      section("Figures", notes.numbers, (n) =>
        n?.value ? `${n.value} — ${n.label}${n.context ? ` (${n.context})` : ""}` : ""
      ),
      section("Risks and objections", notes.risks, (r) => r),
      section("Topics", notes.topics, (t) => (t?.title ? `${t.start ? `${t.start} · ` : ""}${t.title}` : "")),
      intentSection(snapshot),
      section("Open questions", notes.open_questions, (q) => q),
    ].filter(Boolean);
    return {
      empty: "",
      error: "",
      summary: notes.summary || "",
      sections,
      updated: snapshot.analysisAt
        ? `Updated ${new Date(snapshot.analysisAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${
            snapshot.liveAnalysis ? " · refreshes every minute" : ""
          }`
        : "",
    };
  }

  function speakersView(snapshot) {
    const utterances = list(snapshot.utterances);
    const stats = transcription.speakerStats(utterances);
    if (!stats.length) return { empty: "Talk time appears once people speak.", rows: [] };
    const { sentiment } = classification.summarize(utterances, snapshot.classifications || {}, {
      meetingStartedAt: snapshot.meetingStartedAt,
      clock: transcription.clock,
    });
    const mood = new Map(sentiment.map((entry) => [entry.speaker, entry.label]));
    return {
      empty: "",
      rows: stats.map((entry) => {
        const percent = Math.round(entry.talk_share * 100);
        const label = mood.get(entry.speaker) || "";
        return {
          speaker: entry.speaker,
          percent,
          right: label ? `${percent}% · ${label}` : `${percent}%`,
          mood: label,
          title: `${Math.round(entry.talk_seconds)} s talking · ${entry.turns} turns · ${entry.words_per_minute} wpm`,
        };
      }),
    };
  }

  // One call per repaint: everything the renderer needs, already decided.
  function build(snapshot = {}) {
    const state = { status: "idle", ...snapshot };
    return {
      header: header(state),
      showViews: capturing(state.status) || state.audioActive || list(state.utterances).length > 0,
      // Capture only runs once consent, identity and configuration passed, so
      // "capturing but no audio yet" is exactly when live transcription can
      // start. liveReady comes from the worker: without a key there is nothing
      // to start, and the panel says so instead of offering a button that fails.
      canStart: capturing(state.status) && !state.audioActive && state.liveReady !== false,
      // Stopping is not discarding. The transcript stays, and starting again
      // continues it.
      canStop: !!state.audioActive,
      transcript: transcriptView(state),
      notes: notesView(state),
      speakers: speakersView(state),
      action: action(state),
      consent: state.audioActive
        ? "Audio is transcribed live, notes are written by SipPulse AI, and each line is classified by TypeSafe. The transcript goes to your organization's vCon store and your email."
        : "Transcript goes to your organization's vCon store and the collaborator's email.",
    };
  }

  ns.panelModel = { build, TABS };
})(typeof self !== "undefined" ? self : globalThis);
