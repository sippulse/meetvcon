// Inline utterance classification with TypeSafe's Jev System One model:
// every final transcript segment gets an intent, a sentiment score, and an
// action-item probability in ~300 ms, shown as tags in the live transcript
// and aggregated into the meeting report. Jev answers typed questions with
// calibrated probabilities; it does not write text (summaries come from
// src/lib/analysis.js). Network access is injected so tests run without a
// browser.

(function (root) {
  const ns = (root.MeetVcon = root.MeetVcon || {});
  if (ns.classification) return;

  const SCHEMA_ID = "sippulse-meet-classification/1";
  const TIMEOUT_MS = 10_000;
  const MIN_WORDS = 3;
  // Intents worth listing in notes; information and small talk are not.
  const NOTABLE = new Set([
    "commitment",
    "decision",
    "question",
    "objection",
    "purchase_interest",
    "problem_report",
    "scheduling",
  ]);
  const SENTIMENT_LEVELS = ["Very negative", "Negative", "Neutral", "Positive", "Very positive"];

  const QUESTIONS = {
    intent: {
      type: "choice",
      instructions: "What is the speaker doing with this utterance in a business meeting?",
      criteria: {
        commitment: "Commits to doing something or assigns a task",
        decision: "States that something has been decided or agreed",
        question: "Asks for information or clarification",
        objection: "Raises a concern, objection, or disagreement",
        purchase_interest: "Expresses interest in buying, pricing, or a proposal",
        problem_report: "Reports a problem, bug, or complaint",
        scheduling: "Proposes or confirms a date, time, or follow-up meeting",
        information: "Shares status, facts, or context",
        small_talk: "Greeting, thanks, or social chat",
      },
    },
    sentiment: {
      type: "score",
      instructions: "Sentiment expressed by the speaker",
      criteria: SENTIMENT_LEVELS,
    },
    action_item: {
      type: "noul",
      instructions: "The utterance contains a concrete action item or commitment someone will do",
    },
  };

  const round = (value) => Math.round(value * 1000) / 1000;

  function worthClassifying(text) {
    return String(text || "").trim().split(/\s+/).filter(Boolean).length >= MIN_WORDS;
  }

  // Score 0..4 mapped to -1..1.
  function sentimentValue(score) {
    const middle = (SENTIMENT_LEVELS.length - 1) / 2;
    return round((Number(score) - middle) / middle);
  }

  function sentimentLabel(value) {
    if (value >= 0.25) return "positive";
    if (value <= -0.25) return "negative";
    return "neutral";
  }

  function parseAnswers(body) {
    const answers = body?.answers || {};
    const intent = answers.intent;
    const sentiment = answers.sentiment;
    const actionItem = answers.action_item;
    if (!intent?.choice || !Number.isFinite(sentiment?.score) || !Number.isFinite(actionItem?.noul)) {
      throw new Error("Incomplete answers");
    }
    return {
      intent: intent.choice,
      intent_confidence: round(Number(intent.confidence) || 0),
      sentiment: sentimentValue(sentiment.score),
      action_item: round(actionItem.noul),
      model: body.model || "",
    };
  }

  // previous: the utterance before this one, so replies like "sim, fechado"
  // are read in context.
  async function classify({ fetch: fetchImpl, apiBase, apiKey, model, speaker, text, previous }) {
    if (!apiKey) return { ok: false, error: "TypeSafe key is not configured" };
    if (!worthClassifying(text)) return { ok: false, skipped: true, error: "Too short to classify" };
    const state = { speaker, utterance: text };
    if (previous?.text) state.previous_utterance = `${previous.speaker}: ${previous.text}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${apiBase}/systemone`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, state, questions: QUESTIONS }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = typeof body.detail === "string" ? body.detail : body.message;
        return { ok: false, status: response.status, error: detail || `HTTP ${response.status}` };
      }
      return { ok: true, classification: parseAnswers(body) };
    } catch (error) {
      return { ok: false, error: error.name === "AbortError" ? "Classification timed out" : error.message };
    } finally {
      clearTimeout(timer);
    }
  }

  // Report fields derived from per-utterance classifications. utterances
  // carry segment_id; classifications is { [segmentId]: classification }.
  function summarize(utterances, classifications, { meetingStartedAt, clock, minConfidence = 0.6 } = {}) {
    const base = Date.parse(meetingStartedAt || utterances?.[0]?.start);
    const at = (utterance) => {
      const offset = (Date.parse(utterance.start) - base) / 1000;
      return clock && Number.isFinite(offset) ? clock(offset) : "";
    };
    const intents = [];
    const bySpeaker = new Map();
    for (const utterance of utterances || []) {
      const entry = classifications?.[utterance.segment_id];
      if (!entry) continue;
      if (NOTABLE.has(entry.intent) && entry.intent_confidence >= minConfidence) {
        intents.push({
          speaker: utterance.speaker,
          intent: entry.intent,
          detail: utterance.text,
          at: at(utterance),
          confidence: entry.intent_confidence,
        });
      }
      const weight = Math.max(1, Number(utterance.duration) || 1);
      const tally = bySpeaker.get(utterance.speaker) || { sum: 0, weight: 0, count: 0 };
      tally.sum += entry.sentiment * weight;
      tally.weight += weight;
      tally.count++;
      bySpeaker.set(utterance.speaker, tally);
    }
    const sentiment = [...bySpeaker.entries()].map(([speaker, tally]) => {
      const score = round(tally.sum / tally.weight);
      return {
        speaker,
        label: sentimentLabel(score),
        score,
        note: `${tally.count} classified utterance${tally.count === 1 ? "" : "s"}`,
      };
    });
    return { intents, sentiment };
  }

  // Per-dialog classifications for the vCon; dialog index = utterance index.
  function toVconAnalysis({ utterances, classifications, model }) {
    const body = [];
    (utterances || []).forEach((utterance, index) => {
      const entry = classifications?.[utterance.segment_id];
      if (!entry) return;
      body.push({
        dialog: index,
        intent: entry.intent,
        intent_confidence: entry.intent_confidence,
        sentiment: entry.sentiment,
        action_item: entry.action_item,
      });
    });
    if (!body.length) return [];
    return [
      {
        type: "utterance_classification",
        dialog: body.map((entry) => entry.dialog),
        vendor: "typesafe.ai",
        product: model || "",
        schema: SCHEMA_ID,
        encoding: "json",
        body,
      },
    ];
  }

  async function checkKey(fetchImpl, apiBase, apiKey) {
    if (!apiKey) return { ok: false, error: "Not configured" };
    try {
      const response = await fetchImpl(`${apiBase}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
      return response.ok
        ? { ok: true, status: response.status }
        : { ok: false, status: response.status, error: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  ns.classification = {
    SCHEMA_ID,
    QUESTIONS,
    NOTABLE,
    worthClassifying,
    sentimentValue,
    sentimentLabel,
    parseAnswers,
    classify,
    summarize,
    toVconAnalysis,
    checkKey,
  };
})(typeof self !== "undefined" ? self : window);
