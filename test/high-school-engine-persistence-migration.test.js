'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(__dirname, '..', 'supabase', 'migrations', '20260814190557_add_hs_engine_persistence_boundary.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');

const newTables = [
  'hs_game_identity_aliases',
  'hs_game_identity_resolutions',
  'hs_stat_generations',
  'hs_noncanonical_player_stats',
];

test('Slice 2C migration creates the four approved tenant-owned tables', () => {
  for (const table of newTables) {
    assert.match(sql, new RegExp(`create table public\\.${table} \\(`, 'i'));
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
    assert.match(sql, new RegExp(`create policy ${table}_select`, 'i'));
    assert.match(sql, new RegExp(`${table}[\\s\\S]*?org_id uuid not null`, 'i'));
  }
});

test('new-table policies require both tenant membership and High School entitlement', () => {
  for (const table of newTables) {
    const policy = sql.match(new RegExp(`create policy ${table}_select[\\s\\S]*?;`, 'i'))?.[0] || '';
    assert.match(policy, /to authenticated/i);
    assert.match(policy, /org_id in \(select public\.auth_user_org_ids\(\)\)/i);
    assert.match(policy, /'high_school' = any\(o\.enabled_products\)/i);
  }
});

test('new tables grant authenticated read only and reserve writes for service_role', () => {
  assert.match(sql, /revoke all on public\.hs_game_identity_aliases[\s\S]*?from public, anon, authenticated;/i);
  assert.match(sql, /grant select on public\.hs_game_identity_aliases[\s\S]*?to authenticated;/i);
  assert.doesNotMatch(sql, /grant\s+all[\s\S]*?to\s+service_role/i);
  assert.match(sql, /grant select, insert, update on public\.hs_games, public\.hs_import_run_games,[\s\S]*?public\.hs_game_identity_aliases, public\.hs_stat_generations to service_role;/i);
  assert.match(sql, /grant select, insert on public\.hs_game_identity_resolutions, public\.hs_raw_snapshots,[\s\S]*?public\.hs_noncanonical_player_stats to service_role;/i);
  assert.doesNotMatch(sql, /grant\s+(insert|update|delete|all)[\s\S]*?to\s+(anon|authenticated)/i);
});

test('SECURITY INVOKER closure is explicit and never grants organization mutation', () => {
  assert.match(sql, /grant select, update on public\.hs_teams, public\.hs_seasons to service_role;/i);
  assert.match(sql, /grant select, update on public\.hs_import_runs to service_role;/i);
  assert.match(sql, /grant select on public\.hs_roster_memberships to service_role;/i);
  assert.match(sql, /revoke insert, update, delete, truncate on public\.organizations from service_role;/i);
  assert.match(sql, /grant select on public\.organizations to authenticated;/i);
  assert.match(sql, /revoke insert, update, delete, truncate on public\.organizations, public\.hs_teams,[\s\S]*?from public, anon, authenticated;/i);
  assert.doesNotMatch(sql, /grant\s+(?:select|insert|update|delete|all)[^;]*public\.organizations[^;]*to\s+service_role/i);
  assert.doesNotMatch(sql, /grant[^;]*all tables|alter default privileges/i);
});

test('collection RPC is invoker-security and executable only by trusted database roles', () => {
  const fn = sql.match(/create or replace function public\.persist_hs_engine_collection[\s\S]*?\$function\$;/i)?.[0] || '';
  assert.match(fn, /security invoker/i);
  assert.doesNotMatch(fn, /security definer/i);
  assert.match(fn, /set search_path = ''/i);
  assert.doesNotMatch(fn, /\bexecute\b\s+/i, 'RPC must contain no dynamic SQL');
  assert.match(sql, /revoke execute on function public\.persist_hs_engine_collection\(jsonb\) from public, anon, authenticated;/i);
  assert.match(sql, /grant execute on function public\.persist_hs_engine_collection\(jsonb\) to postgres, service_role;/i);
});

test('migration carries generation idempotency, current-generation, digest, and 4 MiB constraints', () => {
  assert.match(sql, /unique \(org_id, team_id, season_id, engine_version, input_set_hash\)/i);
  assert.match(sql, /unique index idx_hs_stat_generations_current_per_team_season[\s\S]*?where is_current/i);
  assert.match(sql, /payload_bytes between 0 and 4194304/i);
  assert.match(sql, /input_set_hash ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(sql, /identity_digest ~ '\^\[0-9a-f\]\{64\}\$'/i);
});

test('legacy rows stay valid while Slice 2C publications can link generations', () => {
  for (const table of ['hs_verified_totals', 'hs_player_advanced_stats', 'hs_pitcher_advanced_stats']) {
    const alter = sql.match(new RegExp(`alter table public\\.${table}[\\s\\S]*?;`, 'i'))?.[0] || '';
    assert.match(alter, /add column generation_id uuid/i);
    assert.doesNotMatch(alter, /generation_id uuid not null/i);
  }
  assert.match(sql, /alter column source_game_ref drop not null/i);
  assert.match(sql, /alter column hs_game_id drop not null/i);
});

test('every added foreign-key column has a supporting index declaration', () => {
  const required = [
    'idx_hs_game_identity_aliases_program_id', 'idx_hs_game_identity_aliases_team_id',
    'idx_hs_game_identity_aliases_season_id', 'idx_hs_game_identity_aliases_hs_game_id',
    'idx_hs_game_identity_resolutions_team_id', 'idx_hs_game_identity_resolutions_season_id',
    'idx_hs_game_identity_resolutions_import_run_id', 'idx_hs_game_identity_resolutions_import_run_game_id',
    'idx_hs_game_identity_resolutions_hs_game_id', 'idx_hs_stat_generations_program_id',
    'idx_hs_stat_generations_team_id', 'idx_hs_stat_generations_season_id',
    'idx_hs_stat_generations_import_run_id', 'idx_hs_noncanonical_player_stats_team_id',
    'idx_hs_noncanonical_player_stats_season_id', 'idx_hs_noncanonical_player_stats_generation_id',
    'idx_hs_noncanonical_player_stats_import_run_game_id', 'idx_hs_noncanonical_player_stats_hs_game_id',
    'idx_hs_verified_totals_generation_id', 'idx_hs_player_advanced_stats_generation_id',
    'idx_hs_pitcher_advanced_stats_generation_id',
  ];
  for (const index of required) assert.match(sql, new RegExp(`create (?:unique )?index ${index}\\b`, 'i'), index);
});

test('unresolved and ambiguous observations cannot manufacture aliases inside the RPC', () => {
  assert.match(sql, /and v_method in \('sourceGameId', 'scheduleComposite'\)/i);
  assert.match(sql, /v_game_id := null;/i);
  assert.match(sql, /identity_status in \('single', 'deduplicated', 'reconciled', 'conflict', 'unresolved', 'ambiguous'\)/i);
});

test('collection observations replace legacy one-resolved-game-per-run uniqueness', () => {
  assert.match(sql, /drop constraint hs_import_run_games_run_source_ref_key/i);
  assert.match(sql, /drop index public\.idx_hs_import_run_games_run_hs_game/i);
  assert.match(sql, /drop constraint hs_game_validation_results_run_game_key/i);
  assert.match(sql, /create unique index idx_hs_import_run_games_run_observation[\s\S]*?\(import_run_id, observation_key\)/i);
});

test('RPC appends resolution history for durable reuse and fallback enrichment', () => {
  const fn = sql.match(/create or replace function public\.persist_hs_engine_collection[\s\S]*?\$function\$;/i)?.[0] || '';
  assert.match(fn, /v_resolution_kind := 'automatic_durable'/i);
  assert.match(fn, /v_resolution_kind := 'automatic_fallback_enrichment'/i);
  assert.match(fn, /insert into public\.hs_game_identity_resolutions/i);
  assert.match(fn, /on conflict \(org_id, import_run_game_id, hs_game_id, evidence_digest\) do nothing/i);
});

test('RPC locks hierarchy before writes and supersedes complete generations atomically', () => {
  const fn = sql.match(/create or replace function public\.persist_hs_engine_collection[\s\S]*?\$function\$;/i)?.[0] || '';
  const teamLock = fn.indexOf('perform 1 from public.hs_teams');
  const seasonLock = fn.indexOf('perform 1 from public.hs_seasons');
  const runLock = fn.indexOf('perform 1 from public.hs_import_runs');
  const observationWrite = fn.indexOf('insert into public.hs_import_run_games');
  assert.ok(teamLock >= 0 && teamLock < seasonLock && seasonLock < runLock && runLock < observationWrite);
  assert.match(fn, /update public\.hs_stat_generations set is_current = false, status = 'superseded'/i);
  assert.match(fn, /update public\.hs_player_advanced_stats set is_current = false/i);
  assert.match(fn, /update public\.hs_pitcher_advanced_stats set is_current = false/i);
  assert.match(fn, /update public\.hs_import_runs[\s\S]*?set status = 'succeeded'/i);
});
