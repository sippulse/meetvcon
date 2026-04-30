// Popup: shows pending-delivery queue and recent meetings.
// Reads chrome.storage.local. Sends retry/discard messages to the SW.

const els = {
  webhookStatus: document.getElementById("webhookStatus"),
  openOptions: document.getElementById("openOptions"),
  openOptionsInline: document.getElementById("openOptionsInline"),
  queueSection: document.getElementById("queueSection"),
  queueCount: document.getElementById("queueCount"),
  queueList: document.getElementById("queueList"),
  meetingsCount: document.getElementById("meetingsCount"),
  meetingsList: document.getElementById("meetingsList"),
  meetingsEmpty: document.getElementById("meetingsEmpty"),
};

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return t;
  const dt = d.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${dt} ${t}`;
}

function fmtDuration(startIso, endIso) {
  if (!startIso || !endIso) return "";
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${m}m` : `${h}h`;
}

function escape(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function renderQueueItem(item) {
  const li = document.createElement("li");
  const subject = item.vcon?.subject || item.vcon?.attachments?.[0]?.body?.meeting_code || "(unknown)";
  const kind = item.deliveryKind || "delivery";
  const next = item.nextAttemptAt ? fmtTime(item.nextAttemptAt) : "";
  li.innerHTML = `
    <div class="row">
      <span class="title" title="${escape(subject)}">${escape(subject)}</span>
      <span class="meta">${escape(kind)}</span>
    </div>
    <div class="detail">
      attempt ${item.attempts ?? 0}/6${next ? ` · next at ${escape(next)}` : ""}
      ${item.lastError ? `<br/><span class="err">${escape(item.lastError)}</span>` : ""}
    </div>
    <div class="actions">
      <button data-action="retry" data-id="${escape(item.id)}">Retry now</button>
      <button data-action="download" data-id="${escape(item.id)}">Download vCon</button>
      <button data-action="discard" data-id="${escape(item.id)}" class="danger">Discard</button>
    </div>
  `;
  return li;
}

function renderMeetingItem(m) {
  const li = document.createElement("li");
  const status = m.status || "delivered";
  const iconClass =
    status === "delivered" ? "ok" :
    status === "queued"    ? "queue" :
    status === "skipped_no_captions" ? "skip" :
    status === "failed"    ? "fail" : "skip";
  const iconChar =
    status === "delivered" ? "✓" :
    status === "queued"    ? "⟳" :
    status === "skipped_no_captions" ? "—" :
    status === "failed"    ? "✕" : "·";

  const dur = fmtDuration(m.startedAt, m.endedAt);
  const subject = m.subject || m.meetingId || "(no title)";
  const utt =
    status === "skipped_no_captions"
      ? "no captions"
      : `${m.utteranceCount ?? 0} utterance${m.utteranceCount === 1 ? "" : "s"}`;

  li.innerHTML = `
    <div class="row">
      <span class="title" title="${escape(subject)}">
        <span class="status-icon ${iconClass}">${iconChar}</span>${escape(subject)}
      </span>
      <span class="meta">${escape(fmtTime(m.endedAt || m.startedAt))}</span>
    </div>
    <div class="detail">${escape(utt)}${dur ? ` · ${escape(dur)}` : ""}</div>
  `;
  return li;
}

async function loadConfig() {
  const { config } = await chrome.storage.local.get("config");
  const cfg = config || {};
  if (!cfg.webhookUrl) {
    els.webhookStatus.classList.remove("hidden");
  }
}

async function loadQueue() {
  const { queue } = await chrome.storage.local.get("queue");
  const items = queue || [];
  els.queueList.replaceChildren();
  if (items.length === 0) {
    els.queueSection.classList.add("hidden");
    return;
  }
  els.queueSection.classList.remove("hidden");
  els.queueCount.textContent = items.length;
  for (const item of items) {
    els.queueList.appendChild(renderQueueItem(item));
  }
}

async function loadMeetings() {
  const { meetings } = await chrome.storage.local.get("meetings");
  const items = meetings || [];
  els.meetingsList.replaceChildren();
  els.meetingsCount.textContent = items.length;
  if (items.length === 0) {
    els.meetingsEmpty.classList.remove("hidden");
    return;
  }
  els.meetingsEmpty.classList.add("hidden");
  for (const m of items.slice(0, 25)) {
    els.meetingsList.appendChild(renderMeetingItem(m));
  }
}

async function refresh() {
  await Promise.all([loadConfig(), loadQueue(), loadMeetings()]);
}

async function downloadVcon(id) {
  const { queue } = await chrome.storage.local.get("queue");
  const item = (queue || []).find((q) => q.id === id);
  if (!item) return;
  const blob = new Blob([JSON.stringify(item.vcon, null, 2)], {
    type: "application/vcon+json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${item.vcon?.uuid || "meetvcon"}.vcon.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

els.queueList.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.dataset.id;
  const action = btn.dataset.action;
  btn.disabled = true;
  try {
    if (action === "retry") {
      const r = await chrome.runtime.sendMessage({ type: "retry_queue_item", id });
      if (!r?.ok) {
        btn.disabled = false;
        btn.textContent = `Retry (${r?.error || "failed"})`;
        return;
      }
    } else if (action === "discard") {
      await chrome.runtime.sendMessage({ type: "discard_queue_item", id });
    } else if (action === "download") {
      await downloadVcon(id);
      btn.disabled = false;
      return;
    }
    await refresh();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = `Error: ${err.message}`;
  }
});

function openOptions(e) {
  e?.preventDefault();
  chrome.runtime.openOptionsPage();
}

els.openOptions.addEventListener("click", openOptions);
els.openOptionsInline.addEventListener("click", openOptions);

// Live refresh while the popup is open: chrome.storage events fire when
// the SW updates queue/meetings.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.queue || changes.meetings || changes.config) refresh();
});

refresh();
