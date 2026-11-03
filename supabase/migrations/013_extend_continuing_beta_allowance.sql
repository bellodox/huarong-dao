-- Huarong Dao experimental continuing-beta publication allowance extension.
-- Run once in Supabase SQL Editor, AFTER migrations 001-012.
-- This intentionally extends an EXISTING authorized finite scope; it does not
-- install a new scope, alter publisher readiness, or reset anything already spent.
-- Do not apply to an unrelated Supabase project or a different scope ID.
-- Operational budget only: the actual WIF/chain balance and per-transaction checks
-- still constrain publication. Larger limits authorize more cumulative spending.
BEGIN;

DO $extend_beta_allowance$
DECLARE
  c public.hd1_coordinator%ROWTYPE;
  r public.hd1_runtime%ROWTYPE;
  h public.hd1_recovery%ROWTYPE;
  scope jsonb;
  expected_scope_id constant text := '48262ae3-4488-447c-950d-c5da7dcb9025';
BEGIN
  -- Match existing publisher lock ordering to avoid concurrent scope mutation.
  SELECT * INTO c FROM public.hd1_coordinator WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing_coordinator'; END IF;
  SELECT * INTO r FROM public.hd1_runtime WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing_runtime'; END IF;
  SELECT * INTO h FROM public.hd1_recovery WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing_recovery'; END IF;

  scope := r.finite_scope;
  IF scope IS NULL
    OR scope->>'id' IS DISTINCT FROM expected_scope_id
    OR scope->>'mode' IS DISTINCT FROM 'continuing_beta'
    OR scope->>'name' IS DISTINCT FROM 'g/huarong-lb'
    OR h.completion IS NULL
    OR h.completion->>'authority_id' IS DISTINCT FROM expected_scope_id
  THEN
    RAISE EXCEPTION 'unexpected_authority_or_incomplete_recovery';
  END IF;

  -- Abort while any job owns the state. Do not repair or alter readiness here.
  IF r.owner IS NOT NULL THEN
    RAISE EXCEPTION 'publisher_job_owner_present';
  END IF;

  -- Idempotent only for this known previous scope. Unexpected values must be
  -- examined rather than overwritten by this one-off operational migration.
  IF scope->>'max_transactions' NOT IN ('10', '1000')
    OR scope->>'max_broadcasts' NOT IN ('40', '4000')
    OR scope->>'max_fee_units' NOT IN ('1000000', '100000000')
    OR scope->>'max_new_locked_units' NOT IN ('6000', '600000')
  THEN
    RAISE EXCEPTION 'unexpected_existing_allowance';
  END IF;

  -- No-op if these exact limits were already installed; don't bump the
  -- runtime version unnecessarily on a repeated SQL Editor execution.
  IF scope->>'max_transactions' = '1000'
    AND scope->>'max_broadcasts' = '4000'
    AND scope->>'max_fee_units' = '100000000'
    AND scope->>'max_new_locked_units' = '600000'
  THEN
    RETURN;
  END IF;

  -- Keep the scope ID and all used counters, claims, reservations and journals.
  -- Only increase the four explicit maxima.
  UPDATE public.hd1_runtime
  SET finite_scope = finite_scope || jsonb_build_object(
      'max_transactions', 1000,
      'max_broadcasts', 4000,
      'max_fee_units', 100000000,
      'max_new_locked_units', 600000
    ),
    version = version + 1
  WHERE singleton;
END;
$extend_beta_allowance$;

-- Verify that the scope is the same and the consumed counters are unchanged.
SELECT
  finite_scope->>'id' AS publication_scope_id,
  finite_scope->>'mode' AS publication_scope_mode,
  (finite_scope->>'transactions')::bigint AS transactions_used,
  (finite_scope->>'max_transactions')::bigint AS transactions_allowed,
  (finite_scope->>'broadcasts')::bigint AS broadcasts_used,
  (finite_scope->>'max_broadcasts')::bigint AS broadcasts_allowed,
  (finite_scope->>'fee_units')::bigint AS fee_units_used,
  (finite_scope->>'max_fee_units')::bigint AS fee_units_allowed,
  (finite_scope->>'new_locked_units')::bigint AS locked_units_used,
  (finite_scope->>'max_new_locked_units')::bigint AS locked_units_allowed
FROM public.hd1_runtime WHERE singleton;
COMMIT;
