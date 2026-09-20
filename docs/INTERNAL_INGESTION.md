# SipPulse Meet Ingestion Contract

The extension sends every finished meeting as a single vCon to the configured
vCon store (`EndpointUrl`). No endpoint is built in; the hosts below are
SipPulse's deployment. SipPulse's store lives inside the CRM,
`POST https://crm.sippulse.com/api/vcons/ingest`, implemented in the
`sippulse-website` repository
(`src/app/api/vcons/ingest/route.ts`, `src/lib/vcon-ingest.ts`). Transcription,
classification, and meeting analysis happen during the call, so the store
never receives audio.

## Where each step runs

| Step | Where (SipPulse's configuration) | Credential |
|---|---|---|
| Live transcription | Offscreen document → `TranscriptionUrl` as `wss://…/v1/listen`, one mono linear16 WebSocket for the microphone and one for the Meet tab. `deepgram` (current): `wss://api.deepgram.com`, nova-3, `language=multi`, 16 kHz, diarized, `mip_opt_out`. `sippulse_ai`: `wss://api.dev.sippulse.ai`, `pulse-stt-streaming-v1`, pt-BR, 8 kHz, `endpointing=700` | `TranscriptionApiKey`, sent as `Sec-WebSocket-Protocol: token, <key>` |
| Inline classification | Offscreen document → TypeSafe `POST https://api.typesafe.ai/v1/systemone` (`jev-latest`) once per final transcript segment: intent (Choice), sentiment (Score 0–4), action item (Noul) | `TypeSafeApiKey` policy, `Authorization: Bearer` |
| Live notes and final report | Offscreen document → SipPulse AI `POST https://api.sippulse.ai/v1/openai/chat/completions` (`deepseek-v4.1-flash`, JSON schema) | `SipPulseAiApiKey` policy, `api-key` header |
| vCon store (CRM) | Service worker → `https://crm.sippulse.com/api/vcons/ingest` | `HmacSecret` (the CRM's `VCON_HMAC_SECRET`), `X-MeetVcon-Signature` |

SipPulse currently streams to **Deepgram**: the SipPulse AI streaming model
is only deployed on the dev environment, which is out until Monday. Switching
back is configuration only (`TranscriptionProvider=sippulse_ai`,
`TranscriptionUrl=https://api.dev.sippulse.ai`, a dev key). The SipPulse model
is multilingual (a nemotron-asr derivative), but the dev gateway validates
`language ∈ {pt-BR, pt}` and rejects anything else at the handshake with
HTTP 400 `UNSUPPORTED_LANGUAGE`; per-provider parameters live in `PROFILES`
in `src/lib/transcription.js`.

The collaborator is always identified by the microphone stream. Deepgram
diarizes the tab stream and each remote voice is named from the Google Meet
captions it overlaps (`Speaker N` when none match); the SipPulse gateway does
not diarize, so each remote segment is named on its own (`Participant` when
no caption matches).

## vCon requests

`POST <EndpointUrl>` with the vCon as the JSON body and:

- `X-MeetVcon-Signature: sha256=<hex>` — HMAC-SHA256 of the exact request
  body with the shared `VCON_HMAC_SECRET`. The store verifies it before
  parsing and answers `401 {"error":"invalid signature"}` otherwise.
- `X-SipPulse-Delivery: final|recovered` and `X-SipPulse-Transcription-Source`
  (below). The store does not read them today; they are there for logs and a
  future upgrade rule.

Transcription sources:

- `<provider>_live` (`deepgram_live`, `sippulse_ai_live`) — full live
  transcript plus the final report, labelled with the provider that produced
  it
- `<provider>_live_recovered` — the recorder did not report back; the
  transcript was rebuilt from segments saved during the call, with the latest
  live notes and the classifications made so far
- `google_captions` — live transcription was never started
- `google_captions_fallback` — live transcription produced nothing usable

Responses:

| Status | Body | Extension |
|---|---|---|
| 202 | `{"status":"accepted","uuid","id"}` | delivered |
| 200 | `{"status":"duplicate","uuid","id"}` | delivered (the store already has that uuid) |
| 400 | `{"error": "..."}` — not JSON or not a valid vCon | queued, retried, then needs attention |
| 401 | `{"error":"invalid signature"}` | queued; fix the secret |
| 503 | `{"error":"server not configured"}` — no `VCON_HMAC_SECRET` on the server | queued |

**There is no test mode:** every valid vCon is stored and goes through the
CRM's AI pipeline and email. The options page's connection test therefore
sends a signed body that is *not* a vCon (`{"connection_test":true}`): `400`
proves the secret is right, `401` that it is wrong, and nothing is stored.

### What the CRM does with it

- Stores the raw vCon, indexes participants, and suggests an anchor company
  from participant emails (exact contact email, then domain).
- Flags `internal=1` when every party that has a `mailto` is `@sippulse.com`.
- A worker (`src/lib/vcon-worker.ts`) runs its own SipPulse AI pass (summary
  in pt-BR, a topic among discovery/demo/support/commercial/technical/
  internal/other, company suggestion) and emails the capturer
  (`attachments[].body.captured_by_user.email`, only `@sippulse.com`, subject
  to `VCON_EMAIL_ALLOWLIST`) with that summary and the transcript.

### Document shape

- `parties[]`: one entry per speaker. The collaborator's party carries
  `mailto`.
- `dialog[]`: `type: "text"` per utterance with `start`, `duration`,
  `parties: [index]`, `body`.
- `attachments[0]` (`meeting_metadata`): meeting code/URL, `delivery_kind`,
  `transcription_source`, `captured_by_user`, and for live sources
  `transcription: { provider, model, language, stream_started_at }`. When the
  final report failed, `analysis_error` explains why.
- `analysis[]` (live sources, when available):
  - `type: "summary"`, `encoding: "none"`, `body`: summary text.
  - `type: "meeting_insights"`, `encoding: "json"`,
    `schema: "sippulse-meet-analysis/1"`, `body`: `{ language, title, summary,
    key_points[], topics[{title,start,summary}], action_items[{owner,task,due}],
    decisions[], open_questions[], intents[{speaker,intent,detail,at,confidence}],
    sentiment[{speaker,label,score,note}], generated_at }`. The narrative fields
    come from the LLM; `intents` and `sentiment` are aggregated from the Jev
    classifications.
  - `type: "speaker_analytics"`, `encoding: "json"`,
    `schema: "sippulse-speaker-stats/1"`, `body`: `[{ speaker, talk_seconds,
    talk_share, words, turns, longest_turn_seconds, questions,
    words_per_minute }]`. Unnamed remote speech is excluded.
  - `type: "utterance_classification"`, `encoding: "json"`,
    `vendor: "typesafe.ai"`, `schema: "sippulse-meet-classification/1"`,
    `body`: `[{ dialog, intent, intent_confidence, sentiment, action_item }]`
    where `dialog` is the index into `dialog[]`, `sentiment` is -1..1, and
    `action_item` is the probability that the line is an action item. Intent
    labels: `commitment`, `decision`, `question`, `objection`,
    `purchase_interest`, `problem_report`, `scheduling`, `information`,
    `small_talk`.

The email should lead with the summary and action items, then decisions,
topics, intents, speaker talk time, and the transcript. `vcon.toMarkdown()` in
`src/lib/vcon.js` renders exactly that layout and can be used as the
reference.

## Reliability and responses

The store is idempotent by vCon `uuid` and **keeps the first copy**: a later
delivery of the same uuid answers `duplicate` without replacing it. The
extension delivers once per meeting (live result, else saved segments, else
captions) and retries the same document, so this is safe; it also means a
better transcript can never replace a worse one after the fact. A `duplicate`
answer is shown to the collaborator as delivered *and* already stored, rather
than as a fresh save.

Queued deliveries are retried against the endpoint and secret configured **at
retry time**, so rotating either one does not strand the outbox.

## Gaps on the CRM side

These are CRM changes, not extension changes:

1. **Every captured meeting is flagged internal.** Google Meet does not expose
   participant emails, so only the collaborator's party has a `mailto`
   (`@sippulse.com`), and `isInternalMeeting` sees "all emails are
   SipPulse". Customer meetings then stay out of the company views and get no
   company suggestion. Parties without `mailto` should make a meeting
   *not internal* (or unknown).
2. **The email ignores the extension's report.** The CRM runs a second LLM
   pass and emails only its own summary and the transcript. It could use the
   `meeting_insights` entry (summary, action items, decisions, intents) and
   `speaker_analytics` when present, and skip the second pass.

## Verifying against the real services

`npm run e2e:live` runs the real offscreen recorder in Chromium against the
SipPulse AI dev gateway and TypeSafe with a synthetic two-voice Portuguese
meeting, and checks that the transcript, speaker names, classifications, and
report all come back. It reads `SIPPULSE_DEV_API_KEY` and `TYPESAFE_AI_KEY`
from the environment or `.env`.
