# SipPulse Meet Capture

Internal Chrome extension that turns an authorized Google Meet conversation
into a diarized vCon, stores it in SipPulse CRM, and emails the transcript to
the capturing collaborator's `@sippulse.com` address.

## Transcription paths

- **SipPulse AI (preferred):** the collaborator clicks the extension action
  once during the meeting. The extension records tab audio plus microphone,
  then uploads it to SipPulse ingestion. The backend uses
  `pulse-telephony`, requests diarization, and leaves language unset for
  automatic detection.
- **Google captions (fallback):** captions are captured continuously into an
  encrypted local recovery record. They become the final transcript if audio
  capture was not started or its upload fails.

Audio capture cannot start silently: Chrome requires an explicit extension
action for `tabCapture`. A visible Meet panel always shows the capture state and
can stop and discard the current call.

## Development

```bash
npm install
npm test
npm run check
```

Load the repository root from `chrome://extensions` using **Load unpacked**.
The extension fails closed until enterprise policy supplies an authenticated
SipPulse endpoint and the collaborator accepts the disclosure. See
[INSTALL.md](./INSTALL.md) for policy setup.

## Structure

- `src/content/`: Meet detection, caption fallback, and visible controls
- `src/background/`: encrypted persistence, retries, recovery, and delivery
- `src/offscreen/`: user-started tab/microphone recording and audio upload
- `src/lib/`: configuration, vCon, parsing, storage, and retry policy
- `src/options/`: consent and managed-configuration status
- `src/popup/`: capture status, AI start action, and recoverable outbox
- `tests/`: dependency-free Node unit tests

The receiver contract is documented in
[docs/INTERNAL_INGESTION.md](./docs/INTERNAL_INGESTION.md). The disclosure text
to publish on a SipPulse-owned page is in [docs/PRIVACY.md](./docs/PRIVACY.md).

## Security

The extension accepts only `https://api.sippulse.com` as a destination. Raw
audio remains in memory until upload. Caption records and retry payloads are
AES-GCM encrypted before local persistence; the non-extractable key is stored
in extension IndexedDB. SipPulse.ai credentials remain on the backend.

Report security issues privately to **security@sippulse.com**.
