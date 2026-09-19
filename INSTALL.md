# Internal Installation and Configuration

## Where settings come from

Each setting is read from two places, field by field:

1. **Google Admin (admin.google.com)** — preferred. Values pushed as extension
   policy win and appear locked on the options page.
2. **Local settings** — the **Settings** card on the extension's options page,
   for anything the administrator did not set (a developer machine, or a pilot
   before the policy exists). Values are stored encrypted on that computer;
   keys are never displayed again, only their last four characters.

`CaptureEnabled` (kill switch) can only be set by policy.

| Field | Meaning |
|---|---|
| `EndpointUrl` | Required. HTTPS URL of the vCon store. SipPulse: `https://crm.sippulse.com/api/vcons/ingest` |
| `HmacSecret` | Required. The store's shared secret (SipPulse CRM: `VCON_HMAC_SECRET`); every delivery is signed with it |
| `AllowedEmailDomains` | Chrome profile domains allowed to capture and receive the email (default `sippulse.com`) |
| `TranscriptionProvider` | `deepgram` (default; nova-3 multilingual, diarized) or `sippulse_ai` (SipPulse AI streaming gateway, pt-BR) |
| `TranscriptionUrl` | HTTPS base of the transcription provider: `https://api.deepgram.com`, or `https://api.dev.sippulse.ai` for SipPulse streaming (dev only for now) |
| `TranscriptionApiKey` | Transcription key (Deepgram: a dedicated `usage:write` key) |
| `SipPulseAiUrl` | HTTPS base of SipPulse AI for live notes and the report: `https://api.sippulse.ai` |
| `SipPulseAiApiKey` | Key for the same environment as `SipPulseAiUrl` |
| `TypeSafeUrl` | HTTPS base of TypeSafe for Jev classification: `https://api.typesafe.ai` |
| `TypeSafeApiKey` | TypeSafe key |
| `CaptureEnabled` | Optional; `false` disables capture (policy only) |

No endpoint is built into the extension (it is open source; each
organization points it at its own servers). Without the vCon store nothing
is delivered; without the SipPulse AI URL and key only Google captions are
captured (no live transcript or notes); without the TypeSafe URL and key
lines are not tagged and the report has no intents or sentiment.

**Host access.** The manifest only asks for `meet.google.com`; every
configured server is an *optional* host permission that Chrome grants per
host. Saving settings asks for the hosts in the form; for URLs pushed by
Google Admin, the options page shows **Allow access** (one click per
collaborator, because Chrome only grants optional permissions from a user
action). The popup points there while access is missing.

### Google Admin (admin.google.com)

Policy reaches browsers managed by the organization (managed Chrome profiles
or enrolled browsers), for the extension ID it is configured on.

1. Sign in to **admin.google.com** as an administrator.
2. Go to **Devices › Chrome › Apps & extensions › Users & browsers**.
3. Pick the organizational unit (start with a pilot OU).
4. Add the extension with the **+** button: **Add from Chrome Web Store** for
   the private listing, or **Add Chrome app or extension by ID** with the
   extension's stable ID. Set the installation policy (Force install for the
   pilot OU).
5. Select the extension and paste the JSON below into **Policy for
   extensions**, then **Save**. The Admin console requires every value wrapped
   in `{"Value": ...}`:

```json
{
  "EndpointUrl": { "Value": "https://crm.sippulse.com/api/vcons/ingest" },
  "HmacSecret": { "Value": "CRM_VCON_HMAC_SECRET" },
  "AllowedEmailDomains": { "Value": ["sippulse.com"] },
  "TranscriptionProvider": { "Value": "deepgram" },
  "TranscriptionUrl": { "Value": "https://api.deepgram.com" },
  "TranscriptionApiKey": { "Value": "DEEPGRAM_KEY" },
  "SipPulseAiUrl": { "Value": "https://api.sippulse.ai" },
  "SipPulseAiApiKey": { "Value": "SIPPULSE_AI_KEY" },
  "TypeSafeUrl": { "Value": "https://api.typesafe.ai" },
  "TypeSafeApiKey": { "Value": "TYPESAFE_KEY" }
}
```

6. On a pilot machine, open `chrome://policy`, choose **Reload policies**, and
   check the extension's entries; then open the extension's options page: the
   fields show "set by Google Admin" and are locked. Choose **Allow access**
   once so Chrome lets the extension reach the configured servers.

Leave a field out of the JSON to let collaborators set it locally.

### Local settings

Open the extension's options page (**Settings** in the popup), fill the
**Settings** card, and choose **Save settings**. Leave a key field empty to
keep the stored key; **Remove local settings** clears everything saved on that
computer. Then use **Test connections**.

### Developer installation

1. Run `npm install`, `npm test`, and `npm run check`.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select the repository root.
4. Open the options page, accept the disclosure, and fill the **Settings**
   card (an unpacked copy has its own extension ID, so Admin policy for the
   published ID does not reach it).

A local file policy also works for testing precedence
(`/etc/opt/chrome/policies/managed/sippulse-meet.json` on Linux; plain values,
no `"Value"` wrapper):

```json
{
  "3rdparty": {
    "extensions": {
      "EXTENSION_ID": {
        "SipPulseAiApiKey": "SIPPULSE_AI_DEV_KEY"
      }
    }
  }
}
```

### Credentials

All credentials are pilot mechanisms and are readable by anyone with access
to a configured machine, whether they came from policy or local settings:

- Create a dedicated SipPulse AI dev key for Meet Capture with a spending
  limit, and rotate it on a schedule.
- Create a dedicated TypeSafe key for Meet Capture.
- The HMAC secret is shared by every enrolled machine and the CRM; anyone who
  reads it can post vCons to the CRM. Rotate it on the CRM
  (`VCON_HMAC_SECRET`) and in policy together, and replace it with SipPulse
  SSO before broad deployment.

Before touching a real Meet, `npm run e2e:live` checks both keys and the
whole pipeline with a synthetic meeting (see `docs/INTERNAL_INGESTION.md`).

### Microphone permission

The background recorder cannot show Chrome's microphone prompt. The first time
a collaborator starts live transcription, the popup opens
`src/permissions/microphone.html` in a tab to request the grant once; after
that the recorder reuses it. Administrators can pre-grant it and skip the tab
with the Chrome policy `AudioCaptureAllowedUrls` containing
`chrome-extension://EXTENSION_ID/` (verify this against your Chrome version in
the pilot before relying on it).

## Company deployment

Publish privately for the SipPulse Workspace domain, deploy first to a pilot
organizational unit, and configure the policy declared by
`enterprise-policy.json`. The production package must use a stable extension ID.
Force installation only after consent, capture, fallback, CRM, email, and
discard behavior have passed the pilot checklist.

## Manual verification

1. Open the options page, check that each field shows where it comes from
   ("set by Google Admin" or "saved on this computer"), and choose **Test
   connections**; vCon storage,
   SipPulse AI, and TypeSafe must all report OK.
2. Confirm capture stays off before consent and for a non-SipPulse Chrome
   profile. Upgrading from 0.2 must ask for consent again.
3. Join Meet and verify the visible panel shows Google captions in the
   Transcript tab.
4. Click the extension and choose **Start live transcription & notes**. On
   first use a tab asks for microphone access; allow it, return to Meet, and
   start again.
5. Confirm remote audio remains audible, the panel shows "Live transcription
   on", your lines appear under your name, and remote lines under their Meet
   names within about two seconds. Within another second, lines get tags
   such as "question" or "commitment".
6. After about a minute of conversation the Notes tab shows a summary and
   action items; the Speakers tab shows talk time and sentiment.
7. Toggle Wi-Fi off for ~20 seconds and back on; the panel reports
   reconnecting and the transcript resumes with correct timestamps.
8. End the call; the popup shows "Preparing the meeting report" and then
   "Delivered". Verify CRM stores one vCon with `analysis[]` and the
   collaborator receives one email. **Last transcript → .md** contains the
   report and transcript.
9. Repeat with a failed endpoint, then restore it and retry from the outbox.
   Confirm **Download** on the outbox row and "Last transcript" in the popup
   produce a readable `.md`.
10. Start another call, choose **Stop and discard**, reload the Meet tab, and
   verify the panel stays in the discarded state and nothing is delivered.
11. Join a call where nobody speaks and leave; confirm the popup does not stay
   on "Google captions active".
