-- Down migration for 20260810141738_enforce_org_id_not_null_on_child_stat_tables.sql.
--
-- Reference file for the pre-adoption window only, per supabase/README.md's
-- existing rollback convention (see that file's "Down migrations" section)
-- -- not a general-purpose rollback tool.
--
-- Unlike most schema rollbacks in this directory, this one is LOSSLESS:
-- dropping a NOT NULL constraint discards no data and no information --
-- every row's org_id value (backfilled deterministically from its actual
-- parent game/team, never guessed) is left exactly as-is. The only
-- effect of running this file is that the database stops rejecting a
-- future tenantless insert on these five tables; it does not undo the
-- backfill itself (there is nothing to undo -- the backfilled values are
-- correct and staying populated is strictly safer than reintroducing the
-- gap).
--
-- Running this file alone does not restore the removed
-- tableHasOrgId()-conditional behavior in src/db-supabase.js -- that is
-- an application code change, reverted independently by reverting this
-- slice's commit if ever needed.

alter table public.batting_lines alter column org_id drop not null;
alter table public.pitching_lines alter column org_id drop not null;
alter table public.play_events alter column org_id drop not null;
alter table public.player_advanced_stats alter column org_id drop not null;
alter table public.pitcher_advanced_stats alter column org_id drop not null;
