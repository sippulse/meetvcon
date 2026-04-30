// Options page logic. Reads/writes config via chrome.storage.local
// (per CLAUDE.md rule #1: webhook URL, bearer token, and HMAC secret
// are user-supplied and stored only in chrome.storage.local — never
// hardcoded in source).

const DEFAULT_CONFIG = {
  webhookUrl: "",
  bearerToken: "",
  hmacSecret: "",
  deliveryMode: "end_of_call",
  snapshotIntervalMin: 5,
  includeSpeakerEmail: false,
  includeCapturerEmail: true,
};

const els = {
  form: document.getElementById("form"),
  webhookUrl: document.getElementById("webhookUrl"),
  bearerToken: document.getElementById("bearerToken"),
  hmacSecret: document.getElementById("hmacSecret"),
  modeEnd: document.getElementById("modeEnd"),
  modeSnap: document.getElementById("modeSnap"),
  snapshotIntervalMin: document.getElementById("snapshotIntervalMin"),
  intervalLabel: document.getElementById("intervalLabel"),
  includeSpeakerEmail: document.getElementById("includeSpeakerEmail"),
  includeCapturerEmail: document.getElementById("includeCapturerEmail"),
  save: document.getElementById("save"),
  test: document.getElementById("test"),
  status: document.getElementById("status"),
};

async function load() {
  const { config } = await chrome.storage.local.get("config");
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  els.webhookUrl.value = cfg.webhookUrl;
  els.bearerToken.value = cfg.bearerToken;
  els.hmacSecret.value = cfg.hmacSecret;
  els.modeEnd.checked = cfg.deliveryMode === "end_of_call";
  els.modeSnap.checked = cfg.deliveryMode === "periodic_snapshot";
  els.snapshotIntervalMin.value = cfg.snapshotIntervalMin;
  els.includeSpeakerEmail.checked = !!cfg.includeSpeakerEmail;
  els.includeCapturerEmail.checked = !!cfg.includeCapturerEmail;
  syncIntervalVisibility();
}

function syncIntervalVisibility() {
  const visible = els.modeSnap.checked;
  els.intervalLabel.classList.toggle("hidden", !visible);
}

function readForm() {
  const mode = els.modeSnap.checked ? "periodic_snapshot" : "end_of_call";
  let interval = parseInt(els.snapshotIntervalMin.value, 10);
  if (!Number.isFinite(interval)) interval = 5;
  interval = Math.max(1, Math.min(60, interval));
  return {
    webhookUrl: els.webhookUrl.value.trim(),
    bearerToken: els.bearerToken.value,
    hmacSecret: els.hmacSecret.value,
    deliveryMode: mode,
    snapshotIntervalMin: interval,
    includeSpeakerEmail: els.includeSpeakerEmail.checked,
    includeCapturerEmail: els.includeCapturerEmail.checked,
  };
}

function setStatus(msg, kind) {
  els.status.textContent = msg;
  els.status.className = kind || "";
}

async function save(e) {
  e.preventDefault();
  const cfg = readForm();
  if (cfg.webhookUrl && !/^https:\/\//i.test(cfg.webhookUrl)) {
    setStatus("Webhook URL must start with https://", "error");
    return;
  }
  await chrome.storage.local.set({ config: cfg });
  setStatus("Saved.", "ok");
}

async function sendTest() {
  setStatus("Sending test payload…");
  // Save current form first so the SW reads up-to-date config.
  const cfg = readForm();
  if (!cfg.webhookUrl) {
    setStatus("Enter a webhook URL first.", "error");
    return;
  }
  if (!/^https:\/\//i.test(cfg.webhookUrl)) {
    setStatus("Webhook URL must start with https://", "error");
    return;
  }
  await chrome.storage.local.set({ config: cfg });
  try {
    const result = await chrome.runtime.sendMessage({ type: "test_webhook" });
    if (result?.ok) {
      setStatus(`Test payload delivered (HTTP ${result.status}).`, "ok");
    } else {
      setStatus(`Test failed: ${result?.error || "unknown error"}`, "error");
    }
  } catch (err) {
    setStatus(`Test failed: ${err.message}`, "error");
  }
}

els.form.addEventListener("submit", save);
els.test.addEventListener("click", sendTest);
els.modeEnd.addEventListener("change", syncIntervalVisibility);
els.modeSnap.addEventListener("change", syncIntervalVisibility);

load();
