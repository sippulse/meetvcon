const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLibrary } = require("./helpers");

test("caption parsing preserves speaker labels for fallback diarization", () => {
  const { captions } = loadLibrary("src/lib/captions.js");
  assert.deepEqual(
    { ...captions.parseCaptionText("Ana Silva\nOlá, como você está?") },
    { speaker: "Ana Silva", text: "Olá, como você está?" }
  );
});

test("caption parsing keeps unlabeled captions as text", () => {
  const { captions } = loadLibrary("src/lib/captions.js");
  assert.deepEqual(
    { ...captions.parseCaptionText("A sentence.\nA continuation") },
    { speaker: null, text: "A sentence. A continuation" }
  );
});
