// On-device meeting summarization via Chrome's built-in Summarizer API
// (Gemini Nano, Chrome 138+). Nothing leaves the device: the model runs
// locally. When the API or model is unavailable, callers degrade
// gracefully (vCon ships without analysis, email ships transcript-only).
//
// Model download requires a user gesture, so it is triggered from the
// options page (requestDownload); the service worker only summarizes
// when availability() is already "available".

(function (root) {
  const ns = (root.MeetVcon = root.MeetVcon || {});
  if (ns.summarizer) return;

  const CREATE_OPTS = {
    type: "key-points",
    format: "plain-text",
    length: "long",
  };

  // Fallback input cap (chars) when the API can't report quotas.
  // Roughly ~3k tokens — safely under Gemini Nano's summarizer window.
  const FALLBACK_MAX_CHARS = 12_000;

  // "unsupported" | "unavailable" | "downloadable" | "downloading" | "available"
  async function availability() {
    if (typeof Summarizer === "undefined") return "unsupported";
    try {
      return await Summarizer.availability();
    } catch {
      return "unsupported";
    }
  }

  // Trigger the model download. Must run inside a user gesture (options
  // page click). onProgress receives 0..1.
  async function requestDownload(onProgress) {
    const s = await Summarizer.create({
      ...CREATE_OPTS,
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          try {
            onProgress?.(e.loaded);
          } catch {}
        });
      },
    });
    s.destroy?.();
  }

  // Meeting record → "Speaker: text" lines for the model.
  function transcriptText(record) {
    const lines = [];
    for (const u of record.utterances || []) {
      const text = (u.text || "").trim();
      if (!text) continue;
      lines.push(`${u.speaker || "unknown"}: ${text}`);
    }
    return lines.join("\n");
  }

  async function fits(s, text) {
    try {
      if (
        typeof s.measureInputUsage === "function" &&
        typeof s.inputQuota === "number"
      ) {
        return (await s.measureInputUsage(text)) <= s.inputQuota;
      }
    } catch {}
    return text.length <= FALLBACK_MAX_CHARS;
  }

  // Summarize text that may exceed the model's input quota: split in
  // halves (on line boundaries) until chunks fit, then summarize the
  // combined partial summaries. Depth-capped; worst case truncates.
  async function summarizeFitting(s, text, depth = 0) {
    if (await fits(s, text)) return await s.summarize(text);
    if (depth >= 4) return await s.summarize(text.slice(0, FALLBACK_MAX_CHARS));
    const lines = text.split("\n");
    if (lines.length < 2) {
      return await s.summarize(text.slice(0, FALLBACK_MAX_CHARS));
    }
    const mid = Math.ceil(lines.length / 2);
    const a = await summarizeFitting(s, lines.slice(0, mid).join("\n"), depth + 1);
    const b = await summarizeFitting(s, lines.slice(mid).join("\n"), depth + 1);
    const merged = [a, b].filter(Boolean).join("\n");
    if (!merged) return null;
    return await summarizeFitting(
      s,
      `Partial summaries of consecutive parts of one meeting:\n${merged}`,
      depth + 1
    );
  }

  // Returns the summary string, or null when unavailable / on any error.
  async function summarizeRecord(record) {
    if ((await availability()) !== "available") return null;
    const text = transcriptText(record);
    if (!text) return null;
    let s = null;
    try {
      s = await Summarizer.create({
        ...CREATE_OPTS,
        sharedContext: `Transcript of a Google Meet call titled "${
          record.subject || record.meetingId || "untitled"
        }". Each line is "Speaker: what they said".`,
      });
      const summary = await summarizeFitting(s, text);
      return typeof summary === "string" && summary.trim() ? summary.trim() : null;
    } catch (err) {
      ns.log?.warn?.("summarizer failed", err);
      return null;
    } finally {
      s?.destroy?.();
    }
  }

  ns.summarizer = { availability, requestDownload, summarizeRecord };
})(typeof self !== "undefined" ? self : window);
