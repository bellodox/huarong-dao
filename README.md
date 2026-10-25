# Huarong Dao

Beta **0.1.0-beta.2 candidate** — a browser sliding-block puzzle with Bulgarian and English UI, 14 layouts (3 unscored practice and 11 ranked), optional assistance, and on-device scores. Prepared and locally validated, not deployed. See [release notes](CHANGELOG.md).

## Safe default: local-only play

Open [the game](docs/index.html) in a browser, or serve the asset directory with a local static HTTP server. Browser storage restrictions can prevent saving when opening a local file; use a local HTTP origin if needed. No package installation or build is required for the static game.

The [issuer declaration](docs/index.html:1766) is empty by default. With no configured issuer, public-score controls are hidden: no wallet is created, no chain API calls are made, and no external crypto script is loaded. Scores and the player name stay in browser storage; clearing site data removes them.

- Classic starts each load (116 single-cell moves minimum). The layout picker groups practice and four ranked difficulty tiers.
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

From the repository root, with Wrangler available and Cloudflare authentication configured, run:

    npx wrangler deploy

The [Wrangler configuration](wrangler.jsonc:6) serves assets from **./docs**, not the former public directory. It binds assets to the [Worker](worker.js:5), which intercepts GET requests for the root and index page. Without an issuer secret, deployment retains local-only behavior.

### Optional public scoring — experimental and unverified live

Only if intentionally enabling this experiment, set the optional issuer secret from the repository root:

    npx wrangler secret put ROD_EXPERIMENT_ISSUER_WIF

**The issuer private key is injected into delivered HTML and is visible to every player. Cloudflare Secrets do not make it private. Use only a disposable experiment wallet with funds you can afford to lose; never a valuable wallet.** See [the injection boundary](worker.js:28).

Public scoring requires explicit player consent, network access, and externally loaded ROD crypto code. Player identity creation and registration are deferred until a qualifying public submission. Registrations spend issuer funds; concurrent registrations can contend for confirmed outputs. Published records are public, and clearing browser storage can lose the player's private key. Verify the in-game operator/contact disclosure before enabling this mode.

Real broadcasts, mining/confirmation, public leaderboard integration, and live Cloudflare deployment remain untested. Local simulations and a deployment dry-run do not establish these paths work.

For beta.2, Cloudflare is unauthenticated; no target URL, current deployment, or rollback ID has been verified. Authentication and recording those operator details remain prerequisites to a controlled rollout. No GitHub push is authorized or claimed.

### Rollback

Before changing a live deployment, record the current known-good Cloudflare deployment/version ID and preserve its routes, bindings, variables, compatibility settings, and issuer-secret configuration securely. Never put secret values in release notes or Git.

If a release fails, use Cloudflare's deployment/version history to roll back to that known-good version, then verify the root/index routes, local play, and intended issuer mode. Check and restore previous settings separately where version rollback does not restore them. If there is no previous known-good deployment, there is no verified rollback target: keep the initial rollout local-only until it is checked. Do not point this checkout back at the obsolete asset directory as a rollback strategy.

## Validation evidence and limits

The parent implementation task reported the following **initial local run** results for this beta; these counts are not totals for the later expanded suites. These checks were not rerun during documentation work:

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

Reported coverage includes Bulgarian/English responsive UI, the 320px beta badge, Classic startup, practice/assistance exclusions, cookie consent and host/domain-cookie withdrawal with startup cleanup, keyboard dialogs, and legal solver paths. Native-storage edge checks cover failed and silently lost writes, first-name rollback/readback, cross-tab nickname locking, reload, duplicate suppression, stale retry rejection, and permanent bests surviving the five-result history. Analytics requests are intercepted in QA; this is not live analytics verification.

### Available local QA commands

The five supplied scripts resolve the checkout relative to their own location. With Python, the Python Playwright package, and its Chromium browser installed, run each from the repository root:

    python.exe tests/qa_edge.py
    python.exe tests/qa_v14.py
    python.exe tests/qa_dialog_keyboard.py
    python.exe tests/qa_accessibility.py
    python.exe tests/qa_deep_independent.py

The deep script includes the independent Python BFS oracle. Optional screenshot/report output in the matrix and deep scripts requires an existing directory selected through the QA_OUTPUT_DIR environment variable; output is disabled by default. No CI pipeline, package manifest, package test runner, build script, or lint script is supplied. The Node counts above are parent-reported ad hoc checks, not checked-in commands. Script sources were inspected, but application checks were not rerun for this documentation-only task. Historical beta.1 results remain in the [changelog](CHANGELOG.md).

## Source layout

- [Single HTML asset](docs/index.html): ordered inline game, scoring, solver, signing, and translation scripts.
- [Worker](worker.js): optional issuer injection and asset passthrough.
- [Deployment configuration](wrangler.jsonc): asset directory and routing.
- [Agent guidance](AGENTS.md): hidden contracts to preserve.
