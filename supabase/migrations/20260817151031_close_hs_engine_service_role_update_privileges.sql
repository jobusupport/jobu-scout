-- Slice 2C forward privilege correction.
--
-- Hosted Supabase default privileges grant service_role ALL (arwdDxtm) on newly
-- created public tables, so creating the Slice 2C tables left UPDATE and MAINTAIN
-- in place beyond what public.persist_hs_engine_collection(jsonb) actually needs.
-- The RPC only selects from and inserts into the alias, resolution, and
-- noncanonical-stat tables (aliases and resolutions use ON CONFLICT DO NOTHING,
-- which requires no UPDATE). UPDATE is required solely on hs_stat_generations,
-- which the RPC locks FOR UPDATE and updates to supersede prior generations.
-- MAINTAIN is required nowhere.

revoke update
on table public.hs_game_identity_aliases,
         public.hs_game_identity_resolutions,
         public.hs_noncanonical_player_stats
from service_role;

revoke maintain
on table public.hs_game_identity_aliases,
         public.hs_game_identity_resolutions,
         public.hs_stat_generations,
         public.hs_noncanonical_player_stats
from service_role;
