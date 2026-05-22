# Installing MeetVcon

Step-by-step guide for installing, updating, and troubleshooting MeetVcon
as an unpacked Chromium extension. For a one-paragraph summary, see the
[README](./README.md#install-developer-mode).

The extension is not yet on the Chrome Web Store. Until then, it runs in
**developer mode** from a local clone of this repository.

## Requirements

- Chrome, Edge, Brave, or any Chromium-based browser, **version 120+**
  (required by `manifest.json`).
- Git (recommended, so you can `git pull` to update). Download-zip works
  but skips the update path.
- A reachable HTTPS webhook to receive vCon payloads. For local testing,
  see [Webhook receiver: minimal example](./README.md#webhook-receiver-minimal-example).

## Install

1. **Clone the repo** somewhere stable on disk — *not* a tmp directory,
   not a path that an IDE / sandbox may rewrite or delete. Chromium reads
   files from this directory every time the extension runs.

   ```bash
   git clone https://github.com/sippulse/meetvcon.git ~/code/meetvcon
   ```

2. Open the extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Brave: `brave://extensions`

3. Toggle **Developer mode** (top right corner).

4. Click **Load unpacked** and select the directory you cloned into
   (the folder that contains `manifest.json`, **not** `src/`).

5. Pin the extension from the toolbar puzzle-piece menu so the icon is
   always visible.

6. Right-click the MeetVcon icon → **Options**. Paste your webhook URL,
   choose a delivery mode, click **Save**. Then click **Send test payload**
   to confirm the receiver gets a vCon.

That's it. The next time you open a Google Meet, MeetVcon will start
capturing captions automatically.

## Update

Because the extension is loaded from disk, Chromium does not auto-update
it. To pick up a new release:

```bash
cd ~/code/meetvcon
git pull
```

Then go to `chrome://extensions` and click the **Reload** icon (⟳) on
the MeetVcon row. Your saved configuration and meeting history persist
across reloads.

If you cloned somewhere else, run `git pull` in that directory instead.
The path that Chromium uses is shown under the extension name in
`chrome://extensions` → **Details**.

## Uninstall

`chrome://extensions` → **Remove** on the MeetVcon row. This deletes
all stored config, the delivery queue, and the local meeting history.

To wipe local data without uninstalling, open the popup → click
**Remove** on each meeting, or open the DevTools console on the popup
and run:

```js
chrome.storage.local.clear()
```

## Troubleshooting

### "File not found" when clicking the extension icon

The extension is loaded from a path that no longer exists. This happens
when you reload Chromium after moving / renaming / deleting the source
directory.

**Fix:**

1. `chrome://extensions` → **Remove** on the MeetVcon row.
2. Click **Load unpacked** again and select the current location of
   the cloned repo.

To confirm where Chromium is reading from: `chrome://extensions` →
**Details** → **Source**.

### "Errors" red badge on the extension row

Open `chrome://extensions` and click the red **Errors** button next to
MeetVcon. The most common causes:

- A file referenced by `manifest.json` was deleted or renamed locally.
  Run `git status` in the repo and discard any unintended local changes,
  then **Reload** the extension.
- A syntax error after editing a JS file. The error message includes
  the filename and line.

### Webhook returns HTTP 404 (visible next to each meeting)

The extension is fine — your webhook endpoint is returning 404. Confirm
with curl:

```bash
curl -i -X POST \
  -H 'Content-Type: application/vcon+json' \
  -d '{"test":true}' \
  '<YOUR_WEBHOOK_URL>'
```

Common causes: missing path segment (e.g. `/webhook`), typo in path,
endpoint deactivated, or a temporary URL (webhook.site, ngrok free)
that expired.

Once you fix the URL in Options, click **Resend** on each affected
meeting in the popup to re-deliver, or **Remove** to drop them.

### Captions aren't being captured in Meet

Look at the in-call panel (bottom-right corner of the Meet tab). If it
shows the watchdog is enabled but no utterances appear, Meet may have
shipped a DOM change. Open an issue with your Chromium version, Meet
language, and an excerpt from the DevTools console filtered for
`[MeetVcon]`.

The first place a maintainer will look is `src/lib/selectors.js`.

### Permission denied for the webhook host

The extension requests host permission for the webhook origin the first
time you save. If you denied it, reopen Options and click **Save** again
to re-prompt. The permission is scoped to that specific origin —
`https://your.host/*`.

## Security notes

- Webhook URL, bearer token, and HMAC secret are stored in
  `chrome.storage.local` on your machine only. They are never transmitted
  anywhere except as part of the configured webhook request.
- The vCon payload includes any speaker name Meet exposes. Speaker emails
  are off by default (toggleable in Options). The capturer's Chrome
  profile email is on by default (toggleable).
- For HMAC-signed delivery, the receiver should verify
  `X-MeetVcon-Signature: sha256=<hex>` against the raw request body
  before parsing.
