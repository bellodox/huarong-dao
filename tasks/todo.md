# Execution checklist — hd1-plan-2 design

Only [the normative plan](plan.md) defines contracts, acceptance criteria, files and verification. This file tracks execution, not a second specification. All implementation remains unchecked and unauthorized. Saving the plan does not satisfy human approval.

## Blocking decisions

- [ ] A0: Separate implementation authorization — [§10](plan.md#10-gates-verification-and-rollback).
- [ ] P1: Explicit capacity/eligibility policy decision and any approved plan revision — [§5](plan.md#p1-blocked-capacitypolicy-decision).
- [ ] E1 authorization: Restricted deployment to gather evidence, explicit chain, funds and broadcast permission (no prior live-success prerequisite) — [§10](plan.md#10-gates-verification-and-rollback).

## Ordered work and checkpoints

- [ ] T1: Public-asset local slice — [packet](plan.md#t1--local-game-loads-from-the-preserved-asset).
- [ ] T2: Remaining browser checks and verified local tooling — [packet](plan.md#t2--remaining-browser-regressions-can-run).
- [ ] C1: Local-only behavior and available runtime commands — [checkpoint](plan.md#t2--remaining-browser-regressions-can-run).
- [ ] T3: Replayable local evidence — [packet](plan.md#t3--a-local-completed-run-carries-replayable-evidence).
- [ ] T4: Complete signed player claim — [packet](plan.md#t4--a-wallet-signs-one-complete-portable-local-claim).
- [ ] C2: Independent vectors/replay; P1 resolved before activation — [checkpoint](plan.md#t4--a-wallet-signs-one-complete-portable-local-claim).
- [ ] T5: Independent Worker verification — [packet](plan.md#t5--worker-rejects-invalid-claims-without-public-side-effects).
- [ ] T6: Durable reservation — [packet](plan.md#t6--one-claim-survives-durable-reservation-and-restart).
- [ ] C3: Persistence/interleaving safety — [checkpoint](plan.md#t6--one-claim-survives-durable-reservation-and-restart).
- [ ] T7: Persisted signed transaction fixture — [packet](plan.md#t7--one-reserved-claim-becomes-a-persisted-signed-transaction-fixture).
- [ ] T8: Supabase derived ranking/index — [packet](plan.md#t8--supabase-serves-a-recoverable-derived-leaderboard).
- [ ] C4: Index recovery and credentials — [checkpoint](plan.md#t8--supabase-serves-a-recoverable-derived-leaderboard).
- [ ] T9: Independent historical reconstruction — [packet](plan.md#t9--independent-historical-reconstruction-survives-overwritereorg).
- [ ] T10: Authorized E1 experiment — [packet](plan.md#t10--authorized-e1-experiment-establishes-chain-feasibility).
- [ ] C5: E1 measured success, no source/fixture substitute — [checkpoint](plan.md#t10--authorized-e1-experiment-establishes-chain-feasibility).
- [ ] T11: In-game public flow — [packet](plan.md#t11--player-sees-the-confirmed-in-game-board).
- [ ] T12: Release evidence/reviews — [packet](plan.md#t12--release-decision-has-bounded-evidence-not-automatic-deployment).
- [ ] C6: Parent closeout; separate deployment authorization — [checkpoint](plan.md#t12--release-decision-has-bounded-evidence-not-automatic-deployment).

## Planning-only completion

Historical items below describe prior planning, not implementation. Parent-reported independent Code Reviewer verdict: APPROVE documentation reconciliation only, no issues/corrections; 101 active local links/fragments/line bounds checked with zero errors. This does not approve implementation, runtime safety, deployment or public use. Parent owns final task status; final OSG persistence is separately authorized.

- [x] No pre-existing task directory/incomplete plan overwritten.
- [x] Frozen design and dependency-sized packets saved; historical prior design retained.
- [x] Documentation validation and inherited whitespace-check limitation recorded in [§13](plan.md#13-planning-validation-record).
- [x] Parent handoff prepared with actual evidence and remaining gates; final authorized OSG persistence results are returned to the parent, not duplicated here.
