// Names remote speech when Google captions are off. Samples which participant
// tiles are showing audio (src/lib/selectors.js) and turns that into
// {speaker, start, duration} events, the same shape caption lines have, so
// transcription.resolveSpeakerNames can vote with them.
//
// The sampling is injectable so the coalescing is tested without a browser.

(function () {
  const ns = (window.MeetVcon = window.MeetVcon || {});
  if (ns.activeSpeaker) return;

  const SAMPLE_MS = 400;
  // Shorter than this is a tile flickering, not somebody speaking.
  const MIN_EVENT_SEC = 0.4;
  const MAX_EVENTS = 2_000;

  const state = {
    timer: null,
    events: [],
    open: new Map(), // name -> ms when it started showing audio
  };

  function close(name, startedAt, now) {
    state.open.delete(name);
    const duration = (now - startedAt) / 1000;
    if (duration < MIN_EVENT_SEC) return;
    state.events.push({ speaker: name, start: new Date(startedAt).toISOString(), duration });
    if (state.events.length > MAX_EVENTS) state.events.shift();
  }

  function sample(names = [], now = Date.now()) {
    const active = new Set(names);
    for (const [name, startedAt] of [...state.open]) {
      if (!active.has(name)) close(name, startedAt, now);
    }
    for (const name of active) {
      if (!state.open.has(name)) state.open.set(name, now);
    }
  }

  // Whoever is mid-sentence counts too, so the newest speech gets a name.
  function getEvents(now = Date.now()) {
    const open = [...state.open]
      .map(([name, startedAt]) => ({
        speaker: name,
        start: new Date(startedAt).toISOString(),
        duration: (now - startedAt) / 1000,
      }))
      .filter((event) => event.duration >= MIN_EVENT_SEC);
    return [...state.events, ...open];
  }

  function start() {
    if (state.timer) return;
    state.timer = setInterval(() => sample(ns.selectors.speakingNames()), SAMPLE_MS);
  }

  function stop() {
    clearInterval(state.timer);
    state.timer = null;
    const now = Date.now();
    for (const [name, startedAt] of [...state.open]) close(name, startedAt, now);
  }

  function reset() {
    stop();
    state.events = [];
    state.open.clear();
  }

  ns.activeSpeaker = { start, stop, reset, sample, getEvents };
})();
