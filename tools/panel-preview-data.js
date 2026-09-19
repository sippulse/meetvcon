// Sample meeting for tools/panel-preview.html: stands in for the capture
// modules so the real in-call panel renders without Google Meet.

(function () {
  const ns = (window.MeetVcon = window.MeetVcon || {});
  const started = Date.now() - 14 * 60_000;
  const at = (seconds) => new Date(started + seconds * 1000).toISOString();

  // Undiarized segments, as the SipPulse AI gateway returns them.
  const segments = [
    { id: 1, channel: 1, speaker: null, text: "Obrigado por entrarem. Vamos começar pela revisão do pipeline de vendas.", start: 12, end: 17.5, confidence: 0.96, language: null },
    { id: 2, channel: 0, speaker: null, text: "Perfeito. Fechamos três provedores novos em agosto, e a Vivanet pediu proposta para 20 mil assinantes.", start: 18.2, end: 25.9, confidence: 0.95, language: null },
    { id: 3, channel: 1, speaker: null, text: "Qual é o prazo que eles deram para a proposta?", start: 26.5, end: 29, confidence: 0.94, language: null },
    { id: 4, channel: 0, speaker: null, text: "Até sexta-feira. Eu envio a proposta e o Bruno cuida da parte técnica do SBC.", start: 29.6, end: 35.1, confidence: 0.95, language: null },
    { id: 5, channel: 1, speaker: null, text: "Só acho que o desconto que eles pediram está alto demais.", start: 35.8, end: 40.4, confidence: 0.93, language: null },
  ];
  // Jev answers, as returned for these lines.
  const classifications = {
    1: { intent: "small_talk", intent_confidence: 1, sentiment: 0.4, action_item: 0.03 },
    2: { intent: "purchase_interest", intent_confidence: 0.82, sentiment: 0.55, action_item: 0.1 },
    3: { intent: "question", intent_confidence: 1, sentiment: 0, action_item: 0.04 },
    4: { intent: "commitment", intent_confidence: 0.98, sentiment: 0.1, action_item: 0.97 },
    5: { intent: "objection", intent_confidence: 0.9, sentiment: -0.45, action_item: 0.02 },
  };
  const captions = [
    { speaker: "Jane Doe", text: "", start: at(12.5), duration: 5 },
    { speaker: "Bruno Lima", text: "", start: at(27), duration: 2 },
    { speaker: "Jane Doe", text: "", start: at(36.2), duration: 4 },
  ];
  const live = {
    streamStartedAt: new Date(started).toISOString(),
    segments,
    classifications,
    interim: { 1: "e o cliente quer começar com um piloto em" },
    analysis: {
      summary: "Revisão do pipeline: três novos provedores fechados em agosto. A Vivanet pediu proposta para 20 mil assinantes com prazo até sexta-feira.",
      key_points: ["Três provedores fechados em agosto", "Vivanet: 20 mil assinantes"],
      topics: [{ title: "Pipeline de vendas", start: "00:12", summary: "" }, { title: "Proposta Vivanet", start: "00:18", summary: "" }],
      action_items: [
        { owner: "Ana Souza", task: "Enviar proposta para a Vivanet", due: "sexta-feira" },
        { owner: "Bruno Lima", task: "Dimensionar o SBC", due: "" },
      ],
      decisions: ["Bruno lidera a parte técnica"],
      open_questions: ["Volume de chamadas simultâneas da Vivanet"],
    },
    analysisAt: new Date(Date.now() - 40_000).toISOString(),
    status: null,
  };

  ns.captionsWatchdog = {
    onStatusChange(fn) {
      fn("active");
      return () => {};
    },
  };
  ns.transcriptCapture = {
    getLive: () => live,
    getCaptionUtterances: () => captions,
    getMeeting: () => ({ startedAt: new Date(started).toISOString() }),
    onLiveChange: () => () => {},
  };
})();
