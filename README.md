# Huarong Dao

Beta **0.1.0-beta.3 candidate** — a browser sliding-block puzzle with Bulgarian and English UI, 14 layouts (3 unscored practice and 11 ranked), optional assistance, and on-device scores. Prepared and locally validated, not deployed. See [release notes](CHANGELOG.md).

## Experimental leaderboard architecture

The [normative plan](tasks/plan.md) incorporates the [decision delta](docs/Huarong_Dao_MVP_Decision_Delta_2026-10-29.md). Its local implementation includes player-signed actual-path evidence, independent Worker replay, Supabase SQL operational reservations/exact raw outbox, transaction serialization and independent raw-history reconstruction. The [execution handoff](tests/release-evidence.md) is the single current source for completion, measured validation and review status. The [original snapshot plan](docs/Huarong_Dao_Public_Leaderboard_Cloudflare_Supabase_MVP.md) is historical. No launch Durable Object, player transaction, rewards or transfers are introduced. Live ROD transport, exhaustive chain discovery and hosted Supabase remain unverified; production issuance is disabled.

## Safe default: local-only play

Open [the game](public/index.html) in a browser, or serve the asset directory with a local static HTTP server. Browser storage restrictions can prevent saving when opening a local file; use a local HTTP origin if needed. No package installation or build is required for the static game.

The [Worker](worker.js) never injects a private key into HTML and ignores the old issuer binding. Public submission is disabled in the production entry. Walletless board viewing and play do not create an identity or load the signing bundle. Scores, exact run evidence and the player name stay in browser storage; clearing site data removes them. Static/file play remains local when the backend is absent.

- Training starts each load (24 single-cell moves minimum, unscored). **Choose Layout** opens the picker, which groups practice and four ranked difficulty tiers; Classic (116 moves minimum) is in the top tier.
- Training, First Steps, and Next Steps are unscored practice: no score saves, nickname commitment, or public submissions. Legacy practice-only records do not lock the nickname; stored records for deferred layouts are retained but excluded from the current selector.
- Assistance (hints, automatic steps/playback, or opening the solution list) excludes that run from scoring.
- The first eligible score requires nickname confirmation. The verified score record locks the name across reloads; a failed save does not commit the name.
- Personal bests are retained independently of the last five local results. A failed local score save can be retried from the victory dialog.
- Story and device-specific install instructions are available in-game; native PWA installation is not required.
- The layout and solution dialogs support keyboard focus containment, Escape, backdrop dismissal, and focus restoration. The bilingual beta badge fits a 320px-wide viewport.

### Optional analytics

Google Analytics loads only after affirmative analytics consent, independently of public-score consent. Reopen Cookie settings under Leaderboard to withdraw consent. Withdrawal disables further analytics and attempts to delete root-path GA cookies for the host and parent domains; remembered rejection also performs cleanup at startup. Already-sent requests cannot be recalled. These controls do not make all other page resources offline or first-party-only. Live analytics delivery has not been verified.

Revocation in another tab disables analytics here through storage events, with additional checks on focus, return to visibility, and page restoration. Acceptance in another tab never automatically enables analytics in an already-open tab. Cookie settings closes Leaderboard and moves keyboard focus to Necessary only.

Rejection is read back to verify persistence. If saving it fails, the game tries to remove and verify removal of a stale stored grant. If neither operation succeeds, analytics stays disabled in this tab, but the old grant may enable it again after reload. A visible Bulgarian/English warning explains this limitation and offers retry by allowing browser storage and choosing Necessary only again.

## Cloudflare deployment (operator action; candidate not deployed)

No deployment, cloud authentication probe or remote publishing was performed. The [Wrangler configuration](wrangler.jsonc) serves the public asset directory and routes API paths through the [Worker](worker.js). Local development does not authorize deployment. A future controlled rollout needs an explicitly configured target, disposable limited-funded server wallet, spend envelope and pinned issuer/name bootstrap, plus the live E1 evidence in the [plan](tasks/plan.md#10-gates-verification-and-rollback).

### Optional public scoring — experimental and unverified live

Publication requires explicit independent public-score consent. Only then does the browser create/reuse a player identity and sign complete evidence; it does not create a player chain transaction. The application signs and funds the receipt transaction server-side. A complete receipt must fit 2,048 UTF-8 bytes; oversized evidence remains intact and local. The tested technical choice is not public-policy approval; see [capacity evidence](tests/release-evidence.md#capacity-choice).

Optional server-side read access requires HD1_READS set to the literal true, an HTTPS SUPABASE_URL and server-only SUPABASE_SERVICE_KEY, as defined in [the Worker](worker.js:64) and [storage boundary](leaderboard/storage.js:4). Never put binding values in browser code, logs or documentation, or inspect restricted secret files to configure this experiment. Apply the [revised SQL migration](supabase/migrations/001_leaderboard.sql), including its public-read grants, before separately authorized hosted use. Merely configuring reads never enables issuance: the production entry hardcodes availability false. There is no live chain adapter or production enablement switch.

The [admission boundary](worker.js:30) additionally requires a server-only HD1_RATE_HMAC_KEY of 32–256 UTF-8 bytes and trusted platform-provided client IP for any future separately authorized adapter. It fails closed without either, uses domain-separated HMAC buckets and checks per-IP before global capacity; stale-rate cleanup is traffic-triggered after ten minutes, not scheduled. Never trust a client-supplied IP header outside the trusted platform boundary. Do not reuse the publicly known fixture key for live use. The [public-read boundary](leaderboard/storage.js:11) is lock-free STABLE SQL, bounded to 100 rank rows plus 20 pending rows and 256 KiB. Leaderboard cache lifetime is five seconds; GET/status requests never advance signing or broadcast.

The separate [loopback fixture entry](tests/runtime-worker.js) demonstrates the end-to-end flow with publicly known test keys and a mock transport, not spendable funding. Never deploy it. Any former exposed issuer must be treated as compromised and never reused.

### Rollback

Disable issuance before rollback. The [SQL rollback](supabase/001_leaderboard.rollback.sql) pauses the coordinator and revokes RPC execution while retaining claims, exact raw transactions and reservations. Never delete the outbox or reset an ambiguous signing barrier to make a retry pass. Reconcile canonical chain/name/input state before resuming. Code rollback cannot undo broadcasts.

Before any future live change, record a known-good deployment/version and preserve routes/bindings securely. No target URL, existing deployment or rollback ID was verified in this task. Do not restore the obsolete asset directory or exposed-key HTML injection.

## Validation evidence and limits

Fresh experimental implementation evidence is recorded in the [execution handoff](tests/release-evidence.md#executed-validation). It includes core/SQL tests, all five rerun browser regressions, evidence replay, real loopback workerd EN/BG flows and an independent Python raw-transaction/signature/replay oracle. It does not establish live analytics, hosted Supabase concurrency, chain mining or deployment. Older results below retain their historical attribution.

The parent implementation task reported the following **initial local run** results for beta.2 (beta.3's fresh local rerun is summarized in the [changelog](CHANGELOG.md)); these counts are not totals for the later expanded suites. These checks were not rerun during documentation work:

| Check | Reported result |
| --- | --- |
| Node inline script parsing | 13 passed |
| Node Worker contracts | 12 passed |
| [Edge regressions](tests/qa_edge.py) | 44 assertions/checks passed |
| [Locale/viewport matrix](tests/qa_v14.py) | 159 checks passed |
| [Dialog keyboard navigation](tests/qa_dialog_keyboard.py) | 28 assertions passed |
| [Accessibility checks](tests/qa_accessibility.py) | 24 assertions passed |
| [Deep independent checks](tests/qa_deep_independent.py) | 28 assertions/checks passed; all 14 layouts checked for legality and minimum moves with independent Python BFS |

The parent reports that all five on-disk QA suites passed across the workflow. After the later fixes, the affected edge, keyboard, accessibility, and locale/viewport matrix suites were rerun and each exited 0; the unaffected deep/BFS suite retains its initial pass. No later assertion totals are claimed here.

Reported coverage includes Bulgarian/English responsive UI, the 320px beta badge, Training startup, practice/assistance exclusions, cookie consent and host/domain-cookie withdrawal with startup cleanup, keyboard dialogs, and legal solver paths. Native-storage edge checks cover failed and silently lost writes, first-name rollback/readback, cross-tab nickname locking, reload, duplicate suppression, stale retry rejection, and permanent bests surviving the five-result history. Analytics requests are intercepted in QA; this is not live analytics verification.

### Available local QA commands

All five supplied scripts now resolve the public asset relative to the checkout. With Python, the Python Playwright package, and Chromium installed, run each from the repository root:

    python.exe tests/qa_edge.py
    python.exe tests/qa_v14.py
    python.exe tests/qa_dialog_keyboard.py
    python.exe tests/qa_accessibility.py
    python.exe tests/qa_deep_independent.py

The deep script independently BFS-checks all 14 layouts. Optional screenshots/reports use an existing directory selected through QA_OUTPUT_DIR; output is disabled by default. Historical beta results remain in the [changelog](CHANGELOG.md).

The [manifest](package.json) and [lockfile](package-lock.json) pin the local experiment tools. Node 24.14.1, Python 3.13.5 and Wrangler 4.155.0 were exercised. After installing the locked packages locally, available commands are:

    npm test
    npm run build:client
    npm run dev
    python.exe tests/qa_evidence.py
    python.exe tests/qa_reconstruct.py
    python.exe tests/qa_release.py

For the isolated actual-workerd/PGlite browser fixture, use:

    python.exe tests/runtime_servers.py
    python.exe tests/qa_public_ui.py
    python.exe tests/qa_outbox_retry.py
    python.exe tests/qa_ranked_worker.py
    python.exe tests/runtime_servers.py --stop

The [fixture launcher](tests/runtime_servers.py) binds loopback ports 8787/8788/8790, saves owned PIDs/logs, refuses occupied ports, and disables dotenv loading. Stop its owned processes even after a failed browser check. Do not run a second development server on those ports. The fixture uses local PostgreSQL WASM, not hosted Supabase/PostgREST or a multi-process PostgreSQL server. There is no checked-in lint, typecheck or CI command; do not invent one.

## Source layout

- [HTML asset](public/index.html): ordered inline game/scoring/solver/translation logic and actual run evidence.
- [Worker](worker.js): API validation, disabled production issuer and unchanged asset passthrough.
- [Leaderboard modules](leaderboard/profile.js): frozen replay rules, signatures, serialization, issuer, storage and reconstruction.
- [Public UI](public/leaderboard-ui.js) and [local signing source](leaderboard/client.js): consent boundary, exact signed retries and identity backup.
- [SQL migration](supabase/migrations/001_leaderboard.sql): server-only atomic operational state and derived index.
- [Deployment configuration](wrangler.jsonc): asset directory and routing.
- [Agent guidance](AGENTS.md): hidden contracts to preserve.
