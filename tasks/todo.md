# Execution checklist — hd1-plan-3 design

## D5–D7 follow-up

The [combined delta](../docs/Huarong_Dao_MVP_Decision_Delta_2026-10-29-2.md) supersedes conflicting earlier requirements. Checked T1–T12 items below describe the prior local implementation, not automatic evidence for these additions. Current status remains in the [handoff](../tests/release-evidence.md#d7d6-current-local-scope).

- [ ] Freeze/publish numerical versioned ranked limits; align browser, authoritative verification, policy and reconstruction; test worst-case complete receipt bytes, boundaries and version mismatches. No ceiling is selected here.
- [x] Implement local one-confirmation reconciled successor eligibility with durable included state/retained lineage; six-confirmation rankings/twelve-confirmation close unchanged. Local validation and live limits are in the handoff.
- [x] Produce shared self-contained relay with thin Worker and direct non-listening Node CLI; executor-reported parity/offline/no-project-dependency probes are in the handoff.
- [ ] Test executable packaging when implemented; no executable distribution exists.
- [x] Write [Windows deployment guide](../docs/cloudflare-deployment.md) for disabled/static and optional read-only modes, migration order and rollback; no remote action performed.
- [x] Complete affected local implementation/validation and scoped final reviews; see the [authoritative closeout](../tests/release-evidence.md#d7d6-current-local-scope). E1, hosted validation and public-use gates remain open; no enablement is authorized.

The [normative plan](plan.md) defines the contracts. Later explicit user instructions authorize experimental implementation/local validation. This checklist distinguishes local evidence from unavailable live checks. **Current completion, review scope and remaining gaps are centralized in the [execution handoff](../tests/release-evidence.md)**; the parent owns final reviews and memory persistence.

## Blocking decisions

- [x] A0: Explicit experimental T1–T12 execution/local-validation authorization received; no production change, commit or push authorization.
- [x] P1 investigation: actual-path encoding and explicit final 2,048-byte publication bound tested and documented in the [plan status](plan.md#1-status-authority-and-scope). No arbitrary 1,536-action cap; unlimited local play retained. This is not human public-policy approval.
- [ ] E1 access: configured target chain, pinned bootstrap, disposable limited-funded app wallet, spend envelope and deployment/broadcast access are not established. No live experiment executed.

## Ordered work and checkpoints

Checked implementation items mean locally implemented and tested, not deployed; final scoped review evidence is linked in the handoff.

- [x] T1: Public asset/config alignment and initial QA paths.
- [x] T2/C1: All five QA paths, installed pinned local tooling and local-only regressions.
- [x] T3: Exact successful single-cell evidence, reset/assistance isolation and weekly-only candidate retention.
- [x] T4/C2 local: Player/app signatures, actual 1,536-move and exact-limit 1,722-move receipts; opt-in identity continuity.
- [x] T5: Independent Worker replay/derived points and pre-admission rejection tests.
- [x] T6/C3 local: SQL atomic decisions, fencing, signing barrier, immutable outbox and disk restart tests. Hosted PostgreSQL concurrent-session validation remains external.
- [x] T7: Register/update serialization and persisted-before-fetch/same-byte retries under fixture transport.
- [x] T8/C4 local: Server-only SQL boundary, atomic derived rebuild, journal retention and outage tests. Hosted Supabase/PostgREST not tested.
- [x] T9 local: Authenticated raw-history fixture reconstruction and independent Python oracle, boundary/reorg/external-spend tests.
- [ ] T10/C5 live: Blocked by absent configured/funded live experiment and unverified exhaustive history/header transport. Source/fixtures do not satisfy E1.
- [x] T11 local: Disabled production UI and EN/BG workerd fixture flow implemented/tested. Public-use gate remains closed.
- [x] T12/C6 local: Release evidence, rollback and scoped review closeout recorded in the [authoritative handoff](../tests/release-evidence.md); parent-authorized proxy records final persistence there. No deployment inferred.

## Planning-only completion

Historical items below describe prior planning, not implementation. Parent-reported independent Code Reviewer verdict: APPROVE documentation reconciliation only, no issues/corrections; 101 active local links/fragments/line bounds checked with zero errors. This does not approve implementation, runtime safety, deployment or public use. Parent owns final task status; final OSG persistence is separately authorized.

- [x] No pre-existing task directory/incomplete plan overwritten.
- [x] Frozen design and dependency-sized packets saved; historical prior design retained.
- [x] Documentation validation and inherited whitespace-check limitation recorded in [§13](plan.md#13-planning-validation-record).
- [x] Parent handoff prepared with actual evidence and remaining gates; final authorized OSG persistence results are returned to the parent, not duplicated here.
