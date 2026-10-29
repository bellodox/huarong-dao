# Experimental leaderboard execution handoff

## Status and authority

2026-10-29. Explicit user instructions authorize experimental T1–T12 implementation and local validation, not production changes, unrestricted spending, restricted secret-file reads, commits or pushes. The [design](../tasks/plan.md) remains normative with its experimental authorization/capacity clarification. This is the **single current implementation/review handoff**; older documentation-only approvals do not approve these changes.

**Local experimental implementation approved; not public launch or live MVP acceptance.** Parent-supplied final Code Reviewer verdict is **APPROVE, local experimental only**; final Vulnerability Checker verdict is **NO BLOCKING FINDINGS, disabled-production scope only**, following delta reassessment. T10/C5 live E1 remains blocked. T11 is local/fixture-only. T12/C6 local review and evidence are complete; administrative persistence is recorded below. The parent owns final status and authorized this documentation/OSG execution proxy. No implementation edits or application tests were performed by this closeout proxy.

## T1–T12 outcomes

| Packet | Observed local outcome and source | Limits |
| --- | --- | --- |
| T1 | [Wrangler](../wrangler.jsonc) serves the public asset; API routes Worker-first; QA paths aligned. | No deploy. |
| T2 | All five original QA suites run against the preserved asset. [Manifest](../package.json)/[lockfile](../package-lock.json) establish pinned local tests/build/workerd tools. | No invented lint/typecheck/CI commands. |
| T3 | [Game](../public/index.html) captures actual successful single-cell actions, isolates resets/layouts/assistance, stores full evidence atomically with local scores and preserves weekly-only candidates. [Evidence suite](qa_evidence.py) independently replays all 14 paths. | Browser storage is not fully transactional across tabs; existing rollback/readback safeguards retained. |
| T4 | [Receipt](../leaderboard/receipt.js) and [client](../leaderboard/client.js) implement canonical complete player/app signatures, normalized compressed identity, legacy WIF continuity, consent-only creation and backup. | Player signs evidence only. No identity/funds needed for play or viewing. |
| T5 | [Worker](../worker.js)/[verifier](../leaderboard/verify.js) reject invalid/cross-origin/oversized claims and independently derive replay/moves/points before admission. | Production issuance always disabled. Rate bounds are operational limits, not bot prevention. |
| T6 | [SQL](../supabase/migrations/001_leaderboard.sql)/[storage boundary](../leaderboard/storage.js) provide atomic decisions/revision reconsideration, queue/identity reservation, fenced unsigned preparation and non-expiring signing barrier. Disk restart and grants exercised. | Local PGlite, not hosted Supabase or independent PostgreSQL sessions. |
| T7 | [Chain](../leaderboard/chain.js)/[issuer](../leaderboard/issuer.js) serialize/register/update, sign full previous name scripts and persist exact raw bytes before mock fetch. Lost begin/finalize responses and timeout retries tested. | Synthetic transactions, no chain funding or broadcast. |
| T8 | [Rankings](../leaderboard/index.js) expose confirmed/pending/stale state with snapshot-bound cursors; SQL rebuild changes only derived index and retains journal/outbox. | Read boundary configured server-side; hosted PostgREST not exercised. |
| T9 | [Reconstruction](../leaderboard/reconcile.js) follows pinned authenticated raw name lineage; overwritten receipts retain complete evidence. [Independent Python oracle](qa_reconstruct.py) verifies full previous-script DER signatures, both receipt signatures and replay with no JS/DB/network. | Caller must supply consensus-authenticated complete history/headers; fixtures cannot establish live completeness. |
| T10 | All locally feasible E1 vectors/serialization/crash/reorg checks executed. | **Live E1 not executed**: no configured approved target/funding/bootstrap/live transport. No live-success substitute. |
| T11 | [UI](../public/leaderboard-ui.js) plus [workerd browser suite](qa_public_ui.py) exercise walletless viewing, explicit consent, signed outbox, pending state, lifetime/week view, weekly-only actual evidence and withdrawal in EN/BG. | Public availability remains disabled; fixture confirmed rows are synthetic. |
| T12 | Evidence, scoped final reviews, [release-boundary check](qa_release.py) and [safe SQL rollback](../supabase/001_leaderboard.rollback.sql) complete locally; persistence below. | No deployment or live acceptance. |

## Capacity choice

Keep the specified reversible action-symbol encoding: one symbol identifies the actual piece and single-cell direction. There is **no separate 1,536-move eligibility cap** and no speculative new codec. Enforce the actual complete signed receipt's UTF-8 length <=2,048 bytes. Too-large evidence stays intact/local and yields an explicit capacity error; never truncate, rewrite, hash-replace or externally link the path.

Fresh signed/replayed fixtures in [receipt vectors](fixtures/receipt.json):

| Fixture | Actual moves | Complete receipt bytes |
| --- | ---: | ---: |
| Normal wings | 116 | 383 |
| Wings with reversible actual prefix and maximum nickname/week | 1,536 | 1,851 |
| Three Roads with reversible actual prefix and maximum nickname/week | 1,722 | 2,048 |

Generic worst-field arithmetic remains 326+M: 1,536 yields 1,862, 1,722 yields 2,048, 1,723 yields 2,049. The wings stable ID is shorter than the generic 16-byte maximum, explaining its 1,851 bytes. Tests exercise both actual replay-valid signatures and generic boundary arithmetic. This proves a technical experimental bound, **not unrestricted public eligibility or human public-policy approval**. Unlimited local play remains available. Production issuance is closed pending live feasibility and the separate public-use decision.

## Executed validation

The following final results are **parent-supplied executor evidence**, not reruns by this administrative proxy. Earlier implementation used Node 24.14.1, Python 3.13.5 and Wrangler 4.155.0; locked versions are recorded in the [manifest](../package.json). Earlier Context7 documentation research is source guidance, not hosted runtime proof.

Final executor: npm test **35/35, zero failed/skipped, exit 0**; npm run build:client exit 0. The outbox retry, ranked Worker (actual workerd), public UI (four EN/BG cases, no errors), evidence (all 14 paths), reconstruction and release checks, plus all five original browser suites, each exited 0. Four screenshots were refreshed and inspected without clipping. Owned processes stopped; ports 8787/8788/8790 closed. Temporary logs/databases/cache outputs were cleaned.

The table below preserves **earlier implementation-run evidence**, not final suite totals. Its initial whitespace pass predates later work: a subsequent executor whitespace check exited 2 for five inherited markup trailing-space lines; the final Code Reviewer whitespace check passed. These are separate boundaries, not a blanket workflow-wide whitespace pass.

| Command | Exit / observed result |
| --- | --- |
| npm test | 0; 26 tests, 26 pass, 0 fail/cancelled/skipped/todo; 66.132 seconds. |
| node --test tests/storage.test.js | 0; 4/4 including disk-backed close/reopen and safe rollback permission denial. Included again in the 26-test run. |
| node --test tests/index.test.js | 0; 2/2 after adding the final reorg/reconsideration regression. Only the first was in the earlier 26-test full run. Thus 27 distinct core tests covered, not a fabricated 27-test full-suite run. |
| npm run build:client | 0; checked-in ESM browser bundle, 50.7 KiB, rebuilt from the consent-only signing source. No source change since its passing runtime flow. |
| python.exe tests/qa_edge.py | 0; analytics cross-tab/withdrawal/cookie, nickname/readback/rollback, duplicate/stale retries and permanent best regressions. |
| python.exe tests/qa_v14.py | 0; EN/BG × three viewport widths, consent, practice and identity matrix. |
| python.exe tests/qa_dialog_keyboard.py | 0; keyboard/focus dialog regressions. |
| python.exe tests/qa_accessibility.py | 0; accessibility regressions. |
| python.exe tests/qa_deep_independent.py | 0; independent BFS all 14 optima, legal 116-move Classic completion, assisted exclusion, five viewport geometries, no page errors. |
| python.exe tests/qa_evidence.py | 0; all 14 browser paths independently replayed; rejected gestures, exact counts, reset/assistance, atomic evidence, 84-move weekly-only candidate vs 82-move lifetime best, no page errors. |
| python.exe tests/qa_reconstruct.py | 0; two raw lineage transactions, full previous-script DER input signatures, four compact receipt signatures, actual 1,536/116 paths and rebuilt 1,160-point lifetime/week result; no Supabase/JS/network. |
| python.exe tests/qa_public_ui.py | 0; actual local workerd on 8787/8788, EN/BG, mobile viewport, no page errors; signed player POST → SQL RPC → app signing → exact persisted raw → fixture timeout; no real chain request. |
| python.exe tests/qa_release.py | 0; public routing/all five QA paths, disabled production issuer/no key substitution, preserved rollback journal/no launch Durable Object. This static check is not live acceptance. |
| python.exe tests/runtime_servers.py --stop | 0; three owned process trees stopped successfully. Ports 8787/8788/8790 subsequently checked closed. Browser session closed. |
| git diff --check | 0 before documentation closeout; line-ending conversion warnings only. Final documentation/source hash validation follows below. |

The final added reorg test uses the actual SQL RPC: a 120-move confirmed projection makes identical B=124 not improved; rebuilding to 130 makes the same ID/bytes queued exactly once. A previously signed removed-confirmed claim instead becomes reorged, retains exact bytes, pauses the coordinator and never accesses signing/transport again. Local PGlite concurrent promises are not a substitute for independently scheduled hosted sessions.

### Browser screenshots inspected

Four fresh 390×844 screenshots were opened and visually inspected after the localization fix:

- [Disabled production EN](local-disabled-en-US.png) and [BG](local-disabled-bg-BG.png): explicit submission-disabled notice, walletless local identity editor and no public consent control.
- [Fixture EN](public-fixture-en-US.png) and [BG](public-fixture-bg-BG.png): translated period/view controls, 1,160-point confirmed fixture row, separate 0/6 pending row, privacy warning and identity backup. No untranslated Bulgarian dynamic fragments remain in the English capture. The Bulgarian controls wrap within the panel rather than overflowing.

### Transaction measurements

[Synthetic serialization vectors](fixtures/transactions.json), not mined txids:

- Revised register: 2,131 bytes, weight 8,524; txid 2c0e56916d4bb5bee81baa66f0870557dc60cc282067d6397f827286862858c8.
- Revised update: 663 bytes, weight 2,652; txid cd1619a72316311bbda17a23ab4a846c7b7bb651442be7a85c80a3840e60d7f8.
- Fixtures pin researched ROD source revision 248f1af050579a369af527288f5773a021ae8492. Live relay fees/dust/consensus acceptance remain unmeasured.

## External blockers and substantive limits

1. No live target URL/deployment/rollback ID, funded wallet, app bootstrap or explicit spend envelope was established. No secret files were inspected; no cloud authentication/status probes, deployments, chain broadcasts, commits, tags or pushes were performed. No real txid/confirmation is claimed.
2. The production Worker intentionally lacks a presumed live chain adapter. Issuance cannot be enabled by a flag. Safe activation needs a verified authenticated history/header source, chain preparation/observation/reconciliation transport, limited funding and explicit deployment/public-use authority.
3. Discovery fixtures require stable complete pages and canonical observations. The researched public API has not proved that contract. A separately authorized synced node scan may be required. JavaScript fixture hashes/headers and complete=true are **caller attestations**, not consensus proof. Never feed untrusted public API assertions directly into the trusted reconstruction boundary.
4. SQL syntax/grants/rollback/restart are locally executed in real PostgreSQL WASM via PGlite. Hosted Supabase, PostgREST authorization behavior, independent-session database contention and deployment operations remain untested. Do not describe local Promise scheduling as full multi-connection concurrency proof.
5. Live six-confirmation mining, overwritten-name exhaustive discovery, MTP/week boundary and twelve-confirmation operational close remain fixture-only. Rewards/transfers are absent. Replay proves legal evidence, not human play, solver absence or sybil resistance.
6. The UI is a local experimental flow, not a verified continuously operating live publisher. Exact outbox/status recovery is tested under fixture timeout; no always-on queue scheduler or hosted liveness guarantee is claimed. A failed/stale backend never blocks local score saving/play.
7. Final reviews below cover the reviewed local implementation only. Administrative recording does not extend approval to future adapters, hosted operation or deployment.

## Final fixes and independent reviews

Parent-supplied final evidence, 2026-10-29:

- Signing authenticates the complete previous raw transaction txid, output, amount and script; enforces absolute 100,000-base-unit and 100-units/byte fee ceilings before signing; and uses an immutable prepared clone.
- Public reads use bounded lock-free STABLE SQL, at most 100 ranked rows plus 20 pending rows and 256 KiB; status uses a single claim lookup. Leaderboard caching is five seconds; GET never advances issuance. Read grants and rollback were revised.
- Admission checks per-IP before global limits. A domain-separated HMAC uses a server-only 32–256 UTF-8-byte binding and fails closed without it/trusted IP. Ten-minute stale-rate cleanup is traffic-triggered. Future separately authorized adapters require this binding/trusted-IP boundary and the revised migration; fixture keys are never live credentials.
- Reconstructed pending receipts below six confirmations without a journal durably pause issuance, with independent preparation/begin/broadcast guards. Six-confirmation reconciliation safely resumes the same exact bytes/txid at generation 1.
- Digit-bearing stable IDs admit Rain2; all 11 ranked and three practice layouts have signing verification. Persisted old signed outbox entries recover before newer candidates: the 116-move retry survives newer 1,536-move evidence, and consent withdrawal stops requests.

**Code Reviewer:** APPROVE local experimental only, full 58 changed/added files against HEAD 8c86d0a631790122302536463a89f1b9d328786c. Independently reported 35/35 tests, exit 0; exact browser bundle; all 11 ranked signing cases; extra SQL post-finalize pending-guard probe; mocked browser old/new retry and withdrawal; reconstruction/release checks exit 0; screenshots inspected. No retained reviewer edits.

**Vulnerability Checker:** NO BLOCKING FINDINGS for local disabled-production scope after delta reassessment. Fresh npm test exit 0, **count not captured**; bundle SHA matches; static guard/consent checks. Its bounded OSG success concerned historical documentation only. Earlier security evidence was 32/32 tests and production-dependency audit zero; initial lockfile audit was zero across 95 dependencies. Those earlier counts/audits are not final reruns by every reviewer.

Nonblocking residuals before future enablement: internal POST/advance still reads full operational state; rate calls take the coordinator lock; cleanup is traffic-triggered rather than scheduled; retained final local outbox entries make read requests grow. Hosted grants/multisession contention, relay/mining/confirmation, authentic complete live discovery, analytics and deployment remain unverified. No optional issue was expanded into implementation work here.

## Git, cleanup and preservation

Observed checkout: main, HEAD 8c86d0a631790122302536463a89f1b9d328786c. Implementation remains uncommitted with new modules/tests/manifest/lockfile/SQL/UI files. The tracked delta includes public HTML, Worker/config, the five QA path fixes and the local dependency exclusion. No reset, clean, staging or unrelated-process kill was used. Historical PDF/source documents remain intact. The full final Git status must be inspected by the parent before any later commit.

Owned local processes were stopped through the saved-PID launcher. Named task-created Wrangler runtime/cache directories, install/runtime/test logs and exit files were removed after their results were transcribed here. The four screenshots and deterministic fixture JSON are retained as review evidence, not production artifacts. Tests themselves and installed locked dependencies are retained.

The earlier documentation pass checked 95 links and 18 hashes; it is historical, not this proxy's final validation. Fresh administrative checks and persistence follow.

## OSG retrieval and authorized persistence

Bounded context and history succeeded before edits with no warnings. The returned historical beta episode had changed anchors and was not treated as implementation approval. Actual related entities resolved through context/history: code:file:README.md and doc:doc:tasks/plan.md#5-complete-wire-receipt-and-canonical-signatures. Existing-store refresh is authorized by the parent; no initialization, repair, migration or installation.

All operations used the explicit target workspace C:\Users\VSCode\source\repos\huarong-dao and the existing public OSG CLI/store.

- Sync: exit 0, 2,267 changes across 45 files; graph commit c37c3e703e99649563d6a116752a4dd0ac315a40ee00db9061604ae932fe56964. AMBIGUOUS_DECLARATION warnings skipped declarations; the displayed warning list was truncated, so an exact warning count is not claimed. Index coverage is not exhaustive.
- First embed saved a successful envelope: 902 total, 817 embedded, 85 reused, eight removed, zero remaining/skipped, complete=true, no warnings. Its CMD wrapper then returned a syntax error rather than a reliable CLI exit. The saved success was inspected; a subsequent explicit subprocess invocation exited 0, embedding zero and reusing all 902, complete=true, no warnings. No timeout or overlapping run occurred.
- Related heading history after sync: current=true, no warnings. Remember exit 0, resolved one entity; episode **agent:episode:92b2f8d5adca0b518ff9038d**, graph commit **c5d1fd40628b89ff19be29d9bb82aa53ad64eabb4fbd6f7cb7976f98de31675be**. POLICY_REFS_UNAVAILABLE means host-loaded rule hashes were not verified/recorded; it is not authenticated approval provenance.
- Post-remember embed: exit 0, model Xenova/all-MiniLM-L6-v2@q8, 903 total, one embedded, 902 reused, zero remaining/removed/skipped, complete=true, no warnings. This covers eligible indexed text, not skipped declarations or measured general recall quality.
- Verify: exit 0, 22 commits/2,588 elements, no warnings. Representative bounded context: exit 0, no warnings, returned the new episode with anchors ok and the actual related [plan heading](../tasks/plan.md:45), stale=false, correct main/HEAD provenance and blended seed. Graph integrity/retrieval is not application or launch certification.

Returned IDs are recorded here after sync as factual administrative closeout; this final transcription is not recursively remembered or claimed reindexed.

## Fresh administrative validation

Proxy documentation check: 118 local links, fragments and citation bounds across six existing documents, zero errors, exit 0. All 58 protected source/config/test/fixture/PDF/design-file SHA-256 values remained unchanged. Working-tree and cached whitespace checks each exited 0, with only LF/CRLF conversion warnings. An initial link-check expression matched zero links and was not accepted as validation; the corrected check supplied 117 links, with 118 checked after final persistence transcription. No application tests were rerun for documentation-only closeout.

Fresh loopback probes found ports 8787/8788/8790 closed; this proxy started no servers. Only its three temporary hash/embed/exit records were removed after transcription. Existing deterministic fixtures, screenshots, tests and unrelated ignored runtime directories are preserved. Final Git inspection: main at HEAD 8c86d0a631790122302536463a89f1b9d328786c; implementation and documentation remain uncommitted, cached diff empty, new implementation/evidence files remain untracked. No commit, push, deploy, reset or unrelated cleanup. Parent retains final status ownership.

## Parent closeout checklist

- [x] Final scoped Code Reviewer/security verdicts attributed above.
- [x] Substantive fixes and affected final validation supplied by parent; no new implementation here.
- [x] T10/live and hosted-database limitations retained; no fixture-to-live upgrade.
- [x] Authorized OSG sync → embed → remember → embed → verify → bounded context complete; actual IDs/coverage/warnings above.
- [x] Final local labels reconciled and Git state inspected. T10/E1 remains blocked; no commit/push/deploy authority.
