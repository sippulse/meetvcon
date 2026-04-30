# Chrome Web Store listing copy

Copy-paste into the [Developer Dashboard](https://chromewebstore.google.com/devconsole) when submitting.

---

## Name

MeetVcon

## Category

Productivity

## Summary (132 chars max)

Send your Google Meet transcripts straight to your CRM, ticketing system, or LLM pipeline. vCon JSON. No bot, no SaaS.

## Detailed description

You finish a Meet call. The transcript is locked inside someone else's SaaS.

Otter, Tactiq, Scribbl, MeetScribe all keep your transcripts in their own cloud. To get them into your CRM, ticketing system, knowledge base, or LLM pipeline, you copy and paste, pay for an integration, or run a bot that joins the call as a participant.

MeetVcon takes a different path.

It reads Google Meet's built-in browser captions. It assembles them into a vCon JSON document, the IETF standard for interoperable conversation data. Then it POSTs the document to the HTTPS webhook you configure. No bot joins your call. No data passes through MeetVcon servers, because there are no MeetVcon servers.

### What you get

- Webhook delivery in standard vCon format. Receivers parse it with any vCon-aware library, or treat it as plain JSON.
- Two delivery modes. End of call, for the simplest receiver. Periodic snapshots, every 1 to 60 minutes, for near-real-time pipelines that need durability against tab crashes.
- Authenticated webhooks. Optional Bearer token. Optional HMAC-SHA256 body signature.
- Reliable delivery. Exponential-backoff retry queue persisted across browser restarts.
- Captions stay on. The extension auto-enables Meet captions when you join a call and re-enables them within ten seconds if they get turned off.
- Capturer attribution. The Chrome profile email is included in the vCon so your receiver can route or attribute by user. You can turn this off.
- In-call panel. A small overlay shows capture status. Participants can see that transcription is active.

### What it does not do

- No external speech-to-text. No Whisper, no Deepgram, no Cloud STT. Transcription quality is whatever Meet's browser captions produce.
- No audio or video recording. Transcripts only.
- No third-party servers. No analytics. No telemetry.
- No support for Zoom or Teams in this version. Meet only.

### Privacy

Transcripts never leave your device until POSTed to the webhook you configure. The extension does not phone home. Webhook URL, bearer token, and HMAC signing secret are stored only in chrome.storage.local on your machine, never in source code, never on a server.

### Source

Open source under the MIT License. Code, issues, and pull requests at https://github.com/sippulse/meetvcon

### Install, point at your webhook, talk

Right-click the icon, open Options, paste your webhook URL, click Save. Send a test payload to confirm. Join a Meet call. Your receiver gets a vCon when the call ends.

---

## Single purpose declaration (for review)

MeetVcon captures Google Meet captions during a call and POSTs the transcript as an IETF vCon JSON document to a user-configured HTTPS webhook. It does nothing else.

## Per-permission justifications

**`storage`**
Save the webhook URL, optional Bearer token and HMAC secret, the user's delivery-mode preference, the recent-meetings list, and the pending-delivery retry queue. Used in chrome.storage.local for configuration and chrome.storage.session for the live transcript buffer.

**`alarms`**
Schedule the periodic snapshot delivery (when the user enables snapshot mode) and the exponential-backoff retry attempts when a webhook delivery fails.

**`identity` and `identity.email`**
Read the Chrome profile email via chrome.identity.getProfileUserInfo. The email is included in the vCon at attachments[0].body.captured_by_user.email so the receiver can identify which user captured the transcript. The user can disable this in the options page.

**Host permission `https://meet.google.com/*`**
Inject the content script that reads Meet's caption overlay, runs the captions watchdog, and shows the in-call status panel.

**Optional host permission `https://*/*`**
Required to POST the transcript to the webhook URL the user configures. Granted at runtime for the specific host the user enters in Options, never broadly. The service worker checks the permission before each delivery and refuses to send if it has been revoked.

## Privacy practices (data usage disclosure)

Personally identifiable information handled by the extension:

- **Email address.** The Chrome profile email, when the user keeps the default "include capturer email" setting on. Included in the vCon document POSTed to the user's own webhook. Not transmitted anywhere else.
- **Communications content.** Meeting transcripts produced by Google Meet's browser captions. Stored locally during the call and POSTed to the user's webhook.

Statements required by the Chrome Web Store:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Screenshots needed (1280x800 PNG)

1. Options page with webhook URL, delivery mode, and "Send test payload" button.
2. In-call panel on a Meet call, status set to "Capturing captions".
3. Popup with one delivered meeting and one queued retry, showing Retry / Download / Discard actions.
4. Optional. A receiver tab showing the incoming vCon JSON (e.g. webhook.site).

## Privacy policy URL (must be publicly hosted before submission)

Suggested location: https://www.sippulse.com/meetvcon/privacy

Required content: what is collected (transcript text, capturer email when enabled), where it goes (the user-configured webhook only), what is stored locally (chrome.storage.local config and recent meetings, chrome.storage.session live buffer), what is not done (no third-party servers, no analytics, no selling of data).
