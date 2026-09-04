# Internal Installation and Policy

## Developer installation

1. Run `npm install`, `npm test`, and `npm run check`.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select the repository root and note the generated extension ID.
4. Apply managed policy using that ID, then verify it at `chrome://policy`.
5. Reload the extension and accept the disclosure on its options page.

Linux policy example (`/etc/opt/chrome/policies/managed/sippulse-meet.json`):

```json
{
  "3rdparty": {
    "extensions": {
      "EXTENSION_ID": {
        "EndpointUrl": "https://api.sippulse.com/v1/meet-captures",
        "BearerToken": "ROTATABLE_PILOT_TOKEN",
        "CaptureEnabled": true,
        "PreferredTranscription": "sippulse_ai"
      }
    }
  }
}
```

The bearer policy is a pilot mechanism. Replace it with SipPulse SSO before
broad deployment; do not put the SipPulse.ai API key in browser policy.

## Company deployment

Publish privately for the SipPulse Workspace domain, deploy first to a pilot
organizational unit, and configure the policy declared by
`enterprise-policy.json`. The production package must use a stable extension ID.
Force installation only after consent, capture, fallback, CRM, email, and
discard behavior have passed the pilot checklist.

## Manual verification

1. Confirm capture stays off before consent and for a non-SipPulse Chrome profile.
2. Join Meet and verify the visible panel and Google-caption count.
3. Click the extension, start SipPulse AI, and grant microphone access.
4. Confirm remote audio remains audible during recording.
5. End the call; verify CRM stores the diarized vCon and the collaborator receives one email.
6. Repeat with a failed endpoint, then restore it and retry from the outbox.
7. Start another call, choose **Stop and discard**, and verify nothing is delivered.
