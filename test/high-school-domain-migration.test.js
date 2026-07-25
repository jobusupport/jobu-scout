'use strict';

// Focused tests for supabase/migrations/20260724221500_create_high_school_domain.sql --
// the High School domain foundation migration (programs, seasons, teams,
// players, roster memberships).
//
// Text-level assertions against the raw SQL, mirroring the convention
// already used in test/remove-game-date-repair-rpc-migration.test.js:
// these prove the migration's shape (tables, constraints, RLS, grants),
// not runtime behavior against a real Postgres instance.
//
// Run with: node --test test/high-school-domain-migration.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260724221500_create_high_school_domain.sql');
const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
const lowerSql = sql.toLowerCase();

// Statements only, with comment lines stripped -- the header comment
// explains the migration in prose (e.g. "no SECURITY DEFINER function is
// added"), which would otherwise false-positive against checks that are
// only meaningful against the actual executable SQL.
const statementsOnlyLower = sql
  .split('\n')
  .filter(l => !l.trim().startsWith('--'))
  .join('\n')
  .toLowerCase();

const TABLES = ['hs_programs', 'hs_seasons', 'hs_teams', 'hs_players', 'hs_roster_memberships'];

// ── 1. Expected tables exist ────────────────────────────────────────────

for (const table of TABLES) {
  test(`the migration creates public.${table}`, () => {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}\\s*\\(`));
  });
}

// ── 2. Every new table has RLS enabled ──────────────────────────────────

for (const table of TABLES) {
  test(`RLS is enabled on public.${table}`, () => {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security;`));
  });
}

// ── 3. Required foreign keys exist (composite, org-scoped) ─────────────

test('hs_programs has a foreign key to organizations(id)', () => {
  assert.match(sql, /constraint "hs_programs_org_id_fkey" foreign key \("org_id"\) references public\.organizations \("id"\) on delete cascade/);
});

for (const [table, constraintName] of [
  ['hs_seasons', 'hs_seasons_org_program_fkey'],
  ['hs_teams', 'hs_teams_org_program_fkey'],
  ['hs_players', 'hs_players_org_program_fkey'],
]) {
  test(`${table} has a COMPOSITE foreign key to hs_programs(org_id, id), not a bare id reference`, () => {
    assert.match(sql, new RegExp(`constraint "${constraintName}" foreign key \\("org_id", "program_id"\\) references public\\.hs_programs \\("org_id", "id"\\) on delete cascade`));
  });
}

for (const [refTable, constraintName] of [
  ['hs_players', 'hs_roster_memberships_org_player_fkey'],
  ['hs_teams', 'hs_roster_memberships_org_team_fkey'],
  ['hs_seasons', 'hs_roster_memberships_org_season_fkey'],
]) {
  test(`hs_roster_memberships has a COMPOSITE foreign key to ${refTable}(org_id, id)`, () => {
    assert.match(sql, new RegExp(`constraint "${constraintName}" foreign key \\("org_id", "(player|team|season)_id"\\) references public\\.${refTable} \\("org_id", "id"\\) on delete cascade`));
  });
}

// ── 4. Tenant-scoped indexes exist ──────────────────────────────────────

for (const idx of [
  'idx_hs_seasons_org_id', 'idx_hs_seasons_program_id',
  'idx_hs_teams_org_id', 'idx_hs_teams_program_id',
  'idx_hs_players_org_id', 'idx_hs_players_program_id',
  'idx_hs_roster_memberships_org_id', 'idx_hs_roster_memberships_team_season', 'idx_hs_roster_memberships_player_id',
]) {
  test(`index ${idx} exists`, () => {
    assert.match(sql, new RegExp(`create index if not exists ${idx} `));
  });
}

// ── 5. Duplicate roster membership is prevented ─────────────────────────

test('hs_roster_memberships has a unique constraint on (player_id, team_id, season_id)', () => {
  assert.match(sql, /constraint "hs_roster_memberships_player_team_season_key" unique \("player_id", "team_id", "season_id"\)/);
});

// ── 6. Cross-program relationships are prevented structurally ──────────
// The structural guarantee: every parent table declares unique(org_id, id)
// so a composite FK can reference it, and every child's FK to that parent
// is composite on (org_id, <parent>_id) -- already asserted above (#3).
// This block additionally proves the supporting unique(org_id, id)
// constraints exist on every table a composite FK targets.

for (const table of ['hs_programs', 'hs_seasons', 'hs_teams', 'hs_players']) {
  test(`${table} has unique(org_id, id) so composite foreign keys can reference it`, () => {
    assert.match(sql, new RegExp(`constraint "${table}_org_id_id_key" unique \\("org_id", "id"\\)`));
  });
}

test('hs_programs enforces exactly one program per organization', () => {
  assert.match(sql, /constraint "hs_programs_org_id_key" unique \("org_id"\)/);
});

// ── 7. No production IDs or seed data ───────────────────────────────────

test('contains no INSERT statements (no seed data)', () => {
  assert.doesNotMatch(lowerSql, /insert into/);
});

test('contains no hard-coded UUID literal (no production-specific IDs)', () => {
  assert.doesNotMatch(sql, /'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/i);
});

// ── 8. No destructive statement, no mutation of existing tables ────────

test('contains no DROP, DELETE, TRUNCATE, or UPDATE DML statement', () => {
  for (const keyword of ['drop table', 'drop function', 'delete from', 'truncate']) {
    assert.doesNotMatch(statementsOnlyLower, new RegExp(keyword));
  }
  // Anchored to line-start so this doesn't false-positive on
  // "create trigger ... BEFORE UPDATE ON ..." (a legitimate trigger
  // clause, not a data-mutating UPDATE statement) -- an actual UPDATE
  // DML statement always starts its own line in this file's formatting.
  assert.doesNotMatch(statementsOnlyLower, /^update /m);
});

test('never issues ALTER TABLE against an existing Travel table', () => {
  for (const existingTable of ['organizations', 'teams', 'players', 'roster_players', 'games', 'org_members']) {
    assert.doesNotMatch(lowerSql, new RegExp(`alter table public\\.${existingTable}\\b`));
    assert.doesNotMatch(lowerSql, new RegExp(`alter table public\\."${existingTable}"`));
  }
});

test('only references organizations for its own foreign key, never writes to it', () => {
  const referencesOrganizations = sql.match(/organizations/gi) || [];
  // Every mention should be inside a "references public.organizations" or
  // an RLS-policy subquery reading it -- never "insert into"/"update"/"delete from".
  assert.ok(referencesOrganizations.length > 0);
  assert.doesNotMatch(lowerSql, /update public\.organizations|delete from public\.organizations|insert into public\.organizations/);
});

// ── 9. Grants are appropriately restricted ──────────────────────────────

test('contains no explicit GRANT to anon, authenticated, or PUBLIC', () => {
  assert.doesNotMatch(lowerSql, /grant .* to (anon|authenticated|public)\b/);
});

test('contains no GRANT statement at all (relies on RLS, matching the existing ordinary-table convention)', () => {
  assert.doesNotMatch(lowerSql, /^\s*grant /m);
});

// ── 10. No unjustified SECURITY DEFINER function ────────────────────────

test('defines no SECURITY DEFINER function (reuses the existing auth_user_org_ids() helper instead)', () => {
  assert.doesNotMatch(statementsOnlyLower, /security definer/);
  assert.doesNotMatch(statementsOnlyLower, /create (or replace )?function/);
});

// ── RLS policy shape ─────────────────────────────────────────────────────

for (const table of TABLES) {
  test(`${table}'s SELECT policy requires both org membership and high_school entitlement`, () => {
    const policyMatch = sql.match(new RegExp(`create policy "${table}_select" on public\\.${table}[\\s\\S]*?;`));
    assert.ok(policyMatch, `expected a ${table}_select policy`);
    const policyText = policyMatch[0];
    assert.match(policyText, /auth_user_org_ids\(\)/);
    assert.match(policyText, /enabled_products['"]? @> array\['high_school'\]/);
  });
}

test('no INSERT, UPDATE, or DELETE policy is defined on any High School table (read-only slice)', () => {
  assert.doesNotMatch(lowerSql, /for insert|for update|for delete|for all/);
});

test('date-range check exists on hs_seasons', () => {
  assert.match(sql, /constraint "hs_seasons_date_range_check" check \("start_date" is null or "end_date" is null or "end_date" >= "start_date"\)/);
});

test('graduation_year check uses a durable floor, not a now()-relative brittle range', () => {
  assert.match(sql, /constraint "hs_players_graduation_year_check" check \("graduation_year" is null or "graduation_year" >= 2000\)/);
  assert.doesNotMatch(lowerSql, /graduation_year.*now\(\)/);
});

test('team level is constrained to the three known values', () => {
  assert.match(sql, /constraint "hs_teams_level_check" check \("level" = any \(array\['varsity'::text, 'junior_varsity'::text, 'freshman'::text\]\)\)/);
});

// ── GameChanger roster-import readiness ─────────────────────────────────

function columnDefinition(table, column) {
  const tableMatch = sql.match(new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`));
  assert.ok(tableMatch, `expected to find CREATE TABLE for ${table}`);
  const body = tableMatch[1];
  const lineMatch = body.split('\n').find((l) => l.trim().startsWith(`"${column}"`));
  return lineMatch || null;
}

// 1. GameChanger team URL is optional
test('hs_teams.gc_team_url is nullable (no NOT NULL)', () => {
  const def = columnDefinition('hs_teams', 'gc_team_url');
  assert.ok(def, 'expected gc_team_url column');
  assert.doesNotMatch(def, /not null/i);
});

// 2. GameChanger team ID is optional
test('hs_teams.gc_external_team_id is nullable (no NOT NULL)', () => {
  const def = columnDefinition('hs_teams', 'gc_external_team_id');
  assert.ok(def, 'expected gc_external_team_id column');
  assert.doesNotMatch(def, /not null/i);
});

// 3 & 25. No credentials, tokens, cookies, or session material are stored
test('no column, comment prose aside, stores a credential/token/cookie/session artifact', () => {
  for (const forbidden of ['cookie', 'password', 'auth_token', 'session_state', 'storage_state', 'access_token', 'refresh_token']) {
    assert.doesNotMatch(statementsOnlyLower, new RegExp(`"${forbidden}"`));
  }
});

// 4 & 5. Jersey number remains text, and lives on the membership, not the player
test('hs_roster_memberships.jersey_number is still text (unchanged)', () => {
  const def = columnDefinition('hs_roster_memberships', 'jersey_number');
  assert.ok(def);
  assert.match(def, /"jersey_number" text/);
});

test('hs_players has no jersey_number column of its own', () => {
  assert.equal(columnDefinition('hs_players', 'jersey_number'), null);
});

// 6 & 7. Leading-zero and missing jersey numbers are permitted
test('jersey_number has no CHECK forcing numeric-only or fixed-length values (preserves "00", "01", and allows NULL)', () => {
  assert.doesNotMatch(lowerSql, /jersey_number.*check/);
  const def = columnDefinition('hs_roster_memberships', 'jersey_number');
  assert.doesNotMatch(def, /not null/i);
});

// 8 & 9. A player can have different numbers on different teams/seasons --
// structural consequence of the membership uniqueness being
// (player_id, team_id, season_id), not (player_id) alone, and jersey_number
// living per-membership, not per-player (already proven by test 5 above).
test('roster-membership uniqueness is per (player, team, season), allowing the same player multiple memberships with independent jersey numbers', () => {
  assert.match(sql, /constraint "hs_roster_memberships_player_team_season_key" unique \("player_id", "team_id", "season_id"\)/);
});

// 10 & 11. Source values distinguish manual/gamechanger and reject unknown values
for (const table of ['hs_teams', 'hs_players', 'hs_roster_memberships']) {
  test(`${table}.record_source is constrained to exactly 'manual' or 'gamechanger'`, () => {
    assert.match(sql, new RegExp(`constraint "${table}_record_source_check" check \\("record_source" = any \\(array\\['manual'::text, 'gamechanger'::text\\]\\)\\)`));
  });
}

// 12 & 13. External IDs are not globally unique; uniqueness is enforced
// within a safe, evidence-grounded scope
test('gc_team_url has no bare column-level UNIQUE -- only a partial index scoped to (org_id, gc_team_url)', () => {
  assert.doesNotMatch(statementsOnlyLower, /unique \("gc_team_url"\)/);
  assert.match(sql, /create unique index if not exists idx_hs_teams_org_gc_team_url on public\.hs_teams \("org_id", "gc_team_url"\) where "gc_team_url" is not null;/);
});

test('gc_external_team_id has no bare column-level UNIQUE -- only a partial index scoped to (org_id, gc_external_team_id)', () => {
  assert.doesNotMatch(statementsOnlyLower, /unique \("gc_external_team_id"\)/);
  assert.match(sql, /create unique index if not exists idx_hs_teams_org_gc_external_team_id on public\.hs_teams \("org_id", "gc_external_team_id"\) where "gc_external_team_id" is not null;/);
});

test('gc_external_player_id has no bare column-level UNIQUE -- only a partial index scoped to (team_id, season_id, gc_external_player_id), not merely org-wide', () => {
  assert.doesNotMatch(statementsOnlyLower, /unique \("gc_external_player_id"\)/);
  assert.match(sql, /create unique index if not exists idx_hs_roster_memberships_team_season_gc_player on public\.hs_roster_memberships \("team_id", "season_id", "gc_external_player_id"\) where "gc_external_player_id" is not null;/);
});

test('gc_external_player_id lives on hs_roster_memberships (team+season scoped), not on hs_players (which spans every team/season)', () => {
  assert.equal(columnDefinition('hs_players', 'gc_external_player_id'), null);
  assert.ok(columnDefinition('hs_roster_memberships', 'gc_external_player_id'));
});

// 14 & 15. Two same-name players can coexist; normalized name is never an identity constraint
test('no unique constraint exists on hs_players first_name/last_name or their normalized forms', () => {
  assert.doesNotMatch(statementsOnlyLower, /unique \("first_name", "last_name"\)/);
  assert.doesNotMatch(statementsOnlyLower, /unique \("normalized_first_name"/);
  assert.doesNotMatch(statementsOnlyLower, /unique \("normalized_last_name"/);
});

test('the normalized-name index is a plain (non-unique) btree index', () => {
  assert.match(sql, /create index if not exists idx_hs_players_program_normalized_name on public\.hs_players using btree \("program_id", "normalized_last_name", "normalized_first_name"\);/);
  assert.doesNotMatch(sql, /create unique index if not exists idx_hs_players_program_normalized_name/);
});

test('normalized_first_name/normalized_last_name are generated columns kept in sync automatically, never independently writable', () => {
  assert.match(sql, /"normalized_first_name" text generated always as \(lower\(trim\("first_name"\)\)\) stored/);
  assert.match(sql, /"normalized_last_name" text generated always as \(lower\(trim\("last_name"\)\)\) stored/);
});

// 17. Imported memberships can be marked inactive without deletion
test('hs_roster_memberships.status already supports an inactive (non-deleted) reconciliation state', () => {
  assert.match(sql, /constraint "hs_roster_memberships_status_check" check \("status" = any \(array\['active'::text, 'inactive'::text\]\)\)/);
});

// 18. Last-observed metadata exists
test('last_observed_at exists on both hs_players and hs_roster_memberships', () => {
  assert.ok(columnDefinition('hs_players', 'last_observed_at'));
  assert.ok(columnDefinition('hs_roster_memberships', 'last_observed_at'));
});

// 19. Last-attempt and last-success timestamps are distinct columns
test('hs_teams tracks roster_sync_attempted_at and roster_sync_succeeded_at as two separate, independently-nullable columns', () => {
  const attempted = columnDefinition('hs_teams', 'roster_sync_attempted_at');
  const succeeded = columnDefinition('hs_teams', 'roster_sync_succeeded_at');
  assert.ok(attempted);
  assert.ok(succeeded);
  assert.notEqual(attempted, succeeded);
  assert.doesNotMatch(attempted, /not null/i);
  assert.doesNotMatch(succeeded, /not null/i);
});

test('hs_teams.roster_sync_status is constrained to the five documented values', () => {
  assert.match(sql, /constraint "hs_teams_roster_sync_status_check" check \("roster_sync_status" = any \(array\['never'::text, 'pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text\]\)\)/);
});

// 20. Synchronization error storage is nullable and bounded
test('hs_teams.roster_sync_error is nullable and length-bounded', () => {
  const def = columnDefinition('hs_teams', 'roster_sync_error');
  assert.ok(def);
  assert.doesNotMatch(def, /not null/i);
  assert.match(sql, /constraint "hs_teams_roster_sync_error_length_check" check \("roster_sync_error" is null or char_length\("roster_sync_error"\) <= 2000\)/);
});

// 21. Synchronization metadata remains tenant-owned (still under RLS, still org_id-scoped)
test('every table carrying new synchronization metadata still has org_id and RLS enabled (unchanged)', () => {
  for (const table of TABLES) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security;`));
    assert.ok(columnDefinition(table, 'org_id'), `expected org_id on ${table}`);
  }
});

// 23. No live GameChanger request occurs (this is a static SQL file)
test('the migration contains no HTTP/browser-automation call of any kind', () => {
  for (const forbidden of ['fetch(', 'playwright', 'puppeteer', 'http://', 'https://']) {
    assert.doesNotMatch(statementsOnlyLower, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

// gc_match_status is a nullable, constrained ambiguity flag, not an identity guarantee
test('hs_players.gc_match_status is nullable and constrained to confirmed/ambiguous', () => {
  const def = columnDefinition('hs_players', 'gc_match_status');
  assert.ok(def);
  assert.doesNotMatch(def, /not null/i);
  assert.match(sql, /constraint "hs_players_gc_match_status_check" check \("gc_match_status" is null or "gc_match_status" = any \(array\['confirmed'::text, 'ambiguous'::text\]\)\)/);
});
