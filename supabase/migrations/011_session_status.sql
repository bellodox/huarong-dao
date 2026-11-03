-- Publicly inspectable, read-only ranked session status.
-- Apply once after 010. No modifications to score admission, witnesses or publishing.
begin;
create function public.hd_session_status(operation text,payload jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid;v_result jsonb;
begin
  if operation not in ('recent','get') then return '{"code":"unsupported_operation"}'::jsonb;end if;
  if operation='get' then
    if coalesce(payload->>'id','') !~ '^[0-9a-fA-F-]{36}$'
       then return '{"code":"invalid_session_id"}'::jsonb;end if;
    begin v_id:=(payload->>'id')::uuid;
    exception when invalid_text_representation then return '{"code":"invalid_session_id"}'::jsonb;end;
  end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc,x.id desc), '[]'::jsonb) into v_result
    from (
      select s.id::text as id,s.layout,s.state,s.seq as checkpoints,
        length(s.moves) as recorded_moves,s.rod_block_height,s.receipt_id,
        s.created_at,s.expires_at,
        c.nickname,c.moves as score_moves,c.points as score_points,
        c.state as publication_state,c.txid,c.confirmations
      from public.hd_ranked_sessions s
      left join public.hd1_claims c on c.id=s.receipt_id
      where operation='recent' or s.id=v_id
      order by s.created_at desc,s.id desc
      limit 10
    ) x;
  if operation='get' then
    return coalesce(v_result->0,'{"code":"not_found"}'::jsonb);
  end if;
  return jsonb_build_object('sessions',v_result);
end $$;
revoke all on function public.hd_session_status(text,jsonb) from public,anon,authenticated;
grant execute on function public.hd_session_status(text,jsonb) to service_role;
commit;
