# SipPulse Meet Capture: user manual

For the person in the meeting. If you are the administrator rolling this out
across the company, read [INSTALL.md](../INSTALL.md) instead.

---

## 1. What it does, in one paragraph

While you are in a Google Meet, the extension writes a transcript with the
name of whoever is speaking. When the call ends it writes the meeting report,
which includes the summary, what was decided, who committed to what and by
when, the figures that were quoted, and the risks still open. The report and
the transcript are stored in the company's vCon store and emailed to you. No
audio is kept anywhere.

**Before you capture anything, tell the other participants.** The extension
gives you the tooling, not the permission. Company policy and the law still
apply.

---

## 2. First run, once per computer

1. **Open the options page.** Click the SipPulse icon in the Chrome toolbar,
   then **Settings**.
2. **Read the disclosure and click "I understand, enable capture".** Nothing
   is captured before you do.
3. **Check the Connection card.** If Configuration says *Ready*, your
   administrator already pushed the keys. If it lists missing values, fill
   them in the Settings card, or ask IT.
4. **Grant host access if asked.** Chrome only lets the extension reach the
   servers you approve, and only from a click. If a line appears saying access
   was not allowed, click **Allow access**.
5. **Click "Test connections".** The vCon store, transcription and SipPulse AI
   should all report OK. TypeSafe reports OK too when your company uses it.
6. **Allow the microphone once.** The first time you start live transcription,
   a tab opens asking for microphone access. Allow it, go back to Meet, and
   start again. Chrome remembers.

---

## 3. In a meeting

### Open the panel

Click the SipPulse icon, then **Open the meeting panel**. The panel opens on
the right side of the browser, beside the call, and stays there while you
switch tabs. You can also open it from Chrome's own side panel menu in the
toolbar.

Nothing is drawn on top of the Meet page. The panel is the interface.

If your administrator set the transcript source to **Google captions**, there
is no button to press: the extension switches captions on, reads them, and
writes the report at the end. The rest of this section is about the default,
where SipPulse AI transcribes the call audio.

### Start live transcription

Click **Start live transcription** in the panel. The status line turns red and
reads *Live transcription on (tab audio + microphone)*.

Until you click it, the extension only reads Google's own captions, and only
when you have them on. That fallback has no speaker separation from your
microphone and no AI notes. The extension never turns captions on for you, so
if you leave them off and never start live transcription, nothing is
captured.

### The three tabs

- **Transcript.** Each line with the speaker's name and the time from the
  start of the call. When your company uses TypeSafe, lines carry tags such as
  *question*, *commitment*, *objection* or *buying signal*. Grey italic text is
  speech still being recognised.
- **Notes.** The meeting report. By default it is written once, when the call
  ends, so during the call this tab tells you that. If your administrator set
  `AnalysisMode` to `live`, notes appear about a minute in and refresh every
  minute.
- **Speakers.** Talk time per person, with a bar for the share of the
  conversation and the sentiment label when classification is on.

### Pause it

**Stop live transcription** ends the audio streaming and keeps everything
written so far. The button turns into **Resume live transcription**, and
starting again continues the same transcript on the same timeline. What was
said while it was off is simply not in the transcript.

### Stop a call you do not want recorded

Click **Stop and discard this call**. Capture stops, the saved data for that
call is deleted, and nothing is delivered. That decision holds even if you
reload the tab or rejoin.

---

## 4. After the call

Leave the meeting and keep Chrome open for about a minute. The popup walks
through *Preparing the meeting report*, then *Delivered*.

You get:

- **An email** with the headline, the summary, action items, the next step,
  decisions, figures, risks, topics, talk time and the transcript.
- **A vCon in the company store**, which the CRM indexes against the customer.
- **A local copy**, in the popup under *Last transcript*. Download it as `.md`
  to read or paste, or as `.vcon` for the raw document.

If delivery fails, the popup shows an **Outbox**. It retries on its own. You
can also press **Retry**, **Download** the report, or **Discard** the item.

---

## 5. When something looks wrong

### The transcript is poor, or has no names

You are probably on the Google captions fallback. Check which source was used:

1. In the popup, look at *Last transcript*. It says *live transcript* or
   *Google captions copy*.
2. For the definitive answer, download the `.md`. The header carries one line:

   | Value | What happened |
   |---|---|
   | `sippulse_ai_live` | Live transcription worked |
   | `sippulse_ai_live_recovered` | It worked, but the recorder died and the transcript was rebuilt from what had been saved |
   | `google_captions_fallback` | Live transcription started and produced nothing usable |
   | `google_captions` | Live transcription was never started |

If you see `google_captions`, you did not click **Start live transcription**.
If you see `google_captions_fallback`, check host access and the key in the
options page, and use **Test connections**.

### The panel says "Open a Google Meet to begin"

The active tab is not a Meet call. Switch to the Meet tab; the panel follows
within two seconds.

### The panel says capture is not configured, or asks for consent

The status line names the missing piece. Click the button below it to go
straight to the options page.

### "Reconnecting to live transcription"

The network dropped. It reconnects on its own and the transcript resumes with
correct timestamps. If it stays amber for more than a minute, stop and start
live transcription again.

### The report never arrived by email

Check the popup first: if it says *Delivered*, the extension did its job and
the CRM owns the email. Talk to IT with the meeting subject and time.

---

## 6. What leaves your browser

| What | Where it goes | When |
|---|---|---|
| Meeting audio | SipPulse AI, for transcription | While transcription is on. Never stored. |
| Transcript text | SipPulse AI, to write the report | When the call ends, or every minute in live mode |
| Each transcript line | TypeSafe, for intent and sentiment | Only when your company configured it |
| The final vCon | Your company's vCon store, then your inbox | When the call ends |

Questions about privacy: security@sippulse.com

---

*SipPulse Meet Capture 1.0.0*
