-- Corrective migration for Phase 4 schema-diff gaps found against production.
-- See supabase/README.md for the full explanation of why this exists.
--
-- Why this is a SEPARATE file instead of edits to the files that originally
-- should have contained these statements (20260620000000/1/2): this branch
-- had already applied those versions before the gaps were discovered.
-- Supabase's migration runner tracks applied state by version number, not
-- content hash -- editing an already-applied file's content is a no-op on
-- a branch that's already run it (confirmed empirically: a rebuild after
-- editing those files logged "All migrations are up to date" and skipped
-- them entirely). Those files were still corrected in place, since they
-- remain the right source of truth for a fresh, from-scratch apply of this
-- baseline (e.g. disaster recovery) -- but making the already-provisioned
-- Preview Branch actually reflect the fix requires a new migration version,
-- exactly as it would in production: migration history is never rewritten
-- after the fact, only appended to.

-- ── Missing FK (file 1) ──────────────────────────────────────────────────
alter table public."profiles" add constraint "profiles_id_fkey" foreign key ("id") references auth."users" ("id") on delete cascade;

-- ── Missing unique constraints (file 20260620000001) ────────────────────
alter table public."admin_support_sessions" add constraint "admin_support_sessions_token_key" unique ("token");
alter table public."ai_usage_events" add constraint "ai_usage_events_idempotency_key_key" unique ("idempotency_key");
alter table public."feature_flags" add constraint "feature_flags_key_key" unique ("key");
alter table public."platform_admins" add constraint "platform_admins_user_id_key" unique ("user_id");
alter table public."player_gc_spray_charts" add constraint "player_gc_spray_charts_team_id_jersey_number_category_key" unique ("team_id", "jersey_number", "category");
alter table public."player_gc_stats" add constraint "player_gc_stats_team_id_jersey_number_category_key" unique ("team_id", "jersey_number", "category");
alter table public."player_handedness" add constraint "player_handedness_team_id_jersey_number_key" unique ("team_id", "jersey_number");

-- ── Missing FKs to auth.users (file 20260620000001) ──────────────────────
alter table public."admin_audit_log" add constraint "admin_audit_log_admin_user_id_fkey" foreign key ("admin_user_id") references auth."users" ("id");
alter table public."admin_support_sessions" add constraint "admin_support_sessions_admin_user_id_fkey" foreign key ("admin_user_id") references auth."users" ("id");
alter table public."ai_usage_events" add constraint "ai_usage_events_user_id_fkey" foreign key ("user_id") references auth."users" ("id");
alter table public."org_entitlement_overrides" add constraint "org_entitlement_overrides_created_by_fkey" foreign key ("created_by") references auth."users" ("id");
alter table public."org_support_notes" add constraint "org_support_notes_admin_user_id_fkey" foreign key ("admin_user_id") references auth."users" ("id");
alter table public."platform_admins" add constraint "platform_admins_created_by_fkey" foreign key ("created_by") references auth."users" ("id");
alter table public."platform_admins" add constraint "platform_admins_user_id_fkey" foreign key ("user_id") references auth."users" ("id") on delete cascade;
alter table public."platform_settings" add constraint "platform_settings_credit_balance_verified_by_fkey" foreign key ("credit_balance_verified_by") references auth."users" ("id");
alter table public."platform_settings" add constraint "platform_settings_updated_by_fkey" foreign key ("updated_by") references auth."users" ("id");

-- ── Over-permissive function grants (file 20260620000002) ────────────────
-- Both functions were already created (via CREATE OR REPLACE, which is
-- itself idempotent), so only the grants need correcting here.
revoke execute on function public.admin_dashboard_metrics() from public, anon, authenticated;
grant execute on function public.admin_dashboard_metrics() to postgres, service_role;

revoke execute on function public.is_jobu_admin(uuid) from public, anon;
grant execute on function public.is_jobu_admin(uuid) to authenticated, postgres, service_role;
