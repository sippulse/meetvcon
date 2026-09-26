# SipPulse Meet Capture — Internal Product Contract

## Outcome

During an authorized Google Meet call, the collaborator sees a live,
speaker-labelled transcript and AI notes (summary, action items, topics,
intents, talk time, sentiment). After the call, SipPulse stores one vCon with
the transcript and meeting report in CRM and emails it to the collaborator
who captured it. Employees never configure webhooks, API keys, delivery
modes, or file formats.

The bar is parity with read.ai and Otter on the in-call and post-call
experience for Portuguese (pt-BR) meetings, without a bot joining the call.

## Required behavior

1. Capture begins only after the collaborator accepts the in-product
   disclosure (consent version 2, which names SipPulse AI and TypeSafe) and
   Chrome reports a signed-in profile on an allowed domain (`sippulse.com`
   unless `AllowedEmailDomains` policy says otherwise).
2. Google captions provide an automatic, speaker-labelled fallback stored only
   in the encrypted local recovery record until final delivery.
3. The collaborator starts live transcription with one extension action. The
   Meet tab (remote participants) and local microphone stream as separate mono
   streams over `/v1/listen` to the SipPulse AI gateway
   (`pulse-stt-streaming-v1`, pt-BR). It starts from the side panel, which
   stays open beside the call.
4. `AnalysisMode` decides when the models run. The default, `final`, keeps the
   call itself free of model calls: nothing is classified or summarized until
   the meeting ends. `live` additionally classifies every transcript line with
   TypeSafe's Jev model (intent, sentiment, action item) within about a second
   and refreshes the notes about every minute.
5. The side panel shows the live transcript, per-speaker talk time, and — in
   `live` mode — intent tags and running notes. Remote speakers are named from
   Meet captions when possible.
6. When the call ends, the full transcript is analyzed by SipPulse AI
   (`deepseek-v4.1-flash`) into the final report: headline, summary, key
   points, decisions with their rationale, action items with owners and due
   dates, the agreed next step, the figures that were quoted, open risks and
   objections, open questions, and topics with times. When TypeSafe is
   configured, every line not already classified is classified then, and the
   Jev intents and per-speaker sentiment are merged into the report.
7. The final vCon preserves one UUID, maps speakers to `parties[]`, maps timed
   utterances to `dialog[]`, carries the report and speaker stats in
   `analysis[]`, and identifies the collaborator in meeting metadata.
8. Final processing stores/upserts one CRM vCon and queues exactly one email to
   the collaborator. During the call, transcript text leaves the browser only
   to SipPulse AI (notes) and TypeSafe (classification).
9. “Stop and discard” stops captions, audio, and any analysis, removes
   recovery data, and prevents delivery for that call, including after a tab
   reload. The marker clears when the collaborator leaves the call or after
   four hours.

## Configuration

Only three values are required: `SipPulseAiApiKey` (live transcription and
notes) and the vCon store (`EndpointUrl`, `HmacSecret`). Everything else is
optional: `SipPulseAiUrl` (defaults to `https://api.sippulse.ai`, the only
built-in endpoint), `AllowedEmailDomains` (unset, any signed-in profile may
capture), `AnalysisMode` (`final` by default, or `live`), a transcription
override (`TranscriptionProvider`,
`TranscriptionUrl`, `TranscriptionApiKey`, defaulting to the SipPulse AI
pair), and TypeSafe (`TypeSafeUrl`, `TypeSafeApiKey`, no default). The vCon
store has no default: it is always the organization's own. Configured hosts are optional
host permissions granted at runtime, which Chrome grants only from a user
action: each collaborator allows them once from the options page, even when
every value comes from Google Admin. They come
from Google Admin extension policy (preferred; locks the field) or, for fields
the policy leaves unset, from local settings on the options page, stored
encrypted. `CaptureEnabled` is a policy-only kill switch. Models and endpoints are
fixed in code (`src/lib/config.js`). The streaming model runs on the SipPulse
AI dev environment for now, so the SipPulse AI key must be a dev key.

## Reliability and privacy

- Encrypt active captions, live transcript segments, live notes, and
  failed-delivery bodies at rest.
- Never store audio: it is streamed to SipPulse AI and discarded.
- Reconnect each stream automatically, buffering up to 60 seconds of audio,
  while keeping one timeline across reconnects.
- Persist retry metadata without transcript text; exhausted retries remain
  visible and manually recoverable.
- Restore retry alarms after browser/service-worker restart.
- Recover stale encrypted meetings (no snapshot for 10 minutes). Give the
  recorder 15 minutes to report the final transcript and report, then fall
  back to the transcript saved during the call, then to Google captions.
- Keep an encrypted local copy of the last captured transcript that the
  collaborator can download as Markdown (with the report) or vCon.
- Use timeouts, idempotency by vCon UUID, and HTTPS-only destinations taken
  from configuration; the manifest grants only `meet.google.com` up front.

## Known pilot limitations

- Provider keys come from managed policy and are readable on every enrolled
  machine. Use dedicated, scoped, rotatable keys. Replacing them with
  short-lived tokens issued by SipPulse is the next security step.
- The collaborator identity is the Chrome profile email, asserted by the
  client. The backend must derive authorization from the credential, not from
  `captured_by_user.email`, until SSO replaces the shared HMAC secret.
- The CRM flags a meeting internal when every party with an email is
  `@sippulse.com`. Meet does not expose participant emails, so today every
  captured meeting is flagged internal (see `docs/INTERNAL_INGESTION.md`,
  "Gaps on the CRM side").
- Local encryption of caption records protects against casual reading of
  extension storage only; it is not a defense against profile-level access.
- Microphone permission requires a one-time visit to the extension's
  permission page (or an `AudioCaptureAllowedUrls` policy).
- The streaming model (a nemotron-asr derivative) is multilingual, but the
  dev gateway only accepts `language=pt-BR|pt` today (`multi`, `en`, `es` are
  rejected with `UNSUPPORTED_LANGUAGE`; English audio returns no text). It is
  mono and does not diarize. Remote
  voices are named line by line from Google Meet captions; with captions off
  they are all `Participant` and excluded from talk-time stats. The
  collaborator's name is derived from their email address.
- The streaming gateway occasionally cuts a sentence in two; halves with no
  pause between them are rejoined.

## Non-goals

The internal version does not support arbitrary webhooks, destinations
outside the fixed SipPulse and TypeSafe hosts,
multiple destinations, public self-service installation, transcript editing,
a meeting bot, or direct email sending from Chrome.

## Success measures

- At least 98% of authorized calls produce a CRM vCon without manual recovery.
- At least 95% of final transcripts and reports are emailed within five
  minutes.
- Live transcript latency under two seconds; live notes refresh within about
  a minute of new speech.
- Fewer than 5% of calls fall back from live transcription to Google captions.
- No transcript is delivered after a collaborator chooses discard.
