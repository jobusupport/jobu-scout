-- Foundational schema baseline (Slice 1 branch-validation follow-up), part 2 of 5.
-- See supabase/README.md for the full explanation of why this exists.
-- Reconstructed via read-only introspection (Supabase list_tables +
-- information_schema/pg_catalog queries), NOT a pg_dump/db push output.

-- All 11 Jobu-Scout-owned functions in the public schema. Excludes
-- admin_dashboard_metrics (owned by the already-tracked
-- admin_dashboard_metrics_fn migration) and every pg_trgm-internal C
-- function (those come from the pg_trgm extension itself, created in
-- file 1 -- reimplementing them here would be redundant and wrong).

CREATE OR REPLACE FUNCTION public.auth_user_org_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT org_id
  FROM   org_members
  WHERE  user_id     = auth.uid()
    AND  accepted_at IS NOT NULL;
$function$;

CREATE OR REPLACE FUNCTION public.is_jobu_admin(uid uuid DEFAULT auth.uid())
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.platform_admins
    where user_id = uid and is_active = true
  );
$function$;

CREATE OR REPLACE FUNCTION public.check_org_limits(p_org_id uuid, p_check text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_org    organizations%ROWTYPE;
  v_count  int;
BEGIN
  SELECT * INTO v_org FROM organizations WHERE id = p_org_id;

  IF p_check = 'opponent_teams' THEN
    SELECT COUNT(*) INTO v_count FROM teams
    WHERE org_id = p_org_id AND is_our_team = false;
    IF v_count >= v_org.max_opponent_teams THEN
      RETURN jsonb_build_object('allowed', false, 'reason',
        format('Plan limit reached: %s opponent teams (max %s on %s plan)',
               v_count, v_org.max_opponent_teams, v_org.plan));
    END IF;

  ELSIF p_check = 'monthly_reports' THEN
    SELECT COUNT(*) INTO v_count FROM reports
    WHERE org_id  = p_org_id
      AND created_at >= date_trunc('month', now());
    IF v_count >= v_org.max_reports_per_month THEN
      RETURN jsonb_build_object('allowed', false, 'reason',
        format('Plan limit reached: %s reports this month (max %s on %s plan)',
               v_count, v_org.max_reports_per_month, v_org.plan));
    END IF;

  ELSIF p_check = 'users' THEN
    SELECT COUNT(*) INTO v_count FROM org_members
    WHERE org_id = p_org_id AND accepted_at IS NOT NULL;
    IF v_count >= v_org.max_users THEN
      RETURN jsonb_build_object('allowed', false, 'reason',
        format('Plan limit reached: %s users (max %s on %s plan)',
               v_count, v_org.max_users, v_org.plan));
    END IF;
  END IF;

  RETURN jsonb_build_object('allowed', true, 'reason', null);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_active_roster_players(p_team_id uuid, p_last_n_games integer DEFAULT 10, p_min_appearances integer DEFAULT 1)
 RETURNS TABLE(player_name text, game_count bigint)
 LANGUAGE plpgsql
AS $function$
declare
  v_recent_game_ids uuid[];
begin
  select array_agg(rg.id)
  into v_recent_game_ids
  from (
    select distinct
      g.id,
      g.game_date,
      g.captured_at
    from public.games as g
    where g.team_id = p_team_id
      and g.game_date is not null
      and exists (
        select 1
        from public.batting_lines as bl
        where bl.game_id = g.id
          and bl.team_id = p_team_id
      )
      and exists (
        select 1
        from public.pitching_lines as pl
        where pl.game_id = g.id
          and pl.team_id = p_team_id
      )
    order by
      g.game_date desc,
      g.captured_at desc nulls last
    limit p_last_n_games
  ) as rg;

  if v_recent_game_ids is null then
    return;
  end if;

  return query
  with roster_rows as (
    select
      bl.player_name::text as roster_player_name,
      bl.game_id as roster_game_id
    from public.batting_lines as bl
    where bl.team_id = p_team_id
      and bl.is_our_team = false
      and bl.game_id = any(v_recent_game_ids)
      and bl.player_name is not null
      and trim(bl.player_name) <> ''

    union all

    select
      pl.player_name::text as roster_player_name,
      pl.game_id as roster_game_id
    from public.pitching_lines as pl
    where pl.team_id = p_team_id
      and pl.is_our_team = false
      and pl.game_id = any(v_recent_game_ids)
      and pl.player_name is not null
      and trim(pl.player_name) <> ''
  ),

  rolled_up as (
    select
      rr.roster_player_name,
      count(distinct rr.roster_game_id)::bigint as roster_game_count
    from roster_rows as rr
    group by rr.roster_player_name
  )

  select
    ru.roster_player_name as player_name,
    ru.roster_game_count as game_count
  from rolled_up as ru
  where ru.roster_game_count >= p_min_appearances
  order by
    ru.roster_game_count desc,
    ru.roster_player_name asc;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_recent_pitching_lines(p_team_id uuid)
 RETURNS TABLE(player_name text, is_our_team boolean, team_side text, team_name_raw text, ip text, ip_decimal numeric, bf integer, pitch_count integer, strikes integer, game_date date, game_time text, game_datetime_raw text, opponent_name text, gc_game_id text)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT
    p.player_name,
    p.is_our_team,
    p.team_side,
    p.team_name_raw,
    p.ip,
    p.ip_decimal,
    p.bf,
    p.pc AS pitch_count,
    p.strikes,
    g.game_date,
    g.game_time,
    g.game_datetime_raw,
    g.opponent_name,
    g.gc_game_id
  FROM pitching_lines p
  JOIN games g ON g.id = p.game_id
  WHERE p.team_id = p_team_id
    AND p.is_our_team = false
    AND g.game_date IS NOT NULL
  ORDER BY g.game_date DESC, p.player_name;
$function$;

CREATE OR REPLACE FUNCTION public.get_team_batting_aggregates(p_team_id uuid)
 RETURNS TABLE(is_our_team boolean, player_name text, games bigint, total_ab bigint, total_h bigint, total_r bigint, total_rbi bigint, total_bb bigint, total_so bigint, total_2b bigint, total_3b bigint, total_hr bigint, total_sb bigint, total_hbp bigint, total_sac bigint, batting_avg numeric, obp numeric, slg numeric)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT
    false AS is_our_team,
    player_name,
    COUNT(DISTINCT game_id)             AS games,
    COALESCE(SUM(ab), 0)               AS total_ab,
    COALESCE(SUM(h), 0)                AS total_h,
    COALESCE(SUM(r), 0)                AS total_r,
    COALESCE(SUM(rbi), 0)              AS total_rbi,
    COALESCE(SUM(bb), 0)               AS total_bb,
    COALESCE(SUM(so), 0)               AS total_so,
    COALESCE(SUM(doubles), 0)          AS total_2b,
    COALESCE(SUM(triples), 0)          AS total_3b,
    COALESCE(SUM(hr), 0)               AS total_hr,
    COALESCE(SUM(sb), 0)               AS total_sb,
    COALESCE(SUM(hbp), 0)              AS total_hbp,
    COALESCE(SUM(sac), 0)              AS total_sac,
    ROUND(
      CAST(COALESCE(SUM(h),0) AS numeric)
      / NULLIF(COALESCE(SUM(ab),0), 0), 3
    ) AS batting_avg,
    ROUND(
      CAST(COALESCE(SUM(h),0) + COALESCE(SUM(bb),0) + COALESCE(SUM(hbp),0) AS numeric)
      / NULLIF(COALESCE(SUM(ab),0) + COALESCE(SUM(bb),0) + COALESCE(SUM(hbp),0) + COALESCE(SUM(sac),0), 0), 3
    ) AS obp,
    ROUND(
      CAST(
        (COALESCE(SUM(h),0) - COALESCE(SUM(doubles),0) - COALESCE(SUM(triples),0) - COALESCE(SUM(hr),0))
        + (2 * COALESCE(SUM(doubles),0))
        + (3 * COALESCE(SUM(triples),0))
        + (4 * COALESCE(SUM(hr),0))
      AS numeric) / NULLIF(COALESCE(SUM(ab),0), 0), 3
    ) AS slg
  FROM batting_lines
  WHERE team_id = p_team_id AND is_our_team = false
  GROUP BY player_name
  ORDER BY total_ab DESC;
$function$;

CREATE OR REPLACE FUNCTION public.get_team_pitching_aggregates(p_team_id uuid)
 RETURNS TABLE(is_our_team boolean, player_name text, games bigint, total_ip numeric, total_bf bigint, total_pitches bigint, total_h bigint, total_r bigint, total_er bigint, total_bb bigint, total_so bigint, k_bb_ratio numeric, era numeric, whip numeric, pitches_per_ip numeric)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT
    false AS is_our_team,
    player_name,
    COUNT(DISTINCT game_id)              AS games,
    SUM(ip_decimal)                      AS total_ip,
    SUM(bf)                              AS total_bf,
    SUM(pc)                              AS total_pitches,
    SUM(h_allowed)                       AS total_h,
    SUM(r_allowed)                       AS total_r,
    SUM(er)                              AS total_er,
    SUM(bb)                              AS total_bb,
    SUM(so)                              AS total_so,
    ROUND(CAST(SUM(so) AS numeric) / NULLIF(SUM(bb), 0), 2)          AS k_bb_ratio,
    ROUND(9.0 * SUM(er) / NULLIF(SUM(ip_decimal), 0), 2)             AS era,
    ROUND((CAST(SUM(bb) AS numeric) + SUM(h_allowed)) / NULLIF(SUM(ip_decimal), 0), 3) AS whip,
    ROUND(CAST(SUM(pc) AS numeric) / NULLIF(SUM(ip_decimal), 0), 1)  AS pitches_per_ip
  FROM pitching_lines
  WHERE team_id = p_team_id AND is_our_team = false
  GROUP BY player_name
  ORDER BY total_ip DESC;
$function$;

CREATE OR REPLACE FUNCTION public.get_team_play_tendencies(p_team_id uuid)
 RETURNS TABLE(event_type text, count bigint, pct numeric)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT
    event_type,
    COUNT(*)                                              AS count,
    ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1)  AS pct
  FROM play_events
  WHERE team_id = p_team_id
    AND event_type != 'unknown'
    AND event_type != 'end_inning'
  GROUP BY event_type
  ORDER BY count DESC;
$function$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;
