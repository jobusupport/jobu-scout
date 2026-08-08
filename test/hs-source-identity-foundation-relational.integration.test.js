'use strict';

// Real-Postgres relational integration tests for
// supabase/migrations/20260808172649_create_hs_source_identity_foundation.sql.
//
// WRITTEN, EXECUTED, AND VERIFIED against a real, disposable, non-Docker
// local Postgres 18 instance during development of this migration -- see
// the "HS GameChanger Importer -- Identity Model Correction" design series
// for the full rationale (v4-v6) and the conversation that authorized
// Slice 1 implementation for exactly how that verification was performed.
//
// Unlike test/high-school-import-publish-rpcs.integration.test.js (which
// talks to a full Supabase project via @supabase/supabase-js, requiring
// PostgREST), this file talks to a RAW Postgres instance directly via the
// psql CLI, because what it proves -- composite foreign-key and CHECK
// constraint behavior -- lives entirely in the database schema itself and
// needs no PostgREST/GoTrue/Realtime layer. This also means it works in
// environments with a native Postgres install but no Docker (Supabase's
// own `supabase start` requires Docker), which is exactly the environment
// this file was first run against.
//
// WRITTEN BUT NOT EXECUTED BY DEFAULT -- mirrors the exact same multi-gate
// safety design as every other *.integration.test.js file in this repo:
//
// Requires ALL of:
//   1. RUN_INTEGRATION_TESTS=1
//   2. TEST_CONFIRM_NON_PRODUCTION=yes -- a deliberate acknowledgement
//      this will run real DDL/DML against the target Postgres instance.
//   3. HS_REL_TEST_PG_HOST, HS_REL_TEST_PG_PORT, HS_REL_TEST_PG_DATABASE
//      (and optionally HS_REL_TEST_PG_USER, default 'postgres') pointing
//      at a disposable/local/non-production Postgres instance. No default
//      host/port is ever assumed -- refuses to guess.
//   4. That instance must already have the full existing migration chain
//      (every file in supabase/migrations/ in filename order) AND this
//      migration applied. This test does not apply migrations itself --
//      it only exercises constraint behavior against an already-migrated
//      database, matching how test/high-school-import-publish-rpcs
//      .integration.test.js expects its own target project to already be
//      migrated.
//
// Refuses outright, regardless of the above and with NO override, unless
// HS_REL_TEST_PG_HOST is exactly "localhost", "127.0.0.1", or "::1" --
// these destructive fixtures (composite FK/CHECK violations, forced-
// failure rollback tests) must never be pointable at anything but this
// machine. Also refuses outright if HS_REL_TEST_PG_HOST (or any of the
// other connection env vars) contains the known production Supabase
// project ref, as further defense-in-depth.
//
// Uses the psql CLI (path from HS_REL_TEST_PSQL_PATH, or 'psql' on PATH)
// rather than a new npm dependency -- no `pg` driver is present in
// package.json today, and adding one is out of scope for a schema-only
// slice.
//
// Run with:
//   RUN_INTEGRATION_TESTS=1 TEST_CONFIRM_NON_PRODUCTION=yes \
//   HS_REL_TEST_PG_HOST=127.0.0.1 HS_REL_TEST_PG_PORT=55491 HS_REL_TEST_PG_DATABASE=jobu_test \
//   node --test test/hs-source-identity-foundation-relational.integration.test.js

const KNOWN_PRODUCTION_PROJECT_REF = 'jqycdruhcaqdumuhirsw'; // "Jobu Scout Project"

// No credential of any kind is ever read, held, or logged by this file.
// The disposable instance these fixtures target is set up with trust
// authentication (see the design-review conversation for the exact
// initdb invocation) specifically so this file never needs a password,
// connection string, or token -- there is nothing here to leak.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RUN = process.env.RUN_INTEGRATION_TESTS === '1';
const confirmedNonProduction = process.env.TEST_CONFIRM_NON_PRODUCTION === 'yes';
const pgHostRaw = process.env.HS_REL_TEST_PG_HOST || '';
const pgPortRaw = process.env.HS_REL_TEST_PG_PORT || '';
const pgDatabaseRaw = process.env.HS_REL_TEST_PG_DATABASE || '';
const pgUserRaw = process.env.HS_REL_TEST_PG_USER || 'postgres';
const psqlPathRaw = process.env.HS_REL_TEST_PSQL_PATH || 'psql';

// ── Loopback-only guard -- no override exists for this, by design ───────
// These fixtures run destructive DDL/DML (composite FK/CHECK violations,
// forced-failure rollback tests). This allowlist is exact-match against
// the only three ways to spell "this machine" -- not a substring check,
// not a DNS-resolution check (which could itself be tricked), and not
// configurable via any environment variable. A host value that isn't
// exactly one of these three strings is refused outright, unconditionally,
// regardless of any other flag.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const isLoopbackHost = LOOPBACK_HOSTS.has(pgHostRaw);

// ── Strict allowlist validation before ANY shell interpolation ──────────
// pgHost is already constrained to one of three known-safe literals above.
// Port/user/database are validated against conservative identifier
// patterns -- real Postgres ports/usernames/database names never need
// anything outside these characters, so rejecting anything else is free
// defense-in-depth against shell metacharacters, not a real functionality
// loss.
const isValidPort = /^\d{1,5}$/.test(pgPortRaw);
const isValidIdentifier = (s) => /^[A-Za-z0-9_]+$/.test(s);
const isValidDatabase = isValidIdentifier(pgDatabaseRaw);
const isValidUser = isValidIdentifier(pgUserRaw);
// The psql binary path is the one value allowed to contain spaces
// (e.g. "C:\Program Files\PostgreSQL\18\bin\psql.exe") -- it is always
// double-quoted at the shell-command boundary below instead of pattern-
// restricted, and is never taken from anything but this process's own
// environment (never from database contents or fixture output).
const isValidPsqlPath = typeof psqlPathRaw === 'string' && psqlPathRaw.length > 0 && !psqlPathRaw.includes('"');

const connectionBlob = `${pgHostRaw}:${pgPortRaw}:${pgDatabaseRaw}:${pgUserRaw}`;
const pointsAtProduction = connectionBlob.includes(KNOWN_PRODUCTION_PROJECT_REF);
const hasConnectionInfo = !!pgHostRaw && !!pgPortRaw && !!pgDatabaseRaw;
const inputsAreWellFormed = !hasConnectionInfo || (isLoopbackHost && isValidPort && isValidDatabase && isValidUser && isValidPsqlPath);
const canRun = RUN && confirmedNonProduction && hasConnectionInfo && !pointsAtProduction && inputsAreWellFormed;

const skip = pointsAtProduction
  ? `refusing to run: connection info resolves to the known production project ref (${KNOWN_PRODUCTION_PROJECT_REF})`
  : hasConnectionInfo && !isLoopbackHost
  ? `refusing to run: HS_REL_TEST_PG_HOST ("${pgHostRaw}") must be exactly one of localhost/127.0.0.1/::1 -- no other host is ever permitted for these destructive fixtures, no override exists`
  : hasConnectionInfo && !(isValidPort && isValidDatabase && isValidUser && isValidPsqlPath)
  ? 'refusing to run: HS_REL_TEST_PG_PORT/DATABASE/USER/PSQL_PATH failed strict allowlist validation -- see file header'
  : canRun
  ? false
  : 'requires RUN_INTEGRATION_TESTS=1, TEST_CONFIRM_NON_PRODUCTION=yes, and HS_REL_TEST_PG_HOST/PORT/DATABASE in this process\'s own environment -- see file header';

// Only referenced once canRun is true, at which point every value above
// has already passed the loopback + allowlist checks.
const pgHost = pgHostRaw;
const pgPort = pgPortRaw;
const pgDatabase = pgDatabaseRaw;
const pgUser = pgUserRaw;
const psqlPath = psqlPathRaw;

function runSqlFile(relativeFixturePath) {
  const fixturePath = path.join(__dirname, 'fixtures', 'hs-source-identity-relational', relativeFixturePath);
  // psql writes query results (BEGIN/INSERT/SAVEPOINT/ROLLBACK/SELECT
  // output) to stdout but ERROR lines to stderr -- spawnSync captures
  // those as two SEPARATE buffers, which would destroy the chronological
  // interleaving the section() parser below depends on (every ERROR
  // would land after all stdout content instead of inside its own
  // check's section). Redirecting via the shell (2>&1, supported by both
  // POSIX shells and cmd.exe) merges them into one ordered stream before
  // Node ever sees it. Every interpolated value here has already been
  // through the loopback/allowlist checks above (pgHost/pgPort/pgUser/
  // pgDatabase) or is quoted (psqlPath, fixturePath) -- both fixture
  // paths are repo-controlled, not external input, and quoting still
  // covers the case of a repo checked out under a path containing spaces
  // (already exercised successfully during development, where the psql
  // binary itself was under "C:\Program Files\...").
  const command = `"${psqlPath}" -h ${pgHost} -p ${pgPort} -U ${pgUser} -d ${pgDatabase} -f "${fixturePath}" 2>&1`;
  const result = spawnSync(command, { encoding: 'utf8', shell: true });
  assert.equal(result.error, undefined, `failed to invoke psql: ${result.error}`);
  // A failed psql invocation must never be silently treated as an empty
  // pass -- distinguish "psql ran and the SQL produced expected/
  // unexpected errors inside its own script" (handled by the per-section
  // assertions below) from "psql itself could not even run the script"
  // (e.g. connection refused before a single \echo marker was reached).
  // In the latter case no section markers exist at all, which the
  // section-presence assertions below (assert.ok(sec.SETUP, ...), etc.)
  // already catch and fail on -- but surface the actual exit code and
  // captured output directly here too, so that failure is immediately
  // diagnosable rather than presenting as a confusing "missing section"
  // error several lines down.
  if (result.status !== 0 && !(result.stdout || '').includes('>>> SETUP_START')) {
    assert.fail(
      `psql exited with status ${result.status} before executing any part of the fixture script. ` +
      `This means it could not even connect/start -- not that a constraint check failed as expected. ` +
      `Captured output:\n${result.stdout || '(empty)'}`
    );
  }
  return result.stdout || '';
}

// Splits combined psql output into named sections delimited by this
// file's own '>>> CHECKx_START name' / '>>> CHECKx_END' echo markers.
function sections(output) {
  const map = {};
  const re = />>> (\w+)_START[^\n]*\n([\s\S]*?)>>> \1_END/g;
  let m;
  while ((m = re.exec(output))) {
    map[m[1]] = m[2];
  }
  return map;
}

function assertSucceededCleanly(section, label) {
  assert.ok(section, `expected a section for ${label}`);
  assert.doesNotMatch(section, /ERROR:/, `${label} should have succeeded with no ERROR, got:\n${section}`);
}

function assertFailedWith(section, constraintNameFragment, label) {
  assert.ok(section, `expected a section for ${label}`);
  assert.match(section, /ERROR:/, `${label} should have failed, got no ERROR:\n${section}`);
  assert.match(
    section,
    new RegExp(constraintNameFragment),
    `${label} should have failed on ${constraintNameFragment}, got:\n${section}`
  );
}

test('hs_team_source_registrations: relational behavior', { skip }, () => {
  const output = runSqlFile('registrations.sql');
  const sec = sections(output);

  assertSucceededCleanly(sec.SETUP, 'fixture setup');

  assertSucceededCleanly(sec.CHECK1, 'same-scope replacement');
  // Data row (not the header, which just says "tag"): old row superseded,
  // new row active, exactly one authoritative row for the slot.
  assert.match(sec.CHECK1, /CHECK1_COUNTS\s*\|\s*1\s*\|\s*1\s*\|\s*1/, `expected 1|1|1 counts row, got:\n${sec.CHECK1}`);

  assertFailedWith(sec.CHECK2, 'hs_team_source_registrations_superseded_by_same_scope_fkey', 'cross-team replacement pointer');
  assertFailedWith(sec.CHECK3, 'hs_team_source_registrations_superseded_by_same_scope_fkey', 'cross-season replacement pointer');

  // Cross-program: hs_programs enforces unique(org_id), so a genuine
  // two-real-programs fixture cannot be constructed (documented in the
  // migration's own header). This proves the org+program existence FK
  // rejects a garbage program_id, which is the reachable proxy today.
  assertFailedWith(sec.CHECK4, 'hs_team_source_registrations_org_program_fkey', 'garbage program_id');

  assertFailedWith(sec.CHECK5, 'hs_team_source_registrations_supersession_consistent_check', 'stray metadata on active');
  assertFailedWith(sec.CHECK5B, 'hs_team_source_registrations_supersession_consistent_check', 'stray metadata on pending');
  assertFailedWith(sec.CHECK5C, 'hs_team_source_registrations_rejected_requires_decision_check', 'rejected without decision (via stray-metadata attempt)');

  assertFailedWith(sec.CHECK6A, 'hs_team_source_registrations_supersession_consistent_check', 'superseded missing superseded_at');
  assertFailedWith(sec.CHECK6B, 'hs_team_source_registrations_supersession_consistent_check', 'superseded missing pointer');
  assertFailedWith(sec.CHECK6C, 'hs_team_source_registrations_supersession_consistent_check', 'superseded missing both');

  assert.ok(sec.CHECK7, 'expected CHECK7 section');
  assert.match(sec.CHECK7, /ERROR:.*null value in column "org_id"/, 'CHECK7 should force the deliberate mid-swap failure');
  // Both booleans true (psql prints boolean true as "t") proves the FULL
  // row -- status, superseded_at, superseded_by_registration_id, and
  // source_team_id -- reverted for both rows, not merely a status label.
  assert.match(
    sec.CHECK7,
    /CHECK7_POST_ROLLBACK\s*\|\s*t\s*\|\s*t/,
    `rollback must fully restore both old (active/unsuperseded/source_a) and new (pending/undecided/source_b) rows, got:\n${sec.CHECK7}`
  );

  assertFailedWith(sec.CHECK8, 'idx_hs_team_source_registrations_active_per_team_season', 'direct duplicate active insert');
  assertFailedWith(sec.CHECK9, 'hs_team_source_registrations_rejected_requires_decision_check', 'rejected without decision metadata');

  assertSucceededCleanly(sec.CHECK10, 'active without decision metadata');
  assert.match(sec.CHECK10, /CHECK10_RESULT\s*\|\s*active\s*\|/, 'active row with null decided_by_user_id/decided_at must succeed');
});

test('hs_opponent_source_links: relational behavior', { skip }, () => {
  const output = runSqlFile('opponent-links.sql');
  const sec = sections(output);

  assertSucceededCleanly(sec.SETUP, 'fixture setup');

  assertSucceededCleanly(sec.CHECK1, 'same-scope replacement');
  assert.match(sec.CHECK1, /CHECK1_COUNTS\s*\|\s*1\s*\|\s*1\s*\|\s*1/, `expected 1|1|1 counts row, got:\n${sec.CHECK1}`);

  assertFailedWith(sec.CHECK2, 'hs_opponent_source_links_superseded_by_same_scope_fkey', 'cross-opponent-team replacement pointer');
  assertFailedWith(sec.CHECK3, 'hs_opponent_source_links_superseded_by_same_scope_fkey', 'cross-season replacement pointer');

  // Same caveat as the registrations test's CHECK4 -- see that test and
  // the migration header. This exercises hs_opponent_teams' own FK to
  // hs_opponent_programs, the reachable proxy given hs_programs'
  // unique(org_id).
  assertFailedWith(sec.CHECK4, 'hs_opponent_teams_org_program_opponent_program_fkey', 'garbage program_id (via hs_opponent_teams)');

  assertFailedWith(sec.CHECK5, 'hs_opponent_source_links_supersession_consistent_check', 'stray metadata on linked');
  assertFailedWith(sec.CHECK5B, 'hs_opponent_source_links_supersession_consistent_check', 'stray metadata on pending');
  assertFailedWith(sec.CHECK5C, 'hs_opponent_source_links_supersession_consistent_check', 'stray metadata on needs_review');

  assertFailedWith(sec.CHECK6A, 'hs_opponent_source_links_supersession_consistent_check', 'superseded missing superseded_at');
  assertFailedWith(sec.CHECK6B, 'hs_opponent_source_links_supersession_consistent_check', 'superseded missing pointer');
  assertFailedWith(sec.CHECK6C, 'hs_opponent_source_links_supersession_consistent_check', 'superseded missing both');

  assert.ok(sec.CHECK7, 'expected CHECK7 section');
  assert.match(sec.CHECK7, /ERROR:.*null value in column "org_id"/, 'CHECK7 should force the deliberate mid-swap failure');
  assert.match(
    sec.CHECK7,
    /CHECK7_POST_ROLLBACK\s*\|\s*t\s*\|\s*t/,
    `rollback must fully restore both old (linked/unsuperseded/source_a) and new (pending/undecided/source_b) rows, got:\n${sec.CHECK7}`
  );

  assertFailedWith(sec.CHECK8, 'idx_hs_opponent_source_links_linked_per_opponent_team', 'direct duplicate linked per opponent team');
  assertFailedWith(sec.CHECK8B, 'idx_hs_opponent_source_links_linked_per_source_season', 'direct duplicate linked per source+season');

  assertFailedWith(sec.CHECK9, 'hs_opponent_source_links_rejected_requires_decision_check', 'rejected without decision metadata');

  assertSucceededCleanly(sec.CHECK10, 'linked without decision metadata or confidence');
  assert.match(sec.CHECK10, /CHECK10_RESULT\s*\|\s*linked\s*\|/, 'linked row with null confidence/decided_by_user_id/decided_at must succeed');

  assertSucceededCleanly(sec.CHECK11, 'same source team reused across two different seasons');
  assert.match(sec.CHECK11, /CHECK11_RESULT\s*\|\s*2\s*\r?\n/, 'both season-scoped links must independently reach linked');
});
