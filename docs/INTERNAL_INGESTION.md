# SipPulse Meet Ingestion Contract

The extension sends every meeting to the managed `EndpointUrl`. The service is
responsible for SipPulse.ai transcription, CRM persistence, and email delivery.
Never expose the SipPulse.ai API key to the extension.

## Google-caption requests

`POST EndpointUrl` with `Content-Type: application/vcon+json` and headers:

- `X-SipPulse-Delivery: final|recovered|test`
- `X-SipPulse-Transcription-Source: google_captions|google_captions_fallback`

`final` and `recovered` requests atomically upsert the vCon and enqueue one
transcript email to `attachments[].body.captured_by_user.email`. `test`
requests carry `google_captions` as the source and must not be stored or
emailed. Until SSO is in place, `captured_by_user.email` is asserted by the
client; do not use it for authorization, and restrict email delivery to
allowed company domains server-side. Google-caption
recovery records remain encrypted in the browser until one of these requests.

## SipPulse.ai requests

The final request is `multipart/form-data` with:

- `audio`: WebM/Opus containing Meet tab audio mixed with collaborator microphone
- `vcon_uuid`: stable meeting UUID
- `fallback_vcon`: caption-derived vCon and meeting metadata
- `transcription_provider`: `sippulse_ai`
- `model`: `pulse-telephony`
- `response_format`: `diarization`

The ingestion service sends the audio server-side to
`https://api.sippulse.ai/v1/asr/transcribe` using its own `api-key`. Send
`model=pulse-telephony`, request diarization, and omit `language` so language is
detected automatically. Convert returned speaker segments into `parties[]` and
`dialog[]`, preserve `vcon_uuid`, set `transcription_source=sippulse_ai`, store
the final vCon in CRM, and enqueue the diarized transcript email.

## Reliability and responses

Use `vcon_uuid` as the idempotency key, with `test` requests handled separately.
The extension may deliver the same UUID twice (audio first, captions later) when
an upload result is lost; a later `google_captions_fallback` request must not
replace a completed SipPulse AI transcript or trigger a second email.
A successful audio
upload returns HTTP 202 with `{ "request_id": "..." }`; a vCon upload returns
HTTP 200/202. Processing failures must use a non-2xx status. Delete raw audio
after transcription completes or permanently fails. The CRM vCon follows the
CRM's retention policy; email delivery must be auditable without retaining a
second transcript copy in the ingestion service.
