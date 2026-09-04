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
        "PreferredTranscription": "sippulse_ai",
        "AllowedEmailDomains": ["sippulse.com"]
      }
    }
  }
}
```

The bearer policy is a pilot mechanism. Replace it with SipPulse SSO before
broad deployment; do not put the SipPulse.ai API key in browser policy.
`AllowedEmailDomains` is optional and defaults to `sippulse.com`.

### Microphone permission

The background recorder cannot show Chrome's microphone prompt. The first time
a collaborator starts SipPulse AI capture, the popup opens
`src/permissions/microphone.html` in a tab to request the grant once; after
that the recorder reuses it. Administrators can pre-grant it and skip the tab
with the Chrome policy `AudioCaptureAllowedUrls` containing
`chrome-extension://EXTENSION_ID/` (verify this against your Chrome version in
the pilot before relying on it).

## Company deployment

Publish privately for the SipPulse Workspace domain, deploy first to a pilot
organizational unit, and configure the policy declared by
`enterprise-policy.json`. The production package must use a stable extension ID.
Force installation only after consent, capture, fallback, CRM, email, and
discard behavior have passed the pilot checklist.

## Manual verification

1. Confirm capture stays off before consent and for a non-SipPulse Chrome profile.
2. Join Meet and verify the visible panel and Google-caption count.
3. Click the extension and start SipPulse AI. On first use a tab asks for
   microphone access; allow it, return to Meet, and start again.
4. Confirm remote audio remains audible during recording.
5. Confirm the in-call panel switches to "Recording tab audio and microphone".
6. End the call; the popup shows "Uploading audio", then "SipPulse AI is
   processing". Verify CRM stores the diarized vCon and the collaborator
   receives one email.
7. Repeat with a failed endpoint, then restore it and retry from the outbox.
   Confirm **Download** on the outbox row and "Last transcript" in the popup
   produce a readable `.md`.
8. Start another call, choose **Stop and discard**, reload the Meet tab, and
   verify the panel stays in the discarded state and nothing is delivered.
9. Join a call where nobody speaks and leave; confirm the popup does not stay
   on "Google captions active".
