// vCon assembly — builds an IETF vCon JSON document from captured utterances.
// See draft-ietf-vcon-vcon-container.

(function (root) {
  const ns = (root.MeetVcon = root.MeetVcon || {});
  if (ns.vcon) return;

  // RFC 4122 v4 UUID. Uses crypto.randomUUID where available (all
  // modern Chromium), falls back to manual construction otherwise.
  function uuidv4() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
    return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h
      .slice(6, 8)
      .join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
  }

  // Build the parties[] array from a deduped list of speakers.
  // Returns { parties, speakerToIndex }.
  function buildParties(utterances) {
    const seen = new Map(); // name -> index
    const parties = [];
    for (const u of utterances) {
      const name = u.speaker;
      if (!name || name === "unknown") continue;
      if (!seen.has(name)) {
        seen.set(name, parties.length);
        const party = { name };
        if (u.email) party.mailto = u.email;
        parties.push(party);
      }
    }
    return { parties, speakerToIndex: seen };
  }

  function buildDialog(utterances, speakerToIndex) {
    return utterances.map((u) => {
      const idx = speakerToIndex.get(u.speaker);
      const dialog = {
        type: "text",
        start: u.start,
        parties: idx !== undefined ? [idx] : [],
        body: u.text || "",
      };
      if (typeof u.duration === "number" && u.duration > 0) {
        dialog.duration = Number(u.duration.toFixed(2));
      }
      return dialog;
    });
  }

  // Assemble a vCon from a meeting record.
  // record: { uuid, meetingId, meetingUrl, subject, startedAt,
  //           utterances, captionsEnabled }
  // opts:   { capturedBy, deliveryKind, transcriptionSource, transcription,
  //           analysis (vCon analysis[] entries), analysisError, capturedByUser }
  //   capturedByUser: { email, id } | null — the Chrome profile that ran
  //   the extension. Surfaces in attachments[].body.captured_by_user when
  //   present.
  function assemble(record, opts = {}) {
    const utterances = record.utterances || [];
    const { parties, speakerToIndex } = buildParties(utterances);
    const dialog = buildDialog(utterances, speakerToIndex);

    const metadata = {
      platform: "google_meet",
      meeting_code: record.meetingId,
      meeting_url: record.meetingUrl,
      captured_by: opts.capturedBy || "SipPulse Meet Capture",
      captions_enabled: record.captionsEnabled !== false,
      delivery_kind: opts.deliveryKind || "final",
      transcription_source: opts.transcriptionSource || "google_captions",
    };
    if (opts.transcription) {
      metadata.transcription = opts.transcription;
    }
    if (opts.analysisError) {
      metadata.analysis_error = opts.analysisError;
    }
    if (opts.capturedByUser && opts.capturedByUser.email) {
      metadata.captured_by_user = {
        email: opts.capturedByUser.email,
      };
      if (opts.capturedByUser.id) {
        metadata.captured_by_user.id = opts.capturedByUser.id;
      }
    }

    return {
      vcon: "0.0.1",
      uuid: record.uuid,
      created_at: record.startedAt || new Date().toISOString(),
      subject: record.subject || "",
      parties,
      dialog,
      analysis: Array.isArray(opts.analysis) ? opts.analysis : [],
      attachments: [
        {
          type: "meeting_metadata",
          encoding: "json",
          body: metadata,
        },
      ],
    };
  }

  function findAnalysis(doc, type) {
    return (Array.isArray(doc.analysis) ? doc.analysis : []).find((entry) => entry.type === type);
  }

  function formatSeconds(value) {
    const total = Math.round(Number(value) || 0);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
  }

  // Meeting report sections (summary, action items, ...) from the
  // meeting_insights and speaker_analytics analysis entries.
  function reportSections(doc) {
    const insights = findAnalysis(doc, "meeting_insights")?.body;
    const stats = findAnalysis(doc, "speaker_analytics")?.body;
    const lines = [];
    const section = (title, items) => {
      if (!items.length) return;
      lines.push(`## ${title}`, "", ...items, "");
    };
    if (insights) {
      if (insights.summary) lines.push("## Summary", "", insights.summary, "");
      section("Key points", (insights.key_points || []).map((point) => `- ${point}`));
      section(
        "Action items",
        (insights.action_items || []).map(
          (item) =>
            `- [ ] ${item.task}${item.owner ? ` — **${item.owner}**` : ""}${item.due ? ` (${item.due})` : ""}`
        )
      );
      section("Decisions", (insights.decisions || []).map((decision) => `- ${decision}`));
      section(
        "Topics",
        (insights.topics || []).map(
          (topic) => `- ${topic.start ? `\`${topic.start}\` ` : ""}**${topic.title}** — ${topic.summary}`
        )
      );
      section(
        "Intents",
        (insights.intents || []).map(
          (intent) =>
            `- ${intent.at ? `\`${intent.at}\` ` : ""}**${intent.speaker || "?"}** · ${intent.intent}: ${intent.detail}`
        )
      );
      section("Open questions", (insights.open_questions || []).map((question) => `- ${question}`));
    }
    if (Array.isArray(stats) && stats.length) {
      const sentiment = new Map((insights?.sentiment || []).map((entry) => [entry.speaker, entry]));
      lines.push("## Speakers", "", "| Speaker | Talk time | Share | Turns | Sentiment |", "|---|---|---|---|---|");
      for (const entry of stats) {
        const mood = sentiment.get(entry.speaker);
        lines.push(
          `| ${entry.speaker} | ${formatSeconds(entry.talk_seconds)} | ${Math.round(entry.talk_share * 100)}% | ${entry.turns} | ${mood ? mood.label : ""} |`
        );
      }
      lines.push("");
    }
    return lines;
  }

  // Render a vCon document as a human-friendly Markdown transcript.
  // Used by the popup's "Download .md" action.
  function toMarkdown(doc) {
    if (!doc) return "";
    const meta = doc.attachments?.find((a) => a.type === "meeting_metadata")?.body || {};
    const parties = Array.isArray(doc.parties) ? doc.parties : [];
    const dialog = Array.isArray(doc.dialog) ? doc.dialog : [];

    const lines = [];
    const subject = doc.subject || meta.meeting_code || "(no title)";
    lines.push(`# ${subject}`);
    lines.push("");

    if (parties.length) {
      lines.push("## Participants");
      lines.push("");
      for (const p of parties) {
        const label = p.mailto ? `${p.name} (${p.mailto})` : p.name;
        lines.push(`- ${label}`);
      }
      lines.push("");
    }

    const facts = [];
    if (meta.meeting_code) facts.push(`- **Meeting code:** ${meta.meeting_code}`);
    if (meta.meeting_url) facts.push(`- **URL:** ${meta.meeting_url}`);
    if (doc.created_at) facts.push(`- **Started:** ${doc.created_at}`);
    const lastDialog = dialog[dialog.length - 1];
    if (lastDialog?.start) {
      const endIso = lastDialog.duration
        ? new Date(Date.parse(lastDialog.start) + lastDialog.duration * 1000).toISOString()
        : lastDialog.start;
      facts.push(`- **Ended:** ${endIso}`);
    }
    if (meta.platform) facts.push(`- **Platform:** ${meta.platform}`);
    if (meta.captured_by) facts.push(`- **Captured by:** ${meta.captured_by}`);
    if (meta.captured_by_user?.email) {
      facts.push(`- **Capturer:** ${meta.captured_by_user.email}`);
    }
    if (meta.delivery_kind) facts.push(`- **Delivery:** ${meta.delivery_kind}`);
    if (meta.transcription_source) {
      facts.push(`- **Transcription:** ${meta.transcription_source}`);
    }
    if (doc.uuid) facts.push(`- **vCon UUID:** ${doc.uuid}`);
    if (facts.length) {
      lines.push("## Details");
      lines.push("");
      lines.push(...facts, "");
    }

    lines.push(...reportSections(doc));

    lines.push("## Transcript");
    lines.push("");

    function fmtClock(iso) {
      if (!iso) return "";
      const d = new Date(iso);
      if (isNaN(d)) return "";
      return d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
    }

    let lastSpeakerIdx = -1;
    for (const d of dialog) {
      const idx = Array.isArray(d.parties) ? d.parties[0] : null;
      const speaker = parties[idx]?.name || "unknown";
      const clock = fmtClock(d.start);
      const text = (d.body || "").trim();
      if (!text) continue;
      if (idx !== lastSpeakerIdx) {
        if (lastSpeakerIdx !== -1) lines.push("");
        lines.push(`**${speaker}**${clock ? ` _[${clock}]_` : ""}`);
        lastSpeakerIdx = idx;
      }
      lines.push(text);
    }
    lines.push("");

    return lines.join("\n");
  }

  // Render a vCon as a WebVTT subtitle file. Timestamps are relative to
  // doc.created_at (the meeting start). Consecutive utterances from the
  // same speaker are kept as separate cues so they stay readable in
  // standard players. Each cue uses the WebVTT speaker tag (<v Name>).
  function toVtt(doc) {
    if (!doc) return "WEBVTT\n";
    const parties = Array.isArray(doc.parties) ? doc.parties : [];
    const dialog = Array.isArray(doc.dialog) ? doc.dialog : [];
    const t0 = Date.parse(doc.created_at);
    const baseMs = Number.isFinite(t0) ? t0 : null;

    function fmtTime(ms) {
      if (!Number.isFinite(ms) || ms < 0) ms = 0;
      const h = Math.floor(ms / 3_600_000);
      const m = Math.floor((ms % 3_600_000) / 60_000);
      const s = Math.floor((ms % 60_000) / 1000);
      const msec = Math.floor(ms % 1000);
      const pad = (n, w = 2) => String(n).padStart(w, "0");
      return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(msec, 3)}`;
    }

    function escapeCue(s) {
      return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    const lines = ["WEBVTT", ""];
    let cueIdx = 1;
    for (const d of dialog) {
      const startAbs = Date.parse(d.start);
      if (!Number.isFinite(startAbs)) continue;
      const startRel = baseMs != null ? startAbs - baseMs : 0;
      const durationMs = (typeof d.duration === "number" ? d.duration : 0) * 1000;
      const endRel = startRel + (durationMs > 0 ? durationMs : 2000);
      const idx = Array.isArray(d.parties) ? d.parties[0] : null;
      const speaker = parties[idx]?.name || "unknown";
      const text = (d.body || "").trim();
      if (!text) continue;
      lines.push(String(cueIdx++));
      lines.push(`${fmtTime(startRel)} --> ${fmtTime(endRel)}`);
      lines.push(`<v ${escapeCue(speaker)}>${escapeCue(text)}`);
      lines.push("");
    }
    return lines.join("\n");
  }

  ns.vcon = { uuidv4, assemble, toMarkdown, toVtt };
})(typeof self !== "undefined" ? self : window);
