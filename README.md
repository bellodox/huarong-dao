# Huarong Dao — experimental leaderboard

A browser sliding-block puzzle with 14 layouts, local score/evidence persistence, Bulgarian/English UI and an optional consent-based ROD public leaderboard. Local play does not require a wallet or public-score consent. Public receipts retain the complete move path; chain confirmation, not database rows alone, establishes ranking evidence.

All work remains experimental. Current validation, live leaderboard and ROD endpoint proof, historical observations, review scope and remaining blockers belong only in the [execution handoff](tests/release-evidence.md#live-leaderboard-working-and-rod-api-reads-verified--2026-11-02). The [normative plan](tasks/plan.md), [checklist](tasks/todo.md) and [operator runbook](docs/cloudflare-deployment.md) define requirements and operational boundaries.

## Architecture

| Boundary | Source and responsibility |
| --- | --- |
| Browser game | [HTML asset](public/index.html): ordered game, scoring, solver, local persistence and translation scripts. Training starts by default; three practice layouts and assisted runs are excluded from public scoring. |
| Public consent and signing | [UI](public/leaderboard-ui.js), [signing source](leaderboard/client.js), generated [browser bundle](public/leaderboard-client.js). Identity creation/signing requires explicit public consent. |
| Worker and portable relay | [Worker](worker.js) delegates API/scheduled work to generated [relay](relay.js), whose [entry source](leaderboard/relay-entry.js) also supports a Node CLI. Static assets use the assets binding. |
| Verification and chain | [Profile](leaderboard/profile.js), [receipts](leaderboard/receipt.js), [verification](leaderboard/verify.js), [transaction construction](leaderboard/chain.js), [reconstruction](leaderboard/reconcile.js). hd2 has inclusive 10× optimum ceilings for eleven ranked layouts; hd1 semantics remain distinct. |
| Publication | [Publisher](leaderboard/publisher.js), [provider](leaderboard/provider.js), [tip guard](leaderboard/tip-guard.js), [issuer](leaderboard/issuer.js) and [storage](leaderboard/storage.js). Provider-anchored authentication is not independent consensus or proof of exhaustive discovery. |
| Durable authority | [SQL migrations](supabase/migrations/001_leaderboard.sql) through [009](supabase/migrations/009_recovery_completion.sql) retain ownership, signing barriers, exact outbox and separate bounded authority journals. |

The [configuration](wrangler.jsonc) currently sets the publisher flag to true and schedules a one-minute cron. This is **not disabled/static configuration**, nor proof that runtime secrets, SQL readiness, funding or hosted service are healthy. Static-only operators must explicitly disable publication and review remote bindings using the [runbook](docs/cloudflare-deployment.md#2-primary-workflow-github-push-to-workers-builds). No deployment, signing or spending is authorized by this README.

The Worker also exposes a temporary fixed-target read-only diagnostic through the [probe module](tests/rod-transport-probe.worker.js). It never probes broadcast or verifies current private runtime identity; successful reads do not guarantee later publication.

## Local setup

Use Node 24.14.1 from the [version file](.nvmrc) and dependencies pinned by the [lockfile](package-lock.json). If dependencies are absent, install them before building:

```bat
npm ci --include=dev --no-audit --no-fund
npm run build
npm test
```

Build regenerates both checked-in distributions and checks relay parity. Tests and Wrangler reject stale relay bytes rather than repairing them. These instructions are not evidence that this checkout passes; consult the handoff. Do not hand-edit generated bundles.

For local play, use a shell without application credentials, disable dotenv loading and explicitly disable publication:

```bat
set WRANGLER_SEND_METRICS=false
set CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false
npm run dev -- --var HD1_PUBLISHER:false
```

Open http://127.0.0.1:8787. Do not load restricted secret files or use cloud login/deploy as a local prerequisite. The [loopback launcher](tests/runtime_servers.py) and [fixture Worker](tests/runtime-worker.js) are test-only; stop only launcher-owned processes with its stop option. Never deploy fixture keys/configuration.

## Available local QA commands

The [manifest](package.json) provides these commands; no lint/typecheck/CI command is defined.

| Command | Purpose |
| --- | --- |
| npm run build | Regenerate relay and browser bundle, then check relay bytes. |
| npm run check:relay | Non-writing generated-relay parity check. |
| npm test | Relay precheck, then sequential Node test files under the root tests directory. |
| npm run dev | Loopback Wrangler development server; use the disabled-publication override above. |

Existing browser QA includes the [original UI suite](tests/qa_v14.py), [deep independent BFS suite](tests/qa_deep_independent.py), [public UI suite](tests/qa_public_ui.py) and [runtime launcher](tests/runtime_servers.py). Inspect each suite's setup before execution; browser/fixture checks are not hosted acceptance. All tests and validation utilities belong under the root tests directory. The manifest deployment command is a remote operation, not local QA; it requires separate authorization.

## Migration and recovery contracts

Apply only missing complete atomic migrations in order, never reset existing journals to retry publication. Ordinary readiness requires capability 4 from [004](supabase/migrations/004_finite_publication.sql); [007](supabase/migrations/007_failed_transaction_recovery.sql) adds recovery capability 7. General positive-conflict recovery requires an authenticated different spend of an original input, six confirmations and bounded ancestry proof. Absence or fee rejection is not retirement. The narrowly pinned [008 override](supabase/migrations/008_operator_restart_override.sql) and [009 completion](supabase/migrations/009_recovery_completion.sql) are explicit exceptions, not general alternate-spend permission.

Completion preserves historical raw journals/counters/bootstrap and separate effective bootstrap; continuing authority is separately capped and server-resolved. No database transaction spans network/signing. Exact raw persistence precedes broadcast, ambiguous signing remains fenced, and at most one app transaction is unconfirmed globally. One reconciled canonical confirmation permits successors, six establish ranking and twelve close a week. Follow the [recovery runbook](docs/cloudflare-deployment.md#experimental-positive-conflict-recovery), not ad hoc flags or reset scripts.

## Validation evidence and limits

The [handoff](tests/release-evidence.md) distinguishes freshly executed checks from historical implementer/reviewer and user-supplied hosted reports. Later changes do not inherit older approval. Local mocks/PGlite/browser evidence cannot establish hosted Supabase concurrency, continuous scheduler health, live fee acceptance, exhaustive discovery, deployment or analytics correctness.

Earlier patch-installation notes are retained in Git history (not current repository setup instructions), including the publisher tip-extension change at revision 2aee9a1. Its historical disabled-publisher statement no longer matches current configuration. Normal remote deployment is a separately authorized operator push to GitHub-connected Workers Builds on the leaderboard branch; agents must not commit, push or deploy as part of local analysis.
