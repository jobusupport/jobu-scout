-- Down migration for 20260803120000_add_hs_player_lifecycle_status.sql.
--
-- Reference file for the pre-adoption window only, per supabase/README.md's
-- existing rollback convention (see that file's "Down migrations" section)
-- -- safe to run manually only before any real, coach-assigned non-'active'
-- status exists in production. Not a general-purpose rollback tool.
--
-- *** ROLLING BACK THIS MIGRATION LOSES INFORMATION. ***
-- A player recorded as 'graduated', 'transferred', or 'not_participating'
-- collapses to is_active=false with no record of WHICH of those it was --
-- indistinguishable from every other non-active reason, including the
-- original pre-migration ambiguity this slice exists to resolve. This is a
-- one-way loss, not a symmetric round-trip: status='active' restores to
-- is_active=true exactly, but every non-active status restores to the same
-- is_active=false with its specific reason discarded.
--
-- Once any organization has a real non-'active' status assigned, do not run
-- this file as an incident response -- export the status column for every
-- non-'active' row first, as a deliberate, documented decommission
-- decision. The safest rollback at any point remains reverting the
-- application code that reads/writes status, never this schema rollback,
-- per supabase/README.md's general guidance.

alter table public.hs_players drop column "is_active";
alter table public.hs_players add column "is_active" boolean not null default true;
update public.hs_players set "is_active" = ("status" = 'active');
alter table public.hs_players drop constraint "hs_players_status_check";
alter table public.hs_players drop column "status";
