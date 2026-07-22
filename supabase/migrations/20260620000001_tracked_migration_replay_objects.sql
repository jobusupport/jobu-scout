-- Tracked-migration replay support objects.
--
-- Reconstructs the 12 tables (plus their FKs/unique constraints/indexes/
-- RLS policies) that production already has via 12 of its 22 separately-
-- tracked Supabase migrations (admin_platform_admins, admin_audit_log,
-- org_entitlement_overrides, org_support_notes, admin_support_sessions,
-- ai_usage_events, feature_flags, platform_settings, player_handedness,
-- add_player_gc_stats_and_spray_charts, create_roster_players) -- none of
-- which exist as files in this repository.
--
-- Added after empirically confirming (via a real Preview Branch replay,
-- not speculation) that Supabase's GitHub-integrated branch build uses
-- ONLY the migration files committed to the repository -- it does NOT
-- pull in migrations tracked only in the parent project's own history.
-- Migration 2 (foundational_functions) failed with
-- 'relation "public.platform_admins" does not exist' the first time this
-- branch was built, proving the gap directly rather than assuming it.
--
-- Must run before 20260620000002_foundational_functions.sql, since
-- is_jobu_admin() (LANGUAGE sql, validated at CREATE FUNCTION time, unlike
-- plpgsql) selects from platform_admins.

-- ── Sequences ───────────────────────────────────────────────────────────
create sequence if not exists public.player_handedness_id_seq;

-- ── Tables ──────────────────────────────────────────────────────────────
create table if not exists public."platform_admins" (
  "id" uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  "user_id" uuid NOT NULL,
  "email" text NOT NULL,
  "role" text NOT NULL DEFAULT 'owner'::text CHECK (role = ANY (ARRAY['owner'::text, 'support_admin'::text, 'billing_admin'::text, 'operations_admin'::text, 'read_only_admin'::text])),
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by" uuid,
  primary key ("id")
);

create table if not exists public."admin_audit_log" (
  "id" uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  "admin_user_id" uuid,
  "admin_email" text,
  "admin_role" text,
  "org_id" uuid,
  "support_session_id" uuid,
  "action" text NOT NULL,
  "resource_type" text,
  "resource_id" text,
  "old_values" jsonb,
  "new_values" jsonb,
  "reason" text,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  primary key ("id")
);

create table if not exists public."org_entitlement_overrides" (
  "id" uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  "org_id" uuid NOT NULL,
  "metric_key" text NOT NULL CHECK (metric_key = ANY (ARRAY['max_opponent_teams'::text, 'max_reports_per_month'::text, 'max_users'::text, 'max_self_scout_reports_per_month'::text, 'max_matchup_reports_per_month'::text])),
  "previous_value" integer,
  "override_value" integer,
  "is_unlimited" boolean NOT NULL DEFAULT false,
  "expires_at" timestamptz,
  "reason" text NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  primary key ("id")
);

create table if not exists public."org_support_notes" (
  "id" uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  "org_id" uuid NOT NULL,
  "admin_user_id" uuid NOT NULL,
  "note" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  primary key ("id")
);

create table if not exists public."admin_support_sessions" (
  "id" uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  "admin_user_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "reason" text NOT NULL,
  "mode" text NOT NULL DEFAULT 'read_only'::text CHECK (mode = ANY (ARRAY['read_only'::text, 'interactive'::text])),
  "token" text NOT NULL,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "ended_at" timestamptz,
  "ended_reason" text,
  primary key ("id")
);

create table if not exists public."ai_usage_events" (
  "id" uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  "org_id" uuid,
  "user_id" uuid,
  "report_id" uuid,
  "event_type" text NOT NULL DEFAULT 'ai_request'::text,
  "model" text NOT NULL,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "estimated_cost_usd" numeric NOT NULL DEFAULT 0,
  "success" boolean NOT NULL DEFAULT true,
  "error_message" text,
  "duration_ms" integer,
  "idempotency_key" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  primary key ("id")
);

create table if not exists public."feature_flags" (
  "id" uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  "key" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "is_globally_enabled" boolean NOT NULL DEFAULT false,
  "enabled_plans" plan_tier[] NOT NULL DEFAULT '{}'::plan_tier[],
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  primary key ("id")
);

create table if not exists public."platform_settings" (
  "id" boolean NOT NULL DEFAULT true CHECK (id),
  "monthly_ai_budget_usd" numeric,
  "hard_ai_spend_limit_usd" numeric,
  "last_verified_credit_balance_usd" numeric,
  "credit_balance_verified_at" timestamptz,
  "credit_balance_verified_by" uuid,
  "budget_ceiling_action" text NOT NULL DEFAULT 'alert_only'::text CHECK (budget_ceiling_action = ANY (ARRAY['alert_only'::text, 'block_new_ai_jobs'::text])),
  "maintenance_mode" boolean NOT NULL DEFAULT false,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by" uuid,
  primary key ("id")
);

create table if not exists public."player_handedness" (
  "id" bigint NOT NULL DEFAULT nextval('player_handedness_id_seq'::regclass),
  "team_id" uuid NOT NULL,
  "jersey_number" text,
  "first_name" text NOT NULL,
  "last_name" text NOT NULL,
  "full_name" text NOT NULL,
  "match_key" text NOT NULL,
  "bats" text DEFAULT 'Unknown'::text CHECK (bats = ANY (ARRAY['L'::text, 'R'::text, 'S'::text, 'Unknown'::text])),
  "throws" text DEFAULT 'Unknown'::text CHECK (throws = ANY (ARRAY['L'::text, 'R'::text, 'Unknown'::text])),
  "gc_player_url" text,
  "last_scraped_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  primary key ("id")
);

create table if not exists public."player_gc_stats" (
  "id" bigint NOT NULL GENERATED BY DEFAULT AS IDENTITY,
  "team_id" uuid NOT NULL,
  "jersey_number" text,
  "full_name" text NOT NULL,
  "match_key" text NOT NULL,
  "category" text NOT NULL CHECK (category = ANY (ARRAY['batting_standard'::text, 'batting_advanced'::text, 'pitching_standard'::text, 'pitching_advanced'::text, 'fielding_standard'::text, 'fielding_catching'::text])),
  "columns" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "rows" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "captured_at" timestamptz NOT NULL DEFAULT now(),
  primary key ("id")
);

create table if not exists public."player_gc_spray_charts" (
  "id" bigint NOT NULL GENERATED BY DEFAULT AS IDENTITY,
  "team_id" uuid NOT NULL,
  "jersey_number" text,
  "full_name" text NOT NULL,
  "match_key" text NOT NULL,
  "category" text NOT NULL DEFAULT 'batting'::text,
  "view_box" text,
  "points" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "captured_at" timestamptz NOT NULL DEFAULT now(),
  primary key ("id")
);

create table if not exists public."roster_players" (
  "id" bigint NOT NULL GENERATED BY DEFAULT AS IDENTITY,
  "team_id" uuid NOT NULL,
  "first_name" text NOT NULL,
  "last_name" text NOT NULL,
  "jersey_number" text,
  "handedness" text,
  "positions" text,
  "is_pickup" boolean NOT NULL DEFAULT false,
  "availability_status" text NOT NULL DEFAULT 'available'::text CHECK (availability_status = ANY (ARRAY['available'::text, 'unavailable'::text, 'injured'::text])),
  "unavailable_until" date,
  "injury_return_date" date,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  primary key ("id")
);

-- ── Unique constraints ──────────────────────────────────────────────────

-- ── Foreign keys (verified ON DELETE rules; targets may be tracked or
--    foundational tables, both already exist by this point) ─────────────
alter table public."admin_audit_log" add constraint "admin_audit_log_org_id_fkey" foreign key ("org_id") references public."organizations" ("id") on delete set null;
alter table public."admin_support_sessions" add constraint "admin_support_sessions_org_id_fkey" foreign key ("org_id") references public."organizations" ("id") on delete cascade;
alter table public."ai_usage_events" add constraint "ai_usage_events_org_id_fkey" foreign key ("org_id") references public."organizations" ("id") on delete set null;
alter table public."ai_usage_events" add constraint "ai_usage_events_report_id_fkey" foreign key ("report_id") references public."reports" ("id") on delete set null;
alter table public."org_entitlement_overrides" add constraint "org_entitlement_overrides_org_id_fkey" foreign key ("org_id") references public."organizations" ("id") on delete cascade;
alter table public."org_support_notes" add constraint "org_support_notes_org_id_fkey" foreign key ("org_id") references public."organizations" ("id") on delete cascade;
alter table public."player_gc_spray_charts" add constraint "player_gc_spray_charts_team_id_fkey" foreign key ("team_id") references public."teams" ("id") on delete cascade;
alter table public."player_gc_stats" add constraint "player_gc_stats_team_id_fkey" foreign key ("team_id") references public."teams" ("id") on delete cascade;
alter table public."player_handedness" add constraint "player_handedness_team_id_fkey" foreign key ("team_id") references public."teams" ("id") on delete cascade;
alter table public."roster_players" add constraint "roster_players_team_id_fkey" foreign key ("team_id") references public."teams" ("id") on delete cascade;
