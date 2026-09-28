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
**Required — three values:**

| Field | Meaning |
|---|---|
| `SipPulseAiApiKey` | SipPulse AI key. Covers live transcription and meeting notes |
| `EndpointUrl` | HTTPS URL of the vCon store. SipPulse: `https://crm.sippulse.com/api/vcons/ingest` |
| `HmacSecret` | The vCon store's shared secret (SipPulse CRM: `VCON_HMAC_SECRET`); every delivery is signed with it |

**Optional:**

| Field | Meaning |
|---|---|
| `SipPulseAiUrl` | HTTPS base of SipPulse AI. Defaults to `https://api.sippulse.ai` |
| `AllowedEmailDomains` | Restrict which Chrome profiles may capture, e.g. `["sippulse.com"]`. Unset, any signed-in profile may |
| `TranscriptionSource` | `sippulse_ai` (default) streams the call audio to SipPulse AI. `google_captions` reads Meet's own captions instead, and is the only mode that switches captions on; no audio leaves the tab, and the SipPulse AI key is used only for the report |
| `AnalysisMode` | `final` (default) analyses once, when the call ends. `live` also analyses during the call: notes every minute and a tag per line, at a higher cost |
| `TypeSafeUrl` + `TypeSafeApiKey` | Intent, sentiment and action-item classification with TypeSafe Jev, e.g. `https://api.typesafe.ai`. No default: classification is off unless set |
| `CaptureEnabled` | `false` disables capture (policy only) |

The only endpoint built into the extension is SipPulse AI's public API, as
the default for `SipPulseAiUrl`; the vCon store is always the
organization's own. Without the three required values the extension stays
off and says which one is missing.

**Host access needs one click per collaborator, even with policy.** The
manifest only asks for `meet.google.com`; every configured server is an
*optional* host permission. Chrome grants those only from a user action, and
extension policy cannot grant them, so Google Admin alone does not finish the
setup. Saving settings asks for the hosts in the form; for URLs pushed by
Google Admin, the options page shows **Allow access**, and the popup points
there. Until someone clicks, live transcription and notes fail and finished
meetings sit in the extension's outbox (they are delivered on the next retry
after access is granted, nothing is lost). Tell the pilot group to open the
options page once and choose **Allow access**.

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
  "SipPulseAiApiKey": { "Value": "SIPPULSE_AI_KEY" },
  "EndpointUrl": { "Value": "https://crm.sippulse.com/api/vcons/ingest" },
  "HmacSecret": { "Value": "CRM_VCON_HMAC_SECRET" }
}
```

That is the whole SipPulse configuration. Add optional fields the same way,
e.g. `"AllowedEmailDomains": { "Value": ["sippulse.com"] }` to restrict
capture to company accounts, or `TypeSafeUrl`/`TypeSafeApiKey` for inline
intent tags.

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
        "SipPulseAiApiKey": "SIPPULSE_AI_KEY"
      }
    }
  }
}
```

### Credentials

All credentials are pilot mechanisms and are readable by anyone with access
to a configured machine, whether they came from policy or local settings:

- Create a dedicated SipPulse AI key for Meet Capture with a spending
  limit, and rotate it on a schedule.
- If you enable classification, create a dedicated TypeSafe key.
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
   connections**; the vCon store, transcription, and SipPulse AI must report
   OK (TypeSafe too, if configured).
2. Confirm capture stays off before consent, and for a profile outside
   `AllowedEmailDomains` when that is set. Upgrading from 0.2 must ask for
   consent again.
3. Join Meet, click the extension and choose **Open the meeting panel**;
   verify the side panel shows Google captions in the Transcript tab.
4. In the side panel choose **Start live transcription**. On first use a tab
   asks for microphone access; allow it, return to Meet, and start again.
5. Confirm remote audio remains audible, the panel shows "Live transcription
   on", your lines appear under your name, and remote lines under their Meet
   names within about two seconds. Within another second, lines get tags
   such as "question" or "commitment".
6. With `AnalysisMode: "live"`, after about a minute of conversation the Notes tab shows a summary and
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
