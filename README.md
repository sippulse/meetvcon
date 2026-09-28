# SipPulse Meet Capture

Internal Chrome extension for live Google Meet transcription and meeting
intelligence. While the call runs, Chrome's side panel shows a live,
speaker-labelled transcript, AI notes (summary, action items, topics,
intents), and talk time with sentiment per speaker. When the call ends, one vCon
with the transcript and meeting report is stored in SipPulse CRM and emailed
to the capturing collaborator (`@sippulse.com` by default; the
`AllowedEmailDomains` policy can change it for other organizations).

## How it works

- **Live transcription (SipPulse AI by default):** the collaborator clicks
  the extension action once during the meeting. The offscreen recorder
  streams the collaborator's microphone and the Meet tab as two mono streams
  over the `/v1/listen` protocol to the SipPulse AI gateway
  (`pulse-stt-streaming-v1`, pt-BR). Remote voices are named from Google Meet
  caption labels. No audio is stored.
- **Inline classification (TypeSafe Jev, optional):** each final line is classified in
  about 300 ms — intent (commitment, decision, question, objection, buying
  signal, problem, scheduling), sentiment, and action item — and tagged in
  the live transcript.
- **Meeting notes (SipPulse AI):** about every minute the transcript so far is
  sent to SipPulse AI (`deepseek-v4.1-flash`, OpenAI-compatible API) for live
  notes; after the call the full transcript produces the final report,
  stored in the vCon's `analysis[]` with the Jev intents and sentiment.
- **Google captions (fallback):** when the collaborator has captions on, their
  text is read into an encrypted local recovery record. It names remote
  speakers and becomes the final transcript if live transcription was not
  started or failed. The extension never switches captions on by itself.

Audio capture cannot start silently: Chrome requires an explicit extension
action for `tabCapture`. The side panel shows the capture state and can stop and
discard the current call. Open it from the extension popup, or from Chrome's
side panel menu.

## Development

```bash
npm install
npm test
npm run check
npm run e2e:live   # real SipPulse AI dev + TypeSafe; needs keys in .env
```

Load the repository root from `chrome://extensions` using **Load unpacked**.
The extension fails closed until a vCon storage endpoint and token are
configured and the collaborator accepts the disclosure. Settings come from
Google Admin (admin.google.com, preferred) or the options page's local
settings; see [INSTALL.md](./INSTALL.md).

## Structure

- `src/content/`: Meet detection, caption fallback, and visible controls
- `src/background/`: `worker-core.mjs` holds the delivery state machine with
  injected Chrome/crypto/network dependencies; `service-worker.js` only wires
  Chrome events to it
- `src/offscreen/`: user-started tab/microphone capture, the two streaming
  WebSockets, the PCM audio worklet, inline classification, and live/final
  analysis
- `src/permissions/`: one-time microphone grant page (the recorder cannot prompt)
- `src/lib/`: configuration, vCon, caption parsing, storage, retry policy,
  `transcription.js` (stream URL, result parsing, speaker naming, talk-time
  stats), `classification.js` (Jev questions and aggregation), and
  `analysis.js` (SipPulse AI prompt, schema, and vCon analysis)
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

The minimal configuration is the SipPulse AI key plus the vCon store
(endpoint and HMAC secret). The only built-in endpoint is SipPulse AI's
public API (`https://api.sippulse.ai`, overridable); the vCon store and any
other provider are configured by the organization (Google Admin or
Settings), and Chrome must grant each host (optional host permissions).
Audio is streamed and never stored.

Caption records, outbox payloads, and the local "last transcript" copy are
AES-GCM encrypted before they reach `chrome.storage.local`. Be precise about
what that buys: the key lives in the extension's IndexedDB in the same Chrome
profile, so this stops casual reading of extension storage but does **not**
protect against someone with access to the profile directory on disk.

Three pilot limitations must be closed before broad deployment:

- **Provider keys are in browser policy.** The SipPulse AI and TypeSafe keys
  are readable on every enrolled machine. Use scoped, rate-limited, rotatable
  keys, and move to short-lived tokens issued by SipPulse.
- **Identity is client-asserted.** The collaborator email comes from the Chrome
  profile and is sent inside the vCon. The backend must not trust it for
  authorization until the shared HMAC secret is replaced by SSO with
  server-side validation.
- **The vCon HMAC secret is shared and readable on every configured machine.**
  Anyone holding it can post vCons to the CRM; rotate it on both sides.

Report security issues privately to **security@sippulse.com**.
