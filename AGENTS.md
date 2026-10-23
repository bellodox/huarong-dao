# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Commands and configuration
- Deploy from the repository root with [the documented Wrangler command](README.md:4); [the next command](README.md:5) sets the optional issuer secret, not a prerequisite for local-only play.
- No package manifest, lockfile, build/lint scripts, test runner, or single-test command is checked in. Do not invent them or treat [historical validation claims](README.md:30) as runnable tests.
- No formatter, linter, import-order, naming, or type configuration is checked in; do not impose inferred style rules. [Wrangler configuration](wrangler.jsonc:2) defines deployment and asset routing only.

## Hidden contracts
- The browser game, scoring, solver, signing, and translation logic share ordered inline scripts in [the HTML asset](public/index.html:2093), not separate frontend modules.
- Preserve [the exact empty issuer declaration](public/index.html:1475): [the Worker replacement sentinel](worker.js:3) is a literal text match; changing it causes configured root requests to return 500.
- [Worker injection](worker.js:28) exposes the issuer key in delivered HTML. Worker secrets do not make it private; use only a disposable experiment wallet. [No issuer](worker.js:14) serves the unchanged local-only asset.
- Keep [asset binding and Worker-first paths](wrangler.jsonc:5) aligned with [GET-only root interception](worker.js:8); other requests pass through to assets.
- [Training and first-steps IDs](public/index.html:2188) have different contracts: training never saves scores; first steps saves locally but never publishes. Assistance excludes a run from scoring.
- [First-score confirmation](public/index.html:2479) persists the local score and then locks the nickname, with rollback if name persistence fails; this applies without public scoring too.
- [Assistance activation](public/index.html:2191) enables the solver lazily. Preserve [single-cell BFS moves](public/index.html:3011) and [interchangeable-piece canonicalization](public/index.html:2922).
- Keep [custom name-input signing](public/index.html:3609); the upstream script parser mishandles long name values. [Publication](public/index.html:3732) creates the player identity only when needed.
- New Bulgarian UI text also needs [the inline translation map](public/index.html:3867); [the mutation observer](public/index.html:4096) translates dynamic text.
- Two notes files cited by [the README](README.md:98) are absent from this checkout. Live broadcasts and deployment remain [historically untested](README.md:97), not verified by documentation work.
