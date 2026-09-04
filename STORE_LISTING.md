# Private Chrome Web Store Submission

## Name and summary

**SipPulse Meet Capture**

Internal SipPulse extension that creates diarized Google Meet transcripts,
stores vCon records in CRM, and emails the capturing collaborator.

## Single purpose

For authorized Google Meet calls, capture speech, create a diarized transcript,
store its vCon in SipPulse CRM, and email the transcript to the signed-in
SipPulse collaborator.

## Permission justifications

- `storage`: managed company configuration, consent state, encrypted crash
  recovery, and delivery status.
- `alarms`: failed-delivery retries and stale-meeting recovery.
- `identity` / `identity.email`: identify the `@sippulse.com` collaborator who
  receives the transcript and owns the CRM capture.
- `activeTab` / `tabCapture`: after an explicit action, record the active Meet
  tab for SipPulse AI transcription. Audio capture cannot start automatically.
- `offscreen`: keep the user-approved audio recorder alive after the popup closes.
- `https://meet.google.com/*`: detect calls, capture caption fallback, and show
  the in-call disclosure/control panel.
- `https://api.sippulse.com/*`: upload audio or vCon only to SipPulse ingestion.

## Data disclosure

The extension handles personal communications, website content, meeting
metadata, speaker names, the collaborator's company email, and—only after a
per-meeting action—tab and microphone audio. It transfers these data to
SipPulse for CRM storage, transcript email, and SipPulse.ai processing. It does
not sell data, advertise, or send data to user-selected third parties.

Publish [docs/PRIVACY.md](./docs/PRIVACY.md) at a dedicated SipPulse URL and use
that URL in the dashboard. Provide reviewers with a managed test profile,
policy configuration, test Meet instructions, and a test ingestion account.

## Distribution

Visibility: **Private**, restricted to the SipPulse Workspace organization.
Use the SipPulse group publisher with two-step verification. Pilot with a small
organizational unit before force installation.
