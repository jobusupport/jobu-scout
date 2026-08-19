'use strict';

// Production-shaped HS Slice 2D proof: registered route -> REAL schedule
// extractor -> offline DOM fixture -> real collector adapter -> real service ->
// real repository -> real persist_hs_engine_collection on a disposable local
// stack.
//
// `discoverScheduleEntries` is deliberately NOT an array-returning stub here:
// it is wired to src/search-gamechanger-teams.js#getVisibleScheduleEntries
// running against sanitized HTML in a real Chromium page. Only two things are
// mocked, both genuinely external boundaries:
//
//   * browser transport -- page.route() serves the fixture instead of fetching
//     web.gc.com (and test/helpers/gc-network-guard.js aborts gc.com anyway);
//   * collectGame -- the per-game box score/play-by-play scrape, which is a
//     separate DOM contract already exercised by the own-team importer. The
//     seam under proof in this file is schedule DISCOVERY.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');

// Must be set before src/search-gamechanger-teams.js is required; points at a
// synthetic file that does not exist, so no session is ever resolved.
process.env.GC_AUTH_FILE_PATH = path.join(__dirname, 'this-fixture-does-not-exist-synthetic.json');

const localUrl = process.env.HS_LOCAL_SUPABASE_URL || '';
const explicitlyEnabled = process.env.RUN_HS_ENGINE_LOCAL_DB_TESTS === '1';
const loopbackOnly = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/i.test(localUrl);
const hasLocalKeys = !!process.env.HS_LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const hasLocalPostgres = process.env.HS_LOCAL_PG_HOST === '127.0.0.1'
  && /^\d{1,5}$/.test(process.env.HS_LOCAL_PG_PORT || '')
  && !!process.env.HS_LOCAL_PG_DATABASE && !!process.env.HS_LOCAL_PG_USER && !!process.env.HS_LOCAL_PG_PASSWORD;
const canRun = explicitlyEnabled && loopbackOnly && hasLocalKeys && hasLocalPostgres;
const skip = canRun ? false : 'requires an explicitly enabled disposable loopback-only Supabase stack and local postgres fixture connection';

const fixtures = require('./fixtures/gc-schedule-fixtures');

let chromium;
let scraper;
let browser;
let db;
let admin;
let importService;
let registerHighSchoolImportRoutes;
let asyncHandler;
let runOpponentImportCollection;
let toOpponentScheduleEntry;
let SCHEDULE_EXTRACTION_MODES;
let A;
let B;

if (canRun) {
  ({ chromium } = require('playwright'));
  scraper = require('../src/search-gamechanger-teams');
  ({ SCHEDULE_EXTRACTION_MODES } = scraper);
  const { createClient } = require('@supabase/supabase-js');
  const { Pool } = require('pg');
  ({ registerHighSchoolImportRoutes } = require('../src/high-school-import-routes'));
  ({ asyncHandler } = require('../src/express-helpers'));
  ({ runOpponentImportCollection, toOpponentScheduleEntry } = require('../src/high-school-opponent-gc-import'));
  const { createHighSchoolImportRepository } = require('../src/high-school-import-repository');
  const { createHighSchoolImportService } = require('../src/high-school-import-service');
  admin = createClient(localUrl, process.env.HS_LOCAL_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  db = new Pool({
    host: process.env.HS_LOCAL_PG_HOST, port: Number(process.env.HS_LOCAL_PG_PORT),
    database: process.env.HS_LOCAL_PG_DATABASE, user: process.env.HS_LOCAL_PG_USER,
    password: process.env.HS_LOCAL_PG_PASSWORD, max: 4,
  });
  importService = createHighSchoolImportService({ repository: createHighSchoolImportRepository(admin) });
}

const fixtureTables = new Set([
  'organizations', 'hs_programs', 'hs_seasons', 'hs_opponent_programs', 'hs_opponent_teams',
  'hs_source_teams', 'hs_source_team_contexts', 'hs_opponent_source_links',
]);

async function ins(table, values) {
  assert.ok(fixtureTables.has(table), `fixture table not allowlisted: ${table}`);
  const cols = Object.keys(values);
  const r = await db.query(
    `insert into public.${table} (${cols.map((c) => `"${c}"`).join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning *`,
    Object.values(values));
  return r.rows[0];
}

async function buildTenant(label, { linkStatus = 'linked' } = {}) {
  const s = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const org = await ins('organizations', {
    name: `disc ${s}`, slug: `disc-${s}`, customer_type: 'high_school',
    primary_product: 'high_school', enabled_products: ['high_school'],
  });
  const program = await ins('hs_programs', { org_id: org.id, name: `P ${s}` });
  const season = await ins('hs_seasons', { org_id: org.id, program_id: program.id, name: `S ${s}`, school_year: '2025-2026' });
  const oppProgram = await ins('hs_opponent_programs', { org_id: org.id, program_id: program.id, name: `Opp ${s}` });
  const oppTeam = await ins('hs_opponent_teams', {
    org_id: org.id, program_id: program.id, opponent_program_id: oppProgram.id,
    season_id: season.id, level: 'varsity', display_name: `Opp ${s} Varsity`,
  });
  const sourceTeam = await ins('hs_source_teams', {
    org_id: org.id, source_provider: 'gamechanger', source_team_ref: `src-${s}`,
    source_team_url: `https://web.gc.com/teams/opponent-high`,
  });
  await ins('hs_source_team_contexts', { org_id: org.id, source_team_id: sourceTeam.id, hs_season_id: season.id });
  await ins('hs_opponent_source_links', {
    org_id: org.id, program_id: program.id, opponent_team_id: oppTeam.id,
    season_id: season.id, source_team_id: sourceTeam.id, status: linkStatus,
  });
  return { s, orgId: org.id, programId: program.id, seasonId: season.id, opponentTeamId: oppTeam.id, sourceTeamId: sourceTeam.id };
}

// Serves the fixture in place of the real schedule page. No navigation to
// web.gc.com ever completes: every other request is aborted.
async function withFixturePage(html, fn) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('**/*', (route) => (route.request().url().includes('__fixture__')
    ? route.fulfill({ status: 200, contentType: 'text/html', body: html })
    : route.abort()));
  try {
    await page.goto('https://web.gc.com/__fixture__/schedule');
    return await fn(page);
  } finally {
    await context.close();
  }
}

function boxScoreFor(entry) {
  return {
    meta: {
      gameDate: entry.gameDate, homeTeam: 'Opponent High', awayTeam: entry.counterpartyName || 'Third Party High',
      ourSide: 'home',
    },
    boxScore: {
      batting: [
        { Player: 'Opp Batter', TeamSide: 'home', playerId: 'opp-b1' },
        { Player: 'Third Batter', TeamSide: 'away', playerId: 'third-b1' },
      ],
      pitching: [],
    },
    plays: [{ inning: 'Bottom 1', batterId: 'opp-b1', text: 'Single. Opp Batter singles to left field, Third Pitcher pitching.' }],
  };
}

function buildApp(tenant, { html, collectImpl } = {}) {
  const app = express();
  app.use(express.json());
  const jobs = {};
  const trace = [];
  app.locals.highSchoolImportService = importService;

  const router = express.Router();
  registerHighSchoolImportRoutes(router, {
    adminClient: admin,
    requireAuth: (req, res, next) => {
      const token = req.get('authorization')?.replace(/^Bearer /, '');
      if (token === `token-${tenant.orgId}`) { req.user = { id: '12121212-1212-4212-8212-121212121212' }; return next(); }
      return res.status(401).json({ error: 'unauthorized' });
    },
    resolveSupportSession: (req, res, next) => next(),
    requireHighSchoolAccess: (req, res, next) => { req._orgId = tenant.orgId; return next(); },
    blockWriteDuringReadOnlySupport: (req, res, next) => next(),
    asyncHandler,
    jobs,
    appendLog: () => {},
    finishJob: () => {},
    attachJobProcess: () => {},
    stopJobProcess: () => {},
    importService,
    spawn: () => { throw new Error('this proof must never spawn a real collector process'); },
    dispatchOpponentCollection: async ({ ctx }) => {
      const summary = await withFixturePage(html, async (page) => runOpponentImportCollection({
        ctx,
        importService,
        // THE REAL EXTRACTOR, against the real DOM in the fixture page.
        discoverScheduleEntries: async () => {
          const rows = await scraper.getVisibleScheduleEntries(page, {
            mode: SCHEDULE_EXTRACTION_MODES.ALL_SCHEDULE_ENTRIES,
          });
          trace.push(['extracted', rows.map((r) => `${r.gameId}:${r.status}`).join(',')]);
          return rows.map(toOpponentScheduleEntry);
        },
        collectGame: collectImpl || (async (entry) => { trace.push(['collect', entry.sourceGameRef]); return boxScoreFor(entry); }),
        isCancelled: () => false,
        isKillSwitchTriggered: () => false,
        sleep: async () => {},
        onProgress: (e) => trace.push(['progress', e.type]),
      }));
      app.locals.lastSummary = summary;
      return summary;
    },
  });
  app.use('/api/high-school', router);
  app.locals.trace = trace;
  return app;
}

function listen(app) {
  const server = app.listen(0);
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

async function startRun(app, tenant, { opponentTeamId } = {}) {
  const { url, close } = listen(app);
  try {
    const res = await fetch(`${url}/api/high-school/opponents/${opponentTeamId || tenant.opponentTeamId}/seasons/${tenant.seasonId}/import-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer token-${tenant.orgId}` },
      body: '{}',
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    await close();
  }
}

test.before(async () => {
  if (!canRun) return;
  assert.ok(loopbackOnly, 'this proof must target loopback');
  browser = await chromium.launch({ headless: true });
  A = await buildTenant('a');
  B = await buildTenant('b');
});

test.after(async () => {
  if (!canRun) return;
  if (browser) await browser.close();
  await db.end();
});

// ── Proof 1: future-only schedule, end to end ──────────────────────────

test('a future row with no score badge flows from the real extractor through the route to a schedule-only publication', { skip }, async () => {
  // 1. the fixture genuinely contains no score badge
  assert.equal(/\b[WL]\s*\d+\s*[-–—]\s*\d+\b/.test(fixtures.futureOnly), false);

  const tenant = await buildTenant('future');
  const app = buildApp(tenant, { html: fixtures.futureOnly });
  const res = await startRun(app, tenant);
  assert.equal(res.status, 201, JSON.stringify(res.body));

  // 2. the real extractor returned the row, and 3. the route received it
  const extracted = app.locals.trace.find(([kind]) => kind === 'extracted');
  assert.ok(extracted, 'the real extractor ran inside the production call graph');
  assert.equal(extracted[1], 'g-future-1:scheduled');
  assert.equal(app.locals.trace.some(([kind]) => kind === 'collect'), false,
    'an unplayed game is never sent for box-score capture, so it cannot fail as a missing box score');

  const summary = app.locals.lastSummary;
  assert.equal(summary.state, 'published_schedule_only');
  assert.equal(summary.scheduleCaptured, true);
  assert.equal(summary.eligibleForVerifiedPublication, false);
  assert.equal(summary.verifiedGenerationPublished, false);

  // 4. persisted as schedule knowledge
  const games = await db.query(
    'select source_game_ref, game_status, game_date from public.hs_opponent_games where opponent_team_id = $1',
    [tenant.opponentTeamId]);
  assert.equal(games.rowCount, 1);
  assert.equal(games.rows[0].source_game_ref, 'g-future-1');
  assert.equal(games.rows[0].game_status, 'scheduled');
  assert.equal(games.rows[0].game_date.toISOString().slice(0, 10), '2026-05-01');

  // 5 & 6. not verified statistics; the RPC derived the state
  const generation = await db.query(
    `select publication_state, final_game_count, official_totals_complete
       from public.hs_opponent_stat_generations where id = $1`, [summary.generationId]);
  assert.equal(generation.rows[0].publication_state, 'schedule_only');
  assert.equal(generation.rows[0].final_game_count, 0);
  assert.equal(generation.rows[0].official_totals_complete, false);
  const totals = await db.query(
    'select games, validated_games from public.hs_opponent_verified_totals where generation_id = $1', [summary.generationId]);
  assert.equal(totals.rows[0].validated_games, 0, 'a future game contributes nothing to totals');

  // 7. replaying the same fixture is idempotent
  const replayApp = buildApp(tenant, { html: fixtures.futureOnly });
  await startRun(replayApp, tenant);
  assert.equal(replayApp.locals.lastSummary.generationId, summary.generationId);
  const generations = await db.query(
    'select count(*)::int c from public.hs_opponent_stat_generations where opponent_team_id = $1', [tenant.opponentTeamId]);
  assert.equal(generations.rows[0].c, 1);
});

// ── Proof 2: mixed schedule, end to end ────────────────────────────────

test('a mixed schedule publishes verified statistics while retaining the future game', { skip }, async () => {
  const tenant = await buildTenant('mixed');
  const app = buildApp(tenant, { html: fixtures.mixedSchedule });
  const res = await startRun(app, tenant);
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const extracted = app.locals.trace.find(([kind]) => kind === 'extracted')[1];
  assert.ok(extracted.includes('g-final-1:final'), 'the played game was extracted');
  assert.ok(extracted.includes('g-future-1:scheduled'), 'the unplayed game was extracted');
  const collected = app.locals.trace.filter(([kind]) => kind === 'collect').map(([, id]) => id);
  assert.deepEqual(collected, ['g-final-1'], 'only the completed game is captured');

  const summary = app.locals.lastSummary;
  assert.equal(summary.state, 'published_verified');
  assert.equal(summary.finalGameCount, 1);

  const generation = await db.query(
    'select publication_state, final_game_count, observation_count from public.hs_opponent_stat_generations where id = $1',
    [summary.generationId]);
  assert.equal(generation.rows[0].publication_state, 'verified');
  assert.equal(generation.rows[0].final_game_count, 1);
  assert.equal(generation.rows[0].observation_count, 2, 'the future game is still an observation');

  const games = await db.query(
    `select source_game_ref, game_status from public.hs_opponent_games
      where opponent_team_id = $1 order by source_game_ref`, [tenant.opponentTeamId]);
  assert.deepEqual(games.rows.map((r) => [r.source_game_ref, r.game_status]),
    [['g-final-1', 'final'], ['g-future-1', 'scheduled']]);

  const excluded = await db.query(
    `select source_game_ref, excluded_from_official_totals from public.hs_opponent_import_run_games
      where org_id = $1 order by source_game_ref`, [tenant.orgId]);
  assert.equal(excluded.rows.find((r) => r.source_game_ref === 'g-future-1').excluded_from_official_totals, true);
  assert.equal(excluded.rows.find((r) => r.source_game_ref === 'g-final-1').excluded_from_official_totals, false);

  const replayApp = buildApp(tenant, { html: fixtures.mixedSchedule });
  await startRun(replayApp, tenant);
  assert.equal(replayApp.locals.lastSummary.generationId, summary.generationId, 'unchanged replay is idempotent');
});

test('DOM row order does not change the published generation', { skip }, async () => {
  const tenant = await buildTenant('order');
  const forwards = buildApp(tenant, { html: fixtures.mixedSchedule });
  await startRun(forwards, tenant);
  const reordered = buildApp(tenant, { html: fixtures.mixedScheduleReordered });
  await startRun(reordered, tenant);
  assert.equal(reordered.locals.lastSummary.generationId, forwards.locals.lastSummary.generationId,
    'row order is provenance; it must not mint a new generation');
});

// ── Non-final states from the real extractor ───────────────────────────

for (const [label, html, expectedStatus] of [
  ['postponed', () => fixtures.postponed, 'postponed'],
  ['cancelled', () => fixtures.cancelled, 'cancelled'],
  ['unknown', () => fixtures.unknownStatus, 'unknown'],
]) {
  test(`a ${label} row is retained as non-statistical schedule knowledge`, { skip }, async () => {
    const tenant = await buildTenant(label.slice(0, 4));
    const app = buildApp(tenant, { html: html() });
    const res = await startRun(app, tenant);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(app.locals.lastSummary.state, 'published_schedule_only');
    assert.equal(app.locals.trace.some(([kind]) => kind === 'collect'), false,
      `a ${label} game is never sent for box-score capture`);
    const games = await db.query(
      'select game_status from public.hs_opponent_games where opponent_team_id = $1', [tenant.opponentTeamId]);
    assert.equal(games.rows[0].game_status, expectedStatus);
    const generation = await db.query(
      'select publication_state, final_game_count from public.hs_opponent_stat_generations where opponent_team_id = $1 and is_current',
      [tenant.opponentTeamId]);
    assert.equal(generation.rows[0].publication_state, 'schedule_only');
    assert.equal(generation.rows[0].final_game_count, 0);
  });
}

test('scheduled -> postponed -> rescheduled-final keeps one canonical game', { skip }, async () => {
  const tenant = await buildTenant('cont');
  const before = buildApp(tenant, { html: fixtures.rescheduledBefore });
  await startRun(before, tenant);
  assert.equal(before.locals.lastSummary.state, 'published_schedule_only');

  const after = buildApp(tenant, { html: fixtures.rescheduledAfter });
  await startRun(after, tenant);
  assert.equal(after.locals.lastSummary.state, 'published_verified');

  const games = await db.query(
    'select source_game_ref, game_status, game_date from public.hs_opponent_games where opponent_team_id = $1',
    [tenant.opponentTeamId]);
  assert.equal(games.rowCount, 1, 'a reschedule is the same contest, not a second one');
  assert.equal(games.rows[0].game_status, 'final');
  assert.equal(games.rows[0].game_date.toISOString().slice(0, 10), '2026-04-17');

  const observations = await db.query(
    `select observed_game_date, observed_game_status from public.hs_opponent_import_run_games
      where org_id = $1 order by observed_game_date`, [tenant.orgId]);
  assert.equal(observations.rowCount, 2, 'both observations survive as history');
  assert.equal(observations.rows[0].observed_game_status, 'postponed');
  assert.equal(observations.rows[0].observed_game_date.toISOString().slice(0, 10), '2026-04-10');
});

test('a same-day doubleheader from the real extractor stays two canonical games', { skip }, async () => {
  const tenant = await buildTenant('dh');
  const app = buildApp(tenant, { html: fixtures.doubleheaderDistinct });
  await startRun(app, tenant);
  assert.equal(app.locals.lastSummary.state, 'published_schedule_only');
  const games = await db.query(
    'select source_game_ref from public.hs_opponent_games where opponent_team_id = $1 order by source_game_ref',
    [tenant.opponentTeamId]);
  assert.deepEqual(games.rows.map((r) => r.source_game_ref), ['g-dh-1', 'g-dh-2']);
});

// ── Failure and authorization, through the real extractor ──────────────

test('failing to capture a discovered completed game blocks the whole candidate', { skip }, async () => {
  const tenant = await buildTenant('fail');
  const app = buildApp(tenant, {
    html: fixtures.mixedSchedule,
    collectImpl: async () => { throw new Error('socket hang up'); },
  });
  const res = await startRun(app, tenant);
  assert.equal(res.status, 201);
  const summary = app.locals.lastSummary;
  assert.equal(summary.state, 'failed');
  assert.equal(summary.failureReason, 'incomplete_collection');
  const generations = await db.query(
    'select count(*)::int c from public.hs_opponent_stat_generations where opponent_team_id = $1', [tenant.opponentTeamId]);
  assert.equal(generations.rows[0].c, 0, 'nothing is published from a partial capture');
});

test('an empty later schedule cannot retire a verified generation discovered earlier', { skip }, async () => {
  const tenant = await buildTenant('reg');
  const verified = buildApp(tenant, { html: fixtures.mixedSchedule });
  await startRun(verified, tenant);
  const verifiedId = verified.locals.lastSummary.generationId;
  assert.equal(verified.locals.lastSummary.state, 'published_verified');

  const emptied = buildApp(tenant, { html: fixtures.futureOnly });
  await startRun(emptied, tenant);
  assert.equal(emptied.locals.lastSummary.state, 'failed');
  assert.equal(emptied.locals.lastSummary.failureReason, 'OPPONENT_COMPLETENESS_REGRESSION');

  const current = await db.query(
    'select id, publication_state from public.hs_opponent_stat_generations where opponent_team_id = $1 and is_current',
    [tenant.opponentTeamId]);
  assert.equal(current.rows[0].id, verifiedId);
  assert.equal(current.rows[0].publication_state, 'verified');
});

test('cross-tenant and unresolved-link attempts are still denied on this path', { skip }, async () => {
  const app = buildApp(A, { html: fixtures.mixedSchedule });
  const crossTenant = await startRun(app, A, { opponentTeamId: B.opponentTeamId });
  assert.equal(crossTenant.status, 404);
  assert.equal(app.locals.trace.length, 0, 'no extraction is attempted for a foreign opponent');

  const unlinked = await buildTenant('nolink', { linkStatus: 'pending' });
  const unlinkedApp = buildApp(unlinked, { html: fixtures.mixedSchedule });
  const res = await startRun(unlinkedApp, unlinked);
  assert.equal(res.status, 409);
  assert.equal(unlinkedApp.locals.trace.length, 0, 'no extraction is attempted without a linked identity');
});

// ── Source event identity collision, route to RPC ──────────────────────

test('two distinct rows sharing one upstream id fail closed without publishing', { skip }, async () => {
  const tenant = await buildTenant('coll');
  const app = buildApp(tenant, { html: fixtures.twoRowsSharedIdDifferentScores });
  const res = await startRun(app, tenant);
  assert.equal(res.status, 201, 'the run starts; discovery is what fails');

  // Both rows genuinely left the extractor.
  const extracted = app.locals.trace.find(([kind]) => kind === 'extracted')[1];
  assert.equal(extracted.split(',').length, 2, 'two observations left the extractor');

  const summary = app.locals.lastSummary;
  assert.equal(summary.state, 'failed');
  assert.equal(summary.failureReason, 'opponent_source_event_identity_collision');
  assert.equal(summary.verifiedGenerationPublished, false);
  assert.equal(summary.manualReconciliationRequired, true);

  // Structured diagnostics name the colliding rows and keep both observations.
  assert.equal(summary.identityCollisions.length, 1);
  const [collision] = summary.identityCollisions;
  assert.equal(collision.sourceGameRef, 'g-shared-1');
  assert.deepEqual(collision.sourceRowIndexes, [0, 1]);
  assert.equal(collision.observations.length, 2, 'both observations are retained for reconciliation');

  // Nothing whatsoever was committed for this new opponent.
  assert.equal(app.locals.trace.some(([kind]) => kind === 'collect'), false,
    'no capture is attempted once a collision is known');
  const generations = await db.query(
    'select count(*)::int c from public.hs_opponent_stat_generations where opponent_team_id = $1', [tenant.opponentTeamId]);
  assert.equal(generations.rows[0].c, 0, 'no current generation is created for a new opponent');
  const games = await db.query(
    'select count(*)::int c from public.hs_opponent_games where opponent_team_id = $1', [tenant.opponentTeamId]);
  assert.equal(games.rows[0].c, 0, 'no partial opponent games are committed');
  const totals = await db.query(
    'select count(*)::int c from public.hs_opponent_verified_totals where opponent_team_id = $1', [tenant.opponentTeamId]);
  assert.equal(totals.rows[0].c, 0, 'no totals are committed');
  const run = await db.query(
    `select status, failure_stage from public.hs_opponent_import_runs
      where opponent_team_id = $1 order by created_at desc limit 1`, [tenant.opponentTeamId]);
  assert.equal(run.rows[0].status, 'failed', 'the import run never reports verified publication success');
});

test('reversing the DOM order produces the same collision classification', { skip }, async () => {
  const tenant = await buildTenant('collrev');
  const app = buildApp(tenant, { html: fixtures.twoRowsSharedHrefReversed });
  await startRun(app, tenant);
  const summary = app.locals.lastSummary;
  assert.equal(summary.state, 'failed');
  assert.equal(summary.failureReason, 'opponent_source_event_identity_collision');
  assert.deepEqual(summary.identityCollisions[0].sourceRowIndexes, [0, 1],
    'the diagnostic is order-independent');
});

test('a collision cannot retire an existing verified generation', { skip }, async () => {
  const tenant = await buildTenant('collprior');
  const verified = buildApp(tenant, { html: fixtures.mixedSchedule });
  await startRun(verified, tenant);
  const verifiedId = verified.locals.lastSummary.generationId;
  assert.equal(verified.locals.lastSummary.state, 'published_verified');

  const colliding = buildApp(tenant, { html: fixtures.twoRowsSharedIdDifferentScores });
  await startRun(colliding, tenant);
  assert.equal(colliding.locals.lastSummary.state, 'failed');
  assert.equal(colliding.locals.lastSummary.failureReason, 'opponent_source_event_identity_collision');

  const current = await db.query(
    `select id, publication_state, final_game_count from public.hs_opponent_stat_generations
      where opponent_team_id = $1 and is_current`, [tenant.opponentTeamId]);
  assert.equal(current.rowCount, 1);
  assert.equal(current.rows[0].id, verifiedId, 'the prior verified generation is untouched');
  assert.equal(current.rows[0].publication_state, 'verified');
  assert.equal(current.rows[0].final_game_count, 1);
});

test('one row rendering two anchors publishes normally, proving the guard is not over-broad', { skip }, async () => {
  const tenant = await buildTenant('onerow');
  const app = buildApp(tenant, { html: fixtures.singleRowTwoAnchors });
  const res = await startRun(app, tenant);
  assert.equal(res.status, 201);
  const summary = app.locals.lastSummary;
  assert.equal(summary.state, 'published_verified', 'a single row with two anchors is one game, not a collision');
  assert.equal(summary.finalGameCount, 1);
  const games = await db.query(
    'select count(*)::int c from public.hs_opponent_games where opponent_team_id = $1', [tenant.opponentTeamId]);
  assert.equal(games.rows[0].c, 1);
});

test('the database rejects a collision even when the application check is bypassed', { skip }, async () => {
  // A privileged caller building the DTO directly must not be able to publish a
  // collection whose observations claim one upstream identity.
  const tenant = await buildTenant('dbguard');
  const { mapHighSchoolOpponentEngineCollection } = require('../src/high-school-engine-persistence-mapper');
  const { createHighSchoolImportRepository } = require('../src/high-school-import-repository');
  const repository = createHighSchoolImportRepository(admin);
  const run = await importService.startOpponentImportRun({
    orgId: tenant.orgId, programId: tenant.programId, seasonId: tenant.seasonId,
    opponentTeamId: tenant.opponentTeamId, sourceTeamId: tenant.sourceTeamId, triggerKind: 'manual',
  });
  const sharedRef = `db-guard-${tenant.s}`;
  const game = (over = {}) => ({
    meta: {
      gameDate: '2026-04-01', homeTeam: 'Opp', awayTeam: 'Third', ourSide: 'home',
      capturedAt: '2026-04-01T20:00:00.000Z', gameStatus: 'final', sourceGameId: sharedRef, ...over,
    },
    boxScore: {
      batting: [
        { Player: 'A', TeamSide: 'home', own: true, playerId: 'p1' },
        { Player: 'B', TeamSide: 'away', own: false, playerId: 'p2' },
      ],
      pitching: [],
    },
    plays: [{ inning: 'Bottom 1', batterId: 'p1', text: 'Single. A singles to left field, C pitching.' }],
  });
  const { dto } = mapHighSchoolOpponentEngineCollection({
    context: { orgId: tenant.orgId, programId: tenant.programId, seasonId: tenant.seasonId, sourceProvider: 'gamechanger' },
    subject: { opponentTeamId: tenant.opponentTeamId, sourceTeamId: tenant.sourceTeamId, importRunId: run.id },
    capturedGames: [game(), game({ venue: 'Other Park' })],
  });
  assert.equal(dto.observations.length, 2);
  assert.equal(new Set(dto.observations.map((o) => o.sourceGameRef)).size, 1,
    'the DTO genuinely claims one upstream identity twice');

  await assert.rejects(
    () => repository.persistEngineCollection(dto),
    (error) => error.code === 'OPPONENT_SOURCE_EVENT_IDENTITY_COLLISION',
    'the SECURITY INVOKER boundary refuses the collection',
  );
  const generations = await db.query(
    'select count(*)::int c from public.hs_opponent_stat_generations where opponent_team_id = $1', [tenant.opponentTeamId]);
  assert.equal(generations.rows[0].c, 0);
  const games = await db.query(
    'select count(*)::int c from public.hs_opponent_games where opponent_team_id = $1', [tenant.opponentTeamId]);
  assert.equal(games.rows[0].c, 0, 'the transaction rolled back completely');
});
