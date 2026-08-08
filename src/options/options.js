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
  emailEnabled: false,
  emailProvider: "resend",
  emailApiKey: "",
  emailFrom: "",
  emailTo: "",
  emailMailgunDomain: "",
  summaryEnabled: false,
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
  summaryEnabled: document.getElementById("summaryEnabled"),
  summaryStatus: document.getElementById("summaryStatus"),
  summaryDownload: document.getElementById("summaryDownload"),
  emailEnabled: document.getElementById("emailEnabled"),
  emailProvider: document.getElementById("emailProvider"),
  emailApiKey: document.getElementById("emailApiKey"),
  emailMailgunDomain: document.getElementById("emailMailgunDomain"),
  mailgunDomainLabel: document.getElementById("mailgunDomainLabel"),
  emailFrom: document.getElementById("emailFrom"),
  emailTo: document.getElementById("emailTo"),
  emailToHint: document.getElementById("emailToHint"),
  testEmail: document.getElementById("testEmail"),
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
  els.summaryEnabled.checked = !!cfg.summaryEnabled;
  els.emailEnabled.checked = !!cfg.emailEnabled;
  els.emailProvider.value = cfg.emailProvider || "resend";
  els.emailApiKey.value = cfg.emailApiKey;
  els.emailMailgunDomain.value = cfg.emailMailgunDomain;
  els.emailFrom.value = cfg.emailFrom;
  els.emailTo.value = cfg.emailTo;
  syncIntervalVisibility();
  syncMailgunVisibility();
  showProfileEmailHint();
  refreshSummaryStatus();
}

function syncIntervalVisibility() {
  const visible = els.modeSnap.checked;
  els.intervalLabel.classList.toggle("hidden", !visible);
}

function syncMailgunVisibility() {
  const visible = els.emailProvider.value === "mailgun";
  els.mailgunDomainLabel.classList.toggle("hidden", !visible);
}

// Show the Chrome profile email (the default recipient) as placeholder.
function showProfileEmailHint() {
  if (!chrome.identity?.getProfileUserInfo) return;
  try {
    chrome.identity.getProfileUserInfo({ accountStatus: "ANY" }, (info) => {
      if (chrome.runtime.lastError || !info?.email) return;
      els.emailTo.placeholder = info.email;
      els.emailToHint.textContent = `Comma-separated. Leave empty to send to your Chrome profile email (${info.email}).`;
    });
  } catch {}
}

// ---- on-device summarizer status -------------------------------------

const SUMMARY_STATUS_TEXT = {
  unsupported:
    "Not supported by this browser. Requires Chrome 138+ with built-in AI (Gemini Nano) on capable hardware.",
  unavailable:
    "The on-device model is unavailable on this device (insufficient hardware or disabled by policy).",
  downloadable: "Model not downloaded yet.",
  downloading: "Model download in progress…",
  available: "Model ready. Summaries are generated on-device.",
};

async function refreshSummaryStatus() {
  const availability = await self.MeetVcon.summarizer.availability();
  els.summaryStatus.textContent =
    SUMMARY_STATUS_TEXT[availability] || availability;
  els.summaryDownload.classList.toggle(
    "hidden",
    availability !== "downloadable"
  );
}

async function downloadSummaryModel() {
  els.summaryDownload.disabled = true;
  els.summaryStatus.textContent = "Downloading model… 0%";
  try {
    await self.MeetVcon.summarizer.requestDownload((loaded) => {
      els.summaryStatus.textContent = `Downloading model… ${Math.round(
        loaded * 100
      )}%`;
    });
  } catch (err) {
    els.summaryStatus.textContent = `Download failed: ${err?.message || err}`;
    els.summaryDownload.disabled = false;
    return;
  }
  els.summaryDownload.disabled = false;
  await refreshSummaryStatus();
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
    summaryEnabled: els.summaryEnabled.checked,
    emailEnabled: els.emailEnabled.checked,
    emailProvider: els.emailProvider.value,
    emailApiKey: els.emailApiKey.value.trim(),
    emailMailgunDomain: els.emailMailgunDomain.value.trim(),
    emailFrom: els.emailFrom.value.trim(),
    emailTo: els.emailTo.value.trim(),
  };
}

function setStatus(msg, kind) {
  els.status.textContent = msg;
  els.status.className = kind || "";
}

// Build the host pattern for chrome.permissions from a URL.
// e.g. https://webhook.site/abc → https://webhook.site/*
function originPatternFor(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

// Returns true if permission is already granted or was granted just now.
// Must be called inside a user-gesture handler (click) for request() to succeed.
async function ensurePermission(url) {
  const pattern = originPatternFor(url);
  if (!pattern) return false;
  const has = await chrome.permissions.contains({ origins: [pattern] });
  if (has) return true;
  return await chrome.permissions.request({ origins: [pattern] });
}

async function save(e) {
  e.preventDefault();
  const cfg = readForm();
  if (cfg.webhookUrl && !/^https:\/\//i.test(cfg.webhookUrl)) {
    setStatus("Webhook URL must start with https://", "error");
    return;
  }
  if (cfg.webhookUrl) {
    const granted = await ensurePermission(cfg.webhookUrl);
    if (!granted) {
      await chrome.storage.local.set({ config: cfg });
      setStatus(
        "Saved, but permission was denied. Click Save again to retry. Delivery will fail until you grant access.",
        "error"
      );
      return;
    }
  }
  if (cfg.emailEnabled) {
    const host = self.MeetVcon.email.providerHost(cfg);
    if (host) {
      const granted = await ensurePermission(`https://${host}/`);
      if (!granted) {
        await chrome.storage.local.set({ config: cfg });
        setStatus(
          `Saved, but permission for ${host} was denied. Email delivery will fail until you grant access.`,
          "error"
        );
        return;
      }
    }
  }
  await chrome.storage.local.set({ config: cfg });
  setStatus("Saved.", "ok");
}

async function sendTestEmail() {
  setStatus("Sending test email…");
  const cfg = readForm();
  if (!self.MeetVcon.email.configComplete(cfg)) {
    setStatus(
      "Fill in the email provider, API key and From address first.",
      "error"
    );
    return;
  }
  const host = self.MeetVcon.email.providerHost(cfg);
  const granted = await ensurePermission(`https://${host}/`);
  if (!granted) {
    setStatus(`Permission denied for ${host}.`, "error");
    return;
  }
  await chrome.storage.local.set({ config: cfg });
  try {
    const result = await chrome.runtime.sendMessage({ type: "test_email" });
    if (result?.ok) {
      setStatus(`Test email sent (HTTP ${result.status}). Check your inbox.`, "ok");
    } else {
      setStatus(`Test email failed: ${result?.error || "unknown error"}`, "error");
    }
  } catch (err) {
    setStatus(`Test email failed: ${err.message}`, "error");
  }
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
  const granted = await ensurePermission(cfg.webhookUrl);
  if (!granted) {
    setStatus("Permission denied for that webhook host.", "error");
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
els.testEmail.addEventListener("click", sendTestEmail);
els.modeEnd.addEventListener("change", syncIntervalVisibility);
els.modeSnap.addEventListener("change", syncIntervalVisibility);
els.emailProvider.addEventListener("change", syncMailgunVisibility);
els.summaryDownload.addEventListener("click", downloadSummaryModel);

load();
