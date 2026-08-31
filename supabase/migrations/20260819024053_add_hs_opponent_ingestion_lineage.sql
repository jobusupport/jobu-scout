-- High School Slice 2D: opponent-game ingestion and verified publication.
--
-- See docs/architecture/HS_2D_OPPONENT_INGESTION_CONTRACT.md for the full
-- design contract this migration implements.
--
-- Slice 2C's publication boundary is structurally bound to an OWN-team
-- subject: hs_import_runs.team_id is not null and references hs_teams,
-- persist_hs_engine_collection inserts hs_games under that team_id, every
-- canonical player must sit on hs_roster_memberships for that team/season,
-- and idx_hs_stat_generations_current_per_team_season permits exactly one
-- current generation per (org_id, team_id, season_id).
--
-- An opponent's game is played between the monitored opponent team and an
-- arbitrary third school. It has no valid own-team team_id, its players are
-- on no roster of ours, and scouting N opponents in one season requires N
-- simultaneous current generations. This migration therefore adds a PARALLEL
-- opponent-subject lineage (never a polymorphic widening of the own-team
-- tables, and never a second publication RPC) and widens the single existing
-- persist_hs_engine_collection(jsonb) boundary with a discriminated subject.
--
-- Backward compatibility: a DTO that omits `subject` is treated exactly as
-- Slice 2C treated it -- same own-team branch, same error codes, same
-- returned generation row. No existing caller changes behaviour.

-- ── Opponent import runs ──────────────────────────────────────────────
-- Capture state, deliberately NOT hs_import_runs: that table's team_id is
-- not null and references hs_teams, so recording an opponent import there
-- would require falsely claiming one of the organization's own teams as the
-- subject. A separate lineage also makes it structurally impossible for one
-- logical import to claim both an own-team and an opponent-team subject.

create table public.hs_opponent_import_runs (
  id uuid primary key default extensions.uuid_generate_v4(),
  org_id uuid not null,
  program_id uuid not null,
  opponent_team_id uuid not null,
  season_id uuid not null,
  source_team_id uuid not null,
  source_provider text not null default 'gamechanger',
  trigger_kind text not null default 'manual',
  status text not null default 'pending',
  started_at timestamptz,
  completed_at timestamptz,
  games_discovered integer not null default 0,
  games_processed integer not null default 0,
  games_succeeded integer not null default 0,
  games_failed integer not null default 0,
  failure_stage text,
  error_summary text,
  config jsonb not null default '{}'::jsonb,
  result_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hs_opponent_import_runs_org_id_id_key unique (org_id, id),
  constraint hs_opponent_import_runs_org_fkey foreign key (org_id) references public.organizations (id) on delete cascade,
  constraint hs_opponent_import_runs_subject_fkey foreign key (org_id, program_id, opponent_team_id, season_id)
    references public.hs_opponent_teams (org_id, program_id, id, season_id) on delete cascade,
  constraint hs_opponent_import_runs_source_team_fkey foreign key (org_id, source_team_id)
    references public.hs_source_teams (org_id, id) on delete cascade,
  constraint hs_opponent_import_runs_provider_check check (source_provider = 'gamechanger'),
  constraint hs_opponent_import_runs_trigger_kind_check check (trigger_kind in ('manual', 'scheduled')),
  constraint hs_opponent_import_runs_status_check check (status in ('pending', 'running', 'succeeded', 'failed')),
  constraint hs_opponent_import_runs_counts_check check (
    games_discovered >= 0 and games_processed >= 0 and games_succeeded >= 0 and games_failed >= 0)
);

create index idx_hs_opponent_import_runs_org_id on public.hs_opponent_import_runs (org_id);
create index idx_hs_opponent_import_runs_subject on public.hs_opponent_import_runs (org_id, opponent_team_id, season_id);
create index idx_hs_opponent_import_runs_source_team_id on public.hs_opponent_import_runs (source_team_id);

-- ── Canonical opponent games ──────────────────────────────────────────
-- One row per real contest played BY the monitored opponent team. The other
-- school in that contest is recorded as counterparty_name; it is deliberately
-- a name, not a foreign key, because HS 2D does not model third-party schools
-- as canonical entities.

create table public.hs_opponent_games (
  id uuid primary key default extensions.uuid_generate_v4(),
  org_id uuid not null,
  program_id uuid not null,
  opponent_team_id uuid not null,
  season_id uuid not null,
  counterparty_name text,
  game_date date,
  game_status text not null default 'unknown',
  source_provider text not null default 'gamechanger',
  source_game_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hs_opponent_games_org_id_id_key unique (org_id, id),
  constraint hs_opponent_games_org_fkey foreign key (org_id) references public.organizations (id) on delete cascade,
  constraint hs_opponent_games_subject_fkey foreign key (org_id, program_id, opponent_team_id, season_id)
    references public.hs_opponent_teams (org_id, program_id, id, season_id) on delete cascade,
  constraint hs_opponent_games_provider_check check (source_provider = 'gamechanger'),
  -- Scheduled, in-progress, final, postponed, cancelled and suspended states
  -- stay distinguishable; they are never collapsed into a single "played" flag.
  constraint hs_opponent_games_status_check check (
    game_status in ('scheduled', 'in_progress', 'final', 'postponed', 'cancelled', 'suspended', 'unknown'))
);

create unique index idx_hs_opponent_games_subject_source_ref
  on public.hs_opponent_games (opponent_team_id, source_game_ref) where source_game_ref is not null;
create index idx_hs_opponent_games_org_id on public.hs_opponent_games (org_id);
create index idx_hs_opponent_games_subject on public.hs_opponent_games (org_id, opponent_team_id, season_id);
create index idx_hs_opponent_games_game_date on public.hs_opponent_games (opponent_team_id, game_date);

-- ── Durable opponent-game identity aliases ────────────────────────────

create table public.hs_opponent_game_identity_aliases (
  id uuid primary key default extensions.uuid_generate_v4(),
  org_id uuid not null,
  program_id uuid not null,
  opponent_team_id uuid not null,
  season_id uuid not null,
  opponent_game_id uuid not null,
  source_provider text not null,
  identity_method text not null,
  identity_digest text not null,
  foundational_digest text,
  discriminators jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint hs_opponent_game_identity_aliases_org_id_id_key unique (org_id, id),
  constraint hs_opponent_game_identity_aliases_org_fkey foreign key (org_id) references public.organizations (id) on delete cascade,
  constraint hs_opponent_game_identity_aliases_subject_fkey foreign key (org_id, program_id, opponent_team_id, season_id)
    references public.hs_opponent_teams (org_id, program_id, id, season_id) on delete cascade,
  constraint hs_opponent_game_identity_aliases_game_fkey foreign key (org_id, opponent_game_id)
    references public.hs_opponent_games (org_id, id) on delete cascade,
  constraint hs_opponent_game_identity_aliases_provider_check check (source_provider = 'gamechanger'),
  constraint hs_opponent_game_identity_aliases_method_check check (identity_method in ('sourceGameId', 'scheduleComposite')),
  constraint hs_opponent_game_identity_aliases_digest_check check (identity_digest ~ '^[0-9a-f]{64}$'),
  constraint hs_opponent_game_identity_aliases_foundational_digest_check
    check (foundational_digest is null or foundational_digest ~ '^[0-9a-f]{64}$'),
  -- A scheduleComposite alias without a foundational digest could never be
  -- re-matched deterministically on a later run.
  constraint hs_opponent_game_identity_aliases_fallback_foundation_check
    check (identity_method <> 'scheduleComposite' or foundational_digest is not null),
  constraint hs_opponent_game_identity_aliases_scope_key
    unique (org_id, opponent_team_id, season_id, source_provider, identity_method, identity_digest)
);

create index idx_hs_opponent_game_identity_aliases_org_id on public.hs_opponent_game_identity_aliases (org_id);
create index idx_hs_opponent_game_identity_aliases_game_id on public.hs_opponent_game_identity_aliases (opponent_game_id);
create index idx_hs_opponent_game_identity_aliases_fallback_lookup
  on public.hs_opponent_game_identity_aliases (org_id, opponent_team_id, season_id, source_provider, foundational_digest)
  where identity_method = 'scheduleComposite';

-- ── Import-run to game membership (immutable source observations) ──────
-- One row per observation. observed_game_date / observed_game_status record
-- what the source claimed AT CAPTURE TIME and are never updated, so a
-- reschedule leaves the original date permanently readable even though the
-- canonical game row advances to the newest observation.

create table public.hs_opponent_import_run_games (
  id uuid primary key default extensions.uuid_generate_v4(),
  org_id uuid not null,
  opponent_import_run_id uuid not null,
  opponent_game_id uuid,
  observation_key text not null,
  source_provider text not null,
  source_game_ref text,
  source_game_url text,
  observed_game_date date,
  observed_game_status text not null default 'unknown',
  discovery_status text not null default 'processed',
  game_outcome text,
  identity_method text not null,
  identity_status text not null,
  identity_digest text not null,
  authoritative boolean not null default false,
  excluded_from_official_totals boolean not null default false,
  ambiguity_component_digest text,
  conflict_fields jsonb not null default '[]'::jsonb,
  engine_version text not null,
  input_set_hash text not null,
  diagnostics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint hs_opponent_import_run_games_org_id_id_key unique (org_id, id),
  constraint hs_opponent_import_run_games_org_fkey foreign key (org_id) references public.organizations (id) on delete cascade,
  constraint hs_opponent_import_run_games_run_fkey foreign key (org_id, opponent_import_run_id)
    references public.hs_opponent_import_runs (org_id, id) on delete cascade,
  constraint hs_opponent_import_run_games_game_fkey foreign key (org_id, opponent_game_id)
    references public.hs_opponent_games (org_id, id) on delete cascade,
  constraint hs_opponent_import_run_games_provider_check check (source_provider = 'gamechanger'),
  constraint hs_opponent_import_run_games_observation_key_check check (observation_key ~ '^[0-9a-f]{64}$'),
  constraint hs_opponent_import_run_games_method_check
    check (identity_method in ('sourceGameId', 'scheduleComposite', 'unresolvedScoped')),
  constraint hs_opponent_import_run_games_status_check
    check (identity_status in ('single', 'deduplicated', 'reconciled', 'conflict', 'unresolved', 'ambiguous')),
  constraint hs_opponent_import_run_games_identity_digest_check check (identity_digest ~ '^[0-9a-f]{64}$'),
  constraint hs_opponent_import_run_games_ambiguity_digest_check
    check (ambiguity_component_digest is null or ambiguity_component_digest ~ '^[0-9a-f]{64}$'),
  constraint hs_opponent_import_run_games_input_set_hash_check check (input_set_hash ~ '^[0-9a-f]{64}$'),
  constraint hs_opponent_import_run_games_observed_status_check check (
    observed_game_status in ('scheduled', 'in_progress', 'final', 'postponed', 'cancelled', 'suspended', 'unknown')),
  constraint hs_opponent_import_run_games_discovery_status_check
    check (discovery_status in ('discovered', 'processed', 'skipped', 'failed')),
  constraint hs_opponent_import_run_games_run_observation_key unique (opponent_import_run_id, observation_key)
);

create index idx_hs_opponent_import_run_games_org_id on public.hs_opponent_import_run_games (org_id);
create index idx_hs_opponent_import_run_games_run_id on public.hs_opponent_import_run_games (opponent_import_run_id);
create index idx_hs_opponent_import_run_games_game_id on public.hs_opponent_import_run_games (opponent_game_id) where opponent_game_id is not null;
create index idx_hs_opponent_import_run_games_identity_digest on public.hs_opponent_import_run_games (org_id, identity_digest);

-- ── Immutable raw snapshots ───────────────────────────────────────────
-- Append-only. Identity is (observation, kind, integrity_hash): re-capturing
-- byte-identical content is idempotent, while a materially changed capture
-- adds a NEW row and never overwrites the earlier one. captured_at records
-- when the source was read and is stored separately from the game's own date;
-- it deliberately does not participate in identity.

create table public.hs_opponent_raw_snapshots (
  id uuid primary key default extensions.uuid_generate_v4(),
  org_id uuid not null,
  opponent_import_run_id uuid not null,
  opponent_import_run_game_id uuid not null,
  opponent_game_id uuid,
  snapshot_kind text not null,
  source_provider text not null,
  source_ref text,
  captured_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  content_type text not null default 'json',
  schema_version text,
  integrity_hash text not null,
  created_at timestamptz not null default now(),
  constraint hs_opponent_raw_snapshots_org_id_id_key unique (org_id, id),
  constraint hs_opponent_raw_snapshots_org_fkey foreign key (org_id) references public.organizations (id) on delete cascade,
  constraint hs_opponent_raw_snapshots_run_fkey foreign key (org_id, opponent_import_run_id)
    references public.hs_opponent_import_runs (org_id, id) on delete cascade,
  constraint hs_opponent_raw_snapshots_run_game_fkey foreign key (org_id, opponent_import_run_game_id)
    references public.hs_opponent_import_run_games (org_id, id) on delete cascade,
  constraint hs_opponent_raw_snapshots_game_fkey foreign key (org_id, opponent_game_id)
    references public.hs_opponent_games (org_id, id) on delete cascade,
  constraint hs_opponent_raw_snapshots_kind_check
    check (snapshot_kind in ('schedule_discovery', 'game_header', 'box_score', 'play_by_play', 'roster')),
  constraint hs_opponent_raw_snapshots_provider_check check (source_provider = 'gamechanger'),
  constraint hs_opponent_raw_snapshots_content_type_check check (content_type in ('json', 'text')),
  constraint hs_opponent_raw_snapshots_integrity_hash_check check (integrity_hash ~ '^[0-9a-f]{64}$'),
  constraint hs_opponent_raw_snapshots_identity_key
    unique (opponent_import_run_game_id, snapshot_kind, integrity_hash)
);

create index idx_hs_opponent_raw_snapshots_org_id on public.hs_opponent_raw_snapshots (org_id);
create index idx_hs_opponent_raw_snapshots_run_id on public.hs_opponent_raw_snapshots (opponent_import_run_id);
create index idx_hs_opponent_raw_snapshots_game_id on public.hs_opponent_raw_snapshots (opponent_game_id) where opponent_game_id is not null;

-- ── Validation outcomes ───────────────────────────────────────────────

create table public.hs_opponent_game_validation_results (
  id uuid primary key default extensions.uuid_generate_v4(),
  org_id uuid not null,
  opponent_import_run_id uuid not null,
  opponent_import_run_game_id uuid not null,
  opponent_game_id uuid,
  opponent_team_id uuid not null,
  has_box_score boolean not null default false,
  has_play_by_play boolean not null default false,
  subject_side text,
  counterparty_side text,
  box_score_batting jsonb not null default '{}'::jsonb,
  box_score_pitching jsonb not null default '{}'::jsonb,
  reconstructed_batting jsonb not null default '{}'::jsonb,
  reconstructed_pitching jsonb not null default '{}'::jsonb,
  deltas jsonb not null default '{}'::jsonb,
  batting_matches_box boolean not null default false,
  quality jsonb not null default '{}'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  confidence text not null default 'low',
  validation_status text not null default 'pending',
  identity_method text,
  identity_status text,
  identity_digest text,
  authoritative boolean not null default false,
  excluded_from_official_totals boolean not null default false,
  conflict_fields jsonb not null default '[]'::jsonb,
  diagnostic_status text,
  diagnostic_code text,
  ambiguity_component_digest text,
  engine_version text,
  input_set_hash text,
  created_at timestamptz not null default now(),
  constraint hs_opponent_game_validation_results_org_id_id_key unique (org_id, id),
  constraint hs_opponent_game_validation_results_org_fkey foreign key (org_id) references public.organizations (id) on delete cascade,
  constraint hs_opponent_game_validation_results_run_fkey foreign key (org_id, opponent_import_run_id)
    references public.hs_opponent_import_runs (org_id, id) on delete cascade,
  constraint hs_opponent_game_validation_results_run_game_fkey foreign key (org_id, opponent_import_run_game_id)
    references public.hs_opponent_import_run_games (org_id, id) on delete cascade,
  constraint hs_opponent_game_validation_results_game_fkey foreign key (org_id, opponent_game_id)
    references public.hs_opponent_games (org_id, id) on delete cascade,
  constraint hs_opponent_game_validation_results_subject_fkey foreign key (org_id, opponent_team_id)
    references public.hs_opponent_teams (org_id, id) on delete cascade,
  constraint hs_opponent_game_validation_results_confidence_check check (confidence in ('low', 'medium', 'high')),
  constraint hs_opponent_game_validation_results_status_check
    check (validation_status in ('pending', 'validated', 'mismatched', 'failed')),
  constraint hs_opponent_game_validation_results_diagnostic_status_check
    check (diagnostic_status is null or diagnostic_status in ('ok', 'error', 'not_run')),
  constraint hs_opponent_game_validation_results_run_observation_key
    unique (opponent_import_run_id, opponent_import_run_game_id)
);

create index idx_hs_opponent_game_validation_results_org_id on public.hs_opponent_game_validation_results (org_id);
create index idx_hs_opponent_game_validation_results_run_game_id on public.hs_opponent_game_validation_results (opponent_import_run_game_id);
create index idx_hs_opponent_game_validation_results_game_id on public.hs_opponent_game_validation_results (opponent_game_id) where opponent_game_id is not null;

-- ── Opponent-scoped statistical generations ───────────────────────────
-- The whole point of the parallel lineage: currency is scoped by
-- opponent_team_id, so opponent A and opponent B each hold a current
-- generation in the same season at the same time, and publishing for A can
-- never supersede B.

create table public.hs_opponent_stat_generations (
  id uuid primary key default extensions.uuid_generate_v4(),
  org_id uuid not null,
  program_id uuid not null,
  opponent_team_id uuid not null,
  season_id uuid not null,
  opponent_import_run_id uuid not null,
  source_team_id uuid not null,
  opponent_source_link_id uuid not null,
  engine_version text not null,
  input_set_hash text not null,
  content_hash text not null,
  payload_bytes integer not null,
  observation_count integer not null,
  snapshot_count integer not null,
  noncanonical_player_count integer not null,
  final_game_count integer not null default 0,
  official_totals_complete boolean not null,
  status text not null default 'completed',
  is_current boolean not null default true,
  completed_at timestamptz not null default now(),
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  constraint hs_opponent_stat_generations_org_id_id_key unique (org_id, id),
  constraint hs_opponent_stat_generations_org_fkey foreign key (org_id) references public.organizations (id) on delete cascade,
  constraint hs_opponent_stat_generations_subject_fkey foreign key (org_id, program_id, opponent_team_id, season_id)
    references public.hs_opponent_teams (org_id, program_id, id, season_id) on delete cascade,
  constraint hs_opponent_stat_generations_run_fkey foreign key (org_id, opponent_import_run_id)
    references public.hs_opponent_import_runs (org_id, id) on delete cascade,
  constraint hs_opponent_stat_generations_source_team_fkey foreign key (org_id, source_team_id)
    references public.hs_source_teams (org_id, id) on delete cascade,
  -- Records exactly which reviewed source link authorised this publication.
  constraint hs_opponent_stat_generations_source_link_fkey
    foreign key (org_id, program_id, opponent_team_id, season_id, opponent_source_link_id)
    references public.hs_opponent_source_links (org_id, program_id, opponent_team_id, season_id, id) on delete cascade,
  constraint hs_opponent_stat_generations_engine_version_check check (engine_version = 'hs-baseball-engine/v1'),
  constraint hs_opponent_stat_generations_input_set_hash_check check (input_set_hash ~ '^[0-9a-f]{64}$'),
  constraint hs_opponent_stat_generations_content_hash_check check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint hs_opponent_stat_generations_payload_bytes_check check (payload_bytes between 0 and 4194304),
  constraint hs_opponent_stat_generations_counts_check check (
    observation_count >= 0 and snapshot_count >= 0 and noncanonical_player_count >= 0
    and final_game_count >= 0 and final_game_count <= observation_count),
  constraint hs_opponent_stat_generations_status_check check (status in ('completed', 'superseded')),
  constraint hs_opponent_stat_generations_current_consistency_check check (
    (is_current and status = 'completed' and superseded_at is null)
    or (not is_current and status = 'superseded' and superseded_at is not null)),
  -- A generation with no final game is schedule knowledge, never a completed
  -- statistical generation.
  constraint hs_opponent_stat_generations_official_totals_check check (
    not official_totals_complete or final_game_count > 0),
  constraint hs_opponent_stat_generations_idempotency_key
    unique (org_id, opponent_team_id, season_id, engine_version, input_set_hash)
);

create index idx_hs_opponent_stat_generations_org_id on public.hs_opponent_stat_generations (org_id);
create index idx_hs_opponent_stat_generations_subject on public.hs_opponent_stat_generations (org_id, opponent_team_id, season_id);
create index idx_hs_opponent_stat_generations_run_id on public.hs_opponent_stat_generations (opponent_import_run_id);
create unique index idx_hs_opponent_stat_generations_current_per_subject_season
  on public.hs_opponent_stat_generations (org_id, opponent_team_id, season_id) where is_current;

-- ── Verified opponent totals ──────────────────────────────────────────

create table public.hs_opponent_verified_totals (
  id uuid primary key default extensions.uuid_generate_v4(),
  org_id uuid not null,
  program_id uuid not null,
  opponent_team_id uuid not null,
  season_id uuid not null,
  opponent_import_run_id uuid not null,
  generation_id uuid not null,
  games integer not null default 0,
  box_score_games integer not null default 0,
  play_by_play_games integer not null default 0,
  validated_games integer not null default 0,
  mismatch_games integer not null default 0,
  subject_batting jsonb not null default '{}'::jsonb,
  subject_pitching jsonb not null default '{}'::jsonb,
  subject_batting_reconstructed jsonb not null default '{}'::jsonb,
  subject_pitching_reconstructed jsonb not null default '{}'::jsonb,
  tendencies jsonb not null default '{}'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  confidence text not null default 'low',
  is_current boolean not null default true,
  superseded_at timestamptz,
  engine_version text not null,
  input_set_hash text not null,
  created_at timestamptz not null default now(),
  constraint hs_opponent_verified_totals_org_id_id_key unique (org_id, id),
  constraint hs_opponent_verified_totals_org_fkey foreign key (org_id) references public.organizations (id) on delete cascade,
  constraint hs_opponent_verified_totals_subject_fkey foreign key (org_id, program_id, opponent_team_id, season_id)
    references public.hs_opponent_teams (org_id, program_id, id, season_id) on delete cascade,
  constraint hs_opponent_verified_totals_run_fkey foreign key (org_id, opponent_import_run_id)
    references public.hs_opponent_import_runs (org_id, id) on delete cascade,
  constraint hs_opponent_verified_totals_generation_fkey foreign key (org_id, generation_id)
    references public.hs_opponent_stat_generations (org_id, id) on delete cascade,
  constraint hs_opponent_verified_totals_confidence_check check (confidence in ('low', 'medium', 'high')),
  constraint hs_opponent_verified_totals_counts_check check (
    games >= 0 and box_score_games >= 0 and play_by_play_games >= 0
    and validated_games >= 0 and mismatch_games >= 0),
  constraint hs_opponent_verified_totals_input_set_hash_check check (input_set_hash ~ '^[0-9a-f]{64}$'),
  constraint hs_opponent_verified_totals_current_consistency_check check (
    (is_current and superseded_at is null) or (not is_current and superseded_at is not null)),
  constraint hs_opponent_verified_totals_generation_key unique (generation_id)
);

create index idx_hs_opponent_verified_totals_org_id on public.hs_opponent_verified_totals (org_id);
create index idx_hs_opponent_verified_totals_subject on public.hs_opponent_verified_totals (org_id, opponent_team_id, season_id);
create unique index idx_hs_opponent_verified_totals_current_per_subject_season
  on public.hs_opponent_verified_totals (org_id, opponent_team_id, season_id) where is_current;

-- ── Noncanonical opponent player lines ────────────────────────────────
-- EVERY player line produced by an opponent collection lands here. HS 2D
-- deliberately has no canonical opponent-player table: resolving opponent
-- players to durable identities is HS 2F's job, and inventing roster
-- membership from scraped data is exactly what this slice must not do.

create table public.hs_opponent_noncanonical_player_stats (
  id uuid primary key default extensions.uuid_generate_v4(),
  org_id uuid not null,
  opponent_team_id uuid not null,
  season_id uuid not null,
  generation_id uuid not null,
  opponent_import_run_game_id uuid,
  opponent_game_id uuid,
  side text not null,
  role text not null,
  display_name text,
  provider_player_id text,
  engine_identity_key text not null,
  unresolved_reason text not null,
  is_counterparty boolean not null,
  statistics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint hs_opponent_noncanonical_player_stats_org_id_id_key unique (org_id, id),
  constraint hs_opponent_noncanonical_player_stats_org_fkey foreign key (org_id) references public.organizations (id) on delete cascade,
  constraint hs_opponent_noncanonical_player_stats_subject_fkey foreign key (org_id, opponent_team_id)
    references public.hs_opponent_teams (org_id, id) on delete cascade,
  constraint hs_opponent_noncanonical_player_stats_generation_fkey foreign key (org_id, generation_id)
    references public.hs_opponent_stat_generations (org_id, id) on delete cascade,
  constraint hs_opponent_noncanonical_player_stats_run_game_fkey foreign key (org_id, opponent_import_run_game_id)
    references public.hs_opponent_import_run_games (org_id, id) on delete cascade,
  constraint hs_opponent_noncanonical_player_stats_game_fkey foreign key (org_id, opponent_game_id)
    references public.hs_opponent_games (org_id, id) on delete cascade,
  -- 'own' means the monitored opponent team (the subject of this collection);
  -- 'opponent' means that game's counterparty school.
  constraint hs_opponent_noncanonical_player_stats_side_check check (side in ('own', 'opponent', 'unknown')),
  constraint hs_opponent_noncanonical_player_stats_role_check check (role in ('batter', 'pitcher', 'fielder')),
  constraint hs_opponent_noncanonical_player_stats_identity_key_length_check
    check (char_length(engine_identity_key) between 1 and 512),
  constraint hs_opponent_noncanonical_player_stats_reason_length_check
    check (char_length(unresolved_reason) between 1 and 1000),
  constraint hs_opponent_noncanonical_player_stats_generation_identity_key
    unique (generation_id, role, side, engine_identity_key)
);

create index idx_hs_opponent_noncanonical_player_stats_org_id on public.hs_opponent_noncanonical_player_stats (org_id);
create index idx_hs_opponent_noncanonical_player_stats_generation_id on public.hs_opponent_noncanonical_player_stats (generation_id);
create index idx_hs_opponent_noncanonical_player_stats_subject on public.hs_opponent_noncanonical_player_stats (org_id, opponent_team_id, season_id);

-- ── Identity resolution history ───────────────────────────────────────

create table public.hs_opponent_game_identity_resolutions (
  id uuid primary key default extensions.uuid_generate_v4(),
  org_id uuid not null,
  opponent_team_id uuid not null,
  season_id uuid not null,
  opponent_import_run_id uuid not null,
  opponent_import_run_game_id uuid not null,
  opponent_game_id uuid not null,
  resolution_kind text not null,
  prior_identity_status text not null,
  evidence_digest text not null,
  created_at timestamptz not null default now(),
  constraint hs_opponent_game_identity_resolutions_org_id_id_key unique (org_id, id),
  constraint hs_opponent_game_identity_resolutions_org_fkey foreign key (org_id) references public.organizations (id) on delete cascade,
  constraint hs_opponent_game_identity_resolutions_subject_fkey foreign key (org_id, opponent_team_id)
    references public.hs_opponent_teams (org_id, id) on delete cascade,
  constraint hs_opponent_game_identity_resolutions_run_fkey foreign key (org_id, opponent_import_run_id)
    references public.hs_opponent_import_runs (org_id, id) on delete cascade,
  constraint hs_opponent_game_identity_resolutions_run_game_fkey foreign key (org_id, opponent_import_run_game_id)
    references public.hs_opponent_import_run_games (org_id, id) on delete cascade,
  constraint hs_opponent_game_identity_resolutions_game_fkey foreign key (org_id, opponent_game_id)
    references public.hs_opponent_games (org_id, id) on delete cascade,
  constraint hs_opponent_game_identity_resolutions_kind_check
    check (resolution_kind in ('automatic_durable', 'automatic_fallback_enrichment', 'manual')),
  constraint hs_opponent_game_identity_resolutions_prior_status_check
    check (prior_identity_status in ('unresolved', 'ambiguous', 'single', 'reconciled', 'conflict')),
  constraint hs_opponent_game_identity_resolutions_evidence_digest_check check (evidence_digest ~ '^[0-9a-f]{64}$'),
  constraint hs_opponent_game_identity_resolutions_once
    unique (org_id, opponent_import_run_game_id, opponent_game_id, evidence_digest)
);

create index idx_hs_opponent_game_identity_resolutions_org_id on public.hs_opponent_game_identity_resolutions (org_id);
create index idx_hs_opponent_game_identity_resolutions_run_game_id on public.hs_opponent_game_identity_resolutions (opponent_import_run_game_id);
create index idx_hs_opponent_game_identity_resolutions_game_id on public.hs_opponent_game_identity_resolutions (opponent_game_id);

-- ── updated_at triggers (matching the existing HS convention) ──────────

create trigger trg_hs_opponent_import_runs_updated_at before update on public.hs_opponent_import_runs
  for each row execute function public.set_updated_at();
create trigger trg_hs_opponent_games_updated_at before update on public.hs_opponent_games
  for each row execute function public.set_updated_at();

-- ── Row level security ────────────────────────────────────────────────

alter table public.hs_opponent_import_runs enable row level security;
alter table public.hs_opponent_games enable row level security;
alter table public.hs_opponent_game_identity_aliases enable row level security;
alter table public.hs_opponent_import_run_games enable row level security;
alter table public.hs_opponent_raw_snapshots enable row level security;
alter table public.hs_opponent_game_validation_results enable row level security;
alter table public.hs_opponent_stat_generations enable row level security;
alter table public.hs_opponent_verified_totals enable row level security;
alter table public.hs_opponent_noncanonical_player_stats enable row level security;
alter table public.hs_opponent_game_identity_resolutions enable row level security;

create policy hs_opponent_import_runs_select on public.hs_opponent_import_runs for select to authenticated
using (org_id in (select public.auth_user_org_ids()) and exists (
  select 1 from public.organizations o where o.id = org_id and 'high_school' = any(o.enabled_products)));
create policy hs_opponent_games_select on public.hs_opponent_games for select to authenticated
using (org_id in (select public.auth_user_org_ids()) and exists (
  select 1 from public.organizations o where o.id = org_id and 'high_school' = any(o.enabled_products)));
create policy hs_opponent_game_identity_aliases_select on public.hs_opponent_game_identity_aliases for select to authenticated
using (org_id in (select public.auth_user_org_ids()) and exists (
  select 1 from public.organizations o where o.id = org_id and 'high_school' = any(o.enabled_products)));
create policy hs_opponent_import_run_games_select on public.hs_opponent_import_run_games for select to authenticated
using (org_id in (select public.auth_user_org_ids()) and exists (
  select 1 from public.organizations o where o.id = org_id and 'high_school' = any(o.enabled_products)));
create policy hs_opponent_raw_snapshots_select on public.hs_opponent_raw_snapshots for select to authenticated
using (org_id in (select public.auth_user_org_ids()) and exists (
  select 1 from public.organizations o where o.id = org_id and 'high_school' = any(o.enabled_products)));
create policy hs_opponent_game_validation_results_select on public.hs_opponent_game_validation_results for select to authenticated
using (org_id in (select public.auth_user_org_ids()) and exists (
  select 1 from public.organizations o where o.id = org_id and 'high_school' = any(o.enabled_products)));
create policy hs_opponent_stat_generations_select on public.hs_opponent_stat_generations for select to authenticated
using (org_id in (select public.auth_user_org_ids()) and exists (
  select 1 from public.organizations o where o.id = org_id and 'high_school' = any(o.enabled_products)));
create policy hs_opponent_verified_totals_select on public.hs_opponent_verified_totals for select to authenticated
using (org_id in (select public.auth_user_org_ids()) and exists (
  select 1 from public.organizations o where o.id = org_id and 'high_school' = any(o.enabled_products)));
create policy hs_opponent_noncanonical_player_stats_select on public.hs_opponent_noncanonical_player_stats for select to authenticated
using (org_id in (select public.auth_user_org_ids()) and exists (
  select 1 from public.organizations o where o.id = org_id and 'high_school' = any(o.enabled_products)));
create policy hs_opponent_game_identity_resolutions_select on public.hs_opponent_game_identity_resolutions for select to authenticated
using (org_id in (select public.auth_user_org_ids()) and exists (
  select 1 from public.organizations o where o.id = org_id and 'high_school' = any(o.enabled_products)));

-- ── Privilege closure ─────────────────────────────────────────────────
-- Local and hosted PostgreSQL differ in what a freshly created public table
-- grants by default, so every privilege below is stated explicitly rather
-- than assumed. PUBLIC and anon end with nothing at all; authenticated gets
-- SELECT only (already narrowed further by the org-scoped, entitlement-gated
-- RLS policies above); service_role gets exactly the verbs the SECURITY
-- INVOKER publication path actually executes and nothing else. No DELETE,
-- TRUNCATE, REFERENCES, TRIGGER or MAINTAIN is granted anywhere.

revoke all on public.hs_opponent_import_runs, public.hs_opponent_games,
  public.hs_opponent_game_identity_aliases, public.hs_opponent_import_run_games,
  public.hs_opponent_raw_snapshots, public.hs_opponent_game_validation_results,
  public.hs_opponent_stat_generations, public.hs_opponent_verified_totals,
  public.hs_opponent_noncanonical_player_stats, public.hs_opponent_game_identity_resolutions
  from public, anon, authenticated, service_role;

grant select on public.hs_opponent_import_runs, public.hs_opponent_games,
  public.hs_opponent_game_identity_aliases, public.hs_opponent_import_run_games,
  public.hs_opponent_raw_snapshots, public.hs_opponent_game_validation_results,
  public.hs_opponent_stat_generations, public.hs_opponent_verified_totals,
  public.hs_opponent_noncanonical_player_stats, public.hs_opponent_game_identity_resolutions
  to authenticated;

-- Mutable during publication: runs are created and completed, games advance
-- their date/status on a reschedule, aliases upsert, generations and totals
-- are superseded.
grant select, insert, update on public.hs_opponent_import_runs, public.hs_opponent_games,
  public.hs_opponent_game_identity_aliases, public.hs_opponent_stat_generations,
  public.hs_opponent_verified_totals to service_role;

-- Append-only: never updated by any code path in this slice.
grant select, insert on public.hs_opponent_import_run_games, public.hs_opponent_raw_snapshots,
  public.hs_opponent_game_validation_results, public.hs_opponent_noncanonical_player_stats,
  public.hs_opponent_game_identity_resolutions to service_role;

-- The opponent branch reads the reviewed identity foundation to authorise a
-- publication. It never writes to it: linking a source team to an opponent
-- team is a reviewed decision, and an ingestion run must not be able to
-- promote its own identity claim.
--
-- 20260808172649 created these five tables relying on "service_role auto-grant
-- plus RLS" rather than stating privileges explicitly. On this platform the
-- default leaves anon and authenticated holding TRUNCATE, REFERENCES, TRIGGER
-- and MAINTAIN -- none of which row level security restrains -- and leaves
-- service_role without the SELECT the gate below actually needs. HS 2D's
-- publication authorization now depends on the integrity of exactly these
-- tables, so the excess is revoked here and only the required SELECT is
-- granted.
--
-- Deliberately NOT granted: SELECT to authenticated. These tables carry no
-- table-level SELECT for authenticated today, so their RLS SELECT policies are
-- currently unreachable. Granting it would newly expose data through the Data
-- API, which is a coach-facing decision belonging to HS 2I, not a privilege
-- closure. Effective anon/authenticated read behaviour is therefore unchanged.
revoke all on public.hs_opponent_teams, public.hs_opponent_programs, public.hs_source_teams,
  public.hs_source_team_contexts, public.hs_opponent_source_links
  from public, anon, authenticated, service_role;
grant select on public.hs_opponent_teams, public.hs_opponent_programs, public.hs_source_teams,
  public.hs_source_team_contexts, public.hs_opponent_source_links to service_role;

-- ── Widened publication boundary ──────────────────────────────────────
-- persist_hs_engine_collection remains the ONE publication mechanism. It gains
-- a discriminated subject so an opponent collection commits through the same
-- transaction, and returns a discriminated envelope so an opponent generation
-- is never mistaken for an hs_stat_generations row. The own-team branch below
-- is spliced verbatim from the reviewed Slice 2C definition; only its two
-- return statements are wrapped in the envelope.
--
-- The return type changes from public.hs_stat_generations to jsonb, which
-- requires drop + create rather than create or replace.

drop function if exists public.persist_hs_engine_collection(jsonb);

create function public.persist_hs_engine_collection(p_dto jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_org_id uuid := (p_dto #>> '{context,orgId}')::uuid;
  v_program_id uuid := (p_dto #>> '{context,programId}')::uuid;
  v_team_id uuid := (p_dto #>> '{context,teamId}')::uuid;
  v_season_id uuid := (p_dto #>> '{context,seasonId}')::uuid;
  v_import_run_id uuid := (p_dto #>> '{context,importRunId}')::uuid;
  v_provider text := p_dto #>> '{context,sourceProvider}';
  v_engine_version text := p_dto ->> 'engineVersion';
  v_input_hash text := p_dto ->> 'inputSetHash';
  v_content_hash text := p_dto ->> 'contentHash';
  v_payload_bytes integer := (p_dto ->> 'payloadBytes')::integer;
  v_existing public.hs_stat_generations%rowtype;
  v_generation public.hs_stat_generations%rowtype;
  v_observation jsonb;
  v_snapshot jsonb;
  v_player jsonb;
  v_noncanonical jsonb;
  v_run_game_id uuid;
  v_game_id uuid;
  v_alias_game_id uuid;
  v_candidate_count integer;
  v_candidate_game_id uuid;
  v_source_ref text;
  v_method text;
  v_identity_digest text;
  v_foundation_digest text;
  v_discriminators jsonb;
  v_resolution_kind text;
  v_prior_status text;
  v_totals jsonb := p_dto -> 'teamTotals';
  v_now timestamptz := now();
  v_subject jsonb := p_dto -> 'subject';
  v_subject_kind text;
  v_opponent_team_id uuid;
  v_source_team_id uuid;
  v_source_link_id uuid;
  v_opp_existing public.hs_opponent_stat_generations%rowtype;
  v_opp_generation public.hs_opponent_stat_generations%rowtype;
  v_final_count integer := 0;
  v_game_status text;
begin
  if p_dto is null or jsonb_typeof(p_dto) <> 'object' or coalesce((p_dto ->> 'complete')::boolean, false) is not true then
    raise exception 'malformed_engine_collection: complete collection DTO required' using errcode = 'P0001';
  end if;
  if v_engine_version <> 'hs-baseball-engine/v1' then
    raise exception 'invalid_engine_version' using errcode = 'P0001';
  end if;
  if v_input_hash !~ '^[0-9a-f]{64}$' or v_content_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_collection_digest' using errcode = 'P0001';
  end if;
  if v_payload_bytes < 0 or v_payload_bytes > 4194304 then
    raise exception 'engine_collection_payload_too_large' using errcode = 'P0001';
  end if;
  if v_provider <> 'gamechanger' then
    raise exception 'invalid_source_provider' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_dto -> 'observations') <> 'array'
     or jsonb_typeof(p_dto -> 'canonicalPlayers') <> 'array'
     or jsonb_typeof(p_dto -> 'noncanonicalPlayers') <> 'array'
     or jsonb_typeof(v_totals) <> 'object' then
    raise exception 'malformed_engine_collection: arrays and teamTotals are required' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_dto) key
     where key not in (
       'complete', 'context', 'engineVersion', 'inputSetHash', 'contentHash', 'payloadBytes',
       'observations', 'snapshotCount', 'canonicalPlayers', 'noncanonicalPlayers',
       'teamTotals', 'officialTotalsComplete', 'subject'
     )
  ) then
    raise exception 'malformed_engine_collection: unexpected top-level property' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_dto -> 'observations') observation
     where jsonb_typeof(observation) <> 'object'
        or not (observation ?& array[
          'observationKey', 'sourceGameRef', 'sourceGameUrl', 'opponentName', 'gameDate',
          'identityMethod', 'identityStatus', 'identityDigest', 'foundationalDigest',
          'discriminators', 'authoritative', 'excludedFromOfficialTotals',
          'ambiguityComponentDigest', 'conflictFields', 'diagnostics', 'diagnostic',
          'validation', 'snapshots', 'engineVersion'
        ])
        or exists (
          select 1 from jsonb_object_keys(observation) observation_key
           where observation_key not in (
             'observationKey', 'sourceGameRef', 'sourceGameUrl', 'opponentName', 'gameDate',
             'identityMethod', 'identityStatus', 'identityDigest', 'foundationalDigest',
             'discriminators', 'authoritative', 'excludedFromOfficialTotals',
             'ambiguityComponentDigest', 'conflictFields', 'diagnostics', 'diagnostic',
             'validation', 'snapshots', 'engineVersion', 'gameStatus'
           )
        )
        or jsonb_typeof(observation -> 'observationKey') <> 'string'
        or (observation ->> 'observationKey') !~ '^[0-9a-f]{64}$'
        or jsonb_typeof(observation -> 'identityMethod') <> 'string'
        or btrim(observation ->> 'identityMethod') = ''
        or jsonb_typeof(observation -> 'identityStatus') <> 'string'
        or btrim(observation ->> 'identityStatus') = ''
        or jsonb_typeof(observation -> 'identityDigest') <> 'string'
        or coalesce(observation ->> 'identityDigest', '') !~ '^[0-9a-f]{64}$'
        or jsonb_typeof(observation -> 'engineVersion') <> 'string'
        or observation ->> 'engineVersion' <> v_engine_version
        or jsonb_typeof(observation -> 'authoritative') <> 'boolean'
        or jsonb_typeof(observation -> 'excludedFromOfficialTotals') <> 'boolean'
        or jsonb_typeof(observation -> 'discriminators') <> 'object'
        or jsonb_typeof(observation -> 'conflictFields') <> 'array'
        or jsonb_typeof(observation -> 'diagnostics') <> 'object'
        or jsonb_typeof(observation -> 'diagnostic') <> 'object'
        or not ((observation -> 'diagnostic') ? 'status')
        or exists (
          select 1 from jsonb_object_keys(observation -> 'diagnostic') diagnostic_key
           where diagnostic_key not in ('status', 'code', 'message')
        )
        or jsonb_typeof(observation #> '{diagnostic,status}') <> 'string'
        or btrim(observation #>> '{diagnostic,status}') = ''
        or observation #>> '{diagnostic,status}' not in ('not_run', 'ok', 'error')
        or case observation #>> '{diagnostic,status}'
          when 'not_run' then not (
            (observation -> 'diagnostic') ?& array['status', 'code']
            and not ((observation -> 'diagnostic') ? 'message')
            and jsonb_typeof(observation #> '{diagnostic,code}') = 'null'
          )
          when 'ok' then (select count(*) from jsonb_object_keys(observation -> 'diagnostic')) <> 1
          when 'error' then not (
            (observation -> 'diagnostic') ?& array['status', 'code', 'message']
            and jsonb_typeof(observation #> '{diagnostic,code}') = 'string'
            and observation #>> '{diagnostic,code}' = 'AMBIGUOUS_RECONSTRUCTION_FAILED'
            and jsonb_typeof(observation #> '{diagnostic,message}') = 'string'
            and observation #>> '{diagnostic,message}' = 'Ambiguous game diagnostic reconstruction failed.'
          )
          else true
        end
        or jsonb_typeof(observation -> 'snapshots') <> 'array'
        or jsonb_typeof(observation -> 'validation') <> 'object'
        or (jsonb_typeof(observation -> 'sourceGameRef') not in ('string', 'null'))
        or (jsonb_typeof(observation -> 'sourceGameUrl') not in ('string', 'null'))
        or (jsonb_typeof(observation -> 'opponentName') not in ('string', 'null'))
        or (jsonb_typeof(observation -> 'gameDate') not in ('string', 'null'))
        or (jsonb_typeof(observation -> 'foundationalDigest') not in ('string', 'null'))
        or (jsonb_typeof(observation -> 'ambiguityComponentDigest') not in ('string', 'null'))
        or (jsonb_typeof(observation -> 'foundationalDigest') = 'string' and (observation ->> 'foundationalDigest') !~ '^[0-9a-f]{64}$')
        or (jsonb_typeof(observation -> 'ambiguityComponentDigest') = 'string' and (observation ->> 'ambiguityComponentDigest') !~ '^[0-9a-f]{64}$')
        or exists (
          select 1 from jsonb_array_elements(observation -> 'snapshots') snapshot
           where jsonb_typeof(snapshot) <> 'object'
              or not (snapshot ?& array['kind', 'sourceRef', 'capturedAt', 'payload', 'integrityHash'])
              or exists (select 1 from jsonb_object_keys(snapshot) k where k not in ('kind', 'sourceRef', 'capturedAt', 'payload', 'integrityHash'))
              or jsonb_typeof(snapshot -> 'kind') <> 'string' or btrim(snapshot ->> 'kind') = ''
              or jsonb_typeof(snapshot -> 'capturedAt') <> 'string' or btrim(snapshot ->> 'capturedAt') = ''
              or jsonb_typeof(snapshot -> 'integrityHash') <> 'string' or (snapshot ->> 'integrityHash') !~ '^[0-9a-f]{64}$'
              or jsonb_typeof(snapshot -> 'sourceRef') not in ('string', 'null')
              or jsonb_typeof(snapshot -> 'payload') not in ('object', 'array')
        )
        or exists (
          select 1 from jsonb_object_keys(observation -> 'validation') k
           where k not in ('hasBoxScore', 'hasPlayByPlay', 'ownSide', 'opponentSide', 'boxScoreBatting',
             'boxScorePitching', 'reconstructedBatting', 'reconstructedPitching', 'deltas',
             'battingMatchesBox', 'quality', 'warnings', 'confidence', 'status')
        )
        or not ((observation -> 'validation') ?& array['hasBoxScore','hasPlayByPlay','ownSide','opponentSide','boxScoreBatting','boxScorePitching','reconstructedBatting','reconstructedPitching','deltas','battingMatchesBox','quality','warnings','confidence','status'])
        or jsonb_typeof(observation #> '{validation,hasBoxScore}') <> 'boolean'
        or jsonb_typeof(observation #> '{validation,hasPlayByPlay}') <> 'boolean'
        or jsonb_typeof(observation #> '{validation,battingMatchesBox}') <> 'boolean'
        or jsonb_typeof(observation #> '{validation,warnings}') <> 'array'
        or jsonb_typeof(observation #> '{validation,confidence}') <> 'string'
        or jsonb_typeof(observation #> '{validation,status}') <> 'string'
        or jsonb_typeof(observation #> '{validation,ownSide}') not in ('string', 'null')
        or jsonb_typeof(observation #> '{validation,opponentSide}') not in ('string', 'null')
        or jsonb_typeof(observation #> '{validation,boxScoreBatting}') <> 'object'
        or jsonb_typeof(observation #> '{validation,boxScorePitching}') <> 'object'
        or jsonb_typeof(observation #> '{validation,reconstructedBatting}') <> 'object'
        or jsonb_typeof(observation #> '{validation,reconstructedPitching}') <> 'object'
        or jsonb_typeof(observation #> '{validation,deltas}') <> 'object'
        or jsonb_typeof(observation #> '{validation,quality}') <> 'object'
  ) then
    raise exception 'malformed_engine_collection: invalid observation shape' using errcode = 'P0001';
  end if;
  if (
    select count(*) <> count(distinct observation ->> 'observationKey')
      from jsonb_array_elements(p_dto -> 'observations') observation
  ) then
    raise exception 'malformed_engine_collection: duplicate observation key' using errcode = 'P0001';
  end if;


  -- ── Discriminated collection subject (Slice 2D) ──────────────────────
  -- A DTO that omits `subject` entirely is an own-team collection, resolved
  -- exactly as Slice 2C resolved it. Nothing below changes that path.
  if v_subject is not null and jsonb_typeof(v_subject) <> 'object' then
    raise exception 'invalid_subject_kind' using errcode = 'P0001';
  end if;
  v_subject_kind := coalesce(nullif(btrim(coalesce(v_subject ->> 'kind', '')), ''), 'own_team');
  if v_subject_kind not in ('own_team', 'opponent_team') then
    raise exception 'invalid_subject_kind' using errcode = 'P0001';
  end if;
  if v_subject is not null then
    if (v_subject ? 'teamId') and (v_subject ? 'opponentTeamId') then
      raise exception 'ambiguous_collection_subject' using errcode = 'P0001';
    end if;
    if not (v_subject ? 'teamId') and not (v_subject ? 'opponentTeamId') then
      raise exception 'missing_collection_subject' using errcode = 'P0001';
    end if;
  end if;

  if v_subject_kind = 'opponent_team' then
    -- An opponent collection must not smuggle an own-team identifier through
    -- the legacy context fields; the two lineages never share a subject.
    if v_team_id is not null or v_import_run_id is not null then
      raise exception 'ambiguous_collection_subject' using errcode = 'P0001';
    end if;
    if not (v_subject ? 'opponentTeamId') then
      raise exception 'missing_collection_subject' using errcode = 'P0001';
    end if;
    v_opponent_team_id := (v_subject ->> 'opponentTeamId')::uuid;
    v_source_team_id := (v_subject ->> 'sourceTeamId')::uuid;
    v_import_run_id := (v_subject ->> 'importRunId')::uuid;
    if v_opponent_team_id is null or v_source_team_id is null or v_import_run_id is null then
      raise exception 'missing_collection_subject' using errcode = 'P0001';
    end if;

    -- Opponent players are never canonical in this slice: resolving them to
    -- durable identities is HS 2F's job, and a canonical row here would mean
    -- inventing roster membership from scraped data.
    if jsonb_array_length(p_dto -> 'canonicalPlayers') > 0 then
      raise exception 'opponent_collection_forbids_canonical_players' using errcode = 'P0001';
    end if;

    -- Competing publications for the same opponent must serialize, or two
    -- concurrent first-time publications would race on the current-generation
    -- index instead of one waiting and observing the other's result.
    --
    -- The own-team branch serializes by locking hs_teams FOR UPDATE, which in
    -- PostgreSQL requires UPDATE privilege on the locked table. Doing the same
    -- to hs_opponent_teams would mean granting service_role UPDATE on the
    -- identity foundation -- exactly the privilege this slice must NOT hold,
    -- because an ingestion run must never be able to edit the reviewed identity
    -- it is being authorised against. A transaction-scoped advisory lock keyed
    -- on the subject gives the same serialization, is released automatically on
    -- commit or rollback, and requires no table privileges at all. A hash
    -- collision between two different subjects can only cause harmless extra
    -- waiting, never an incorrect result.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      v_org_id::text || ':' || v_opponent_team_id::text || ':' || v_season_id::text, 0));

    perform 1 from public.hs_opponent_teams
     where id = v_opponent_team_id and org_id = v_org_id and program_id = v_program_id
       and season_id = v_season_id;
    if not found then raise exception 'opponent_team_not_found_for_org_program' using errcode = 'P0002'; end if;

    perform 1 from public.hs_source_teams where id = v_source_team_id and org_id = v_org_id;
    if not found then raise exception 'source_team_not_found_for_org' using errcode = 'P0002'; end if;

    -- Only a reviewed, currently linked source identity may authorise verified
    -- publication. pending / needs_review / rejected / superseded all block, and
    -- this branch never writes to the link table, so an ingestion run can never
    -- promote its own identity claim.
    select id into v_source_link_id from public.hs_opponent_source_links
     where org_id = v_org_id and program_id = v_program_id and opponent_team_id = v_opponent_team_id
       and season_id = v_season_id and source_team_id = v_source_team_id and status = 'linked';
    if not found then raise exception 'opponent_source_link_not_linked' using errcode = 'P0002'; end if;

    -- A conflicting, unresolved or ambiguous identity is preserved as an
    -- observation but must never become verified output.
    if exists (
      select 1 from jsonb_array_elements(p_dto -> 'observations') observation
       where coalesce((observation ->> 'authoritative')::boolean, false)
         and (observation ->> 'identityStatus') in ('conflict', 'unresolved', 'ambiguous')
    ) then
      raise exception 'opponent_identity_unresolved' using errcode = 'P0001';
    end if;

    perform 1 from public.hs_opponent_import_runs
     where id = v_import_run_id and org_id = v_org_id and program_id = v_program_id
       and opponent_team_id = v_opponent_team_id and season_id = v_season_id
       and source_team_id = v_source_team_id and status = 'running'
     for update;
    if not found then
      select * into v_opp_existing from public.hs_opponent_stat_generations
       where org_id = v_org_id and opponent_team_id = v_opponent_team_id and season_id = v_season_id
         and engine_version = v_engine_version and input_set_hash = v_input_hash;
      if found and v_opp_existing.content_hash = v_content_hash then
        return jsonb_build_object('subjectKind', 'opponent_team', 'generation', to_jsonb(v_opp_existing));
      end if;
      raise exception 'invalid_opponent_import_run_state' using errcode = 'P0001';
    end if;

    select * into v_opp_existing from public.hs_opponent_stat_generations
     where org_id = v_org_id and opponent_team_id = v_opponent_team_id and season_id = v_season_id
       and engine_version = v_engine_version and input_set_hash = v_input_hash
     for update;
    if found then
      if v_opp_existing.content_hash <> v_content_hash then
        raise exception 'idempotency_content_mismatch' using errcode = 'P0001';
      end if;
      return jsonb_build_object('subjectKind', 'opponent_team', 'generation', to_jsonb(v_opp_existing));
    end if;

    for v_observation in select value from jsonb_array_elements(p_dto -> 'observations') order by value ->> 'observationKey'
    loop
      v_candidate_count := 0;
      v_candidate_game_id := null;
      v_resolution_kind := null;
      v_method := v_observation ->> 'identityMethod';
      v_identity_digest := v_observation ->> 'identityDigest';
      v_foundation_digest := v_observation ->> 'foundationalDigest';
      v_discriminators := coalesce(v_observation -> 'discriminators', '{}'::jsonb);
      v_source_ref := nullif(v_observation ->> 'sourceGameRef', '');
      v_game_status := coalesce(nullif(btrim(coalesce(v_observation ->> 'gameStatus', '')), ''), 'unknown');
      v_game_id := null;

      if coalesce((v_observation ->> 'authoritative')::boolean, false)
         and v_method in ('sourceGameId', 'scheduleComposite') then
        select opponent_game_id into v_alias_game_id from public.hs_opponent_game_identity_aliases
         where org_id = v_org_id and opponent_team_id = v_opponent_team_id and season_id = v_season_id
           and source_provider = v_provider and identity_method = v_method and identity_digest = v_identity_digest;
        v_game_id := v_alias_game_id;

        -- A stable upstream identifier keeps the same canonical game across a
        -- reschedule: the date moved, the identity did not.
        if v_game_id is null and v_method = 'sourceGameId' and v_source_ref is not null then
          select id into v_game_id from public.hs_opponent_games
           where org_id = v_org_id and opponent_team_id = v_opponent_team_id and source_game_ref = v_source_ref;
          if v_game_id is not null then v_resolution_kind := 'automatic_durable'; end if;
        end if;

        -- Fallback identity adopts an existing game only when EXACTLY one alias
        -- matches the foundational digest and no discriminator contradicts it.
        -- Two or more candidates leave the observation unresolved rather than
        -- guessing, which is what keeps an indistinguishable doubleheader from
        -- silently collapsing into one game.
        if v_game_id is null and v_method = 'scheduleComposite' then
          select count(distinct a.opponent_game_id), min(a.opponent_game_id::text)::uuid
            into v_candidate_count, v_candidate_game_id
            from public.hs_opponent_game_identity_aliases a
           where a.org_id = v_org_id and a.opponent_team_id = v_opponent_team_id and a.season_id = v_season_id
             and a.source_provider = v_provider and a.identity_method = 'scheduleComposite'
             and a.foundational_digest = v_foundation_digest
             and exists (
               select 1 from jsonb_each_text(a.discriminators) old_d
               join jsonb_each_text(v_discriminators) new_d on new_d.key = old_d.key and new_d.value = old_d.value
             )
             and not exists (
               select 1 from jsonb_each_text(a.discriminators) old_d
               join jsonb_each_text(v_discriminators) new_d on new_d.key = old_d.key and new_d.value <> old_d.value
             );
          if v_candidate_count = 1 then
            v_game_id := v_candidate_game_id;
            v_resolution_kind := 'automatic_fallback_enrichment';
          end if;
          if v_candidate_count > 1 then v_game_id := null; end if;
        end if;

        if v_game_id is null and not (v_method = 'scheduleComposite' and coalesce(v_candidate_count, 0) > 1) then
          insert into public.hs_opponent_games
            (org_id, program_id, opponent_team_id, season_id, counterparty_name, game_date, game_status,
             source_provider, source_game_ref)
          values (v_org_id, v_program_id, v_opponent_team_id, v_season_id,
            nullif(v_observation ->> 'opponentName', ''), nullif(v_observation ->> 'gameDate', '')::date,
            v_game_status, v_provider, case when v_method = 'sourceGameId' then v_source_ref else null end)
          on conflict (opponent_team_id, source_game_ref) where source_game_ref is not null
          do update set updated_at = public.hs_opponent_games.updated_at
          returning id into v_game_id;
        end if;
      end if;

      -- The canonical game advances to the newest observation; every prior
      -- observation keeps its own observed_game_date / observed_game_status
      -- below, so a reschedule never destroys the former date.
      if v_game_id is not null then
        update public.hs_opponent_games
           set game_date = coalesce(nullif(v_observation ->> 'gameDate', '')::date, game_date),
               game_status = v_game_status,
               counterparty_name = coalesce(nullif(v_observation ->> 'opponentName', ''), counterparty_name)
         where org_id = v_org_id and id = v_game_id;

        insert into public.hs_opponent_game_identity_aliases
          (org_id, program_id, opponent_team_id, season_id, opponent_game_id, source_provider,
           identity_method, identity_digest, foundational_digest, discriminators)
        select v_org_id, v_program_id, v_opponent_team_id, v_season_id, v_game_id, v_provider,
               v_method, v_identity_digest, v_foundation_digest, v_discriminators
         where v_method in ('sourceGameId', 'scheduleComposite')
        on conflict (org_id, opponent_team_id, season_id, source_provider, identity_method, identity_digest) do nothing;
      end if;

      insert into public.hs_opponent_import_run_games
        (org_id, opponent_import_run_id, opponent_game_id, observation_key, source_provider, source_game_ref,
         source_game_url, observed_game_date, observed_game_status, discovery_status, game_outcome,
         identity_method, identity_status, identity_digest, authoritative, excluded_from_official_totals,
         ambiguity_component_digest, conflict_fields, engine_version, input_set_hash, diagnostics)
      values
        (v_org_id, v_import_run_id, v_game_id, v_observation ->> 'observationKey', v_provider, v_source_ref,
         nullif(v_observation ->> 'sourceGameUrl', ''), nullif(v_observation ->> 'gameDate', '')::date, v_game_status,
         'processed', case when v_game_id is null then 'replaced' else 'inserted' end,
         v_method, v_observation ->> 'identityStatus', v_identity_digest,
         coalesce((v_observation ->> 'authoritative')::boolean, false),
         coalesce((v_observation ->> 'excludedFromOfficialTotals')::boolean, false) or v_game_status <> 'final',
         nullif(v_observation ->> 'ambiguityComponentDigest', ''),
         coalesce(v_observation -> 'conflictFields', '[]'::jsonb),
         v_engine_version, v_input_hash, coalesce(v_observation -> 'diagnostics', '{}'::jsonb))
      returning id into v_run_game_id;

      if v_game_status = 'final' then v_final_count := v_final_count + 1; end if;

      if v_resolution_kind is not null and v_game_id is not null then
        v_prior_status := case v_observation ->> 'identityStatus'
          when 'deduplicated' then 'single'
          else v_observation ->> 'identityStatus'
        end;
        insert into public.hs_opponent_game_identity_resolutions
          (org_id, opponent_team_id, season_id, opponent_import_run_id, opponent_import_run_game_id,
           opponent_game_id, resolution_kind, prior_identity_status, evidence_digest)
        values
          (v_org_id, v_opponent_team_id, v_season_id, v_import_run_id, v_run_game_id,
           v_game_id, v_resolution_kind, v_prior_status, v_identity_digest)
        on conflict (org_id, opponent_import_run_game_id, opponent_game_id, evidence_digest) do nothing;
      end if;

      -- Snapshot identity is (observation, kind, integrity_hash): identical
      -- content is idempotent, changed content adds a row, nothing is ever
      -- overwritten.
      for v_snapshot in select value from jsonb_array_elements(coalesce(v_observation -> 'snapshots', '[]'::jsonb)) order by value ->> 'kind'
      loop
        insert into public.hs_opponent_raw_snapshots
          (org_id, opponent_import_run_id, opponent_import_run_game_id, opponent_game_id, snapshot_kind,
           source_provider, source_ref, captured_at, payload, content_type, schema_version, integrity_hash)
        values
          (v_org_id, v_import_run_id, v_run_game_id, v_game_id, v_snapshot ->> 'kind', v_provider,
           nullif(v_snapshot ->> 'sourceRef', ''), (v_snapshot ->> 'capturedAt')::timestamptz,
           coalesce(v_snapshot -> 'payload', '{}'::jsonb), 'json', v_engine_version, v_snapshot ->> 'integrityHash')
        on conflict (opponent_import_run_game_id, snapshot_kind, integrity_hash) do nothing;
      end loop;

      insert into public.hs_opponent_game_validation_results
        (org_id, opponent_import_run_id, opponent_import_run_game_id, opponent_game_id, opponent_team_id,
         has_box_score, has_play_by_play, subject_side, counterparty_side, box_score_batting, box_score_pitching,
         reconstructed_batting, reconstructed_pitching, deltas, batting_matches_box, quality, warnings,
         confidence, validation_status, identity_method, identity_status, identity_digest, authoritative,
         excluded_from_official_totals, conflict_fields, diagnostic_status, diagnostic_code,
         ambiguity_component_digest, engine_version, input_set_hash)
      values
        (v_org_id, v_import_run_id, v_run_game_id, v_game_id, v_opponent_team_id,
         coalesce((v_observation #>> '{validation,hasBoxScore}')::boolean, false),
         coalesce((v_observation #>> '{validation,hasPlayByPlay}')::boolean, false),
         nullif(v_observation #>> '{validation,ownSide}', ''), nullif(v_observation #>> '{validation,opponentSide}', ''),
         coalesce(v_observation #> '{validation,boxScoreBatting}', '{}'::jsonb),
         coalesce(v_observation #> '{validation,boxScorePitching}', '{}'::jsonb),
         coalesce(v_observation #> '{validation,reconstructedBatting}', '{}'::jsonb),
         coalesce(v_observation #> '{validation,reconstructedPitching}', '{}'::jsonb),
         coalesce(v_observation #> '{validation,deltas}', '{}'::jsonb),
         coalesce((v_observation #>> '{validation,battingMatchesBox}')::boolean, false),
         coalesce(v_observation #> '{validation,quality}', '{}'::jsonb),
         coalesce(v_observation #> '{validation,warnings}', '[]'::jsonb),
         coalesce(v_observation #>> '{validation,confidence}', 'low'),
         coalesce(v_observation #>> '{validation,status}', 'pending'),
         v_method, v_observation ->> 'identityStatus', v_identity_digest,
         coalesce((v_observation ->> 'authoritative')::boolean, false),
         coalesce((v_observation ->> 'excludedFromOfficialTotals')::boolean, false) or v_game_status <> 'final',
         coalesce(v_observation -> 'conflictFields', '[]'::jsonb),
         v_observation #>> '{diagnostic,status}', nullif(v_observation #>> '{diagnostic,code}', ''),
         nullif(v_observation ->> 'ambiguityComponentDigest', ''), v_engine_version, v_input_hash)
      on conflict (opponent_import_run_id, opponent_import_run_game_id) do nothing;
    end loop;

    -- Supersession is scoped by opponent_team_id, so publishing for one
    -- opponent can never retire another opponent's current generation, and
    -- never touches own-team lineage at all.
    update public.hs_opponent_stat_generations set is_current = false, status = 'superseded', superseded_at = v_now
     where org_id = v_org_id and opponent_team_id = v_opponent_team_id and season_id = v_season_id and is_current;
    update public.hs_opponent_verified_totals set is_current = false, superseded_at = v_now
     where org_id = v_org_id and opponent_team_id = v_opponent_team_id and season_id = v_season_id and is_current;

    insert into public.hs_opponent_stat_generations
      (org_id, program_id, opponent_team_id, season_id, opponent_import_run_id, source_team_id,
       opponent_source_link_id, engine_version, input_set_hash, content_hash, payload_bytes,
       observation_count, snapshot_count, noncanonical_player_count, final_game_count,
       official_totals_complete, status, is_current, completed_at)
    values
      (v_org_id, v_program_id, v_opponent_team_id, v_season_id, v_import_run_id, v_source_team_id,
       v_source_link_id, v_engine_version, v_input_hash, v_content_hash, v_payload_bytes,
       jsonb_array_length(p_dto -> 'observations'), coalesce((p_dto ->> 'snapshotCount')::integer, 0),
       jsonb_array_length(p_dto -> 'noncanonicalPlayers'), v_final_count,
       -- A collection with no final game is schedule knowledge, never a
       -- completed statistical generation.
       coalesce((p_dto ->> 'officialTotalsComplete')::boolean, false) and v_final_count > 0,
       'completed', true, v_now)
    returning * into v_opp_generation;

    insert into public.hs_opponent_verified_totals
      (org_id, program_id, opponent_team_id, season_id, opponent_import_run_id, generation_id, games,
       box_score_games, play_by_play_games, validated_games, mismatch_games, subject_batting, subject_pitching,
       subject_batting_reconstructed, subject_pitching_reconstructed, tendencies, warnings, confidence,
       is_current, engine_version, input_set_hash)
    values
      (v_org_id, v_program_id, v_opponent_team_id, v_season_id, v_import_run_id, v_opp_generation.id,
       coalesce((v_totals ->> 'games')::integer, 0), coalesce((v_totals ->> 'boxScoreGames')::integer, 0),
       coalesce((v_totals ->> 'playByPlayGames')::integer, 0), coalesce((v_totals ->> 'validatedGames')::integer, 0),
       coalesce((v_totals ->> 'mismatchGames')::integer, 0), coalesce(v_totals -> 'officialBatting', '{}'::jsonb),
       coalesce(v_totals -> 'officialPitching', '{}'::jsonb), coalesce(v_totals -> 'reconstructedBatting', '{}'::jsonb),
       coalesce(v_totals -> 'reconstructedPitchingDefense', '{}'::jsonb), coalesce(v_totals -> 'tendencies', '{}'::jsonb),
       coalesce(v_totals -> 'warnings', '[]'::jsonb), coalesce(v_totals ->> 'confidence', 'low'), true,
       v_engine_version, v_input_hash);

    for v_noncanonical in select value from jsonb_array_elements(p_dto -> 'noncanonicalPlayers') order by value ->> 'engineIdentityKey', value ->> 'role'
    loop
      insert into public.hs_opponent_noncanonical_player_stats
        (org_id, opponent_team_id, season_id, generation_id, opponent_import_run_game_id, opponent_game_id,
         side, role, display_name, provider_player_id, engine_identity_key, unresolved_reason,
         is_counterparty, statistics)
      values
        (v_org_id, v_opponent_team_id, v_season_id, v_opp_generation.id, null, null,
         v_noncanonical ->> 'side', v_noncanonical ->> 'role', nullif(v_noncanonical ->> 'displayName', ''),
         nullif(v_noncanonical ->> 'providerPlayerId', ''), v_noncanonical ->> 'engineIdentityKey',
         v_noncanonical ->> 'reason', coalesce((v_noncanonical ->> 'isOpponent')::boolean, false),
         coalesce(v_noncanonical -> 'stats', '{}'::jsonb));
    end loop;

    update public.hs_opponent_import_runs
       set status = 'succeeded', completed_at = v_now,
           games_processed = jsonb_array_length(p_dto -> 'observations'),
           games_succeeded = jsonb_array_length(p_dto -> 'observations'), games_failed = 0,
           result_summary = jsonb_build_object('generationId', v_opp_generation.id, 'engineVersion', v_engine_version,
             'inputSetHash', v_input_hash, 'officialTotalsComplete', v_opp_generation.official_totals_complete,
             'finalGameCount', v_final_count)
     where id = v_import_run_id and org_id = v_org_id;

    return jsonb_build_object('subjectKind', 'opponent_team', 'generation', to_jsonb(v_opp_generation));
  end if;

  -- ── Own-team subject: the reviewed Slice 2C path, unchanged ──────────
  if v_subject is not null and (v_subject ->> 'teamId')::uuid is distinct from v_team_id then
    raise exception 'ambiguous_collection_subject' using errcode = 'P0001';
  end if;
  perform 1 from public.hs_teams
   where id = v_team_id and org_id = v_org_id and program_id = v_program_id
   for update;
  if not found then raise exception 'team_not_found_for_org_program' using errcode = 'P0002'; end if;

  perform 1 from public.hs_seasons
   where id = v_season_id and org_id = v_org_id and program_id = v_program_id
   for update;
  if not found then raise exception 'season_not_found_for_org_program' using errcode = 'P0002'; end if;

  perform 1 from public.hs_import_runs
   where id = v_import_run_id and org_id = v_org_id and program_id = v_program_id
     and team_id = v_team_id and season_id = v_season_id and status = 'running'
   for update;
  if not found then
    select * into v_existing from public.hs_stat_generations
     where org_id = v_org_id and team_id = v_team_id and season_id = v_season_id
       and engine_version = v_engine_version and input_set_hash = v_input_hash;
    if found and v_existing.content_hash = v_content_hash then return jsonb_build_object('subjectKind', 'own_team', 'generation', to_jsonb(v_existing)); end if;
    raise exception 'invalid_import_run_state' using errcode = 'P0001';
  end if;

  select * into v_existing from public.hs_stat_generations
   where org_id = v_org_id and team_id = v_team_id and season_id = v_season_id
     and engine_version = v_engine_version and input_set_hash = v_input_hash
   for update;
  if found then
    if v_existing.content_hash <> v_content_hash then
      raise exception 'idempotency_content_mismatch' using errcode = 'P0001';
    end if;
    return jsonb_build_object('subjectKind', 'own_team', 'generation', to_jsonb(v_existing));
  end if;

  for v_observation in select value from jsonb_array_elements(p_dto -> 'observations') order by value ->> 'observationKey'
  loop
    v_candidate_count := 0;
    v_candidate_game_id := null;
    v_resolution_kind := null;
    v_method := v_observation ->> 'identityMethod';
    v_identity_digest := v_observation ->> 'identityDigest';
    v_foundation_digest := v_observation ->> 'foundationalDigest';
    v_discriminators := coalesce(v_observation -> 'discriminators', '{}'::jsonb);
    v_source_ref := nullif(v_observation ->> 'sourceGameRef', '');
    v_game_id := null;

    if coalesce((v_observation ->> 'authoritative')::boolean, false)
       and v_method in ('sourceGameId', 'scheduleComposite') then
      select hs_game_id into v_alias_game_id from public.hs_game_identity_aliases
       where org_id = v_org_id and team_id = v_team_id and season_id = v_season_id
         and source_provider = v_provider and identity_method = v_method and identity_digest = v_identity_digest;
      v_game_id := v_alias_game_id;

      if v_game_id is null and v_method = 'sourceGameId' and v_source_ref is not null then
        select id into v_game_id from public.hs_games
         where org_id = v_org_id and team_id = v_team_id and source_game_ref = v_source_ref;
        if v_game_id is not null then v_resolution_kind := 'automatic_durable'; end if;
      end if;

      if v_game_id is null and v_method = 'scheduleComposite' then
        select count(distinct a.hs_game_id), min(a.hs_game_id::text)::uuid
          into v_candidate_count, v_candidate_game_id
          from public.hs_game_identity_aliases a
         where a.org_id = v_org_id and a.team_id = v_team_id and a.season_id = v_season_id
           and a.source_provider = v_provider and a.identity_method = 'scheduleComposite'
           and a.foundational_digest = v_foundation_digest
           and exists (
             select 1 from jsonb_each_text(a.discriminators) old_d
             join jsonb_each_text(v_discriminators) new_d on new_d.key = old_d.key and new_d.value = old_d.value
           )
           and not exists (
             select 1 from jsonb_each_text(a.discriminators) old_d
             join jsonb_each_text(v_discriminators) new_d on new_d.key = old_d.key and new_d.value <> old_d.value
           );
        if v_candidate_count = 1 then
          v_game_id := v_candidate_game_id;
          v_resolution_kind := 'automatic_fallback_enrichment';
        end if;
        if v_candidate_count > 1 then
          v_game_id := null;
        end if;
      end if;

      if v_game_id is null and not (v_method = 'scheduleComposite' and coalesce(v_candidate_count, 0) > 1) then
        insert into public.hs_games (org_id, program_id, team_id, season_id, opponent_name, game_date, source_provider, source_game_ref)
        values (v_org_id, v_program_id, v_team_id, v_season_id,
          nullif(v_observation ->> 'opponentName', ''), nullif(v_observation ->> 'gameDate', '')::date,
          v_provider, case when v_method = 'sourceGameId' then v_source_ref else null end)
        on conflict (team_id, source_game_ref) where source_game_ref is not null do update set updated_at = public.hs_games.updated_at
        returning id into v_game_id;
      end if;

      if v_game_id is not null then
        insert into public.hs_game_identity_aliases
          (org_id, program_id, team_id, season_id, hs_game_id, source_provider, identity_method, identity_digest, foundational_digest, discriminators)
        values (v_org_id, v_program_id, v_team_id, v_season_id, v_game_id, v_provider, v_method, v_identity_digest, v_foundation_digest, v_discriminators)
        on conflict (org_id, team_id, season_id, source_provider, identity_method, identity_digest) do nothing;
      end if;
    end if;

    insert into public.hs_import_run_games
      (org_id, import_run_id, hs_game_id, source_game_ref, source_game_url, discovery_status, game_outcome,
       diagnostics, observation_key, source_provider, identity_method, identity_status, identity_digest,
       authoritative, excluded_from_official_totals, ambiguity_component_digest, engine_version, input_set_hash)
    values
      (v_org_id, v_import_run_id, v_game_id, v_source_ref, nullif(v_observation ->> 'sourceGameUrl', ''), 'processed',
       case when v_game_id is null then 'replaced' else 'inserted' end,
       coalesce(v_observation -> 'diagnostics', '{}'::jsonb), v_observation ->> 'observationKey', v_provider,
       v_method, v_observation ->> 'identityStatus', v_identity_digest,
       coalesce((v_observation ->> 'authoritative')::boolean, false),
       coalesce((v_observation ->> 'excludedFromOfficialTotals')::boolean, false),
       nullif(v_observation ->> 'ambiguityComponentDigest', ''), v_engine_version, v_input_hash)
    on conflict (import_run_id, observation_key) where observation_key is not null
    do update set diagnostics = excluded.diagnostics
    returning id into v_run_game_id;

    if v_resolution_kind is not null and v_game_id is not null then
      v_prior_status := case v_observation ->> 'identityStatus'
        when 'deduplicated' then 'single'
        else v_observation ->> 'identityStatus'
      end;
      insert into public.hs_game_identity_resolutions
        (org_id, team_id, season_id, import_run_id, import_run_game_id, hs_game_id,
         resolution_kind, prior_identity_status, evidence_digest)
      values
        (v_org_id, v_team_id, v_season_id, v_import_run_id, v_run_game_id, v_game_id,
         v_resolution_kind, v_prior_status, v_identity_digest)
      on conflict (org_id, import_run_game_id, hs_game_id, evidence_digest) do nothing;
    end if;

    for v_snapshot in select value from jsonb_array_elements(coalesce(v_observation -> 'snapshots', '[]'::jsonb)) order by value ->> 'kind'
    loop
      insert into public.hs_raw_snapshots
        (org_id, import_run_id, import_run_game_id, hs_game_id, snapshot_kind, source_provider,
         source_ref, captured_at, payload, content_type, schema_version, integrity_hash)
      values
        (v_org_id, v_import_run_id, v_run_game_id, v_game_id, v_snapshot ->> 'kind', v_provider,
         nullif(v_snapshot ->> 'sourceRef', ''), (v_snapshot ->> 'capturedAt')::timestamptz,
         coalesce(v_snapshot -> 'payload', '{}'::jsonb), 'json', v_engine_version, v_snapshot ->> 'integrityHash')
      on conflict (import_run_game_id, snapshot_kind, captured_at) where import_run_game_id is not null do nothing;
    end loop;

    insert into public.hs_game_validation_results
      (org_id, import_run_id, import_run_game_id, hs_game_id, team_id, has_box_score, has_play_by_play,
       scouted_side, opponent_side, box_score_batting, box_score_pitching, reconstructed_batting,
       reconstructed_pitching, deltas, batting_matches_box, quality, warnings, confidence,
       validation_status, identity_method, identity_status, identity_digest, authoritative,
       excluded_from_official_totals, conflict_fields, diagnostic_status, diagnostic_code,
       ambiguity_component_digest, engine_version, input_set_hash)
    values
      (v_org_id, v_import_run_id, v_run_game_id, v_game_id, v_team_id,
       coalesce((v_observation #>> '{validation,hasBoxScore}')::boolean, false),
       coalesce((v_observation #>> '{validation,hasPlayByPlay}')::boolean, false),
       nullif(v_observation #>> '{validation,ownSide}', ''), nullif(v_observation #>> '{validation,opponentSide}', ''),
       coalesce(v_observation #> '{validation,boxScoreBatting}', '{}'::jsonb),
       coalesce(v_observation #> '{validation,boxScorePitching}', '{}'::jsonb),
       coalesce(v_observation #> '{validation,reconstructedBatting}', '{}'::jsonb),
       coalesce(v_observation #> '{validation,reconstructedPitching}', '{}'::jsonb),
       coalesce(v_observation #> '{validation,deltas}', '{}'::jsonb),
       coalesce((v_observation #>> '{validation,battingMatchesBox}')::boolean, false),
       coalesce(v_observation #> '{validation,quality}', '{}'::jsonb),
       coalesce(v_observation #> '{validation,warnings}', '[]'::jsonb),
       coalesce(v_observation #>> '{validation,confidence}', 'low'),
       coalesce(v_observation #>> '{validation,status}', 'pending'),
       v_method, v_observation ->> 'identityStatus', v_identity_digest,
       coalesce((v_observation ->> 'authoritative')::boolean, false),
       coalesce((v_observation ->> 'excludedFromOfficialTotals')::boolean, false),
       coalesce(v_observation -> 'conflictFields', '[]'::jsonb),
       v_observation #>> '{diagnostic,status}', nullif(v_observation #>> '{diagnostic,code}', ''),
       nullif(v_observation ->> 'ambiguityComponentDigest', ''), v_engine_version, v_input_hash)
    on conflict (import_run_id, import_run_game_id) where import_run_game_id is not null do nothing;
  end loop;

  update public.hs_stat_generations set is_current = false, status = 'superseded', superseded_at = v_now
   where org_id = v_org_id and team_id = v_team_id and season_id = v_season_id and is_current;
  update public.hs_verified_totals set is_current = false, superseded_at = v_now
   where org_id = v_org_id and team_id = v_team_id and season_id = v_season_id and is_current;
  update public.hs_player_advanced_stats set is_current = false, superseded_at = v_now
   where org_id = v_org_id and team_id = v_team_id and season_id = v_season_id and is_current;
  update public.hs_pitcher_advanced_stats set is_current = false, superseded_at = v_now
   where org_id = v_org_id and team_id = v_team_id and season_id = v_season_id and is_current;

  insert into public.hs_stat_generations
    (org_id, program_id, team_id, season_id, import_run_id, engine_version, input_set_hash, content_hash,
     payload_bytes, observation_count, snapshot_count, canonical_player_count, noncanonical_player_count,
     official_totals_complete, status, is_current, completed_at)
  values
    (v_org_id, v_program_id, v_team_id, v_season_id, v_import_run_id, v_engine_version, v_input_hash, v_content_hash,
     v_payload_bytes, jsonb_array_length(p_dto -> 'observations'), coalesce((p_dto ->> 'snapshotCount')::integer, 0),
     jsonb_array_length(p_dto -> 'canonicalPlayers'), jsonb_array_length(p_dto -> 'noncanonicalPlayers'),
     coalesce((p_dto ->> 'officialTotalsComplete')::boolean, false), 'completed', true, v_now)
  returning * into v_generation;

  insert into public.hs_verified_totals
    (org_id, program_id, team_id, season_id, import_run_id, games, box_score_games, play_by_play_games,
     validated_games, mismatch_games, batting_official, pitching_official, batting_reconstructed,
     pitching_reconstructed, tendencies, warnings, confidence, is_current, generation_id, engine_version, input_set_hash)
  values
    (v_org_id, v_program_id, v_team_id, v_season_id, v_import_run_id,
     coalesce((v_totals ->> 'games')::integer, 0), coalesce((v_totals ->> 'boxScoreGames')::integer, 0),
     coalesce((v_totals ->> 'playByPlayGames')::integer, 0), coalesce((v_totals ->> 'validatedGames')::integer, 0),
     coalesce((v_totals ->> 'mismatchGames')::integer, 0), coalesce(v_totals -> 'officialBatting', '{}'::jsonb),
     coalesce(v_totals -> 'officialPitching', '{}'::jsonb), coalesce(v_totals -> 'reconstructedBatting', '{}'::jsonb),
     coalesce(v_totals -> 'reconstructedPitchingDefense', '{}'::jsonb), coalesce(v_totals -> 'tendencies', '{}'::jsonb),
     coalesce(v_totals -> 'warnings', '[]'::jsonb), coalesce(v_totals ->> 'confidence', 'low'), true,
     v_generation.id, v_engine_version, v_input_hash);

  for v_player in select value from jsonb_array_elements(p_dto -> 'canonicalPlayers') order by value ->> 'playerId', value ->> 'role'
  loop
    perform 1 from public.hs_roster_memberships rm
     where rm.org_id = v_org_id and rm.team_id = v_team_id and rm.season_id = v_season_id
       and rm.player_id = (v_player ->> 'playerId')::uuid;
    if not found then raise exception 'player_not_on_roster' using errcode = 'P0002'; end if;
    if v_player ->> 'role' = 'batter' then
      insert into public.hs_player_advanced_stats
        (org_id, program_id, team_id, season_id, player_id, import_run_id, games, errors, bunts,
         is_current, generation_id, engine_version, input_set_hash, statistics)
      values
        (v_org_id, v_program_id, v_team_id, v_season_id, (v_player ->> 'playerId')::uuid, v_import_run_id,
         nullif(v_player #>> '{stats,games}', '')::integer, coalesce(nullif(v_player #>> '{stats,E}', '')::integer, 0),
         coalesce(nullif(v_player #>> '{stats,bunts}', '')::integer, 0), true, v_generation.id,
         v_engine_version, v_input_hash, coalesce(v_player -> 'stats', '{}'::jsonb));
    elsif v_player ->> 'role' = 'pitcher' then
      insert into public.hs_pitcher_advanced_stats
        (org_id, program_id, team_id, season_id, player_id, import_run_id, games, wp, bk, pik,
         is_current, generation_id, engine_version, input_set_hash, statistics)
      values
        (v_org_id, v_program_id, v_team_id, v_season_id, (v_player ->> 'playerId')::uuid, v_import_run_id,
         nullif(v_player #>> '{stats,games}', '')::integer, coalesce(nullif(v_player #>> '{stats,WP}', '')::integer, 0),
         coalesce(nullif(v_player #>> '{stats,BK}', '')::integer, 0), coalesce(nullif(v_player #>> '{stats,PIK}', '')::integer, 0),
         true, v_generation.id, v_engine_version, v_input_hash, coalesce(v_player -> 'stats', '{}'::jsonb));
    else
      raise exception 'invalid_canonical_player_role' using errcode = 'P0001';
    end if;
  end loop;

  for v_noncanonical in select value from jsonb_array_elements(p_dto -> 'noncanonicalPlayers') order by value ->> 'engineIdentityKey', value ->> 'role'
  loop
    insert into public.hs_noncanonical_player_stats
      (org_id, team_id, season_id, generation_id, import_run_game_id, hs_game_id, side, role,
       display_name, provider_player_id, engine_identity_key, unresolved_reason, is_opponent, statistics)
    values
      (v_org_id, v_team_id, v_season_id, v_generation.id, null, null,
       v_noncanonical ->> 'side', v_noncanonical ->> 'role', nullif(v_noncanonical ->> 'displayName', ''),
       nullif(v_noncanonical ->> 'providerPlayerId', ''), v_noncanonical ->> 'engineIdentityKey',
       v_noncanonical ->> 'reason', coalesce((v_noncanonical ->> 'isOpponent')::boolean, false),
       coalesce(v_noncanonical -> 'stats', '{}'::jsonb));
  end loop;

  update public.hs_import_runs
     set status = 'succeeded', completed_at = v_now,
         games_processed = jsonb_array_length(p_dto -> 'observations'),
         games_succeeded = jsonb_array_length(p_dto -> 'observations'), games_failed = 0,
         result_summary = jsonb_build_object('generationId', v_generation.id, 'engineVersion', v_engine_version,
           'inputSetHash', v_input_hash, 'officialTotalsComplete', v_generation.official_totals_complete)
   where id = v_import_run_id and org_id = v_org_id;

  return jsonb_build_object('subjectKind', 'own_team', 'generation', to_jsonb(v_generation));
end;
$function$;

revoke execute on function public.persist_hs_engine_collection(jsonb) from public, anon, authenticated;
grant execute on function public.persist_hs_engine_collection(jsonb) to postgres, service_role;
