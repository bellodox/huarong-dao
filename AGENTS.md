# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Commands and configuration
- “Ship”, “release”, and “next beta patch” mean local preparation/versioning/validation/review only, never deployment. Do not run cloud authentication/status probes, logins, deployment, or remote publishing unless explicitly requested; do not infer commit/tag/push authorization. No GitHub push is authorized. Beta.3 is prepared locally, not deployed; cloud authentication does not block local completion. The optional issuer secret is not a prerequisite for local-only play.
- Five checkout-relative Python Playwright scripts and their prerequisites/commands are listed in [local QA guidance](README.md#available-local-qa-commands); the deep script includes independent Python BFS. No package manifest, lockfile, package test runner, or build/lint scripts are checked in. Do not invent package commands or confuse [parent-reported validation](README.md#validation-evidence-and-limits) with freshly executed checks.
- No formatter, linter, import-order, naming, or type configuration is checked in; do not impose inferred style rules. [Wrangler configuration](wrangler.jsonc:2) defines deployment and asset routing only.

## Hidden contracts
- The browser game, scoring, solver, signing, and translation logic share ordered inline scripts in [the HTML asset](docs/index.html:2405), not separate frontend modules.
- Preserve [the exact empty issuer declaration](docs/index.html:1766): [the Worker replacement sentinel](worker.js:3) is a literal text match; changing it causes configured root requests to return 500. The Worker is unchanged for beta.3.
- [Worker injection](worker.js:28) exposes the issuer key in delivered HTML. Worker secrets do not make it private; use only a disposable experiment wallet. [No issuer](worker.js:14) serves the unchanged local-only asset.
- Keep [asset binding and Worker-first paths](wrangler.jsonc:5) aligned with [GET-only root interception](worker.js:8); other requests pass through to assets.
- The [14-layout catalog](docs/index.html:3100) has 3 unscored practice and 11 ranked layouts. Training, First Steps, and Next Steps never save/publish scores or commit names. Preserve stable IDs and the Training startup selection; legacy practice-only records must not lock names.
- [First-score confirmation](docs/index.html:2824) verifies a combined owner/score record before locking the nickname, restoring the prior name if the score save fails; this applies without public scoring too. Retain cross-tab locking, durable bests, duplicate suppression, and stale-retry guards.
- [Assistance activation](docs/index.html:2552) enables the solver lazily and excludes scoring. Preserve [single-cell BFS moves](docs/index.html:3566) and [interchangeable-piece canonicalization](docs/index.html:3478).
- Keep [custom name-input signing](docs/index.html:4222); the upstream script parser mishandles long name values. [Publication](docs/index.html:4264) creates the player identity only when needed.
- New Bulgarian UI text also needs [the inline translation map](docs/index.html:4520); [the mutation observer](docs/index.html:4821) translates dynamic text.
- Preserve [dialog keyboard handling](docs/index.html:4028) and [analytics consent/withdrawal](docs/index.html:4883), including host/domain cookie cleanup at startup after rejection. Analytics consent and public-score consent are independent.
- [Beta validation evidence](README.md#validation-evidence-and-limits) is parent-reported local testing. Live analytics, broadcasts, public leaderboard integration, and deployment remain unverified; documentation work does not verify them.
