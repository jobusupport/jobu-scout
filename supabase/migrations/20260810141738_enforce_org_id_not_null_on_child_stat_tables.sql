-- Security Slice T3K: enforce org_id on child stat tables.
--
-- batting_lines, pitching_lines, play_events, player_advanced_stats, and
-- pitcher_advanced_stats already had an "org_id" uuid column (with a
-- foreign key to organizations(id)) since the foundational baseline
-- migration -- but it was nullable, with no database-level backstop
-- requiring it to be populated. src/db-supabase.js's insertBattingLines/
-- insertPitchingLines/insertPlayEvents/upsertPlayerAdvancedStats/
-- upsertPitcherAdvancedStats each guarded their own org_id assignment
-- behind tableHasOrgId(tableName) -- a live "select org_id ... limit 1"
-- capability probe originally written for a schema state where these
-- columns genuinely did not exist yet. That schema state no longer
-- exists (verified below), so the probe now only ever protects a
-- tenantless write from being silently accepted by a nullable column,
-- which is precisely the gap this migration closes at the database
-- layer -- the accompanying src/db-supabase.js change removes the
-- now-dead conditional and always attaches org_id.
--
-- ── Read-only verification performed before writing this migration ──────
-- Queried the live project directly (information_schema.columns,
-- aggregate counts and joins -- no row content read):
--   - org_id exists and is nullable on all five tables above; NOT NULL
--     already on games.org_id and teams.org_id.
--   - Every existing row (9,284 batting_lines / 2,038 pitching_lines /
--     27,300 play_events / 3,482 player_advanced_stats / 865
--     pitcher_advanced_stats) already has org_id populated: zero NULLs.
--   - Zero rows where a row's org_id disagrees with its parent
--     games.org_id (via game_id) or teams.org_id (via team_id).
--   - Zero orphaned rows (every game_id/team_id resolves to a real
--     parent).
-- The backfill below is therefore expected to update zero rows in
-- production -- it is included anyway (rather than skipped) so this
-- migration is correct and replay-safe from ANY prior state, including a
-- from-empty baseline replay or a future environment that genuinely has
-- gaps, not just today's already-consistent one.
--
-- scouting_reports also calls tableHasOrgId() but is deliberately NOT
-- touched here: it has no org_id column at all, no foreign key to
-- organizations, and zero rows in production -- a separate, unmigrated,
-- effectively-unused legacy table (superseded by the "reports" table,
-- which has always had NOT NULL org_id). Its own tableHasOrgId() check
-- continues to reflect its actual, still-partially-migrated schema state
-- and is left exactly as-is.
--
-- Unique constraints/upsert conflict targets are NOT changed here:
-- batting_lines/pitching_lines/play_events are already uniquely keyed by
-- game_id (plus player_name/is_our_team or sequence_num), and
-- player_advanced_stats/pitcher_advanced_stats by team_id (plus
-- player_name/is_our_team). game_id and team_id are themselves globally
-- unique and foreign-keyed to an org-owned parent (a game or team belongs
-- to exactly one organization), so these constraints -- and the matching
-- application onConflict targets -- are already tenant-safe without
-- adding org_id to them.
--
-- RLS is already enabled on all five tables with zero policies (default
-- deny for the anon/authenticated roles) -- confirmed via the project's
-- own security advisor. Every write path exercised here uses the
-- service-role connection, which bypasses RLS entirely, so this migration
-- does not touch RLS. The five relevant read RPCs
-- (get_team_batting_aggregates, get_team_pitching_aggregates,
-- get_recent_pitching_lines, get_active_roster_players,
-- get_team_play_tendencies) scope by team_id, which is already
-- tenant-unique for the same reason -- not touched either.
--
-- ── Staged so every row is guaranteed non-null BEFORE the constraint is
-- added, and the migration refuses (rather than guesses) if any row's
-- parent can't be resolved deterministically ────────────────────────────

-- Step 1 -- deterministic backfill from each table's own authoritative
-- parent. Game-child tables inherit the parent game's org_id; team-child
-- (advanced-stat) tables inherit the parent team's org_id. Never guesses:
-- a row whose parent doesn't resolve simply stays NULL and is caught by
-- the guard in Step 2.
update public.batting_lines bl
   set org_id = g.org_id
  from public.games g
 where g.id = bl.game_id
   and bl.org_id is null;

update public.pitching_lines pl
   set org_id = g.org_id
  from public.games g
 where g.id = pl.game_id
   and pl.org_id is null;

update public.play_events pe
   set org_id = g.org_id
  from public.games g
 where g.id = pe.game_id
   and pe.org_id is null;

update public.player_advanced_stats pas
   set org_id = t.org_id
  from public.teams t
 where t.id = pas.team_id
   and pas.org_id is null;

update public.pitcher_advanced_stats pas
   set org_id = t.org_id
  from public.teams t
 where t.id = pas.team_id
   and pas.org_id is null;

-- Step 2 -- fail the migration outright (never delete or guess) if any
-- row still has no org_id after the backfill above, e.g. because its
-- game_id/team_id doesn't resolve to a real parent. Explicitly not a
-- silent skip: an unresolvable row here is a data-integrity condition
-- that needs a deliberate decision, not a schema change.
do $$
declare
  remaining bigint;
begin
  select count(*) into remaining from public.batting_lines where org_id is null;
  if remaining > 0 then
    raise exception 'T3K: % batting_lines row(s) still have NULL org_id after backfill -- refusing to add NOT NULL. Investigate orphaned game_id values before re-running.', remaining;
  end if;

  select count(*) into remaining from public.pitching_lines where org_id is null;
  if remaining > 0 then
    raise exception 'T3K: % pitching_lines row(s) still have NULL org_id after backfill -- refusing to add NOT NULL. Investigate orphaned game_id values before re-running.', remaining;
  end if;

  select count(*) into remaining from public.play_events where org_id is null;
  if remaining > 0 then
    raise exception 'T3K: % play_events row(s) still have NULL org_id after backfill -- refusing to add NOT NULL. Investigate orphaned game_id values before re-running.', remaining;
  end if;

  select count(*) into remaining from public.player_advanced_stats where org_id is null;
  if remaining > 0 then
    raise exception 'T3K: % player_advanced_stats row(s) still have NULL org_id after backfill -- refusing to add NOT NULL. Investigate orphaned team_id values before re-running.', remaining;
  end if;

  select count(*) into remaining from public.pitcher_advanced_stats where org_id is null;
  if remaining > 0 then
    raise exception 'T3K: % pitcher_advanced_stats row(s) still have NULL org_id after backfill -- refusing to add NOT NULL. Investigate orphaned team_id values before re-running.', remaining;
  end if;
end $$;

-- Step 3 -- only now that every row is guaranteed non-null.
alter table public.batting_lines alter column org_id set not null;
alter table public.pitching_lines alter column org_id set not null;
alter table public.play_events alter column org_id set not null;
alter table public.player_advanced_stats alter column org_id set not null;
alter table public.pitcher_advanced_stats alter column org_id set not null;
