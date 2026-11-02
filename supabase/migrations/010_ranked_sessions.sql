-- HD2 ranked session integrity, deterministic layout/session seeds.
-- Apply after 009. Existing receipts, tx journals and ROD publisher logic are untouched.
-- Only accepted move prefixes and SHA-256 commitments are stored, never raw input telemetry.
begin;

create table public.hd_ranked_sessions (
  id uuid primary key,
  layout text not null,
  state text not null default 'active' check(state in ('active','sealed','admitted')),
  seq integer not null default 0 check(seq between 0 and 40),
  moves text not null default '',
  nonce text not null check(nonce ~ '^[0-9a-f]{64}$'),
  rules_digest text not null check(rules_digest ~ '^[0-9a-f]{64}$'),
  layout_seed text not null check(layout_seed ~ '^[0-9a-f]{64}$'),
  session_seed text not null check(session_seed ~ '^[0-9a-f]{64}$'),
  rod_block_hash text not null check(rod_block_hash ~ '^[0-9a-f]{64}$'),
  rod_block_height bigint not null check(rod_block_height between 0 and 999999999),
  trace_digest text not null check(trace_digest ~ '^[0-9a-f]{64}$'),
  chain_head text not null check(chain_head ~ '^[0-9a-f]{64}$'),
  input_digest text check(input_digest is null or input_digest ~ '^[0-9a-f]{64}$'),
  token_hash text not null check(token_hash ~ '^[0-9a-f]{64}$'),
  proof_hash text check(proof_hash is null or proof_hash ~ '^[0-9a-f]{64}$'),
  receipt_id text unique check(receipt_id is null or receipt_id ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null
);
create index hd_ranked_sessions_expiry on public.hd_ranked_sessions(expires_at);
create table public.hd_ranked_session_rates(
  bucket text primary key check(bucket ~ '^[0-9a-f]{64}$'),
  started timestamptz not null,
  hits integer not null
);
create index hd_ranked_rates_expiry on public.hd_ranked_session_rates(started);
alter table public.hd_ranked_sessions enable row level security;
alter table public.hd_ranked_session_rates enable row level security;
revoke all on public.hd_ranked_sessions,public.hd_ranked_session_rates from public,anon,authenticated,service_role;

create function public.hd_session_rpc(operation text,payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.hd_ranked_sessions%rowtype;
  v_id uuid;v_now timestamptz:=clock_timestamp();v_hits int;v_moves text;
  v_chain_hash text;v_chain_height bigint;
begin
  if operation='start' then
    if coalesce(payload->>'bucket','') !~ '^[0-9a-f]{64}$'
      or coalesce(payload->>'token_hash','') !~ '^[0-9a-f]{64}$'
      or coalesce(payload->>'nonce','') !~ '^[0-9a-f]{64}$'
      or coalesce(payload->>'rules_digest','') !~ '^[0-9a-f]{64}$'
      or coalesce(payload->>'layout_seed','') !~ '^[0-9a-f]{64}$'
      or coalesce(payload->>'session_seed','') !~ '^[0-9a-f]{64}$'
      or coalesce(payload->>'rod_block_hash','') !~ '^[0-9a-f]{64}$'
      or coalesce(payload->>'rod_block_height','') !~ '^[0-9]{1,9}$'
      or coalesce(payload->>'trace_digest','') !~ '^[0-9a-f]{64}$'
      or coalesce(payload->>'chain_head','') !~ '^[0-9a-f]{64}$'
      or coalesce(payload->>'layout','') not in (
        'wings','heng_dao_li_ma','rear_guard','small_obstacle','ambush','fayaa_sideBySide',
        'fayaa_threeRoads','fayaa_peach','fayaa_rain2','fayaa_cannotStop','fayaa_highRisk')
      then return '{"code":"malformed"}';end if;
    -- The source is the existing, reconciled ROD snapshot, not a client-supplied secret.
    -- One indexed coordinator read; no ROD RPC or new chain transaction per game.
    select c.snapshot->>'hash',(c.snapshot->>'height')::bigint
      into v_chain_hash,v_chain_height
      from public.hd1_coordinator c where c.singleton and not c.paused
        and coalesce((c.snapshot->>'stale')::boolean,true)=false;
    if v_chain_hash is distinct from payload->>'rod_block_hash'
       or v_chain_height is distinct from (payload->>'rod_block_height')::bigint
       then return '{"code":"anchor_changed"}';end if;
    -- This rate bucket is keyed with a Worker-secret HMAC, not a reversible IP hash.
    insert into public.hd_ranked_session_rates(bucket,started,hits)
      values(payload->>'bucket',v_now,1)
      on conflict(bucket) do update set
        hits=case when public.hd_ranked_session_rates.started<v_now-interval '60 seconds'
                  then 1 else public.hd_ranked_session_rates.hits+1 end,
        started=case when public.hd_ranked_session_rates.started<v_now-interval '60 seconds'
                  then v_now else public.hd_ranked_session_rates.started end
      returning hits into v_hits;
    if v_hits>60 then return '{"code":"rate_limited"}';end if;
    begin v_id:=(payload->>'id')::uuid;
    exception when invalid_text_representation then return '{"code":"malformed"}';end;
    insert into public.hd_ranked_sessions(
      id,layout,nonce,rules_digest,layout_seed,session_seed,rod_block_hash,rod_block_height,
      trace_digest,chain_head,token_hash,expires_at
    ) values (
      v_id,payload->>'layout',payload->>'nonce',payload->>'rules_digest',
      payload->>'layout_seed',payload->>'session_seed',payload->>'rod_block_hash',
      (payload->>'rod_block_height')::bigint,payload->>'trace_digest',
      payload->>'chain_head',payload->>'token_hash',v_now+interval '30 minutes'
    );
    return '{"code":"ok"}';
  end if;
  if operation='gc' then
    delete from public.hd_ranked_sessions where id in
      (select id from public.hd_ranked_sessions where expires_at<v_now order by expires_at limit 5000);
    delete from public.hd_ranked_session_rates where bucket in
      (select bucket from public.hd_ranked_session_rates where started<v_now-interval '10 minutes' limit 5000);
    return '{"code":"ok"}';
  end if;
  if operation<>'advance' then return '{"code":"unsupported_operation"}';end if;
  if coalesce(payload->>'id','') !~ '^[0-9a-fA-F-]{36}$' then return '{"code":"malformed"}';end if;
  begin v_id:=(payload->>'id')::uuid;
  exception when invalid_text_representation then return '{"code":"malformed"}';end;
  select * into s from public.hd_ranked_sessions where id=v_id for update;
  if s.id is null or s.state<>'active' or s.expires_at<=v_now then return '{"code":"session_expired"}';end if;
  if s.layout is distinct from payload->>'layout'
      or s.seq is distinct from (payload->>'seq')::integer
      or s.token_hash is distinct from payload->>'token_hash'
      or s.nonce is distinct from payload->>'nonce'
      or s.rules_digest is distinct from payload->>'rules_digest'
      or s.layout_seed is distinct from payload->>'layout_seed'
      or s.session_seed is distinct from payload->>'session_seed'
      or s.rod_block_hash is distinct from payload->>'rod_block_hash'
      or s.rod_block_height is distinct from (payload->>'rod_block_height')::bigint
      or s.chain_head is distinct from payload->>'previous_head'
      or s.trace_digest is distinct from payload->>'prior_trace_digest'
      then return '{"code":"session_conflict"}';end if;
  v_moves:=payload->>'moves';
  if v_moves is null or length(v_moves)<length(s.moves) or length(v_moves)>1260
      or left(v_moves,length(s.moves))<>s.moves
      or coalesce(payload->>'trace_digest','') !~ '^[0-9a-f]{64}$'
      or coalesce(payload->>'next_head','') !~ '^[0-9a-f]{64}$'
      then return '{"code":"session_conflict"}';end if;
  if coalesce((payload->>'final')::boolean,false) then
    if s.seq<2 or coalesce(payload->>'proof_hash','') !~ '^[0-9a-f]{64}$'
       or coalesce(payload->>'input_digest','') !~ '^[0-9a-f]{64}$'
       then return '{"code":"checkpoints_missing"}';end if;
    update public.hd_ranked_sessions set state='sealed',moves=v_moves,
      trace_digest=payload->>'trace_digest',chain_head=payload->>'next_head',
      input_digest=payload->>'input_digest',proof_hash=payload->>'proof_hash',
      expires_at=v_now+interval '72 hours' where id=v_id;
  else
    if length(v_moves)<>40*(s.seq+1) or coalesce(payload->>'next_hash','') !~ '^[0-9a-f]{64}$'
       then return '{"code":"checkpoint_boundary"}';end if;
    update public.hd_ranked_sessions set seq=seq+1,moves=v_moves,
      trace_digest=payload->>'trace_digest',chain_head=payload->>'next_head',
      token_hash=payload->>'next_hash' where id=v_id;
  end if;
  return '{"code":"ok"}';
end $$;
revoke all on function public.hd_session_rpc(text,jsonb) from public,anon,authenticated;
grant execute on function public.hd_session_rpc(text,jsonb) to service_role;

-- Transactionally consume a single session within score admission. The existing
-- hd1 score/issuer/ROD receipt format is unchanged. Already admitted exact bytes
-- keep their legacy idempotent retry semantics after this migration.
alter function public.hd1_rpc(text,jsonb) rename to hd1_rpc_v9;
revoke all on function public.hd1_rpc_v9(text,jsonb) from public,anon,authenticated,service_role;
create function public.hd1_rpc(operation text,payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.hd_ranked_sessions%rowtype;
  q public.hd1_claims%rowtype;result jsonb;sid uuid;proof jsonb;
begin
  if operation<>'admit' then return public.hd1_rpc_v9(operation,payload);end if;
  -- Existing exact claims must remain retriable without a new gameplay session.
  select * into q from public.hd1_claims where id=payload->>'id';
  if q.id is not null then
    if q.bytes is distinct from payload->>'bytes' then return '{"code":"idempotency_conflict"}';end if;
    return public.hd1_rpc_v9(operation,payload-'session');
  end if;
  proof:=payload->'session';
  if payload->>'profile' is distinct from 'hd2'
     or jsonb_typeof(proof) is distinct from 'object'
     or coalesce(proof->>'proof_hash','') !~ '^[0-9a-f]{64}$'
     then return '{"code":"session_required"}';end if;
  begin sid:=(proof->>'id')::uuid;
  exception when invalid_text_representation then return '{"code":"session_required"}';end;
  select * into s from public.hd_ranked_sessions where id=sid for update;
  if s.id is null or s.state<>'sealed' or s.expires_at<=clock_timestamp()
     or s.proof_hash is distinct from proof->>'proof_hash'
     or s.layout is distinct from payload->>'layout'
     or s.moves is distinct from payload->>'move_path'
     or s.session_seed is distinct from proof->>'session_seed'
     or s.rod_block_hash is distinct from proof->>'rod_block_hash'
     or s.rod_block_height is distinct from (proof->>'rod_block_height')::bigint
     or s.layout_seed is distinct from proof->>'layout_seed'
     or s.rules_digest is distinct from proof->>'rules_digest'
     or s.nonce is distinct from proof->>'nonce'
     or s.chain_head is distinct from proof->>'head'
     or s.input_digest is distinct from proof->>'input_digest'
     then return '{"code":"invalid_session"}';end if;
  result:=public.hd1_rpc_v9(operation,payload-'session');
  -- Don't spend the session for queue/full/week/reconciliation failures.
  if result ? 'code' then return result;end if;
  update public.hd_ranked_sessions set state='admitted',receipt_id=payload->>'id' where id=sid;
  return result;
end $$;
revoke all on function public.hd1_rpc(text,jsonb) from public,anon,authenticated;
grant execute on function public.hd1_rpc(text,jsonb) to service_role;

-- Reuse the publisher's already-performed readiness lookup for the ROD anchor.
-- This adds ZERO extra Supabase requests per session start.
alter function public.hd1_public(text,jsonb) rename to hd1_public_v10;
revoke all on function public.hd1_public_v10(text,jsonb) from public,anon,authenticated,service_role;
create function public.hd1_public(operation text,payload jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;v_hash text;v_height text;
begin
  result:=public.hd1_public_v10(operation,payload);
  if operation<>'readiness' or result->>'available' is distinct from 'true'
     or payload->>'include_anchor' is distinct from 'true' then return result;end if;
  select c.snapshot->>'hash',c.snapshot->>'height' into v_hash,v_height
    from public.hd1_coordinator c where c.singleton and not c.paused
      and coalesce((c.snapshot->>'stale')::boolean,true)=false;
  if v_hash ~ '^[0-9a-f]{64}$' and v_height ~ '^[0-9]{1,9}$' then
    return result||jsonb_build_object('rod_anchor',jsonb_build_object('hash',v_hash,'height',v_height::bigint));
  end if;
  return result;
end $$;
revoke all on function public.hd1_public(text,jsonb) from public,anon,authenticated;
grant execute on function public.hd1_public(text,jsonb) to service_role;
commit;
