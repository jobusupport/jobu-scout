'use strict';

// Security Slice T3B: genuine behavioral tests for src/report-access.js --
// the pure, dependency-free logic behind the ourTeamId ownership fix and
// the authenticated report-download route. Every function here is the
// REAL production module (required directly, never reimplemented), and
// the path-containment/symlink tests use real temporary files/directories
// on disk, not source-text assertions.
//
// Run with: node --test test/report-access.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  isValidUuid,
  resolveOwnedTeamId,
  sanitizeDownloadFilename,
  resolveContainedReportPath,
  isServableReportFile,
  resolveReportOutputDir,
} = require('../src/report-access');

// ── isValidUuid ──────────────────────────────────────────────────────────────

test('isValidUuid: accepts a well-formed UUID', () => {
  assert.equal(isValidUuid('11111111-1111-4111-8111-111111111111'), true);
});

test('isValidUuid: rejects malformed/blank/non-string values', () => {
  assert.equal(isValidUuid('not-a-uuid'), false);
  assert.equal(isValidUuid(''), false);
  assert.equal(isValidUuid(null), false);
  assert.equal(isValidUuid(undefined), false);
  assert.equal(isValidUuid(12345), false);
  assert.equal(isValidUuid('11111111-1111-4111-8111-11111111111'), false); // one char short
  assert.equal(isValidUuid('../../etc/passwd'), false);
});

// ── resolveOwnedTeamId (ourTeamId ownership) ─────────────────────────────────

const ORG_A_TEAMS = [
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', team_name: 'Org A Travel 14U' },
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb', team_name: 'Org A Travel 16U' },
];

test('resolveOwnedTeamId: missing ourTeamId (undefined/null/blank) returns null -- existing default behavior preserved', () => {
  assert.equal(resolveOwnedTeamId(ORG_A_TEAMS, undefined), null);
  assert.equal(resolveOwnedTeamId(ORG_A_TEAMS, null), null);
  assert.equal(resolveOwnedTeamId(ORG_A_TEAMS, ''), null);
});

test('resolveOwnedTeamId: org A can use its own team id', () => {
  assert.equal(
    resolveOwnedTeamId(ORG_A_TEAMS, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
});

test('resolveOwnedTeamId: a team id belonging to a DIFFERENT org (not present in the passed-in, already org-scoped list) is rejected', () => {
  const orgBTeamId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  assert.equal(resolveOwnedTeamId(ORG_A_TEAMS, orgBTeamId), false);
});

test('resolveOwnedTeamId: unknown (well-formed but nonexistent) id is rejected identically to a cross-org id', () => {
  assert.equal(resolveOwnedTeamId(ORG_A_TEAMS, 'ffffffff-ffff-4fff-8fff-ffffffffffff'), false);
});

test('resolveOwnedTeamId: malformed/wrong-type ourTeamId is rejected safely, never thrown', () => {
  assert.equal(resolveOwnedTeamId(ORG_A_TEAMS, 12345), false);
  assert.equal(resolveOwnedTeamId(ORG_A_TEAMS, { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }), false);
  assert.equal(resolveOwnedTeamId(ORG_A_TEAMS, ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']), false);
});

test('resolveOwnedTeamId: cross-org and unknown-id rejections are indistinguishable (same `false` return, no extra detail)', () => {
  const crossOrg = resolveOwnedTeamId(ORG_A_TEAMS, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  const unknown = resolveOwnedTeamId(ORG_A_TEAMS, 'ffffffff-ffff-4fff-8fff-ffffffffffff');
  assert.equal(crossOrg, false);
  assert.equal(unknown, false);
  assert.equal(crossOrg, unknown);
});

test('resolveOwnedTeamId: never mutates the passed-in teams array', () => {
  const teamsCopy = JSON.parse(JSON.stringify(ORG_A_TEAMS));
  resolveOwnedTeamId(ORG_A_TEAMS, 'nonexistent');
  assert.deepEqual(ORG_A_TEAMS, teamsCopy);
});

test('resolveOwnedTeamId: handles an empty/missing teams list safely (never throws)', () => {
  assert.equal(resolveOwnedTeamId([], 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), false);
  assert.equal(resolveOwnedTeamId(undefined, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), false);
  assert.equal(resolveOwnedTeamId(null, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), false);
});

// ── sanitizeDownloadFilename (header-injection prevention) ───────────────────

test('sanitizeDownloadFilename: normal title produces a normal filename', () => {
  assert.equal(sanitizeDownloadFilename('Report - Synthetic Tigers'), 'Report - Synthetic Tigers.pdf');
});

test('sanitizeDownloadFilename: strips CR/LF (header-injection characters)', () => {
  const malicious = 'Report\r\nSet-Cookie: evil=1';
  const safe = sanitizeDownloadFilename(malicious);
  assert.doesNotMatch(safe, /\r|\n/);
});

test('sanitizeDownloadFilename: strips quotes (cannot break out of the Content-Disposition attribute)', () => {
  const malicious = 'Report" ; filename="evil.exe';
  const safe = sanitizeDownloadFilename(malicious);
  assert.doesNotMatch(safe, /"/);
});

test('sanitizeDownloadFilename: strips path separators and control characters', () => {
  const malicious = '../../etc/passwd\x00.pdf';
  const safe = sanitizeDownloadFilename(malicious);
  assert.doesNotMatch(safe, /[\/\\\x00]/);
});

test('sanitizeDownloadFilename: always ends in .pdf regardless of input', () => {
  assert.match(sanitizeDownloadFilename('anything'), /\.pdf$/);
  assert.match(sanitizeDownloadFilename(''), /\.pdf$/);
  assert.match(sanitizeDownloadFilename(null), /\.pdf$/);
});

test('sanitizeDownloadFilename: length-capped', () => {
  const huge = 'A'.repeat(500);
  const safe = sanitizeDownloadFilename(huge);
  assert.ok(safe.length <= 84); // 80 + '.pdf'
});

test('sanitizeDownloadFilename: blank/null title falls back to a generic name, never empty', () => {
  assert.equal(sanitizeDownloadFilename(''), 'report.pdf');
  assert.equal(sanitizeDownloadFilename(null), 'report.pdf');
  assert.equal(sanitizeDownloadFilename('!!!***'), 'report.pdf');
});

// ── resolveContainedReportPath (path-traversal / containment) ────────────────

const REPORTS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'jobu-reports-test-'));

test('resolveContainedReportPath: a normal relative path resolves inside the root', () => {
  const resolved = resolveContainedReportPath(REPORTS_ROOT, 'org-a/report-1/scout-team.pdf');
  assert.ok(resolved);
  assert.ok(resolved.startsWith(path.resolve(REPORTS_ROOT)));
});

test('resolveContainedReportPath: missing/blank storage_path is rejected (legacy report with no file)', () => {
  assert.equal(resolveContainedReportPath(REPORTS_ROOT, null), null);
  assert.equal(resolveContainedReportPath(REPORTS_ROOT, undefined), null);
  assert.equal(resolveContainedReportPath(REPORTS_ROOT, ''), null);
});

test('resolveContainedReportPath: ../ traversal escaping the root is rejected', () => {
  assert.equal(resolveContainedReportPath(REPORTS_ROOT, '../../../etc/passwd'), null);
  assert.equal(resolveContainedReportPath(REPORTS_ROOT, 'org-a/../../outside.pdf'), null);
});

test('resolveContainedReportPath: an absolute path stored in the row is rejected, not honored', () => {
  const externalAbs = process.platform === 'win32' ? 'C:\\Windows\\System32\\config' : '/etc/passwd';
  assert.equal(resolveContainedReportPath(REPORTS_ROOT, externalAbs), null);
});

test('resolveContainedReportPath: a sibling directory that merely shares a prefix with the root is rejected ' +
     '(the containment check requires a real path separator, not just a string prefix match)', () => {
  const sibling = path.resolve(REPORTS_ROOT) + '-evil';
  // storage_path can't directly express this, but prove the boundary check itself is separator-aware
  // by resolving a crafted relative path that lands exactly on the sibling directory.
  const relative = path.relative(REPORTS_ROOT, path.join(sibling, 'file.pdf'));
  assert.equal(resolveContainedReportPath(REPORTS_ROOT, relative), null);
});

test('resolveContainedReportPath: non-string storage_path is rejected safely', () => {
  assert.equal(resolveContainedReportPath(REPORTS_ROOT, 12345), null);
  assert.equal(resolveContainedReportPath(REPORTS_ROOT, { path: 'x' }), null);
});

// ── isServableReportFile (real filesystem: files, directories, symlinks) ─────

test('isServableReportFile: a real regular file is servable', () => {
  const filePath = path.join(REPORTS_ROOT, 'real-report.pdf');
  fs.writeFileSync(filePath, 'synthetic pdf bytes');
  assert.equal(isServableReportFile(filePath), true);
});

test('isServableReportFile: a missing file is not servable (fails safely, never throws)', () => {
  assert.equal(isServableReportFile(path.join(REPORTS_ROOT, 'does-not-exist.pdf')), false);
});

test('isServableReportFile: a directory is rejected, not served', () => {
  const dirPath = path.join(REPORTS_ROOT, 'a-directory');
  fs.mkdirSync(dirPath, { recursive: true });
  assert.equal(isServableReportFile(dirPath), false);
});

test('isServableReportFile: a symlink is rejected even when it points at a real file inside the root ' +
     '(lstat never follows symlinks; every symlink is refused, not only ones that escape the root)', { skip: process.platform === 'win32' ? 'symlink creation requires elevated privileges on this platform' : false }, () => {
  const targetPath = path.join(REPORTS_ROOT, 'symlink-target.pdf');
  fs.writeFileSync(targetPath, 'synthetic pdf bytes');
  const linkPath = path.join(REPORTS_ROOT, 'symlink-report.pdf');
  try {
    fs.symlinkSync(targetPath, linkPath, 'file');
  } catch (err) {
    // Environment doesn't allow symlink creation (e.g. Windows without dev mode) -- skip gracefully.
    return;
  }
  try {
    assert.equal(isServableReportFile(linkPath), false);
  } finally {
    fs.unlinkSync(linkPath);
  }
});

// ── resolveReportOutputDir (collision-resistant per-org storage) ────────────

test('resolveReportOutputDir: two organizations generating a SAME-NAMED report on the SAME DATE receive distinct storage paths', () => {
  const orgA = 'aaaaaaaa-0000-4000-8000-000000000001';
  const orgB = 'bbbbbbbb-0000-4000-8000-000000000002';
  const reportForOrgA = 'cccccccc-0000-4000-8000-000000000001'; // e.g. both scouted "Tigers 14U" today
  const reportForOrgB = 'dddddddd-0000-4000-8000-000000000002';

  const dirA = resolveReportOutputDir(REPORTS_ROOT, orgA, reportForOrgA);
  const dirB = resolveReportOutputDir(REPORTS_ROOT, orgB, reportForOrgB);

  assert.notEqual(dirA, dirB);
  assert.ok(dirA.startsWith(path.resolve(REPORTS_ROOT)));
  assert.ok(dirB.startsWith(path.resolve(REPORTS_ROOT)));
  // report.js's own (unchanged) filename logic would still produce the
  // identical base filename inside each directory (e.g. scout-Tigers-14U-
  // 2026-01-01.pdf) -- collision-resistance comes entirely from the
  // directory split, not from the filename itself.
  const sameFilename = 'scout-Tigers-14U-2026-01-01.pdf';
  assert.notEqual(
    path.join(dirA, sameFilename),
    path.join(dirB, sameFilename)
  );
});

test('resolveReportOutputDir: missing or malformed orgId/reportId returns null (caller falls back to the flat, non-namespaced directory)', () => {
  const validId = 'aaaaaaaa-0000-4000-8000-000000000001';
  assert.equal(resolveReportOutputDir(REPORTS_ROOT, null, validId), null);
  assert.equal(resolveReportOutputDir(REPORTS_ROOT, validId, null), null);
  assert.equal(resolveReportOutputDir(REPORTS_ROOT, 'not-a-uuid', validId), null);
  assert.equal(resolveReportOutputDir(REPORTS_ROOT, undefined, undefined), null);
});

test('resolveReportOutputDir: the organization directory component is only ever the exact trusted orgId, never derived from anything else', () => {
  const orgId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const reportId = 'cccccccc-0000-4000-8000-000000000001';
  const dir = resolveReportOutputDir(REPORTS_ROOT, orgId, reportId);
  const relative = path.relative(REPORTS_ROOT, dir);
  const segments = relative.split(path.sep);
  assert.equal(segments[0], orgId);
  assert.equal(segments[1], reportId);
});
