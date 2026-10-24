# Huarong Dao

Initial beta **0.1.0-beta.1** — a browser sliding-block puzzle with Bulgarian and English UI, eight layouts, optional assistance, and on-device scores. No deployment has been performed for this beta. See [release notes](CHANGELOG.md).

## Safe default: local-only play

Open [the game](docs/index.html) in a browser, or serve the asset directory with a local static HTTP server. Browser storage restrictions can prevent saving when opening a local file; use a local HTTP origin if needed. No package installation or build is required for the static game.

The [issuer declaration](docs/index.html:1760) is empty by default. With no configured issuer, public-score controls are hidden: no wallet is created, no chain API calls are made, and no external crypto script is loaded. Scores and the player name stay in browser storage; clearing site data removes them.

- Training is practice-only and never saves scores. First steps saves locally but never publishes.
- Assistance (hints, automatic steps/playback, or opening the solution list) excludes that run from scoring.
- The first eligible score requires nickname confirmation. The verified score record locks the name across reloads; a failed save does not commit the name.
- Personal bests are retained independently of the last five local results. A failed local score save can be retried from the victory dialog.
- Story and device-specific install instructions are available in-game; native PWA installation is not required.

## Cloudflare deployment (operator action; not yet performed)

From the repository root, with Wrangler available and Cloudflare authentication configured, run:

    npx wrangler deploy

The [Wrangler configuration](wrangler.jsonc:6) serves assets from **./docs**, not the former public directory. It binds assets to the [Worker](worker.js:5), which intercepts GET requests for the root and index page. Without an issuer secret, deployment retains local-only behavior.

### Optional public scoring — experimental and unverified live

Only if intentionally enabling this experiment, set the optional issuer secret from the repository root:

    npx wrangler secret put ROD_EXPERIMENT_ISSUER_WIF

**The issuer private key is injected into delivered HTML and is visible to every player. Cloudflare Secrets do not make it private. Use only a disposable experiment wallet with funds you can afford to lose; never a valuable wallet.** See [the injection boundary](worker.js:28).

Public scoring requires explicit player consent, network access, and externally loaded ROD crypto code. Player identity creation and registration are deferred until a qualifying public submission. Registrations spend issuer funds; concurrent registrations can contend for confirmed outputs. Published records are public, and clearing browser storage can lose the player's private key. Verify the in-game operator/contact disclosure before enabling this mode.

Real broadcasts, mining/confirmation, public leaderboard integration, and live Cloudflare deployment remain untested. Local simulations and a deployment dry-run do not establish these paths work.

### Rollback

Before changing a live deployment, record the current known-good Cloudflare deployment/version ID and preserve its routes, bindings, variables, compatibility settings, and issuer-secret configuration securely. Never put secret values in release notes or Git.

If a release fails, use Cloudflare's deployment/version history to roll back to that known-good version, then verify the root/index routes, local play, and intended issuer mode. Check and restore previous settings separately where version rollback does not restore them. If there is no previous known-good deployment, there is no verified rollback target: keep the initial rollout local-only until it is checked. Do not point this checkout back at the obsolete asset directory as a rollback strategy.

## Validation evidence and limits

The parent implementation task reported the following **local** results for this beta; these checks were not rerun during documentation work:

| Check | Reported result |
| --- | --- |
| Inline script parsing | 12/12 passed |
| Worker contracts using dummy keys | 11/11 passed |
| Browser, storage, and UI checks | 19/19 passed |
| Inert public-score queue simulations | 7/7 passed |
| Final retry regression checks | 18/18 passed |
| Cached Wrangler 4.100.0 deployment dry-run | Explicit exit 0 |

Reported headless coverage included Bulgarian/English at 1280×800, 320×568, and 375×500; pointer movement; onboarding; first-name persistence after reload; best-score retention beyond the last five results; assistance/training exclusions; and failed-score retry/stale-result guards. Local-only checks made no external requests and created no wallet.

No CI pipeline, package manifest, checked-in test runner, build script, or lint script is supplied. These are task-reported checks, not a reproducible CI suite or evidence of deployment. Live public paths remain unverified as noted above.

## Source layout

- [Single HTML asset](docs/index.html): ordered inline game, scoring, solver, signing, and translation scripts.
- [Worker](worker.js): optional issuer injection and asset passthrough.
- [Deployment configuration](wrangler.jsonc): asset directory and routing.
- [Agent guidance](AGENTS.md): hidden contracts to preserve.
