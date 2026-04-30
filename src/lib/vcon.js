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
      const name = u.speaker || "unknown";
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
      const idx = speakerToIndex.get(u.speaker || "unknown");
      const dialog = {
        type: "text",
        start: u.start,
        parties: [idx],
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
  // opts:   { capturedBy, deliveryKind, capturedByUser }
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
      captured_by: opts.capturedBy || "MeetVcon",
      captions_enabled: record.captionsEnabled !== false,
      delivery_kind: opts.deliveryKind || "final",
    };
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
      analysis: [],
      attachments: [
        {
          type: "meeting_metadata",
          encoding: "json",
          body: metadata,
        },
      ],
    };
  }

  ns.vcon = { uuidv4, assemble };
})(typeof self !== "undefined" ? self : window);
