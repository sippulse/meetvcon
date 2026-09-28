# Private Chrome Web Store Submission

## Name and summary

**SipPulse Meet Capture**

Internal SipPulse extension for live Google Meet transcripts and AI meeting
notes. Stores the vCon with the meeting report in CRM and emails the capturing
collaborator.

## Single purpose

For authorized Google Meet calls, create a live speaker-labelled transcript and
meeting notes, store the vCon in SipPulse CRM, and email the transcript and
report to the signed-in SipPulse collaborator.

## Permission justifications

- `storage`: managed company configuration, consent state, encrypted crash
  recovery, and delivery status.
- `alarms`: failed-delivery retries and stale-meeting recovery.
- `identity` / `identity.email`: identify the `@sippulse.com` collaborator who
  receives the transcript and owns the CRM capture.
- `activeTab` / `tabCapture`: after an explicit action, stream the active Meet
  tab's audio for live transcription. Audio capture cannot start automatically.
- `offscreen`: keep the user-approved live transcription running after the
  popup closes.
- Microphone access is requested once through an extension page; the offscreen
  recorder reuses that grant.
- `https://meet.google.com/*`: detect calls, capture caption fallback, and show
  the in-call disclosure/control panel.
- Optional `https://*/*`: requested at runtime only for the servers the
  organization configures (vCon store, transcription, SipPulse AI, TypeSafe);
  nothing is granted until the collaborator allows each host. SipPulse's
  configuration:
- `https://crm.sippulse.com/*`: deliver the final vCon to the SipPulse CRM vCon store.
- `https://api.sippulse.ai/*`: stream audio to SipPulse AI for live
  transcription and send transcript text for meeting notes and the report.
- `https://api.typesafe.ai/*` (optional): classify each transcript line's
  intent, sentiment, and action items.

## Data disclosure

The extension handles personal communications, website content, meeting
metadata, speaker names, the collaborator's company email, and—only after a
per-meeting action—tab and microphone audio. It streams audio to SipPulse AI for
transcription, sends transcript text to SipPulse AI for notes and to TypeSafe
for classification, and transfers
the final vCon to SipPulse for CRM storage and transcript email. It does
not sell data, advertise, or send data to user-selected third parties.

Publish [docs/PRIVACY.md](./docs/PRIVACY.md) at a dedicated SipPulse URL and use
that URL in the dashboard. Provide reviewers with a managed test profile,
policy configuration, test Meet instructions, and a test ingestion account.

## Distribution

Visibility: **Private**, restricted to the SipPulse Workspace organization.
Use the SipPulse group publisher with two-step verification. Pilot with a small
organizational unit before force installation.
