# MeetVcon — Product Requirements Document

**Status:** Draft v0.1
**Owner:** Flavio (flavio@sippulse.com)
**Last updated:** 2026-04-30

---

## 1. Summary

MeetVcon is a Chrome extension that transcribes Google Meet conversations in real time and, at the end of the meeting, posts the full transcript to a user-configured HTTPS webhook. The webhook payload is formatted according to the IETF **vCon** standard (Virtualized Conversation, JSON), making the output directly consumable by CRMs, ticketing systems, LLM pipelines, and conversation-analytics platforms without custom adapters.

## 2. Problem

Existing Google Meet transcribers (Otter, Tactiq, Scribbl, MeetScribe) save transcripts inside their own UI or sync to proprietary cloud accounts. Teams that want to push transcripts into their **own** systems (a CRM, a knowledge base, a workflow engine, an LLM agent) have to:

- Manually export and re-upload after each meeting, **or**
- Pay for a SaaS plan and use whatever integrations the vendor offers, **or**
- Run a recording bot that joins the call as a participant (intrusive, requires admin approval, often blocked).

There is no lightweight, self-hosted-friendly extension that takes the transcript and **delivers it to an arbitrary HTTPS endpoint in a standard format** the moment the meeting ends.

## 3. Goals

- **G1.** Capture Google Meet transcripts in real time without a bot joining the call.
- **G2.** Detect end-of-meeting reliably and POST the complete transcript to a user-configured HTTPS webhook.
- **G3.** Format the payload as a valid vCon JSON object (IETF draft-ietf-vcon).
- **G4.** Keep all data on the user's device until the moment of webhook delivery — no third-party backend.
- **G5.** Provide retry-with-backoff and a local outbox for failed deliveries.
- **G6.** Use **only** Google Meet's built-in browser captions as the transcription source. No external speech-to-text service, no audio processing, no LLM, no cloud STT API. The extension is a thin layer that reads what Meet already displays on screen.

## 4. Non-goals (v1)

- Audio or video recording — transcript only.
- **Any external speech-to-text or AI service** (Whisper, Deepgram, Google STT API, OpenAI, Anthropic, etc.). Transcription quality is whatever Meet's browser captions provide — nothing more, nothing less.
- Audio capture or processing of any kind (no `tabCapture`, no `getUserMedia`, no `MediaRecorder`).
- Multi-platform support (Zoom, Teams) — Meet only in v1.
- Real-time **per-utterance** streaming. Periodic snapshot delivery (every N minutes, see §6.3.1) is supported, but we do not push individual utterances as they arrive.
- **Delta-mode** delivery (sending only new utterances since the last POST, requiring receiver-side stitching). Snapshot mode covers the same use cases with simpler receiver logic; delta mode is deferred to a possible v2 if there is demand for bandwidth optimization on long calls.
- Built-in summarization, translation, or LLM features — those are the receiver's job.
- Cloud sync, multi-device transcript history, team sharing.
- Speaker diarization beyond what Meet's captions already provide.

## 5. Target users & stories

**U1. Solo professional with a CRM.** "I want every client call's transcript to land in my CRM under the right contact, automatically, without me copy-pasting."

**U2. Developer building an LLM agent.** "I want my Meet calls to be ingested by my own pipeline so an agent can summarize, extract action items, and update tickets."

**U3. Support team lead.** "I want every internal escalation call's transcript posted to our internal logging system in vCon format for compliance and search."

**U4. Researcher.** "I want my interview transcripts saved to my own server, in a standard format, with no third-party SaaS in between."

## 6. Functional requirements

### 6.1 Transcript capture

- **F1.1** Inject a content script on `https://meet.google.com/*`.
- **F1.2** Detect when the user is in an active call (Meet's in-call DOM markers).
- **F1.3** Read live captions from the Meet captions overlay DOM. Captions must be enabled by the user — extension surfaces a clear prompt if they are off (see §6.1.1).
- **F1.4** Capture per-utterance: speaker name (as shown by Meet), start timestamp (ISO 8601, UTC), text.
- **F1.5** De-duplicate caption updates (Meet emits progressive caption text — store final form per utterance).
- **F1.6** Buffer utterances in `chrome.storage.session` keyed by meeting ID.

### 6.1.1 Captions-off handling and auto-enable strategy

Because the extension's only transcription source is Meet's built-in captions, a call with captions disabled produces no transcript. The extension must handle this transparently — never silently "succeed" with an empty payload — and should proactively keep captions enabled for the duration of the call.

**Background.** Google Meet provides no official API to toggle captions from a Chrome extension. Every extension in this category (MeetScribe, MeetCaptioner, Meet Enhancement Suite, Laxis, etc.) achieves auto-enable by simulating user interaction with Meet's existing UI. This is fragile against Meet DOM changes and must be defensive.

**Auto-enable strategy (in priority order):**

1. **`aria-label` click — primary.** Locate the captions toggle button via `button[aria-label*="captions" i]` (case-insensitive, language-aware: `"Turn on captions"`, `"Activar subtítulos"`, `"Ativar legendas"`, `"Activer les sous-titres"`, etc.). Dispatch a synthetic `click()`. Stable across Meet versions because aria-labels rarely change.
2. **Keyboard shortcut fallback.** If selector lookup fails, dispatch a `keydown` event with `key: "c"` to `document.body`. Meet's built-in shortcut toggles captions. Requires the Meet tab to have focus.
3. **Watchdog loop.** After enabling, run a `setInterval` (every 10 seconds) that:
   - Verifies the captions overlay container is present in the DOM.
   - If absent → captions were turned off. Attempt re-enable using strategy 1, then 2.
   - Maximum 3 re-enable attempts per minute to avoid fighting the user if they deliberately turned captions off.
4. **Respect explicit user opt-out.** If the user clicks "Disable for this call" in our in-call panel, the watchdog stops trying to re-enable captions for that meeting.

**Functional requirements:**

- **F1.1.1** On entering a call, detect whether captions are currently active (presence of the Meet captions overlay container in the DOM).
- **F1.1.2** Run the auto-enable strategy above when captions are off. If all three steps fail, the in-call panel displays a banner: *"Captions are off — click 'CC' in Meet to enable captions for transcription."* with a "Try again" button that retries the strategy.
- **F1.1.3** A red/grey indicator on the panel shows live status: **green** = captions on and capture active; **grey** = captions off, no capture.
- **F1.1.4** If captions are toggled off **mid-call**, capture pauses and the watchdog attempts re-enable (subject to the rate limit and user opt-out). Already-captured utterances are retained. When captions resume, capture resumes — the resulting transcript will have a gap, which is reflected in the vCon `dialog[]` timestamps (no synthetic content, no interpolation).
- **F1.1.5** At end-of-meeting, the finalization logic checks whether **any** utterances were captured:
  - **≥1 utterance captured** → assemble vCon and POST as normal.
  - **Zero utterances captured** → do **not** POST a vCon. Instead, log the meeting locally with status `skipped_no_captions`, surface it in the popup with a clear explanation, and offer a one-click "Send empty meeting notification" action that POSTs a minimal vCon with `dialog: []` and an `attachments[]` entry of type `meeting_metadata` carrying `{ "captions_enabled": false, "reason": "captions_off_entire_call" }`. Default is **not** to send.
- **F1.1.6** Configuration option (off by default): *"Always notify webhook even when no transcript was captured"* — when enabled, F1.1.5's "skip" path becomes an automatic POST of the empty-dialog vCon, so receivers can record that a call happened.
- **F1.1.7** The vCon `attachments[]` always includes `captions_enabled: true|false` so the receiver can distinguish "silent meeting" from "captions weren't on."

> **Why this matters:** Per goal G6, MeetVcon does no audio processing of its own. A captions-off call is genuinely uncaptureable — surfacing that clearly is more honest than producing a misleading empty transcript.

### 6.2 End-of-meeting detection

- **F2.1** Trigger finalization when any of:
  - User clicks "Leave call".
  - Meet returns to the post-call screen (`/landing` or post-call URL pattern).
  - Tab is closed while in a call (`beforeunload` from content script, with service worker fallback).
- **F2.2** On finalization: assemble vCon, hand to service worker for delivery, clear session buffer for that meeting.

### 6.3 Webhook delivery

- **F3.1** Service worker POSTs the vCon JSON to the user-configured HTTPS URL.
- **F3.2** Headers:
  - `Content-Type: application/vcon+json`
  - `User-Agent: MeetVcon/<version>`
  - `Authorization: Bearer <token>` if the user configured one.
  - `X-MeetVcon-Signature: sha256=<hmac>` if the user configured a signing secret (HMAC-SHA256 over the body).
  - `X-MeetVcon-Delivery: snapshot|final` indicates whether this POST is a periodic in-progress snapshot or the final end-of-call delivery.
- **F3.3** Reject non-HTTPS URLs at config time. No HTTP allowed.
- **F3.4** Treat 2xx as success. Any other status, network error, or timeout → enter retry queue.
- **F3.5** Retry policy: exponential backoff (30s, 2m, 10m, 1h, 6h, 24h), max 6 attempts. Persist queue in `chrome.storage.local`.
- **F3.6** Manual "Retry now" and "Discard" actions from the extension popup for queued items.

### 6.3.1 Delivery modes

The user chooses one of two delivery modes per install (configurable on the options page):

**Mode A — `end_of_call` (default).** A single POST when the call ends, containing the complete vCon. Simplest for receivers, lowest webhook traffic. Risk: if the tab crashes, the user force-closes the window, or the service worker is evicted before finalization, the transcript is lost.

**Mode B — `periodic_snapshot`.** Every N minutes during an active call (configurable: 1, 5, 10, 30; default 5), POST a **cumulative snapshot vCon** containing every utterance captured so far in the meeting. The same `vcon.uuid` is used for every snapshot. The receiver treats subsequent snapshots as upserts — the latest one is authoritative. A final POST at end-of-call carries `X-MeetVcon-Delivery: final`; intermediate ones carry `X-MeetVcon-Delivery: snapshot`. This mode protects against tab crashes, supports near-real-time receivers, and stays vCon-spec-clean (every payload is a complete, valid vCon).

**Implementation notes:**

- **F3.1.1** In `periodic_snapshot` mode, the service worker schedules a `chrome.alarms` alarm every N minutes while a call is active. The content script signals call start/end via `chrome.runtime.sendMessage` (`{type: "call_started", meetingId, uuid}` and `{type: "call_ended", meetingId}`).
- **F3.1.2** When the snapshot alarm fires: the service worker requests the current utterance buffer from the active Meet tab, assembles a vCon, and POSTs it. If the POST fails, it enters the retry queue like any other delivery.
- **F3.1.3** Snapshots are **not** queued separately per snapshot. Only the latest snapshot per meeting UUID is retained in the retry queue — earlier failed snapshots for the same UUID are superseded. (No point retrying an old snapshot when a newer one is ready to send.)
- **F3.1.4** The end-of-call `final` POST is queued separately and is **never** superseded by a later snapshot, because there can't be one — the call has ended.
- **F3.1.5** Bandwidth caveat: cumulative payload grows over the call (O(call_length × utterances/min)). For a 1-hour call that's typically <500 KB. For multi-hour calls, the user may want to switch to a longer interval. Document this in the options page help text.
- **F3.1.6** Receivers that only care about the final transcript can ignore `snapshot` deliveries by checking the `X-MeetVcon-Delivery` header — same vCon UUID will arrive again with `final` at end-of-call.

### 6.4 Configuration (options page)

- **F4.1** Webhook URL (required, HTTPS-only, validated).
- **F4.2** Bearer token (optional, stored in `chrome.storage.local`).
- **F4.3** HMAC signing secret (optional, stored in `chrome.storage.local`).
- **F4.4** "Send test payload" button — posts a minimal valid vCon to the configured URL and shows the response.
- **F4.5** Toggle: "Include speaker email if visible in Meet" (off by default).
- **F4.6** Per-meeting opt-out: a button in the in-call panel to disable webhook delivery for the current call.
- **F4.7** **Delivery mode** (radio): `end_of_call` (default) or `periodic_snapshot`. When `periodic_snapshot` is selected, a numeric input appears for the interval in minutes (default 5; valid range 1–60). See §6.3.1.
- **F4.8** **Include capturer email** (checkbox, default ON): when enabled, the Chrome profile email of the user running the extension is included in the vCon at `attachments[0].body.captured_by_user.email`, with the Chrome profile id at `captured_by_user.id`. Read via `chrome.identity.getProfileUserInfo({accountStatus: "ANY"})`. Requires the `identity.email` permission, declared in `manifest.json`. Useful for receivers that need to route or attribute transcripts by capturer. Empty if the user is not signed into a Chrome profile.

> **Security note:** Per project rule #1, no credentials are ever hardcoded. The user enters webhook URL, bearer token, and signing secret in the options page; they are stored exclusively in `chrome.storage.local` (which is per-extension and not synced unless the user opts in). Nothing ships in source.

### 6.5 In-call UI

- **F5.1** A small floating panel injected into the Meet page showing:
  - Recording indicator (red dot + "MeetVcon is capturing this meeting").
  - Live utterance count.
  - Webhook target hostname (so the user knows where it's going).
  - "Disable for this call" button.
- **F5.2** Panel must be **visibly present** and not hideable beyond a minimized pill, to support consent transparency (see §10).

### 6.6 Popup UI

- **F6.1** List of recent meetings: title, date, duration, delivery status (delivered / queued / failed).
- **F6.2** For each: view transcript, re-send, download vCon JSON, delete.
- **F6.3** Meetings retained locally for 30 days (configurable), then auto-purged.

## 7. vCon payload format

Conforms to `draft-ietf-vcon-vcon-container` (latest at implementation time). Minimum viable shape:

```json
{
  "vcon": "0.0.1",
  "uuid": "018f3a1c-...-...",
  "created_at": "2026-04-30T14:32:11Z",
  "subject": "Weekly sync — Acme team",
  "parties": [
    { "name": "Flavio Costa", "mailto": "flavio@sippulse.com", "role": "host" },
    { "name": "Jane Doe", "role": "participant" }
  ],
  "dialog": [
    {
      "type": "text",
      "start": "2026-04-30T14:32:15Z",
      "duration": 4.2,
      "parties": [0],
      "body": "Thanks everyone for joining."
    },
    {
      "type": "text",
      "start": "2026-04-30T14:32:20Z",
      "duration": 6.8,
      "parties": [1],
      "body": "Happy to be here. Quick update on the pipeline..."
    }
  ],
  "analysis": [],
  "attachments": [
    {
      "type": "meeting_metadata",
      "encoding": "json",
      "body": {
        "platform": "google_meet",
        "meeting_code": "abc-defg-hij",
        "meeting_url": "https://meet.google.com/abc-defg-hij",
        "captured_by": "MeetVcon/0.1.0",
        "captions_enabled": true,
        "delivery_kind": "final",
        "captured_by_user": {
          "email": "flavio@sippulse.com",
          "id": "1234567890abcdef"
        }
      }
    }
  ]
}
```

Notes:
- `dialog[].parties` references `parties[]` by index.
- Speaker emails are only included if §F4.5 is enabled and Meet exposes them.
- `subject` is taken from the Meet meeting title when available, else empty string.

## 8. Architecture

```
┌──────────────────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│ Content script           │     │ Service worker (MV3) │     │ Options page    │
│ (meet.google.com)        │     │                      │     │                 │
│                          │     │  - delivery queue    │     │  - webhook URL  │
│  - DOM caption scraper   │────▶│  - retry/backoff     │     │  - bearer token │
│  - in-call UI panel      │     │  - HMAC signing      │     │  - HMAC secret  │
│  - end-of-call detector  │     │  - storage cleanup   │     │  - test send    │
└──────────────────────────┘     └──────────┬───────────┘     └─────────────────┘
                                            │
                                            ▼
                                     HTTPS POST (vCon)
                                            │
                                            ▼
                                  user's configured endpoint
```

- **Manifest V3.** Service worker handles all network. Content script never makes the webhook call.
- **Storage:** `chrome.storage.session` for live capture, `chrome.storage.local` for completed meetings, queue, and config.
- **Permissions:** `storage`, `alarms` (for retry and snapshot scheduling), `identity` + `identity.email` (read Chrome profile email for `captured_by_user` — gated by F4.8), host permission `https://meet.google.com/*`. No `<all_urls>`.
- **No telemetry, no remote config, no analytics.**

## 9. Non-functional requirements

- **NFR1. Privacy.** Transcript never leaves the device until POSTed to the user-configured endpoint. No intermediary server.
- **NFR2. Performance.** Caption scraping must add <5% CPU on a mid-range laptop during a 1-hour call. Memory <50 MB.
- **NFR3. Reliability.** ≥99% webhook delivery success when target is reachable, given retry policy. Zero data loss for crashes mid-call (session buffer flushed to local storage every 30s).
- **NFR4. Security.** HTTPS-only delivery. Optional HMAC signing. No third-party scripts. CSP-strict.
- **NFR5. Compatibility.** Chrome 120+, Edge (Chromium) 120+. Brave supported best-effort.

## 10. Legal, consent, and policy

- **Consent UI.** The in-call panel (F5.1) is non-removable during capture. A short consent line ("This call is being transcribed by a Chrome extension") is shown in the panel and copied to the clipboard the first time per session for the host to paste into chat if desired.
- **Two-party consent jurisdictions.** Documentation will warn users about CA, FL, EU, etc. The extension does not record audio/video, only the captions Meet itself generates — but transcripts may still trigger consent obligations.
- **Chrome Web Store policy.** Listing must clearly disclose webhook delivery, the destination is user-configured, and no data goes to MeetVcon servers (because there are none).
- **Google Meet ToS.** Reading the Meet captions DOM is the same approach used by MeetScribe, Tactiq, etc. Risk of ToS breakage if Google changes the DOM — accepted; mitigated by versioned selectors and a fallback warning to the user.

## 11. Failure modes & edge cases

| Case | Behavior |
| --- | --- |
| Captions never enabled during call | No vCon is POSTed by default. Meeting logged locally as `skipped_no_captions`; popup offers manual "send empty notification" action. See §6.1.1. |
| Captions toggled off mid-call | Capture pauses, banner reappears; resumes when captions return. Resulting transcript has a time gap — no synthetic content. |
| Tab crashes mid-call | On next extension load, service worker checks for orphaned session buffer and flushes/queues it. |
| Webhook returns 401/403 | Item stays in queue, user notified in popup with "Check your token" action. |
| User edits webhook URL while delivery is queued | Queued items use the URL active **at capture time**, not the new one. |
| Speaker name is "You" or unknown | Mapped to `parties[].name = "host"` or `"unknown"` respectively. |
| Meet DOM structure changes | Selectors versioned; on miss, in-call panel shows "MeetVcon needs an update" and capture is paused (no garbage data). |
| User in back-to-back meetings | Each meeting is finalized and queued independently, keyed by Meet meeting code. |

## 12. Milestones

- **M1 — Spike (3 days):** Caption DOM scraping + in-call panel + local transcript view. No webhook yet.
- **M2 — MVP (1 week):** End-of-meeting detection + vCon assembly + HTTPS POST + options page. Manual test only.
- **M3 — Reliability (1 week):** Retry queue, HMAC signing, popup UI with re-send/discard.
- **M4 — Polish & store submission (1 week):** Consent UX, copy, icons, screenshots, Chrome Web Store review.
- **M5 — Post-launch (ongoing):** Selector resilience monitoring, user-reported bugs.

Total to public listing: **~3–4 weeks** of focused work.

## 13. Success metrics (post-launch)

- Webhook delivery success rate ≥99% (measured locally per install via popup stats).
- Selector-break incidents ≤1 per quarter, fixed within 48h.
- Chrome Web Store rating ≥4.5.
- ≥1,000 active installs within 6 months (vanity, not load-bearing).

## 14. Open questions

1. Should the extension support **multiple webhook endpoints** (e.g., one per meeting title pattern) in v1 or v2? Leaning v2.
2. Should we publish a **reference receiver** (small Node.js / Python example) alongside the extension to make adoption easier?
3. Should we offer an optional **end-to-end encrypted** mode where the user supplies a public key and the vCon body is encrypted before POST? Useful for compliance-heavy users; adds complexity.
4. **Branding:** logo, color, store screenshots — out of scope for this PRD but blocks M4.

## 15. References

- IETF vCon working group: https://datatracker.ietf.org/wg/vcon/about/
- Chrome Extensions MV3: https://developer.chrome.com/docs/extensions/mv3/intro/
- Existing comparable extensions for reference (not vendors): MeetScribe, Tactiq, Scribbl, Otter.ai.
