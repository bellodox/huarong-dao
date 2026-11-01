-- Experimental, service-only positive-conflict recovery. Apply atomically after 006.
-- Never rewrite the original claim, raw outbox, bootstrap pin or finite authority.
begin;
create table public.hd1_recovery (
  id text primary key check(id ~ '^[a-f0-9-]{36}$'),
  singleton boolean not null unique default true check(singleton),
  original_id text not null unique references public.hd1_claims(id),
  envelope jsonb not null, proof jsonb, attempt jsonb not null,
  status text not null default 'recovery_frozen', revision bigint not null default 0,
  transactions integer not null default 0 check(transactions between 0 and 1),
  broadcasts integer not null default 0 check(broadcasts between 0 and 4),
  fee_units bigint not null default 0, new_locked_units bigint not null default 0,
  effective_bootstrap text, checked_hash text
);
alter table public.hd1_recovery enable row level security;
revoke all on public.hd1_recovery from public,anon,authenticated,service_role;
alter function public.hd1_rpc(text,jsonb) rename to hd1_rpc_v6;
revoke all on function public.hd1_rpc_v6(text,jsonb) from public,anon,authenticated,service_role;
create function public.hd1_rpc(operation text,payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.hd1_coordinator%rowtype; r public.hd1_runtime%rowtype;
  h public.hd1_recovery%rowtype; q public.hd1_claims%rowtype;
  a jsonb; result jsonb; plan jsonb; retirement_proof jsonb; fee bigint; locked bigint;
  lifetime integer; weekly integer; valid_job boolean; included jsonb;
begin
  select * into c from public.hd1_coordinator where singleton for update;
  select * into r from public.hd1_runtime where singleton for update;
  select * into h from public.hd1_recovery where singleton for update;
  valid_job:=r.owner is not null and r.owner=payload->>'job' and r.expires>clock_timestamp();
  if operation='recovery_inspect' then return to_jsonb(h); end if;
  if operation='recovery_install' then
    if h.id is not null then
      if h.id=payload->>'id' and h.envelope=payload then return to_jsonb(h); end if;
      return '{"code":"recovery_exists"}';
    end if;
    if r.owner is not null and r.expires>clock_timestamp() then return '{"code":"job_busy"}'; end if;
    select * into q from public.hd1_claims where id=payload->>'claim_id' for update;
    if q.id is null or coalesce(payload->>'id','') !~ '^[a-f0-9-]{36}$' or
      payload->>'scope_id' is distinct from r.finite_scope->>'id' or r.finite_scope is null or
      not (r.finite_scope->'claims' ? q.id) or q.raw is null or
      payload->>'original_txid' is distinct from q.txid or
      payload->>'generation' is distinct from q.generation::text or
      r.finite_scope->'reservations'->q.id->>'generation' is distinct from q.generation::text or
      q.state not in ('signed_persisted','broadcast_unknown','broadcast_pending','conflicted','failed_closed') or
      coalesce(payload->>'conflict_txid','') !~ '^[a-f0-9]{64}$' or payload->>'conflict_txid'=q.txid or
      payload->>'consent_claim' is distinct from q.id or payload->>'name' is distinct from 'g/huarong-lb' or
      payload->>'max_signings' is distinct from '1' or
      jsonb_typeof(payload->'max_broadcasts') is distinct from 'number' or coalesce(payload->>'max_broadcasts','') !~ '^[1-4]$' or
      jsonb_typeof(payload->'max_fee_units') is distinct from 'number' or coalesce(payload->>'max_fee_units','') !~ '^[0-9]{1,6}$' or
      jsonb_typeof(payload->'max_new_locked_units') is distinct from 'number' or coalesce(payload->>'max_new_locked_units','') !~ '^[0-9]{1,7}$'
      then return '{"code":"invalid_recovery"}'; end if;
    if (payload->>'max_fee_units')::bigint not between 1 and 100000 or
      (payload->>'max_new_locked_units')::bigint not between 0 and 1000600 then return '{"code":"invalid_recovery"}'; end if;
    if exists(select 1 from public.hd1_claims where id<>q.id and state in
      ('unsigned_preparing','signing_started','signing_unknown','signed_persisted','broadcast_unknown','broadcast_pending','observed_unconfirmed','reorged','conflicted','failed_closed'))
      then return '{"code":"preexisting_publication"}'; end if;
    a:=to_jsonb(q)||jsonb_build_object('state','queued','owner',null,'generation',null,'prepared',null,'raw',null,'txid',null,
      'receipt',null,'attempts',0,'retry_at',null,'expires',null,'confirmations',0,'actual_epoch',null);
    insert into public.hd1_recovery(id,original_id,envelope,attempt) values(payload->>'id',q.id,payload,a) returning * into h;
    update public.hd1_runtime set ready=false,code='recovery_frozen' where singleton;
    update public.hd1_coordinator set paused=true,revision=revision+1 where singleton;
    return to_jsonb(h);
  end if;
  -- A recovery installation is an enduring fence, including after inclusion or failure.
  -- Ordinary cron and the original scope cannot reactivate either exact spend.
  if h.id is not null and operation in ('job','prepare','begin','broadcast','cancel') then
    if operation<>'job' or payload->>'recovery' is distinct from h.id then return '{"code":"recovery_required"}'; end if;
  end if;
  if operation like 'recovery_%' then
    if h.id is null or payload->>'recovery' is distinct from h.id or payload->>'scope' is distinct from h.envelope->>'scope_id'
      then return '{"code":"recovery_mismatch"}'; end if;
    if not coalesce(valid_job,false) then return '{"code":"stale_job"}'; end if;
    select * into q from public.hd1_claims where id=h.original_id for update;
    a:=h.attempt;
    if operation='recovery_original_included' then
      if not exists(select 1 from jsonb_array_elements(coalesce(c.snapshot->'lineage','[]'::jsonb)) i where i->>'txid'=q.txid)
        then return '{"code":"reconciliation_required"}'; end if;
      update public.hd1_recovery set status='original_included',revision=revision+1 where id=h.id returning * into h;
      return to_jsonb(h);
    end if;
    if operation='recovery_pause' then
      update public.hd1_recovery set status=case when payload->>'code' in
        ('recovery_proof_reorg','recovery_frozen','signing_unknown','epoch_changed','not_improved','recovery_history_bound')
        then payload->>'code' else 'recovery_frozen' end,checked_hash=null,revision=revision+1 where id=h.id returning * into h;
      update public.hd1_runtime set ready=false,code=h.status where singleton;
      update public.hd1_coordinator set paused=true where singleton;
      return to_jsonb(h);
    end if;
    if operation='recovery_prove' then
      if h.revision is distinct from (payload->>'recovery_revision')::bigint then return '{"code":"stale_state"}'; end if;
      retirement_proof:=payload->'proof';
      if retirement_proof->>'original_txid' is distinct from q.txid or retirement_proof->>'conflict_txid' is distinct from h.envelope->>'conflict_txid' or
        coalesce(retirement_proof->>'raw','') !~ '^([a-f0-9]{2})+$' or coalesce(retirement_proof->>'block_hash','') !~ '^[a-f0-9]{64}$' or
        coalesce(payload->>'confirmations','') !~ '^[0-9]{1,9}$' or (payload->>'confirmations')::integer<6 or
        coalesce(payload->>'tip_hash','') !~ '^[a-f0-9]{64}$' or
        not exists(select 1 from jsonb_array_elements(q.prepared->'inputs') i where
          i->>'txid'=retirement_proof->'input'->>'txid' and i->'index'=retirement_proof->'input'->'index') then return '{"code":"invalid_retirement_proof"}'; end if;
      if h.proof is not null and h.proof is distinct from retirement_proof then return '{"code":"recovery_proof_reorg"}'; end if;
      if exists(select 1 from jsonb_array_elements(coalesce(c.snapshot->'lineage','[]'::jsonb)) i where i->>'txid'=q.txid)
        then return '{"code":"original_included"}'; end if;
      update public.hd1_recovery set proof=coalesce(h.proof,retirement_proof),checked_hash=payload->>'tip_hash',
        status=case when status in ('included','confirmed') then status else 'retired' end,revision=revision+1 where id=h.id returning * into h;
      return to_jsonb(h);
    end if;
    if operation='recovery_synchronize' then
      if h.proof is null or h.checked_hash is distinct from payload->'snapshot'->>'hash' or
        c.revision is distinct from (payload->>'revision')::bigint or r.version is distinct from (payload->>'version')::bigint
        then return '{"code":"stale_state"}'; end if;
      result:=public.hd1_rpc_v6('synchronize',payload);
      if result ? 'code' and not (result ? 'version') then return result; end if;
      select value into included from jsonb_array_elements(coalesce(payload->'snapshot'->'receipts','[]'::jsonb)||
        coalesce(payload->'snapshot'->'pending','[]'::jsonb)) where value->>'txid'=a->>'txid';
      if included is not null then
        a:=a||jsonb_build_object('state',case when (payload->'snapshot'->>'height')::bigint-(included->>'height')::bigint+1>=6 then 'confirmed' else 'included' end,
          'confirmations',(payload->'snapshot'->>'height')::bigint-(included->>'height')::bigint+1,'actual_epoch',included->'epoch');
      elsif a->>'state' in ('included','confirmed','reorged') then
        a:=a||'{"state":"reorged","confirmations":0}'::jsonb;
      end if;
      update public.hd1_recovery set attempt=a,status=case when a->>'state' in ('included','confirmed','reorged') then a->>'state' else 'retired' end,
        revision=revision+1 where id=h.id returning * into h;
      -- Only the positively retired original is exempted. No other reorg/barrier is cleared.
      update public.hd1_coordinator set paused=a->>'state'='reorged' or
        jsonb_array_length(coalesce(snapshot->'reorgedLineage','[]'::jsonb))>0 or
        exists(select 1 from public.hd1_claims where id<>q.id and state in ('reorged','conflicted','failed_closed')),
        active=case when a->>'state' in ('included','confirmed') then null else q.id end where singleton returning * into c;
      update public.hd1_runtime set ready=not c.paused,code=case when c.paused then 'reconciliation_required' else 'ready' end
        where singleton returning * into r;
      return to_jsonb(r)||jsonb_build_object('recovery',to_jsonb(h),'effective_bootstrap',coalesce(h.effective_bootstrap,r.bootstrap));
    end if;
    if operation in ('recovery_prepare','recovery_begin','recovery_broadcast') then
      if h.proof is null or h.checked_hash is distinct from c.snapshot->>'hash' or c.paused or h.status not in ('retired','included','confirmed')
        then return '{"code":"recovery_frozen"}'; end if;
      if payload->>'id' is distinct from q.id then return '{"code":"recovery_mismatch"}'; end if;
      if exists(select 1 from jsonb_array_elements(coalesce(c.snapshot->'lineage','[]'::jsonb)) i where i->>'txid'=q.txid)
        then return '{"code":"original_included"}'; end if;
    end if;
    if operation in ('recovery_prepare','recovery_begin') then
      if h.transactions>=1 then return '{"code":"transaction_budget_exhausted"}'; end if;
      if q.epoch<>c.epoch or (payload->>'epoch')::bigint is distinct from c.epoch then return '{"code":"epoch_changed"}'; end if;
      if payload->>'head' is distinct from c.head or (payload->>'revision')::bigint is distinct from c.revision then return '{"code":"stale_state"}'; end if;
      if exists(select 1 from public.hd1_claims where id<>q.id and state in
        ('signing_started','signing_unknown','signed_persisted','broadcast_unknown','broadcast_pending','observed_unconfirmed','reorged','conflicted','failed_closed'))
        then return '{"code":"signer_busy"}'; end if;
      select min(moves),min(moves) filter(where epoch=c.epoch) into lifetime,weekly from (
        select moves,epoch from public.hd1_receipts where player=q.player and layout=q.layout
        union all select p.moves,p.epoch from jsonb_to_recordset(coalesce(c.snapshot->'pending','[]'::jsonb)) as p(player text,layout text,moves integer,epoch bigint)
          where p.player=q.player and p.layout=q.layout
        union all select moves,coalesce(actual_epoch,epoch) from public.hd1_claims where id<>q.id and player=q.player and layout=q.layout
          and state not in ('not_improved','cancelled','epoch_changed','rejected','confirmed')
      ) bests;
      if not(q.moves<coalesce(lifetime,2147483647) or q.moves<coalesce(weekly,2147483647)) then return '{"code":"not_improved"}'; end if;
      plan:=case when operation='recovery_prepare' then payload->'prepared' else a->'prepared' end;
      if jsonb_typeof(plan->'inputs') is distinct from 'array' or jsonb_array_length(plan->'inputs') not between 1 and 10 or
        coalesce(plan->>'fee','') !~ '^[0-9]{1,6}$' or coalesce(plan->>'markerAmount','') !~ '^[0-9]{1,7}$' or
        coalesce(plan->>'nameAmount','') !~ '^[0-9]{1,16}$' or
        (c.head is null and plan->>'operation' is distinct from 'register') or
        (c.head is not null and (plan->>'operation' is distinct from 'update' or not exists(select 1 from jsonb_array_elements(plan->'inputs') i where
          (i->>'txid')||':'||(i->>'index')=c.head))) or
        exists(select 1 from jsonb_array_elements(plan->'inputs') i where i->>'txid'=h.proof->'input'->>'txid' and i->'index'=h.proof->'input'->'index')
        then return '{"code":"invalid_budget_plan"}'; end if;
      fee:=(plan->>'fee')::bigint;
      locked:=(plan->>'markerAmount')::bigint+greatest(0,(plan->>'nameAmount')::bigint-coalesce((
        select sum((i->>'amount')::bigint) from jsonb_array_elements(plan->'inputs') i where (i->>'txid')||':'||(i->>'index')=c.head),0));
      if fee not between 1 and 100000 or (plan->>'markerAmount')::bigint<600 or (plan->>'nameAmount')::bigint<1000000
        then return '{"code":"invalid_budget_plan"}'; end if;
      if fee>(h.envelope->>'max_fee_units')::bigint or locked>(h.envelope->>'max_new_locked_units')::bigint
        then return '{"code":"spend_budget_exhausted"}'; end if;
    end if;
    if operation='recovery_prepare' then
      if a->>'state' not in ('queued','unsigned_preparing') then return '{"code":"barrier_locked"}'; end if;
      if a->>'state'='unsigned_preparing' and (a->>'expires')::timestamptz>clock_timestamp() then return '{"code":"signer_busy"}'; end if;
      if coalesce(length(payload->>'owner'),0) not between 1 and 64 then return '{"code":"stale_owner"}'; end if;
      update public.hd1_coordinator set active=q.id,generation=generation+1,revision=revision+1 where singleton returning * into c;
      a:=a||jsonb_build_object('state','unsigned_preparing','owner',payload->>'owner','generation',c.generation,'prepared',plan,
        'evaluation_revision',c.revision,'expires',clock_timestamp()+interval '30 seconds');
    elsif operation in ('recovery_begin','recovery_finalize','recovery_broadcast') then
      if a->>'owner' is distinct from payload->>'owner' or a->>'generation' is distinct from payload->>'generation' then return '{"code":"stale_owner"}'; end if;
      if operation='recovery_begin' then
        if a->>'state'<>'unsigned_preparing' or (a->>'expires')::timestamptz<=clock_timestamp() then return '{"code":"barrier_locked"}'; end if;
        if payload->'prepared' is distinct from a->'prepared' then return '{"code":"stale_state"}'; end if;
        a:=a||'{"state":"signing_started","expires":null}'::jsonb;
        update public.hd1_recovery set transactions=1,fee_units=fee,new_locked_units=locked where id=h.id;
      elsif operation='recovery_finalize' then
        if a->>'raw' is not null then
          if a->>'raw' is distinct from payload->>'raw' or a->>'txid' is distinct from payload->>'txid' or a->>'receipt' is distinct from payload->>'receipt'
            then return '{"code":"idempotency_conflict"}'; end if;
          return a;
        end if;
        if a->>'state'<>'signing_started' then return '{"code":"barrier_locked"}'; end if;
        if coalesce(payload->>'raw','') !~ '^([a-f0-9]{2})+$' or length(payload->>'raw')>=20000 or
          coalesce(payload->>'txid','') !~ '^[a-f0-9]{64}$' or payload->>'receipt' is distinct from q.receipt then return '{"code":"malformed"}'; end if;
        a:=a||jsonb_build_object('raw',payload->>'raw','txid',payload->>'txid','receipt',payload->>'receipt','state','signed_persisted','retry_at',clock_timestamp());
        if a->'prepared'->>'operation'='register' then
          if r.bootstrap is distinct from q.txid or r.bootstrap_claim is distinct from q.id then raise exception 'bootstrap_conflict'; end if;
          update public.hd1_recovery set effective_bootstrap=payload->>'txid' where id=h.id;
        end if;
      else
        if a->>'raw' is null or a->>'state' not in ('signed_persisted','broadcast_unknown','broadcast_pending') then return '{"code":"barrier_locked"}'; end if;
        if h.broadcasts>=(h.envelope->>'max_broadcasts')::integer then return '{"code":"broadcast_budget_exhausted"}'; end if;
        if (a->>'retry_at')::timestamptz>clock_timestamp() then return '{"code":"retry_later"}'; end if;
        a:=a||jsonb_build_object('state','broadcast_unknown','attempts',(a->>'attempts')::integer+1,
          'retry_at',clock_timestamp()+interval '30 seconds');
        update public.hd1_recovery set broadcasts=broadcasts+1 where id=h.id;
      end if;
    else raise exception 'unsupported_operation'; end if;
    update public.hd1_recovery set attempt=a,revision=revision+1 where id=h.id;
    return a;
  end if;
  result:=public.hd1_rpc_v6(operation,payload);
  if h.id is not null and operation in ('operational','job','save','synchronize','job_error') and result ? 'version' then
    return result||jsonb_build_object('recovery',to_jsonb(h),'effective_bootstrap',coalesce(h.effective_bootstrap,r.bootstrap));
  end if;
  return result;
end $$;
revoke all on function public.hd1_rpc(text,jsonb) from public,anon,authenticated;
grant execute on function public.hd1_rpc(text,jsonb) to service_role;

alter function public.hd1_public(text,jsonb) rename to hd1_public_v6;
revoke all on function public.hd1_public_v6(text,jsonb) from public,anon,authenticated,service_role;
create function public.hd1_public(operation text,payload jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; h public.hd1_recovery%rowtype;
begin
  result:=public.hd1_public_v6(operation,payload);
  if operation='readiness' then
    select * into h from public.hd1_recovery where singleton;
    result:=result||'{"recovery_capability_revision":7}'::jsonb;
    if h.id is not null then result:=result||jsonb_build_object('available',false,'code',h.status,'recovery_required',true); end if;
  end if;
  if operation='status' then
    select * into h from public.hd1_recovery where original_id=payload->>'id';
    if h.id is not null then
      result:=result||jsonb_build_object('recovery_status',h.status,'recovery_txid',h.attempt->>'txid',
        'recovery_confirmations',h.attempt->'confirmations','publication_retryable',false,'retry_code','recovery_required');
    end if;
  end if;
  return result;
end $$;
revoke all on function public.hd1_public(text,jsonb) from public,anon,authenticated;
grant execute on function public.hd1_public(text,jsonb) to service_role;
-- Inspection is service-only but genuinely usable inside a READ ONLY transaction.
create function public.hd1_recovery_read(operation text,payload jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if operation='raw' and coalesce(payload->>'txid','') ~ '^[a-f0-9]{64}$' and payload=jsonb_build_object('txid',payload->>'txid') then
    return (select jsonb_build_object('raw',exact.raw,'txid',exact.txid,'claim_id',exact.id,'generation',exact.generation,'scope_id',r.finite_scope->>'id') from (
      select raw,txid,id,generation from public.hd1_claims where txid=payload->>'txid'
      union all select attempt->>'raw',attempt->>'txid',original_id,(attempt->>'generation')::bigint from public.hd1_recovery where attempt->>'txid'=payload->>'txid'
    ) exact cross join public.hd1_runtime r where r.singleton limit 1);
  end if;
  if operation<>'inspect' or payload<>'{}'::jsonb then raise exception 'invalid_query'; end if;
  return (select jsonb_build_object('id',h.id,'status',h.status,'envelope',jsonb_build_object('original_txid',h.envelope->>'original_txid'),
    'attempt',jsonb_build_object('txid',h.attempt->>'txid','confirmations',h.attempt->'confirmations'),
    'transactions',h.transactions,'broadcasts',h.broadcasts,'fee_units',h.fee_units,'new_locked_units',h.new_locked_units)
    from public.hd1_recovery h where singleton);
end $$;
revoke all on function public.hd1_recovery_read(text,jsonb) from public,anon,authenticated;
grant execute on function public.hd1_recovery_read(text,jsonb) to service_role;
alter function public.hd1_public_status(public.hd1_claims) rename to hd1_public_status_v6;
revoke all on function public.hd1_public_status_v6(public.hd1_claims) from public,anon,authenticated,service_role;
create function public.hd1_public_status(q public.hd1_claims) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; h public.hd1_recovery%rowtype;
begin
  result:=public.hd1_public_status_v6(q);
  select * into h from public.hd1_recovery where original_id=q.id;
  if h.id is not null then return result||jsonb_build_object('recovery_status',h.status,'recovery_txid',h.attempt->>'txid',
    'recovery_confirmations',h.attempt->'confirmations','publication_retryable',false,'retry_code','recovery_required'); end if;
  return result;
end $$;
revoke all on function public.hd1_public_status(public.hd1_claims) from public,anon,authenticated,service_role;
commit;
