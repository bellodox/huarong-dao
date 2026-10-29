# Implementation design: replay-backed public leaderboard

## 1. Status, authority and scope

**Planning-only contract, revision hd1-plan-2, 2026-10-29. Implementation NOT authorized by this documentation task.** This document is the single normative implementation design. This explicitly authorized revision incorporates [D1–D5](../docs/Huarong_Dao_MVP_Decision_Delta_2026-10-29.md); the [execution checklist](todo.md) tracks it, not a second contract. Later substantive changes require explicit revision and affected validation. Saving this design is neither protocol/standard approval nor permission to spend, broadcast, deploy, install dependencies, commit or push. P1 remains unresolved. Restricted E1 deployment gathers live evidence; later public-use availability requires E1 success, not vice versa.

Authorized scope is documentation reconciliation across this plan, checklist, decision delta, historical source banner and affected README/AGENTS/CHANGELOG references. Preserve application/PDF/configuration/test sources and unrelated work. No delegation or memory writes in this subtask; parent owns final status, review and persistence. Future implementation needs separate authorization.

Precedence: this revised plan is normative; the decision delta records its authorized rationale; the [original source plan](../docs/Huarong_Dao_Public_Leaderboard_Cloudflare_Supabase_MVP.md) remains historical. Its snapshot/hash-only publication, periodic checkpoints, old paths and next action are superseded. Supabase now owns accepted operational state, reservations/outbox, receipt indexes and derived rankings under §7; ROD is independently sufficient for authenticated confirmed receipt reconstruction. Neither is replaced with snapshot-only evidence.

## 2. Required end-to-end behavior and boundaries

1. Play anonymously and free, without wallet creation, login or network dependency. Capture initial board, immutable rule profile and every successful single-cell move from reset to completion. Rejected gestures do not append moves; multi-cell gestures expand into actual legal single-cell transitions. Reset/layout changes start new evidence; assistance permanently marks that run local-only.
2. Practice, assisted and non-improving runs stay local. A completed ranked unassisted run qualifies if it strictly improves the player's **lifetime OR current-week minimum moves** for that layout. Missing best is infinity. A weekly first/better run may qualify despite being worse than the lifetime best; do not upload only the locally retained lifetime best. Equal moves never improve, even with a faster timer. Legacy local results have no ordered evidence and cannot be promoted to verified receipts.
3. After explicit publication consent, the player's existing/generated ROD wallet signs the complete canonical evidence locally. No player chain transaction or player funding is required. The Worker independently verifies signature, board and every move, derives moves/points and rechecks eligibility at issuance. It cannot establish human play, absence of external solver use, or sybil resistance. Label assurance **replayed**, never human-verified.
4. An application key signs a SELF-CONTAINED receipt containing the entire evidence and player signature. Persist exact signed transaction bytes and immediately attempt application-funded broadcast; do not batch into snapshots or wait for a periodic publisher. Queue/confirmation latency is explicit: immediate means first broadcast after safe signing/persistence, not instantaneous service under contention.
5. Supabase owns accepted operational state, transaction/UTXO reservations, the exact raw outbox, receipt index and derived ranking projections. It is not an independent proof of a valid score. The in-game leaderboard comes from the Worker with pending/confirmed/reorg states. ROD retains complete receipts: an independent verifier reconstructs lifetime and weekly rankings from authenticated confirmed-chain receipts without Supabase. Rewards, transfers and allocation policy remain future work.

Future legal-choice/deviation codecs must reconstruct the ACTUAL chosen path with precise versioned rules; fixed boards need no seed. Existing action encoding/scoring remain unchanged. A future universal OpenSpeX receipt may conceptually support inline/referenced evidence; Huarong requires COMPLETE INLINE SELF-CONTAINED ON-CHAIN evidence only, with no generic schema expansion. Future OSG/GraphPort adapters are optional and nonblocking; native LanceDB/filesystem storage is not Workers-compatible. Preserve behavior across any separately authorized migration; implement none now.

No per-move broadcasts, hash-only evidence replacement, per-player name transactions, Nostr service, ANGI outputs, OSG runtime or full OpenSpeX conformance claim. The narrow hd1 application profile is not the full SpeX working concept.

## 3. Preservation and future asset alignment

Baseline rechecked for this revision: branch main, HEAD e711a22e42752821d4b7fef03d28b75164d5cd7c; index empty, old HTML tracked deletion, public asset and planning/PDF documents pre-existing untracked work. Short status rendering can show additions/rename; cached diff is empty. No staging operation is authorized. Preserve these changes rather than treating them as this revision's implementation.

The [configuration](../wrangler.jsonc:6) still serves the docs directory; the [README QA guidance](../README.md#available-local-qa-commands) lists five QA scripts whose sources still target the absent old asset. **Do not fix these now.** Future task T1 must align the public asset, routing, all five QA paths and affected documentation before tests can establish application health. Keep the Worker entry as [worker.js](../worker.js), split new modules under a leaderboard directory, and route API requests Worker-first while preserving assets. Do not introduce a second runtime entry just to mirror the PDF's conceptual naming.

Preserve stable catalog IDs and Training startup, lazy solver/canonical interchangeable-piece BFS, practice and assistance exclusions, durable bests independent of recent five entries, duplicate/stale retry guards, and the combined first-score owner/best/history write with readback and rollback on failure. Preserve cross-tab lock checks; browser localStorage is not a fully transactional multi-tab database. Preserve wallet continuity and the custom full previous-name-script signing behavior when porting transaction code. Preserve Bulgarian/English dynamic translations, focus/keyboard dialogs and independent analytics/public consent including analytics withdrawal and cookie cleanup. Existing local scores use moves/time; the points formula below is new, not current behavior.

## 4. Exact hd1 replay profile and scoring

The profile is fixed by this specification, not fetched from Supabase. Board is 4 columns by 5 rows, row-major. Piece indices 0 through 9 correspond to CC, ZY, ZF, MC, HZ, GY, S1, S2, S3, S4. Shapes respectively are 2x2; four 1x2; 2x1; four 1x1. Occupancy characters A through J mean those indices; dot means empty. The 20-character initial occupancy must equal the catalog entry for the claimed layout, contain exactly two empty cells and rectangular complete pieces of the fixed shapes. An arbitrary user board is not ranked.

Moves use alphabet ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_ (base64url alphabet used as individual symbols, **not** a packed binary base64 stream). Symbol index equals four times piece index plus direction index: up=0, right=1, down=2, left=3. Indices 40 through 63 are invalid. Each action translates that piece by one cell, wholly in bounds and without overlap. Preserve piece identity across replay; interchangeable-piece canonicalization is only a BFS optimization. A solution ends with CC top-left at x=1,y=3; reject any move following the first solved state. Move count is exactly the symbol count. Empty, illegal or unsolved logs fail.

The exact catalog below is part of this profile. Occupancies are recorded in §12 from the current source; future tests independently expand shapes, replay and BFS-check them. No dependency on a future website for old rules is allowed. A new catalog/rule/scoring meaning requires a new profile, never reinterpret hd1.

For optimum O and replayed M >= O, points are nearest-integer half-up of 10*O^3/M^2, implemented as integer floor((20*O^3 + M^2)/(2*M^2)). Zero points are allowed; no score floor is implied. Each player's per-layout best is minimum M; lifetime overall is the sum across the eleven ranked layouts. Weekly overall uses only receipts included in that epoch. Maximum is 11,740 (ranked O sum 1,174). Overall ordering: points descending, completed distinct ranked layouts descending, then compressed player public-key bytes ascending. Per-layout order: moves ascending, then those key bytes. Equal-best duplicate receipts use earliest chain position (height, transaction index, output index) for provenance only. Client elapsed time stays local and never decides public order, eligibility or rewards.

## 5. Complete wire receipt and canonical signatures

The chain value is one valid UTF-8 JSON OBJECT, compact and without whitespace, with exact field order p,w,l,b,n,m,s,a. No duplicate/unknown fields. Unsigned object has p,w,l,b,n,m; player-signed object adds s; final object adds a. All serializers must emit literal Unicode UTF-8, no optional escapes, no BOM or trailing newline. Integers are nonnegative decimal without leading zeros, exponent or negative zero. Reject noncanonical incoming bytes, not merely semantically equal JSON.

| Field | Exact meaning and bound |
| --- | --- |
| p | Literal hd1: fixed rules, catalog, formula, assurance and encoding in this document |
| w | Client epoch hint, integer 0..9,999,999,999; not authoritative inclusion week |
| l | Exact stable catalog ID, ASCII, at most 16 bytes |
| b | Initial occupancy, exactly 20 ASCII characters as §4 |
| n | NFC public nickname, nonempty, at most 12 Unicode scalar values and 48 UTF-8 bytes; no quote, backslash, U+0000..001F, U+007F..009F, angle brackets or unpaired surrogates |
| m | Complete ordered move symbols, no truncation; candidate profile cap 1,536 is **NOT approved**, see P1 |
| s | Player recoverable signature, 65 bytes encoded unpadded base64url: 87 ASCII characters |
| a | Application recoverable signature, same encoding and length |

Canonical player signing preimage is UTF-8 of the literal domain `huarong/hd1/player` followed by one zero byte followed by the **complete valid unsigned JSON object**, including closing brace. Digest is one SHA-256 of that preimage. App signing is analogously domain `huarong/hd1/app`, zero byte, then the **complete valid player-signed object**, including s and closing brace. Neither signs an unterminated JSON prefix. Final value contains both signatures and all evidence, never just its digest. Receipt ID/idempotency key is lower-case hex SHA-256 of canonical player-signed bytes. The app signature authenticates that exact claim; chain inclusion supplies authoritative logical sequence/week. No nonce or server challenge is needed for replay-safe identical claims; identical evidence in another week differs through w, which is only an intent hint.

Signature bytes: header 31+recovery-id (0..3), then unsigned big-endian r and s, each exactly 32 bytes; valid scalar range and low-S mandatory. Recover compressed SEC1 public key, verify against the digest and reject alternate encodings/high-S. Player identity is those 33 compressed public-key bytes, regardless of imported WIF compression flag; do not mutate the stored WIF or pretend an uncompressed legacy address is the same address as the normalized compressed identity. Derive and vector-test legacy ROD Base58Check addresses with the network's verified parameters before use; no Bech32 assumption. The application recovered key must match the configured authorized app transaction key. Chain bootstrap authenticates the issuer/name lineage, not a key offered by an untrusted receipt. Signing library must avoid hashing the already computed digest again (for the researched noble API this requires prehash:false); compatibility is unproven until E1.

### P1: BLOCKED capacity/policy decision

Fresh Python compact UTF-8 serialization with the worst allowed 10-digit w, 16-byte l, 20-byte b, 48-byte non-escaping n and two 87-character signatures gives **326+M bytes**. M=1,536 gives **1,862 bytes**, leaving 186 of the 2,048 value bytes. M=1,722 gives exactly 2,048; M=1,723 gives 2,049. JSON escapes are forbidden for the restricted nickname characters; allowed Unicode is literal, and byte length rather than codepoint length is enforced. Signature length alone is not signature validity; these measurements are capacity fixtures, not signed/replay-valid transactions.

The 1,536 candidate cap is an additional eligibility restriction not requested by the user. Neither first weekly nor first lifetime entry provides a finite move bound. Even requiring points >=1 would allow up to floor(sqrt(20*126^3))=6,325 moves, exceeding this encoding's capacity. Therefore the unrestricted workflow cannot be promised by this receipt design. **P1 requires explicit human approval of a bounded public profile or an explicitly revised full-evidence design. Until then public issuance is disabled; never truncate evidence, silently reject otherwise-eligible runs under an approved-sounding cap, replace it with a hash, or claim the requirement resolved.** Unlimited local play remains intact. The 16-byte layout ID and 48-byte name limits are fixed wire/profile bounds and must also be disclosed in that policy review.

## 6. Weeks, confirmations and reconstruction

Epoch is floor((inclusion-block MTP - 345600)/604800), where 345600 is Monday 1970-01-05 00:00 UTC. Compute MTP as median of that block's timestamp and its ten preceding canonical-chain block timestamps (for fewer available ancestors, median of available sorted timestamps, lower middle); chain launch/ROD consensus behavior must be checked by E1. MTP is not assumed strictly increasing. No client clock, server timestamp or Supabase time decides week or ranking. Six confirmations includes inclusion block as confirmation one. Pending receipts are separate from confirmed rankings.

Before signing, use current canonical tip MTP as provisional week; recheck both lifetime and provisional weekly improvement against durable confirmed plus reserved issuance state. Require w to equal this provisional epoch at admission; a changed epoch before signing releases the unsigned reservation and returns epoch_changed for fresh player consent/signature. A signed transaction must never be mutated. If mined across a boundary, release/migrate its provisional projection to the **actual inclusion epoch**, recompute affected totals and queued eligibility. Do not discard a valid authenticated solved receipt just because the actual week differs from w or the Worker admission estimate. Independent reconstruction selects best valid receipts, regardless of private admission history; chain-observed replay results, not hidden admission logs, govern totals. A boundary-crossing receipt that no longer improves is a no-op in that epoch, not a fake score. Zero-point completions still count as completed.

For operational weekly close, identify the first canonical block whose MTP enters a later epoch and wait until it has twelve confirmations. This is operational finalization, not immutable settlement or reorg immunity; reopen/rebuild if canonical history changes. Rewards remain disabled.

Reconstruction starts from documented authorized registration/genesis txid, app compressed key, marker legacy address and exact name g/huarong-lb. Discover **all** address-history pages, deduplicate txids, obtain raw transactions and canonical header ancestry, parse raw name scripts and marker outputs, follow same-name outpoint spends from the bootstrap, and authenticate transaction ownership and app/player signatures. A forged payment to the marker does not qualify. Current mutable name state alone loses earlier receipts and is insufficient. Each qualifying name value is a full receipt, even after a later update overwrites it. Verify replay and compute bests directly; do not consult Supabase scores. Exhaustive history, transaction indices and raw scripts are E1 prerequisites, not presumed API guarantees. If the API cannot prove complete discovery, an explicitly authorized synced ROD-node scan of the same transaction lineage is a prerequisite; no substitute snapshot architecture is selected.

## 7. Issuer state machine, ownership and failure recovery

Supabase PostgreSQL owns accepted operational claims, immutable claim bytes, public identity reservations, bounded queue, lifetime/weekly projections, transaction/UTXO journal, exact raw outbox, receipt indexes and reconciliation cursor. All mutations use a small server-only SQL RPC/storage boundary called by the existing Worker; no new backend service or launch Durable Object. Multi-row admission/reservation/projection changes are one database transaction using row locks and/or revision CAS, uniqueness constraints and constrained execution grants. Browser has no database writes or privileged credentials; restrictive grants/RLS are defense in depth. RPC naming alone does not prove atomicity: integration tests must exercise concurrent calls and rollback. Supabase outage stops admission/signing; reads may return labeled stale data or 503. ROD remains the independent complete confirmed receipt ledger. Confirmed projections can be rebuilt from chain; chain alone cannot recover private unsigned decisions or an unbroadcast outbox, so preserve database backups/journal and never infer that missing operational state frees inputs.

Safety MVP: **at most one unconfirmed signed transaction globally**, not a speculative ancestor chain. Hold the next issuance until the previous has six confirmations and reconciliation completes. Updates spend the previous same-name output; no name_new, only register then update, at most one name input/output. Include a dedicated legacy-address marker output in every receipt transaction, independently of change. Name minimum researched as 0.01 ROD; exact monetary/base-unit/fee/dust rules and spend reserves require E1. Use a NEW disposable limited-fund app WIF, server secret only, never the old exposed browser issuer key. Never inject it into HTML, logs, Supabase or API responses. Player signs evidence only; app signs and funds chain transaction.

State transitions: received (not accepted) → verified → durably reserved/queued → unsigned_preparing → signing_started (or signing_unknown on unresolved failure) → signed-persisted → broadcast_pending/unknown → observed_unconfirmed → confirmed. Unsigned not_improved is a revision-bound evaluation, not a permanent terminal rejection. Other unsigned terminal states: rejected, epoch_changed, cancelled; reconciliation states: reorged, conflicted, failed_closed. Immutable malformed/signature-invalid rejections are distinct from state-dependent non-improvement. Queue admission atomically reserves a slot and identity binding; response queued is only allowed after that commit. Queue bound 64 unsigned claims globally and one per player/layout/week; full queue returns 429 queue_full with Retry-After, without a reservation. Payload cap 8,192 bytes; expensive crypto/replay work rate limited before verification. Operator rate values must be specified/tested before exposing service; no claim this prevents bots.

After replay, an atomic SQL admission RPC locks the application coordinator and affected claim/player/projection rows in a consistent order, compares eligibility/nickname, and reserves queue state with a durable monotonically increasing revision. Advance revision for reservation changes, unsigned cancellation/expiry, inclusion-epoch migration and reorg reconstruction. Persist each unsigned evaluation revision in that transaction. Preparation RPCs reserve the current name head, inputs and the single global signing slot; unique active reservations prevent overlapping spends. No database transaction or row lock is held across Worker signing, chain queries or broadcast. Fetch chain observations outside transactions and check expected head/revision before the controlled signing transition.

Unsigned preparation ownership uses database-time expiry and a monotonically increasing fencing generation. Every mutation checks owner, generation, expected state/revision and expiry in the same transaction. A stale or expired preparation owner must not sign. Expiry releases only unsigned preparation that has NOT entered the signing barrier. Immediately before local signing, an atomic RPC rechecks epoch, eligibility, name head, funds/reserved inputs and ownership, then durably enters signing_started. This barrier is NOT an automatically expiring lease: no takeover or input reuse is allowed merely because the Worker timed out. A successful response authorizes only that generation's single signing attempt; resolve an uncertain response from durable state before signing, never guess success. Signing runs outside the database transaction.

Once signing_started, retain exclusive ownership/reservations until exact raw bytes and deterministic txid are committed by a generation/state-checked finalize RPC. A lease check cannot prevent a paused owner resuming after expiry; the non-expiring barrier is deliberately chosen instead of claiming impossible lease safety. If crash/lost response leaves no raw bytes, fail closed in signing_unknown: no successor signs, no reservation expires and no alternative spend is authorized. Recovery requires proving the old execution cannot resume and reconciling chain/outbox before an explicitly controlled reset; if that cannot be established, leave issuance paused. A stale/invalidated owner never signs or finalizes. On persistence failure do not fetch/broadcast; retain ambiguous barrier state rather than release ownership and sign again. Exact raw persistence is immutable and precedes ALL broadcast attempts. Bounded Worker-triggered retries/status recovery use the same SQL boundary; no always-on process, new service or Durable Object alarm is required. Liveness under signer loss is not promised at the expense of single-key safety.

First broadcast follows signed persistence immediately. Unknown timeout is **not failure proof**: query exact txid/inputs, then rebroadcast the SAME bytes only. Retry schedule 5s,30s,120s then reconciliation/operator pause; status remains unknown if evidence is missing. No automatic fee replacement or new-input signing while outcome ambiguous. Exact duplicates return the stored claim decision/txid, except an unsigned not_improved decision is reusable only at its recorded evaluation revision. On an identical player-signed claim retry after the state revision changes, atomically re-evaluate lifetime OR current provisional-week eligibility and current admission constraints; update its evaluation revision and decision, reserving once if it now qualifies. Reuse the same receipt ID and canonical player-signed bytes; an epoch mismatch still requires fresh consent/signature under §6. Same idempotency key with different canonical bytes returns conflict. Serialize reconsideration with admission/signing, reuse any existing queue reservation, and never create a second publication for the claim. Once transaction bytes/txid have been persisted, exact-raw/txid idempotency is permanent, including across reorgs: retries use that transaction's reconciliation path, never a new signing path. Keep durable decisions and evaluation revisions through restarts. A provisional best or nickname reservation rolls back on unsigned rejection/cancellation only before signing_started; a signing barrier cannot be cancelled/released as ordinary unsigned work. Once signed, retain reservation until chain reconciliation resolves it; never free ambiguous inputs.

Reorgs, external key spends and name conflicts are possible. Halt issuance, find common ancestor, roll back affected confirmed projections/name locks, reconstruct canonical lineage and bests, advance the state revision and re-evaluate queued claims. Previously unsigned not_improved claims become reconsiderable on identical retry under the new revision once reconciliation permits admission; signed transactions remain on their existing reconciliation path. If the authorized name head cannot be unambiguously recovered, fail closed and require operator diagnosis. A confirmed public name binding is reconstructed from the earliest valid chain receipt for that player in canonical chain order; later differing n is invalid for public identity. Pending identity reservations are serialized separately from browser nickname locks and are not public-confirmed identity. A reorg may remove that first binding. Never silently rename existing local records; conflicting existing local nickname versus public identity yields explicit name_conflict and local play continues. UI escapes text; publication warns that complete evidence, stable key and name are public and cannot be erased by withdrawing consent.

Transaction signing must serialize the **full previous name script**, including long PUSHDATA fields, in legacy SIGHASH_ALL preimage, double-SHA256 it, and use low-S DER transaction signatures with sighash byte. All money arithmetic is integer base units. Receipt signatures above are recoverable compact signatures, not DER transaction signatures. Validate exact scripts, outputs, txid, standard weight (<40,000 researched policy weight units), fees and network address parameters before broadcast; value capacity alone is not operational feasibility.

## 8. Worker API and browser integration

Same-origin JSON API; API failures never prevent local play. No secret in availability flags. Remove the old issuer HTML injection in future implementation rather than preserving its insecure public mode.

| Route | Contract |
| --- | --- |
| GET /api/leaderboard | scope=lifetime or week; week integer required for weekly, limit 1..100 default20, opaque snapshot-bound cursor; optional compressed player-key hex. Return ordered totals/per-layout bests, confirmed height/hash, epoch, snapshot revision, stale flag and separately pending statuses. Never merge pending into confirmed totals. |
| POST /api/score | Content-Type application/json; canonical player-signed object from §5, Idempotency-Key=receipt ID. Explicit public consent is obtained before browser signing; endpoint does not accept WIF, claimed points/time/assistance as authority. Validate origin, size, canonical form, profile, name, signature and full replay before durable admission. |
| GET /api/submissions/{receipt-id} | Public receipt-bound status, derived moves/points, provisional/actual epoch, txid if signed, confirmations, error code, retry guidance; no private credentials. Allows recovery after lost POST response. |

POST responses: 202 queued/pending/unknown only after durable reservation; 200 existing decision or not_improved (no new broadcast); 400 malformed/noncanonical, 401 invalid_signature, 409 idempotency_conflict/name_conflict/epoch_changed, 413 payload_too_large, 422 invalid_replay/unknown_profile/practice_layout, 429 queue_full/rate_limited, 503 issuance_disabled/funds_unavailable/reconciliation_required. Responses use status, receipt_id, code, retryable, provisional_epoch, actual_epoch, txid, confirmations, derived_moves, derived_points as applicable; no undefined claim of acceptance/confirmation. Final public eligibility is determined at issuance and confirmed reconstruction, not merely HTTP status. Unsupported cap yields issuance_disabled until P1 is resolved, not a quietly active cap.

Browser stores exact full run evidence with the corresponding result, not just current best; offline retries reuse signed bytes/ID and status lookup. Do not auto-publish legacy results. Recheck consent and run identity before signing/enqueueing; withdrawing consent stops unsigned local retries, cannot recall sent/signed chain bytes. Local first-score save remains independent of server availability; public name commitment is the server/chain identity rule in §7. Wallet created/imported only on opt-in public use; retain existing identity key and backup/export affordance, never overwrite to resolve a nickname conflict. Feature availability is discovered via the leaderboard response or explicit 503, never by exposing an app WIF. Leaderboard supports lifetime/week switching and separate queued, broadcast, six-confirmed, stale and reorg notices with Bulgarian/English translations and accessible dialogs.

## 9. Evidence, research and source limitations

Fresh in this task: baseline/status/history inspection, full prior plan and full PDF extraction, Worker/config/README reads, targeted public source inspection, existing QA-path inspection and Python receipt arithmetic. [Existing BFS report](../tests/independent_bfs.txt) matches the supplied independently reported BFS result: 14 layouts, 3 practice, 11 ranked, O sum 1,174. The independent BFS execution was **child/parent-reported**, not rerun here. No application runtime, chain, deployment, external API or signing test ran here. PDF is *SpeX dApp Protocol — Working Concept v0.4*, 23 October 2026, 11 pages (page labels 02..11 after cover); the old title and 13-page citation are wrong. Full extraction was read; optional fresh page counting via fitz failed because that module is absent, not because the PDF was changed.

OSG context was parent-reported successful; fresh history lookup for actual resolved code:file:worker.js returned current=true, no warnings, graph c81d47855205b0b508a5ef002348f3962368a73ed28f9ae7080ef06975cab0d3e. Older episode agent:episode:8aacea8f3ce11cca1fbf9c66 anchors an older d2c854 revision; it is not current implementation evidence. No plan/public entity resolved; none fabricated. No memory write in this task.

External findings below were source-inspected by the parent, **not runtime-tested here**. Abbreviated revisions are attributed source observations; mutable branch URLs are not claimed immutable full-hash pins. Future implementation must resolve full revisions and review official documentation before selecting exact dependency versions; no package/version is installed or invented by this plan.

| Source | Finding and limit |
| --- | --- |
| [ROD names main](https://github.com/SpaceXpanse/rod-core-wallet/blob/master/src/names/main.cpp), observed f17675b | Name <=256 bytes, value <=2048 bytes UTF-8 JSON object; register/update, one name input/output, prior same-name spend. |
| [ROD parameters](https://github.com/SpaceXpanse/rod-core-wallet/blob/master/src/names/params.h), observed 883f41e | Minimum name amount 0.01 ROD; verify intended network at E1. |
| [ROD standard policy](https://github.com/SpaceXpanse/rod-core-wallet/blob/master/src/policy/policy.h), observed c239849 | Standard weight 40000 (~10000 vbytes), low-S policy; live relay fee/ancestor rules unverified. |
| [ROD name mempool](https://github.com/SpaceXpanse/rod-core-wallet/blob/master/src/names/mempool.cpp) | Unconfirmed same-name chains exist in source; not authority to assume a ten-deep operational limit. MVP permits only one. |
| [ROD reference](https://rod.spacexpanse.org) | Limits and six-confirmation recommendation; not endpoint execution evidence. |
| [API routes](https://github.com/SpaceXpanse/rod-api-server/blob/new/server/rest.py), [address methods](https://github.com/SpaceXpanse/rod-api-server/blob/new/server/methods/address.py), [API README](https://github.com/SpaceXpanse/rod-api-server/blob/new/README.md) | POST /broadcast form raw; GET /transaction/{txid}, /unspent/{address}, /history/{legacy-address}?offset= (newest-first ten txids via ElectrumX), /header/{blockhash}, /height/{n}, /fee, /decode/{raw}. Exact raw-script availability, complete paging, canonical headers/MTP and public availability unverified; Bech32 unsupported in README. |
| Superseded issuer research | Earlier Durable Object storage/alarm research is historical, not launch architecture. Supabase SQL concurrency/failure semantics in §7 require implementation tests. |
| [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/), [noble curves](https://github.com/paulmillr/noble-curves) | WebCrypto does not supply secp256k1; parent Context7 noble v2 research found recoverable low-S signing and prehash:false for an existing digest. Actual Worker compatibility unproven. |
| [Supabase RPC](https://supabase.com/docs/reference/javascript/rpc), [database functions](https://supabase.com/docs/guides/database/functions), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) | HTTP RPC invocation documented; server SQL transaction and access semantics must be specified/tested, not inferred from client method name. |

The [working concept PDF](../docs/SpeX_dApp_Protocol_Working_Concept_v0.4.pdf) provides conceptual roles: identity/privacy pp.5–6, receipt semantics pp.6–7, selective chain authority p.7, storage/compatibility p.8 and open work/status pp.10–11. It explicitly is not an accepted OIP, certification or shipped implementation. This application's full-evidence public chain choice has privacy/capacity consequences beyond its optional generic commitment model.

## 10. Gates, verification and rollback

**Authorization gate A0:** a human separately authorizes the implementation scope; no unchecked task below is executable merely because this plan is saved. **P1:** explicit public-evidence capacity policy decision/revision as §5. **E1:** before restricted experimental deployment/broadcast TO GATHER live evidence, obtain separate explicit authorization naming chain, disposable app wallet, limited funding/spend envelope, exact app name/marker and broadcast permission. This task authorizes NONE. Real experiment transactions cannot be rolled back by reverting code.

Restricted experimental deployment requires E1 authorization and applicable P1 resolution, NOT prior live success. Later public-use availability separately requires E1 results. This documentation task authorizes neither deployment.

E1 experiment must record pass/fail and raw evidence (without secrets) for: Workers-runtime player/app vectors, recovered compressed identities and legacy addresses; exact maximum **valid** receipt UTF-8 bytes <=2048; complete register/update serialization and independent verification, transaction weight/fee/dust and full previous-script SIGHASH_ALL; funded registration then update; one-at-a-time concurrent submissions; Supabase atomic reservation/CAS, stale-owner/expiry and signing-barrier recovery; persisted-before-fetch crash recovery; duplicate exact-raw rebroadcast and timeout/unknown handling; complete paginated historical discovery/raw scripts/headers/MTP with overwritten name values; six confirmations; independent Python replay and lifetime/weekly rebuild with Supabase absent; boundary crossing, reorg and external-spend fail-closed fixtures. Record network, library/source revisions, raw txids, headers, byte/weight measures, expected/actual outputs and gaps. Source reading or fixtures alone do not pass live transport/discovery gates. If exhaustiveness cannot be established, stop and document the authorized node-scan prerequisite; do not claim success from the current name value.

All automated tests/check utilities belong in root tests. Existing commands (blocked on asset alignment and runtime prerequisites) are: python.exe tests/qa_edge.py; python.exe tests/qa_v14.py; python.exe tests/qa_dialog_keyboard.py; python.exe tests/qa_accessibility.py; python.exe tests/qa_deep_independent.py. They are existing files, not fresh passes. No package manifest, package runner, build/lint scripts or CI configuration currently exists. Future test paths in §11 are planned, **not available commands now**. Their future focused command is python.exe followed by the linked test path after that task creates it. Runtime integration tooling/commands must be established and recorded in T2, never inferred here.

Checkpoint after every two tasks: retain passing affected local checks and explicit blocked gates; review evidence before dependent work. Stop if a task exceeds five files or three acceptance criteria; revise/split plan explicitly. Final future security review covers input handling, secrets, signing, APIs, persistence and deployment; independent code review uses Code Reviewer only after implementation and tests are complete. Reviews cannot authorize funds, protocol approval or deployment. Rollback disables public issuance first, preserves exact signed outbox/history, restores known-good application/config separately, reconciles chain before resuming, and never deletes already published records or overwrites player wallets.

## 11. Dependency graph and small vertical work packets

Dependency graph: A0 → T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12. P1 gates T4's public profile activation and all public issuance. E1 authorization gates T10 live experiment; E1 success gates T11 public availability. T3–T9 may use local fixtures only under A0 while P1/E1 remain blocked, with issuance disabled. Each task has <=5 files, <=3 acceptance bullets and an observable verification. File references to new paths are explicitly **planned**, not existing links.

### T1 — Local game loads from the preserved asset

Align the pre-existing public asset move without changing gameplay. Files (5): existing configuration and README; the three existing QA files for edge, locale/viewport and deep independent checks. Dependencies A0. Scope medium.
- Asset routing and these three QA sources resolve the public asset.
- Document actual commands/prerequisites and remaining two stale QA paths without claiming passes.
Verification: git diff --check; run the three existing Python commands in §10 after prerequisites are checked, recording actual exits.

### T2 — Remaining browser regressions can run

Complete path alignment and establish local Worker/signing test tooling without deployment. Files (5): existing two remaining QA files and agent guidance; planned package.json and dependency lockfile, exact package manager/lockfile chosen only after official compatibility/version check. Dependencies T1. Scope medium.
- Keyboard/accessibility QA and guidance resolve the public asset; all five existing suites can run.
- Exact verified runtime/dependency commands and pins recorded; no app secret in browser fixtures.
Verification: five existing Python commands in §10; actual installed local Worker tool help/start-stop smoke evidence, not an invented package script. Checkpoint C1: preserve local-only browser behavior and record available future runtime commands.

### T3 — A local completed run carries replayable evidence

Capture board/profile/valid moves alongside local results, preserving all §3 invariants. Files (3): existing public asset; planned leaderboard/profile.js and tests/qa_evidence.py. Dependencies T2. Scope medium.
- Legal single-cell moves append once, invalid gestures do not; reset/assistance isolates eligibility.
- Weekly-only candidate evidence survives even when lifetime best is better; legacy remains local.
- Independent Python fixture replay equals browser move count and terminal board.
Verification: future-created focused Python check plus affected existing QA; do not enable uploads.

### T4 — A wallet signs one complete portable local claim

Files (4): existing public asset; planned leaderboard/receipt.js, tests/qa_receipt.py and tests/fixtures/receipt.json. Dependencies T3; P1 before activation. Scope medium.
- Canonical domain/signature vectors bind every evidence/name field and recover normalized identities.
- Worst-case valid Unicode/signature fixtures enforce exact UTF-8 limit and approved policy only.
- Wallet continuity, opt-in and withdrawal are preserved with no player transaction.
Verification: future-created Python vector/capacity check and recorded local runtime crypto command from T2. Checkpoint C2: independent replay/signature agreement; P1 remains a blocking human decision unless explicitly resolved.

### T5 — Worker rejects invalid claims without public side effects

Files (4): existing Worker; planned leaderboard/verify.js, tests/qa_verify.py and tests/fixtures/invalid.json. Dependencies T4. Scope medium.
- API independently replays all layouts, rejects tampering/unknown profiles and derives integer points.
- Lifetime OR weekly strict improvement, equal moves and boundary epochs have deterministic fixtures.
- Invalid/oversized/rate-limited requests never reserve/sign/broadcast.
Verification: future-created focused Python API/fixture harness using T2's recorded runtime command.

### T6 — One claim survives durable reservation and restart

Files (5): existing Worker; planned leaderboard/issuer.js, leaderboard/storage.js, supabase/migrations/001_leaderboard.sql and tests/qa_issuer.py. Dependencies T5. Scope medium.
- Transactional SQL RPC row locking/CAS and revision-checked reservations enforce §7 bounds under interleaving, including preparation expiry and the non-expiring signing barrier.
- Duplicates/restarts preserve durable decisions and evaluation revisions; unsigned not_improved retries re-evaluate after revision changes, while conflicting bytes fail and persisted signed transactions retain exact-raw/txid idempotency without double signing/publication.
- Pre-barrier unsigned rejection releases provisional state; signing_started/signing_unknown and ambiguous signed state stay reserved.
Verification: future-created crash/interleaving harness, including confirmed best 130, reserved A=120, B=124 initially not_improved in both lifetime/week projections, then unsigned A cancellation and identical player-signed B retry qualifying with unchanged receipt ID. Repeat/concurrent retries and restart must retain one reservation/publication; unchanged-revision non-improvement and immutable malformed/signature-invalid rejections remain stable. Include stale-generation, lost begin/finalize response, preparation expiry, paused signing owner and database outage fixtures. Checkpoint C3: no broadcast before exact-raw persistence, no SQL lock across signing/network, no competing signer after barrier loss.

### T7 — One reserved claim becomes a persisted signed transaction fixture

Files (4): planned leaderboard/chain.js, leaderboard/issuer.js, tests/qa_chain.py and tests/fixtures/transactions.json. Dependencies T6. Scope medium.
- Full receipt register/update fixtures verify scripts, full previous-script signatures and exact txids/weights.
- Persist exact bytes before mock broadcast; retries use identical bytes and allow only one unconfirmed transaction.
- Fee/fund/conflict errors fail closed without new-input replacement.
Verification: future-created independent Python serialization/signature fixture check and local Worker mock transport. No live broadcast.

### T8 — Supabase serves a recoverable derived leaderboard

Files (4): planned leaderboard/index.js, leaderboard/storage.js, tests/qa_index.py and tests/fixtures/index.json. Dependencies T7. Scope medium.
- Operational projection writes use the existing narrow SQL boundary, are idempotent, server-only and transactionally tested with constrained privileges.
- Worker queries show deterministic confirmed/pending/stale state; database outage halts admission/signing and preserves reservations/outbox.
- Rebuild confirmed totals from receipt fixtures without Supabase; never delete the operational journal/outbox to test index reconstruction.
Verification: future-created Python fixture check; actual isolated database integration command established only with separate service authorization. Checkpoint C4: database outage/recovery and no client service credential.

### T9 — Independent historical reconstruction survives overwrite/reorg

Files (4): planned leaderboard/reconcile.js, leaderboard/issuer.js, tests/qa_reconstruct.py and tests/fixtures/history.json. Dependencies T8. Scope medium.
- Exhaustive paginated raw-history fixtures exclude forged markers and follow authenticated name lineage.
- Independent Python replay rebuilds weekly/lifetime scores without Supabase, including overwritten values.
- Six/twelve confirmations, crossing epochs, common-ancestor rollback and external spends match §6–7.
Verification: future-created Python reconstruction check plus mock Worker reorg/restart harness, including canonical-best rollback making a previously unsigned not_improved claim eligible on identical retry after reconciliation, with unchanged receipt ID and no duplicate publication; an already signed claim instead retains its exact transaction/reconciliation path.

### T10 — Authorized E1 experiment establishes chain feasibility

Files (3): planned tests/qa_chain_live.py, tests/fixtures/chain_public.json and tests/chain-evidence.md. Dependencies T9, P1 and E1 authorization, NOT prior live success. Restricted deployment gathers that evidence. Scope medium.
- Every E1 requirement in §10 has measured pass/fail evidence; unknown discovery completeness blocks rollout.
- Limited-fund registration/update, immediate broadcast and exact-byte timeout retry are independently verified.
- Secrets excluded, started processes stopped, live artifacts limited to public evidence.
Verification: future-created live harness only under exact chain/funding/broadcast authorization; record its real command and exits. Checkpoint C5: E1 must pass; no fixture/source-only substitute.

### T11 — Player sees the confirmed in-game board

Files (4): existing public asset/Worker; planned leaderboard/index.js and tests/qa_public_ui.py. Dependencies T10 and E1 success. Scope medium.
- Walletless play/viewing and opt-in evidence submission show accurate queued/pending/confirmed/reorg states.
- Lifetime/week/per-layout rankings match independent reconstruction, never pending totals.
- Bulgarian/English, dialogs, local nickname rollback/cross-tab behavior and consent separation regressions pass.
Verification: future-created Python browser flow plus affected five existing suites using actual established runtime commands.

### T12 — Release decision has bounded evidence, not automatic deployment

Files (4): existing README/agent guidance; planned tests/release-evidence.md and tests/qa_release.py. Dependencies T11. Scope medium.
- Record fresh versus historical results, approved P1/E1 evidence, secret boundary and chain-reconciliation rollback.
- Implementation/tests complete before required security and Code Reviewer reviews; scope/verdicts recorded.
- Issuance/deployment remains disabled until separately authorized; rewards remain absent.
Verification: future-created release contract check, affected documentation links and git diff --check; final status/diff with unrelated work preserved. Checkpoint C6: parent owns final status and any separately authorized memory persistence; no public launch inferred.

## 12. Frozen catalog

The following generated occupancy table is part of §4. It is populated from the existing source during planning, not an implementation module. Verify independently before use.

| Stable ID | Eligibility | Optimum O | Initial occupancy |
| --- | --- | --- | --- |
| training | practice | 24 | DCBJDCB.EAA.EAAHGIFF |
| first_steps | practice | 32 | DBHJDB..ECAAECAAGIFF |
| next_steps | practice | 50 | IHAADBAADBFFEC.GEC.J |
| wings | ranked | 116 | BAACBAACDFFEDIJEG..H |
| heng_dao_li_ma | ranked | 118 | BAACBAACDFFED..EGHIJ |
| rear_guard | ranked | 82 | BAACBAACDGHEDIJE.FF. |
| small_obstacle | ranked | 100 | BAACBAACGFFHDIJED..E |
| ambush | ranked | 110 | BAACBAACGFFHIDEJ.DE. |
| fayaa_sideBySide | ranked | 85 | CAABCAABGHIJDFFED..E |
| fayaa_threeRoads | ranked | 92 | GAAHCAABCFFBDIJED..E |
| fayaa_peach | ranked | 100 | GAAHCAABCDEBIDEJ.FF. |
| fayaa_rain2 | ranked | 119 | CAA.CAAGFFBDE.BDEHIJ |
| fayaa_cannotStop | ranked | 126 | .AACGAACBFFDBE.DHEIJ |
| fayaa_highRisk | ranked | 126 | AAC.AAC.GBFFDBHEDIJE |

## 13. Planning validation record

Revision hd1-plan-2, 2026-10-29: authorized reconciliation replaces the launch Durable Object with Supabase operational ownership and a narrow transactional SQL boundary, retaining complete inline receipts and independent confirmed-chain ranking. A non-expiring signing barrier trades availability for stale-owner safety. No application implementation/deployment occurred. P1 remains unresolved; E1 gathers evidence before a separate public-use gate. Current documentation-only Code Reviewer verdict and its limits are recorded in the [planning-only completion checklist](todo.md#planning-only-completion). Parent owns final status and has separately authorized final OSG persistence. Records below describe the earlier revision only, including its then-authorized persistence scope.

Pre-closeout review correction, 2026-10-28: addressed Code Reviewer's NEEDS CHANGES finding by making unsigned state-dependent non-improvement revision-bound and reconsiderable after reservation/projection changes, while preserving receipt identity and permanent signed-transaction idempotency. T6/T9 planned verification now covers cancellation/reorg retries and duplicate-publication prevention. Parent-reported review scope: the first Code Reviewer examined the entire plan and identified this cached-rejection retry issue; the second focused Code Reviewer APPROVED the correction's coherence only, with no new high-confidence issue. This is not blanket implementation, security or runtime-feasibility approval, nor human approval of altered frozen standards. A0 implementation authorization, P1 approval of the candidate 1,536-move public cap or revised full-evidence design, E1 chain/signing/history runtime feasibility, and future funds/broadcast authorization remain BLOCKED; future implementation checklist items remain unchecked. Earlier validation records below remain historical evidence, not fresh validation of this correction. The parent retains final status and persistence ownership; this bounded final executor is separately authorized to validate documentation and execute existing-store OSG closeout, superseding the earlier no-persistence task boundary without authorizing implementation.

Validation is documentation-only; no app/chain feasibility pass is implied. Fresh Python checks returned exit 0 for 34 active local links/fragments/line bounds, five protected SHA-256 comparisons (public asset, Worker, configuration, README and PDF), four receipt byte fixtures (326, 1862, 2048, 2049) and the positive-score bound 6325. Catalog extraction checked all fourteen boards for shape, overlap, bounds and exactly two empty cells; it did not rerun BFS. Twelve ordered work packets and absence of placeholders are checked separately at closeout. External URLs are attributed research references; HTTP availability and contents were not freshly tested here. Planned paths are prose rather than broken links to files that do not exist.

The historical body retains its original 24,155 characters and 255 lines, with only the four-line banner prepended; the prepend-only patch and body size/content inspection are the preservation evidence. A comparison against the Git index failed because that pre-existing document is untracked; no false index-comparison pass is claimed. Full git diff --check returned exit 2 solely for four pre-existing Markdown hard-break lines in that preserved historical body (now lines 7–10). They are intentionally not rewritten. New normative documents and the banner receive separate whitespace checks; final results are in the parent evidence handoff. Historical links in the superseded body are retained as source text, not certified active navigation.

The optional fitz page-count probe returned exit 1 (module absent); the full PDF extraction, including cover and numbered pages through 11, is the page-count basis. A final Python assertion initially expected exit 0 from git diff --no-index --check against an empty file; that expectation was incorrect because no-index reports exit 1 for a new-file difference even without whitespace diagnostics. The independent active-text whitespace check passed. No dependencies installed, PDF modified, agents spawned, memory persisted, implementation executed, chain transaction sent, or deployment/commit/push performed. Final porcelain status preserves the original deletion/untracked files and adds only the authorized task documents; the only edit to a pre-existing file is the historical banner. Application tests remain blocked by stale asset paths until future alignment.
