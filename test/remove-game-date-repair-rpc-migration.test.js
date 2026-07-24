'use strict';

// Focused tests for supabase/migrations/20260724180000_remove_repair_audited_game_dates_fn.sql --
// the cleanup migration that revokes and drops the temporary
// repair_audited_game_dates(text) RPC now that its one-time repair has
// been applied and independently verified.
//
// These are text-level assertions against the raw SQL, mirroring the
// convention in test/repair-audited-game-dates-server-boundary.test.js:
// they prove the migration's shape (what it does and does not touch), not
// runtime behavior against a real Postgres instance.
//
// Run with: node --test test/remove-game-date-repair-rpc-migration.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260724180000_remove_repair_audited_game_dates_fn.sql');
const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');

// Statements only, with the header comment block stripped -- the comment
// explains the migration in prose (mentioning TRUNCATE, public.games, etc.
// as things it does NOT do), which would otherwise false-positive against
// checks that are only meaningful against the actual executable SQL.
const statementsOnly = migrationSql
  .split('\n')
  .filter(l => !l.trim().startsWith('--'))
  .join('\n');

test('the cleanup migration file exists', () => {
  assert.ok(migrationSql.length > 0);
});

test('it drops the exact schema-qualified signature, not an unqualified or signature-free drop', () => {
  assert.match(migrationSql, /drop function public\.repair_audited_game_dates\(text\);/);
});

test('the drop statement has no IF EXISTS -- it fails loudly on unexpected state rather than silently no-op-ing', () => {
  const dropLine = migrationSql.split('\n').find(l => /drop function/i.test(l));
  assert.ok(dropLine, 'expected a drop function statement');
  assert.doesNotMatch(dropLine, /if exists/i);
});

test('it does not drop any other function name', () => {
  const dropStatements = migrationSql.match(/drop function[^;]*;/gi) || [];
  assert.equal(dropStatements.length, 1);
  assert.match(dropStatements[0], /repair_audited_game_dates/);
});

test('it revokes execute before dropping (revoke statement precedes the drop statement)', () => {
  const revokeIndex = migrationSql.search(/revoke execute/i);
  const dropIndex = migrationSql.search(/drop function/i);
  assert.ok(revokeIndex >= 0, 'expected a revoke statement');
  assert.ok(dropIndex >= 0, 'expected a drop statement');
  assert.ok(revokeIndex < dropIndex, 'revoke must come before drop');
});

test('the revoke targets the exact function signature and covers every relevant role', () => {
  const revokeLine = migrationSql.split('\n').find(l => /revoke execute/i.test(l));
  assert.ok(revokeLine);
  assert.match(revokeLine, /repair_audited_game_dates\(text\)/);
  for (const role of ['public', 'anon', 'authenticated', 'service_role', 'postgres']) {
    assert.match(revokeLine.toLowerCase(), new RegExp(`\\b${role}\\b`));
  }
});

test('contains no data-manipulation statements', () => {
  for (const keyword of ['insert into', 'update ', 'delete from', 'truncate', 'merge ']) {
    assert.doesNotMatch(statementsOnly.toLowerCase(), new RegExp(keyword));
  }
});

test('contains no dynamic SQL', () => {
  assert.doesNotMatch(statementsOnly.toLowerCase(), /execute\s+format|execute\s+'|format\(/);
});

test('never references public.games', () => {
  assert.doesNotMatch(statementsOnly, /public\.games\b/);
});

test('never references public.game_stat_validation_results', () => {
  assert.doesNotMatch(statementsOnly, /game_stat_validation_results/);
});

test('contains exactly two SQL statements: the revoke and the drop', () => {
  const statements = statementsOnly
    .split('\n')
    .filter(l => l.trim().length > 0);
  assert.equal(statements.length, 2);
});
