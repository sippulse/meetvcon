# SipPulse Meet Capture — Internal Product Contract

## Outcome

After an authorized Google Meet call, SipPulse stores one diarized vCon in CRM
and emails a readable transcript to the collaborator who captured it. Employees
never configure webhooks, API keys, delivery modes, or file formats.

## Required behavior

1. Capture begins only after the collaborator accepts the in-product disclosure
   and Chrome reports a signed-in `@sippulse.com` profile.
2. Google captions provide an automatic, speaker-labelled fallback stored only
   in the encrypted local recovery record until final delivery.
3. The collaborator may start higher-quality audio capture with one extension
   action. Record the Meet tab and local microphone, keeping the panel visible.
4. SipPulse ingestion sends audio server-side to SipPulse.ai with
   `model=pulse-telephony`, diarization enabled, and no language parameter.
5. The final vCon preserves one UUID, maps speakers to `parties[]`, maps timed
   segments to `dialog[]`, and identifies the collaborator in meeting metadata.
6. Final processing stores/upserts one CRM vCon and queues exactly one email to
   the collaborator. No intermediate transcript leaves the browser.
7. “Stop and discard” stops captions and audio, removes recovery data, and
   prevents delivery for that call.

## Reliability and privacy

- Encrypt active captions and failed-delivery bodies at rest.
- Keep recorded audio in memory and delete it after upload.
- Persist retry metadata without transcript text; exhausted retries remain
  visible and manually recoverable.
- Restore retry alarms after browser/service-worker restart.
- Recover stale encrypted meetings through the Google-caption fallback.
- Use timeouts, idempotency by vCon UUID, and a fixed
  SipPulse-only HTTPS origin.
- Treat SipPulse.ai as a processor and delete server-side raw audio when
  transcription completes or permanently fails.

## Non-goals

The internal version does not support arbitrary webhooks, user API keys,
multiple destinations, public self-service installation, transcript editing,
or direct email sending from Chrome.

## Success measures

- At least 98% of authorized calls produce a CRM vCon without manual recovery.
- At least 95% of final transcripts are emailed within five minutes.
- Fewer than 5% of calls fall back from SipPulse AI to Google captions.
- No transcript is delivered after a collaborator chooses discard.
