// Transcript capture: observe Meet's caption overlay, build a buffer of
// utterances, and send encrypted persistence requests to the service worker.
//
// Meet captions are progressive: as a person speaks, a single caption
// "block" element's text is updated word-by-word. When the speaker pauses
// (or another speaker takes over), Meet creates a new block. We use
// element identity (via WeakMap) to track each block as one utterance
// and update its text on every mutation.

(function () {
  const ns = (window.MeetVcon = window.MeetVcon || {});
  if (ns.transcriptCapture) return;

  const { log, selectors, vcon, captions } = ns;

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

  async function workerRequest(type, payload = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    if (!response?.ok) {
      throw new Error(response?.error || `${type} failed`);
    }
    return response;
  }

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
  function recordBlock(el) {
    if (el.tagName === "BUTTON" || el.getAttribute("role") === "button") return;
    let entry = state.blocksByEl.get(el);
    const parsed = captions.parseCaptionText(el.innerText || el.textContent);
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
      await workerRequest("active_meeting_put", { record });
    } catch (err) {
      log.error("failed to persist meeting", err);
    }
  }

  function resetUtterances() {
    state.blocksByEl = new WeakMap();
    state.utteranceIds = [];
    state.utteranceById = new Map();
    state.nextId = 1;
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
    resetUtterances();
    const response = await workerRequest("active_meeting_get", { meetingId });
    const existing = response.record;
    state.meeting = existing || {
      uuid: vcon.uuidv4(),
      meetingId,
      meetingUrl: location.origin + "/" + meetingId,
      subject: readSubject(),
      startedAt: new Date().toISOString(),
    };
    if (!existing) {
      await persist();
    } else {
      // Re-hydrate utterance list from storage so we don't double-count.
      for (const u of existing.utterances || []) {
        const id = state.nextId++;
        const startMs = Date.parse(u.start);
        const rec = {
          ...u,
          id,
          startMs,
          lastUpdated:
            u.lastUpdated ||
            new Date(startMs + (Number(u.duration) || 0) * 1000).toISOString(),
        };
        state.utteranceById.set(id, rec);
        state.utteranceIds.push(id);
      }
      log.info("rehydrated", existing.utterances?.length || 0, "utterances");
    }
    log.info("meeting started", state.meeting.meetingId, "uuid", state.meeting.uuid);

    return state.meeting;
  }

  // Always releases local state, even when the worker reports a failure:
  // a queued delivery is handled by the worker's outbox, and an empty call
  // must not leave timers re-creating the record every five seconds.
  async function endMeeting() {
    if (!state.meeting) return null;
    const meetingId = state.meeting.meetingId;
    log.info("meeting ended", meetingId);
    let response = null;
    try {
      await persist();
      response = await chrome.runtime.sendMessage({ type: "call_ended", meetingId });
      if (!response?.ok && !response?.queued) {
        log.warn("final delivery not accepted", response?.error);
      }
    } catch (err) {
      log.error("call_ended failed", err);
    } finally {
      state.meeting = null;
      resetUtterances();
    }
    return response;
  }

  async function cancelMeeting() {
    if (!state.meeting) return;
    const meetingId = state.meeting.meetingId;
    state.meeting = null;
    resetUtterances();
    await workerRequest("capture_cancelled", { meetingId });
    log.info("meeting capture discarded", meetingId);
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
    cancelMeeting,
    getUtteranceCount: () => state.utteranceIds.length,
    getMeeting: () => state.meeting,
    meetingIdFromUrl,
  };
})();
