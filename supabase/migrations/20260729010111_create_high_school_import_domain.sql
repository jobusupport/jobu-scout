-- High School import-run and source-provenance domain (Slice 0B).
--
-- Database-foundation-only slice: no importer application code, no API
-- routes, no UI, no seed data. Adds the durable schema a FUTURE High
-- School GameChanger game/stat importer will write to and read from.
-- Nothing in this migration runs a scrape, opens a browser, or touches
-- GameChanger, and nothing here stores a credential, cookie, token, or
-- session artifact of any kind (same permanent separation documented in
-- 20260724221500_create_high_school_domain.sql's header).
--
-- ── Why this migration also adds hs_games ───────────────────────────────
-- hs_game_validation_results and hs_verified_totals need a tenant-safe,
-- composite-FK-enforced link to "the High School game" they describe. No
-- such table exists anywhere in this schema today -- the existing High
-- School domain foundation (hs_programs/hs_seasons/hs_teams/hs_players/
-- hs_roster_memberships) never modeled a game, and only the unrelated
-- legacy Travel domain has `games`. Rather than leave hs_game_id as an
-- unenforced, FK-less placeholder (which would silently defeat the
-- tenant-isolation guarantee every other relationship in this migration
-- relies on), a minimal hs_games table is added here so the reference is
-- real. It intentionally carries only what this slice's other tables
-- need to point at a game -- no opponent-team entity, no score, no
-- innings, no result: that richer game record is future-slice scope.
--
-- ── Legacy tables this domain parallels (read, never modified) ─────────
-- stat_validation_runs -> hs_import_runs (run-level) /
--   hs_game_validation_results (per-game, legacy's game_stat_validation_results)
-- derived_team_verified_totals -> hs_verified_totals (adds season scoping
--   and explicit current/superseded rows; the leged table has neither
--   because it is one row per team_id, full stop)
-- player_advanced_stats / pitcher_advanced_stats -> hs_player_advanced_stats /
--   hs_pitcher_advanced_stats (keyed to the canonical hs_players identity
--   and a season, never player_name text, and never an is_our_team flag --
--   hs_players already only ever represents one program's own players,
--   see hs_players_org_program_fkey; the Travel domain's is_our_team
--   exists only because its players table also stores scouted opponents)
-- None of the tables above, nor any existing hs_* table, is altered,
-- renamed, or dropped by this migration.
--
-- ── Box score vs. play-by-play precedence (preserved from game-reconstructor.js) ──
-- The supplied game-reconstructor.js treats the box score as the official
-- record of totals and only trusts play-by-play-derived numbers for
-- advanced tendencies once validated against that box score. This
-- migration's hs_game_validation_results keeps box-score and
-- reconstructed (play-by-play-derived) figures in separate JSONB columns
-- with an explicit deltas/match column between them, and hs_verified_totals
-- keeps the same official-vs-reconstructed split at the aggregate level --
-- mirroring stat_validation_runs / derived_team_verified_totals exactly,
-- never collapsing the two into one "trusted" number at write time.
--
-- ── ID / timestamp / lifecycle conventions (same as the HS foundation) ──
-- uuid primary keys via extensions.uuid_generate_v4(). Every tenant-owned
-- table carries org_id directly and declares `unique (org_id, id)`, and
-- every foreign key to a parent is COMPOSITE -- `foreign key (org_id, x_id)
-- references parent (org_id, id)` -- so Postgres itself refuses a row
-- whose parent belongs to a different organization; there is no
-- composite-FK-satisfying way to attach an import run, snapshot,
-- validation result, or stat line to another org's team/season/player.
-- created_at/updated_at with the existing shared set_updated_at()
-- trigger on every MUTABLE table; append-only audit tables
-- (hs_raw_snapshots, hs_game_validation_results) get created_at only, by
-- design -- a new row is how a re-validation or re-capture is recorded,
-- never an UPDATE of history.
--
-- ── Current/superseded semantics ─────────────────────────────────────────
-- hs_verified_totals, hs_player_advanced_stats, and hs_pitcher_advanced_stats
-- each carry is_current (boolean) + superseded_at (timestamptz), enforced
-- consistent by a CHECK constraint, plus a partial UNIQUE index requiring
-- at most one is_current row per (team/player, season). season_id is
-- NOT NULL on all three specifically so that partial index is airtight --
-- Postgres unique indexes never treat two NULLs as equal, so a nullable
-- season_id would silently let two different "current" rows coexist for
-- the same team/player once more than one had a null season. Historical
-- rows are never deleted or overwritten in place; superseding a row is
-- always (a) insert the new current row, (b) UPDATE the old row's
-- is_current to false and superseded_at to now() -- application-layer
-- responsibility, not a trigger added here (this slice adds no functions).
--
-- ── RLS ──────────────────────────────────────────────────────────────────
-- Every table below: RLS enabled, a single SELECT policy requiring both
-- org membership (auth_user_org_ids()) and the organization's
-- enabled_products to include 'high_school' -- identical shape to every
-- policy in 20260724221500_create_high_school_domain.sql. No INSERT/
-- UPDATE/DELETE policy is defined anywhere in this migration; Postgres's
-- RLS default-deny leaves all writes unreachable for anon/authenticated
-- roles. The Express server's service_role key bypasses RLS (as for every
-- existing table) and is the only intended write path for a future
-- importer -- this migration adds no route, job, or function that uses
-- it. No explicit GRANT statements: Supabase's standard auto-grant plus
-- RLS is the existing convention (see 20260620000005's own comment).
--
-- Contains no seed data, no production IDs, and no statement that reads
-- from, writes to, or alters any existing table.

-- ── hs_games ─────────────────────────────────────────────────────────────
create table if not exists public.hs_games (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "program_id" uuid not null,
  "team_id" uuid not null,
  "season_id" uuid,
  "opponent_name" text,
  "game_date" date,
  "source_provider" text check ("source_provider" is null or "source_provider" = any (array['gamechanger'::text])),
  "source_game_ref" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id"),
  constraint "hs_games_org_id_id_key" unique ("org_id", "id"),
  constraint "hs_games_org_id_fkey" foreign key ("org_id") references public.organizations ("id") on delete cascade,
  constraint "hs_games_org_program_fkey" foreign key ("org_id", "program_id") references public.hs_programs ("org_id", "id") on delete cascade,
  constraint "hs_games_org_team_fkey" foreign key ("org_id", "team_id") references public.hs_teams ("org_id", "id") on delete cascade,
  constraint "hs_games_org_season_fkey" foreign key ("org_id", "season_id") references public.hs_seasons ("org_id", "id") on delete cascade
);

create trigger trg_hs_games_updated_at before update on public.hs_games for each row execute function set_updated_at();

create index if not exists idx_hs_games_org_id on public.hs_games using btree ("org_id");
create index if not exists idx_hs_games_program_id on public.hs_games using btree ("program_id");
create index if not exists idx_hs_games_team_id on public.hs_games using btree ("team_id");
create index if not exists idx_hs_games_season_id on public.hs_games using btree ("season_id");

-- Partial unique index (not a bare column-level UNIQUE) for the same
-- nullable-external-identifier reason documented throughout the HS
-- domain foundation migration.
create unique index if not exists idx_hs_games_team_source_game_ref on public.hs_games ("team_id", "source_game_ref") where "source_game_ref" is not null;

-- ── hs_import_runs ───────────────────────────────────────────────────────
-- One row per attempt to import High School data for one team (optionally
-- scoped to one season). config/result_summary are structured, sanitized
-- JSON only -- never a raw request/response body, header, cookie, or
-- credential; error_summary mirrors hs_teams.roster_sync_error's existing
-- nullable + 2000-char-bounded convention exactly.
create table if not exists public.hs_import_runs (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "program_id" uuid not null,
  "team_id" uuid not null,
  "season_id" uuid,
  "source_provider" text not null default 'gamechanger',
  "source_team_ref" text,
  "trigger_kind" text not null default 'manual',
  "status" text not null default 'pending',
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "games_discovered" integer not null default 0,
  "games_processed" integer not null default 0,
  "games_succeeded" integer not null default 0,
  "games_failed" integer not null default 0,
  "failure_stage" text,
  "error_summary" text,
  "config" jsonb not null default '{}'::jsonb,
  "result_summary" jsonb not null default '{}'::jsonb,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id"),
  constraint "hs_import_runs_org_id_id_key" unique ("org_id", "id"),
  constraint "hs_import_runs_org_id_fkey" foreign key ("org_id") references public.organizations ("id") on delete cascade,
  constraint "hs_import_runs_org_program_fkey" foreign key ("org_id", "program_id") references public.hs_programs ("org_id", "id") on delete cascade,
  constraint "hs_import_runs_org_team_fkey" foreign key ("org_id", "team_id") references public.hs_teams ("org_id", "id") on delete cascade,
  constraint "hs_import_runs_org_season_fkey" foreign key ("org_id", "season_id") references public.hs_seasons ("org_id", "id") on delete cascade,
  constraint "hs_import_runs_source_provider_check" check ("source_provider" = any (array['gamechanger'::text])),
  constraint "hs_import_runs_trigger_kind_check" check ("trigger_kind" = any (array['manual'::text, 'scheduled'::text, 'api'::text])),
  constraint "hs_import_runs_status_check" check ("status" = any (array['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'partial'::text])),
  constraint "hs_import_runs_failure_stage_check" check ("failure_stage" is null or "failure_stage" = any (array['discovery'::text, 'snapshot_capture'::text, 'reconstruction'::text, 'validation'::text, 'aggregation'::text])),
  constraint "hs_import_runs_error_summary_length_check" check ("error_summary" is null or char_length("error_summary") <= 2000),
  constraint "hs_import_runs_counts_non_negative_check" check ("games_discovered" >= 0 and "games_processed" >= 0 and "games_succeeded" >= 0 and "games_failed" >= 0),
  constraint "hs_import_runs_completed_after_started_check" check ("completed_at" is null or "started_at" is null or "completed_at" >= "started_at")
);

create trigger trg_hs_import_runs_updated_at before update on public.hs_import_runs for each row execute function set_updated_at();

create index if not exists idx_hs_import_runs_org_id on public.hs_import_runs using btree ("org_id");
create index if not exists idx_hs_import_runs_team_id on public.hs_import_runs using btree ("team_id");
create index if not exists idx_hs_import_runs_org_status_created_at on public.hs_import_runs using btree ("org_id", "status", "created_at");

-- ── hs_import_run_games ──────────────────────────────────────────────────
-- Association between one import run and each source game it discovered
-- or processed. hs_game_id stays nullable -- a game can be discovered and
-- diagnosed before (or without ever) resolving to an hs_games row (e.g.
-- skipped/rejected games) -- but every row still carries a stable
-- source_game_ref so idempotent re-processing within the same run is
-- structurally guaranteed, not just application-enforced.
create table if not exists public.hs_import_run_games (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "import_run_id" uuid not null,
  "hs_game_id" uuid,
  "source_game_ref" text not null,
  "source_game_url" text,
  "discovery_status" text not null default 'discovered',
  "game_outcome" text,
  "diagnostics" jsonb not null default '{}'::jsonb,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id"),
  constraint "hs_import_run_games_org_id_id_key" unique ("org_id", "id"),
  constraint "hs_import_run_games_org_run_fkey" foreign key ("org_id", "import_run_id") references public.hs_import_runs ("org_id", "id") on delete cascade,
  constraint "hs_import_run_games_org_game_fkey" foreign key ("org_id", "hs_game_id") references public.hs_games ("org_id", "id") on delete cascade,
  constraint "hs_import_run_games_run_source_ref_key" unique ("import_run_id", "source_game_ref"),
  constraint "hs_import_run_games_discovery_status_check" check ("discovery_status" = any (array['discovered'::text, 'processing'::text, 'processed'::text, 'skipped'::text, 'rejected'::text, 'failed'::text])),
  constraint "hs_import_run_games_game_outcome_check" check ("game_outcome" is null or "game_outcome" = any (array['inserted'::text, 'replaced'::text, 'skipped'::text, 'rejected'::text, 'failed'::text]))
);

create trigger trg_hs_import_run_games_updated_at before update on public.hs_import_run_games for each row execute function set_updated_at();

create index if not exists idx_hs_import_run_games_org_id on public.hs_import_run_games using btree ("org_id");
create index if not exists idx_hs_import_run_games_import_run_id on public.hs_import_run_games using btree ("import_run_id");
create index if not exists idx_hs_import_run_games_hs_game_id on public.hs_import_run_games using btree ("hs_game_id");

-- A resolved game is claimed by at most one run-game row per run -- two
-- different source-game refs discovered in the same run must never both
-- resolve to the same hs_games row.
create unique index if not exists idx_hs_import_run_games_run_hs_game on public.hs_import_run_games ("import_run_id", "hs_game_id") where "hs_game_id" is not null;

-- ── hs_raw_snapshots ──────────────────────────────────────────────────────
-- Durable database provenance for captured source evidence -- replaces
-- the legacy pipeline's dependence on local JSON-file/screenshot paths
-- (see game-reconstructor.js / pipeline.js) with a payload column. No
-- filesystem path is stored as the source of truth here, and no browser
-- auth-state, cookie, or request-header value is ever written to payload
-- (application-layer responsibility; this migration only shapes the
-- column). Append-only: a re-capture is a new row, never an UPDATE, so no
-- updated_at/trigger.
create table if not exists public.hs_raw_snapshots (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "import_run_id" uuid not null,
  "import_run_game_id" uuid,
  "hs_game_id" uuid,
  "snapshot_kind" text not null,
  "source_provider" text not null default 'gamechanger',
  "source_ref" text,
  "captured_at" timestamptz not null default now(),
  "payload" jsonb not null default '{}'::jsonb,
  "content_type" text not null default 'json',
  "schema_version" text not null default 'v1',
  "integrity_hash" text,
  "created_at" timestamptz not null default now(),
  primary key ("id"),
  constraint "hs_raw_snapshots_org_id_id_key" unique ("org_id", "id"),
  constraint "hs_raw_snapshots_org_run_fkey" foreign key ("org_id", "import_run_id") references public.hs_import_runs ("org_id", "id") on delete cascade,
  constraint "hs_raw_snapshots_org_run_game_fkey" foreign key ("org_id", "import_run_game_id") references public.hs_import_run_games ("org_id", "id") on delete cascade,
  constraint "hs_raw_snapshots_org_game_fkey" foreign key ("org_id", "hs_game_id") references public.hs_games ("org_id", "id") on delete cascade,
  constraint "hs_raw_snapshots_snapshot_kind_check" check ("snapshot_kind" = any (array['schedule_discovery'::text, 'game_header'::text, 'box_score'::text, 'play_by_play'::text, 'roster'::text])),
  constraint "hs_raw_snapshots_source_provider_check" check ("source_provider" = any (array['gamechanger'::text])),
  constraint "hs_raw_snapshots_content_type_check" check ("content_type" = any (array['json'::text, 'text'::text]))
);

create index if not exists idx_hs_raw_snapshots_org_id on public.hs_raw_snapshots using btree ("org_id");
create index if not exists idx_hs_raw_snapshots_import_run_id on public.hs_raw_snapshots using btree ("import_run_id");
create index if not exists idx_hs_raw_snapshots_hs_game_id on public.hs_raw_snapshots using btree ("hs_game_id");
create index if not exists idx_hs_raw_snapshots_snapshot_kind on public.hs_raw_snapshots using btree ("snapshot_kind");

-- Duplicate-write protection, split by whether a run-game association
-- exists yet -- a bare (import_run_id, snapshot_kind, captured_at) unique
-- index would let a game-scoped snapshot collide in the same instant as
-- a run-level (schedule_discovery) snapshot; keeping the two partial
-- indexes separate avoids that, while still allowing intentionally
-- distinct captures at different timestamps or for different games.
create unique index if not exists idx_hs_raw_snapshots_dedup_with_game on public.hs_raw_snapshots ("import_run_game_id", "snapshot_kind", "captured_at") where "import_run_game_id" is not null;
create unique index if not exists idx_hs_raw_snapshots_dedup_run_level on public.hs_raw_snapshots ("import_run_id", "snapshot_kind", "captured_at") where "import_run_game_id" is null;

-- ── hs_game_validation_results ───────────────────────────────────────────
-- Per-game validation outcome, mirroring the legacy game_stat_validation_results
-- shape -- box score is the official record, play-by-play-reconstructed
-- figures are compared against it, never substituted for it. One row per
-- (import_run_id, hs_game_id): a re-validation is a new import run, so
-- history stays a clean append-only audit trail without an ambiguous
-- "current" row (unlike hs_verified_totals, which explicitly needs one).
create table if not exists public.hs_game_validation_results (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "import_run_id" uuid not null,
  "import_run_game_id" uuid,
  "hs_game_id" uuid not null,
  "team_id" uuid not null,
  "has_box_score" boolean not null default false,
  "has_play_by_play" boolean not null default false,
  "scouted_side" text,
  "opponent_side" text,
  "box_score_batting" jsonb not null default '{}'::jsonb,
  "box_score_pitching" jsonb not null default '{}'::jsonb,
  "reconstructed_batting" jsonb not null default '{}'::jsonb,
  "reconstructed_pitching" jsonb not null default '{}'::jsonb,
  "deltas" jsonb not null default '{}'::jsonb,
  "batting_matches_box" boolean not null default false,
  "quality" jsonb not null default '{}'::jsonb,
  "warnings" jsonb not null default '[]'::jsonb,
  "confidence" text not null default 'low',
  "validation_status" text not null default 'pending',
  "created_at" timestamptz not null default now(),
  primary key ("id"),
  constraint "hs_game_validation_results_org_id_id_key" unique ("org_id", "id"),
  constraint "hs_game_validation_results_org_run_fkey" foreign key ("org_id", "import_run_id") references public.hs_import_runs ("org_id", "id") on delete cascade,
  constraint "hs_game_validation_results_org_run_game_fkey" foreign key ("org_id", "import_run_game_id") references public.hs_import_run_games ("org_id", "id") on delete cascade,
  constraint "hs_game_validation_results_org_game_fkey" foreign key ("org_id", "hs_game_id") references public.hs_games ("org_id", "id") on delete cascade,
  constraint "hs_game_validation_results_org_team_fkey" foreign key ("org_id", "team_id") references public.hs_teams ("org_id", "id") on delete cascade,
  constraint "hs_game_validation_results_run_game_key" unique ("import_run_id", "hs_game_id"),
  constraint "hs_game_validation_results_scouted_side_check" check ("scouted_side" is null or "scouted_side" = any (array['home'::text, 'away'::text])),
  constraint "hs_game_validation_results_opponent_side_check" check ("opponent_side" is null or "opponent_side" = any (array['home'::text, 'away'::text])),
  constraint "hs_game_validation_results_confidence_check" check ("confidence" = any (array['low'::text, 'medium'::text, 'high'::text])),
  constraint "hs_game_validation_results_status_check" check ("validation_status" = any (array['pending'::text, 'validated'::text, 'mismatched'::text, 'failed'::text]))
);

create index if not exists idx_hs_game_validation_results_org_id on public.hs_game_validation_results using btree ("org_id");
create index if not exists idx_hs_game_validation_results_import_run_id on public.hs_game_validation_results using btree ("import_run_id");
create index if not exists idx_hs_game_validation_results_hs_game_id on public.hs_game_validation_results using btree ("hs_game_id");
create index if not exists idx_hs_game_validation_results_team_id on public.hs_game_validation_results using btree ("team_id");

-- ── hs_verified_totals ────────────────────────────────────────────────────
-- Report-safe verified aggregate facts, one CURRENT row per (team, season)
-- plus a full history of superseded rows -- never calculated ad hoc from
-- raw play-event distributions at read time (mirrors derived_team_verified_totals's
-- existing "official vs. reconstructed" split, scoped here to a season).
create table if not exists public.hs_verified_totals (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "program_id" uuid not null,
  "team_id" uuid not null,
  "season_id" uuid not null,
  "import_run_id" uuid,
  "games" integer not null default 0,
  "box_score_games" integer not null default 0,
  "play_by_play_games" integer not null default 0,
  "validated_games" integer not null default 0,
  "mismatch_games" integer not null default 0,
  "batting_official" jsonb not null default '{}'::jsonb,
  "pitching_official" jsonb not null default '{}'::jsonb,
  "batting_reconstructed" jsonb not null default '{}'::jsonb,
  "pitching_reconstructed" jsonb not null default '{}'::jsonb,
  "tendencies" jsonb not null default '{}'::jsonb,
  "warnings" jsonb not null default '[]'::jsonb,
  "confidence" text not null default 'low',
  "is_current" boolean not null default true,
  "superseded_at" timestamptz,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id"),
  constraint "hs_verified_totals_org_id_id_key" unique ("org_id", "id"),
  constraint "hs_verified_totals_org_program_fkey" foreign key ("org_id", "program_id") references public.hs_programs ("org_id", "id") on delete cascade,
  constraint "hs_verified_totals_org_team_fkey" foreign key ("org_id", "team_id") references public.hs_teams ("org_id", "id") on delete cascade,
  constraint "hs_verified_totals_org_season_fkey" foreign key ("org_id", "season_id") references public.hs_seasons ("org_id", "id") on delete cascade,
  constraint "hs_verified_totals_org_run_fkey" foreign key ("org_id", "import_run_id") references public.hs_import_runs ("org_id", "id") on delete cascade,
  constraint "hs_verified_totals_confidence_check" check ("confidence" = any (array['low'::text, 'medium'::text, 'high'::text])),
  constraint "hs_verified_totals_counts_non_negative_check" check ("games" >= 0 and "box_score_games" >= 0 and "play_by_play_games" >= 0 and "validated_games" >= 0 and "mismatch_games" >= 0),
  constraint "hs_verified_totals_current_superseded_consistency_check" check (("is_current" and "superseded_at" is null) or (not "is_current" and "superseded_at" is not null))
);

create trigger trg_hs_verified_totals_updated_at before update on public.hs_verified_totals for each row execute function set_updated_at();

create index if not exists idx_hs_verified_totals_org_id on public.hs_verified_totals using btree ("org_id");
create index if not exists idx_hs_verified_totals_team_id on public.hs_verified_totals using btree ("team_id");
create index if not exists idx_hs_verified_totals_season_id on public.hs_verified_totals using btree ("season_id");

-- At most one current row per (team, season). season_id is NOT NULL
-- (see header comment) specifically so this index cannot be bypassed by
-- two null-season rows both being "current" at once.
create unique index if not exists idx_hs_verified_totals_current_per_team_season on public.hs_verified_totals ("team_id", "season_id") where "is_current";

-- ── hs_player_advanced_stats ─────────────────────────────────────────────
-- Season/run-derived hitter stats, keyed to the canonical hs_players
-- identity (never player_name text) and a season. One CURRENT row per
-- (player, team, season); superseded rows are retained for history.
create table if not exists public.hs_player_advanced_stats (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "program_id" uuid not null,
  "team_id" uuid not null,
  "season_id" uuid not null,
  "player_id" uuid not null,
  "import_run_id" uuid,
  "games" integer,
  "total_pitches" integer,
  "gb" integer,
  "fb" integer,
  "ld" integer,
  "batted_balls" integer,
  "gb_pct" numeric,
  "fb_pct" numeric,
  "ld_pct" numeric,
  "spray_lf" integer,
  "spray_cf" integer,
  "spray_rf" integer,
  "spray_3b" integer,
  "spray_ss" integer,
  "spray_2b" integer,
  "spray_1b" integer,
  "spray_pc" integer,
  "spray_lf_pct" numeric,
  "spray_cf_pct" numeric,
  "spray_rf_pct" numeric,
  "spray_3b_pct" numeric,
  "spray_ss_pct" numeric,
  "spray_2b_pct" numeric,
  "spray_1b_pct" numeric,
  "spray_pc_pct" numeric,
  "risp_ab" integer,
  "risp_h" integer,
  "ba_risp" numeric,
  "swing_decisions" jsonb not null default '{}'::jsonb,
  "spray_by_count" jsonb not null default '{}'::jsonb,
  "k_pct" numeric,
  "bb_pct" numeric,
  "errors" integer not null default 0,
  "bunts" integer not null default 0,
  "is_current" boolean not null default true,
  "superseded_at" timestamptz,
  "generated_at" timestamptz not null default now(),
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id"),
  constraint "hs_player_advanced_stats_org_id_id_key" unique ("org_id", "id"),
  constraint "hs_player_advanced_stats_org_program_fkey" foreign key ("org_id", "program_id") references public.hs_programs ("org_id", "id") on delete cascade,
  constraint "hs_player_advanced_stats_org_team_fkey" foreign key ("org_id", "team_id") references public.hs_teams ("org_id", "id") on delete cascade,
  constraint "hs_player_advanced_stats_org_season_fkey" foreign key ("org_id", "season_id") references public.hs_seasons ("org_id", "id") on delete cascade,
  constraint "hs_player_advanced_stats_org_player_fkey" foreign key ("org_id", "player_id") references public.hs_players ("org_id", "id") on delete cascade,
  constraint "hs_player_advanced_stats_org_run_fkey" foreign key ("org_id", "import_run_id") references public.hs_import_runs ("org_id", "id") on delete cascade,
  constraint "hs_player_advanced_stats_games_non_negative_check" check ("games" is null or "games" >= 0),
  constraint "hs_player_advanced_stats_errors_non_negative_check" check ("errors" >= 0),
  constraint "hs_player_advanced_stats_bunts_non_negative_check" check ("bunts" >= 0),
  constraint "hs_player_advanced_stats_current_superseded_consistency_check" check (("is_current" and "superseded_at" is null) or (not "is_current" and "superseded_at" is not null))
);

create trigger trg_hs_player_advanced_stats_updated_at before update on public.hs_player_advanced_stats for each row execute function set_updated_at();

create index if not exists idx_hs_player_advanced_stats_org_id on public.hs_player_advanced_stats using btree ("org_id");
create index if not exists idx_hs_player_advanced_stats_team_id on public.hs_player_advanced_stats using btree ("team_id");
create index if not exists idx_hs_player_advanced_stats_season_id on public.hs_player_advanced_stats using btree ("season_id");
create index if not exists idx_hs_player_advanced_stats_player_id on public.hs_player_advanced_stats using btree ("player_id");

create unique index if not exists idx_hs_player_advanced_stats_current_per_player_team_season on public.hs_player_advanced_stats ("player_id", "team_id", "season_id") where "is_current";

-- ── hs_pitcher_advanced_stats ────────────────────────────────────────────
-- Season/run-derived pitching stats, same current/superseded and
-- canonical-player-identity shape as hs_player_advanced_stats above.
create table if not exists public.hs_pitcher_advanced_stats (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "program_id" uuid not null,
  "team_id" uuid not null,
  "season_id" uuid not null,
  "player_id" uuid not null,
  "import_run_id" uuid,
  "games" integer,
  "total_pitches" integer,
  "strikes" integer,
  "s_pct" numeric,
  "gb" integer,
  "fb" integer,
  "ld" integer,
  "gb_pct" numeric,
  "fb_pct" numeric,
  "ld_pct" numeric,
  "go_ao" numeric,
  "so_per7" numeric,
  "bb_per7" numeric,
  "k_pct_bf" numeric,
  "bb_pct_bf" numeric,
  "p_per_ip" numeric,
  "wp" integer not null default 0,
  "bk" integer not null default 0,
  "pik" integer not null default 0,
  "is_current" boolean not null default true,
  "superseded_at" timestamptz,
  "generated_at" timestamptz not null default now(),
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id"),
  constraint "hs_pitcher_advanced_stats_org_id_id_key" unique ("org_id", "id"),
  constraint "hs_pitcher_advanced_stats_org_program_fkey" foreign key ("org_id", "program_id") references public.hs_programs ("org_id", "id") on delete cascade,
  constraint "hs_pitcher_advanced_stats_org_team_fkey" foreign key ("org_id", "team_id") references public.hs_teams ("org_id", "id") on delete cascade,
  constraint "hs_pitcher_advanced_stats_org_season_fkey" foreign key ("org_id", "season_id") references public.hs_seasons ("org_id", "id") on delete cascade,
  constraint "hs_pitcher_advanced_stats_org_player_fkey" foreign key ("org_id", "player_id") references public.hs_players ("org_id", "id") on delete cascade,
  constraint "hs_pitcher_advanced_stats_org_run_fkey" foreign key ("org_id", "import_run_id") references public.hs_import_runs ("org_id", "id") on delete cascade,
  constraint "hs_pitcher_advanced_stats_games_non_negative_check" check ("games" is null or "games" >= 0),
  constraint "hs_pitcher_advanced_stats_wp_bk_pik_non_negative_check" check ("wp" >= 0 and "bk" >= 0 and "pik" >= 0),
  constraint "hs_pitcher_advanced_stats_current_superseded_consistency_check" check (("is_current" and "superseded_at" is null) or (not "is_current" and "superseded_at" is not null))
);

create trigger trg_hs_pitcher_advanced_stats_updated_at before update on public.hs_pitcher_advanced_stats for each row execute function set_updated_at();

create index if not exists idx_hs_pitcher_advanced_stats_org_id on public.hs_pitcher_advanced_stats using btree ("org_id");
create index if not exists idx_hs_pitcher_advanced_stats_team_id on public.hs_pitcher_advanced_stats using btree ("team_id");
create index if not exists idx_hs_pitcher_advanced_stats_season_id on public.hs_pitcher_advanced_stats using btree ("season_id");
create index if not exists idx_hs_pitcher_advanced_stats_player_id on public.hs_pitcher_advanced_stats using btree ("player_id");

create unique index if not exists idx_hs_pitcher_advanced_stats_current_per_player_team_season on public.hs_pitcher_advanced_stats ("player_id", "team_id", "season_id") where "is_current";

-- ── Row Level Security ───────────────────────────────────────────────────
alter table public.hs_games enable row level security;
alter table public.hs_import_runs enable row level security;
alter table public.hs_import_run_games enable row level security;
alter table public.hs_raw_snapshots enable row level security;
alter table public.hs_game_validation_results enable row level security;
alter table public.hs_verified_totals enable row level security;
alter table public.hs_player_advanced_stats enable row level security;
alter table public.hs_pitcher_advanced_stats enable row level security;

create policy "hs_games_select" on public.hs_games
  for select
  using (
    "org_id" in (select auth_user_org_ids())
    and exists (
      select 1 from public.organizations "o"
      where "o"."id" = "hs_games"."org_id"
        and "o"."enabled_products" @> array['high_school']::text[]
    )
  );

create policy "hs_import_runs_select" on public.hs_import_runs
  for select
  using (
    "org_id" in (select auth_user_org_ids())
    and exists (
      select 1 from public.organizations "o"
      where "o"."id" = "hs_import_runs"."org_id"
        and "o"."enabled_products" @> array['high_school']::text[]
    )
  );

create policy "hs_import_run_games_select" on public.hs_import_run_games
  for select
  using (
    "org_id" in (select auth_user_org_ids())
    and exists (
      select 1 from public.organizations "o"
      where "o"."id" = "hs_import_run_games"."org_id"
        and "o"."enabled_products" @> array['high_school']::text[]
    )
  );

create policy "hs_raw_snapshots_select" on public.hs_raw_snapshots
  for select
  using (
    "org_id" in (select auth_user_org_ids())
    and exists (
      select 1 from public.organizations "o"
      where "o"."id" = "hs_raw_snapshots"."org_id"
        and "o"."enabled_products" @> array['high_school']::text[]
    )
  );

create policy "hs_game_validation_results_select" on public.hs_game_validation_results
  for select
  using (
    "org_id" in (select auth_user_org_ids())
    and exists (
      select 1 from public.organizations "o"
      where "o"."id" = "hs_game_validation_results"."org_id"
        and "o"."enabled_products" @> array['high_school']::text[]
    )
  );

create policy "hs_verified_totals_select" on public.hs_verified_totals
  for select
  using (
    "org_id" in (select auth_user_org_ids())
    and exists (
      select 1 from public.organizations "o"
      where "o"."id" = "hs_verified_totals"."org_id"
        and "o"."enabled_products" @> array['high_school']::text[]
    )
  );

create policy "hs_player_advanced_stats_select" on public.hs_player_advanced_stats
  for select
  using (
    "org_id" in (select auth_user_org_ids())
    and exists (
      select 1 from public.organizations "o"
      where "o"."id" = "hs_player_advanced_stats"."org_id"
        and "o"."enabled_products" @> array['high_school']::text[]
    )
  );

create policy "hs_pitcher_advanced_stats_select" on public.hs_pitcher_advanced_stats
  for select
  using (
    "org_id" in (select auth_user_org_ids())
    and exists (
      select 1 from public.organizations "o"
      where "o"."id" = "hs_pitcher_advanced_stats"."org_id"
        and "o"."enabled_products" @> array['high_school']::text[]
    )
  );

-- No explicit GRANT statements: Supabase's standard anon/authenticated/
-- service_role auto-grant plus RLS (enabled above, SELECT-only policies)
-- is the existing convention for every ordinary table in this schema.
