# SipPulse Meet Capture

Internal Chrome extension that turns an authorized Google Meet conversation
into a diarized vCon, stores it in SipPulse CRM, and emails the transcript to
the capturing collaborator's company address (`@sippulse.com` by default; the
`AllowedEmailDomains` policy can change it for other organizations).

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
- `src/background/`: `worker-core.mjs` holds the delivery state machine with
  injected Chrome/crypto/network dependencies; `service-worker.js` only wires
  Chrome events to it
- `src/offscreen/`: user-started tab/microphone recording and audio upload
- `src/permissions/`: one-time microphone grant page (the recorder cannot prompt)
- `src/lib/`: configuration, vCon, parsing, storage, and retry policy
- `src/options/`: consent and managed-configuration status
- `src/popup/`: capture status, AI start action, recoverable outbox, and a
  local download of the last captured transcript (.md / .vcon) as an escape
  hatch while the backend is not live
- `tests/`: dependency-free Node unit tests, including the service-worker
  state machine against a fake `chrome` object

The receiver contract is documented in
[docs/INTERNAL_INGESTION.md](./docs/INTERNAL_INGESTION.md). The disclosure text
to publish on a SipPulse-owned page is in [docs/PRIVACY.md](./docs/PRIVACY.md).

## Security

The extension accepts only `https://api.sippulse.com` as a destination. Raw
audio remains in memory until upload. SipPulse.ai credentials remain on the
backend.

Caption records, outbox payloads, and the local "last transcript" copy are
AES-GCM encrypted before they reach `chrome.storage.local`. Be precise about
what that buys: the key lives in the extension's IndexedDB in the same Chrome
profile, so this stops casual reading of extension storage but does **not**
protect against someone with access to the profile directory on disk.

Two pilot limitations must be closed before broad deployment:

- **Identity is client-asserted.** The collaborator email comes from the Chrome
  profile and is sent inside the vCon. The backend must not trust it for
  authorization until the bearer policy is replaced by SSO with server-side
  validation.
- **The managed bearer token is shared and readable on every enrolled machine.**
  Treat it as rotatable and scope it to ingestion only.

Report security issues privately to **security@sippulse.com**.
