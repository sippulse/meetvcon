# SipPulse Meet Ingestion Contract

The extension sends every finished meeting to the managed `EndpointUrl` as a
single vCon. Transcription, classification, and meeting analysis happen during
the call, so the ingestion service never receives audio: it stores the vCon in
CRM and emails the transcript and report to the collaborator.

## Where each step runs

| Step | Where | Credential |
|---|---|---|
| Live transcription | Offscreen document → SipPulse AI gateway `wss://api.dev.sippulse.ai/v1/listen` (Deepgram-compatible protocol, `pulse-stt-streaming-v1`, `pt-BR`, mono linear16 8 kHz, `endpointing=700`). One WebSocket for the microphone, one for the Meet tab. | `SipPulseAiApiKey` policy, sent as `Sec-WebSocket-Protocol: token, <key>` |
| Inline classification | Offscreen document → TypeSafe `POST https://api.typesafe.ai/v1/systemone` (`jev-latest`) once per final transcript segment: intent (Choice), sentiment (Score 0–4), action item (Noul) | `TypeSafeApiKey` policy, `Authorization: Bearer` |
| Live notes and final report | Offscreen document → SipPulse AI `POST https://api.dev.sippulse.ai/v1/openai/chat/completions` (`deepseek-v4.1-flash`, JSON schema) | `SipPulseAiApiKey` policy, `api-key` header |
| vCon storage and email | Service worker → `EndpointUrl` | `BearerToken` policy (pilot) |

The streaming model is only deployed on the SipPulse AI **dev** environment
for now, so the key must be a dev key; production will be `api.sippulse.ai`
(`SIPPULSE_AI_HOST` in `src/lib/config.js`). The model itself is multilingual
(a nemotron-asr derivative), but the dev gateway validates
`language ∈ {pt-BR, pt}` and rejects anything else at the handshake with
HTTP 400 `UNSUPPORTED_LANGUAGE`; when it opens up, change `language` in
`TRANSCRIPTION`.

The gateway does not diarize. The collaborator is identified by the
microphone stream; each remote segment is named from the Google Meet caption
that overlaps it in time, or `Participant` when there is none.

## vCon requests

`POST EndpointUrl` with `Content-Type: application/vcon+json`,
`Authorization: Bearer <BearerToken>`, and headers:

- `X-SipPulse-Delivery: final|recovered|test`
- `X-SipPulse-Transcription-Source`, one of:
  - `sippulse_ai_live` — full live transcript plus the final report
  - `sippulse_ai_live_recovered` — the recorder did not report back; the
    transcript was rebuilt from segments saved during the call, with the latest
    live notes and the classifications made so far
  - `google_captions` — live transcription was never started
  - `google_captions_fallback` — live transcription produced nothing usable

`final` and `recovered` requests atomically upsert the vCon and enqueue one
email to `attachments[].body.captured_by_user.email`. `test` requests carry
`google_captions` as the source and must not be stored or emailed. Until SSO
is in place, `captured_by_user.email` is asserted by the client; do not use it
for authorization, and restrict email delivery to allowed company domains
server-side.

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

Use the vCon `uuid` as the idempotency key, with `test` requests handled
separately. The extension may deliver the same UUID twice when a response is
lost; a later request must not replace a completed `sippulse_ai_live` vCon with
a recovered or caption-based one, and must not trigger a second email. Return
HTTP 200/202 on success; processing failures must use a non-2xx status so the
extension's encrypted outbox retries. The CRM vCon follows the CRM's retention
policy; email delivery must be auditable without retaining a second transcript
copy in the ingestion service.

The audio multipart upload (`transcription_provider=sippulse_ai`,
`pulse-telephony`) used by version 0.2 is no longer sent and can be retired
once no 0.2 installations remain.

## Verifying against the real services

`npm run e2e:live` runs the real offscreen recorder in Chromium against the
SipPulse AI dev gateway and TypeSafe with a synthetic two-voice Portuguese
meeting, and checks that the transcript, speaker names, classifications, and
report all come back. It reads `SIPPULSE_DEV_API_KEY` and `TYPESAFE_AI_KEY`
from the environment or `.env`.
