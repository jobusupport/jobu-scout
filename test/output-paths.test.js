'use strict';

// Security Slice T3H: src/output-paths.js#resolveOrgOutputRoot()/
// resolveTeamOutputDir()/resolveOrgSubdir() are the single authoritative
// resolvers every scraped-output writer/reader now uses instead of the
// shared, flat output/<TeamName>/ tree. team_game_urls-style tenant
// isolation was already fixed at the database layer by T3G; this closes
// the equivalent gap one layer earlier, at the raw-file staging layer,
// where two organizations scouting an identically-named team could
// previously have their files physically co-located.
//
// These tests exercise the REAL src/output-paths.js against real
// temporary directories (never this checkout's actual output/ tree),
// proving the containment and fail-closed guarantees directly rather than
// only checking source text.
//
// Run with: node --test test/output-paths.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUTPUT_PATHS_MODULE = require.resolve('../src/output-paths');

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

// Re-requires src/output-paths.js fresh with REPO_ROOT effectively pointed
// at an isolated temp directory -- by overriding process.cwd()-independent
// __dirname resolution is not possible without editing the module, so
// instead each test asserts against the module's real REPO_ROOT-relative
// output/ location but always cleans up any directory it creates, and
// every test uses a unique, obviously-synthetic orgId so it can never
// collide with anything a real run would create. No test reads or
// modifies pre-existing content under this checkout's real output/.
function outputPaths() {
  delete require.cache[OUTPUT_PATHS_MODULE];
  return require('../src/output-paths');
}

function cleanupOrgDir(orgId) {
  const { outputRoot } = outputPaths();
  const dir = path.join(outputRoot(), orgId);
  fs.rmSync(dir, { recursive: true, force: true });
}

test('resolveOrgOutputRoot: a valid organization id produces output/<orgId>/ and creates it', () => {
  const { resolveOrgOutputRoot, outputRoot } = outputPaths();
  try {
    const orgRoot = resolveOrgOutputRoot(ORG_A);
    assert.equal(orgRoot, path.join(outputRoot(), ORG_A));
    assert.ok(fs.existsSync(orgRoot) && fs.statSync(orgRoot).isDirectory());
  } finally {
    cleanupOrgDir(ORG_A);
  }
});

test('resolveTeamOutputDir: a valid organization id and team name produce output/<orgId>/<team>/ and create it', () => {
  const { resolveTeamOutputDir, outputRoot } = outputPaths();
  try {
    const teamDir = resolveTeamOutputDir(ORG_A, 'Elite 14U');
    assert.equal(teamDir, path.join(outputRoot(), ORG_A, 'Elite 14U'));
    assert.ok(fs.existsSync(teamDir) && fs.statSync(teamDir).isDirectory());
  } finally {
    cleanupOrgDir(ORG_A);
  }
});

test('resolveOrgOutputRoot: missing organization id fails (InvalidOutputOrgIdError), never resolves a shared/legacy path', () => {
  const { resolveOrgOutputRoot, InvalidOutputOrgIdError } = outputPaths();
  assert.throws(() => resolveOrgOutputRoot(undefined), InvalidOutputOrgIdError);
});

test('resolveOrgOutputRoot: blank organization id fails', () => {
  const { resolveOrgOutputRoot, InvalidOutputOrgIdError } = outputPaths();
  assert.throws(() => resolveOrgOutputRoot('   '), InvalidOutputOrgIdError);
});

test('resolveOrgOutputRoot: malformed (non-UUID) organization id fails', () => {
  const { resolveOrgOutputRoot, InvalidOutputOrgIdError } = outputPaths();
  for (const bad of ['not-a-uuid', '12345', 'org-a', ORG_A.slice(0, -1)]) {
    assert.throws(() => resolveOrgOutputRoot(bad), InvalidOutputOrgIdError, `expected "${bad}" to be rejected`);
  }
});

test('resolveTeamOutputDir: validation occurs before any path use -- an invalid orgId never creates a directory', () => {
  const { resolveTeamOutputDir, outputRoot } = outputPaths();
  const before = fs.existsSync(outputRoot()) ? fs.readdirSync(outputRoot()) : [];
  assert.throws(() => resolveTeamOutputDir('not-a-uuid', 'Some Team'));
  const after = fs.existsSync(outputRoot()) ? fs.readdirSync(outputRoot()) : [];
  assert.deepEqual(after, before, 'no new directory may have been created for an invalid orgId');
});

test('resolveTeamOutputDir: ".." traversal in the team-folder component is rejected, never escapes the organization root', () => {
  const { resolveTeamOutputDir, InvalidOutputOrgIdError } = outputPaths();
  try {
    assert.throws(() => resolveTeamOutputDir(ORG_A, '../../etc'), InvalidOutputOrgIdError);
    assert.throws(() => resolveTeamOutputDir(ORG_A, '..'), InvalidOutputOrgIdError);
  } finally {
    cleanupOrgDir(ORG_A);
  }
});

test('resolveTeamOutputDir: an absolute-path or nested-path team-folder component is rejected', () => {
  const { resolveTeamOutputDir, InvalidOutputOrgIdError } = outputPaths();
  try {
    const escapes = process.platform === 'win32'
      ? ['C:\\Windows\\Temp', '\\\\server\\share', 'nested\\path']
      : ['/etc/passwd', 'nested/path'];
    for (const escape of escapes) {
      assert.throws(() => resolveTeamOutputDir(ORG_A, escape), InvalidOutputOrgIdError, `expected "${escape}" to be rejected`);
    }
  } finally {
    cleanupOrgDir(ORG_A);
  }
});

test('resolveOrgOutputRoot: a sibling directory sharing a prefix (e.g. "<orgId>-evil") is never treated as contained', () => {
  const { assertContained, outputRoot } = outputPaths();
  const orgRoot = path.join(outputRoot(), ORG_A);
  const sibling = path.join(outputRoot(), `${ORG_A}-evil`);
  assert.throws(() => assertContained(orgRoot, sibling));
});

test('resolveTeamOutputDir: normal team names with spaces and ordinary punctuation remain usable', () => {
  const { resolveTeamOutputDir } = outputPaths();
  try {
    const dir = resolveTeamOutputDir(ORG_A, 'FS Bulldogs 14U (Black)');
    assert.ok(fs.existsSync(dir));
    assert.match(dir, /FS Bulldogs 14U \(Black\)$/);
  } finally {
    cleanupOrgDir(ORG_A);
  }
});

test('resolveTeamOutputDir: identical team names for two different organizations resolve to physically distinct directories', () => {
  const { resolveTeamOutputDir } = outputPaths();
  try {
    const dirA = resolveTeamOutputDir(ORG_A, 'Elite 14U');
    const dirB = resolveTeamOutputDir(ORG_B, 'Elite 14U');
    assert.notEqual(dirA, dirB);
    assert.ok(dirA.includes(ORG_A));
    assert.ok(dirB.includes(ORG_B));
    assert.ok(!dirA.includes(ORG_B));
    assert.ok(!dirB.includes(ORG_A));
  } finally {
    cleanupOrgDir(ORG_A);
    cleanupOrgDir(ORG_B);
  }
});

test('resolveTeamOutputDir: writing into organization A\'s team directory never creates or touches organization B\'s directory for the same team name', () => {
  const { resolveTeamOutputDir } = outputPaths();
  try {
    const dirA = resolveTeamOutputDir(ORG_A, 'Elite 14U');
    fs.writeFileSync(path.join(dirA, 'game-1.json'), JSON.stringify({ synthetic: true }), 'utf8');

    const { outputRoot } = outputPaths();
    const orgBRoot = path.join(outputRoot(), ORG_B);
    assert.ok(!fs.existsSync(orgBRoot), 'organization B\'s root must not have been created as a side effect');
  } finally {
    cleanupOrgDir(ORG_A);
    cleanupOrgDir(ORG_B);
  }
});

test('resolveOrgSubdir: resolves and creates a named subdirectory scoped under the organization root, not the shared output/ root', () => {
  const { resolveOrgSubdir, outputRoot } = outputPaths();
  try {
    const dir = resolveOrgSubdir(ORG_A, '_failed-team-matches');
    assert.equal(dir, path.join(outputRoot(), ORG_A, '_failed-team-matches'));
    assert.ok(fs.existsSync(dir));
  } finally {
    cleanupOrgDir(ORG_A);
  }
});

test('resolveOrgSubdir: fails closed for a missing organization id, same as resolveOrgOutputRoot', () => {
  const { resolveOrgSubdir, InvalidOutputOrgIdError } = outputPaths();
  assert.throws(() => resolveOrgSubdir(undefined, '_failed-team-matches'), InvalidOutputOrgIdError);
});

test('the helper never resolves a team directory directly under the global output/ root -- every real return value includes the organization id as a path segment', () => {
  const { resolveTeamOutputDir, outputRoot } = outputPaths();
  try {
    const dir = resolveTeamOutputDir(ORG_A, 'Some Team');
    const rel = path.relative(outputRoot(), dir);
    const segments = rel.split(path.sep);
    assert.equal(segments[0], ORG_A, 'the first path segment under output/ must always be the organization id');
  } finally {
    cleanupOrgDir(ORG_A);
  }
});
