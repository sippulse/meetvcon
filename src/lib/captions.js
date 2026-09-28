// Pure caption parsing helpers shared by the content script and unit tests.

(function (root) {
  const ns = (root.MeetVcon = root.MeetVcon || {});
  if (ns.captions) return;

  function parseCaptionText(rawText) {
    const lines = String(rawText || "")
      .trim()
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) return { speaker: null, text: "" };
    if (lines.length === 1) return { speaker: null, text: lines[0] };

    const candidate = lines[0];
    const looksLikeSpeaker =
      candidate.length <= 60 &&
      !/[.!?…:]$/.test(candidate) &&
      !candidate.includes("  ");

    return looksLikeSpeaker
      ? { speaker: candidate, text: lines.slice(1).join(" ") }
      : { speaker: null, text: lines.join(" ") };
  }

  ns.captions = { parseCaptionText };
})(typeof self !== "undefined" ? self : window);
