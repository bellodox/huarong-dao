Huarong Dao - polished experimental build (single-file frontend)

DEPLOY
  npx wrangler deploy
  npx wrangler secret put ROD_EXPERIMENT_ISSUER_WIF

Cloudflare Worker behavior:
- Serves public/index.html at / and /index.html.
- Injects the Cloudflare secret at response time into the single HTML asset.
- Changes no game transaction endpoints or backend state.
- Without the secret, the game works normally with local-only scores and no public score controls.

GAME BEHAVIOR
- Seven puzzle layouts, beginning with 'Тренировка' (24 one-cell moves, practice-only) and 'Първи стъпки' (32 one-cell moves, local results only).
- 'Тренировка' never submits or stores a score, creates a wallet, registers a name, or spends ROD; it is omitted from leaderboard choices.
- 'Първи стъпки' records unassisted best results in the existing browser localStorage leaderboard only. It never creates a wallet, registers a ROD name, or submits a ROD transaction. The ranking viewer always shows its local results even when the on-chain leaderboard is available.
- The five remaining layouts record locally; public submission is enabled only with a configured experiment issuer WIF.
- Both layouts derive from a valid classic solution path and were independently BFS-verified in single-cell slides.
- Former 'first_challenge' score records are intentionally not reused for the newly named practice level; the new practice ID is 'training'.
- On first visit, generate and save a random Player###### nickname automatically, without a startup modal.
- No wallet creation or transaction on load, save, restart, or assisted play.
- Hints, automatic steps/playback and opening the solution list exclude the run.
- No wallet is generated on startup. When public submission is configured, the first explicitly approved qualifying score generates the player wallet and registers its ROD name.
- Later improved scores update that name using its prepaid fee reserve.
- All name transactions are formed and signed in the browser and posted to the existing ROD API /broadcast.
- The leaderboard uses shared marker outputs and existing /history and /transaction endpoints.
- A failed on-chain score submission can be retried from the victory dialog without changing the run's eligibility.
- The browser can recover an existing player's name from recent marker history when local transaction state is missing.

FIXES / VALIDATION
- Solver only runs after asking for help, then reuses its optimal path during automated steps.
- Timer measures real elapsed wall-clock time, including time while the tab was inactive.
- Restart clears assistance UI state and keyboard shortcuts do not interfere with text fields.
- All seven puzzle layouts checked for cell overlap and solvability.
- Displayed minimum-move counts now match this game's single-cell move convention.
- Name-update signing builds the legacy SIGHASH_ALL preimage directly, avoiding an upstream PUSHDATA2 parser bug.
- Browser smoke tests and mocked registration/update transaction tests passed, plus local Worker secret-injection tests.

LIMITATIONS
- The injected WIF is visible in the browser response. Use only a disposable experiment wallet.
- First registrations spend the issuer wallet's confirmed UTXOs. For multiple simultaneous players,
  pre-fund it with separate confirmed outputs to reduce UTXO contention.
- External ROD web-wallet JavaScript is loaded by CDN. Working network access is needed for score submission.
- Real ROD chain broadcasts, mining/confirmation, and live Cloudflare deployment have NOT been tested.
- Resetting local browser storage loses the player's private key; this is an experiment, not a durable account system.

INSTALL HELP
- The persistent install-instructions button sits beside the sound toggle.
- Device-specific guidance for Android Chrome, iPhone/iPad Safari, and desktop Chrome/Edge.
- The instructions do not require native PWA installability or a blockchain transaction.

LOCAL-ONLY BEHAVIOR
- The first_steps layout keeps using the existing huarong_local_leaderboard_v1 storage key (top 10 locally, best per nickname). No storage migration is necessary.
- Previously published first_steps transactions, if any, remain on chain; the app does not show them in shared rankings or create new ones.
- Clearing browser data also clears local results.

GAME STORY AND EXIT
- Story button immediately precedes the Install instructions button on the bottom bar.
- Story modal explains the literary legend and the objective; no effect on progress, score, or ROD.
- Restored the down-arrow / EXIT / down-arrow marker beneath the bottom-middle opening.

PRIVACY: When a WIF is configured, the optional public-submission modal requests explicit consent and explains ROD publication under Privacy. With no WIF, public disclosures and submission controls are hidden, and local-only Privacy explains on-device storage. Local scores always remain available. Verify the named operator/contact before deployment.

2026-10-23 POLISH UPDATE
- Timer starts on first valid move, not on attempted/aborted pointer touches.
- Proper multi-pointer filtering, pointercancel cleanup and no movement after finishing.
- Reusing old consent is prevented when switching usernames; privacy remains accessible in leaderboard settings.
- Consent is reset if saved username is absent or invalid.
- Late leaderboard callbacks cannot overwrite a new level's victory status.
- Removed mobile viewport zoom restriction; player username screen declares accessible dialog semantics.
- No changes to ROD WIF injection or transaction signing/funding design.
- Privacy consent changes propagate to other open tabs via storage events.
- The deferred public-score dialog traps keyboard focus; assisted Next does not start the timer without a valid move.

2026-10-23 DEFERRED USERNAME UPDATE
- Assign and persist an automatic Player###### nickname; first launch immediately opens the puzzle.
- Allow a local-only win with no registration. A button on a ranked unassisted victory opens a public-score dialog.
- The dialog permits nickname changes, then explicit public-record consent. Registration and wallet generation remain deferred until submission.
- The existing Cloudflare Worker STILL INJECTS THE FUNDING WIF INTO THE DELIVERED HTML. The key is visible to players. It is NOT made private by Workers Secrets. Do not use a valuable WIF.
- Retained the transparent blockchain/privacy disclosure; removing it would not secure the WIF.

2026-10-23 WIF-CONDITIONAL LOCAL MODE
- The source WIF configuration is EMPTY by default. Empty means LOCAL ONLY: no public submission, no WIF use, no chain API calls or CDN crypto loading. The player receives persistent Player###### nickname on first launch.
- On first eligible public score, when the issuer WIF is configured, the public submission dialog lets the player change their nickname and give explicit consent.
- If Cloudflare Worker has no WIF secret, it serves the untouched local-only HTML normally (no 503 error).
- When configured, the Worker injects the WIF in the HTML response. IT IS VISIBLE TO PLAYERS. Use only an experimental, disposable issuer key.
- The leaderboard dialog remains usable locally; its public options and blockchain disclosure are hidden in local-only mode.

2026-10-23 DEEP REGRESSION AUDIT
- Trophy nickname changes retain a previously better score when a worse pending win is submitted.
- Public history now paginates the current API's 10-tx pages up to the 120-tx scan cap; incomplete coverage is labeled.
- Earlier eligible queued scores are not invalidated by hints in subsequent games.
- Stale async public refreshes are ignored; API calls have a timeout and consent/name checks at broadcast time.
- WebAudio-unavailable or storage-restricted browsers fail gracefully; malformed local score rows are filtered.
- Trophy modal has keyboard Escape/focus handling; basic cross-tab nickname/local score changes are reflected.
- Existing WIF injection remains unchanged and remains publicly visible when configured.
- ROD live broadcast and production Cloudflare deployment remain untested.
- Complete regression notes: huarong-audit-notes.md (included in this bundle).


FIRST-SCORE NAME LOCK: See huarong-first-score-fix-notes.md. No migration is needed because this build was not published.
