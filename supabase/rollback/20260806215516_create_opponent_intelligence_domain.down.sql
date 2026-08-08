-- Down migration for 20260806031303_create_opponent_intelligence_domain.sql.
--
-- Pre-adoption-only safety boundary (matches supabase/README.md's existing
-- convention): safe to run manually before any real coach has entered
-- opponent-roster data or scouting notes through this domain. Once real
-- data exists, running this drops it irretrievably -- a deliberate,
-- documented data-export step is required first, not a blind re-run of
-- this file. See supabase/README.md's "Down migrations" section.
--
-- Drops in strict reverse-dependency order: coach_scouting_notes and
-- opponent_roster_import_conflicts and opponent_roster_memberships all
-- reference opponent_players, which must go last among the new tables.
-- The two composite unique constraints added to the pre-existing
-- teams/games tables are dropped last of all, after nothing new
-- references them.

drop function if exists public.merge_opponent_players(uuid, uuid, uuid, uuid);
drop table if exists public.coach_scouting_notes;
drop table if exists public.opponent_roster_import_conflicts;
drop table if exists public.opponent_roster_memberships;
drop table if exists public.opponent_players;

alter table public."games" drop constraint if exists "games_org_id_id_key";
alter table public."teams" drop constraint if exists "teams_org_id_id_key";
