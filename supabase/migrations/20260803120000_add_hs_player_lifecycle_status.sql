-- HS player lifecycle status (Slice: HS Player Lifecycle Status).
--
-- hs_players.is_active was a single boolean conflating five distinct
-- real-world states -- active, graduated, transferred, not participating,
-- and any other non-returning reason -- with no way to tell them apart and
-- no explicit reactivation semantic beyond re-toggling the same flag. This
-- migration adds a real status lifecycle without discarding any existing
-- row's actual state and without breaking the existing, currently-tested
-- is_active request contract (src/high-school-roster-service.js keeps
-- accepting is_active as a compatibility input -- see that file's own
-- comment for the mapping/conflict policy).
--
-- ── Dependency check performed before writing this migration ────────────
-- Grepped every migration file, every RLS policy, every SECURITY DEFINER
-- function (both publish_hs_player_advanced_stats and
-- publish_hs_pitcher_advanced_stats only check hs_players existence by
-- id/org_id/program_id, never is_active -- see
-- 20260729190000_add_hs_publish_rpcs.sql), every view (none reference
-- hs_players at all -- see 20260620000003_foundational_views_and_indexes.sql),
-- and every index/trigger on hs_players
-- (20260724221500_create_high_school_domain.sql) -- nothing depends on
-- is_active's current type or writability. Dropping and recreating it as a
-- generated column below is safe with respect to every other database
-- object in this schema. Application code was grepped the same way: only
-- src/high-school-roster-service.js ever writes to hs_players (createPlayer/
-- updatePlayer); every other reference across src/ is a read-only .select()
-- (src/high-school-api.js's roster route, src/high-school-import-routes.js's
-- GC candidate-matching lookup) or a comment/parameter-shape reference in
-- the still-unwired src/high-school-importer-contract.js.
--
-- ── Why this is staged, not a single ALTER ───────────────────────────────
-- Steps below run in this exact order, inside this migration's own
-- transaction, specifically so status is always fully backfilled and
-- constrained BEFORE is_active is ever touched, and is_active is never
-- dropped before every row's information is already preserved in status:
--   1. add status, nullable, no constraint yet (permits backfilling before
--      anything requires every row to already be valid)
--   2. backfill status from each row's ACTUAL is_active value -- true rows
--      become 'active', false rows become 'other_non_returning' (the
--      conservative legacy mapping: the database has no way to know
--      whether a legacy is_active=false row was graduated, transferred, or
--      something else, so it is never guessed as either)
--   3. add the five-value CHECK constraint, only now that every row
--      already satisfies it
--   4. set NOT NULL + default 'active', only now that every row is
--      already guaranteed non-null
--   5. only now: drop the plain is_active column and recreate it as a
--      generated column derived from status, so every existing reader of
--      is_active keeps working unchanged and no writer (application code or
--      otherwise) can ever produce an inconsistent is_active/status pair at
--      the database layer
--
-- No other table, view, RLS policy, function, index, or trigger is touched
-- by this migration. hs_players_select (RLS) is unchanged -- it never
-- referenced is_active and still doesn't.

-- Step 1
alter table public.hs_players add column "status" text;

-- Step 2 -- backfill from the REAL, current is_active value of every row,
-- never a blanket default. This is what makes the difference between
-- "every row becomes active" (wrong) and "every row keeps its actual
-- state" (required).
update public.hs_players
   set "status" = case when "is_active" then 'active' else 'other_non_returning' end;

-- Step 3
alter table public.hs_players
  add constraint "hs_players_status_check"
  check ("status" = any (array['active'::text, 'graduated'::text, 'transferred'::text, 'not_participating'::text, 'other_non_returning'::text]));

-- Step 4
alter table public.hs_players alter column "status" set default 'active';
alter table public.hs_players alter column "status" set not null;

-- Step 5 -- is_active becomes a read-only, always-consistent derivation of
-- status. Confirmed safe: no view, function, RLS policy, index, or other
-- generated column in this schema references hs_players.is_active (see
-- header comment).
alter table public.hs_players drop column "is_active";
alter table public.hs_players add column "is_active" boolean
  generated always as ("status" = 'active') stored;
