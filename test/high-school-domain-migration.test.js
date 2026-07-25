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
