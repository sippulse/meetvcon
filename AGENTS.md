# Repository Guidelines

## Project Structure & Module Organization

This is a build-free Chrome Manifest V3 extension for internal SipPulse use. `manifest.json` is the runtime entry point. Shared browser utilities live in `src/lib/`; Google Meet detection, caption fallback, and the bridge that feeds the side panel are in `src/content/`. The service worker owns encrypted recovery, delivery, and retries in `src/background/`: put behavior in `worker-core.mjs` (dependency-injected, unit tested) and keep `service-worker.js` as wiring only. `src/offscreen/` streams tab and microphone audio to the SipPulse AI gateway, classifies each line with TypeSafe Jev, runs SipPulse AI analysis, relays live transcript/tags/notes as `live_update`, and reports the final transcript and report as `ai_session_result`; provider logic that can be pure lives in `src/lib/transcription.js`, `src/lib/classification.js`, and `src/lib/analysis.js`; `src/permissions/` holds the one-time microphone grant page. User interfaces live in `src/sidepanel/` (the in-call panel, rendered from the pure view model in `src/lib/panel-model.js`), `src/options/` and `src/popup/`. Tests mirror library concerns under `tests/`; store assets and their generator are in `screenshots/` and `tools/`.

Read `PRD.md` before changing product behavior. Read `docs/INTERNAL_INGESTION.md` when changing the vCon (the receiving store lives in the sibling `sippulse-website` repo, `src/app/api/vcons/ingest/route.ts`), `analysis[]` shape, CRM, email, SipPulse AI, or TypeSafe contract.

## Build, Test, and Development Commands

There is no compile step; Chromium loads the repository root directly.

- `npm install` installs the Playwright-based screenshot tooling.
- `npm test` runs the Node test suite.
- `npm run check` syntax-checks JavaScript in `src/`, `tools/`, and `tests/`.
- `npm run screenshots` launches Chromium and regenerates the three store images.

For local development, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this repository. Configure it from the options page Settings card (or Google Admin policy, see `INSTALL.md`); capture fails closed until the vCon endpoint and token are set.

## Coding Style & Naming Conventions

Use plain JavaScript with two-space indentation, semicolons, double-quoted strings, `camelCase` identifiers, `UPPER_SNAKE_CASE` constants, and kebab-case filenames. Content-script libraries attach APIs to `MeetVcon`; service-worker files may use ES modules. Match surrounding code because no formatter or linter is configured.

## Testing Guidelines

Name tests after their module, such as `tests/vcon.test.js`. Add focused tests for parsing, configuration, vCon shaping, streaming result handling (`tests/transcription.test.js`), Jev questions and aggregation (`tests/classification.test.js`), analysis prompts and output coercion (`tests/analysis.test.js`), and retry-state changes. Delivery, discard, recovery, and AI-session changes belong in `tests/worker-core.test.js` using `tests/fake-chrome.js`; do not add service-worker behavior without a test there. Before opening a PR, run `npm test`, `npm run check`, `npm run e2e:live` (real SipPulse AI dev and TypeSafe; keys from `.env`), and a Chromium smoke test. Changes to capture or delivery also require a real Meet test against staging.

## Commit & Pull Request Guidelines

History uses concise imperative subjects, sometimes prefixed with `Fix:`. Keep commits focused. PRs should explain user-visible behavior, link the issue, list verification performed, and include updated screenshots for UI changes.

## Security & Configuration

Keep API keys out of the repository. Settings come from Google Admin policy (`chrome.storage.managed`, preferred, locks the field) or from the options page's local settings, which the worker stores encrypted and never returns unmasked; keep that precedence in `config.merge` and only accept `save_settings` from the options page. `.env` is for `npm run e2e:live` and is git-ignored. Never commit the vCon HMAC secret, provider keys, transcripts, audio, `.env` files, or browser profiles. Never hardcode an endpoint: this is open source, so every destination comes from configuration (`src/lib/config.js`), must be HTTPS, and is reached through an optional host permission granted at runtime; the manifest only grants `meet.google.com`. The single exception is `DEFAULT_SIPPULSE_AI_URL` (`https://api.sippulse.ai`), the overridable default for `SipPulseAiUrl`, so the minimal configuration is the SipPulse AI key plus the vCon store; the vCon store never has a default. Explain permission changes in the PR.
