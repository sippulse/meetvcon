const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLibraries } = require("./helpers");

// The libraries run in a vm context, so the objects they build are not
// reference-equal to this realm's; compare their JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

const load = () =>
  loadLibraries(["src/lib/transcription.js", "src/lib/classification.js", "src/lib/panel-model.js"]).panelModel;

const START = "2026-09-04T12:00:00.000Z";
const at = (seconds) => new Date(Date.parse(START) + seconds * 1000).toISOString();

function snapshot(overrides = {}) {
  return {
    status: "active",
    audioActive: true,
    analysisEnabled: true,
    classificationEnabled: true,
    liveAnalysis: false,
    collaborator: { email: "ana.souza@sippulse.com" },
    meetingStartedAt: START,
    utterances: [
      { segment_id: "s1", speaker: "Bruno Lima", text: "Queria falar da proposta.", start: at(2), duration: 3 },
      { segment_id: "s2", speaker: "Bruno Lima", text: "São vinte mil assinantes.", start: at(6), duration: 3 },
      { segment_id: "s3", speaker: "Ana Souza", text: "Aprovo dez por cento.", start: at(12), duration: 4 },
    ],
    classifications: {},
    interim: {},
    analysis: null,
    analysisAt: null,
    analysisError: "",
    transcriptionState: "",
    ...overrides,
  };
}

test("the header says what is happening, and streaming trouble is visible", () => {
  const panelModel = load();
  assert.deepEqual(plain(panelModel.build(snapshot()).header), {
    tone: "red",
    text: "Live transcription on (tab audio + microphone)",
  });
  assert.equal(panelModel.build(snapshot({ transcriptionState: "reconnecting" })).header.tone, "amber");
  assert.equal(
    panelModel.build(snapshot({ audioActive: false, status: "active" })).header.text,
    "Capturing Google captions"
  );
  // A blocked state explains itself instead of saying "no consent yet".
  assert.equal(
    panelModel.build({ status: "managed_disabled", statusDetail: "Set the vCon store endpoint" }).header.text,
    "Capture is not configured yet — Set the vCon store endpoint"
  );
  assert.equal(panelModel.build({ status: "idle" }).showViews, false);
});

test("a turn names its speaker once and interim speech is marked", () => {
  const panelModel = load();
  const view = panelModel.build(snapshot({ interim: { 0: "estou pensando" } })).transcript;
  assert.equal(view.empty, "");
  assert.deepEqual(
    plain(view.lines.map((line) => [line.speaker, line.time, line.interim])),
    [
      ["Bruno Lima", "00:02", false],
      [null, "", false],
      ["Ana Souza", "00:12", false],
      [null, "", true],
    ]
  );
  assert.equal(view.lines.at(-1).text, "Ana Souza: estou pensando", "the microphone channel is the collaborator");
});

test("only confident, notable classifications become tags", () => {
  const panelModel = load();
  const view = panelModel.build(
    snapshot({
      classifications: {
        s1: { intent: "purchase_interest", intent_confidence: 0.9, sentiment: 0.5, action_item: 0.1 },
        s2: { intent: "objection", intent_confidence: 0.4, sentiment: 0, action_item: 0.2 },
        s3: { intent: "information", intent_confidence: 0.9, sentiment: 0, action_item: 0.85 },
      },
    })
  ).transcript;
  assert.deepEqual(plain(view.lines[0].tags), [
    { kind: "purchase_interest", label: "buying signal" },
    { kind: "positive", label: "positive" },
  ]);
  assert.deepEqual(plain(view.lines[1].tags), [], "a guess below 0.6 is not shown");
  assert.deepEqual(plain(view.lines[2].tags), [{ kind: "commitment", label: "action item" }]);
});

test("the notes tab says when the report is coming, and shows every section once it arrives", () => {
  const panelModel = load();
  assert.match(panelModel.build(snapshot()).notes.empty, /when the call ends/);
  assert.match(panelModel.build(snapshot({ liveAnalysis: true })).notes.empty, /about a minute/);
  assert.match(panelModel.build(snapshot({ audioActive: false })).notes.empty, /need live transcription/);
  assert.match(
    panelModel.build(snapshot({ analysisEnabled: false })).notes.empty,
    /not configured/
  );

  const notes = panelModel.build(
    snapshot({
      analysis: {
        summary: "Fechado com dez por cento.",
        action_items: [{ owner: "Ana Souza", task: "Enviar a proposta", due: "sexta" }],
        next_step: "Kick off na segunda",
        key_points: ["Vinte mil assinantes"],
        decisions: [{ decision: "Dez por cento", rationale: "quinze era alto" }],
        numbers: [{ label: "desconto", value: "10%", context: "aprovado" }],
        risks: ["Concorrência ainda em avaliação"],
        topics: [{ title: "Proposta", start: "00:02", summary: "" }],
        open_questions: ["Quem assina o contrato?"],
      },
      analysisAt: at(120),
    })
  ).notes;
  assert.equal(notes.summary, "Fechado com dez por cento.");
  assert.deepEqual(
    plain(notes.sections.map((section) => section.title)),
    ["Action items", "Next step", "Key points", "Decisions", "Figures", "Risks and objections", "Topics", "Open questions"]
  );
  assert.deepEqual(plain(notes.sections[0].items), ["Enviar a proposta — Ana Souza (sexta)"]);
  assert.deepEqual(plain(notes.sections[3].items), ["Dez por cento (quinze era alto)"]);
  assert.deepEqual(plain(notes.sections[4].items), ["10% — desconto (aprovado)"]);
  assert.match(notes.updated, /^Updated /);
  assert.equal(notes.updated.includes("refreshes"), false, "only live mode refreshes");
});

test("decisions written as plain strings by an older report still render", () => {
  const panelModel = load();
  const notes = panelModel.build(snapshot({ analysis: { decisions: ["Piloto em outubro"], summary: "" } })).notes;
  assert.deepEqual(plain(notes.sections), [{ title: "Decisions", items: ["Piloto em outubro"] }]);
});

test("speakers show talk share, and the call can be stopped while it runs", () => {
  const panelModel = load();
  const model = panelModel.build(snapshot());
  assert.deepEqual(
    plain(model.speakers.rows.map((row) => row.speaker)),
    ["Bruno Lima", "Ana Souza"]
  );
  assert.equal(model.speakers.rows[0].percent + model.speakers.rows[1].percent, 100);
  assert.match(model.speakers.rows[0].title, /turns/);
  assert.deepEqual(plain(model.action), { id: "discard", label: "Stop and discard this call" });
  assert.equal(model.canStart, false, "live transcription is already on");
  assert.equal(panelModel.build(snapshot({ audioActive: false })).canStart, true, "capture runs, audio does not");
  assert.equal(panelModel.build({ status: "setup_required" }).canStart, false, "capture never started");
  assert.match(model.consent, /vCon store/);

  assert.deepEqual(plain(panelModel.build({ status: "setup_required" }).action), { id: "setup", label: "Review setup" });
  assert.equal(panelModel.build({ status: "discarded" }).action, null);
  assert.equal(panelModel.build({ status: "idle" }).speakers.empty, "Talk time appears once people speak.");
});
