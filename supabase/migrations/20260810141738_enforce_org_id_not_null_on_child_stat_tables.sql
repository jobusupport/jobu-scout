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
-- ── Corrected after independent security review ──────────────────────────
-- This migration was edited in place (same filename/timestamp) rather
-- than superseded by a second forward migration. It has never been
-- applied to the production database -- only replayed against this PR's
-- own ephemeral Supabase Preview Branch, which is torn down and
-- regenerated fresh on every push -- so there is no already-applied
-- migration history to protect, and no "migration repair"/renumbering
-- concern. This is the same category of change as any other unmerged,
-- unapplied work-in-progress commit on an open PR; supabase/README.md's
-- "never edit a previously applied migration" guidance protects a
-- migration a real, persistent database has already recorded as applied,
-- which does not describe this file's current state.
--
-- The original version of this migration only detected and backfilled
-- NULL org_id values, and only re-checked for remaining NULLs before
-- adding NOT NULL. A pre-existing row with a NON-NULL org_id that
-- disagreed with its authoritative parent's org_id, or a row whose
-- game_id/team_id didn't resolve to any real parent at all, would have
-- silently passed through untouched and then received NOT NULL without
-- ever being validated. Independent review confirmed zero such rows
-- exist in production today (see below), but the migration itself did
-- not enforce that -- it relied entirely on a one-time, external,
-- read-only check rather than a self-contained, replay-safe guard. Step
-- 2 below now validates ALL THREE failure categories (remaining null,
-- orphaned/unresolvable parent, and non-null mismatch vs. the parent) for
-- every one of the five tables before any NOT NULL is added, so this
-- migration is correct on its own for any future or different database
-- state, not only today's already-consistent one.
--
-- ── Read-only verification performed before writing this migration ──────
-- Queried the live project directly (information_schema.columns,
-- aggregate counts and joins -- no row content read):
--   - org_id exists and is nullable on all five tables above; NOT NULL
--     already on games.org_id and teams.org_id.
--   - Every existing row (9,284 batting_lines / 2,038 pitching_lines /
--     27,300 play_events / 3,482 player_advanced_stats / 865
--     pitcher_advanced_stats -- 42,969 total) already has org_id
--     populated: zero NULLs.
--   - Zero rows where a row's org_id disagrees with its parent
--     games.org_id (via game_id) or teams.org_id (via team_id).
--   - Zero orphaned rows (every game_id/team_id resolves to a real
--     parent).
-- The backfill below is therefore expected to update zero rows in
-- production, and the Step 2 validation below is expected to find zero
-- failures -- both are included anyway (rather than skipped) so this
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
-- ── Staged so every row is guaranteed non-null AND parent-consistent
-- BEFORE the constraint is added, and the migration refuses (rather than
-- guesses, and rather than silently rewriting a conflicting non-null
-- value) if any row's parent can't be resolved deterministically or
-- disagrees with the row's existing org_id ──────────────────────────────

-- Step 1 -- deterministic backfill from each table's own authoritative
-- parent. Game-child tables inherit the parent game's org_id; team-child
-- (advanced-stat) tables inherit the parent team's org_id. Only ever
-- touches rows that are currently NULL -- never overwrites an existing
-- non-null value, conflicting or not (see Step 2, which instead fails
-- the migration on a conflict rather than silently correcting it). A row
-- whose parent doesn't resolve simply stays NULL and is caught by the
-- guard in Step 2.
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

-- Step 2 -- fail the migration outright (never delete, never guess, and
-- never silently rewrite a conflicting non-null value) unless every row
-- in every one of the five tables is fully valid: org_id is non-null,
-- its authoritative parent (game or team) actually exists, and org_id
-- exactly matches that parent's org_id. This catches three distinct
-- failure categories that Step 1's backfill deliberately does NOT
-- correct on its own:
--   - a null org_id that could not be backfilled (its parent doesn't
--     exist -- an orphaned row)
--   - a non-null org_id on a row whose parent doesn't exist at all (also
--     orphaned -- backfill never touched it because it wasn't null, but
--     its parentage still can't be verified)
--   - a non-null org_id that disagrees with its (real, existing)
--     parent's org_id -- a pre-existing mismatch Step 1's `... and
--     org_id is null` guard intentionally never touches, since silently
--     overwriting a conflicting value is exactly the kind of guess this
--     migration must not make
-- Error messages below report only aggregate counts per failure category
-- -- never row ids, player names, team names, or any other row content.
do $$
declare
  null_count bigint;
  orphan_count bigint;
  mismatch_count bigint;
begin
  select
    count(*) filter (where bl.org_id is null),
    count(*) filter (where g.id is null),
    count(*) filter (where g.id is not null and bl.org_id is not null and bl.org_id is distinct from g.org_id)
    into null_count, orphan_count, mismatch_count
  from public.batting_lines bl
  left join public.games g on g.id = bl.game_id;
  if null_count > 0 or orphan_count > 0 or mismatch_count > 0 then
    raise exception 'T3K: batting_lines failed pre-NOT-NULL validation -- % row(s) with unresolved null org_id, % row(s) with no resolvable parent game, % row(s) with a non-null org_id that disagrees with its parent game''s org_id. Refusing to add NOT NULL until each is resolved by a deliberate data decision.', null_count, orphan_count, mismatch_count;
  end if;

  select
    count(*) filter (where pl.org_id is null),
    count(*) filter (where g.id is null),
    count(*) filter (where g.id is not null and pl.org_id is not null and pl.org_id is distinct from g.org_id)
    into null_count, orphan_count, mismatch_count
  from public.pitching_lines pl
  left join public.games g on g.id = pl.game_id;
  if null_count > 0 or orphan_count > 0 or mismatch_count > 0 then
    raise exception 'T3K: pitching_lines failed pre-NOT-NULL validation -- % row(s) with unresolved null org_id, % row(s) with no resolvable parent game, % row(s) with a non-null org_id that disagrees with its parent game''s org_id. Refusing to add NOT NULL until each is resolved by a deliberate data decision.', null_count, orphan_count, mismatch_count;
  end if;

  select
    count(*) filter (where pe.org_id is null),
    count(*) filter (where g.id is null),
    count(*) filter (where g.id is not null and pe.org_id is not null and pe.org_id is distinct from g.org_id)
    into null_count, orphan_count, mismatch_count
  from public.play_events pe
  left join public.games g on g.id = pe.game_id;
  if null_count > 0 or orphan_count > 0 or mismatch_count > 0 then
    raise exception 'T3K: play_events failed pre-NOT-NULL validation -- % row(s) with unresolved null org_id, % row(s) with no resolvable parent game, % row(s) with a non-null org_id that disagrees with its parent game''s org_id. Refusing to add NOT NULL until each is resolved by a deliberate data decision.', null_count, orphan_count, mismatch_count;
  end if;

  select
    count(*) filter (where pas.org_id is null),
    count(*) filter (where t.id is null),
    count(*) filter (where t.id is not null and pas.org_id is not null and pas.org_id is distinct from t.org_id)
    into null_count, orphan_count, mismatch_count
  from public.player_advanced_stats pas
  left join public.teams t on t.id = pas.team_id;
  if null_count > 0 or orphan_count > 0 or mismatch_count > 0 then
    raise exception 'T3K: player_advanced_stats failed pre-NOT-NULL validation -- % row(s) with unresolved null org_id, % row(s) with no resolvable parent team, % row(s) with a non-null org_id that disagrees with its parent team''s org_id. Refusing to add NOT NULL until each is resolved by a deliberate data decision.', null_count, orphan_count, mismatch_count;
  end if;

  select
    count(*) filter (where pas.org_id is null),
    count(*) filter (where t.id is null),
    count(*) filter (where t.id is not null and pas.org_id is not null and pas.org_id is distinct from t.org_id)
    into null_count, orphan_count, mismatch_count
  from public.pitcher_advanced_stats pas
  left join public.teams t on t.id = pas.team_id;
  if null_count > 0 or orphan_count > 0 or mismatch_count > 0 then
    raise exception 'T3K: pitcher_advanced_stats failed pre-NOT-NULL validation -- % row(s) with unresolved null org_id, % row(s) with no resolvable parent team, % row(s) with a non-null org_id that disagrees with its parent team''s org_id. Refusing to add NOT NULL until each is resolved by a deliberate data decision.', null_count, orphan_count, mismatch_count;
  end if;
end $$;

-- Step 3 -- only now that every row is guaranteed non-null AND verified
-- consistent with its authoritative parent.
alter table public.batting_lines alter column org_id set not null;
alter table public.pitching_lines alter column org_id set not null;
alter table public.play_events alter column org_id set not null;
alter table public.player_advanced_stats alter column org_id set not null;
alter table public.pitcher_advanced_stats alter column org_id set not null;
