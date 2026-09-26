# SipPulse Meet Capture Privacy Disclosure

SipPulse Meet Capture is an internal browser extension used by SipPulse
collaborators. Its single purpose is to create a live, speaker-labelled transcript
and meeting notes for an authorized Google Meet call, store the resulting vCon
in SipPulse CRM, and email the transcript and report to the collaborator who
captured it.

## Data handled

The extension handles the meeting title and URL, Google Meet caption text,
speaker labels, timestamps, the collaborator's `@sippulse.com` Chrome profile
email, and delivery status. When the collaborator explicitly starts live
transcription, it also streams audio from the Meet tab and collaborator
microphone.

## Use and sharing

Data is used only for the stated transcription, analysis, and delivery
purpose. Processors:

- **SipPulse AI's streaming service** receives the live audio stream and
  returns the transcript.
- **SipPulse AI** receives transcript text during and after the call to write
  notes: summary, topics, action items, decisions, and open questions.
- **TypeSafe** receives each transcript line, with the line before it, and
  returns its intent, sentiment, and whether it is an action item.
- **SipPulse CRM and email** receive the final vCon and report, which are
  stored in CRM and sent to the capturing collaborator's company email.
 Data is not sold, used for advertising,
or sent to arbitrary user-configured destinations.

## Storage and deletion

Audio is streamed and never written to browser storage. Active caption
transcripts, live transcript segments and notes, failed-delivery payloads, and a copy of the last
captured transcript are encrypted locally against casual access; status
metadata contains no transcript text. Local payloads are removed
after successful delivery or when the collaborator discards them. CRM and email copies follow SipPulse corporate retention and deletion policies.

## Control and contact

Capture begins only after the collaborator accepts the in-product disclosure.
Live transcription additionally requires an explicit action for every
meeting. The side panel shows the capture state and can stop and discard that
call.
Collaborators are responsible for informing participants and following company
policy and applicable law. Privacy and security questions: security@sippulse.com.
