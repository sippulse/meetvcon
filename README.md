# MeetVcon

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![vCon](https://img.shields.io/badge/format-vCon-1f6feb.svg)](https://datatracker.ietf.org/wg/vcon/about/)

Chrome extension that transcribes Google Meet calls using the browser's
built-in captions and POSTs each transcript as an IETF
[**vCon**](https://datatracker.ietf.org/wg/vcon/about/) (Virtualized
Conversation) JSON document to a user-configured HTTPS webhook.

- **No external speech-to-text.** No Whisper, no Deepgram, no Google STT
  API. Transcription quality is whatever Meet's browser captions provide.
- **No bot joins your call.** A floating panel reads captions from the DOM.
- **No third-party servers.** The transcript leaves your device only when
  it's POSTed to the webhook *you* configure.
- **Standard format.** Receivers consume `application/vcon+json`, the
  emerging standard for interoperable conversation data.

See [`PRD.md`](./PRD.md) for the full product specification.

## Features

- **Captions auto-enable.** On joining a call, MeetVcon turns Meet's
  captions on for you and re-enables them within ~10 seconds if they get
  turned off mid-call (rate-limited; respects an explicit user opt-out).
- **Two delivery modes.**
  - `end_of_call` (default): one POST per call, on hangup.
  - `periodic_snapshot`: every N minutes (1–60), POST a cumulative
    snapshot using the same vCon UUID. Survives tab crashes; supports
    near-real-time receivers.
- **Reliable delivery.** Exponential-backoff retry queue (30s → 24h),
  persisted across service-worker restarts. Snapshot dedup so stale
  retries don't clobber fresh data.
- **Authenticated webhooks.** Optional Bearer token and optional
  HMAC-SHA256 body signature.
- **Capturer attribution.** Each vCon includes the Chrome profile email
  of the user who ran the extension (toggleable).
- **On-device AI summary (optional).** At end of call, Chrome's built-in
  Summarizer (Gemini Nano, Chrome 138+) generates a key-points summary
  entirely on your machine — no external AI service. The summary is added
  to the vCon (`analysis[]`) so your webhook/CRM receives it too.
- **Email delivery (optional).** After each call, MeetVcon emails you the
  summary and the full plain-text transcript through the transactional
  email provider you configure (Resend, SendGrid, or Mailgun) using your
  own API key. Recipient defaults to your Chrome profile email. Failed
  sends land in the same retry queue as webhooks.
- **In-call status panel** with capture indicator and one-click
  opt-out / try-again.
- **Popup UI.** Pending-delivery queue (Retry / Download vCon / Discard)
  and recent-meetings list.

## Install (developer mode)

The extension is not yet published on the Chrome Web Store. To run it:

1. Clone this repo (or download the source zip):
   ```bash
   git clone https://github.com/sippulse/meetvcon.git
   ```
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Toggle **Developer mode** in the top right.
4. Click **Load unpacked** and select the cloned `meetvcon/` directory.
5. Pin the extension from the toolbar puzzle-piece menu.

For detailed steps, how to update (`git pull` + reload), uninstall, and
troubleshooting, see [**INSTALL.md**](./INSTALL.md).

## Configure

Right-click the MeetVcon icon → **Options**.

| Field | Required | Description |
| --- | --- | --- |
| Webhook URL | yes | HTTPS endpoint that receives the vCon payloads. |
| Bearer token | no | Sent as `Authorization: Bearer <token>` if set. |
| HMAC signing secret | no | If set, payloads are signed: `X-MeetVcon-Signature: sha256=<hex>` (HMAC-SHA256 over the raw body). |
| Delivery mode | yes | `end_of_call` (default) or `periodic_snapshot`. |
| Snapshot interval | conditional | Minutes between snapshots, when in `periodic_snapshot` mode (1–60, default 5). |
| Include capturer email | no | When on (default), the Chrome profile email is included in `attachments[0].body.captured_by_user.email`. |
| AI summary | no | When on, an on-device summary (Chrome built-in Summarizer / Gemini Nano) is generated at end of call and added to `analysis[]` and to the email. Requires Chrome 138+ and a one-time model download (button in Options). |
| Email delivery | no | When on, the summary + plain-text transcript are emailed at end of call. |
| Email provider | conditional | `Resend`, `SendGrid`, or `Mailgun`. |
| Email API key | conditional | Your provider API key. Stored only in `chrome.storage.local`. |
| Mailgun domain | conditional | Sending domain, Mailgun only (e.g. `mg.example.com`). |
| From | conditional | Sender address; must be verified with your provider. |
| To | no | Comma-separated recipients. Empty = your Chrome profile email. |

Click **Send test payload** to verify your receiver gets a vCon before
joining a real call, and **Send test email** to verify email delivery.

## vCon payload shape

Conforms to `draft-ietf-vcon-vcon-container`. Minimum example:

```json
{
  "vcon": "0.0.1",
  "uuid": "018f3a1c-...",
  "created_at": "2026-04-30T14:32:11Z",
  "subject": "Weekly sync",
  "parties": [
    { "name": "Flavio Costa" },
    { "name": "Jane Doe" }
  ],
  "dialog": [
    { "type": "text", "start": "2026-04-30T14:32:15Z",
      "duration": 4.2, "parties": [0],
      "body": "Thanks everyone for joining." }
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
          "email": "you@example.com",
          "id": "1234567890abcdef"
        }
      }
    }
  ]
}
```

## Webhook receiver: minimal example

Any HTTPS endpoint will work. A throwaway Node.js receiver for testing:

```js
import http from "node:http";
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      console.log(req.method, req.url, req.headers["x-meetvcon-delivery"]);
      console.log(JSON.parse(body));
      res.writeHead(200).end("ok");
    });
  })
  .listen(8443);
```

Expose it over HTTPS for testing with `ngrok http 8443`, then paste the
ngrok URL into MeetVcon's options page.

## Architecture

```
┌──────────────────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│ Content script           │     │ Service worker (MV3) │     │ Options / popup │
│ (meet.google.com)        │     │                      │     │                 │
│                          │     │  - delivery queue    │     │  - webhook URL  │
│  - DOM caption scraper   │────▶│  - retry/backoff     │     │  - bearer token │
│  - in-call UI panel      │     │  - HMAC signing      │     │  - HMAC secret  │
│  - end-of-call detector  │     │  - snapshot alarms   │     │  - test send    │
│  - captions watchdog     │     │  - identity API      │     │  - queue mgmt   │
└──────────────────────────┘     └──────────┬───────────┘     └─────────────────┘
                                            │
                                            ▼
                                     HTTPS POST (vCon)
                                            │
                                            ▼
                                  user's configured endpoint
```

## Project layout

```
manifest.json                          MV3 manifest
PRD.md                                 product spec
CHANGELOG.md
LICENSE
src/
  lib/
    logger.js                          shared [MeetVcon] logger
    selectors.js                       Meet DOM selectors (multilingual)
    storage.js                         chrome.storage helpers
    vcon.js                            vCon assembler + renderers
    email.js                           email provider HTTP requests
    summarizer.js                      on-device summary (Gemini Nano)
  content/
    captions-watchdog.js               auto-enable + monitoring
    transcript-capture.js              caption DOM observer
    in-call-panel.js                   floating status overlay
    panel.css
    main.js                            content-script orchestrator
  background/
    service-worker.js                  delivery + retry + alarms
  options/                             webhook config
  popup/                               queue + recent-meetings UI
.github/
  ISSUE_TEMPLATE/
  PULL_REQUEST_TEMPLATE.md
```

## Privacy

- Transcripts never leave the device until POSTed to your webhook and/or
  emailed via the provider you configured.
- No telemetry, no analytics, no third-party services you didn't configure.
- No external STT or LLM. Transcription is whatever Meet's browser
  captions produce; the optional summary runs on-device (Chrome built-in
  Summarizer / Gemini Nano) — transcript text is never sent to an
  external AI service.
- Email delivery, when enabled, sends the transcript through the
  transactional email provider **you** chose, with **your** API key.
- Webhook URL, bearer token, HMAC secret, and email API key are stored
  exclusively in `chrome.storage.local` and are never hardcoded in source.

## Legal & consent

Recording or transcribing a meeting may be subject to consent requirements
in your jurisdiction (e.g., two-party-consent states in the US, GDPR in
the EU). The in-call panel is non-removable during capture so participants
can see that transcription is active. You are responsible for obtaining
participant consent where required.

## Contributing

Issues and PRs welcome. The most common breakage is a Google Meet DOM
change. If captions stop being captured, look first at
`src/lib/selectors.js`.

For security issues, email **security@sippulse.com** instead of opening
a public issue.

## License

[MIT](./LICENSE) © 2026 SipPulse.
