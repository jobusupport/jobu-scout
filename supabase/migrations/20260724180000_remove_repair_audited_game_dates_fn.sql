-- Removes the temporary, one-time repair RPC introduced in
-- 20260724000000_repair_audited_game_dates_fn.sql, now that the single
-- authorized repair invocation has completed and been independently
-- verified: all 13 audited games hold their exact repaired game_date,
-- both legitimate May-24 games are unchanged, and all 26 associated
-- game_stat_validation_results rows are untouched. See that migration's
-- own header comment and src/repairs/README.md for the full history.
--
-- This function has no purpose once its one-time repair has been applied
-- and confirmed -- its continued existence is pure attack surface (a
-- SECURITY DEFINER function, even one this narrowly scoped, is something
-- to remove rather than leave lying around once it's done its job).
--
-- Revoke-then-drop, not drop-alone: belt-and-suspenders against a
-- hypothetical intervening grant this migration didn't originate (the
-- deploying role, `postgres`, is already the function's owner and a
-- superuser, so revoking its own EXECUTE privilege here is a no-op in
-- practice, not a behavior change -- included anyway for an explicit,
-- self-documenting revoke list rather than relying on ownership alone).
--
-- The DROP below names the function's exact schema-qualified signature,
-- `public.repair_audited_game_dates(text)`, with no IF EXISTS -- if the
-- deployed function is missing or its signature has drifted from what
-- this migration expects, this statement fails the migration outright
-- instead of silently no-op'ing past an unexpected state.
--
-- This migration performs no data manipulation: no INSERT/UPDATE/DELETE/
-- TRUNCATE/MERGE, no dynamic SQL, and no reference anywhere to
-- public.games or public.game_stat_validation_results.

revoke execute on function public.repair_audited_game_dates(text) from public, anon, authenticated, service_role, postgres;

drop function public.repair_audited_game_dates(text);
