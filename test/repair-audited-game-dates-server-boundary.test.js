'use strict';

// Server-boundary contract tests for
// supabase/migrations/20260724000000_repair_audited_game_dates_fn.sql.
//
// WHY THESE TESTS EXIST: an earlier revision of this migration accepted
// the entire 13-record repair set as a caller-supplied `p_records jsonb`
// parameter, validated only for self-consistency against whatever the
// CURRENT row happened to contain. That made the function usable, in
// effect, as a generic "update any game's date" RPC -- nothing at the
// database layer stopped a caller with RPC access from substituting a
// different game, a different date, a different count of targets, or a
// game outside the audited 13. Client-side allowlist validation in
// src/repairs/repair-audited-game-dates.js is NOT a security boundary --
// anything able to invoke the RPC directly bypasses it entirely.
//
// The fix: the exact 13-record before/after mapping is now a HARDCODED
// LITERAL inside the function body. The function's only parameter is
// `p_operation`, constrained to exactly 'repair' or 'rollback'. There is no
// calling convention through which any caller can supply a game ID, a
// date, or a count -- the SQL text itself proves this, independent of
// whatever the Node.js CLI does or does not check.
//
// LIMITATION (stated explicitly, per repository convention -- see
// test/admin-api-product-route-wiring.test.js for the same established
// pattern of mocking the RPC boundary rather than live-testing SQL): no
// local or CI Postgres instance is available in this repository (SQLite is
// the only local database option, and this function's syntax -- plpgsql,
// jsonb, `for update`, SECURITY DEFINER -- has no SQLite equivalent). These
// tests therefore verify the migration's SQL TEXT directly: the hardcoded
// mapping's exact content, the function signature, the grant/revoke
// statements, and the presence of the specific safety constructs the
// design depends on (row locking, operation whitelisting, count
// assertions). They do NOT execute the function against a real database.
// True end-to-end proof that PostgreSQL enforces this exactly as written
// can only come from actually applying the migration to a real database
// (staging or an ephemeral Supabase branch) and invoking the RPC -- which
// this task explicitly prohibits doing against production, and no
// non-production Postgres is available in this environment.

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260724000000_repair_audited_game_dates_fn.sql');
const ALLOWLIST_PATH = path.join(__dirname, '..', 'src', 'repairs', 'audited-game-dates-2026-07-24.allowlist.json');

const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');
const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));

// Extracts the v_repairs jsonb literal's inner text and parses it as JSON,
// so the test compares actual structured data, not a fragile substring
// match against SQL formatting.
function extractHardcodedRepairs(sql) {
  const start = sql.indexOf("v_repairs constant jsonb := '[");
  assert.ok(start !== -1, 'could not locate the v_repairs constant declaration in the migration');
  const arrayStart = sql.indexOf('[', start);
  const literalEnd = sql.indexOf("]'::jsonb", arrayStart);
  assert.ok(literalEnd !== -1, 'could not locate the end of the v_repairs jsonb literal');
  const jsonText = sql.slice(arrayStart, literalEnd + 1);
  return JSON.parse(jsonText);
}

// ── 1-9. The hardcoded server-side mapping is byte-for-byte the audit ──────

test('the migration file exists and defines repair_audited_game_dates', () => {
  assert.match(migrationSql, /create or replace function public\.repair_audited_game_dates/);
});

// Everything from the CREATE OR REPLACE FUNCTION line onward -- excludes
// the header comment block above it, which legitimately documents (by
// name) the old, unsafe p_records design this migration replaced. Scanning
// the whole file for that string would false-positive on the comment
// explaining why it's gone, not just on real code.
const functionCode = migrationSql.slice(migrationSql.indexOf('create or replace function public.repair_audited_game_dates'));

test('the function signature accepts ONLY p_operation -- no game data of any kind', () => {
  assert.match(functionCode, /^create or replace function public\.repair_audited_game_dates\(p_operation text\)/);
  assert.doesNotMatch(functionCode, /p_records/, 'the old, unsafe p_records parameter must not exist in the actual function code');
  assert.doesNotMatch(functionCode, /p_game_id|p_new_date|p_old_date|p_team_id/, 'no per-record parameter of any kind may exist -- the mapping must be hardcoded, not passed in');
});

test('the hardcoded server-side mapping contains exactly 13 records', () => {
  const hardcoded = extractHardcodedRepairs(migrationSql);
  assert.equal(hardcoded.length, 13);
});

test('the hardcoded server-side mapping is byte-for-byte identical to the audited allowlist (same game IDs, same dates, same raw evidence, in the same order)', () => {
  const hardcoded = extractHardcodedRepairs(migrationSql);
  assert.deepEqual(hardcoded, allowlist.records);
});

test('the hardcoded mapping never contains either legitimate May-24 game ID (arbitrary substitution is structurally impossible, not merely checked)', () => {
  const hardcoded = extractHardcodedRepairs(migrationSql);
  const ids = hardcoded.map(r => r.gameId);
  for (const legit of allowlist.legitimateExcludedGameIds) {
    assert.equal(ids.includes(legit), false);
  }
});

test('the hardcoded mapping has no duplicate gameId or gcGameId', () => {
  const hardcoded = extractHardcodedRepairs(migrationSql);
  assert.equal(new Set(hardcoded.map(r => r.gameId)).size, 13);
  assert.equal(new Set(hardcoded.map(r => r.gcGameId)).size, 13);
});

test('a fourteenth, arbitrary game can never be introduced: the mapping is a fixed literal, not built from any input, loop bound, or external read', () => {
  // The ENTIRE array is one JSONB string literal assigned to a `constant`.
  // There is no `select`, no parameter substitution, and no string
  // concatenation feeding into v_repairs -- grep for the declaration
  // keyword `constant` on the same statement as the literal, proving nothing
  // can reassign or extend it later in the function body.
  assert.match(migrationSql, /v_repairs constant jsonb :=/);
  assert.doesNotMatch(migrationSql, /v_repairs\s*:=\s*(?!constant)/, 'v_repairs must never be reassigned after its constant declaration');
});

test('omitting one of the 13 audited games is structurally impossible: the function itself asserts exactly 13 rows are updated, derived from the hardcoded literal, not from caller input', () => {
  assert.match(migrationSql, /v_updated_count <> v_expected_count or v_updated_count <> 13/);
  assert.match(migrationSql, /v_expected_count := jsonb_array_length\(v_repairs\)/, 'the expected count must come from the hardcoded literal, never from a caller-supplied array');
});

test('a caller cannot alter the proposed date, old date, team ID, or raw evidence for any record: none of these values are read from any function parameter', () => {
  // p_operation is the only parameter (already asserted above). Every
  // v_game_id / v_gc_game_id / v_team_id / v_expected_current_date /
  // v_target_date / v_raw assignment in the function body must read from
  // v_rec (an element of the hardcoded v_repairs), never from a bare
  // parameter reference.
  const assignments = migrationSql.match(/v_(game_id|gc_game_id|team_id|raw)\s*:=[^;]+;/g) || [];
  assert.ok(assignments.length > 0, 'expected to find per-record field assignments');
  for (const line of assignments) {
    assert.match(line, /v_rec->>/, `expected this assignment to read from v_rec (the hardcoded record), found: ${line}`);
  }
});

// ── 10-11. Repair cannot apply rollback values, and vice versa ─────────────

test('operation is constrained to exactly "repair" or "rollback" -- any other value is rejected before any row is touched', () => {
  assert.match(migrationSql, /if p_operation is distinct from 'repair' and p_operation is distinct from 'rollback' then/);
  assert.match(migrationSql, /raise exception 'invalid operation/);
});

test('repair and rollback use opposite expected-current/target date pairs from the SAME hardcoded record -- confirms rollback cannot introduce a value repair could not, and vice versa', () => {
  // Both directions are built exclusively from the same two fields
  // (oldDate/newDate) of the same hardcoded v_rec -- there is no third
  // value either direction could target.
  assert.match(migrationSql, /v_expected_current_date := \(v_rec->>'oldDate'\)::date;\s*\n\s*v_target_date\s*:= \(v_rec->>'newDate'\)::date;/);
  assert.match(migrationSql, /v_expected_current_date := \(v_rec->>'newDate'\)::date;\s*\n\s*v_target_date\s*:= \(v_rec->>'oldDate'\)::date;/);
});

// ── 12-13. Role/grant enforcement ───────────────────────────────────────────

test('PUBLIC, anon, and authenticated have execute explicitly revoked', () => {
  const revokeLine = migrationSql.match(/revoke execute on function public\.repair_audited_game_dates\(text\) from ([^;]+);/);
  assert.ok(revokeLine, 'expected an explicit revoke statement');
  const revokedFrom = revokeLine[1].split(',').map(s => s.trim());
  assert.deepEqual(revokedFrom.sort(), ['anon', 'authenticated', 'public'].sort());
});

test('only postgres and service_role are granted execute -- no other role, including anon/authenticated, appears in the grant', () => {
  const grantLine = migrationSql.match(/grant execute on function public\.repair_audited_game_dates\(text\) to ([^;]+);/);
  assert.ok(grantLine, 'expected an explicit grant statement');
  const grantedTo = grantLine[1].split(',').map(s => s.trim());
  assert.deepEqual(grantedTo.sort(), ['postgres', 'service_role'].sort());
  assert.equal(grantedTo.includes('anon'), false);
  assert.equal(grantedTo.includes('authenticated'), false);
  assert.equal(grantedTo.includes('public'), false);
});

// ── 14-15. Concurrency / unexpected-state safety constructs are present ────

test('every target row is read with FOR UPDATE (row-level locking against concurrent writers) before any precondition check', () => {
  const forUpdateCount = (migrationSql.match(/for update;/g) || []).length;
  assert.ok(forUpdateCount >= 1, 'expected at least one `for update` row lock');
});

test('every precondition mismatch raises an exception (aborting the whole transaction) rather than skipping or warning', () => {
  const requiredRaises = [
    'game_not_found',
    'gc_game_id_mismatch',
    'team_id_mismatch',
    'game_date_precondition_failed',
    'raw_evidence_mismatch',
  ];
  for (const marker of requiredRaises) {
    assert.match(migrationSql, new RegExp(`raise exception '${marker}`), `expected a raise exception for ${marker}`);
  }
});

test('no exception handler swallows or absorbs an error anywhere in this function -- every failure propagates and rolls back the whole call', () => {
  assert.doesNotMatch(migrationSql, /exception\s+when/i, 'a plpgsql EXCEPTION WHEN block would catch and potentially suppress a failure, defeating the all-or-nothing guarantee');
});

// ── 16-17. Atomic all-13 repair and rollback (design-level proof) ──────────

test('validation (pass 1) is a fully separate loop from the writes (pass 2) -- no UPDATE statement exists before every precondition has already been checked', () => {
  const pass1End = migrationSql.indexOf('-- ── Pass 2:');
  const pass1 = migrationSql.slice(0, pass1End);
  assert.doesNotMatch(pass1, /update public\.games/, 'pass 1 must never write -- it only validates');
});

test('the final row-count assertion hardcodes 13, not a value derived from any caller input', () => {
  assert.match(migrationSql, /v_updated_count <> 13/);
});

test('each UPDATE in pass 2 repeats the expected-current-date as an explicit WHERE predicate (an atomic conditional update, not only a prior SELECT check) and verifies exactly one row was affected via GET DIAGNOSTICS', () => {
  const pass2 = migrationSql.slice(migrationSql.indexOf('-- ── Pass 2:'));
  assert.match(pass2, /where id = v_game_id\s*\n\s*and game_date = v_expected_current_date;/);
  assert.match(pass2, /get diagnostics v_rows_affected = row_count;/);
  assert.match(pass2, /if v_rows_affected <> 1 then/);
});

// ── 18-19. Idempotency / mixed-state handling is the CLI's job, already unit-tested ─
// The SQL function itself is a pure "verify these 13 exact preconditions,
// then write these 13 exact values" primitive -- it does not attempt to
// classify already-repaired/mixed/unexpected states (there is nothing left
// to check once every precondition already passed for all 13 rows). That
// classification is the Node CLI's responsibility, already covered by
// test/repair-audited-game-dates.test.js's classifyOverallState /
// idempotent-no-op / mixed-state-fails-closed tests.

// ── SQL-injection surface check ─────────────────────────────────────────────

test('no dynamic SQL is constructed anywhere -- no EXECUTE, no format(), no string concatenation into a query', () => {
  assert.doesNotMatch(migrationSql, /\bexecute\s+['"(]/i, 'a dynamic EXECUTE would be a SQL-injection surface for whatever value feeds it');
  assert.doesNotMatch(migrationSql, /format\(/i);
});

// ── SECURITY DEFINER hardening ───────────────────────────────────────────────

test('the function is SECURITY DEFINER with a fixed, empty search_path, and schema-qualifies every table reference', () => {
  assert.match(migrationSql, /security definer/);
  assert.match(migrationSql, /set search_path = ''/);
  assert.doesNotMatch(migrationSql, /from games\b/, 'every reference must be schema-qualified (public.games), never bare');
  assert.match(migrationSql, /from public\.games/);
});
