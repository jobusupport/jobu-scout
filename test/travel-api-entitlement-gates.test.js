'use strict';

// Database-free, always-executing tests proving every Travel-specific
// authenticated API route in server.js and the extracted job-route module is protected by the new
// requireTravelAccess guard, that no shared/High-School/admin/public route
// was accidentally gated, and that a future route added to server.js
// without an explicit classification below fails this suite loudly rather
// than silently shipping unclassified.
//
// server.js is not `require`d here -- it unconditionally calls app.listen()
// and performs other real startup side effects at module load (see
// test/product-aware-routing.test.js's own header for the same reasoning).
// These are supplemental text-level assertions against the route registrations
// themselves, the established convention this repo already uses for
// exactly this class of check (test/product-aware-routing.test.js,
// test/admin-api-product-route-wiring.test.js). Actual Express behavior is
// covered by test/travel-job-routes.test.js. Live entitlement behavior
// against a real database is covered, gated by default, in
// test/travel-api-entitlement-gates.integration.test.js -- mirroring how
// test/api-product-capabilities.test.js and
// test/high-school-api-integration.test.js already split this same concern.
//
// Run with: node --test test/travel-api-entitlement-gates.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const JOB_ROUTES_PATH = path.join(__dirname, '..', 'src', 'travel-job-routes.js');
const serverSrc = fs.readFileSync(SERVER_PATH, 'utf8');
const serverLines = serverSrc.split('\n');
const jobRoutesSrc = fs.readFileSync(JOB_ROUTES_PATH, 'utf8');
const jobRouteLines = jobRoutesSrc.split('\n');

// ── Route inventory ──────────────────────────────────────────────────────
//
// Every `app.<method>('/path', ...)` registration in server.js, found the
// same way a human review would: a plain source-level regex, not a partial
// hand-maintained list copied out of memory. If a future route is added to
// server.js and this list isn't updated, the "every found route must have a
// classification" test below fails -- that's the whole point of building
// the inventory this way instead of only asserting a fixed, easy-to-forget
// set of paths.
const ROUTE_LINE_RE = /^app\.(get|post|put|patch|delete)\((?:\[[^\]]*\]|'([^']+)')/;

function findRouteRegistrations() {
  const routes = [];
  for (const [file, lines] of [['server.js', serverLines], ['src/travel-job-routes.js', jobRouteLines]]) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(/^\s*app\.(get|post|put|patch|delete)\(/);
      if (!match) continue;
      routes.push({ line: line.trim(), file, lineNumber: i + 1, method: match[1] });
    }
  }
  return routes;
}

// Explicit classification for every route this file's own inventory scan
// finds today. Keyed by the exact registration line's method + first path
// literal it contains (a multi-path `app.get(['/a','/b'], ...)` registration
// is matched on the array literal text itself, since there are only two of
// those in this file and both are page-shell routes, not API routes).
//
// 'travel'  -- must contain requireTravelAccess.
// 'exempt'  -- must NOT contain requireTravelAccess (shared/account/session,
//              bootstrap/capability, admin-mounted, public/system, or a
//              page-shell route serving the inert HTML document only).
const CLASSIFICATION = {
  // ── Page shells -- inert HTML documents only, not gated per instruction ──
  "app.get(['/admin', '/admin/*splat']": 'exempt',
  "app.get(['/travel', '/travel/*splat', '/high-school', '/high-school/*splat']": 'exempt',
  "app.get('/'": 'exempt',

  // ── Auth / session -- shared, must remain reachable to establish identity ──
  "app.post('/api/auth/signup'": 'exempt',
  "app.post('/api/auth/login'": 'exempt',
  "app.post('/api/auth/logout'": 'exempt',
  "app.get('/api/auth/me'": 'exempt',
  "app.post('/api/auth/refresh'": 'exempt',
  "app.post('/api/auth/forgot-password'": 'exempt',
  "app.post('/api/auth/reset-password'": 'exempt',

  // ── Bootstrap / capability resolution -- must stay reachable to resolve
  // which product(s) an org has in the first place; gating it would be
  // circular ──
  "app.get('/api/product/capabilities'": 'exempt',

  // ── Billing -- shared account concern (plan/subscription/user count) for
  // every org type, not Travel-specific by itself. GET /api/billing/status
  // does mix in Travel-specific usage counters (opponentTeams,
  // scoutingReportsThisMonth, etc.) alongside genuinely shared fields
  // (plan, subscriptionStatus, maxUsers, userCount) -- see this task's own
  // audit report: gating the whole route would regress a High-School-only
  // org's ability to see its own plan/subscription, so it is deliberately
  // left ungated here as a reported, not silently resolved, design
  // conflict. create-checkout-session/create-portal-session manage the
  // org's Stripe subscription itself, unrelated to product entitlement, and
  // billing changes are explicitly out of scope for this change. ──
  "app.get('/api/billing/status'": 'exempt',
  "app.post('/api/billing/create-checkout-session'": 'exempt',
  "app.post('/api/billing/create-portal-session'": 'exempt',

  // ── Public/system -- no user JWT involved ──
  "app.post('/api/webhooks/stripe'": 'exempt',
  "app.get('/api/debug/auth'": 'exempt', // pre-existing, unrelated info-disclosure risk -- flagged in this task's report, out of scope to fix here

  // ── Travel-specific: teams, rosters, games, reports, scrape/report jobs ──
  "app.get('/api/teams'": 'travel',
  "app.get('/api/teams/:id/summary'": 'travel',
  "app.get('/api/reports'": 'travel',
  "app.get('/api/jobs/:id'": 'travel',
  "app.post('/api/jobs/:id/stream-credential'": 'travel',
  "app.get('/api/jobs/:id/stream'": 'travel',
  "app.post('/api/jobs/:id/stop'": 'travel',
  "app.post('/api/run/gc-scraper'": 'travel',
  "app.post('/api/run/pg-scraper'": 'travel',
  "app.post('/api/run/reingest'": 'travel',
  "app.post('/api/run/report'": 'travel',
  "app.post('/api/run/self-scout'": 'travel',
  "app.post('/api/run/matchup'": 'travel',
  "app.post('/api/run/full-pipeline'": 'travel',
  "app.post('/api/run/all-gc'": 'travel',
  "app.post('/api/run/all-pg'": 'travel',
  "app.post('/api/run/all-reports'": 'travel',
  "app.get('/api/teams/:id/games'": 'travel',
  "app.get('/api/teams/:id/game-urls'": 'travel',
  "app.post('/api/teams/:id/game-urls'": 'travel',
  "app.put('/api/teams/:id/game-urls/:urlId'": 'travel',
  "app.delete('/api/teams/:id/game-urls/:urlId'": 'travel',
  "app.get('/api/teams/:id/players'": 'travel',
  "app.post('/api/teams/:id/players'": 'travel',
  "app.put('/api/teams/:id/players/:playerId'": 'travel',
  "app.delete('/api/teams/:id/players/:playerId'": 'travel',
  "app.post('/api/teams/:id/players/seed-from-games'": 'travel',
  "app.post('/api/teams/add'": 'travel',
  "app.put('/api/teams/:id'": 'travel',
  "app.delete('/api/teams/:id'": 'travel',
  "app.patch('/api/teams/:id/archive'": 'travel',
  "app.post('/api/settings/sheet'": 'travel',
};

function classify(line) {
  for (const prefix of Object.keys(CLASSIFICATION)) {
    if (line.startsWith(prefix)) return CLASSIFICATION[prefix];
  }
  return null;
}

test('route inventory: every server and extracted job route has an explicit classification', () => {
  const routes = findRouteRegistrations();
  assert.ok(routes.length > 30, 'sanity check: expected to find a substantial number of route registrations');

  const unclassified = routes
    .map((r) => ({ ...r, classification: classify(r.line) }))
    .filter((r) => r.classification === null);

  assert.deepEqual(
    unclassified.map((r) => `${r.file}:${r.lineNumber}: ${r.line.slice(0, 80)}`),
    [],
    'a route was added to server.js with no explicit travel/exempt classification in this test file -- classify it above before merging'
  );
});

test('route inventory: every route classified "travel" is gated by requireTravelAccess', () => {
  const routes = findRouteRegistrations();
  const travelRoutes = routes.filter((r) => classify(r.line) === 'travel');
  assert.equal(travelRoutes.length, 32);

  const missingGate = travelRoutes.filter((r) => !r.line.includes('requireTravelAccess'));
  assert.deepEqual(
    missingGate.map((r) => `line ${r.lineNumber}: ${r.line.slice(0, 100)}`),
    [],
    'a route classified "travel" above does not actually invoke requireTravelAccess in its registration'
  );
});

test('route inventory: no route classified "exempt" invokes requireTravelAccess', () => {
  const routes = findRouteRegistrations();
  const exemptRoutes = routes.filter((r) => classify(r.line) === 'exempt');

  const wronglyGated = exemptRoutes.filter((r) => r.line.includes('requireTravelAccess'));
  assert.deepEqual(
    wronglyGated.map((r) => `line ${r.lineNumber}: ${r.line.slice(0, 100)}`),
    [],
    'a route classified "exempt" above unexpectedly invokes requireTravelAccess -- either the classification or the route is wrong'
  );
});

// ── Middleware ordering ──────────────────────────────────────────────────
//
// requireTravelAccess must run after authentication (requireAuth, or for
// the SSE stream route, requireStreamAuth) establishes req.user, and after
// resolveSupportSession (where present) has had the chance to pin req._orgId
// to the target customer -- never before either, and never skipped ahead of
// blockWriteDuringReadOnlySupport in a way that would let a write-blocked
// support session reach a mutation handler regardless of order (both are
// independent gates; either denying is sufficient), but must run BEFORE the
// actual route handler in all cases.

test('every Travel route with resolveSupportSession runs requireTravelAccess after it, not before', () => {
  const routes = findRouteRegistrations().filter((r) => classify(r.line) === 'travel');
  for (const r of routes) {
    if (!r.line.includes('resolveSupportSession')) continue;
    const supportIdx = r.line.indexOf('resolveSupportSession');
    const travelIdx = r.line.indexOf('requireTravelAccess');
    assert.ok(
      travelIdx > supportIdx,
      `line ${r.lineNumber}: requireTravelAccess must appear after resolveSupportSession: ${r.line.slice(0, 120)}`
    );
  }
});

test('every Travel mutation route runs requireTravelAccess before blockWriteDuringReadOnlySupport', () => {
  const routes = findRouteRegistrations().filter((r) => classify(r.line) === 'travel');
  for (const r of routes) {
    if (!r.line.includes('blockWriteDuringReadOnlySupport')) continue;
    const travelIdx = r.line.indexOf('requireTravelAccess');
    const blockIdx = r.line.indexOf('blockWriteDuringReadOnlySupport');
    assert.ok(travelIdx >= 0, `line ${r.lineNumber}: expected requireTravelAccess to be present`);
    assert.ok(
      travelIdx < blockIdx,
      `line ${r.lineNumber}: requireTravelAccess must appear before blockWriteDuringReadOnlySupport: ${r.line.slice(0, 140)}`
    );
  }
});

test('the SSE job-stream route resolves support after stream authentication and before Travel access', () => {
  const streamLine = jobRouteLines.find((l) => l.includes("app.get('/api/jobs/:id/stream'"));
  assert.ok(streamLine, 'expected to find the job-stream route registration');
  assert.match(streamLine, /requireStreamAuth,\s*resolveSupportSession,\s*requireTravelAccess,\s*requireJobOwnership/);

  // The old pattern made the token check conditional on the token being
  // present at all (`if (token && adminClient)`), so omitting the query
  // param entirely bypassed authentication. Confirm that shape is gone from
  // requireStreamAuth's own definition.
  const defStart = jobRoutesSrc.indexOf('function requireStreamAuth');
  assert.ok(defStart >= 0, 'expected to find requireStreamAuth\'s definition');
  const defSrc = jobRoutesSrc.slice(defStart, defStart + 600);
  assert.match(defSrc, /streamCredentials\.resolve\(req\.query\.stream_token, req\.params\.id\)/);
  assert.doesNotMatch(defSrc, /adminClient|req\.query\.(?:org|supported_org)/);
});

test('POST /api/jobs/:id/stop now requires authentication (it previously had none at all)', () => {
  const stopLine = jobRouteLines.find((l) => l.includes("app.post('/api/jobs/:id/stop'"));
  assert.ok(stopLine, 'expected to find the job-stop route registration');
  assert.match(
    stopLine,
    /requireAuth,\s*resolveSupportSession,\s*requireTravelAccess,\s*blockWriteDuringReadOnlySupport,\s*requireJobOwnership/
  );
});

test('every externally reachable job operation uses the canonical ownership guard', () => {
  for (const signature of [
    "app.get('/api/jobs/:id'",
    "app.get('/api/jobs/:id/stream'",
    "app.post('/api/jobs/:id/stop'",
  ]) {
    const line = jobRouteLines.find((candidate) => candidate.includes(signature));
    assert.ok(line, `expected to find ${signature}`);
    assert.match(line, /requireJobOwnership/);
  }
});

test('every run route binds new jobs to the authoritative request organization', () => {
  const creationLines = serverLines.filter((line) => line.includes('createJob(') && !line.includes('function createJob'));
  assert.equal(creationLines.length, 10);
  for (const line of creationLines) {
    assert.match(line, /await getRequestOrgId\(req\)/);
    assert.match(line, /req\.user\?\.id/);
    assert.doesNotMatch(line, /req\.(body|query|params|headers).*org/i);
  }
});

test('the browser requests a short-lived stream credential and never puts the Supabase access token in EventSource URLs', () => {
  const dashboardSrc = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
  const match = dashboardSrc.match(/<script type="__bundler\/template">\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(match, 'expected the bundled dashboard template');
  const template = JSON.parse(match[1]);
  assert.match(template, /POST|method: 'POST'/);
  assert.match(template, /\/stream-credential/);
  assert.match(template, /stream\?stream_token=/);
  assert.doesNotMatch(template, /stream\?token=/);
});

// ── Canonical reuse, not a competing algorithm ───────────────────────────

test('server.js imports the canonical requireProductAccess from src/product-capabilities.js', () => {
  assert.match(
    serverSrc,
    /const\s*\{\s*getOrganizationCapabilities,\s*requireProductAccess\s*\}\s*=\s*require\('\.\/src\/product-capabilities'\)/
  );
});

test('requireTravelAccess is built from requireProductAccess(\'travel\') exactly once, composed with the existing getRequestOrgId resolver -- not a reimplemented entitlement check', () => {
  assert.match(serverSrc, /const requireTravelProductAccess = requireProductAccess\('travel'\)/);

  const defStart = serverSrc.indexOf('async function requireTravelAccess');
  assert.ok(defStart >= 0, 'expected to find requireTravelAccess\'s definition');
  const defSrc = serverSrc.slice(defStart, defStart + 400);

  // Must delegate to the canonical middleware, not re-check
  // enabledProducts/capabilities itself.
  assert.match(defSrc, /getRequestOrgId\(req\)/);
  assert.match(defSrc, /requireTravelProductAccess\(req, res, next\)/);
  assert.doesNotMatch(defSrc, /enabledProducts\.includes/);
});

// ── Admin and High School routers are untouched ──────────────────────────

test('the admin router mount is unchanged (still gated entirely by requireJobuAdmin inside createAdminRouter, no requireTravelAccess involved)', () => {
  assert.match(serverSrc, /app\.use\('\/api\/admin', createAdminRouter\(\{ requireAuth \}\)\)/);
});

test('the High School router mount is unchanged, and requireTravelAccess does not appear anywhere in src/high-school-api.js', () => {
  assert.match(serverSrc, /app\.use\('\/api\/high-school', createHighSchoolRouter\(\{ requireAuth \}\)\)/);
  const hsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'high-school-api.js'), 'utf8');
  assert.doesNotMatch(hsSrc, /requireTravelAccess/);
  // Its own, separate, pre-existing canonical guard must still be present and unchanged.
  assert.match(hsSrc, /async function requireHighSchoolAccess/);
});
