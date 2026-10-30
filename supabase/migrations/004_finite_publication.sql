-- Finite experimental authority is durable operational state, not a scheduler lease.
-- Apply atomically after 003. Never reset signing journals, counters or exact raw bytes.
begin;
alter table public.hd1_runtime add column finite_scope jsonb;
alter function public.hd1_rpc(text,jsonb) rename to hd1_rpc_v3;
revoke all on function public.hd1_rpc_v3(text,jsonb) from public,anon,authenticated,service_role;
create function public.hd1_rpc(operation text,payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.hd1_coordinator%rowtype; r public.hd1_runtime%rowtype;
  q public.hd1_claims%rowtype; scope jsonb; plan jsonb; reservation jsonb; result jsonb;
  fee bigint; locked bigint; previous_name bigint;
begin
  -- Identical lock order to 003: scope installation, signing and cron cannot cross.
  select * into c from public.hd1_coordinator where singleton for update;
  select * into r from public.hd1_runtime where singleton for update;
  scope:=r.finite_scope;
  if operation='finite_open' then
    if scope is not null then return '{"code":"finite_scope_exists"}'; end if;
    if coalesce(payload->>'id','') !~ '^[a-f0-9-]{36}$' or payload->>'name' is distinct from 'g/huarong-lb' or
      jsonb_typeof(payload->'max_transactions') is distinct from 'number' or
      jsonb_typeof(payload->'max_fee_units') is distinct from 'number' or
      jsonb_typeof(payload->'max_new_locked_units') is distinct from 'number' or
      coalesce(payload->>'max_transactions','') !~ '^[1-4]$' or
      coalesce(payload->>'max_fee_units','') !~ '^[0-9]{1,6}$' or
      coalesce(payload->>'max_new_locked_units','') !~ '^[0-9]{1,7}$' then return '{"code":"invalid_scope"}'; end if;
    if (payload->>'max_fee_units')::bigint not between 1 and 100000 or
      (payload->>'max_new_locked_units')::bigint not between 0 and 1000600 then return '{"code":"invalid_scope"}'; end if;
    if r.owner is not null and r.expires>clock_timestamp() then return '{"code":"job_busy"}'; end if;
    -- Even an expired job can own irreversible signing. Never adopt any preexisting
    -- unsigned preparation, ambiguous signer or unconfirmed exact raw into this budget.
    if exists(select 1 from public.hd1_claims where state in
      ('unsigned_preparing','signing_started','signing_unknown') or
      raw is not null and state not in ('included','confirmed')) then return '{"code":"preexisting_publication"}'; end if;
    scope:=jsonb_build_object('id',payload->>'id','name',payload->>'name',
      'max_transactions',payload->'max_transactions','max_fee_units',payload->'max_fee_units',
      'max_new_locked_units',payload->'max_new_locked_units','transactions',0,'fee_units',0,
      'new_locked_units',0,'broadcasts',0,'reservations','{}'::jsonb,
      'claims',coalesce((select jsonb_agg(id order by evaluation_revision,id) from public.hd1_claims where state='queued' and raw is null),'[]'::jsonb));
    update public.hd1_runtime set finite_scope=scope where singleton;
    return scope;
  end if;
  if scope is not null and operation in ('job','prepare','begin','broadcast') then
    -- No automatic expiry, job_done, restart, initialize or ordinary cron lifts this fence.
    if payload->>'scope' is distinct from scope->>'id' then return '{"code":"finite_scope_required"}'; end if;
    if operation<>'job' and (r.owner is distinct from payload->>'job' or r.expires is null or r.expires<=clock_timestamp())
      then return '{"code":"stale_job"}'; end if;
    if operation in ('prepare','begin','broadcast') then
      select * into q from public.hd1_claims where id=payload->>'id' for update;
      if q.id is null or not (scope->'claims' ? q.id) then return '{"code":"claim_outside_scope"}'; end if;
      reservation:=scope->'reservations'->q.id;
      if operation='broadcast' then
        if reservation is null or reservation->>'generation' is distinct from q.generation::text then return '{"code":"claim_outside_scope"}'; end if;
        if (scope->>'broadcasts')::bigint >= (scope->>'max_transactions')::bigint then return '{"code":"broadcast_budget_exhausted"}'; end if;
      else
        plan:=case when operation='prepare' then payload->'prepared' else q.prepared end;
        if reservation is not null then return '{"code":"transaction_budget_exhausted"}'; end if;
        if (scope->>'transactions')::bigint >= (scope->>'max_transactions')::bigint then return '{"code":"transaction_budget_exhausted"}'; end if;
        if plan->>'operation' is null or plan->>'operation' not in ('register','update') or
          jsonb_typeof(plan->'fee') is distinct from 'number' or
          jsonb_typeof(plan->'markerAmount') is distinct from 'number' or
          jsonb_typeof(plan->'nameAmount') is distinct from 'number' or
          coalesce(plan->>'fee','') !~ '^[0-9]{1,6}$' or
          coalesce(plan->>'markerAmount','') !~ '^[0-9]{1,16}$' or
          coalesce(plan->>'nameAmount','') !~ '^[0-9]{1,16}$' or
          jsonb_typeof(plan->'inputs') is distinct from 'array' then return '{"code":"invalid_budget_plan"}'; end if;
        fee:=(plan->>'fee')::bigint;
        if fee not between 1 and 100000 or (plan->>'markerAmount')::bigint<600 or (plan->>'nameAmount')::bigint<1000000
          then return '{"code":"invalid_budget_plan"}'; end if;
        -- Carrying an existing name amount is not a new lock; any increase still is.
        previous_name:=0;
        if plan->>'operation'='update' then
          select coalesce(sum((i->>'amount')::bigint),0) into previous_name from jsonb_array_elements(plan->'inputs') i
            where i->>'script' ~ '^5[12]' and length(i->>'script')>50;
        end if;
        locked:=(plan->>'markerAmount')::bigint+greatest(0,(plan->>'nameAmount')::bigint-previous_name);
        if (scope->>'fee_units')::bigint+fee>(scope->>'max_fee_units')::bigint or
          (scope->>'new_locked_units')::bigint+locked>(scope->>'max_new_locked_units')::bigint then return '{"code":"spend_budget_exhausted"}'; end if;
      end if;
    end if;
  end if;
  result:=public.hd1_rpc_v3(operation,payload);
  if scope is not null and operation='begin' and result->>'state'='signing_started' then
    -- Same transaction as the non-expiring barrier. Ambiguous responses consume authority
    -- permanently, never sign again or refund it on lease expiry/reconciliation/cancellation.
    scope:=scope||jsonb_build_object('transactions',(scope->>'transactions')::bigint+1,
      'fee_units',(scope->>'fee_units')::bigint+fee,'new_locked_units',(scope->>'new_locked_units')::bigint+locked,
      'reservations',(scope->'reservations')||jsonb_build_object(q.id,jsonb_build_object(
        'generation',result->'generation','fee_units',fee,'new_locked_units',locked)));
    update public.hd1_runtime set finite_scope=scope where singleton;
  elsif scope is not null and operation='broadcast' and result->>'state'='broadcast_unknown' and result->>'raw' is not null then
    update public.hd1_runtime set finite_scope=jsonb_set(scope,'{broadcasts}',to_jsonb((scope->>'broadcasts')::bigint+1)) where singleton;
  end if;
  return result;
end $$;
revoke all on function public.hd1_rpc(text,jsonb) from public,anon,authenticated;
grant execute on function public.hd1_rpc(text,jsonb) to service_role;

-- Capability belongs to this migration, not a retroactive edit to deployed 003.
-- STABLE readiness remains journal-free and callable inside a read-only transaction.
alter function public.hd1_public(text,jsonb) rename to hd1_public_v3;
revoke all on function public.hd1_public_v3(text,jsonb) from public,anon,authenticated,service_role;
create function public.hd1_public(operation text,payload jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  result:=public.hd1_public_v3(operation,payload);
  if operation='readiness' then return result||'{"capability_revision":4}'::jsonb; end if;
  return result;
end $$;
revoke all on function public.hd1_public(text,jsonb) from public,anon,authenticated;
grant execute on function public.hd1_public(text,jsonb) to service_role;
commit;
