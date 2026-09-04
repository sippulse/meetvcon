# Repository Guidelines

## Project Structure & Module Organization

This is a build-free Chrome Manifest V3 extension for internal SipPulse use. `manifest.json` is the runtime entry point. Shared browser utilities live in `src/lib/`; Google Meet detection, caption fallback, and the in-call panel are in `src/content/`. The service worker owns encrypted recovery, delivery, and retries in `src/background/`: put behavior in `worker-core.mjs` (dependency-injected, unit tested) and keep `service-worker.js` as wiring only. `src/offscreen/` records tab and microphone audio and reports upload results back as `ai_upload_result`; `src/permissions/` holds the one-time microphone grant page. User interfaces live in `src/options/` and `src/popup/`. Tests mirror library concerns under `tests/`; store assets and their generator are in `screenshots/` and `tools/`.

Read `PRD.md` before changing product behavior. Read `docs/INTERNAL_INGESTION.md` when changing the upload, CRM vCon, email, or SipPulse AI contract.

## Build, Test, and Development Commands

There is no compile step; Chromium loads the repository root directly.

- `npm install` installs the Playwright-based screenshot tooling.
- `npm test` runs the Node test suite.
- `npm run check` syntax-checks JavaScript in `src/`, `tools/`, and `tests/`.
- `npm run screenshots` launches Chromium and regenerates the three store images.

For local development, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this repository. Use the managed-policy example in `INSTALL.md`; capture fails closed without it.

## Coding Style & Naming Conventions

Use plain JavaScript with two-space indentation, semicolons, double-quoted strings, `camelCase` identifiers, `UPPER_SNAKE_CASE` constants, and kebab-case filenames. Content-script libraries attach APIs to `MeetVcon`; service-worker files may use ES modules. Match surrounding code because no formatter or linter is configured.

## Testing Guidelines

Name tests after their module, such as `tests/vcon.test.js`. Add focused tests for parsing, configuration, vCon shaping, and retry-state changes. Delivery, discard, recovery, and AI-session changes belong in `tests/worker-core.test.js` using `tests/fake-chrome.js`; do not add service-worker behavior without a test there. Before opening a PR, run `npm test`, `npm run check`, and a Chromium smoke test. Changes to capture or delivery also require a real Meet test against staging.

## Commit & Pull Request Guidelines

History uses concise imperative subjects, sometimes prefixed with `Fix:`. Keep commits focused. PRs should explain user-visible behavior, link the issue, list verification performed, and include updated screenshots for UI changes.

## Security & Configuration

Keep API keys server-side. Never commit managed bearer tokens, transcripts, audio, `.env` files, or browser profiles. Preserve the fixed SipPulse API origin and narrowly scoped Chrome permissions; explain permission changes in the PR.
