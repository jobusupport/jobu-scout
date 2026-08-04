'use strict';

// Focused tests for supabase/migrations/20260803120000_add_hs_player_lifecycle_status.sql
// and its down migration.
//
// ── What these tests do and do NOT prove ─────────────────────────────────
// Text-level assertions against the raw SQL, mirroring the convention
// already used in test/high-school-domain-migration.test.js and
// test/remove-game-date-repair-rpc-migration.test.js: these prove the
// migration's SHAPE and STATEMENT ORDER (the value-preserving CASE backfill
// runs before the CHECK constraint, which runs before NOT NULL, which runs
// before is_active is ever dropped; the five allowed status values; the
// generated-column expression; that no other table/RLS policy is touched).
//
// They do NOT execute any SQL and do NOT prove row-level behavior against a
// real Postgres instance -- no local Postgres/Supabase harness was available
// in this environment (the Supabase CLI is present, but it requires Docker
// to run `supabase start`, and no Docker daemon is available here). Actual
// row-level verification -- seeding both is_active=true and is_active=false
// legacy rows, applying this migration, and confirming status/is_active
// read back correctly for every one of the five statuses, then applying the
// rollback and confirming the documented collapse -- MUST happen against a
// disposable Supabase Preview Branch (see supabase/README.md's "Preview
// Branch validation workflow") before this PR is merged. This is a
// documented merge-gate requirement, not an oversight.
//
// Run with: node --test test/high-school-player-lifecycle-status-migration.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260803120000_add_hs_player_lifecycle_status.sql');
const DOWN_MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'rollback', '20260803120000_add_hs_player_lifecycle_status.down.sql');

const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
const lowerSql = sql.toLowerCase();
const downSql = fs.readFileSync(DOWN_MIGRATION_PATH, 'utf8');
const lowerDownSql = downSql.toLowerCase();

// Statements only, comment lines stripped -- same convention as
// test/high-school-domain-migration.test.js, so a prose mention inside a
// header comment (e.g. this file's own explanation of what it does) can
// never false-positive a statement-level assertion.
function statementsOnly(text) {
  return text
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
}

const statements = statementsOnly(sql);
const statementsLower = statements.toLowerCase();

// ── 1. Statement order: add (nullable) -> backfill -> constrain -> not
//      null/default -> drop+recreate is_active, in that exact order ──────

function indexOfStatement(pattern, label) {
  const idx = statementsLower.search(pattern);
  assert.notEqual(idx, -1, `expected to find: ${label}`);
  return idx;
}

test('migration adds status as nullable first (no CHECK/NOT NULL yet on that statement)', () => {
  const idx = indexOfStatement(/alter table public\.hs_players add column "status" text;/, 'add column status (nullable)');
  assert.ok(idx >= 0);
});

test('statement order is: add status -> backfill from is_active -> CHECK constraint -> NOT NULL/default -> drop+recreate is_active', () => {
  const addStatusIdx = indexOfStatement(/alter table public\.hs_players add column "status" text;/, 'add column status');
  const backfillIdx = indexOfStatement(/update public\.hs_players\s+set "status" = case when "is_active" then 'active' else 'other_non_returning' end;/, 'value-preserving backfill');
  const checkIdx = indexOfStatement(/add constraint "hs_players_status_check"/, 'CHECK constraint');
  const notNullIdx = indexOfStatement(/alter table public\.hs_players alter column "status" set not null;/, 'SET NOT NULL');
  const defaultIdx = indexOfStatement(/alter table public\.hs_players alter column "status" set default 'active';/, 'SET DEFAULT');
  const dropIsActiveIdx = indexOfStatement(/alter table public\.hs_players drop column "is_active";/, 'DROP COLUMN is_active');
  const addGeneratedIdx = indexOfStatement(/generated always as \("status" = 'active'\) stored/, 'generated is_active column');

  assert.ok(addStatusIdx < backfillIdx, 'status must be added before it is backfilled');
  assert.ok(backfillIdx < checkIdx, 'backfill must complete before the CHECK constraint is added (so no existing row can violate it)');
  assert.ok(checkIdx < defaultIdx, 'CHECK constraint should be in place before default/not-null tightening');
  assert.ok(defaultIdx < notNullIdx || checkIdx < notNullIdx, 'NOT NULL must come after backfill');
  assert.ok(backfillIdx < notNullIdx, 'backfill must complete before NOT NULL is enforced (every row must already be non-null)');
  assert.ok(notNullIdx < dropIsActiveIdx, 'is_active must not be dropped before status is fully constrained and populated');
  assert.ok(dropIsActiveIdx < addGeneratedIdx, 'is_active must be dropped before being recreated as a generated column');
});

// ── 2. The backfill preserves each row's ACTUAL is_active value ─────────
// (not a blanket default -- this is the specific defect the correction
// pass required fixing).

test('the backfill is a CASE expression keyed on the row\'s own is_active value, never a blanket default', () => {
  assert.match(statements, /update public\.hs_players\s+set "status" = case when "is_active" then 'active' else 'other_non_returning' end;/);
});

test('the backfill maps is_active=true to active and is_active=false to other_non_returning specifically (not graduated/transferred, which cannot be inferred)', () => {
  assert.match(statements, /when "is_active" then 'active'/);
  assert.match(statements, /else 'other_non_returning'/);
  assert.doesNotMatch(statementsLower, /else 'graduated'/);
  assert.doesNotMatch(statementsLower, /else 'transferred'/);
});

test('the migration contains no naive blanket backfill that ignores is_active entirely', () => {
  // A blanket, value-discarding backfill would look like:
  //   update public.hs_players set "status" = 'active';
  // with no CASE/is_active reference anywhere on that statement -- assert
  // no UPDATE statement in this file lacks a reference to is_active.
  const updateStatements = statements.match(/update public\.hs_players[\s\S]*?;/gi) || [];
  assert.ok(updateStatements.length > 0, 'expected at least one UPDATE statement (the backfill)');
  for (const stmt of updateStatements) {
    assert.match(stmt, /is_active/i, `every UPDATE on hs_players must reference is_active, got: ${stmt}`);
  }
});

// ── 3. Constraint / default / generated-column shape ────────────────────

test('the CHECK constraint allows exactly the five documented status values', () => {
  assert.match(
    sql,
    /constraint "hs_players_status_check"\s+check \("status" = any \(array\['active'::text, 'graduated'::text, 'transferred'::text, 'not_participating'::text, 'other_non_returning'::text\]\)\)/
  );
});

test('status gets a NOT NULL constraint and a default of \'active\' for future inserts', () => {
  assert.match(statements, /alter table public\.hs_players alter column "status" set default 'active';/);
  assert.match(statements, /alter table public\.hs_players alter column "status" set not null;/);
});

test('is_active is recreated as a STORED GENERATED column derived from status, never a plain writable column', () => {
  assert.match(sql, /alter table public\.hs_players add column "is_active" boolean\s+generated always as \("status" = 'active'\) stored;/);
});

test('is_active is dropped exactly once and re-added exactly once (not left in an intermediate writable state)', () => {
  const dropCount = (statementsLower.match(/drop column "is_active"/g) || []).length;
  const addCount = (statementsLower.match(/add column "is_active"/g) || []).length;
  assert.equal(dropCount, 1);
  assert.equal(addCount, 1);
});

// ── 4. No other table, RLS policy, index, or trigger is touched ─────────

test('no other hs_* table is altered by this migration', () => {
  for (const otherTable of ['hs_programs', 'hs_seasons', 'hs_teams', 'hs_roster_memberships', 'hs_games', 'hs_import_runs']) {
    assert.doesNotMatch(statementsLower, new RegExp(`alter table public\\.${otherTable}\\b`));
  }
});

test('no RLS policy is created, altered, or dropped by this migration (hs_players_select stays exactly as originally defined)', () => {
  assert.doesNotMatch(statementsLower, /create policy/);
  assert.doesNotMatch(statementsLower, /drop policy/);
  assert.doesNotMatch(statementsLower, /alter policy/);
  assert.doesNotMatch(statementsLower, /enable row level security/);
});

test('no index or trigger is created or dropped by this migration', () => {
  assert.doesNotMatch(statementsLower, /create index/);
  assert.doesNotMatch(statementsLower, /drop index/);
  assert.doesNotMatch(statementsLower, /create trigger/);
  assert.doesNotMatch(statementsLower, /drop trigger/);
});

test('no SECURITY DEFINER function, GRANT, or REVOKE is added (this migration only touches hs_players columns)', () => {
  assert.doesNotMatch(statementsLower, /security definer/);
  assert.doesNotMatch(statementsLower, /create (or replace )?function/);
  assert.doesNotMatch(statementsLower, /^\s*grant /m);
  assert.doesNotMatch(statementsLower, /^\s*revoke /m);
});

// ── 5. No destructive statement beyond the two deliberate, documented
//      is_active drop/recreate steps ────────────────────────────────────

test('contains no DROP TABLE, DELETE, or TRUNCATE', () => {
  for (const keyword of ['drop table', 'delete from', 'truncate']) {
    assert.doesNotMatch(statementsLower, new RegExp(keyword));
  }
});

test('contains exactly one DROP COLUMN statement, and it targets is_active specifically', () => {
  const dropColumnStatements = statementsLower.match(/drop column "[a-z_]+"/g) || [];
  assert.deepEqual(dropColumnStatements, ['drop column "is_active"']);
});

// ── 6. No seed data, no production IDs, no live network/browser calls ───

test('contains no INSERT statement (no seed data)', () => {
  assert.doesNotMatch(statementsLower, /insert into/);
});

test('contains no hard-coded UUID literal', () => {
  assert.doesNotMatch(sql, /'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/i);
});

test('contains no HTTP/browser-automation call of any kind', () => {
  for (const forbidden of ['fetch(', 'playwright', 'puppeteer', 'http://', 'https://']) {
    assert.doesNotMatch(statementsLower, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('contains no credential/token/cookie/session artifact', () => {
  for (const forbidden of ['cookie', 'password', 'auth_token', 'session_state', 'storage_state', 'access_token', 'refresh_token']) {
    assert.doesNotMatch(statementsLower, new RegExp(`"${forbidden}"`));
  }
});

// ── Down migration ─────────────────────────────────────────────────────

test('the down migration lives under supabase/rollback/, not supabase/migrations/', () => {
  assert.ok(fs.existsSync(DOWN_MIGRATION_PATH), 'expected the down migration file to exist under supabase/rollback/');
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260803120000_add_hs_player_lifecycle_status.down.sql')));
});

test('the down migration restores is_active as a plain writable boolean, collapsing every non-active status to false', () => {
  assert.match(downSql, /alter table public\.hs_players drop column "is_active";/);
  assert.match(downSql, /alter table public\.hs_players add column "is_active" boolean not null default true;/);
  assert.match(downSql, /update public\.hs_players set "is_active" = \("status" = 'active'\);/);
});

test('the down migration drops the status column and its CHECK constraint', () => {
  assert.match(downSql, /alter table public\.hs_players drop constraint "hs_players_status_check";/);
  assert.match(downSql, /alter table public\.hs_players drop column "status";/);
});

test('the down migration explicitly documents that rolling back loses the specific non-active reason', () => {
  assert.match(lowerDownSql, /loses information/);
  assert.match(lowerDownSql, /graduated/);
  assert.match(lowerDownSql, /transferred/);
  assert.match(lowerDownSql, /not_participating|not participating/);
});

test('the down migration documents the pre-adoption-only safety boundary (matches supabase/README.md\'s existing convention)', () => {
  assert.match(lowerDownSql, /pre-adoption/);
});
