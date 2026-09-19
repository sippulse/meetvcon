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
      transcriptionSource: "sippulse_ai_live",
      capturedByUser: { email: "ana@sippulse.com", id: "profile-id" },
    }
  );

  assert.deepEqual(Array.from(document.parties, (party) => party.name), ["Ana", "Bruno"]);
  assert.deepEqual(Array.from(document.dialog, (entry) => entry.parties[0]), [0, 1]);
  assert.equal(
    document.attachments[0].body.captured_by_user.email,
    "ana@sippulse.com"
  );
  assert.equal(document.attachments[0].body.transcription_source, "sippulse_ai_live");
});

test("Markdown export renders the meeting report ahead of the transcript", () => {
  const { vcon } = loadLibrary("src/lib/vcon.js");
  const document = vcon.assemble(
    {
      uuid: "meeting-uuid",
      meetingId: "abc-defg-hij",
      subject: "Pipeline",
      startedAt: "2026-09-04T12:00:00.000Z",
      utterances: [{ speaker: "Ana", text: "Envio a proposta", start: "2026-09-04T12:00:01.000Z", duration: 2 }],
    },
    {
      transcriptionSource: "sippulse_ai_live",
      analysis: [
        {
          type: "meeting_insights",
          encoding: "json",
          body: {
            summary: "Proposta para a Vivanet.",
            key_points: [],
            action_items: [{ owner: "Ana", task: "Enviar proposta", due: "sexta" }],
            decisions: [],
            topics: [],
            intents: [],
            open_questions: [],
            sentiment: [{ speaker: "Ana", label: "positive", score: 0.5, note: "" }],
          },
        },
        {
          type: "speaker_analytics",
          encoding: "json",
          body: [{ speaker: "Ana", talk_seconds: 2, talk_share: 1, turns: 1 }],
        },
      ],
    }
  );
  const markdown = vcon.toMarkdown(document);
  assert.match(markdown, /## Summary\n\nProposta para a Vivanet\./);
  assert.match(markdown, /- \[ \] Enviar proposta — \*\*Ana\*\* \(sexta\)/);
  assert.match(markdown, /\| Ana \| 2s \| 100% \| 1 \| positive \|/);
  assert.ok(markdown.indexOf("## Summary") < markdown.indexOf("## Transcript"));
});
