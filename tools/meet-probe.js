// Paste this into the DevTools console of a live Google Meet call, with the
// extension's own rules copied verbatim from src/lib/selectors.js. It prints,
// once a second for fifteen seconds, which participant tiles it finds, the
// name it reads from each, and which ones it believes are speaking.
//
// Ask two people to talk while it runs. If the "speaking" column names the
// person actually talking, the extension can name remote voices without
// Google captions. If it stays empty, or names everyone at once, paste the
// output back and the selectors get corrected against the real DOM.

(() => {
  const TILE_SELECTOR = "[data-participant-id], [data-requested-participant-id]";
  const NOT_A_NAME = /^(you|presenting|apresentando|tú|vous|pinned|fixado|muted|sem som)$/i;

  function tileName(tile) {
    const label = (tile.getAttribute("aria-label") || "").trim();
    if (label && !NOT_A_NAME.test(label)) return label;
    for (const node of tile.querySelectorAll("div, span")) {
      if (node.childElementCount) continue;
      const text = (node.textContent || "").trim();
      if (text && text.length <= 60 && !NOT_A_NAME.test(text)) return text;
    }
    return "";
  }

  function animatedParts(tile) {
    const names = [];
    for (const node of tile.querySelectorAll("div, span")) {
      const style = getComputedStyle(node);
      if (style.animationName && style.animationName !== "none" && style.visibility !== "hidden") {
        names.push(style.animationName);
      }
    }
    return names;
  }

  let ticks = 0;
  const timer = setInterval(() => {
    const tiles = [...document.querySelectorAll(TILE_SELECTOR)];
    const rows = tiles.map((tile) => {
      const animations = animatedParts(tile);
      return {
        name: tileName(tile) || "(no name found)",
        speaking: animations.length > 0,
        animations: animations.slice(0, 3).join(", "),
      };
    });
    console.log(`t+${++ticks}s  tiles=${tiles.length}`, rows.length ? rows : "(no tiles matched)");
    if (ticks >= 15) {
      clearInterval(timer);
      console.log("done. copy everything above.");
    }
  }, 1000);
})();
