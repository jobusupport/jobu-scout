'use strict';

// Focused tests for supabase/migrations/20260728220000_create_high_school_import_domain.sql --
// the High School import-run and source-provenance domain (Slice 0B):
// hs_games, hs_import_runs, hs_import_run_games, hs_raw_snapshots,
// hs_game_validation_results, hs_verified_totals, hs_player_advanced_stats,
// hs_pitcher_advanced_stats.
//
// Text-level assertions against the raw SQL, mirroring the convention
// already used in test/high-school-domain-migration.test.js: these prove
// the migration's shape (tables, constraints, RLS, grants), not runtime
// behavior against a real Postgres instance.
//
// Run with: node --test test/high-school-import-domain-migration.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const MIGRATION_PATH = path.join(REPO_ROOT, 'supabase', 'migrations', '20260728220000_create_high_school_import_domain.sql');
const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
const lowerSql = sql.toLowerCase();

// Statements only, with comment lines stripped -- the header comment
// explains the migration in prose, which would otherwise false-positive
// against checks meaningful only against the actual executable SQL.
const statementsOnlyLower = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .toLowerCase();

const NEW_TABLES = [
  'hs_games',
  'hs_import_runs',
  'hs_import_run_games',
  'hs_raw_snapshots',
  'hs_game_validation_results',
  'hs_verified_totals',
  'hs_player_advanced_stats',
  'hs_pitcher_advanced_stats',
];

const EXISTING_HS_TABLES = ['hs_programs', 'hs_seasons', 'hs_teams', 'hs_players', 'hs_roster_memberships'];

const LEGACY_TRAVEL_TABLES = [
  'organizations',
  'teams',
  'players',
  'roster_players',
  'games',
  'org_members',
  'stat_validation_runs',
  'game_stat_validation_results',
  'derived_team_verified_totals',
  'player_advanced_stats',
  'pitcher_advanced_stats',
];

function columnDefinition(table, column) {
  const tableMatch = sql.match(new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`));
  assert.ok(tableMatch, `expected to find CREATE TABLE for ${table}`);
  const body = tableMatch[1];
  const lineMatch = body.split('\n').find((l) => l.trim().startsWith(`"${column}"`));
  return lineMatch || null;
}

// ── 1. Migration file exists and is registered ──────────────────────────

test('the migration file exists at the expected path', () => {
  assert.ok(fs.existsSync(MIGRATION_PATH));
});

test('the migration-contract test is registered in package.json test script', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /test\/high-school-import-domain-migration\.test\.js/);
});

// ── 2. All required tables exist ─────────────────────────────────────────

for (const table of NEW_TABLES) {
  test(`the migration creates public.${table}`, () => {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}\\s*\\(`));
  });
}

// ── 3 & 4. UUID primary keys ──────────────────────────────────────────────

for (const table of NEW_TABLES) {
  test(`${table} has a uuid primary key defaulting to extensions.uuid_generate_v4()`, () => {
    const def = columnDefinition(table, 'id');
    assert.ok(def);
    assert.match(def, /"id" uuid not null default extensions\.uuid_generate_v4\(\)/);
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}[\\s\\S]*?primary key \\("id"\\)`));
  });
}

// ── 5. Required NOT NULL columns ─────────────────────────────────────────

const REQUIRED_NOT_NULL = {
  hs_games: ['org_id', 'program_id', 'team_id'],
  hs_import_runs: ['org_id', 'program_id', 'team_id', 'source_provider', 'trigger_kind', 'status'],
  hs_import_run_games: ['org_id', 'import_run_id', 'source_game_ref', 'discovery_status'],
  hs_raw_snapshots: ['org_id', 'import_run_id', 'snapshot_kind', 'source_provider', 'payload', 'content_type'],
  hs_game_validation_results: ['org_id', 'import_run_id', 'hs_game_id', 'team_id', 'confidence', 'validation_status'],
  hs_verified_totals: ['org_id', 'program_id', 'team_id', 'season_id', 'confidence', 'is_current'],
  hs_player_advanced_stats: ['org_id', 'program_id', 'team_id', 'season_id', 'player_id', 'is_current'],
  hs_pitcher_advanced_stats: ['org_id', 'program_id', 'team_id', 'season_id', 'player_id', 'is_current'],
};

for (const [table, columns] of Object.entries(REQUIRED_NOT_NULL)) {
  for (const column of columns) {
    test(`${table}.${column} is NOT NULL`, () => {
      const def = columnDefinition(table, column);
      assert.ok(def, `expected column ${column} on ${table}`);
      assert.match(def, /not null/i);
    });
  }
}

// season_id is nullable on hs_games and hs_import_runs ("when applicable")
// but NOT NULL everywhere a current/superseded partial unique index
// depends on it -- see the migration's own header comment for why.
test('hs_games.season_id is nullable', () => {
  const def = columnDefinition('hs_games', 'season_id');
  assert.ok(def);
  assert.doesNotMatch(def, /not null/i);
});

test('hs_import_runs.season_id is nullable ("season when applicable")', () => {
  const def = columnDefinition('hs_import_runs', 'season_id');
  assert.ok(def);
  assert.doesNotMatch(def, /not null/i);
});

for (const table of ['hs_verified_totals', 'hs_player_advanced_stats', 'hs_pitcher_advanced_stats']) {
  test(`${table}.season_id is NOT NULL (required so the current-row partial unique index cannot be bypassed via NULL)`, () => {
    const def = columnDefinition(table, 'season_id');
    assert.ok(def);
    assert.match(def, /not null/i);
  });
}

test('hs_import_run_games.hs_game_id is nullable (a game may be discovered without resolving)', () => {
  const def = columnDefinition('hs_import_run_games', 'hs_game_id');
  assert.ok(def);
  assert.doesNotMatch(def, /not null/i);
});

// ── 6. Status / provider / kind / confidence CHECK constraints ──────────

const CHECK_CONSTRAINTS = [
  ['hs_games', 'hs_games', null], // no dedicated check needed beyond source_provider inline check below
];

test('hs_games.source_provider is constrained to gamechanger (nullable)', () => {
  assert.match(sql, /"source_provider" text check \("source_provider" is null or "source_provider" = any \(array\['gamechanger'::text\]\)\)/);
});

test('hs_import_runs.source_provider is constrained to gamechanger', () => {
  assert.match(sql, /constraint "hs_import_runs_source_provider_check" check \("source_provider" = any \(array\['gamechanger'::text\]\)\)/);
});

test('hs_import_runs.trigger_kind is constrained to manual/scheduled/api', () => {
  assert.match(sql, /constraint "hs_import_runs_trigger_kind_check" check \("trigger_kind" = any \(array\['manual'::text, 'scheduled'::text, 'api'::text\]\)\)/);
});

test('hs_import_runs.status is constrained to the five documented values', () => {
  assert.match(sql, /constraint "hs_import_runs_status_check" check \("status" = any \(array\['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'partial'::text\]\)\)/);
});

test('hs_import_runs.failure_stage is nullable and constrained to known pipeline stages', () => {
  const def = columnDefinition('hs_import_runs', 'failure_stage');
  assert.ok(def);
  assert.doesNotMatch(def, /not null/i);
  assert.match(sql, /constraint "hs_import_runs_failure_stage_check" check \("failure_stage" is null or "failure_stage" = any \(array\['discovery'::text, 'snapshot_capture'::text, 'reconstruction'::text, 'validation'::text, 'aggregation'::text\]\)\)/);
});

test('hs_import_runs.error_summary is nullable and length-bounded to 2000 chars (matches hs_teams.roster_sync_error)', () => {
  const def = columnDefinition('hs_import_runs', 'error_summary');
  assert.ok(def);
  assert.doesNotMatch(def, /not null/i);
  assert.match(sql, /constraint "hs_import_runs_error_summary_length_check" check \("error_summary" is null or char_length\("error_summary"\) <= 2000\)/);
});

test('hs_import_run_games.discovery_status is constrained to the six documented values', () => {
  assert.match(sql, /constraint "hs_import_run_games_discovery_status_check" check \("discovery_status" = any \(array\['discovered'::text, 'processing'::text, 'processed'::text, 'skipped'::text, 'rejected'::text, 'failed'::text\]\)\)/);
});

test('hs_import_run_games.game_outcome is nullable and constrained to inserted/replaced/skipped/rejected/failed', () => {
  const def = columnDefinition('hs_import_run_games', 'game_outcome');
  assert.ok(def);
  assert.doesNotMatch(def, /not null/i);
  assert.match(sql, /constraint "hs_import_run_games_game_outcome_check" check \("game_outcome" is null or "game_outcome" = any \(array\['inserted'::text, 'replaced'::text, 'skipped'::text, 'rejected'::text, 'failed'::text\]\)\)/);
});

test('hs_raw_snapshots.snapshot_kind is constrained to the five documented categories', () => {
  assert.match(sql, /constraint "hs_raw_snapshots_snapshot_kind_check" check \("snapshot_kind" = any \(array\['schedule_discovery'::text, 'game_header'::text, 'box_score'::text, 'play_by_play'::text, 'roster'::text\]\)\)/);
});

test('hs_raw_snapshots.content_type is constrained to json/text', () => {
  assert.match(sql, /constraint "hs_raw_snapshots_content_type_check" check \("content_type" = any \(array\['json'::text, 'text'::text\]\)\)/);
});

test('hs_game_validation_results.scouted_side and opponent_side are constrained to home/away when present', () => {
  assert.match(sql, /constraint "hs_game_validation_results_scouted_side_check" check \("scouted_side" is null or "scouted_side" = any \(array\['home'::text, 'away'::text\]\)\)/);
  assert.match(sql, /constraint "hs_game_validation_results_opponent_side_check" check \("opponent_side" is null or "opponent_side" = any \(array\['home'::text, 'away'::text\]\)\)/);
});

test('hs_game_validation_results.validation_status is constrained to pending/validated/mismatched/failed', () => {
  assert.match(sql, /constraint "hs_game_validation_results_status_check" check \("validation_status" = any \(array\['pending'::text, 'validated'::text, 'mismatched'::text, 'failed'::text\]\)\)/);
});

for (const table of ['hs_game_validation_results', 'hs_verified_totals']) {
  test(`${table}.confidence is constrained to low/medium/high`, () => {
    assert.match(sql, new RegExp(`constraint "${table}_confidence_check" check \\("confidence" = any \\(array\\['low'::text, 'medium'::text, 'high'::text\\]\\)\\)`));
  });
}

// ── 7. Required defaults ─────────────────────────────────────────────────

test('hs_import_runs.status defaults to pending', () => {
  const def = columnDefinition('hs_import_runs', 'status');
  assert.match(def, /default 'pending'/);
});

test('hs_import_run_games.discovery_status defaults to discovered', () => {
  const def = columnDefinition('hs_import_run_games', 'discovery_status');
  assert.match(def, /default 'discovered'/);
});

for (const table of ['hs_verified_totals', 'hs_player_advanced_stats', 'hs_pitcher_advanced_stats']) {
  test(`${table}.is_current defaults to true`, () => {
    const def = columnDefinition(table, 'is_current');
    assert.match(def, /"is_current" boolean not null default true/);
  });
}

test('jsonb payload/summary columns default to an empty object or array, never NULL', () => {
  assert.match(columnDefinition('hs_import_runs', 'config'), /default '\{\}'::jsonb/);
  assert.match(columnDefinition('hs_import_runs', 'result_summary'), /default '\{\}'::jsonb/);
  assert.match(columnDefinition('hs_raw_snapshots', 'payload'), /default '\{\}'::jsonb/);
  assert.match(columnDefinition('hs_verified_totals', 'warnings'), /default '\[\]'::jsonb/);
});

// ── 8 & 9. Composite tenant-safe foreign keys; cross-org rows are structurally impossible ──

for (const table of NEW_TABLES) {
  test(`${table} declares unique(org_id, id) so composite foreign keys can reference it`, () => {
    assert.match(sql, new RegExp(`constraint "${table}_org_id_id_key" unique \\("org_id", "id"\\)`));
  });
}

const COMPOSITE_FKS = [
  ['hs_games', 'hs_games_org_program_fkey', 'program_id', 'hs_programs'],
  ['hs_games', 'hs_games_org_team_fkey', 'team_id', 'hs_teams'],
  ['hs_games', 'hs_games_org_season_fkey', 'season_id', 'hs_seasons'],
  ['hs_import_runs', 'hs_import_runs_org_program_fkey', 'program_id', 'hs_programs'],
  ['hs_import_runs', 'hs_import_runs_org_team_fkey', 'team_id', 'hs_teams'],
  ['hs_import_runs', 'hs_import_runs_org_season_fkey', 'season_id', 'hs_seasons'],
  ['hs_import_run_games', 'hs_import_run_games_org_run_fkey', 'import_run_id', 'hs_import_runs'],
  ['hs_import_run_games', 'hs_import_run_games_org_game_fkey', 'hs_game_id', 'hs_games'],
  ['hs_raw_snapshots', 'hs_raw_snapshots_org_run_fkey', 'import_run_id', 'hs_import_runs'],
  ['hs_raw_snapshots', 'hs_raw_snapshots_org_run_game_fkey', 'import_run_game_id', 'hs_import_run_games'],
  ['hs_raw_snapshots', 'hs_raw_snapshots_org_game_fkey', 'hs_game_id', 'hs_games'],
  ['hs_game_validation_results', 'hs_game_validation_results_org_run_fkey', 'import_run_id', 'hs_import_runs'],
  ['hs_game_validation_results', 'hs_game_validation_results_org_run_game_fkey', 'import_run_game_id', 'hs_import_run_games'],
  ['hs_game_validation_results', 'hs_game_validation_results_org_game_fkey', 'hs_game_id', 'hs_games'],
  ['hs_game_validation_results', 'hs_game_validation_results_org_team_fkey', 'team_id', 'hs_teams'],
  ['hs_verified_totals', 'hs_verified_totals_org_program_fkey', 'program_id', 'hs_programs'],
  ['hs_verified_totals', 'hs_verified_totals_org_team_fkey', 'team_id', 'hs_teams'],
  ['hs_verified_totals', 'hs_verified_totals_org_season_fkey', 'season_id', 'hs_seasons'],
  ['hs_verified_totals', 'hs_verified_totals_org_run_fkey', 'import_run_id', 'hs_import_runs'],
  ['hs_player_advanced_stats', 'hs_player_advanced_stats_org_program_fkey', 'program_id', 'hs_programs'],
  ['hs_player_advanced_stats', 'hs_player_advanced_stats_org_team_fkey', 'team_id', 'hs_teams'],
  ['hs_player_advanced_stats', 'hs_player_advanced_stats_org_season_fkey', 'season_id', 'hs_seasons'],
  ['hs_player_advanced_stats', 'hs_player_advanced_stats_org_player_fkey', 'player_id', 'hs_players'],
  ['hs_player_advanced_stats', 'hs_player_advanced_stats_org_run_fkey', 'import_run_id', 'hs_import_runs'],
  ['hs_pitcher_advanced_stats', 'hs_pitcher_advanced_stats_org_program_fkey', 'program_id', 'hs_programs'],
  ['hs_pitcher_advanced_stats', 'hs_pitcher_advanced_stats_org_team_fkey', 'team_id', 'hs_teams'],
  ['hs_pitcher_advanced_stats', 'hs_pitcher_advanced_stats_org_season_fkey', 'season_id', 'hs_seasons'],
  ['hs_pitcher_advanced_stats', 'hs_pitcher_advanced_stats_org_player_fkey', 'player_id', 'hs_players'],
  ['hs_pitcher_advanced_stats', 'hs_pitcher_advanced_stats_org_run_fkey', 'import_run_id', 'hs_import_runs'],
];

for (const [table, constraintName, column, refTable] of COMPOSITE_FKS) {
  test(`${table}.${column} has a COMPOSITE foreign key to ${refTable}(org_id, id), not a bare id reference`, () => {
    assert.match(
      sql,
      new RegExp(`constraint "${constraintName}" foreign key \\("org_id", "${column}"\\) references public\\.${refTable} \\("org_id", "id"\\) on delete cascade`)
    );
  });

  test(`${table} has no bare (non-composite) foreign key on ${column} alone`, () => {
    assert.doesNotMatch(statementsOnlyLower, new RegExp(`foreign key \\("${column}"\\) references`));
  });
}

test('hs_games has a foreign key to organizations(id)', () => {
  assert.match(sql, /constraint "hs_games_org_id_fkey" foreign key \("org_id"\) references public\.organizations \("id"\) on delete cascade/);
});

test('hs_import_runs has a foreign key to organizations(id)', () => {
  assert.match(sql, /constraint "hs_import_runs_org_id_fkey" foreign key \("org_id"\) references public\.organizations \("id"\) on delete cascade/);
});

// ── 10 & 11. Unique and partial-unique indexes ───────────────────────────

test('hs_games has a partial unique index on (team_id, source_game_ref) where source_game_ref is not null', () => {
  assert.match(sql, /create unique index if not exists idx_hs_games_team_source_game_ref on public\.hs_games \("team_id", "source_game_ref"\) where "source_game_ref" is not null;/);
  assert.doesNotMatch(statementsOnlyLower, /unique \("source_game_ref"\)/);
});

test('hs_import_run_games enforces idempotent processing: unique (import_run_id, source_game_ref)', () => {
  assert.match(sql, /constraint "hs_import_run_games_run_source_ref_key" unique \("import_run_id", "source_game_ref"\)/);
});

test('hs_import_run_games has a partial unique index preventing two run-games resolving to the same hs_game within one run', () => {
  assert.match(sql, /create unique index if not exists idx_hs_import_run_games_run_hs_game on public\.hs_import_run_games \("import_run_id", "hs_game_id"\) where "hs_game_id" is not null;/);
});

test('hs_raw_snapshots has two mutually-exclusive partial unique dedup indexes split on import_run_game_id nullability', () => {
  assert.match(sql, /create unique index if not exists idx_hs_raw_snapshots_dedup_with_game on public\.hs_raw_snapshots \("import_run_game_id", "snapshot_kind", "captured_at"\) where "import_run_game_id" is not null;/);
  assert.match(sql, /create unique index if not exists idx_hs_raw_snapshots_dedup_run_level on public\.hs_raw_snapshots \("import_run_id", "snapshot_kind", "captured_at"\) where "import_run_game_id" is null;/);
});

test('hs_game_validation_results enforces one result per (import_run_id, hs_game_id)', () => {
  assert.match(sql, /constraint "hs_game_validation_results_run_game_key" unique \("import_run_id", "hs_game_id"\)/);
});

for (const [table, indexName] of [
  ['hs_verified_totals', 'idx_hs_verified_totals_current_per_team_season'],
  ['hs_player_advanced_stats', 'idx_hs_player_advanced_stats_current_per_player_team_season'],
  ['hs_pitcher_advanced_stats', 'idx_hs_pitcher_advanced_stats_current_per_player_team_season'],
]) {
  test(`${table} has a partial unique index enforcing at most one current row, predicated on "is_current"`, () => {
    assert.match(sql, new RegExp(`create unique index if not exists ${indexName} on public\\.${table} \\([^)]+\\) where "is_current";`));
  });
}

test('hs_verified_totals current-row index is scoped to (team_id, season_id)', () => {
  assert.match(sql, /create unique index if not exists idx_hs_verified_totals_current_per_team_season on public\.hs_verified_totals \("team_id", "season_id"\) where "is_current";/);
});

for (const [table, indexName] of [
  ['hs_player_advanced_stats', 'idx_hs_player_advanced_stats_current_per_player_team_season'],
  ['hs_pitcher_advanced_stats', 'idx_hs_pitcher_advanced_stats_current_per_player_team_season'],
]) {
  test(`${table} current-row index is scoped to (player_id, team_id, season_id)`, () => {
    assert.match(sql, new RegExp(`create unique index if not exists ${indexName} on public\\.${table} \\("player_id", "team_id", "season_id"\\) where "is_current";`));
  });
}

// ── 12. RLS is enabled on every new table ────────────────────────────────

for (const table of NEW_TABLES) {
  test(`RLS is enabled on public.${table}`, () => {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security;`));
  });
}

// ── 13. Tenant-member SELECT policies exist ──────────────────────────────

for (const table of NEW_TABLES) {
  test(`${table}'s SELECT policy requires both org membership and high_school entitlement`, () => {
    const policyMatch = sql.match(new RegExp(`create policy "${table}_select" on public\\.${table}[\\s\\S]*?;`));
    assert.ok(policyMatch, `expected a ${table}_select policy`);
    const policyText = policyMatch[0];
    assert.match(policyText, /auth_user_org_ids\(\)/);
    assert.match(policyText, /enabled_products['"]? @> array\['high_school'\]/);
  });
}

// ── 14 & 15. No authenticated write policy; service-role-only writes ────

test('no INSERT, UPDATE, or DELETE policy is defined on any new table (read-only slice)', () => {
  assert.doesNotMatch(lowerSql, /for insert|for update|for delete|for all/);
});

test('contains no explicit GRANT to anon, authenticated, or PUBLIC', () => {
  assert.doesNotMatch(lowerSql, /grant .* to (anon|authenticated|public)\b/);
});

test('contains no GRANT statement at all (relies on RLS + Supabase auto-grant, matching the existing convention)', () => {
  assert.doesNotMatch(lowerSql, /^\s*grant /m);
});

test('defines no SECURITY DEFINER function (adds no function of any kind)', () => {
  assert.doesNotMatch(statementsOnlyLower, /security definer/);
  assert.doesNotMatch(statementsOnlyLower, /create (or replace )?function/);
});

// ── 16. Timestamp triggers follow repository conventions ────────────────

const MUTABLE_TABLES = ['hs_games', 'hs_import_runs', 'hs_import_run_games', 'hs_verified_totals', 'hs_player_advanced_stats', 'hs_pitcher_advanced_stats'];
const APPEND_ONLY_TABLES = ['hs_raw_snapshots', 'hs_game_validation_results'];

for (const table of MUTABLE_TABLES) {
  test(`${table} has an updated_at trigger using the shared set_updated_at() function`, () => {
    assert.match(sql, new RegExp(`create trigger trg_${table}_updated_at before update on public\\.${table} for each row execute function set_updated_at\\(\\);`));
    const def = columnDefinition(table, 'updated_at');
    assert.ok(def, `expected updated_at column on ${table}`);
  });
}

for (const table of APPEND_ONLY_TABLES) {
  test(`${table} is append-only: no updated_at column, no updated_at trigger`, () => {
    assert.equal(columnDefinition(table, 'updated_at'), null);
    assert.doesNotMatch(sql, new RegExp(`create trigger trg_${table}_updated_at`));
  });
}

// ── 17. No existing High School table is altered ─────────────────────────

test('never issues ALTER TABLE against an existing High School table', () => {
  for (const existingTable of EXISTING_HS_TABLES) {
    assert.doesNotMatch(lowerSql, new RegExp(`alter table public\\.${existingTable}\\b`));
    assert.doesNotMatch(lowerSql, new RegExp(`alter table public\\."${existingTable}"`));
  }
});

test('never CREATE OR REPLACEs or drops an existing High School table', () => {
  for (const existingTable of EXISTING_HS_TABLES) {
    assert.doesNotMatch(lowerSql, new RegExp(`drop table.*\\b${existingTable}\\b`));
  }
});

// ── 18. No legacy Travel table is altered ─────────────────────────────────

test('never issues ALTER TABLE against any legacy Travel/validation/advanced-stat table', () => {
  for (const legacyTable of LEGACY_TRAVEL_TABLES) {
    assert.doesNotMatch(lowerSql, new RegExp(`alter table public\\.${legacyTable}\\b`));
    assert.doesNotMatch(lowerSql, new RegExp(`alter table public\\."${legacyTable}"`));
  }
});

test('never creates a table literally named after a legacy Travel table (only hs_-prefixed equivalents)', () => {
  for (const legacyTable of LEGACY_TRAVEL_TABLES) {
    assert.doesNotMatch(lowerSql, new RegExp(`create table if not exists public\\.${legacyTable}\\s*\\(`));
    assert.doesNotMatch(lowerSql, new RegExp(`create table if not exists public\\."${legacyTable}"`));
  }
});

test('contains no DROP, DELETE, TRUNCATE, or UPDATE DML statement', () => {
  for (const keyword of ['drop table', 'drop function', 'delete from', 'truncate']) {
    assert.doesNotMatch(statementsOnlyLower, new RegExp(keyword));
  }
  assert.doesNotMatch(statementsOnlyLower, /^update /m);
});

test('contains no INSERT statement (no seed data)', () => {
  assert.doesNotMatch(lowerSql, /insert into/);
});

test('contains no hard-coded UUID literal (no production-specific IDs)', () => {
  assert.doesNotMatch(sql, /'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/i);
});

// ── 19. No credential-bearing column or auth-state storage ──────────────

test('no column stores a credential/token/cookie/session artifact', () => {
  for (const forbidden of ['cookie', 'password', 'auth_token', 'session_state', 'storage_state', 'access_token', 'refresh_token', 'authorization_header']) {
    assert.doesNotMatch(statementsOnlyLower, new RegExp(`"${forbidden}"`));
  }
});

test('the migration contains no HTTP/browser-automation call of any kind', () => {
  for (const forbidden of ['fetch(', 'playwright', 'puppeteer', 'http://', 'https://']) {
    assert.doesNotMatch(statementsOnlyLower, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

// ── 20. No application/route/UI/importer implementation is included ─────
//
// This check was written for the Slice 0B PR itself ("schema-only,
// nothing references these tables yet") and was true of that PR's own
// diff. Slice 1A (a separate, later, explicitly authorized PR) adds
// exactly the High School importer persistence layer this migration's own
// header comment always said was future work -- so "nothing ever
// references these tables" is no longer the right invariant to hold
// forever. What Slice 0B's own scope boundary actually cared about --
// "only the importer persistence layer touches these tables; no UI, no
// unrelated route, no other module" -- still holds and is still checked
// below, now scoped to the three files Slice 1A's own PR describes as its
// entire application-code surface.
const SLICE_1A_PERSISTENCE_FILES = [
  path.join('src', 'high-school-import-service.js'),
  path.join('src', 'high-school-import-repository.js'),
  path.join('src', 'high-school-import-sanitizer.js'),
];

test('no source or UI file OTHER THAN the Slice 1A importer persistence layer references the new tables', () => {
  const searchDirs = ['src', 'dashboard'];
  const forbiddenPattern = new RegExp(NEW_TABLES.join('|'));
  for (const dir of searchDirs) {
    const dirPath = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(dirPath)) continue;
    const walk = (p) => {
      const matches = [];
      for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
        const entryPath = path.join(p, entry.name);
        if (entry.isDirectory()) matches.push(...walk(entryPath));
        else if (/\.(js|html)$/.test(entry.name)) matches.push(entryPath);
      }
      return matches;
    };
    for (const filePath of walk(dirPath)) {
      const relativePath = path.relative(REPO_ROOT, filePath);
      if (SLICE_1A_PERSISTENCE_FILES.includes(relativePath)) continue;
      const contents = fs.readFileSync(filePath, 'utf8');
      assert.doesNotMatch(
        contents,
        forbiddenPattern,
        `expected no application/UI reference to Slice 0B tables outside the Slice 1A persistence layer in ${relativePath}`
      );
    }
  }
});

// ── Importer ownership contract (repo-wide, indirection-resistant) ──────
//
// The check above proves its own, narrower claim: no file in src/ or
// dashboard/ OTHER THAN the three listed persistence files even mentions
// one of these table names as a string. That leaves two real blind spots:
// (1) it never walks the repo root (server.js, the one-off migration/repair
// scripts like sync-to-supabase.js, rebuild-team-from-json.js) or admin/,
// where a legacy or admin-tooling script could add a stray write without
// this test ever seeing it; (2) a bare string-mention check can't
// distinguish "this file WRITES to hs_verified_totals" from "this file's
// comment mentions hs_verified_totals in passing" -- so it is both too
// narrow in scope and too blunt in what it actually proves.
//
// An EARLIER version of this test tried to fix blind spot (2) directly, by
// matching a literal `.from('hs_<table>')` immediately followed by
// `.insert(`/`.update(`/`.upsert(`/`.delete(`. That is trivially
// bypassable: a variable table name (`const t = 'hs_games'; .from(t)`), a
// helper function taking `table` as a parameter, a template-literal table
// name, or bracket-notation (`adminClient['from'](...)`) all evade a regex
// anchored on a literal quoted string directly inside `.from(...)`, and
// `adminClient` is already legitimately imported in several other files
// (high-school-api.js, admin-api.js, ...) so the ingredients for exactly
// that bypass already exist elsewhere in this repo.
//
// The fix: stop trying to prove "this is specifically a WRITE call" via
// call-shape matching (a text scan cannot reliably tell a literal from an
// aliased reference once indirection is allowed) and instead go back to
// the strictly stronger property blind spot (1) already established works
// -- a plain, repo-wide, no-adjacency-required mention of the table/RPC
// name -- since every bypass above (variable assignment, helper call site,
// template literal, bracket notation) still leaves the literal
// table/RPC-name STRING somewhere in the file as plain text. This is the
// same tradeoff (and same low false-positive risk, given how distinctive
// these identifiers are) the existing, already-accepted src/dashboard-only
// check above has always made -- just widened to the whole repository.
const REPO_WIDE_EXCLUDED_DIRS = new Set(['node_modules', '.git', 'coverage', 'supabase', 'test', '.claude']);

function walkRepoJsAndHtmlFiles(dir) {
  const matches = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (REPO_WIDE_EXCLUDED_DIRS.has(entry.name)) continue;
      matches.push(...walkRepoJsAndHtmlFiles(path.join(dir, entry.name)));
    } else if (/\.(js|html)$/.test(entry.name)) {
      matches.push(path.join(dir, entry.name));
    }
  }
  return matches;
}

const HS_IMPORT_RPC_NAMES = [
  'publish_hs_verified_totals',
  'publish_hs_player_advanced_stats',
  'publish_hs_pitcher_advanced_stats',
];

test('no file anywhere in the repository (outside the Slice 1A persistence layer) references a High School import table or its publish RPCs, by any name, alias, or indirection', () => {
  const forbiddenPattern = new RegExp(NEW_TABLES.concat(HS_IMPORT_RPC_NAMES).join('|'));

  for (const filePath of walkRepoJsAndHtmlFiles(REPO_ROOT)) {
    const relativePath = path.relative(REPO_ROOT, filePath);
    if (SLICE_1A_PERSISTENCE_FILES.includes(relativePath)) continue;
    const contents = fs.readFileSync(filePath, 'utf8');
    assert.doesNotMatch(
      contents,
      forbiddenPattern,
      `expected no reference (literal, aliased, template-literal, or bracket-notation) to a Slice 1A table or publish RPC outside the persistence layer in ${relativePath}`
    );
  }
});

// ── Non-negative and consistency CHECK constraints ───────────────────────

test('hs_import_runs count columns are non-negative', () => {
  assert.match(sql, /constraint "hs_import_runs_counts_non_negative_check" check \("games_discovered" >= 0 and "games_processed" >= 0 and "games_succeeded" >= 0 and "games_failed" >= 0\)/);
});

test('hs_import_runs enforces completed_at >= started_at when both are present', () => {
  assert.match(sql, /constraint "hs_import_runs_completed_after_started_check" check \("completed_at" is null or "started_at" is null or "completed_at" >= "started_at"\)/);
});

for (const table of ['hs_verified_totals', 'hs_player_advanced_stats', 'hs_pitcher_advanced_stats']) {
  test(`${table} enforces is_current/superseded_at consistency via CHECK`, () => {
    assert.match(
      sql,
      new RegExp(`constraint "${table}_current_superseded_consistency_check" check \\(\\("is_current" and "superseded_at" is null\\) or \\(not "is_current" and "superseded_at" is not null\\)\\)`)
    );
  });
}

// ── Legacy box-score-vs-reconstructed distinction is preserved ──────────

test('hs_game_validation_results keeps box-score and reconstructed figures in separate columns (never collapsed)', () => {
  for (const col of ['box_score_batting', 'box_score_pitching', 'reconstructed_batting', 'reconstructed_pitching', 'deltas']) {
    assert.ok(columnDefinition('hs_game_validation_results', col), `expected column ${col}`);
  }
});

test('hs_verified_totals keeps official and reconstructed totals in separate columns (never collapsed)', () => {
  for (const col of ['batting_official', 'pitching_official', 'batting_reconstructed', 'pitching_reconstructed']) {
    assert.ok(columnDefinition('hs_verified_totals', col), `expected column ${col}`);
  }
});

// ── Canonical player identity, never player_name text ────────────────────

for (const table of ['hs_player_advanced_stats', 'hs_pitcher_advanced_stats']) {
  test(`${table} links to canonical hs_players via player_id, never a player_name text column`, () => {
    assert.ok(columnDefinition(table, 'player_id'));
    assert.equal(columnDefinition(table, 'player_name'), null);
  });

  test(`${table} has no is_our_team column (hs_players never represents opponent-scouted players)`, () => {
    assert.equal(columnDefinition(table, 'is_our_team'), null);
  });
}
