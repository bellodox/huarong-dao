# Changelog

## 0.1.0-beta.2 — locally validated candidate

Prepared locally; not deployed or pushed. Cloudflare is unauthenticated, and no target URL, current deployment, or known-good rollback ID has been verified.

### Added
- Six layouts bring the active catalog to 14: 3 unscored practice and 11 ranked, grouped by difficulty tier. Deferred layouts are outside the active catalog; their stored scores are retained.
- Independent Python BFS minimum-move verification and five checkout-relative Python Playwright QA scripts. See [commands and attributed validation](README.md#validation-evidence-and-limits).
- Separate opt-in analytics controls, with Cookie settings in Leaderboard for withdrawal.

### Changed
- Classic is the startup layout, with a 116 single-cell-move minimum. Layout names and bilingual onboarding now match the catalog.
- First Steps and Next Steps join Training as practice-only: no score saving, nickname commitment, or public publication. Legacy practice-only scores no longer establish a fixed nickname; ranked score durability, verified first-score commitment, best/history separation, and retry guards remain in place.
- Layout and solution dialogs now contain keyboard focus, close with Escape or backdrop clicks, and restore focus to their opener.

### Fixed
- Analytics withdrawal removes host-only and parent-domain root-path GA cookies; startup enforces remembered rejection and cleans stale cookies. Already-sent analytics cannot be recalled.
- Cross-tab analytics revocation is enforced through storage events and rechecks on focus, return to visibility, and page restoration; peer acceptance never automatically grants analytics in an already-open tab.
- Rejection persistence is verified, with verified stale-grant removal as a fallback. If both saving and removal fail, analytics remains off in the current tab and a bilingual warning/retry discloses that a stale grant may enable it again after reload.
- Cookie settings hands keyboard focus from Leaderboard to Necessary only, and numeric move badges translate correctly in English.
- The Bulgarian/English beta.2 badge fits the header at 320px width.

### Validation and limitations
- Parent-reported initial local run, not rerun for documentation: edge 44, matrix 159, keyboard 28, accessibility 24, deep 28 assertions/checks; independent Python BFS legality/minimums for all 14 layouts; Node inline parsing 13 and Worker contracts 12. These are initial-run counts, not later expanded-suite totals.
- The parent reports all five on-disk QA suites passed across the workflow; final affected edge, keyboard, accessibility, and matrix reruns each exited 0. Deep/BFS was unaffected and retains its initial pass.
- The Worker is unchanged. Live analytics, real public-score broadcasts/confirmations, public leaderboard integration, and deployment remain unverified. The [deploy/rollback route](README.md#cloudflare-deployment-operator-action-candidate-not-deployed) is operator guidance, not evidence of a successful rollout. No GitHub push is authorized.

## 0.1.0-beta.1 — initial beta

Prepared for initial release; not yet deployed.

### Added
- Bulgarian/English puzzle UI, eight layouts, optional solver assistance, story, and install guidance.
- [next_steps (50 moves)](docs/index.html:3139) layout.
- Local-only default with nickname confirmation, persistent personal bests, and the last five results. Training and assisted runs are unscored; First steps remains local-only.
- Optional experimental public scoring with explicit consent. The disposable issuer key is exposed in delivered HTML; it is not a private backend credential.

### Fixed
- Failed local score saves can be retried without duplicate results; stale retry/result contexts are guarded.
- Deployment assets use the current [game directory](wrangler.jsonc:6).

### Validation and limitations
- Parent-reported local checks: 12/12 inline parsing, 11/11 Worker contracts with dummy keys, 19/19 browser/storage/UI, 7/7 inert public-queue simulations, and 18/18 final retry regressions; cached Wrangler 4.100.0 dry-run exited 0.
- These are not CI results or live verification. Real public broadcasts, confirmations, and Cloudflare deployment remain untested. See [validation details and release guidance](README.md).
