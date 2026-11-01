-- Experimental completion and a separately bounded, server-resolved beta window.
-- Apply atomically after 008. Never reset or rewrite either exact transaction journal.
begin;
alter table public.hd1_recovery add column completion jsonb;

-- This exemption names one archived original, never an arbitrary failed transaction.
create function public.hd1_completed_original(candidate text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.hd1_recovery where original_id=candidate and completion is not null)
$$;
revoke all on function public.hd1_completed_original(text) from public,anon,authenticated,service_role;

-- Preserve the deployed implementations; amend only the exact inherited guard sites.
do $migration$
declare definition text; needle text;
begin
  definition:=pg_get_functiondef('public.hd1_rpc_v2(text,jsonb)'::regprocedure);
  needle:='where state=any(unreconciled)';
  if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>2 then raise exception 'unexpected_rebuild_guards'; end if;
  definition:=replace(definition,needle,needle||' and not public.hd1_completed_original(id)');
  needle:='state<>all(released)';
  if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>3 then raise exception 'unexpected_reservation_guards'; end if;
  definition:=replace(definition,needle,needle||' and not public.hd1_completed_original(id)');
  execute definition;

  definition:=pg_get_functiondef('public.hd1_rpc_v6(text,jsonb)'::regprocedure);
  needle:='(scope->>''broadcasts'')::bigint >= (scope->>''max_transactions'')::bigint';
  if strpos(definition,needle)=0 then raise exception 'unexpected_finite_guard'; end if;
  definition:=replace(definition,needle,'(scope->>''broadcasts'')::bigint >= coalesce(scope->>''max_broadcasts'',scope->>''max_transactions'')::bigint');
  execute definition;

  definition:=pg_get_functiondef('public.hd1_rpc(text,jsonb)'::regprocedure);
  needle:='if h.id is not null and operation in (''job'',''prepare'',''begin'',''broadcast'',''cancel'') then';
  if strpos(definition,needle)=0 then raise exception 'unexpected_recovery_fence'; end if;
  definition:=replace(definition,needle,'if h.id is not null and h.completion is null and operation in (''job'',''prepare'',''begin'',''broadcast'',''cancel'') then');
  execute definition;

  definition:=pg_get_functiondef('public.hd1_public_v2(text,jsonb)'::regprocedure);
  needle:='where state not in (''confirmed'',''not_improved'',''cancelled'',''rejected'',''epoch_changed'') order by id limit 20';
  if strpos(definition,needle)=0 then raise exception 'unexpected_pending_projection'; end if;
  definition:=replace(definition,needle,'where state not in (''confirmed'',''not_improved'',''cancelled'',''rejected'',''epoch_changed'') and not public.hd1_completed_original(id) order by id limit 20');
  execute definition;

  definition:=pg_get_functiondef('public.hd1_public_status_v6(public.hd1_claims)'::regprocedure);
  needle:='(scope->>''broadcasts'')::bigint >= (scope->>''max_transactions'')::bigint';
  if strpos(definition,needle)=0 then raise exception 'unexpected_retry_projection'; end if;
  definition:=replace(definition,needle,'(scope->>''broadcasts'')::bigint >= coalesce(scope->>''max_broadcasts'',scope->>''max_transactions'')::bigint');
  execute definition;

  definition:=pg_get_functiondef('public.hd1_recovery_read(text,jsonb)'::regprocedure);
  needle:='''scope_id'',r.finite_scope->>''id''';
  if strpos(definition,needle)=0 then raise exception 'unexpected_raw_export'; end if;
  definition:=replace(definition,needle,'''scope_id'',case when public.hd1_completed_original(exact.id) then (select completion->''original_scope''->>''id'' from public.hd1_recovery where singleton) else r.finite_scope->>''id'' end');
  execute definition;
end $migration$;

alter function public.hd1_rpc(text,jsonb) rename to hd1_rpc_v8;
revoke all on function public.hd1_rpc_v8(text,jsonb) from public,anon,authenticated,service_role;
create function public.hd1_rpc(operation text,payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.hd1_coordinator%rowtype; r public.hd1_runtime%rowtype;
  h public.hd1_recovery%rowtype; q public.hd1_claims%rowtype;
  scope jsonb; result jsonb; plan jsonb; canonical public.hd1_receipts%rowtype;
begin
  select * into c from public.hd1_coordinator where singleton for update;
  select * into r from public.hd1_runtime where singleton for update;
  select * into h from public.hd1_recovery where singleton for update;
  scope:=r.finite_scope;
  if operation='recovery_complete' then
    if h.id is null or payload->>'recovery' is distinct from h.id then return '{"code":"recovery_mismatch"}'; end if;
    if h.completion is not null then
      if payload->>'authority_id' is distinct from h.completion->>'authority_id' then return '{"code":"completion_exists"}'; end if;
      return jsonb_build_object('code','recovery_completed','authority',scope-'claims'-'reservations');
    end if;
    if r.owner is not null and r.expires>clock_timestamp() then return '{"code":"job_busy"}'; end if;
    if c.revision is distinct from (payload->>'revision')::bigint or r.version is distinct from (payload->>'version')::bigint or
      h.revision is distinct from (payload->>'recovery_revision')::bigint or payload->>'tip_hash' is distinct from c.snapshot->>'hash'
      then return '{"code":"stale_state"}'; end if;
    select * into q from public.hd1_claims where id=h.original_id for update;
    select * into canonical from public.hd1_receipts where txid=h.attempt->>'txid' and id=q.id limit 1;
    if q.id is null or payload->>'original_txid' is distinct from q.txid or
      payload->>'replacement_txid' is distinct from h.attempt->>'txid' or
      payload->>'scope_id' is distinct from scope->>'id' or scope->>'id' is distinct from h.envelope->>'scope_id' or
      h.envelope->>'original_txid' is distinct from q.txid or h.envelope->>'generation' is distinct from q.generation::text or
      scope->'reservations'->q.id->>'generation' is distinct from q.generation::text or
      q.state is distinct from 'conflicted' or q.raw is null or h.attempt->>'raw' is null or
      h.status is distinct from 'confirmed' or h.attempt->>'state' is distinct from 'confirmed' or
      h.transactions<>1 or h.broadcasts<1 or h.proof is null or
      (scope->>'transactions')::bigint is distinct from (scope->>'max_transactions')::bigint or
      (scope->>'broadcasts')::bigint is distinct from (scope->>'max_transactions')::bigint or
      r.bootstrap is distinct from q.txid or h.effective_bootstrap is distinct from h.attempt->>'txid' or
      canonical.txid is null or canonical.receipt is distinct from h.attempt->>'receipt' or
      (c.snapshot->>'height')::bigint-canonical.height+1<6 or (h.attempt->>'confirmations')::bigint<6 or
      not r.ready or c.paused or c.active is not null or coalesce((c.snapshot->>'stale')::boolean,true) or
      r.code<>'ready' or r.checked_at is null or r.checked_at<=clock_timestamp()-interval '3 minutes' or
      h.checked_hash is distinct from c.snapshot->>'hash' or
      r.document->'headers'->-1->>'hash' is distinct from c.snapshot->>'hash' or
      jsonb_array_length(coalesce(c.snapshot->'reorgedLineage','[]'::jsonb))<>0 or
      not exists(select 1 from jsonb_array_elements(c.snapshot->'lineage') i where i->>'txid'=canonical.txid) or
      exists(select 1 from jsonb_array_elements(c.snapshot->'lineage') i where i->>'txid'=q.txid) or
      exists(select 1 from public.hd1_claims where id<>q.id and state in
        ('unsigned_preparing','signing_started','signing_unknown','signed_persisted','broadcast_unknown','broadcast_pending','observed_unconfirmed','reorged','conflicted','failed_closed'))
      then return '{"code":"completion_preconditions_failed"}'; end if;
    -- One fixed, separately authorized window. Repetition can neither reset nor widen it.
    if coalesce(payload->>'authority_id','') !~ '^[a-f0-9-]{36}$' or payload->>'authority_id' in (h.id,scope->>'id') or
      payload->'max_transactions' is distinct from '10'::jsonb or payload->'max_broadcasts' is distinct from '40'::jsonb or
      payload->'max_fee_units' is distinct from '1000000'::jsonb or payload->'max_new_locked_units' is distinct from '6000'::jsonb
      then return '{"code":"invalid_continuing_authority"}'; end if;
    update public.hd1_recovery set completion=jsonb_build_object('authority_id',payload->>'authority_id',
      'completed_at',clock_timestamp(),'original_scope',scope,'recovery_revision',h.revision,'runtime_version',r.version,
      'coordinator_revision',c.revision,'tip_hash',c.snapshot->>'hash','height',c.snapshot->'height',
      'replacement_txid',canonical.txid,'confirmations',(c.snapshot->>'height')::bigint-canonical.height+1),
      status='completed',revision=revision+1 where id=h.id;
    scope:=jsonb_build_object('id',payload->>'authority_id','mode','continuing_beta','name','g/huarong-lb',
      'max_transactions',10,'max_broadcasts',40,'max_fee_units',1000000,'max_new_locked_units',6000,
      'transactions',0,'broadcasts',0,'fee_units',0,'new_locked_units',0,'reservations','{}'::jsonb,
      'claims',coalesce((select jsonb_agg(id order by evaluation_revision,id) from public.hd1_claims where state='queued' and raw is null),'[]'::jsonb));
    update public.hd1_runtime set finite_scope=scope,version=version+1 where singleton;
    update public.hd1_coordinator set revision=revision+1 where singleton;
    return jsonb_build_object('code','recovery_completed','authority',scope-'claims'-'reservations');
  end if;
  if h.completion is not null then
    if (operation like 'recovery_%' and operation<>'recovery_inspect') or payload->>'recovery' is not null then
      return '{"code":"recovery_completed"}';
    end if;
    if operation='finite_open' then return '{"code":"finite_scope_exists"}'; end if;
    if operation in ('prepare','begin','finalize','broadcast','cancel') and payload->>'id'=h.original_id then
      return '{"code":"retired_original"}';
    end if;
    if operation='finalize' and payload->>'txid' in (h.envelope->>'original_txid',h.attempt->>'txid') then
      return '{"code":"retired_transaction"}';
    end if;
    if operation in ('job','prepare','begin','broadcast','admit') then
      if scope->>'id' is distinct from h.completion->>'authority_id' or scope->>'mode' is distinct from 'continuing_beta'
        then return '{"code":"continuing_authority_mismatch"}'; end if;
      if payload->>'scope' is not null and payload->>'scope' is distinct from scope->>'id' then return '{"code":"finite_scope_required"}'; end if;
      payload:=payload||jsonb_build_object('scope',scope->>'id');
    end if;
    if operation in ('prepare','begin') then
      select * into q from public.hd1_claims where id=payload->>'id' for update;
      plan:=case when operation='prepare' then payload->'prepared' else q.prepared end;
      -- Continuing authority carries the existing name, never registers/transfers or adds name value.
      if c.head is null or plan->>'operation' is distinct from 'update' or
        plan->'markerAmount' is distinct from '600'::jsonb or jsonb_typeof(plan->'inputs') is distinct from 'array' then
        return '{"code":"invalid_budget_plan"}';
      end if;
      if jsonb_array_length(plan->'inputs') not between 1 and 10 or
        (select count(*) from jsonb_array_elements(plan->'inputs') i where (i->>'txid')||':'||(i->>'index')=c.head)<>1 or
        not exists(select 1 from jsonb_array_elements(plan->'inputs') i where (i->>'txid')||':'||(i->>'index')=c.head and i->'amount'=plan->'nameAmount') then
        return '{"code":"invalid_budget_plan"}';
      end if;
    end if;
    if operation in ('synchronize','rebuild') and (
      not exists(select 1 from jsonb_array_elements(coalesce(payload->'snapshot'->'receipts','[]'::jsonb)) i where i->>'txid'=h.completion->>'replacement_txid') or
      not exists(select 1 from jsonb_array_elements(coalesce(payload->'snapshot'->'lineage','[]'::jsonb)) i where i->>'txid'=h.completion->>'replacement_txid') or
      exists(select 1 from jsonb_array_elements(coalesce(payload->'snapshot'->'lineage','[]'::jsonb)) i where i->>'txid'=h.envelope->>'original_txid')) then
      return public.hd1_rpc_v8('job_error',jsonb_build_object('job',payload->>'job','code','reorg_detected'));
    end if;
  end if;
  result:=public.hd1_rpc_v8(operation,payload);
  if h.completion is not null and operation='admit' and result->>'state'='queued' and result->>'raw' is null and
    not (scope->'claims' ? (result->>'id')) then
    update public.hd1_runtime set finite_scope=jsonb_set(scope,'{claims}',scope->'claims'||jsonb_build_array(result->>'id')) where singleton;
  end if;
  return result;
end $$;
revoke all on function public.hd1_rpc(text,jsonb) from public,anon,authenticated;
grant execute on function public.hd1_rpc(text,jsonb) to service_role;

alter function public.hd1_public(text,jsonb) rename to hd1_public_v8;
revoke all on function public.hd1_public_v8(text,jsonb) from public,anon,authenticated,service_role;
create function public.hd1_public(operation text,payload jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; h public.hd1_recovery%rowtype; scope jsonb; budget_code text;
begin
  select * into h from public.hd1_recovery where singleton;
  if operation='readiness' and h.completion is not null then
    -- Use the real readiness/freshness/identity computation, not an availability override.
    result:=public.hd1_public_v6(operation,payload)||jsonb_build_object('recovery_capability_revision',7,
      'completion_capability_revision',9,'recovery_required',false,'bootstrap_txid',h.effective_bootstrap);
    select finite_scope into scope from public.hd1_runtime where singleton;
    if scope->>'id' is distinct from h.completion->>'authority_id' or scope->>'mode' is distinct from 'continuing_beta' then
      budget_code:='continuing_authority_mismatch';
    elsif (scope->>'transactions')::bigint>=(scope->>'max_transactions')::bigint then budget_code:='transaction_budget_exhausted';
    elsif (scope->>'broadcasts')::bigint>=(scope->>'max_broadcasts')::bigint then budget_code:='broadcast_budget_exhausted';
    elsif (scope->>'fee_units')::bigint>=(scope->>'max_fee_units')::bigint or
      (scope->>'max_new_locked_units')::bigint-(scope->>'new_locked_units')::bigint<600 then budget_code:='spend_budget_exhausted'; end if;
    if budget_code is not null then result:=result||jsonb_build_object('available',false,'code',budget_code); end if;
    return result;
  end if;
  return public.hd1_public_v8(operation,payload);
end $$;
revoke all on function public.hd1_public(text,jsonb) from public,anon,authenticated;
grant execute on function public.hd1_public(text,jsonb) to service_role;
comment on function public.hd1_rpc(text,jsonb) is '009: exact confirmed recovery completion; archived original authority; separately capped server-resolved continuing beta authority';
commit;
