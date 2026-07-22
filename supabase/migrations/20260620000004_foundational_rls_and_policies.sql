-- Foundational schema baseline (Slice 1 branch-validation follow-up), part 4 of 6.
-- See supabase/README.md for the full explanation of why this exists.
-- Reconstructed via read-only introspection (Supabase list_tables +
-- information_schema/pg_catalog queries), NOT a pg_dump/db push output.

-- Every one of these 21 tables has rls_enabled=true in production, via
-- the ensure_rls event trigger (file 5) -- enabling it explicitly here
-- too so the behavior is correct even before that event trigger exists
-- or if it's ever disabled. 11 of these 21 tables have RLS enabled with
-- ZERO policies defined -- Postgres's fail-closed RLS default means
-- those tables are completely inaccessible to any non-service-role
-- client. That's intentional and verified, not an oversight: only
-- service-role (which bypasses RLS entirely) touches those tables today.

alter table public."at_bats" enable row level security;
alter table public."batting_lines" enable row level security;
alter table public."derived_team_verified_totals" enable row level security;
alter table public."game_stat_validation_results" enable row level security;
alter table public."games" enable row level security;
alter table public."org_members" enable row level security;
alter table public."organizations" enable row level security;
alter table public."pitcher_advanced_stats" enable row level security;
alter table public."pitches" enable row level security;
alter table public."pitching_lines" enable row level security;
alter table public."play_events" enable row level security;
alter table public."player_advanced_stats" enable row level security;
alter table public."players" enable row level security;
alter table public."profiles" enable row level security;
alter table public."reports" enable row level security;
alter table public."scouting_feedback_submissions" enable row level security;
alter table public."scouting_reports" enable row level security;
alter table public."scrape_jobs" enable row level security;
alter table public."stat_validation_runs" enable row level security;
alter table public."stripe_webhook_events" enable row level security;
alter table public."teams" enable row level security;

-- ── Policies (only the 10 of 21 foundational tables that have any) ──────
create policy "at_bats_insert" on public."at_bats"
  for INSERT
  with check ((org_id IN ( SELECT org_members.org_id
   FROM org_members
  WHERE ((org_members.user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['admin'::org_role, 'coach'::org_role])) AND (org_members.accepted_at IS NOT NULL)))));

create policy "at_bats_select" on public."at_bats"
  for SELECT
  using ((org_id IN ( SELECT auth_user_org_ids() AS auth_user_org_ids)));

create policy "games_insert" on public."games"
  for INSERT
  with check ((org_id IN ( SELECT org_members.org_id
   FROM org_members
  WHERE ((org_members.user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['admin'::org_role, 'coach'::org_role])) AND (org_members.accepted_at IS NOT NULL)))));

create policy "games_select" on public."games"
  for SELECT
  using ((org_id IN ( SELECT auth_user_org_ids() AS auth_user_org_ids)));

create policy "games_update" on public."games"
  for UPDATE
  using ((org_id IN ( SELECT org_members.org_id
   FROM org_members
  WHERE ((org_members.user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['admin'::org_role, 'coach'::org_role])) AND (org_members.accepted_at IS NOT NULL)))));

create policy "org_members_delete" on public."org_members"
  for DELETE
  using (((org_id IN ( SELECT org_members_1.org_id
   FROM org_members org_members_1
  WHERE ((org_members_1.user_id = auth.uid()) AND (org_members_1.role = 'admin'::org_role) AND (org_members_1.accepted_at IS NOT NULL)))) OR (user_id = auth.uid())));

create policy "org_members_insert" on public."org_members"
  for INSERT
  with check ((org_id IN ( SELECT org_members_1.org_id
   FROM org_members org_members_1
  WHERE ((org_members_1.user_id = auth.uid()) AND (org_members_1.role = 'admin'::org_role) AND (org_members_1.accepted_at IS NOT NULL)))));

create policy "org_members_select" on public."org_members"
  for SELECT
  using ((org_id IN ( SELECT auth_user_org_ids() AS auth_user_org_ids)));

create policy "orgs_select" on public."organizations"
  for SELECT
  using ((id IN ( SELECT auth_user_org_ids() AS auth_user_org_ids)));

create policy "orgs_update" on public."organizations"
  for UPDATE
  using ((id IN ( SELECT org_members.org_id
   FROM org_members
  WHERE ((org_members.user_id = auth.uid()) AND (org_members.role = 'admin'::org_role) AND (org_members.accepted_at IS NOT NULL)))));

create policy "pitches_insert" on public."pitches"
  for INSERT
  with check ((org_id IN ( SELECT org_members.org_id
   FROM org_members
  WHERE ((org_members.user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['admin'::org_role, 'coach'::org_role])) AND (org_members.accepted_at IS NOT NULL)))));

create policy "pitches_select" on public."pitches"
  for SELECT
  using ((org_id IN ( SELECT auth_user_org_ids() AS auth_user_org_ids)));

create policy "players_insert" on public."players"
  for INSERT
  with check ((org_id IN ( SELECT org_members.org_id
   FROM org_members
  WHERE ((org_members.user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['admin'::org_role, 'coach'::org_role])) AND (org_members.accepted_at IS NOT NULL)))));

create policy "players_select" on public."players"
  for SELECT
  using ((org_id IN ( SELECT auth_user_org_ids() AS auth_user_org_ids)));

create policy "players_update" on public."players"
  for UPDATE
  using ((org_id IN ( SELECT org_members.org_id
   FROM org_members
  WHERE ((org_members.user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['admin'::org_role, 'coach'::org_role])) AND (org_members.accepted_at IS NOT NULL)))));

create policy "profiles_insert" on public."profiles"
  for INSERT
  with check ((id = auth.uid()));

create policy "profiles_select" on public."profiles"
  for SELECT
  using ((id = auth.uid()));

create policy "profiles_update" on public."profiles"
  for UPDATE
  using ((id = auth.uid()));

create policy "reports_insert" on public."reports"
  for INSERT
  with check ((org_id IN ( SELECT org_members.org_id
   FROM org_members
  WHERE ((org_members.user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['admin'::org_role, 'coach'::org_role])) AND (org_members.accepted_at IS NOT NULL)))));

create policy "reports_select" on public."reports"
  for SELECT
  using ((org_id IN ( SELECT auth_user_org_ids() AS auth_user_org_ids)));

create policy "reports_update" on public."reports"
  for UPDATE
  using ((org_id IN ( SELECT org_members.org_id
   FROM org_members
  WHERE ((org_members.user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['admin'::org_role, 'coach'::org_role])) AND (org_members.accepted_at IS NOT NULL)))));

create policy "scrape_jobs_insert" on public."scrape_jobs"
  for INSERT
  with check ((org_id IN ( SELECT org_members.org_id
   FROM org_members
  WHERE ((org_members.user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['admin'::org_role, 'coach'::org_role])) AND (org_members.accepted_at IS NOT NULL)))));

create policy "scrape_jobs_select" on public."scrape_jobs"
  for SELECT
  using ((org_id IN ( SELECT auth_user_org_ids() AS auth_user_org_ids)));

create policy "teams_delete" on public."teams"
  for DELETE
  using ((org_id IN ( SELECT org_members.org_id
   FROM org_members
  WHERE ((org_members.user_id = auth.uid()) AND (org_members.role = 'admin'::org_role) AND (org_members.accepted_at IS NOT NULL)))));

create policy "teams_insert" on public."teams"
  for INSERT
  with check ((org_id IN ( SELECT org_members.org_id
   FROM org_members
  WHERE ((org_members.user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['admin'::org_role, 'coach'::org_role])) AND (org_members.accepted_at IS NOT NULL)))));

create policy "teams_select" on public."teams"
  for SELECT
  using ((org_id IN ( SELECT auth_user_org_ids() AS auth_user_org_ids)));

create policy "teams_update" on public."teams"
  for UPDATE
  using ((org_id IN ( SELECT org_members.org_id
   FROM org_members
  WHERE ((org_members.user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['admin'::org_role, 'coach'::org_role])) AND (org_members.accepted_at IS NOT NULL)))));

-- ── RLS for tracked-migration tables ─────────────────────────────────────
-- All 12 have rls_enabled=true in production. 5 of them (platform_admins,
-- player_handedness, player_gc_stats, player_gc_spray_charts,
-- roster_players) have zero policies -- same fail-closed-to-service-role-
-- only pattern as 11 of the 21 foundational tables.
alter table public."platform_admins" enable row level security;
alter table public."admin_audit_log" enable row level security;
alter table public."org_entitlement_overrides" enable row level security;
alter table public."org_support_notes" enable row level security;
alter table public."admin_support_sessions" enable row level security;
alter table public."ai_usage_events" enable row level security;
alter table public."feature_flags" enable row level security;
alter table public."platform_settings" enable row level security;
alter table public."player_handedness" enable row level security;
alter table public."player_gc_stats" enable row level security;
alter table public."player_gc_spray_charts" enable row level security;
alter table public."roster_players" enable row level security;

create policy "admin_audit_log_select_admin" on public."admin_audit_log"
  for SELECT
  using (is_jobu_admin());

create policy "admin_support_sessions_select_admin" on public."admin_support_sessions"
  for SELECT
  using (is_jobu_admin());

create policy "ai_usage_events_select_admin" on public."ai_usage_events"
  for SELECT
  using (is_jobu_admin());

create policy "feature_flags_select_authenticated" on public."feature_flags"
  for SELECT
  using ((auth.uid() IS NOT NULL));

create policy "feature_flags_write_admin" on public."feature_flags"
  for ALL
  using (is_jobu_admin())
  with check (is_jobu_admin());

create policy "org_entitlement_overrides_select_admin" on public."org_entitlement_overrides"
  for SELECT
  using (is_jobu_admin());

create policy "org_support_notes_select_admin" on public."org_support_notes"
  for SELECT
  using (is_jobu_admin());

create policy "platform_settings_select_admin" on public."platform_settings"
  for SELECT
  using (is_jobu_admin());
