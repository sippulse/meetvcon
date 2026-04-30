// Transcript capture: observe Meet's caption overlay, build a buffer of
// utterances, persist to chrome.storage.session every few seconds.
//
// Meet captions are progressive: as a person speaks, a single caption
// "block" element's text is updated word-by-word. When the speaker pauses
// (or another speaker takes over), Meet creates a new block. We use
// element identity (via WeakMap) to track each block as one utterance
// and update its text on every mutation.

(function () {
  const ns = (window.MeetVcon = window.MeetVcon || {});
  if (ns.transcriptCapture) return;

  const { log, selectors, vcon, storage } = ns;

  const PERSIST_INTERVAL_MS = 5_000;

  const state = {
    observer: null,
    persistTimer: null,
    overlayEl: null,
    // WeakMap<Element, { id, speaker, text, start, lastUpdated }>
    blocksByEl: new WeakMap(),
    // Ordered list of utterance ids; we copy from blocksByEl into this
    // when persisting.
    utteranceIds: [],
    // utteranceById[id] = the same record stored in blocksByEl, kept here
    // because WeakMap is not iterable.
    utteranceById: new Map(),
    nextId: 1,
    meeting: null, // { uuid, meetingId, meetingUrl, subject, startedAt }
  };

  function meetingIdFromUrl() {
    // Meet URL: https://meet.google.com/abc-defg-hij
    const m = location.pathname.match(/^\/([a-z]{3,4}-[a-z]{4}-[a-z]{3,4})/i);
    return m ? m[1] : null;
  }

  function readSubject() {
    // Meet sets document.title to the meeting name when available.
    // Falls back to the URL fragment.
    const t = document.title || "";
    return t.replace(/\s*-\s*Google Meet\s*$/, "").trim();
  }

  // Heuristic: the caption block is one direct child of the overlay region.
  // Within that block, the speaker name is usually a short text node near
  // the top, and the spoken text follows. We grab speaker as the first
  // non-empty short line, text as the remainder.
  function parseBlock(el) {
    const raw = (el.innerText || el.textContent || "").trim();
    if (!raw) return { speaker: null, text: "" };
    const lines = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    if (lines.length === 0) return { speaker: null, text: "" };
    if (lines.length === 1) {
      // No speaker label visible — treat whole content as text.
      return { speaker: null, text: lines[0] };
    }
    // First line is speaker if it looks like a name (no terminal punctuation,
    // reasonably short). Otherwise treat all lines as text.
    const first = lines[0];
    const looksLikeName =
      first.length <= 60 && !/[.!?]$/.test(first) && !/\s{2,}/.test(first);
    if (looksLikeName) {
      return { speaker: first, text: lines.slice(1).join(" ") };
    }
    return { speaker: null, text: lines.join(" ") };
  }

  function recordBlock(el) {
    let entry = state.blocksByEl.get(el);
    const parsed = parseBlock(el);
    const now = new Date();

    if (!entry) {
      entry = {
        id: state.nextId++,
        speaker: parsed.speaker || "unknown",
        text: parsed.text,
        start: now.toISOString(),
        startMs: now.getTime(),
        lastUpdated: now.toISOString(),
      };
      state.blocksByEl.set(el, entry);
      state.utteranceIds.push(entry.id);
      state.utteranceById.set(entry.id, entry);
      log.debug("new utterance", entry.id, entry.speaker, entry.text.slice(0, 40));
    } else {
      // Update text if it changed; keep speaker as initially captured
      // (Meet doesn't change the speaker mid-block).
      if (parsed.text && parsed.text !== entry.text) {
        entry.text = parsed.text;
        entry.lastUpdated = now.toISOString();
      }
      if (entry.speaker === "unknown" && parsed.speaker) {
        entry.speaker = parsed.speaker;
      }
    }
  }

  function snapshotUtterances() {
    // Convert internal records into the storage-shape utterance list.
    return state.utteranceIds.map((id) => {
      const u = state.utteranceById.get(id);
      const endMs = Date.parse(u.lastUpdated);
      const duration = Math.max(0, (endMs - u.startMs) / 1000);
      return {
        speaker: u.speaker,
        text: u.text,
        start: u.start,
        duration,
      };
    });
  }

  async function persist() {
    if (!state.meeting) return;
    const utterances = snapshotUtterances();
    const record = {
      ...state.meeting,
      utterances,
      captionsEnabled: !!selectors.areCaptionsActive(),
    };
    try {
      await storage.setMeeting(state.meeting.meetingId, record);
    } catch (err) {
      log.error("failed to persist meeting", err);
    }
  }

  function onMutation(mutations) {
    for (const m of mutations) {
      // Existing block updated.
      if (m.type === "characterData" || m.type === "childList") {
        // Walk up to a direct child of the overlay (= one caption block).
        let target = m.target.nodeType === Node.TEXT_NODE ? m.target.parentElement : m.target;
        while (
          target &&
          target.parentElement !== state.overlayEl &&
          target !== state.overlayEl
        ) {
          target = target.parentElement;
        }
        if (target && target !== state.overlayEl) {
          recordBlock(target);
        }
      }
    }
    // Also sweep top-level children to pick up any blocks we missed
    // (happens when the overlay is reattached or re-rendered).
    if (state.overlayEl) {
      for (const child of state.overlayEl.children) {
        if (!state.blocksByEl.has(child)) recordBlock(child);
      }
    }
  }

  function attachObserver() {
    const overlay = selectors.findCaptionsOverlay();
    if (!overlay) return false;
    if (overlay === state.overlayEl) return true;

    if (state.observer) state.observer.disconnect();
    state.overlayEl = overlay;
    state.observer = new MutationObserver(onMutation);
    state.observer.observe(overlay, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    log.info("captions observer attached");

    // Pick up any blocks already present.
    for (const child of overlay.children) recordBlock(child);
    return true;
  }

  // Re-check overlay periodically because Meet can re-mount it.
  function maintainObserver() {
    if (!state.overlayEl || !document.contains(state.overlayEl)) {
      attachObserver();
    }
  }

  async function startMeeting() {
    const meetingId = meetingIdFromUrl();
    if (!meetingId) {
      log.warn("could not derive meeting id from URL", location.pathname);
      return null;
    }
    if (state.meeting && state.meeting.meetingId === meetingId) {
      return state.meeting;
    }
    // If a record already exists in session storage (e.g. tab reload), reuse it.
    const existing = await storage.getMeeting(meetingId);
    state.meeting = existing || {
      uuid: vcon.uuidv4(),
      meetingId,
      meetingUrl: location.origin + "/" + meetingId,
      subject: readSubject(),
      startedAt: new Date().toISOString(),
    };
    if (!existing) {
      await storage.setMeeting(meetingId, { ...state.meeting, utterances: [] });
    } else {
      // Re-hydrate utterance list from storage so we don't double-count.
      for (const u of existing.utterances || []) {
        const id = state.nextId++;
        const rec = { ...u, id, startMs: Date.parse(u.start) };
        state.utteranceById.set(id, rec);
        state.utteranceIds.push(id);
      }
      log.info("rehydrated", existing.utterances?.length || 0, "utterances");
    }
    log.info("meeting started", state.meeting.meetingId, "uuid", state.meeting.uuid);

    // Notify service worker so it can schedule snapshot alarms.
    chrome.runtime.sendMessage({
      type: "call_started",
      meetingId: state.meeting.meetingId,
      uuid: state.meeting.uuid,
    }).catch(() => {});

    return state.meeting;
  }

  async function endMeeting() {
    if (!state.meeting) return;
    log.info("meeting ended", state.meeting.meetingId);
    await persist();
    chrome.runtime.sendMessage({
      type: "call_ended",
      meetingId: state.meeting.meetingId,
    }).catch(() => {});
    state.meeting = null;
  }

  function start() {
    if (state.persistTimer) return;
    log.info("transcript capture started");
    state.persistTimer = setInterval(() => {
      maintainObserver();
      persist();
    }, PERSIST_INTERVAL_MS);
    // Initial attach (might fail if overlay isn't there yet — watchdog will
    // turn captions on, then maintainObserver will pick it up).
    attachObserver();
  }

  function stop() {
    if (state.persistTimer) {
      clearInterval(state.persistTimer);
      state.persistTimer = null;
    }
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    state.overlayEl = null;
    log.info("transcript capture stopped");
  }

  ns.transcriptCapture = {
    start,
    stop,
    startMeeting,
    endMeeting,
    getUtteranceCount: () => state.utteranceIds.length,
    getMeeting: () => state.meeting,
  };
})();
