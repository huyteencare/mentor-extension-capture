# Repository Guidelines

## Project Structure & Module Organization

This repository is a Manifest V3 Chrome extension for mentor-side Google Meet capture. Top-level entry points are `manifest.json`, `background.js`, `hook.js`, `content.js`, `popup.*`, and `viewer.*`. The `background/` directory holds the service-worker modules: session state, participant mapping, tag-join detection, upload, and debug logging. Research and operational notes live under `docs/`. Build output goes to `dist/` and should be treated as generated.

## Build, Test, and Development Commands

- `./build.sh`  
  Packages the extension into `dist/meet-capture-mentor.zip`.
- `node --check background.js`  
  Syntax-check a file after edits; use the same pattern for `hook.js`, `popup.js`, or files under `background/`.
- `curl http://127.0.0.1:8787/api/sessions`  
  Quick backend sanity check when testing against the local API.

For local development, update `config.js`, reload the unpacked extension in `chrome://extensions/`, and inspect the service worker for background logs.

## Coding Style & Naming Conventions

Use plain JavaScript with 2-space indentation and semicolons, matching the existing files. Prefer small single-purpose modules under `background/`. Use `camelCase` for variables/functions, `UPPER_SNAKE_CASE` for constants, and kebab-style filenames only where already established. Keep logging prefixes stable, e.g. `[Meet Capture]`, `[Hook]`, and identity debug event names.

## Testing Guidelines

There is no formal test suite in this repo. Verify changes with:

- `node --check` on every edited JS file
- manual Meet flows in Chrome
- local API inspection (`/api/sessions`, debug JSONL logs if enabled)

When changing participant mapping or replacement handling, test at least: initial join, name detection, tab switch/camera recreate, and multi-participant behavior.

## Commit & Pull Request Guidelines

Recent history uses short imperative subjects, often with prefixes such as `feat:`, `refactor:`, or `docs:`. Keep commits focused and descriptive, for example: `refactor: tighten replacement-video continuity matching`.

PRs should include:

- the user-visible behavior change
- config or permission changes (`manifest.json`, `config.js`)
- manual test steps and outcomes
- screenshots or logs for popup/viewer/debug-flow changes

## Security & Configuration Tips

Do not commit environment-specific API URLs or secrets beyond the checked-in defaults. Review `host_permissions` carefully before widening access. Keep storage and upload naming behavior backward-compatible unless the backend/viewer contract is being updated in the same change.
