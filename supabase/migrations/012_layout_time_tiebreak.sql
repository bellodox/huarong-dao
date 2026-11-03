-- Public per-layout time tiebreaker. Apply ONCE after 011_session_status.sql.
-- Duration is derived from existing ranked-session gesture telemetry in the relay.
-- Move-based improvement, points, hd2 receipts, issuer, fees, and ROD publication
-- remain unchanged. Historical scores without accepted timing sort last on ties.
begin;

alter table public.hd_ranked_sessions add column duration_ds integer
  check(duration_ds between 0 and 18000);
alter table public.hd1_claims add column duration_ds integer
  check(duration_ds between 0 and 18000);

-- The existing finish RPC remains a single atomic write. It stores no raw
-- pointer telemetry and makes no extra database round trip.
create or replace function public.hd_session_rpc(operation text,payload jsonb default '{}') returns jsonb
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
    if coalesce(payload->>'duration_ds','') !~ '^(0|[1-9][0-9]{0,4})$'
       then return '{"code":"invalid_duration"}';end if;
    if (payload->>'duration_ds')::integer>18000
       then return '{"code":"invalid_duration"}';end if;
    update public.hd_ranked_sessions set state='sealed',moves=v_moves,
      duration_ds=(payload->>'duration_ds')::integer,
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

-- Admission already consumes a sealed session atomically. Copy its measured
-- duration into the durable claim in that same transaction, without rewriting
-- the strictly move-based admission function or its idempotency behavior.
create function public.hd1_copy_session_duration() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.state='admitted' and new.receipt_id is not null
     and new.duration_ds is not null then
    update public.hd1_claims c set duration_ds=new.duration_ds
      where c.id=new.receipt_id and c.layout=new.layout and c.moves=length(new.moves);
  end if;
  return new;
end $$;
revoke all on function public.hd1_copy_session_duration() from public,anon,authenticated,service_role;
create trigger hd1_ranked_duration_admitted
  after update of state,receipt_id on public.hd_ranked_sessions
  for each row when (new.state='admitted')
  execute function public.hd1_copy_session_duration();

-- Preserve the existing public RPC contract, readiness, status, epoch,
-- pagination cursor, pending projection, and overall rankings.
-- Only layout-filtered confirmed rankings are ordered by accepted duration
-- after the verified move count. Join by exact authenticated receipt ID.
alter function public.hd1_public(text,jsonb) rename to hd1_public_v11;
revoke all on function public.hd1_public_v11(text,jsonb) from public,anon,authenticated,service_role;
create function public.hd1_public(operation text,payload jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; timed_rows jsonb; timed_more boolean;
  page_limit integer:=coalesce((payload->>'limit')::integer,20);
  page_offset integer:=coalesce((payload->>'offset')::integer,0);
  scope text:=coalesce(payload->>'scope','lifetime');
  selected_layout text:=payload->>'layout';
begin
  -- Existing function retains all validation and non-leaderboard behavior.
  result:=public.hd1_public_v11(operation,payload);
  if operation<>'leaderboard' or selected_layout is null then return result;end if;

  with best as (
    select distinct on (r.player,r.layout)
      r.player,r.nickname,r.layout,r.moves,r.points,r.id,
      c.duration_ds
    from public.hd1_receipts r
    left join public.hd1_claims c on c.id=r.id and c.player=r.player
      and c.layout=r.layout and c.moves=r.moves and c.points=r.points
    where (scope='lifetime' or r.epoch=(payload->>'week')::bigint)
      and r.layout=selected_layout
      and (payload->>'player' is null or r.player=payload->>'player')
      and r.layout in ('wings','heng_dao_li_ma','rear_guard','small_obstacle','ambush',
        'fayaa_sideBySide','fayaa_threeRoads','fayaa_peach','fayaa_rain2',
        'fayaa_cannotStop','fayaa_highRisk')
    -- Preserve the original canonical choice among equal-move receipts for
    -- one player: time does not authorize another record or publication.
    order by r.player,r.layout,r.moves,r.height,r.transaction_index,r.output_index
  ), players as (
    select player,min(nickname) as nickname,sum(points) as points,
      count(*) as completed,min(moves) as moves,min(duration_ds) as duration_ds,
      jsonb_object_agg(layout,jsonb_build_object('moves',moves,'points',points,
        'receipt_id',id,'duration_ds',duration_ds)) as bests
    from best group by player
  ), numbered as (
    select *,row_number() over(order by moves asc,duration_ds asc nulls last,
      player collate "C") as position from players
  ), page as (
    select * from numbered order by position limit page_limit+1 offset page_offset
  )
  select coalesce((select jsonb_agg(jsonb_build_object('player',player,'nickname',nickname,
    'points',points,'completed',completed,'bests',bests) order by position)
    from page where position<=page_offset+page_limit),'[]'::jsonb),
    (select count(*)>page_limit from page)
  into timed_rows,timed_more;

  return result||jsonb_build_object('rows',timed_rows,'has_more',timed_more);
end $$;
revoke all on function public.hd1_public(text,jsonb) from public,anon,authenticated;
grant execute on function public.hd1_public(text,jsonb) to service_role;
commit;
