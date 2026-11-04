# Huarong Dao — experimental leaderboard

A browser sliding-block puzzle with 14 layouts, local score/evidence persistence, Bulgarian/English UI and an optional consent-based ROD public leaderboard. Local play does not require a wallet or public-score consent. Public receipts retain the complete move path; chain confirmation, not database rows alone, establishes ranking evidence.

Version **0.1.0** retains the experimental **Beta** designation in both UI locales; it is not a production-readiness claim. Current validation, review scope and remaining gates belong only in the [execution handoff](tests/release-evidence.md#experimental-local-010-release--2026-11-04). Earlier hosted observations there remain historical. The [normative plan](tasks/plan.md), [checklist](tasks/todo.md) and [operator runbook](docs/cloudflare-deployment.md) define requirements and operational boundaries. “Ship” or “release” means local preparation/validation only: never deployment, tagging, commits or pushes.

## Architecture

| Boundary | Source and responsibility |
| --- | --- |
| Browser game | [HTML asset](public/index.html): ordered game, scoring, solver, local persistence and translation scripts. Training starts by default; three practice layouts and assisted runs are excluded from public scoring. |
| Public consent and signing | [UI](public/leaderboard-ui.js), [signing source](leaderboard/client.js), generated [browser bundle](public/leaderboard-client.js). Identity creation/signing requires explicit public consent. |
| Ranked sessions | [Browser witness](public/ranked-session.js) and [relay validation](leaderboard/session.js) bind layout/rules, fresh session entropy, reconciled ROD anchor and accepted move checkpoints. New ranked claims require a sealed witness; this is replay identity, not proof of human input. Existing exact admitted claims retain idempotent retry semantics. |
| Worker and portable relay | [Worker](worker.js) delegates API/scheduled work to generated [relay](relay.js), whose [entry source](leaderboard/relay-entry.js) also supports a Node CLI. Static assets use the assets binding. |
| Verification and chain | [Profile](leaderboard/profile.js), [receipts](leaderboard/receipt.js), [verification](leaderboard/verify.js), [transaction construction](leaderboard/chain.js), [reconstruction](leaderboard/reconcile.js). hd2 has inclusive 10× optimum ceilings for eleven ranked layouts; hd1 semantics remain distinct. |
| Publication | [Publisher](leaderboard/publisher.js), [provider](leaderboard/provider.js), [tip guard](leaderboard/tip-guard.js), [issuer](leaderboard/issuer.js) and [storage](leaderboard/storage.js). Provider-anchored authentication is not independent consensus or proof of exhaustive discovery. |
| Durable state | [SQL migrations](supabase/migrations/001_leaderboard.sql) retain authority journals; [010](supabase/migrations/010_ranked_sessions.sql)–[012](supabase/migrations/012_layout_time_tiebreak.sql) add sessions/status/time. [013](supabase/migrations/013_extend_continuing_beta_allowance.sql) is a pinned existing-authority operation, not fresh-install DDL; [014](supabase/migrations/014_restore_publisher_rpc_execute.sql) is conditional ACL repair. Follow the [migration guidance](docs/cloudflare-deployment.md#session-schema-and-conditional-operational-sql). |

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

Browser QA includes [release](tests/qa_release.py), [edge](tests/qa_edge.py), [version/responsive](tests/qa_v14.py), [deep independent BFS](tests/qa_deep_independent.py), [keyboard](tests/qa_dialog_keyboard.py), [accessibility](tests/qa_accessibility.py), [availability](tests/qa_availability_diagnostics.py), [retry status](tests/qa_retry_status.py), [public UI](tests/qa_public_ui.py), [outbox retry](tests/qa_outbox_retry.py) and the explicit [historical D6 control](tests/qa_d6_successor.py). Run checkout-relative Python suites with python.exe after inspecting their setup; the [runtime launcher](tests/runtime_servers.py) supplies loopback services and its --stop option stops only its owned processes. Public UI/outbox suites use [actual browser-pointer session checkpoints](tests/ranked_browser_fixture.py), not injected witnesses; the D6 control deliberately retains its historical pre-session schema. The [packaged session test](tests/packaged-sessions.test.js) exercises generated Worker routes against PostgreSQL-compatible PGlite in workerd, not hosted Supabase. All checks belong under the root tests directory.

Normal manifest tests are offline. External Node transport diagnostics are separately opt-in through HD1_LIVE_NETWORK_DIAGNOSTICS=true in the [diagnostic test](tests/rod-network-diagnostics.test.js); they are not proof of deployed Workers connectivity. The manifest deployment command is a remote operation, not local QA, and requires separate authorization.

## Migration and recovery contracts

Apply only missing complete atomic migrations in order, never reset existing journals to retry publication. Ordinary readiness requires capability 4 from [004](supabase/migrations/004_finite_publication.sql); [007](supabase/migrations/007_failed_transaction_recovery.sql) adds recovery capability 7. General positive-conflict recovery requires an authenticated different spend of an original input, six confirmations and bounded ancestry proof. Absence or fee rejection is not retirement. The narrowly pinned [008 override](supabase/migrations/008_operator_restart_override.sql) and [009 completion](supabase/migrations/009_recovery_completion.sql) are explicit exceptions, not general alternate-spend permission.

Completion preserves historical raw journals/counters/bootstrap and separate effective bootstrap; continuing authority is separately capped and server-resolved. No database transaction spans network/signing. Exact raw persistence precedes broadcast, ambiguous signing remains fenced, and at most one app transaction is unconfirmed globally. One reconciled canonical confirmation permits successors, six establish ranking and twelve close a week. Follow the [recovery runbook](docs/cloudflare-deployment.md#experimental-positive-conflict-recovery), not ad hoc flags or reset scripts.

Accepted session duration is client-reported, not an anti-cheat guarantee, and breaks equal-move ties only in per-layout public rankings. It changes neither move-improvement eligibility, points, overall ranking, hd2 receipts nor ROD publication frequency. Historical untimed scores display Time: —. Schema readiness capability 4 alone does not attest session/status/time installation; see the [ordered migration prerequisites](docs/cloudflare-deployment.md#session-schema-and-conditional-operational-sql).

## Validation evidence and limits

The [handoff](tests/release-evidence.md) distinguishes freshly executed checks from historical implementer/reviewer and user-supplied hosted reports. Later changes do not inherit older approval. Local mocks/PGlite/browser evidence cannot establish hosted Supabase concurrency, continuous scheduler health, live fee acceptance, exhaustive discovery, deployment or analytics correctness.

Earlier patch-installation notes are retained in Git history (not current repository setup instructions), including the publisher tip-extension change at revision 2aee9a1. Its historical disabled-publisher statement no longer matches current configuration. Normal remote deployment is a separately authorized operator push to GitHub-connected Workers Builds on the leaderboard branch; agents must not commit, push or deploy as part of local analysis.
