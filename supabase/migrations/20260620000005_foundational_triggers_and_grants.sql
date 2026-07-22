-- Foundational schema baseline (Slice 1 branch-validation follow-up), part 5 of 6.
-- See supabase/README.md for the full explanation of why this exists.
-- Reconstructed via read-only introspection (Supabase list_tables +
-- information_schema/pg_catalog queries), NOT a pg_dump/db push output.

-- ── Triggers on foundational tables ─────────────────────────────────────
create trigger trg_at_bats_updated_at before update on public."at_bats" for each row execute function set_updated_at();
create trigger trg_games_updated_at before update on public."games" for each row execute function set_updated_at();
create trigger trg_org_members_updated_at before update on public."org_members" for each row execute function set_updated_at();
create trigger trg_organizations_updated_at before update on public."organizations" for each row execute function set_updated_at();
create trigger trg_players_updated_at before update on public."players" for each row execute function set_updated_at();
create trigger trg_profiles_updated_at before update on public."profiles" for each row execute function set_updated_at();
create trigger trg_reports_updated_at before update on public."reports" for each row execute function set_updated_at();
create trigger trg_teams_updated_at before update on public."teams" for each row execute function set_updated_at();

-- ── Triggers on tracked-migration tables ────────────────────────────────
create trigger feature_flags_set_updated_at before update on public."feature_flags" for each row execute function set_updated_at();
create trigger platform_settings_set_updated_at before update on public."platform_settings" for each row execute function set_updated_at();

-- on_auth_user_created is on auth.users (Supabase-managed schema), not
-- public -- included because Jobu Scout's own handle_new_user() function
-- (file 2) depends on this trigger existing to ever be called.
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ── Event trigger ───────────────────────────────────────────────────────
-- Jobu-Scout-owned (function defined in file 2). Explains why every table
-- in this project has rls_enabled=true: it's automatic on CREATE TABLE,
-- not set per-migration. The five other event triggers found on this
-- project (issue_graphql_placeholder, pgrst_ddl_watch, pgrst_drop_watch,
-- issue_pg_cron_access, issue_pg_net_access, issue_pg_graphql_access) are
-- Supabase-managed internal plumbing present on every Supabase project --
-- deliberately excluded per the instruction not to include Supabase-
-- managed objects Jobu Scout doesn't itself depend on.
do $$ begin
  create event trigger ensure_rls on ddl_command_end
    when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
    execute function public.rls_auto_enable();
exception when duplicate_object then null; end $$;

-- ── Grants ──────────────────────────────────────────────────────────────
-- Verified via information_schema.role_table_grants: every foundational
-- and tracked-migration table receives Supabase's standard full grant set
-- (anon, authenticated, service_role) automatically -- no custom GRANT
-- statements needed for tables. The one object in the whole project with
-- non-default grants, admin_customer_overview (service_role only), is
-- handled explicitly in file 3 where that view is created, alongside the
-- is_jobu_admin() function grant tightening handled in file 2.
