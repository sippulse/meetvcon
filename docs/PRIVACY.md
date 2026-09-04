# SipPulse Meet Capture Privacy Disclosure

SipPulse Meet Capture is an internal browser extension used by SipPulse
collaborators. Its single purpose is to create a diarized transcript of an
authorized Google Meet call, store the resulting vCon in SipPulse CRM, and email
the transcript to the collaborator who captured it.

## Data handled

The extension handles the meeting title and URL, Google Meet caption text,
speaker labels, timestamps, the collaborator's `@sippulse.com` Chrome profile
email, and delivery status. When the collaborator explicitly starts SipPulse AI
capture, it also records audio from the Meet tab and collaborator microphone.

## Use and sharing

Data is used only for the stated transcription and delivery purpose. Audio is
sent to SipPulse's ingestion service and processed by SipPulse.ai using the
`pulse-telephony` model with diarization and automatic language detection. The
resulting vCon is stored in SipPulse CRM and a transcript is sent to the
capturing collaborator's company email. Data is not sold, used for advertising,
or sent to arbitrary user-configured destinations.

## Storage and deletion

Audio remains in browser memory until upload and is not written to browser
storage. Active caption transcripts and failed-delivery payloads are encrypted
locally; status metadata contains no transcript text. Local payloads are removed
after successful delivery or when the collaborator discards them. The ingestion
service deletes raw audio after transcription completes or permanently fails.
CRM and email copies follow SipPulse corporate retention and deletion policies.

## Control and contact

Capture begins only after the collaborator accepts the in-product disclosure.
SipPulse AI audio capture additionally requires an explicit action for every
meeting. The in-call panel remains visible and can stop and discard that call.
Collaborators are responsible for informing participants and following company
policy and applicable law. Privacy and security questions: security@sippulse.com.
