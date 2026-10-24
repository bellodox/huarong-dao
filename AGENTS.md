# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Commands and configuration
- Deploy from the repository root with [the documented Wrangler command](README.md:21); [the next command](README.md:29) sets the optional issuer secret, not a prerequisite for local-only play.
- No package manifest, lockfile, build/lint scripts, test runner, or single-test command is checked in. Do not invent them or treat [historical validation claims](README.md:43) as runnable tests.
- No formatter, linter, import-order, naming, or type configuration is checked in; do not impose inferred style rules. [Wrangler configuration](wrangler.jsonc:2) defines deployment and asset routing only.

## Hidden contracts
- The browser game, scoring, solver, signing, and translation logic share ordered inline scripts in [the HTML asset](docs/index.html:2384), not separate frontend modules.
- Preserve [the exact empty issuer declaration](docs/index.html:1760): [the Worker replacement sentinel](worker.js:3) is a literal text match; changing it causes configured root requests to return 500.
- [Worker injection](worker.js:28) exposes the issuer key in delivered HTML. Worker secrets do not make it private; use only a disposable experiment wallet. [No issuer](worker.js:14) serves the unchanged local-only asset.
- Keep [asset binding and Worker-first paths](wrangler.jsonc:5) aligned with [GET-only root interception](worker.js:8); other requests pass through to assets.
- [Training and first-steps IDs](docs/index.html:2521) have different contracts: training never saves scores; first steps saves locally but never publishes. Assistance excludes a run from scoring.
- [First-score confirmation](docs/index.html:2802) verifies a combined owner/score record before locking the nickname, restoring the prior name if the score save fails; this applies without public scoring too.
- [Assistance activation](docs/index.html:2530) enables the solver lazily. Preserve [single-cell BFS moves](docs/index.html:3410) and [interchangeable-piece canonicalization](docs/index.html:3322).
- Keep [custom name-input signing](docs/index.html:4025); the upstream script parser mishandles long name values. [Publication](docs/index.html:4067) creates the player identity only when needed.
- New Bulgarian UI text also needs [the inline translation map](docs/index.html:4326); [the mutation observer](docs/index.html:4577) translates dynamic text.
- [Beta validation evidence](README.md:43) is parent-reported local testing, not a checked-in suite. [Live broadcasts and deployment](README.md:35) remain untested; documentation work does not verify them.
