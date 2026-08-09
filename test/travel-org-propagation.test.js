'use strict';

// Security Slice T2: source-level regression tests proving the trusted
// organization-propagation contract for every production-reachable
// Travel team write entry point identified in
// security/travel-tenant-isolation-write-path (Slice T1).
//
// server.js is not `require`d here -- it unconditionally calls
// app.listen() at module load (see test/travel-api-entitlement-gates.test.js's
// own header for the same, already-established reasoning in this repo).
// These are source-text assertions against the route registrations
// themselves, matching that file's convention. Live Express/propagation
// behavior for the extracted job-route module is covered by
// test/travel-job-routes.test.js; live persistence-layer behavior is
// covered by test/db-supabase-tenant-isolation.test.js and
// test/pipeline-org-context.test.js.
//
// Run with: node --test test/travel-org-propagation.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const SCRAPER_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'search-gamechanger-teams.js'), 'utf8');
const REINGEST_SRC = fs.readFileSync(path.join(__dirname, '..', 'reingest-games.js'), 'utf8');
const GENERATE_REPORT_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'generate-report.js'), 'utf8');

function extractRouteBlock(source, marker) {
  const startIdx = source.indexOf(marker);
  assert.ok(startIdx !== -1, `route marker not found in server.js: ${marker}`);
  const rest = source.slice(startIdx + marker.length);
  const nextMatch = rest.search(/\napp\.(get|post|put|patch|delete)\(/);
  const endIdx = nextMatch === -1 ? source.length : startIdx + marker.length + nextMatch;
  return source.slice(startIdx, endIdx);
}

function countOccurrences(text, pattern) {
  const matches = text.match(new RegExp(pattern, 'g'));
  return matches ? matches.length : 0;
}

const ROUTES = [
  { name: 'gc-scraper', marker: "app.post('/api/run/gc-scraper'" },
  { name: 'reingest', marker: "app.post('/api/run/reingest'" },
  { name: 'full-pipeline', marker: "app.post('/api/run/full-pipeline'" },
  { name: 'all-gc', marker: "app.post('/api/run/all-gc'" },
  // Security Slice T3D: the report-generation trigger routes.
  { name: 'report', marker: "app.post('/api/run/report'" },
  { name: 'self-scout', marker: "app.post('/api/run/self-scout'" },
  { name: 'matchup', marker: "app.post('/api/run/matchup'" },
  { name: 'all-reports', marker: "app.post('/api/run/all-reports'" },
];

for (const { name, marker } of ROUTES) {
  test(`${name} route: resolves the trusted org exactly once (into a local variable), reused for both createJob and the spawn env`, () => {
    const block = extractRouteBlock(SERVER_SRC, marker);

    const orgIdCalls = countOccurrences(block, 'getRequestOrgId\\(req\\)');
    assert.equal(orgIdCalls, 1, `${name}: expected exactly one getRequestOrgId(req) call, found ${orgIdCalls}`);

    assert.match(block, /const orgId\s*=\s*await getRequestOrgId\(req\)/, `${name}: must resolve into a local "orgId" variable`);
    // Non-greedy, single-line match -- createJob's first argument is a
    // template-literal label that may itself contain literal parentheses
    // (e.g. "All (5 teams)"), so this cannot stop at the first ")".
    assert.match(block, /createJob\(.*?,\s*orgId,/, `${name}: createJob must be called with the resolved orgId variable, not a fresh resolver call`);
    assert.match(block, /JOBU_JOB_ORG_ID:\s*orgId/, `${name}: the spawned child's env must receive JOBU_JOB_ORG_ID set to the same resolved orgId`);
  });

  test(`${name} route: never sources an organization id from request body, query, or headers`, () => {
    const block = extractRouteBlock(SERVER_SRC, marker);
    assert.doesNotMatch(block, /req\.body\.org_?[iI]d/, `${name}: must not read an org id from req.body`);
    assert.doesNotMatch(block, /req\.query\.org_?[iI]d/, `${name}: must not read an org id from req.query`);
    assert.doesNotMatch(block, /req\.headers\[.*org/i, `${name}: must not read an org id from req.headers`);
  });

  test(`${name} route: JOBU_JOB_ORG_ID (or the resolved orgId value) never appears inside an appendLog(...) call`, () => {
    const block = extractRouteBlock(SERVER_SRC, marker);
    const appendLogLines = block.split('\n').filter((line) => line.includes('appendLog('));
    for (const line of appendLogLines) {
      assert.doesNotMatch(line, /orgId|JOBU_JOB_ORG_ID/, `job-visible log line must never include the org id: "${line.trim()}"`);
    }
  });
}

test('gc-scraper and all-gc routes: the org-less src/scrape-game-urls.js branch is untouched ' +
     '(that script does not call ensureTeam/upsertTeam, per the Slice T1 call-graph trace, so it is out of scope)', () => {
  const gcScraperBlock = extractRouteBlock(SERVER_SRC, "app.post('/api/run/gc-scraper'");
  assert.match(gcScraperBlock, /spawnJob\(id, 'node', \['src\/scrape-game-urls\.js'/);
});

test('full-pipeline route: step 3 (reingest-games.js) also receives JOBU_JOB_ORG_ID', () => {
  const block = extractRouteBlock(SERVER_SRC, "app.post('/api/run/full-pipeline'");
  assert.match(block, /runStep\('node', \['reingest-games\.js', team\.team_name\], ROOT, \{ JOBU_JOB_ORG_ID: orgId \}\)/);
});

// ── Child entry points: search-gamechanger-teams.js ─────────────────────────

test('search-gamechanger-teams.js: requires job org context, and every team construction site attaches it as orgId', () => {
  assert.match(SCRAPER_SRC, /require\(["']\.\/job-org-context["']\)/);

  // Matches only an actual invocation assigned to a variable (e.g.
  // "const jobOrgId = requireJobOrgContext();"), not a prose mention of
  // the function name inside an explanatory comment.
  const jobOrgIdCalls = countOccurrences(SCRAPER_SRC, '=\\s*requireJobOrgContext\\(\\)');
  assert.equal(jobOrgIdCalls, 2, 'expected exactly one call in main() and one in scrapeTeamById()');

  // main()'s env-var branch
  assert.match(SCRAPER_SRC, /status:\s*"active",\s*\n\s*orgId:\s*jobOrgId,/);
  // scrapeTeamById()
  assert.match(SCRAPER_SRC, /status:\s*"active",\s*\n\s*orgId:\s*jobOrgId,\s*\n\s*\};/);
  // Google-Sheet path -- attached after the spread, so a spreadsheet row's
  // own field (if any) can never override the job-bound value.
  assert.match(SCRAPER_SRC, /selectTeamsToProcess\(teams\)\s*\n\s*\.map\(\(team\)\s*=>\s*\(\{\s*\.\.\.team,\s*orgId:\s*jobOrgId\s*\}\)\)/);
});

test('search-gamechanger-teams.js: requireJobOrgContext() runs before any browser/database acquisition in main() and scrapeTeamById()', () => {
  const mainIdx = SCRAPER_SRC.indexOf('async function main()');
  const mainBody = SCRAPER_SRC.slice(mainIdx, SCRAPER_SRC.indexOf('async function scrapeTeamById'));
  const orgCheckIdx = mainBody.indexOf('requireJobOrgContext()');
  const browserLaunchIdx = mainBody.indexOf('chromium.launch(');
  const pipelineInitIdx = mainBody.indexOf('pipeline.init(');
  assert.ok(orgCheckIdx !== -1 && browserLaunchIdx !== -1 && pipelineInitIdx !== -1);
  assert.ok(orgCheckIdx < browserLaunchIdx, 'org context must be checked before the browser is launched');
  assert.ok(orgCheckIdx < pipelineInitIdx, 'org context must be checked before the pipeline/database is initialized');

  const scrapeByIdIdx = SCRAPER_SRC.indexOf('async function scrapeTeamById');
  const scrapeByIdBody = SCRAPER_SRC.slice(scrapeByIdIdx, SCRAPER_SRC.indexOf('// ── Exports'));
  const scrapeOrgCheckIdx = scrapeByIdBody.indexOf('requireJobOrgContext()');
  const scrapeBrowserIdx = scrapeByIdBody.indexOf('chromium.launch(');
  assert.ok(scrapeOrgCheckIdx !== -1 && scrapeBrowserIdx !== -1);
  assert.ok(scrapeOrgCheckIdx < scrapeBrowserIdx, 'org context must be checked before the browser is launched in scrapeTeamById');
});

test('search-gamechanger-teams.js: the job org id value is never interpolated into a console.log/console.error call', () => {
  const loggingLines = SCRAPER_SRC.split('\n').filter((l) => /console\.(log|error)\(/.test(l));
  for (const line of loggingLines) {
    assert.doesNotMatch(line, /\$\{jobOrgId\}/, `console output must never include the org id value: "${line.trim()}"`);
  }
});

// ── Child entry point: reingest-games.js ─────────────────────────────────────

test('reingest-games.js: requires job org context before pipeline.init(), and attaches it to the direct db.upsertTeam call', () => {
  assert.match(REINGEST_SRC, /require\(['"]\.\/src\/job-org-context['"]\)/);
  assert.match(REINGEST_SRC, /const JOB_ORG_ID = requireJobOrgContext\(\)/);

  const orgCheckIdx = REINGEST_SRC.indexOf('requireJobOrgContext()');
  const pipelineInitIdx = REINGEST_SRC.indexOf('pipeline.init(DB_PATH)');
  assert.ok(orgCheckIdx !== -1 && pipelineInitIdx !== -1);
  assert.ok(orgCheckIdx < pipelineInitIdx, 'org context must be resolved before pipeline.init()');

  assert.match(REINGEST_SRC, /db\.upsertTeam\(\{\s*teamName:\s*folderName,\s*orgId:\s*JOB_ORG_ID\s*\}\)/);
});

test('reingest-games.js: the job org id value is never interpolated into a console.log/console.error call', () => {
  const loggingLines = REINGEST_SRC.split('\n').filter((l) => /console\.(log|error)\(/.test(l));
  for (const line of loggingLines) {
    assert.doesNotMatch(line, /\$\{JOB_ORG_ID\}/, `console output must never include the org id value: "${line.trim()}"`);
  }
});

// ── Security Slice T3C: team discovery is scoped to JOBU_JOB_ORG_ID ─────────
//
// reingest-games.js previously resolved "does a team row for this scraped
// folder already exist?" (and, in its final summary, "what teams now exist
// after this run?") via db.getAllTeams() -- a completely unscoped query
// across every organization. A folder name colliding with another
// organization's team name could therefore match, and silently attach new
// game data to, that other organization's team row; the final summary
// separately logged every organization's team names/ids/game counts to
// this job's own (customer-visible) output. These tests prove both call
// sites now use the tenant-scoped src/db-supabase.js#listTeamsForOrg
// instead, that the unscoped getAllTeams() is gone from this file
// entirely, and that the job's own org-id contract is validated (not just
// "present") before any team query runs.

test('reingest-games.js: db.getAllTeams() is no longer called anywhere in this file', () => {
  assert.doesNotMatch(REINGEST_SRC, /db\.getAllTeams\(/, 'the unscoped global team query must not remain');
});

test('reingest-games.js: both team-discovery call sites use the tenant-scoped db.listTeamsForOrg(JOB_ORG_ID)', () => {
  const calls = REINGEST_SRC.match(/db\.listTeamsForOrg\(JOB_ORG_ID\)/g) || [];
  assert.equal(calls.length, 2, 'expected exactly two scoped calls: the per-folder lookup and the final summary');
});

test('reingest-games.js: JOBU_JOB_ORG_ID is validated against a UUID contract before pipeline.init() or any team query', () => {
  assert.match(REINGEST_SRC, /require\(['"]\.\/src\/report-access['"]\)/, 'must reuse the existing isValidUuid helper, not a new ad-hoc regex');
  assert.match(REINGEST_SRC, /if\s*\(!isValidUuid\(JOB_ORG_ID\)\)/);

  const jobOrgIdAssignIdx = REINGEST_SRC.indexOf('const JOB_ORG_ID = requireJobOrgContext()');
  const uuidCheckIdx = REINGEST_SRC.indexOf('if (!isValidUuid(JOB_ORG_ID))');
  const pipelineInitIdx = REINGEST_SRC.indexOf('pipeline.init(DB_PATH)');
  const firstListTeamsIdx = REINGEST_SRC.indexOf('db.listTeamsForOrg(JOB_ORG_ID)');

  assert.ok(jobOrgIdAssignIdx !== -1 && uuidCheckIdx !== -1 && pipelineInitIdx !== -1 && firstListTeamsIdx !== -1);
  assert.ok(jobOrgIdAssignIdx < uuidCheckIdx, 'the raw env value must be resolved before its format is validated');
  assert.ok(uuidCheckIdx < pipelineInitIdx, 'format validation must happen before pipeline/database init');
  assert.ok(uuidCheckIdx < firstListTeamsIdx, 'format validation must happen before any team query');
});

test('reingest-games.js: a malformed JOBU_JOB_ORG_ID fails closed (exits) rather than proceeding with an unscoped or empty filter', () => {
  const uuidCheckIdx = REINGEST_SRC.indexOf('if (!isValidUuid(JOB_ORG_ID))');
  const nextExitIdx = REINGEST_SRC.indexOf('process.exit(1)', uuidCheckIdx);
  assert.ok(uuidCheckIdx !== -1 && nextExitIdx !== -1 && nextExitIdx - uuidCheckIdx < 200,
    'the malformed-org-id branch must exit(1) immediately, not fall through');
});

test('reingest-games.js: no GameChanger URL field is ever emitted in a console.log/console.error call', () => {
  const loggingLines = REINGEST_SRC.split('\n').filter((l) => /console\.(log|error)\(/.test(l));
  for (const line of loggingLines) {
    assert.doesNotMatch(line, /gc_team_url|gcTeamUrl|pg_team_url|pgTeamUrl/i, `log line must never include a scraper URL field: "${line.trim()}"`);
  }
});

test('reingest-games.js: logged team identity fields (id/name) only ever come from the org-scoped result set, ' +
     'never from a freshly-fetched, independently-scoped query', () => {
  // Every place this file logs a team's id/name reads from a local variable
  // ("team" or "t") that was itself produced by db.listTeamsForOrg(JOB_ORG_ID)
  // or db.upsertTeam({ ..., orgId: JOB_ORG_ID }) above -- proven by the two
  // tests above. This test guards against a future regression reintroducing
  // a second, differently-scoped lookup purely for logging purposes.
  const loggingLines = REINGEST_SRC.split('\n').filter((l) => /console\.(log|error)\(/.test(l) && /team_name|team\.id|t\.id/.test(l));
  assert.ok(loggingLines.length > 0, 'sanity check: this file does log team identity somewhere');
  for (const line of loggingLines) {
    assert.doesNotMatch(line, /getAllTeams|getTeamByUrl\(/, `team-identity log line must not read from an unscoped/independent lookup: "${line.trim()}"`);
  }
});

test('reingest-games.js: team matching and summary formatting are delegated to the REAL, ' +
     'independently-tested src/reingest-helpers.js -- not an inline duplicate predicate or template ' +
     '(see test/db-supabase-tenant-isolation.test.js for the executable proof of their behavior)', () => {
  assert.match(REINGEST_SRC, /require\(['"]\.\/src\/reingest-helpers['"]\)/, 'must import the extracted helpers module');
  assert.match(REINGEST_SRC, /findMatchingTeam\s*,\s*formatTeamSummaryLine/, 'must destructure both helpers from that module');

  assert.match(REINGEST_SRC, /findMatchingTeam\(existingTeams,\s*folderName\)/, 'ingestTeamFolder must call the real matcher, not an inline .find(...)');
  assert.match(REINGEST_SRC, /console\.log\(formatTeamSummaryLine\(t,\s*bundle\.meta\.gamesAnalyzed\)\)/, 'the final summary loop must call the real formatter, not an inline template literal');

  // No inline reimplementation of either helper's logic may remain in this
  // file -- the team-name substring-matching predicate and the "[id] name
  // — N game(s)" template literal must live only in src/reingest-helpers.js.
  // (findTeamFolders' own, unrelated folder-name filter also legitimately
  // uses .toLowerCase().includes() -- this checks specifically for the
  // removed team_name-matching expression, not that pattern in general.)
  assert.doesNotMatch(REINGEST_SRC, /existingTeams\.find\(/, 'the matching predicate must not be duplicated inline via existingTeams.find(...) in reingest-games.js');
  assert.doesNotMatch(REINGEST_SRC, /t\.team_name\.toLowerCase\(\)\.includes\(/, 'the team_name matching predicate must not be duplicated inline in reingest-games.js');
  assert.doesNotMatch(REINGEST_SRC, /`\s*\[\$\{t\.id\}\]/, 'the summary-line template must not be duplicated inline in reingest-games.js');
});

// ── Security Slice T3D: generate-report.js team resolution is scoped ────────
//
// generate-report.js previously resolved a coach-supplied team name/id
// (findTeam), listed every team (listTeams/--list), and iterated every
// team (--all) via the completely unscoped db.getAllTeams() -- a report
// job for one organization could select, enumerate, or generate a report
// for another organization's team. These tests prove all three call sites
// now use the tenant-scoped src/db.js#listTeamsForOrg instead, that the
// unscoped getAllTeams() is gone from this file entirely, that the job's
// own JOBU_JOB_ORG_ID contract is validated (not just "present") before
// any database access, and that every HTTP/background route that spawns
// this script propagates JOBU_JOB_ORG_ID into its environment.

test('generate-report.js: db.getAllTeams() is no longer called anywhere in this file', () => {
  assert.doesNotMatch(GENERATE_REPORT_SRC, /db\.getAllTeams\(/, 'the unscoped global team query must not remain');
});

test('generate-report.js: all three team-discovery call sites (listTeams, findTeam, --all) use the ' +
     'tenant-scoped db.listTeamsForOrg(JOB_ORG_ID)', () => {
  const calls = GENERATE_REPORT_SRC.match(/db\.listTeamsForOrg\(JOB_ORG_ID\)/g) || [];
  assert.equal(calls.length, 3, 'expected exactly three scoped calls: listTeams, findTeam, and the --all branch');
});

test('generate-report.js: requires job org context and validates it against the established UUID ' +
     'contract before db.init() or any team query', () => {
  assert.match(GENERATE_REPORT_SRC, /require\(['"]\.\/job-org-context['"]\)/, 'must reuse the shared job-org-context contract, not a new ad-hoc env read');
  assert.match(GENERATE_REPORT_SRC, /const JOB_ORG_ID = requireJobOrgContext\(\)/);
  assert.match(GENERATE_REPORT_SRC, /require\(['"]\.\/report-access['"]\)/, 'must reuse the existing isValidUuid helper, not a new ad-hoc regex');
  assert.match(GENERATE_REPORT_SRC, /if\s*\(!isValidUuid\(JOB_ORG_ID\)\)/);

  const jobOrgIdAssignIdx = GENERATE_REPORT_SRC.indexOf('const JOB_ORG_ID = requireJobOrgContext()');
  const uuidCheckIdx = GENERATE_REPORT_SRC.indexOf('if (!isValidUuid(JOB_ORG_ID))');
  const dbInitIdx = GENERATE_REPORT_SRC.indexOf('db.init(DB_PATH)');
  const firstListTeamsIdx = GENERATE_REPORT_SRC.indexOf('db.listTeamsForOrg(JOB_ORG_ID)');

  assert.ok(jobOrgIdAssignIdx !== -1 && uuidCheckIdx !== -1 && dbInitIdx !== -1 && firstListTeamsIdx !== -1);
  assert.ok(jobOrgIdAssignIdx < uuidCheckIdx, 'the raw env value must be resolved before its format is validated');
  assert.ok(uuidCheckIdx < dbInitIdx, 'format validation must happen before db.init()');
  assert.ok(uuidCheckIdx < firstListTeamsIdx, 'format validation must happen before any team query');
});

test('generate-report.js: a malformed JOBU_JOB_ORG_ID fails closed (exits) rather than proceeding with ' +
     'an unscoped or empty filter', () => {
  const uuidCheckIdx = GENERATE_REPORT_SRC.indexOf('if (!isValidUuid(JOB_ORG_ID))');
  const nextExitIdx = GENERATE_REPORT_SRC.indexOf('process.exit(1)', uuidCheckIdx);
  assert.ok(uuidCheckIdx !== -1 && nextExitIdx !== -1 && nextExitIdx - uuidCheckIdx < 200,
    'the malformed-org-id branch must exit(1) immediately, not fall through');
});

test('generate-report.js: team matching and list/ambiguity formatting are delegated to the REAL, ' +
     'independently-tested src/report-team-selection.js -- not an inline duplicate predicate or template ' +
     '(see test/report-team-selection.test.js and test/db-supabase-tenant-isolation.test.js for the ' +
     'executable proof of their behavior)', () => {
  assert.match(GENERATE_REPORT_SRC, /require\(['"]\.\/report-team-selection['"]\)/, 'must import the extracted helpers module');
  assert.match(GENERATE_REPORT_SRC, /resolveTeamMatch\s*,\s*formatTeamListLine\s*,\s*formatAmbiguousMatchLine/, 'must destructure all three helpers from that module');

  assert.match(GENERATE_REPORT_SRC, /resolveTeamMatch\(teams,\s*nameFragment\)/, 'findTeam must call the real matcher, not an inline .find(...)/.filter(...)');
  assert.match(GENERATE_REPORT_SRC, /console\.log\(formatTeamListLine\(t,\s*games\)\)/, 'listTeams must call the real list-line formatter, not an inline template literal');
  assert.match(GENERATE_REPORT_SRC, /console\.log\(formatAmbiguousMatchLine\(m\)\)/, 'the ambiguous-match loop must call the real formatter, not an inline template literal');

  // No inline reimplementation of the matching predicate may remain --
  // the exact-id/exact-name/partial-name logic must live only in
  // src/report-team-selection.js.
  assert.doesNotMatch(GENERATE_REPORT_SRC, /teams\.find\(t\s*=>\s*normalize/, 'the id-matching predicate must not be duplicated inline in generate-report.js');
  assert.doesNotMatch(GENERATE_REPORT_SRC, /teams\.filter\(t\s*=>/, 'the exact/partial-name matching predicate must not be duplicated inline in generate-report.js');
});

test('generate-report.js: the job org id value is never interpolated into a console.log/console.error call', () => {
  const loggingLines = GENERATE_REPORT_SRC.split('\n').filter((l) => /console\.(log|error|warn)\(/.test(l));
  for (const line of loggingLines) {
    assert.doesNotMatch(line, /\$\{JOB_ORG_ID\}/, `console output must never include the org id value: "${line.trim()}"`);
  }
});

test('server.js: every route that spawns src/generate-report.js propagates JOBU_JOB_ORG_ID into its ' +
     'environment (report, self-scout, matchup, full-pipeline step 4, all-reports)', () => {
  // Matches only an actual spawnJob/runStep argument array literal (e.g.
  // ['src/generate-report.js', ...]), not a prose comment mentioning the
  // filename.
  const spawnLines = SERVER_SRC.split('\n').filter((l) => /\[['"]src\/generate-report\.js['"]/.test(l));
  assert.equal(spawnLines.length, 5, `expected exactly 5 generate-report.js spawn sites, found ${spawnLines.length}`);

  // Each spawn call's env argument is built on the line(s) immediately
  // above it (env / reportEnv) -- checked directly against the known
  // route blocks rather than by proximity heuristics, since two spawn
  // sites (full-pipeline, all-reports) build their env expression across
  // more than one statement.
  const reportBlock      = extractRouteBlock(SERVER_SRC, "app.post('/api/run/report'");
  const selfScoutBlock   = extractRouteBlock(SERVER_SRC, "app.post('/api/run/self-scout'");
  const matchupBlock     = extractRouteBlock(SERVER_SRC, "app.post('/api/run/matchup'");
  const fullPipelineBlock = extractRouteBlock(SERVER_SRC, "app.post('/api/run/full-pipeline'");
  const allReportsBlock  = extractRouteBlock(SERVER_SRC, "app.post('/api/run/all-reports'");

  for (const [label, block] of [
    ['report', reportBlock],
    ['self-scout', selfScoutBlock],
    ['matchup', matchupBlock],
    ['full-pipeline', fullPipelineBlock],
    ['all-reports', allReportsBlock],
  ]) {
    assert.match(block, /JOBU_JOB_ORG_ID:\s*orgId/, `${label}: env passed to generate-report.js must include JOBU_JOB_ORG_ID: orgId`);
    assert.match(block, /\[['"]src\/generate-report\.js['"]/, `${label}: sanity check -- this block must actually spawn generate-report.js`);
  }

  // full-pipeline and all-reports build their env in a separate statement
  // from the spawn call itself (reportEnv / the inline object literal) --
  // pin those two down precisely so a future edit can't silently detach
  // the JOBU_JOB_ORG_ID-bearing env from the generate-report.js spawn.
  assert.match(fullPipelineBlock, /JOBU_JOB_ORG_ID:\s*orgId\s*\};\s*\r?\n\s*await runStep\('node', \['src\/generate-report\.js'/, 'full-pipeline step 4: reportEnv (with JOBU_JOB_ORG_ID) must be the object passed to the generate-report.js runStep call');
  assert.match(allReportsBlock, /runStep\('node', \['src\/generate-report\.js', team\.team_name\], ROOT, \{ \.\.\.buildUsageEnv\(req, quota\), JOBU_JOB_ORG_ID: orgId \}\)/, 'all-reports route');
});

test('server.js: --all is never passed to generate-report.js from any HTTP/background route -- ' +
     '"all teams for this organization" is expressed by looping getTeams(req) (already org-scoped) and ' +
     'calling generate-report.js once per team, never by an org-less --all invocation', () => {
  const generateReportInvocations = SERVER_SRC.match(/\[['"]src\/generate-report\.js['"][^\]]*\]/g) || [];
  assert.ok(generateReportInvocations.length > 0, 'sanity check: this file does spawn generate-report.js somewhere');
  for (const invocation of generateReportInvocations) {
    assert.doesNotMatch(invocation, /--all|-a['"]/, `generate-report.js must never be invoked with --all from server.js: "${invocation}"`);
  }
});
