-- High School import publishing RPCs (Slice 1A.1).
--
-- Slice 1A (20260728220000_create_high_school_import_domain.sql,
-- src/high-school-import-repository.js) documented, inline, that its
-- publishVerifiedTotals/publishPlayerAdvancedStats/publishPitcherAdvancedStats
-- each perform a three-step, NOT ATOMIC sequence over plain PostgREST calls
-- (find the current row -> supersede it -> insert the new one), and that
-- closing that gap for real "requires a database-side function... this
-- slice is explicitly NOT authorized to add." This migration adds exactly
-- those three functions, one per table, so each publish is a single
-- Postgres transaction: a crash or error at any point leaves the
-- previously published (current) row completely untouched, never
-- superseded with no replacement.
--
-- ── Why this must be a database function at all ─────────────────────────
-- Same architectural reason as admin_update_org_product
-- (20260722010000_admin_update_org_product_fn.sql) and
-- repair_audited_game_dates (20260724000000_repair_audited_game_dates_fn.sql):
-- the application only talks to Postgres through @supabase/supabase-js,
-- where every `.from(...).insert()/.update()` call is its own independent
-- HTTP request/statement with no shared transaction. A guarantee like "the
-- previous current row is never superseded unless its replacement insert
-- also succeeds" is only available inside a single Postgres function body,
-- which executes as one implicit transaction.
--
-- ── Per-identity publish, not a batch replace ───────────────────────────
-- The task that requested this slice described a "publish the complete
-- player/pitcher advanced-statistics dataset for a team" batch operation.
-- The ACTUAL merged Slice 1A contract
-- (createHighSchoolImportRepository.publishPlayerAdvancedStats /
-- publishPitcherAdvancedStats) is per-row: one player, one call, current/
-- superseded by (player_id, team_id, season_id) -- there is no existing
-- code path, application or database, that ever assembled or replaced a
-- whole team's player roster of stats in one write. Per this slice's own
-- instruction to treat the already-merged contract as authoritative over a
-- speculative batch shape, these RPCs preserve that exact per-identity
-- publish semantics (one team-total row per team+season, one player-stat
-- row per player+team+season) rather than inventing a new batch interface.
-- Because each call already publishes exactly one logical row, the
-- "duplicate logical key within one payload" concern the batch design
-- would have needed does not arise here: the row's own identity IS the
-- call's parameters, and the current/superseded partial unique index
-- (enforced under `for update` row locks below) is what prevents two
-- "current" rows for the same identity from ever coexisting, exactly as
-- it already did for Slice 1A's three-call sequence -- just atomically now.
--
-- ── Authorization model (matches admin_update_org_product exactly) ──────
-- Every table this migration's functions write to has RLS enabled with
-- ONLY a SELECT policy (Slice 0B) -- INSERT/UPDATE are unreachable for
-- anon/authenticated by RLS default-deny regardless of this migration.
-- The Express server's service_role key is the sole existing write path
-- for this entire domain (see 20260728220000's own header), and it
-- bypasses RLS entirely -- so there is no auth.uid()/auth_user_org_ids()
-- session context available inside these functions to "resolve the
-- caller's organization" from a JWT the way an RLS policy would. The
-- established pattern this codebase already uses for exactly this
-- situation (admin_update_org_product) is: EXECUTE is revoked from
-- anon AND authenticated (not just the public pseudo-role -- this
-- project auto-grants both independently of PUBLIC, see
-- 20260620000002's grant-tightening comment) and granted only to
-- postgres/service_role, so a direct PostgREST RPC call from an ordinary
-- authenticated user's own JWT is rejected before this function body ever
-- runs. "Do not trust a client-supplied org_id as authorization evidence"
-- is therefore enforced two ways: (1) only the trusted Express layer can
-- call this function at all, and (2) even so, EVERY id this function
-- receives (team_id, season_id, player_id, import_run_id) is independently
-- re-verified below via locked, schema-qualified lookups -- never assumed
-- correct merely because it was passed in. In particular, an import run
-- must match the complete caller-supplied organization/program/team/season
-- hierarchy. A caller (correct or buggy) cannot attach a run from another
-- hierarchy to a publication because every parent row must match before
-- any write or the call raises P0002.
--
-- ── SECURITY DEFINER hardening ───────────────────────────────────────────
-- SET search_path = '' + fully schema-qualified references (public.*)
-- throughout, identical rationale to admin_update_org_product's own header
-- comment: with an empty search_path only pg_catalog is implicitly
-- searched, so an unqualified reference could never be hijacked by an
-- attacker-created same-named object, even though these functions run as
-- their (elevated-privilege) owner. No dynamic SQL anywhere in this file --
-- jsonb_populate_record (used for the stats blobs) is an ordinary builtin,
-- not EXECUTE, and every value from the caller is used only as a bound
-- plpgsql variable in parameterized statements.
--
-- ── Verified-totals publication gate (defense in depth) ──────────────────
-- src/high-school-import-service.js's assertVerifiedTotalsPublishable
-- already rejects, client-side, BEFORE the repository call: incomplete
-- box-score coverage, any mismatched game, and unresolved side
-- attribution. This function independently re-derives the first two of
-- those three directly from the same aggregate numbers being persisted.
-- The persisted counts also retain summarizeTeamValidation's authoritative
-- partition: box-score/play-by-play counts are subsets of games, while
-- validated and mismatched games are the two exhaustive play-by-play
-- outcomes (validated_games + mismatch_games = play_by_play_games). This
-- lets the database reject impossible aggregates independently of the
-- application. The third
-- check (resolved side attribution) is NOT re-derived here: it depends on
-- hs_game_validation_results rows keyed by hs_game_id, which this
-- function's parameters (a team-season AGGREGATE, not a list of games)
-- have no way to identify, and import_run_id is optional on this table --
-- re-deriving it would require assuming every aggregate publish is
-- preceded by validation rows for that exact run, which Slice 1A's own
-- contract does not guarantee. This is a documented, intentionally scoped
-- limitation, not an oversight.
--
-- ── Stale-publication / concurrency protection ───────────────────────────
-- `for update` row locks on the parent team/run rows and on the existing
-- current row serialize truly concurrent publishers for the same identity
-- -- the race Slice 1A's own JS-level CONCURRENT_PUBLICATION_CONFLICT
-- check could only detect after the fact is now structurally impossible
-- (the second transaction simply waits for the lock, then re-evaluates
-- against the first transaction's committed result). Preventing an OLDER
-- import run from overwriting a NEWER one's already-published totals is a
-- different problem locking alone doesn't solve, so where both the
-- existing current row and the incoming publish carry a non-null
-- import_run_id, this function compares the two runs' created_at and
-- rejects the publish if the incoming run is not strictly newer. This
-- schema has no dedicated sequence/version column, and import_run_id is
-- optional, so this guard is scoped to exactly the case it can support
-- without guessing -- when either side lacks an import_run_id, no
-- ordering claim is possible and none is enforced (documented limitation,
-- not a new versioning system).
--
-- ── Grants ────────────────────────────────────────────────────────────────
-- revoke ... from public, anon, authenticated; grant ... to postgres,
-- service_role -- identical shape to every other SECURITY DEFINER function
-- in this schema that only the Express server's adminClient may call.

-- ── publish_hs_verified_totals ───────────────────────────────────────────
create or replace function public.publish_hs_verified_totals(
  p_org_id uuid,
  p_program_id uuid,
  p_team_id uuid,
  p_season_id uuid,
  p_import_run_id uuid,
  p_games integer,
  p_box_score_games integer,
  p_play_by_play_games integer,
  p_validated_games integer,
  p_mismatch_games integer,
  p_batting_official jsonb default '{}'::jsonb,
  p_pitching_official jsonb default '{}'::jsonb,
  p_batting_reconstructed jsonb default '{}'::jsonb,
  p_pitching_reconstructed jsonb default '{}'::jsonb,
  p_tendencies jsonb default '{}'::jsonb,
  p_warnings jsonb default '[]'::jsonb,
  p_confidence text default 'low'
)
returns public.hs_verified_totals
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_run public.hs_import_runs%rowtype;
  v_existing_current_id uuid;
  v_existing_run_created_at timestamptz;
  v_affected int;
  v_new_row public.hs_verified_totals%rowtype;
begin
  if p_org_id is null or p_program_id is null or p_team_id is null or p_season_id is null then
    raise exception 'org_id, program_id, team_id, and season_id are all required' using errcode = '22004';
  end if;
  if p_games is null or p_box_score_games is null or p_play_by_play_games is null or p_validated_games is null or p_mismatch_games is null then
    raise exception 'games, box_score_games, play_by_play_games, validated_games, and mismatch_games are all required' using errcode = '22004';
  end if;
  if p_games < 0 or p_box_score_games < 0 or p_play_by_play_games < 0 or p_validated_games < 0 or p_mismatch_games < 0 then
    raise exception 'game counts must be non-negative' using errcode = '22003';
  end if;
  -- summarizeTeamValidation derives each coverage count from the same
  -- gameResults array. Check those caller-controlled relationships before
  -- taking any row lock or performing any publication mutation.
  if p_box_score_games > p_games then
    raise exception 'invalid_verified_totals_counts: box_score_games (%) cannot exceed games (%)', p_box_score_games, p_games using errcode = 'P0001';
  end if;
  if p_play_by_play_games > p_games then
    raise exception 'invalid_verified_totals_counts: play_by_play_games (%) cannot exceed games (%)', p_play_by_play_games, p_games using errcode = 'P0001';
  end if;
  if p_validated_games > p_games then
    raise exception 'invalid_verified_totals_counts: validated_games (%) cannot exceed games (%)', p_validated_games, p_games using errcode = 'P0001';
  end if;
  if p_mismatch_games > p_games then
    raise exception 'invalid_verified_totals_counts: mismatch_games (%) cannot exceed games (%)', p_mismatch_games, p_games using errcode = 'P0001';
  end if;
  if p_validated_games > p_play_by_play_games then
    raise exception 'invalid_verified_totals_counts: validated_games (%) cannot exceed play_by_play_games (%)', p_validated_games, p_play_by_play_games using errcode = 'P0001';
  end if;
  if p_mismatch_games > p_play_by_play_games then
    raise exception 'invalid_verified_totals_counts: mismatch_games (%) cannot exceed play_by_play_games (%)', p_mismatch_games, p_play_by_play_games using errcode = 'P0001';
  end if;
  if p_validated_games + p_mismatch_games <> p_play_by_play_games then
    raise exception 'invalid_verified_totals_counts: validated_games (%) plus mismatch_games (%) must equal play_by_play_games (%)', p_validated_games, p_mismatch_games, p_play_by_play_games using errcode = 'P0001';
  end if;
  if p_confidence is null or p_confidence not in ('low', 'medium', 'high') then
    raise exception 'confidence must be one of low/medium/high' using errcode = '22023';
  end if;

  -- Ownership: team must belong to (org, program); season must belong to
  -- (org, program). Locked so a concurrent org/program reassignment (there
  -- is no such operation today, but the lock costs nothing) cannot race
  -- this check.
  perform 1 from public.hs_teams
   where id = p_team_id and org_id = p_org_id and program_id = p_program_id
   for update;
  if not found then
    raise exception 'team_not_found_for_org_program: %', p_team_id using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.hs_seasons
     where id = p_season_id and org_id = p_org_id and program_id = p_program_id
  ) then
    raise exception 'season_not_found_for_org_program: %', p_season_id using errcode = 'P0002';
  end if;

  -- Publication gate -- see header comment for why only these two of the
  -- three Slice 1A checks are re-derivable here.
  if p_box_score_games <> p_games then
    raise exception 'incomplete_box_score_coverage: % of % game(s) missing a box score', (p_games - p_box_score_games), p_games using errcode = 'P0001';
  end if;
  if p_mismatch_games > 0 then
    raise exception 'unresolved_mismatch: % game(s) have an unresolved play-by-play/box-score mismatch', p_mismatch_games using errcode = 'P0001';
  end if;

  if p_import_run_id is not null then
    select * into v_run
      from public.hs_import_runs
     where id = p_import_run_id
       and org_id = p_org_id
       and program_id = p_program_id
       and team_id = p_team_id
       and season_id = p_season_id
     for update;
    if not found then
      raise exception 'import_run_not_found_for_org_team: %', p_import_run_id using errcode = 'P0002';
    end if;
    if v_run.status <> 'running' then
      raise exception 'invalid_import_run_state: run % has status %, expected running', p_import_run_id, v_run.status using errcode = 'P0001';
    end if;
  end if;

  select id into v_existing_current_id
    from public.hs_verified_totals
   where team_id = p_team_id and season_id = p_season_id and is_current
   for update;

  if v_existing_current_id is not null and p_import_run_id is not null then
    select old_run.created_at into v_existing_run_created_at
      from public.hs_verified_totals vt
      join public.hs_import_runs old_run
        on old_run.id = vt.import_run_id and old_run.org_id = vt.org_id
     where vt.id = v_existing_current_id
       and vt.import_run_id is not null;

    if v_existing_run_created_at is not null and v_existing_run_created_at >= v_run.created_at then
      raise exception 'stale_import_run_publication: import run % is not newer than the run behind the currently published totals', p_import_run_id using errcode = 'P0001';
    end if;
  end if;

  if v_existing_current_id is not null then
    update public.hs_verified_totals
       set is_current = false, superseded_at = now()
     where id = v_existing_current_id
       and is_current = true;
    get diagnostics v_affected = row_count;
    if v_affected <> 1 then
      raise exception 'concurrent_publication_conflict: could not supersede the current row for team %/season %', p_team_id, p_season_id using errcode = '40001';
    end if;
  end if;

  insert into public.hs_verified_totals (
    org_id, program_id, team_id, season_id, import_run_id,
    games, box_score_games, play_by_play_games, validated_games, mismatch_games,
    batting_official, pitching_official, batting_reconstructed, pitching_reconstructed,
    tendencies, warnings, confidence, is_current, superseded_at
  ) values (
    p_org_id, p_program_id, p_team_id, p_season_id, p_import_run_id,
    p_games, p_box_score_games, p_play_by_play_games, p_validated_games, p_mismatch_games,
    coalesce(p_batting_official, '{}'::jsonb), coalesce(p_pitching_official, '{}'::jsonb),
    coalesce(p_batting_reconstructed, '{}'::jsonb), coalesce(p_pitching_reconstructed, '{}'::jsonb),
    coalesce(p_tendencies, '{}'::jsonb), coalesce(p_warnings, '[]'::jsonb),
    p_confidence, true, null
  )
  returning * into v_new_row;

  return v_new_row;
end;
$function$;

revoke execute on function public.publish_hs_verified_totals(uuid, uuid, uuid, uuid, uuid, integer, integer, integer, integer, integer, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.publish_hs_verified_totals(uuid, uuid, uuid, uuid, uuid, integer, integer, integer, integer, integer, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text) to postgres, service_role;

-- ── publish_hs_player_advanced_stats ─────────────────────────────────────
--
-- p_stats is the same "passthrough map of already-computed column values"
-- shape as Slice 1A's JS stripReservedColumns -- but where the JS layer
-- silently STRIPPED reserved/identity keys, this function REJECTS any key
-- not on the explicit stat-column allowlist below (never silently drops
-- or silently accepts an unrecognized field -- see the required-behavior
-- note on this in the task this migration implements). jsonb_populate_record
-- is an ordinary builtin (not dynamic SQL) and only ever populates columns
-- that survived that allowlist check.
create or replace function public.publish_hs_player_advanced_stats(
  p_org_id uuid,
  p_program_id uuid,
  p_team_id uuid,
  p_season_id uuid,
  p_player_id uuid,
  p_import_run_id uuid,
  p_stats jsonb default '{}'::jsonb
)
returns public.hs_player_advanced_stats
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_allowed_columns constant text[] := array[
    'games', 'total_pitches', 'gb', 'fb', 'ld', 'batted_balls',
    'gb_pct', 'fb_pct', 'ld_pct',
    'spray_lf', 'spray_cf', 'spray_rf', 'spray_3b', 'spray_ss', 'spray_2b', 'spray_1b', 'spray_pc',
    'spray_lf_pct', 'spray_cf_pct', 'spray_rf_pct', 'spray_3b_pct', 'spray_ss_pct', 'spray_2b_pct', 'spray_1b_pct', 'spray_pc_pct',
    'risp_ab', 'risp_h', 'ba_risp',
    'swing_decisions', 'spray_by_count',
    'k_pct', 'bb_pct', 'errors', 'bunts'
  ];
  v_key text;
  v_run public.hs_import_runs%rowtype;
  v_existing_current_id uuid;
  v_existing_run_created_at timestamptz;
  v_affected int;
  v_stats_row public.hs_player_advanced_stats;
  v_new_row public.hs_player_advanced_stats%rowtype;
begin
  if p_org_id is null or p_program_id is null or p_team_id is null or p_season_id is null or p_player_id is null then
    raise exception 'org_id, program_id, team_id, season_id, and player_id are all required' using errcode = '22004';
  end if;
  if p_stats is null or jsonb_typeof(p_stats) <> 'object' then
    raise exception 'stats must be a JSON object' using errcode = '22023';
  end if;

  for v_key in select jsonb_object_keys(p_stats) loop
    if not (v_key = any (v_allowed_columns)) then
      raise exception 'unknown_stat_field: % is not a recognized hs_player_advanced_stats field', v_key using errcode = 'P0001';
    end if;
  end loop;

  perform 1 from public.hs_teams
   where id = p_team_id and org_id = p_org_id and program_id = p_program_id
   for update;
  if not found then
    raise exception 'team_not_found_for_org_program: %', p_team_id using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.hs_seasons
     where id = p_season_id and org_id = p_org_id and program_id = p_program_id
  ) then
    raise exception 'season_not_found_for_org_program: %', p_season_id using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.hs_players
     where id = p_player_id and org_id = p_org_id and program_id = p_program_id
  ) then
    raise exception 'player_not_found_for_org_program: %', p_player_id using errcode = 'P0002';
  end if;

  if p_import_run_id is not null then
    select * into v_run
      from public.hs_import_runs
     where id = p_import_run_id
       and org_id = p_org_id
       and program_id = p_program_id
       and team_id = p_team_id
       and season_id = p_season_id
     for update;
    if not found then
      raise exception 'import_run_not_found_for_org_team: %', p_import_run_id using errcode = 'P0002';
    end if;
    if v_run.status <> 'running' then
      raise exception 'invalid_import_run_state: run % has status %, expected running', p_import_run_id, v_run.status using errcode = 'P0001';
    end if;
  end if;

  select id into v_existing_current_id
    from public.hs_player_advanced_stats
   where player_id = p_player_id and team_id = p_team_id and season_id = p_season_id and is_current
   for update;

  if v_existing_current_id is not null and p_import_run_id is not null then
    select old_run.created_at into v_existing_run_created_at
      from public.hs_player_advanced_stats st
      join public.hs_import_runs old_run
        on old_run.id = st.import_run_id and old_run.org_id = st.org_id
     where st.id = v_existing_current_id
       and st.import_run_id is not null;

    if v_existing_run_created_at is not null and v_existing_run_created_at >= v_run.created_at then
      raise exception 'stale_import_run_publication: import run % is not newer than the run behind the currently published stats', p_import_run_id using errcode = 'P0001';
    end if;
  end if;

  if v_existing_current_id is not null then
    update public.hs_player_advanced_stats
       set is_current = false, superseded_at = now()
     where id = v_existing_current_id
       and is_current = true;
    get diagnostics v_affected = row_count;
    if v_affected <> 1 then
      raise exception 'concurrent_publication_conflict: could not supersede the current row for player %/team %/season %', p_player_id, p_team_id, p_season_id using errcode = '40001';
    end if;
  end if;

  -- Populate ONLY the stat columns from the (already allowlist-validated)
  -- jsonb blob; every hierarchy/identity/lifecycle column below is set
  -- explicitly from this function's own parameters, never from p_stats.
  v_stats_row := jsonb_populate_record(null::public.hs_player_advanced_stats, p_stats);

  insert into public.hs_player_advanced_stats (
    org_id, program_id, team_id, season_id, player_id, import_run_id,
    games, total_pitches, gb, fb, ld, batted_balls,
    gb_pct, fb_pct, ld_pct,
    spray_lf, spray_cf, spray_rf, spray_3b, spray_ss, spray_2b, spray_1b, spray_pc,
    spray_lf_pct, spray_cf_pct, spray_rf_pct, spray_3b_pct, spray_ss_pct, spray_2b_pct, spray_1b_pct, spray_pc_pct,
    risp_ab, risp_h, ba_risp,
    swing_decisions, spray_by_count,
    k_pct, bb_pct, errors, bunts,
    is_current, superseded_at, generated_at
  ) values (
    p_org_id, p_program_id, p_team_id, p_season_id, p_player_id, p_import_run_id,
    v_stats_row.games, v_stats_row.total_pitches, v_stats_row.gb, v_stats_row.fb, v_stats_row.ld, v_stats_row.batted_balls,
    v_stats_row.gb_pct, v_stats_row.fb_pct, v_stats_row.ld_pct,
    v_stats_row.spray_lf, v_stats_row.spray_cf, v_stats_row.spray_rf, v_stats_row.spray_3b, v_stats_row.spray_ss, v_stats_row.spray_2b, v_stats_row.spray_1b, v_stats_row.spray_pc,
    v_stats_row.spray_lf_pct, v_stats_row.spray_cf_pct, v_stats_row.spray_rf_pct, v_stats_row.spray_3b_pct, v_stats_row.spray_ss_pct, v_stats_row.spray_2b_pct, v_stats_row.spray_1b_pct, v_stats_row.spray_pc_pct,
    v_stats_row.risp_ab, v_stats_row.risp_h, v_stats_row.ba_risp,
    coalesce(v_stats_row.swing_decisions, '{}'::jsonb), coalesce(v_stats_row.spray_by_count, '{}'::jsonb),
    v_stats_row.k_pct, v_stats_row.bb_pct, coalesce(v_stats_row.errors, 0), coalesce(v_stats_row.bunts, 0),
    true, null, now()
  )
  returning * into v_new_row;

  return v_new_row;
end;
$function$;

revoke execute on function public.publish_hs_player_advanced_stats(uuid, uuid, uuid, uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.publish_hs_player_advanced_stats(uuid, uuid, uuid, uuid, uuid, uuid, jsonb) to postgres, service_role;

-- ── publish_hs_pitcher_advanced_stats ────────────────────────────────────
--
-- Deliberately a SEPARATE function body from the player-stats one above,
-- not a shared generic "publish stats" function parameterized by table
-- name -- see the task's own instruction to keep player/pitcher schemas
-- distinct rather than forcing them through a generic function that would
-- need dynamic SQL (and lose column-level type safety) to target either
-- table from one body.
create or replace function public.publish_hs_pitcher_advanced_stats(
  p_org_id uuid,
  p_program_id uuid,
  p_team_id uuid,
  p_season_id uuid,
  p_player_id uuid,
  p_import_run_id uuid,
  p_stats jsonb default '{}'::jsonb
)
returns public.hs_pitcher_advanced_stats
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_allowed_columns constant text[] := array[
    'games', 'total_pitches', 'strikes', 's_pct',
    'gb', 'fb', 'ld', 'gb_pct', 'fb_pct', 'ld_pct', 'go_ao',
    'so_per7', 'bb_per7', 'k_pct_bf', 'bb_pct_bf', 'p_per_ip',
    'wp', 'bk', 'pik'
  ];
  v_key text;
  v_run public.hs_import_runs%rowtype;
  v_existing_current_id uuid;
  v_existing_run_created_at timestamptz;
  v_affected int;
  v_stats_row public.hs_pitcher_advanced_stats;
  v_new_row public.hs_pitcher_advanced_stats%rowtype;
begin
  if p_org_id is null or p_program_id is null or p_team_id is null or p_season_id is null or p_player_id is null then
    raise exception 'org_id, program_id, team_id, season_id, and player_id are all required' using errcode = '22004';
  end if;
  if p_stats is null or jsonb_typeof(p_stats) <> 'object' then
    raise exception 'stats must be a JSON object' using errcode = '22023';
  end if;

  for v_key in select jsonb_object_keys(p_stats) loop
    if not (v_key = any (v_allowed_columns)) then
      raise exception 'unknown_stat_field: % is not a recognized hs_pitcher_advanced_stats field', v_key using errcode = 'P0001';
    end if;
  end loop;

  perform 1 from public.hs_teams
   where id = p_team_id and org_id = p_org_id and program_id = p_program_id
   for update;
  if not found then
    raise exception 'team_not_found_for_org_program: %', p_team_id using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.hs_seasons
     where id = p_season_id and org_id = p_org_id and program_id = p_program_id
  ) then
    raise exception 'season_not_found_for_org_program: %', p_season_id using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.hs_players
     where id = p_player_id and org_id = p_org_id and program_id = p_program_id
  ) then
    raise exception 'player_not_found_for_org_program: %', p_player_id using errcode = 'P0002';
  end if;

  if p_import_run_id is not null then
    select * into v_run
      from public.hs_import_runs
     where id = p_import_run_id
       and org_id = p_org_id
       and program_id = p_program_id
       and team_id = p_team_id
       and season_id = p_season_id
     for update;
    if not found then
      raise exception 'import_run_not_found_for_org_team: %', p_import_run_id using errcode = 'P0002';
    end if;
    if v_run.status <> 'running' then
      raise exception 'invalid_import_run_state: run % has status %, expected running', p_import_run_id, v_run.status using errcode = 'P0001';
    end if;
  end if;

  select id into v_existing_current_id
    from public.hs_pitcher_advanced_stats
   where player_id = p_player_id and team_id = p_team_id and season_id = p_season_id and is_current
   for update;

  if v_existing_current_id is not null and p_import_run_id is not null then
    select old_run.created_at into v_existing_run_created_at
      from public.hs_pitcher_advanced_stats st
      join public.hs_import_runs old_run
        on old_run.id = st.import_run_id and old_run.org_id = st.org_id
     where st.id = v_existing_current_id
       and st.import_run_id is not null;

    if v_existing_run_created_at is not null and v_existing_run_created_at >= v_run.created_at then
      raise exception 'stale_import_run_publication: import run % is not newer than the run behind the currently published stats', p_import_run_id using errcode = 'P0001';
    end if;
  end if;

  if v_existing_current_id is not null then
    update public.hs_pitcher_advanced_stats
       set is_current = false, superseded_at = now()
     where id = v_existing_current_id
       and is_current = true;
    get diagnostics v_affected = row_count;
    if v_affected <> 1 then
      raise exception 'concurrent_publication_conflict: could not supersede the current row for player %/team %/season %', p_player_id, p_team_id, p_season_id using errcode = '40001';
    end if;
  end if;

  v_stats_row := jsonb_populate_record(null::public.hs_pitcher_advanced_stats, p_stats);

  insert into public.hs_pitcher_advanced_stats (
    org_id, program_id, team_id, season_id, player_id, import_run_id,
    games, total_pitches, strikes, s_pct,
    gb, fb, ld, gb_pct, fb_pct, ld_pct, go_ao,
    so_per7, bb_per7, k_pct_bf, bb_pct_bf, p_per_ip,
    wp, bk, pik,
    is_current, superseded_at, generated_at
  ) values (
    p_org_id, p_program_id, p_team_id, p_season_id, p_player_id, p_import_run_id,
    v_stats_row.games, v_stats_row.total_pitches, v_stats_row.strikes, v_stats_row.s_pct,
    v_stats_row.gb, v_stats_row.fb, v_stats_row.ld, v_stats_row.gb_pct, v_stats_row.fb_pct, v_stats_row.ld_pct, v_stats_row.go_ao,
    v_stats_row.so_per7, v_stats_row.bb_per7, v_stats_row.k_pct_bf, v_stats_row.bb_pct_bf, v_stats_row.p_per_ip,
    coalesce(v_stats_row.wp, 0), coalesce(v_stats_row.bk, 0), coalesce(v_stats_row.pik, 0),
    true, null, now()
  )
  returning * into v_new_row;

  return v_new_row;
end;
$function$;

revoke execute on function public.publish_hs_pitcher_advanced_stats(uuid, uuid, uuid, uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.publish_hs_pitcher_advanced_stats(uuid, uuid, uuid, uuid, uuid, uuid, jsonb) to postgres, service_role;
