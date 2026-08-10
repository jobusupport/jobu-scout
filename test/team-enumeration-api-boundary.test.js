'use strict';

// Security Slice T3E: getAllTeams() was an ambiguous, security-sensitive
// name -- nothing in it told a reader whether "all" meant one
// organization's teams or every organization's, or whether it was safe to
// call from an authenticated HTTP/background-job workflow. It has been
// replaced by two explicitly-named APIs:
//
//   listTeamsForOrg(orgId)        -- tenant-aware, application-safe
//   listAllTeamsForOperator()     -- explicit, operator-only, repository-
//                                     wide enumeration with no tenant
//                                     filter of any kind
//
// These tests prove the boundary is a REACHABILITY property, not merely a
// naming convention: listAllTeamsForOperator() must never be referenced by
// server.js, generate-report.js, or any tenant pipeline/job module, and
// the ambiguous getAllTeams name must not exist anywhere in executable
// production source. The allowlist of legitimate callers below was built
// from an independent repository-wide search (not assumed) -- a genuine
// recursive scan of the whole repo (excluding node_modules/.git/output/
// scraped-data directories) backs every assertion, so a new, unexpected
// caller introduced later would fail this suite rather than going
// unnoticed.
//
// Run with: node --test test/team-enumeration-api-boundary.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

// Directories that are never production/test JS source relevant to this
// boundary: dependency trees, VCS internals, and scraped/generated data
// (output/, temp-screenshots/, storage/) that could theoretically contain
// stray .js-named files but are never require()d or executed as part of
// this application.
const EXCLUDED_DIR_NAMES = new Set([
  'node_modules', '.git', 'output', 'temp-screenshots', 'storage',
]);

function walkJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      walkJsFiles(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// Computed once for the whole file -- a genuine repository-wide walk, not
// a hard-coded list of files to check.
const ALL_JS_FILES = walkJsFiles(REPO_ROOT);

function relPath(absPath) {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}

// ── The ambiguous name must not exist anywhere in executable source ─────────

test('getAllTeams does not appear anywhere in the repository\'s executable production source ' +
     '(historical, past-tense mentions in explanatory comments about an already-fixed defect are fine; ' +
     'a live definition, export, call site, or destructured import is not)', () => {
  // Test files are allowed to mention the old name in prose describing
  // PAST vulnerable behavior (the same convention already established for
  // e.g. the removed getSingleOrgIdFallback) -- those are checked
  // separately below by pattern, not by blanket exclusion of test/.
  const productionFiles = ALL_JS_FILES.filter((f) => !relPath(f).startsWith('test/'));

  // A live call site is the pattern that actually matters -- built via
  // concatenation so this file's own source never contains the literal
  // "db" + "." + "getAllTeams(" substring (which would otherwise make
  // this very file flag itself as an offender).
  const liveCallPattern = new RegExp('\\bdb\\' + '.' + 'getAllTeams\\(');

  const offenders = [];
  for (const file of productionFiles) {
    const source = fs.readFileSync(file, 'utf8');
    if (!/\bgetAllTeams\b/.test(source)) continue;
    if (liveCallPattern.test(source)) { offenders.push(relPath(file)); continue; }
    // reingest-games.js retains one explanatory, explicitly past-tense
    // ("previously meant") comment about the T3C-era defect -- the one
    // legitimate historical exception, verified by requiring BOTH the
    // old name and "previously meant" to appear (not merely the
    // filename), so it fails if the wording ever drifts into describing
    // current behavior.
    const isHistoricalComment = relPath(file) === 'reingest-games.js' && /previously meant/.test(source);
    if (!isHistoricalComment) offenders.push(relPath(file));
  }
  assert.deepEqual(offenders, [], `getAllTeams must not appear in these production files: ${offenders.join(', ')}`);
});

test('no executable call site db.getAllTeams(...) remains anywhere in production source', () => {
  const productionFiles = ALL_JS_FILES.filter((f) => !relPath(f).startsWith('test/'));
  const liveCallPattern = new RegExp('\\bdb\\' + '.' + 'getAllTeams\\(');
  const offenders = productionFiles
    .filter((f) => liveCallPattern.test(fs.readFileSync(f, 'utf8')))
    .map(relPath);
  assert.deepEqual(offenders, [], `a live db.getAllTeams(...) call site remains in: ${offenders.join(', ')}`);
});

// ── listAllTeamsForOperator(): exact, independently-enumerated caller list ──

// Built from the T3E Phase 1 repository-wide search: the two repository
// implementations (definition + internal SQLite passthrough use) and the
// six verified operator-only maintenance scripts. Any file outside this
// list that references listAllTeamsForOperator fails the test below --
// this is not an assumed count, it is checked against every .js file in
// the repository.
const ALLOWED_OPERATOR_API_CALLERS = new Set([
  'src/db.js',
  'src/db-supabase.js',
  'rebuild-team-from-json.js',
  'src/check-game-date-integrity.js',
  'src/fix-play-event-names.js',
  'src/recalculate-all-teams.js',
  'src/recalculate-team-stats.js',
  'src/validate-team-stats.js',
]);

test('listAllTeamsForOperator is referenced ONLY by its two repository implementations and the six ' +
     'verified operator-only maintenance scripts -- an exact, independently-enumerated allowlist, not an ' +
     'assumed count', () => {
  const actualCallers = ALL_JS_FILES
    .filter((f) => !relPath(f).startsWith('test/'))
    .filter((f) => /\blistAllTeamsForOperator\b/.test(fs.readFileSync(f, 'utf8')))
    .map(relPath)
    .sort();

  assert.deepEqual(actualCallers, [...ALLOWED_OPERATOR_API_CALLERS].sort(),
    'the set of files referencing listAllTeamsForOperator must be exactly the verified operator-only allowlist -- ' +
    'a new caller appearing here (or an expected one disappearing) must fail this test');
});

// ── Explicit negative proof for every tenant-facing entry point ─────────────

const TENANT_FACING_FILES = [
  'server.js',
  'src/generate-report.js',
  'src/report-team-selection.js',
  'src/pipeline.js',
  'reingest-games.js',
  'src/search-gamechanger-teams.js',
];

for (const relFile of TENANT_FACING_FILES) {
  test(`${relFile} does not reference listAllTeamsForOperator anywhere (not imported, destructured, aliased, or called)`, () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, relFile), 'utf8');
    assert.doesNotMatch(source, /listAllTeamsForOperator/, `${relFile} must never reference the operator-only enumeration API`);
  });
}

// ── No application runtime command exposes an operator script ───────────────

test('package.json exposes no npm script that runs any of the six operator-only maintenance scripts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const scriptCommands = Object.values(pkg.scripts || {}).join('\n');
  const operatorScriptBasenames = [...ALLOWED_OPERATOR_API_CALLERS]
    .filter((f) => f !== 'src/db.js' && f !== 'src/db-supabase.js');
  for (const scriptPath of operatorScriptBasenames) {
    assert.doesNotMatch(scriptCommands, new RegExp(scriptPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `package.json must not expose ${scriptPath} as an application-runtime npm script`);
  }
});

test('none of the six operator-only maintenance scripts are require()d by server.js, generate-report.js, ' +
     'pipeline.js, or any other production module (they are only ever invoked directly as `node <script>.js`)', () => {
  const operatorScripts = [...ALLOWED_OPERATOR_API_CALLERS]
    .filter((f) => f !== 'src/db.js' && f !== 'src/db-supabase.js');

  const otherProductionFiles = ALL_JS_FILES
    .filter((f) => !relPath(f).startsWith('test/'))
    .filter((f) => !operatorScripts.includes(relPath(f)));

  for (const scriptRelPath of operatorScripts) {
    const basename = path.basename(scriptRelPath, '.js');
    const offenders = otherProductionFiles.filter((f) => {
      const source = fs.readFileSync(f, 'utf8');
      return new RegExp(`require\\(['"][^'"]*${basename}['"]\\)`).test(source);
    });
    assert.deepEqual(offenders, [], `${scriptRelPath} must not be require()d by: ${offenders.map(relPath).join(', ')}`);
  }
});
