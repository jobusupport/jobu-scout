-- High School Slice 2C: collection-engine persistence boundary.
--
-- Backward compatible: legacy rows and the three Slice 1A publication RPCs
-- remain valid.  New Slice 2C writes always carry a generation and engine
-- contract version; legacy columns added below are nullable for old rows.

alter table public.hs_import_run_games
  alter column source_game_ref drop not null,
  add column observation_key text,
  add column source_provider text,
  add column identity_method text,
  add column identity_status text,
  add column identity_digest text,
  add column authoritative boolean,
  add column excluded_from_official_totals boolean,
  add column ambiguity_component_digest text,
  add column engine_version text,
  add column input_set_hash text;

-- Slice 1A allowed only one row per resolved game in an import run.  The
-- collection engine deliberately retains every source observation (including
-- replays and fallback-enrichment evidence), so observation_key replaces the
-- resolved game as the per-run idempotency boundary.
alter table public.hs_import_run_games
  drop constraint hs_import_run_games_run_source_ref_key;
drop index public.idx_hs_import_run_games_run_hs_game;

alter table public.hs_import_run_games
  add constraint hs_import_run_games_observation_key_digest_check
    check (observation_key is null or observation_key ~ '^[0-9a-f]{64}$'),
  add constraint hs_import_run_games_source_provider_2c_check
    check (source_provider is null or source_provider = 'gamechanger'),
  add constraint hs_import_run_games_identity_method_check
    check (identity_method is null or identity_method in ('sourceGameId', 'scheduleComposite', 'unresolvedScoped')),
  add constraint hs_import_run_games_identity_status_check
    check (identity_status is null or identity_status in ('single', 'deduplicated', 'reconciled', 'conflict', 'unresolved', 'ambiguous')),
  add constraint hs_import_run_games_identity_digest_check
    check (identity_digest is null or identity_digest ~ '^[0-9a-f]{64}$'),
  add constraint hs_import_run_games_ambiguity_digest_check
    check (ambiguity_component_digest is null or ambiguity_component_digest ~ '^[0-9a-f]{64}$'),
  add constraint hs_import_run_games_input_set_hash_check
    check (input_set_hash is null or input_set_hash ~ '^[0-9a-f]{64}$');

create unique index idx_hs_import_run_games_run_observation
  on public.hs_import_run_games (import_run_id, observation_key)
  where observation_key is not null;
create index idx_hs_import_run_games_org_identity_digest
  on public.hs_import_run_games (org_id, identity_digest)
  where identity_digest is not null;
create index idx_hs_import_run_games_ambiguity_component
  on public.hs_import_run_games (org_id, import_run_id, ambiguity_component_digest)
  where ambiguity_component_digest is not null;

alter table public.hs_game_validation_results
  alter column hs_game_id drop not null,
  add column identity_method text,
  add column identity_status text,
  add column identity_digest text,
  add column authoritative boolean,
  add column excluded_from_official_totals boolean not null default false,
  add column conflict_fields jsonb not null default '[]'::jsonb,
  add column diagnostic_status text,
  add column diagnostic_code text,
  add column ambiguity_component_digest text,
  add column engine_version text,
  add column input_set_hash text;

alter table public.hs_game_validation_results
  drop constraint hs_game_validation_results_run_game_key;

alter table public.hs_game_validation_results
  add constraint hs_game_validation_results_identity_method_check
    check (identity_method is null or identity_method in ('sourceGameId', 'scheduleComposite', 'unresolvedScoped')),
  add constraint hs_game_validation_results_identity_status_2c_check
    check (identity_status is null or identity_status in ('single', 'deduplicated', 'reconciled', 'conflict', 'unresolved', 'ambiguous')),
  add constraint hs_game_validation_results_identity_digest_check
    check (identity_digest is null or identity_digest ~ '^[0-9a-f]{64}$'),
  add constraint hs_game_validation_results_diagnostic_status_check
    check (diagnostic_status is null or diagnostic_status in ('ok', 'error', 'not_run')),
  add constraint hs_game_validation_results_ambiguity_digest_check
    check (ambiguity_component_digest is null or ambiguity_component_digest ~ '^[0-9a-f]{64}$'),
  add constraint hs_game_validation_results_input_set_hash_check
    check (input_set_hash is null or input_set_hash ~ '^[0-9a-f]{64}$');

create unique index idx_hs_game_validation_results_run_observation
  on public.hs_game_validation_results (import_run_id, import_run_game_id)
  where import_run_game_id is not null;
create index idx_hs_game_validation_results_run_game_id
  on public.hs_game_validation_results (import_run_game_id)
  where import_run_game_id is not null;

create table public.hs_game_identity_aliases (
  id uuid primary key default extensions.uuid_generate_v4(),
  org_id uuid not null,
  program_id uuid not null,
  team_id uuid not null,
  season_id uuid not null,
  hs_game_id uuid not null,
  source_provider text not null,
  identity_method text not null,
  identity_digest text not null,
  foundational_digest text,
  discriminators jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint hs_game_identity_aliases_org_id_id_key unique (org_id, id),
  constraint hs_game_identity_aliases_org_fkey foreign key (org_id) references public.organizations (id) on delete cascade,
  constraint hs_game_identity_aliases_org_program_fkey foreign key (org_id, program_id) references public.hs_programs (org_id, id) on delete cascade,
  constraint hs_game_identity_aliases_org_team_fkey foreign key (org_id, team_id) references public.hs_teams (org_id, id) on delete cascade,
  constraint hs_game_identity_aliases_org_season_fkey foreign key (org_id, season_id) references public.hs_seasons (org_id, id) on delete cascade,
  constraint hs_game_identity_aliases_org_game_fkey foreign key (org_id, hs_game_id) references public.hs_games (org_id, id) on delete cascade,
  constraint hs_game_identity_aliases_provider_check check (source_provider = 'gamechanger'),
  constraint hs_game_identity_aliases_method_check check (identity_method in ('sourceGameId', 'scheduleComposite')),
  constraint hs_game_identity_aliases_digest_check check (identity_digest ~ '^[0-9a-f]{64}$'),
  constraint hs_game_identity_aliases_foundational_digest_check check (foundational_digest is null or foundational_digest ~ '^[0-9a-f]{64}$'),
  constraint hs_game_identity_aliases_fallback_foundation_check check (identity_method <> 'scheduleComposite' or foundational_digest is not null),
  constraint hs_game_identity_aliases_scope_key unique (org_id, team_id, season_id, source_provider, identity_method, identity_digest)
);

create index idx_hs_game_identity_aliases_org_id on public.hs_game_identity_aliases (org_id);
create index idx_hs_game_identity_aliases_program_id on public.hs_game_identity_aliases (program_id);
create index idx_hs_game_identity_aliases_team_id on public.hs_game_identity_aliases (team_id);
create index idx_hs_game_identity_aliases_season_id on public.hs_game_identity_aliases (season_id);
create index idx_hs_game_identity_aliases_hs_game_id on public.hs_game_identity_aliases (hs_game_id);
create index idx_hs_game_identity_aliases_fallback_lookup
  on public.hs_game_identity_aliases (org_id, team_id, season_id, source_provider, foundational_digest)
  where identity_method = 'scheduleComposite';

create table public.hs_game_identity_resolutions (
  id uuid primary key default extensions.uuid_generate_v4(),
  org_id uuid not null,
  team_id uuid not null,
  season_id uuid not null,
  import_run_id uuid not null,
  import_run_game_id uuid not null,
  hs_game_id uuid not null,
  resolution_kind text not null,
  prior_identity_status text not null,
  evidence_digest text not null,
  created_at timestamptz not null default now(),
  constraint hs_game_identity_resolutions_org_id_id_key unique (org_id, id),
  constraint hs_game_identity_resolutions_org_fkey foreign key (org_id) references public.organizations (id) on delete cascade,
  constraint hs_game_identity_resolutions_org_team_fkey foreign key (org_id, team_id) references public.hs_teams (org_id, id) on delete cascade,
  constraint hs_game_identity_resolutions_org_season_fkey foreign key (org_id, season_id) references public.hs_seasons (org_id, id) on delete cascade,
  constraint hs_game_identity_resolutions_org_run_fkey foreign key (org_id, import_run_id) references public.hs_import_runs (org_id, id) on delete cascade,
  constraint hs_game_identity_resolutions_org_run_game_fkey foreign key (org_id, import_run_game_id) references public.hs_import_run_games (org_id, id) on delete cascade,
  constraint hs_game_identity_resolutions_org_game_fkey foreign key (org_id, hs_game_id) references public.hs_games (org_id, id) on delete cascade,
  constraint hs_game_identity_resolutions_kind_check check (resolution_kind in ('automatic_durable', 'automatic_fallback_enrichment', 'manual')),
  constraint hs_game_identity_resolutions_prior_status_check check (prior_identity_status in ('unresolved', 'ambiguous', 'single', 'reconciled', 'conflict')),
  constraint hs_game_identity_resolutions_evidence_digest_check check (evidence_digest ~ '^[0-9a-f]{64}$'),
  constraint hs_game_identity_resolutions_once unique (org_id, import_run_game_id, hs_game_id, evidence_digest)
);

create index idx_hs_game_identity_resolutions_org_id on public.hs_game_identity_resolutions (org_id);
create index idx_hs_game_identity_resolutions_team_id on public.hs_game_identity_resolutions (team_id);
create index idx_hs_game_identity_resolutions_season_id on public.hs_game_identity_resolutions (season_id);
create index idx_hs_game_identity_resolutions_import_run_id on public.hs_game_identity_resolutions (import_run_id);
create index idx_hs_game_identity_resolutions_import_run_game_id on public.hs_game_identity_resolutions (import_run_game_id);
create index idx_hs_game_identity_resolutions_hs_game_id on public.hs_game_identity_resolutions (hs_game_id);

create table public.hs_stat_generations (
  id uuid primary key default extensions.uuid_generate_v4(),
  org_id uuid not null,
  program_id uuid not null,
  team_id uuid not null,
  season_id uuid not null,
  import_run_id uuid not null,
  engine_version text not null,
  input_set_hash text not null,
  content_hash text not null,
  payload_bytes integer not null,
  observation_count integer not null,
  snapshot_count integer not null,
  canonical_player_count integer not null,
  noncanonical_player_count integer not null,
  official_totals_complete boolean not null,
  status text not null default 'completed',
  is_current boolean not null default true,
  completed_at timestamptz not null default now(),
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  constraint hs_stat_generations_org_id_id_key unique (org_id, id),
  constraint hs_stat_generations_org_fkey foreign key (org_id) references public.organizations (id) on delete cascade,
  constraint hs_stat_generations_org_program_fkey foreign key (org_id, program_id) references public.hs_programs (org_id, id) on delete cascade,
  constraint hs_stat_generations_org_team_fkey foreign key (org_id, team_id) references public.hs_teams (org_id, id) on delete cascade,
  constraint hs_stat_generations_org_season_fkey foreign key (org_id, season_id) references public.hs_seasons (org_id, id) on delete cascade,
  constraint hs_stat_generations_org_run_fkey foreign key (org_id, import_run_id) references public.hs_import_runs (org_id, id) on delete cascade,
  constraint hs_stat_generations_engine_version_check check (engine_version = 'hs-baseball-engine/v1'),
  constraint hs_stat_generations_input_set_hash_check check (input_set_hash ~ '^[0-9a-f]{64}$'),
  constraint hs_stat_generations_content_hash_check check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint hs_stat_generations_payload_bytes_check check (payload_bytes between 0 and 4194304),
  constraint hs_stat_generations_counts_check check (observation_count >= 0 and snapshot_count >= 0 and canonical_player_count >= 0 and noncanonical_player_count >= 0),
  constraint hs_stat_generations_status_check check (status in ('completed', 'superseded')),
  constraint hs_stat_generations_current_consistency_check check ((is_current and status = 'completed' and superseded_at is null) or (not is_current and status = 'superseded' and superseded_at is not null)),
  constraint hs_stat_generations_idempotency_key unique (org_id, team_id, season_id, engine_version, input_set_hash)
);

create index idx_hs_stat_generations_org_id on public.hs_stat_generations (org_id);
create index idx_hs_stat_generations_program_id on public.hs_stat_generations (program_id);
create index idx_hs_stat_generations_team_id on public.hs_stat_generations (team_id);
create index idx_hs_stat_generations_season_id on public.hs_stat_generations (season_id);
create index idx_hs_stat_generations_import_run_id on public.hs_stat_generations (import_run_id);
create unique index idx_hs_stat_generations_current_per_team_season
  on public.hs_stat_generations (org_id, team_id, season_id) where is_current;

create table public.hs_noncanonical_player_stats (
  id uuid primary key default extensions.uuid_generate_v4(),
  org_id uuid not null,
  team_id uuid not null,
  season_id uuid not null,
  generation_id uuid not null,
  import_run_game_id uuid,
  hs_game_id uuid,
  side text not null,
  role text not null,
  display_name text,
  provider_player_id text,
  engine_identity_key text not null,
  unresolved_reason text not null,
  is_opponent boolean not null,
  statistics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint hs_noncanonical_player_stats_org_id_id_key unique (org_id, id),
  constraint hs_noncanonical_player_stats_org_fkey foreign key (org_id) references public.organizations (id) on delete cascade,
  constraint hs_noncanonical_player_stats_org_team_fkey foreign key (org_id, team_id) references public.hs_teams (org_id, id) on delete cascade,
  constraint hs_noncanonical_player_stats_org_season_fkey foreign key (org_id, season_id) references public.hs_seasons (org_id, id) on delete cascade,
  constraint hs_noncanonical_player_stats_org_generation_fkey foreign key (org_id, generation_id) references public.hs_stat_generations (org_id, id) on delete cascade,
  constraint hs_noncanonical_player_stats_org_run_game_fkey foreign key (org_id, import_run_game_id) references public.hs_import_run_games (org_id, id) on delete cascade,
  constraint hs_noncanonical_player_stats_org_game_fkey foreign key (org_id, hs_game_id) references public.hs_games (org_id, id) on delete cascade,
  constraint hs_noncanonical_player_stats_side_check check (side in ('own', 'opponent', 'unknown')),
  constraint hs_noncanonical_player_stats_role_check check (role in ('batter', 'pitcher', 'fielder')),
  constraint hs_noncanonical_player_stats_identity_key_length_check check (char_length(engine_identity_key) between 1 and 512),
  constraint hs_noncanonical_player_stats_reason_length_check check (char_length(unresolved_reason) between 1 and 1000),
  constraint hs_noncanonical_player_stats_generation_identity_key unique (generation_id, role, side, engine_identity_key)
);

create index idx_hs_noncanonical_player_stats_org_id on public.hs_noncanonical_player_stats (org_id);
create index idx_hs_noncanonical_player_stats_team_id on public.hs_noncanonical_player_stats (team_id);
create index idx_hs_noncanonical_player_stats_season_id on public.hs_noncanonical_player_stats (season_id);
create index idx_hs_noncanonical_player_stats_generation_id on public.hs_noncanonical_player_stats (generation_id);
create index idx_hs_noncanonical_player_stats_import_run_game_id on public.hs_noncanonical_player_stats (import_run_game_id) where import_run_game_id is not null;
create index idx_hs_noncanonical_player_stats_hs_game_id on public.hs_noncanonical_player_stats (hs_game_id) where hs_game_id is not null;

alter table public.hs_verified_totals
  add column generation_id uuid,
  add column engine_version text,
  add column input_set_hash text;
alter table public.hs_verified_totals
  add constraint hs_verified_totals_org_generation_fkey foreign key (org_id, generation_id) references public.hs_stat_generations (org_id, id) on delete cascade,
  add constraint hs_verified_totals_input_set_hash_2c_check check (input_set_hash is null or input_set_hash ~ '^[0-9a-f]{64}$');
create index idx_hs_verified_totals_generation_id on public.hs_verified_totals (generation_id) where generation_id is not null;

alter table public.hs_player_advanced_stats
  add column generation_id uuid,
  add column engine_version text,
  add column input_set_hash text,
  add column statistics jsonb not null default '{}'::jsonb;
alter table public.hs_player_advanced_stats
  add constraint hs_player_advanced_stats_org_generation_fkey foreign key (org_id, generation_id) references public.hs_stat_generations (org_id, id) on delete cascade,
  add constraint hs_player_advanced_stats_input_set_hash_2c_check check (input_set_hash is null or input_set_hash ~ '^[0-9a-f]{64}$');
create index idx_hs_player_advanced_stats_generation_id on public.hs_player_advanced_stats (generation_id) where generation_id is not null;

alter table public.hs_pitcher_advanced_stats
  add column generation_id uuid,
  add column engine_version text,
  add column input_set_hash text,
  add column statistics jsonb not null default '{}'::jsonb;
alter table public.hs_pitcher_advanced_stats
  add constraint hs_pitcher_advanced_stats_org_generation_fkey foreign key (org_id, generation_id) references public.hs_stat_generations (org_id, id) on delete cascade,
  add constraint hs_pitcher_advanced_stats_input_set_hash_2c_check check (input_set_hash is null or input_set_hash ~ '^[0-9a-f]{64}$');
create index idx_hs_pitcher_advanced_stats_generation_id on public.hs_pitcher_advanced_stats (generation_id) where generation_id is not null;

alter table public.hs_game_identity_aliases enable row level security;
alter table public.hs_game_identity_resolutions enable row level security;
alter table public.hs_stat_generations enable row level security;
alter table public.hs_noncanonical_player_stats enable row level security;

create policy hs_game_identity_aliases_select on public.hs_game_identity_aliases for select to authenticated
using (org_id in (select public.auth_user_org_ids()) and exists (
  select 1 from public.organizations o where o.id = org_id and 'high_school' = any(o.enabled_products)
));
create policy hs_game_identity_resolutions_select on public.hs_game_identity_resolutions for select to authenticated
using (org_id in (select public.auth_user_org_ids()) and exists (
  select 1 from public.organizations o where o.id = org_id and 'high_school' = any(o.enabled_products)
));
create policy hs_stat_generations_select on public.hs_stat_generations for select to authenticated
using (org_id in (select public.auth_user_org_ids()) and exists (
  select 1 from public.organizations o where o.id = org_id and 'high_school' = any(o.enabled_products)
));
create policy hs_noncanonical_player_stats_select on public.hs_noncanonical_player_stats for select to authenticated
using (org_id in (select public.auth_user_org_ids()) and exists (
  select 1 from public.organizations o where o.id = org_id and 'high_school' = any(o.enabled_products)
));

revoke all on public.hs_game_identity_aliases, public.hs_game_identity_resolutions,
  public.hs_stat_generations, public.hs_noncanonical_player_stats from public, anon, authenticated;
grant select on public.hs_game_identity_aliases, public.hs_game_identity_resolutions,
  public.hs_stat_generations, public.hs_noncanonical_player_stats to authenticated;
-- SECURITY INVOKER privilege closure for persist_hs_engine_collection(jsonb).
-- Prerequisite hierarchy rows are provisioned outside this boundary; the RPC
-- only locks/validates them. Persistence writes are limited to the tables the
-- function mutates below. No organization privilege is required or granted.
revoke insert, update, delete, truncate on public.organizations from service_role;
grant select on public.organizations to authenticated;
revoke insert, update, delete, truncate on public.organizations, public.hs_teams,
  public.hs_seasons, public.hs_import_runs, public.hs_roster_memberships,
  public.hs_games, public.hs_import_run_games, public.hs_game_identity_aliases,
  public.hs_game_identity_resolutions, public.hs_raw_snapshots,
  public.hs_game_validation_results, public.hs_stat_generations,
  public.hs_noncanonical_player_stats, public.hs_verified_totals,
  public.hs_player_advanced_stats, public.hs_pitcher_advanced_stats
  from public, anon, authenticated;
revoke delete, truncate, references, trigger on public.hs_teams, public.hs_seasons,
  public.hs_import_runs, public.hs_roster_memberships, public.hs_games,
  public.hs_import_run_games, public.hs_game_identity_aliases,
  public.hs_game_identity_resolutions, public.hs_raw_snapshots,
  public.hs_game_validation_results, public.hs_stat_generations,
  public.hs_noncanonical_player_stats, public.hs_verified_totals,
  public.hs_player_advanced_stats, public.hs_pitcher_advanced_stats from service_role;
grant select, update on public.hs_teams, public.hs_seasons to service_role;
grant select, update on public.hs_import_runs to service_role;
grant select on public.hs_roster_memberships to service_role;
grant select, insert, update on public.hs_games, public.hs_import_run_games,
  public.hs_game_identity_aliases, public.hs_stat_generations to service_role;
grant select, insert on public.hs_game_identity_resolutions, public.hs_raw_snapshots,
  public.hs_game_validation_results, public.hs_noncanonical_player_stats to service_role;
grant select, insert, update on public.hs_verified_totals, public.hs_player_advanced_stats,
  public.hs_pitcher_advanced_stats to service_role;

create or replace function public.persist_hs_engine_collection(p_dto jsonb)
returns public.hs_stat_generations
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
       'teamTotals', 'officialTotalsComplete'
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
             'validation', 'snapshots', 'engineVersion'
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
    if found and v_existing.content_hash = v_content_hash then return v_existing; end if;
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
    return v_existing;
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
       coalesce(v_observation #>> '{diagnostic,status}', 'not_run'), nullif(v_observation #>> '{diagnostic,code}', ''),
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

  return v_generation;
end;
$function$;

revoke execute on function public.persist_hs_engine_collection(jsonb) from public, anon, authenticated;
grant execute on function public.persist_hs_engine_collection(jsonb) to postgres, service_role;
