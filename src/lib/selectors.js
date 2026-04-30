// Meet DOM selectors. Centralized here so when Google ships a UI change,
// there's one file to update.
//
// Strategy: prefer aria-label matching over class names. Class names in Meet
// are obfuscated (e.g. ".VfPpkd-Bz112c-LgbsSe") and change frequently.
// aria-labels are translated but stable across releases — match by substring
// in multiple languages.

(function () {
  const ns = (window.MeetVcon = window.MeetVcon || {});
  if (ns.selectors) return;

  // Substrings that appear in the captions-toggle aria-label across locales.
  // Matched case-insensitively. Add new entries as they're observed.
  const CAPTION_LABEL_SUBSTRINGS = [
    "captions",        // en
    "subtitles",       // en (some variants)
    "subtítulos",      // es
    "legendas",        // pt-BR / pt-PT
    "sous-titres",     // fr
    "untertitel",      // de
    "sottotitoli",     // it
    "ondertiteling",   // nl
    "字幕",             // ja, zh
    "자막",             // ko
    "субтитры",        // ru
  ];

  function findCaptionsToggleButton() {
    const buttons = document.querySelectorAll(
      'button[aria-label], [role="button"][aria-label]'
    );
    for (const btn of buttons) {
      const label = (btn.getAttribute("aria-label") || "").toLowerCase();
      if (!label) continue;
      for (const needle of CAPTION_LABEL_SUBSTRINGS) {
        if (label.includes(needle.toLowerCase())) return btn;
      }
    }
    return null;
  }

  // The captions overlay container. Meet renders captions inside an element
  // with `aria-live="polite"` and a region role. Multiple such regions exist;
  // captions specifically have role="region" with an aria-label that includes
  // a captions-related substring, OR they live inside a container with
  // jsname="YSxPC" (observed but unstable — used as last-resort fallback).
  function findCaptionsOverlay() {
    // Primary: a region/live element whose aria-label mentions captions.
    const candidates = document.querySelectorAll(
      '[aria-live="polite"], [role="region"]'
    );
    for (const el of candidates) {
      const label = (el.getAttribute("aria-label") || "").toLowerCase();
      for (const needle of CAPTION_LABEL_SUBSTRINGS) {
        if (label.includes(needle.toLowerCase())) return el;
      }
    }
    return null;
  }

  // Are captions currently active on this page?
  // Two signals — either is sufficient:
  //   1. The captions toggle button has aria-pressed="true".
  //   2. A captions overlay container is present and visible.
  function areCaptionsActive() {
    const btn = findCaptionsToggleButton();
    if (btn) {
      const pressed = btn.getAttribute("aria-pressed");
      if (pressed === "true") return true;
      if (pressed === "false") {
        // Definitive: button says off. Trust it.
        return false;
      }
      // No aria-pressed — fall through to overlay detection.
    }
    const overlay = findCaptionsOverlay();
    return !!overlay;
  }

  // Are we currently in a call? Meet shows specific in-call controls
  // (mic toggle, hangup) only when in a call. We check for the hangup button
  // by aria-label as the most reliable signal.
  const HANGUP_LABEL_SUBSTRINGS = [
    "leave call",
    "leave meeting",
    "end call",
    "salir de la llamada",
    "sair da chamada",
    "quitter l'appel",
    "anruf verlassen",
  ];

  function isInCall() {
    const buttons = document.querySelectorAll("button[aria-label]");
    for (const btn of buttons) {
      const label = (btn.getAttribute("aria-label") || "").toLowerCase();
      for (const needle of HANGUP_LABEL_SUBSTRINGS) {
        if (label.includes(needle.toLowerCase())) return true;
      }
    }
    return false;
  }

  ns.selectors = {
    findCaptionsToggleButton,
    findCaptionsOverlay,
    areCaptionsActive,
    isInCall,
  };
})();
