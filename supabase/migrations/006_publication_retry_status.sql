-- Additive read-only status repair; never changes finite authority or signed journals.
-- Apply after existing 005, atomically. No diagnostic payload persistence is added.
begin;
create or replace function public.hd1_public_status(q public.hd1_claims) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare scope jsonb; retryable boolean; retry_code text;
begin
  retryable:=q.state in ('queued','broadcast_unknown','broadcast_pending');
  if retryable and q.attempts>=4 then retry_code:='retry_exhausted'; end if;
  select r.finite_scope into scope from public.hd1_runtime r where r.singleton;
  if retryable and scope is not null then
    if not (scope->'claims' ? q.id) then retry_code:='claim_outside_scope';
    elsif q.raw is not null then
      if scope->'reservations'->q.id->>'generation' is distinct from q.generation::text then retry_code:='claim_outside_scope';
      elsif (scope->>'broadcasts')::bigint >= (scope->>'max_transactions')::bigint then retry_code:='broadcast_budget_exhausted'; end if;
    elsif (scope->>'transactions')::bigint >= (scope->>'max_transactions')::bigint then retry_code:='transaction_budget_exhausted';
    -- Every unsigned publication needs at least the mandatory 600-unit marker output.
    elsif (scope->>'fee_units')::bigint >= (scope->>'max_fee_units')::bigint
      or (scope->>'max_new_locked_units')::bigint - (scope->>'new_locked_units')::bigint < 600
      then retry_code:='spend_budget_exhausted'; end if;
  end if;
  return jsonb_build_object('status',case when q.state in ('signing_started','signing_unknown') then 'signing_unknown' else q.state end,
    'receipt_id',q.id,'code',q.state,'retryable',retryable,
    'publication_retryable',retryable and retry_code is null,'retry_code',retry_code,
    'provisional_epoch',q.epoch,'actual_epoch',q.actual_epoch,'txid',q.txid,
    'confirmations',q.confirmations,'derived_moves',q.moves,'derived_points',q.points);
end $$;
revoke all on function public.hd1_public_status(public.hd1_claims) from public,anon,authenticated,service_role;
commit;
