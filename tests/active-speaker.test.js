const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLibraries } = require("./helpers");

// The module samples the Meet DOM on a timer, but the timer only feeds
// sample(); the coalescing below is what turns tile activity into the
// {speaker, start, duration} windows that name remote speech.
function load() {
  const ns = loadLibraries(["src/content/active-speaker.js"], {
    setInterval,
    clearInterval,
    document: {},
  });
  return ns.activeSpeaker;
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const T = Date.parse("2026-09-04T12:00:00.000Z");

test("a tile that lights up and goes quiet becomes one speaking window", () => {
  const activeSpeaker = load();
  activeSpeaker.sample(["Jane Doe"], T);
  activeSpeaker.sample(["Jane Doe"], T + 400);
  activeSpeaker.sample([], T + 2_000);

  assert.deepEqual(plain(activeSpeaker.getEvents(T + 3_000)), [
    { speaker: "Jane Doe", start: "2026-09-04T12:00:00.000Z", duration: 2 },
  ]);
  activeSpeaker.reset();
});

test("two tiles at once are two windows, and a flicker is not speech", () => {
  const activeSpeaker = load();
  activeSpeaker.sample(["Jane Doe", "Bruno Lima"], T);
  activeSpeaker.sample(["Bruno Lima"], T + 1_000);
  // Jane's window closed at 1 s; Bruno is still going.
  assert.deepEqual(
    plain(activeSpeaker.getEvents(T + 4_000)).map((event) => [event.speaker, event.duration]),
    [
      ["Jane Doe", 1],
      ["Bruno Lima", 4],
    ],
    "whoever is mid-sentence is reported too, so the newest speech gets a name"
  );

  activeSpeaker.reset();
  activeSpeaker.sample(["Blink"], T);
  activeSpeaker.sample([], T + 100);
  assert.deepEqual(plain(activeSpeaker.getEvents(T + 100)), [], "100 ms of animation is not a turn");
  activeSpeaker.reset();
});

test("reset forgets the call, so the next meeting starts clean", () => {
  const activeSpeaker = load();
  activeSpeaker.sample(["Jane Doe"], T);
  activeSpeaker.sample([], T + 2_000);
  assert.equal(activeSpeaker.getEvents(T + 2_000).length, 1);
  activeSpeaker.reset();
  assert.deepEqual(plain(activeSpeaker.getEvents(T + 2_000)), []);
});
