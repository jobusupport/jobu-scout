'use strict';

// Security Slice T3H: structural (source-text) proof, in the same style
// test/scrape-game-urls-org-context.test.js and
// test/travel-org-propagation.test.js already use, that every
// production-reachable writer/reader of the scraped-output staging tree
// routes through src/output-paths.js's org-scoped resolvers and that the
// pre-T3H flat output/<TeamName>/ construction is gone from each one.
//
// Executable (real-child-process / real-filesystem) proof of the shared
// resolver's own containment and fail-closed behavior lives in
// test/output-paths.test.js -- these tests exist to prove each CALLER
// actually wires into that already-proven primitive correctly, not to
// re-prove the primitive itself.
//
// Two of the files covered here (src/scrape-game-urls.js,
// src/high-school-gc-import.js) cannot be safely exercised end-to-end in
// this suite without a real GameChanger session and a real browser, which
// this repository's test conventions deliberately avoid (see
// test/scrape-game-urls-org-context.test.js's own header). reingest-games.js
// additionally cannot be safely spawned as a real subprocess for this
// specific behavior: its DB_PATH is a hardcoded, non-overridable path to
// this checkout's real voodoo-scout.db (unlike e.g.
// check-game-date-integrity.js's SQLITE_DB_PATH override), so a real
// subprocess run would read/write actual project data -- adding an
// override seam is unrelated refactoring outside this slice's scope. This
// file's structural checks are the deliberate, documented substitute for
// those three.
//
// Run with: node --test test/output-scoping-structural.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

function src(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

// ── src/scrape-game-urls.js ─────────────────────────────────────────────

test('scrape-game-urls.js requires output-paths.js and resolves its staging directory through resolveTeamOutputDir, not a literal output/ join', () => {
  const source = src('src/scrape-game-urls.js');
  assert.match(source, /require\(\s*['"]\.\/output-paths['"]\s*\)/);
  assert.match(source, /resolveTeamOutputDir\(/);
  assert.doesNotMatch(source, /path\.join\(\s*__dirname[^)]*['"]output['"]/, 'no literal output/ root may be constructed in this file');
});

test('scrape-game-urls.js resolves and validates its output directory before launching a browser or requiring GameChanger access', () => {
  const source = src('src/scrape-game-urls.js');
  const resolveIndex = source.indexOf('resolveTeamOutputDir(');
  const launchIndex = source.indexOf('chromium.launch(');
  assert.notEqual(resolveIndex, -1, 'resolveTeamOutputDir must be called');
  assert.notEqual(launchIndex, -1, 'chromium.launch must be called');
  assert.ok(resolveIndex < launchIndex, 'output-path validation must happen before the browser launches');
});

test('scrape-game-urls.js sets search-gamechanger-teams.js\'s trusted org-id state (setCurrentJobOrgId) with its own already-validated JOB_ORG_ID before calling extractGameData', () => {
  const source = src('src/scrape-game-urls.js');
  assert.match(source, /mainScraper\.setCurrentJobOrgId\(\s*JOB_ORG_ID\s*\)/, 'must propagate the same trusted org id, not a fresh/unvalidated one');
  const setIndex = source.indexOf('mainScraper.setCurrentJobOrgId(');
  const extractCallIndex = source.indexOf('extractGameData(page,');
  assert.notEqual(setIndex, -1);
  assert.notEqual(extractCallIndex, -1);
  assert.ok(setIndex < extractCallIndex, 'org-id state must be set before extractGameData is ever invoked');
});

// ── src/search-gamechanger-teams.js ─────────────────────────────────────

test('search-gamechanger-teams.js requires output-paths.js and every output/ helper (team dir, failed-matches, failed-captures, Team URLs.txt) routes through it', () => {
  const source = src('src/search-gamechanger-teams.js');
  assert.match(source, /require\(\s*['"]\.\/output-paths['"]\s*\)/);
  assert.match(source, /resolveTeamOutputDir\(/);
  assert.match(source, /resolveOrgSubdir\(/);
  assert.match(source, /resolveOrgOutputRoot\(/);
  assert.doesNotMatch(source, /const\s+OUTPUT_DIR\s*=/, 'the old flat module-level OUTPUT_DIR constant must be gone');
  assert.doesNotMatch(source, /const\s+FAILED_MATCHES_DIR\s*=/, 'the old flat module-level constant must be gone');
  assert.doesNotMatch(source, /const\s+FAILED_GAME_CAPTURES_DIR\s*=/, 'the old flat module-level constant must be gone');
});

test('search-gamechanger-teams.js sets CURRENT_JOB_ORG_ID from requireJobOrgContext() in both main() and scrapeTeamById(), before any output/ path can be requested', () => {
  const source = src('src/search-gamechanger-teams.js');
  const setterAssignments = source.match(/CURRENT_JOB_ORG_ID\s*=\s*jobOrgId\s*;/g) || [];
  assert.ok(setterAssignments.length >= 2, 'expected CURRENT_JOB_ORG_ID to be set in both main() and scrapeTeamById()');
});

test('search-gamechanger-teams.js exports setCurrentJobOrgId for external callers (scrape-game-urls.js/high-school-gc-import.js), and it independently re-validates its input', () => {
  const source = src('src/search-gamechanger-teams.js');
  assert.match(source, /function setCurrentJobOrgId\(orgId\)\s*\{/);
  assert.match(source, /setCurrentJobOrgId,?\s*\n?\s*\};/);
  const fnBody = source.slice(
    source.indexOf('function setCurrentJobOrgId'),
    source.indexOf('function setCurrentJobOrgId') + 400
  );
  assert.match(fnBody, /isValidUuid\(orgId\)/, 'setCurrentJobOrgId must not trust its input without re-validating it');
});

test('search-gamechanger-teams.js: getTeamOutputDir/failedMatchesDir/failedGameCapturesDir/teamUrlsFilePath all fail closed via requireCurrentJobOrgId when org context has not been established', () => {
  const source = src('src/search-gamechanger-teams.js');
  assert.match(source, /function requireCurrentJobOrgId\(\)\s*\{/);
  for (const fn of ['failedMatchesDir', 'failedGameCapturesDir', 'teamUrlsFilePath', 'getTeamOutputDir']) {
    const fnStart = source.indexOf(`function ${fn}(`);
    assert.notEqual(fnStart, -1, `expected to find function ${fn}`);
    const fnBody = source.slice(fnStart, fnStart + 300);
    assert.match(fnBody, /requireCurrentJobOrgId\(\)/, `${fn} must read the validated org id via requireCurrentJobOrgId()`);
  }
});

// ── src/scrape-gc-player-stats.js ───────────────────────────────────────
// Discovered during T3H implementation: called from
// scrape-handedness.js#captureRosterHandedness for every roster player
// (production-reachable, gated by GC_HANDEDNESS_DEBUG_HTML=true, the same
// flag scrape-handedness.js's own debug dump uses) and was missing from
// the original Phase 2 writer inventory. Its debug-HTML dump used to write
// directly into the legacy shared output/_handedness-debug/ directory,
// bypassing scrape-handedness.js's own org-scoped fix entirely.

test('scrape-gc-player-stats.js requires an orgId for its debug-HTML dump and routes it through resolveOrgSubdir, not a literal output/ join', () => {
  const source = src('src/scrape-gc-player-stats.js');
  assert.match(source, /require\(\s*['"]\.\/output-paths['"]\s*\)/);
  assert.match(source, /resolveOrgSubdir\(\s*orgId/);
  assert.doesNotMatch(source, /path\.join\(\s*__dirname[^)]*['"]output['"]/, 'no literal output/ root may be constructed in this file');
});

test('scrape-gc-player-stats.js: captureGcStatsAndSprayForPlayer accepts orgId and threads it into every debug-dump call site', () => {
  const source = src('src/scrape-gc-player-stats.js');
  assert.match(source, /async function captureGcStatsAndSprayForPlayer\(page,\s*\{[^}]*orgId[^}]*\}\)/);
  const dumpCallLines = source.split('\n').filter((line) => line.includes('maybeDumpDebugHtml('));
  assert.ok(dumpCallLines.length >= 2, 'expected at least the STATSFAIL and SPRAYFAIL debug-dump call sites');
  for (const line of dumpCallLines) {
    assert.match(line, /orgId/, `every maybeDumpDebugHtml call must pass orgId: ${line}`);
  }
});

test('scrape-handedness.js passes its own already-validated CURRENT_JOB_ORG_ID into captureGcStatsAndSprayForPlayer', () => {
  const source = src('src/scrape-handedness.js');
  const callStart = source.indexOf('captureGcStatsAndSprayForPlayer(page,');
  assert.notEqual(callStart, -1);
  const callBody = source.slice(callStart, callStart + 700);
  assert.match(callBody, /orgId:\s*CURRENT_JOB_ORG_ID/);
});

// ── src/scrape-handedness.js ────────────────────────────────────────────

test('scrape-handedness.js requires output-paths.js (not search-gamechanger-teams.js, preserving its standalone-require guarantee) and its debug dump routes through resolveOrgSubdir', () => {
  const source = src('src/scrape-handedness.js');
  assert.match(source, /require\(\s*['"]\.\/output-paths['"]\s*\)/);
  assert.doesNotMatch(source, /require\(\s*['"]\.\/search-gamechanger-teams['"]\s*\)/, 'must keep its independent, side-effect-free require graph');
  assert.match(source, /resolveOrgSubdir\(/);
  assert.doesNotMatch(source, /const\s+OUTPUT_DIR\s*=/);
  assert.doesNotMatch(source, /const\s+DEBUG_DIR\s*=/, 'the old flat module-level DEBUG_DIR constant must be gone');
});

test('scrape-handedness.js: captureTeamHandednessByUrl requires orgId (production path); captureTeamHandedness makes it optional but sets CURRENT_JOB_ORG_ID when supplied (legacy CLI path)', () => {
  const source = src('src/scrape-handedness.js');
  const byUrlStart = source.indexOf('async function captureTeamHandednessByUrl(');
  const byUrlBody = source.slice(byUrlStart, byUrlStart + 1200);
  assert.match(byUrlBody, /if\s*\(\s*!orgId\s*\)\s*throw/, 'captureTeamHandednessByUrl must require orgId');
  assert.match(byUrlBody, /CURRENT_JOB_ORG_ID\s*=\s*orgId/);

  const legacyStart = source.indexOf('async function captureTeamHandedness(');
  const legacyBody = source.slice(legacyStart, legacyStart + 1200);
  assert.match(legacyBody, /if\s*\(\s*orgId\s*\)\s*CURRENT_JOB_ORG_ID\s*=\s*orgId/, 'the legacy CLI path must accept an optional orgId, not require one, so its non-debug behavior is unchanged');
});

// ── src/scrape-handedness-cli.js ────────────────────────────────────────

test('scrape-handedness-cli.js requires --orgId only when --debugHtml is used, and fails closed before any browser/DB work', () => {
  const source = src('src/scrape-handedness-cli.js');
  assert.match(source, /args\.debugHtml === 'true' && !orgId/);
  const guardIndex = source.search(/args\.debugHtml === 'true' && !orgId/);
  const dbInitIndex = source.indexOf('db.init(');
  const launchIndex = source.indexOf('chromium.launch(');
  assert.ok(guardIndex < dbInitIndex, 'the --orgId guard must run before db.init()');
  assert.ok(guardIndex < launchIndex, 'the --orgId guard must run before the browser launches');
  assert.match(source, /orgId\s*[,}]/, 'orgId must be threaded into the captureTeamHandedness call');
});

// ── reingest-games.js ────────────────────────────────────────────────────

test('reingest-games.js requires output-paths.js and resolves OUTPUT_ROOT via resolveOrgOutputRoot(JOB_ORG_ID), after JOB_ORG_ID validation and before pipeline.init()', () => {
  const source = src('reingest-games.js');
  assert.match(source, /require\(\s*['"]\.\/src\/output-paths['"]\s*\)/);
  assert.match(source, /const\s+OUTPUT_ROOT\s*=\s*resolveOrgOutputRoot\(\s*JOB_ORG_ID\s*\)/);
  assert.doesNotMatch(source, /path\.join\(\s*__dirname\s*,\s*['"]output['"]\s*\)/, 'the old flat output/ root construction must be gone');

  const validateIndex = source.indexOf('isValidUuid(JOB_ORG_ID)');
  const outputRootIndex = source.indexOf('const OUTPUT_ROOT = resolveOrgOutputRoot');
  const pipelineInitIndex = source.indexOf('pipeline.init(DB_PATH)');
  assert.ok(validateIndex < outputRootIndex, 'JOB_ORG_ID must be validated before OUTPUT_ROOT is resolved');
  assert.ok(outputRootIndex < pipelineInitIndex, 'OUTPUT_ROOT must be resolved before pipeline.init()/any DB access');
});

test('reingest-games.js: findTeamFolders() enumerates only OUTPUT_ROOT (this job\'s own organization directory), never a broader or global path', () => {
  const source = src('reingest-games.js');
  const fnStart = source.indexOf('function findTeamFolders(');
  const fnEnd = source.indexOf('\n}', fnStart);
  const fnBody = source.slice(fnStart, fnEnd);
  const readdirCalls = fnBody.match(/fs\.readdirSync\(([^,)]+)/g) || [];
  const existsCalls = fnBody.match(/fs\.existsSync\(([^)]+)\)/g) || [];
  assert.ok(readdirCalls.length >= 1, 'expected at least one fs.readdirSync call in findTeamFolders');
  for (const call of [...readdirCalls, ...existsCalls]) {
    assert.match(call, /OUTPUT_ROOT/, `findTeamFolders must only ever read OUTPUT_ROOT, found: ${call}`);
  }
});

// ── src/high-school-gc-import.js ────────────────────────────────────────
// Discovered during T3H implementation: this file also calls
// search-gamechanger-teams.js#extractGameData() directly (reusing its pure
// DOM-extraction logic for the High School product, per this file's own
// header comment) and was missing from the original Phase 2 writer
// inventory. Because extractGameData()'s first line is now
// getTeamOutputDir(), which reads search-gamechanger-teams.js's
// CURRENT_JOB_ORG_ID, this caller would otherwise crash on every run once
// that module-level guard was added -- it must set that state itself, the
// same way scrape-game-urls.js does, using the same trusted,
// server-resolved org id (req._orgId, propagated as HS_IMPORT_ORG_ID) this
// file's other operations already use.

test('high-school-gc-import.js validates HS_IMPORT_ORG_ID and calls setCurrentJobOrgId before any browser/session work, failing closed (not crashing) on an invalid value', () => {
  const source = src('src/high-school-gc-import.js');
  assert.match(source, /isValidUuid\(ctx\.orgId\)/);
  assert.match(source, /scraper\.setCurrentJobOrgId\(\s*ctx\.orgId\s*\)/);

  const validateIndex = source.indexOf('isValidUuid(ctx.orgId)');
  const setIndex = source.indexOf('scraper.setCurrentJobOrgId(ctx.orgId)');
  const launchIndex = source.indexOf('chromium.launch({');
  const collectGameIndex = source.indexOf('const collectGame');
  assert.ok(validateIndex < launchIndex, 'org-id validation must happen before the browser launches');
  assert.ok(setIndex < launchIndex, 'setCurrentJobOrgId must be called before the browser launches');
  assert.ok(setIndex < collectGameIndex, 'setCurrentJobOrgId must be called before collectGame (which calls extractGameData) is ever defined/used');
});

test('high-school-gc-import.js: ctx.orgId comes from HS_IMPORT_ORG_ID (the server-resolved value), never from argv or a client-controlled field', () => {
  const source = src('src/high-school-gc-import.js');
  assert.match(source, /orgId:\s*process\.env\.HS_IMPORT_ORG_ID/);
});

test('src/high-school-import-routes.js sets HS_IMPORT_ORG_ID from the trusted, already-resolved request organization (req._orgId), not from the request body/query', () => {
  const source = src('src/high-school-import-routes.js');
  assert.match(source, /HS_IMPORT_ORG_ID:\s*req\._orgId/);
});
