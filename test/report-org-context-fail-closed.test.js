'use strict';

// Security Slice T3D (independent review correction): generate-report.js's
// own comment claims JOBU_JOB_ORG_ID is required and validated "before ANY
// database access (including db.init())". Before this file existed, that
// claim was proven only by source-text position (test/travel-org-propagation.test.js's
// index-comparison guards) -- never by actually running the script and
// observing what happens. These tests spawn the REAL script as a genuine
// `node src/generate-report.js` OS-process child (the exact entry point
// server.js spawns in production), the same technique
// test/gc-network-isolation.test.js already uses to prove
// src/high-school-gc-import.js fails closed at the process boundary, not
// merely within whatever process node:test happens to run in.
//
// Proves, for missing / blank / whitespace-only / malformed JOBU_JOB_ORG_ID:
//   - the process exits non-zero;
//   - the error is the expected org-context failure, not some unrelated
//     crash (e.g. a missing Supabase config or database file);
//   - db.init()'s own logging ("[db] USE_SUPABASE" / "[db-supabase] Supabase
//     client initialized.") never appears in stdout/stderr -- proving
//     db.init() itself never ran, i.e. no SQLite file was opened and no
//     Supabase client was constructed for querying;
//   - no team-related output (a team id/name, "Teams in Voodoo Scout DB",
//     a report-completion line) ever appears.
//
// Run with: node --test test/report-org-context-fail-closed.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'src', 'generate-report.js');
const REPO_ROOT = path.join(__dirname, '..');

function runGenerateReportChild(jobOrgId, args = ['Some Team Name']) {
  const env = { ...process.env };
  // Explicit, not merely inherited -- this is the specific precondition
  // each test below is proving matters. `undefined` removes the key
  // entirely from the child's environment when passed to child_process
  // (Node drops undefined-valued env entries), which is what the
  // "missing" test needs; every other case sets an explicit string.
  if (jobOrgId === undefined) {
    delete env.JOBU_JOB_ORG_ID;
  } else {
    env.JOBU_JOB_ORG_ID = jobOrgId;
  }
  // Never let a real report actually attempt to run even if validation
  // were somehow bypassed -- REPORTS_DIR points outside the repo so a
  // regression here can never write into the working tree.
  env.REPORTS_DIR = path.join(require('os').tmpdir(), 'jobu-scout-test-reports-should-never-be-created');

  return new Promise((resolve, reject) => {
    const child = spawn('node', [SCRIPT, ...args], { cwd: REPO_ROOT, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`generate-report.js child process did not exit within the bound.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 15000);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function assertFailedClosedBeforeDatabaseActivity({ code, stdout, stderr }) {
  const combined = stdout + stderr;
  assert.notEqual(code, 0, 'the process must exit with a failure, not silently succeed or hang');
  assert.doesNotMatch(combined, /\[db\]/, 'db.js#init() must never have logged -- it must never have run');
  assert.doesNotMatch(combined, /\[db-supabase\]/, 'db-supabase.js#init() must never have logged -- no Supabase client may have been constructed for querying');
  assert.doesNotMatch(combined, /Teams in Voodoo Scout DB/, 'listTeams() must never have run');
  assert.doesNotMatch(combined, /Generating report:/, 'runForTeam() must never have run');
  assert.doesNotMatch(combined, /No teams in database/, 'a team query must never have completed (even an empty-result one)');
}

test('generate-report.js (real child process): missing JOBU_JOB_ORG_ID fails closed before any database activity', async () => {
  const result = await runGenerateReportChild(undefined);
  assertFailedClosedBeforeDatabaseActivity(result);
  assert.match(result.stderr, /OrgContextRequiredError|JOBU_JOB_ORG_ID is required/, 'must fail via the established job-org-context contract');
}, { timeout: 20000 });

test('generate-report.js (real child process): blank JOBU_JOB_ORG_ID fails closed before any database activity', async () => {
  const result = await runGenerateReportChild('');
  assertFailedClosedBeforeDatabaseActivity(result);
  assert.match(result.stderr, /OrgContextRequiredError|JOBU_JOB_ORG_ID is required/, 'blank must be treated the same as missing');
}, { timeout: 20000 });

test('generate-report.js (real child process): whitespace-only JOBU_JOB_ORG_ID fails closed before any database activity', async () => {
  const result = await runGenerateReportChild('   \t  ');
  assertFailedClosedBeforeDatabaseActivity(result);
  assert.match(result.stderr, /OrgContextRequiredError|JOBU_JOB_ORG_ID is required/, 'whitespace-only must be treated the same as missing');
}, { timeout: 20000 });

test('generate-report.js (real child process): malformed (non-UUID) JOBU_JOB_ORG_ID fails closed before any database activity', async () => {
  const result = await runGenerateReportChild('not-a-real-uuid');
  assertFailedClosedBeforeDatabaseActivity(result);
  assert.match(result.stdout + result.stderr, /is not a valid organization id/, 'must fail via the isValidUuid format check, not an unrelated crash');
  assert.doesNotMatch(result.stdout, /OrgContextRequiredError/, 'a malformed (present, non-blank) value must pass requireJobOrgContext and fail at the UUID-format check instead');
}, { timeout: 20000 });

test('generate-report.js (real child process): a syntactically-plausible but attacker-supplied-looking org id (e.g. path traversal / SQL-ish string) is rejected the same way, never treated as a valid organization', async () => {
  const result = await runGenerateReportChild("'; DROP TABLE teams; --");
  assertFailedClosedBeforeDatabaseActivity(result);
  assert.match(result.stdout + result.stderr, /is not a valid organization id/);
});
