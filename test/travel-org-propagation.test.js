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
