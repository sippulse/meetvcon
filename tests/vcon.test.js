const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLibrary } = require("./helpers");

test("vCon is diarized and routes to the collaborator", () => {
  const { vcon } = loadLibrary("src/lib/vcon.js");
  const document = vcon.assemble(
    {
      uuid: "meeting-uuid",
      meetingId: "abc-defg-hij",
      startedAt: "2026-09-04T12:00:00.000Z",
      utterances: [
        { speaker: "Ana", text: "Olá", start: "2026-09-04T12:00:01.000Z" },
        { speaker: "Bruno", text: "Oi", start: "2026-09-04T12:00:02.000Z" },
      ],
    },
    {
      transcriptionSource: "sippulse_ai",
      capturedByUser: { email: "ana@sippulse.com", id: "profile-id" },
    }
  );

  assert.deepEqual(Array.from(document.parties, (party) => party.name), ["Ana", "Bruno"]);
  assert.deepEqual(Array.from(document.dialog, (entry) => entry.parties[0]), [0, 1]);
  assert.equal(
    document.attachments[0].body.captured_by_user.email,
    "ana@sippulse.com"
  );
  assert.equal(document.attachments[0].body.transcription_source, "sippulse_ai");
});
