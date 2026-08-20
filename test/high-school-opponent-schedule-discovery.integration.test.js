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

// ── Generic wrappers, production-shaped (HS 2D review correction) ───────
//
// Against 57c4d5f these same wrappers collapsed to ONE entry and a real game
// vanished before the collector ever saw it:
//   dateGroupLi  entries=1 ids=["game-AAA"] collision=false
//   tableRow     entries=1 ids=["game-CCC"] collision=false
// These drive the corrected extractor through the registered route, the real
// collector, service, repository and RPC, and prove both games survive all the
// way into the published generation.

test('a date-group wrapper publishes BOTH games through the real route', { skip }, async () => {
  const tenant = await buildTenant('wrapli');
  const app = buildApp(tenant, { html: fixtures.dateGroupLiTwoDatedGames });
  const res = await startRun(app, tenant);
  assert.equal(res.status, 201, JSON.stringify(res.body));

  // Both left the extractor.
  const extracted = app.locals.trace.find(([kind]) => kind === 'extracted')[1].split(',');
  assert.equal(extracted.length, 2, 'both games left the extractor');
  assert.deepEqual(extracted.sort(), ['game-alpha:final', 'game-beta:final']);

  // Both reached collection assembly and were captured.
  const collected = app.locals.trace.filter(([kind]) => kind === 'collect').map(([, id]) => id).sort();
  assert.deepEqual(collected, ['game-alpha', 'game-beta'], 'both completed games were captured');

  const summary = app.locals.lastSummary;
  assert.equal(summary.state, 'published_verified');
  assert.equal(summary.finalGameCount, 2, 'official counts reflect both games');

  // Both are represented in the published collection.
  const generation = await db.query(
    `select final_game_count, observation_count, array_length(final_identity_digests, 1) as digests
       from public.hs_opponent_stat_generations where id = $1`, [summary.generationId]);
  assert.equal(generation.rows[0].final_game_count, 2);
  assert.equal(generation.rows[0].observation_count, 2);
  assert.equal(generation.rows[0].digests, 2, 'two distinct completed-game identities are recorded');

  const games = await db.query(
    `select source_game_ref from public.hs_opponent_games where opponent_team_id = $1 order by source_game_ref`,
    [tenant.opponentTeamId]);
  assert.deepEqual(games.rows.map((r) => r.source_game_ref), ['game-alpha', 'game-beta']);

  const totals = await db.query(
    'select games, validated_games from public.hs_opponent_verified_totals where generation_id = $1', [summary.generationId]);
  assert.equal(totals.rows[0].games, 2, 'totals reflect both games');

  // Replay of the same fixture is idempotent.
  const replay = buildApp(tenant, { html: fixtures.dateGroupLiTwoDatedGames });
  await startRun(replay, tenant);
  assert.equal(replay.locals.lastSummary.generationId, summary.generationId);

  // Reversed DOM order does not mint a new generation.
  const reversed = buildApp(tenant, { html: fixtures.dateGroupLiTwoDatedGamesReversed });
  await startRun(reversed, tenant);
  assert.equal(reversed.locals.lastSummary.generationId, summary.generationId,
    'DOM order is provenance; it must not mint a new generation');
  const generations = await db.query(
    'select count(*)::int c from public.hs_opponent_stat_generations where opponent_team_id = $1', [tenant.opponentTeamId]);
  assert.equal(generations.rows[0].c, 1);
});

test('a table-row wrapper publishes BOTH games through the real route', { skip }, async () => {
  const tenant = await buildTenant('wraptr');
  const app = buildApp(tenant, { html: fixtures.tableRowTwoDatedGames });
  const res = await startRun(app, tenant);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const summary = app.locals.lastSummary;
  assert.equal(summary.state, 'published_verified');
  assert.equal(summary.finalGameCount, 2);
  const games = await db.query(
    `select source_game_ref from public.hs_opponent_games where opponent_team_id = $1 order by source_game_ref`,
    [tenant.opponentTeamId]);
  assert.deepEqual(games.rows.map((r) => r.source_game_ref), ['game-delta', 'game-gamma']);
});

test('a generic wrapper with two same-href anchors fails closed as a collision', { skip }, async () => {
  const tenant = await buildTenant('wrapcol');
  const app = buildApp(tenant, { html: fixtures.genericWrapperSameHref });
  const res = await startRun(app, tenant);
  assert.equal(res.status, 201);

  // All observations survive extraction.
  const extracted = app.locals.trace.find(([kind]) => kind === 'extracted')[1].split(',');
  assert.equal(extracted.length, 2, 'neither anchor is discarded');

  const summary = app.locals.lastSummary;
  assert.equal(summary.state, 'failed');
  assert.equal(summary.failureReason, 'opponent_source_event_identity_collision');
  assert.equal(summary.identityCollisions[0].observations.length, 2);
  assert.equal(app.locals.trace.some(([kind]) => kind === 'collect'), false,
    'no capture is attempted while identity is ambiguous');

  const generations = await db.query(
    'select count(*)::int c from public.hs_opponent_stat_generations where opponent_team_id = $1', [tenant.opponentTeamId]);
  assert.equal(generations.rows[0].c, 0, 'no partial generation remains');
  const games = await db.query(
    'select count(*)::int c from public.hs_opponent_games where opponent_team_id = $1', [tenant.opponentTeamId]);
  assert.equal(games.rows[0].c, 0);
  const totals = await db.query(
    'select count(*)::int c from public.hs_opponent_verified_totals where opponent_team_id = $1', [tenant.opponentTeamId]);
  assert.equal(totals.rows[0].c, 0);
});

test('a wrapper collision cannot retire a prior verified generation', { skip }, async () => {
  const tenant = await buildTenant('wrapprior');
  const verified = buildApp(tenant, { html: fixtures.dateGroupLiTwoDatedGames });
  await startRun(verified, tenant);
  const verifiedId = verified.locals.lastSummary.generationId;
  assert.equal(verified.locals.lastSummary.state, 'published_verified');

  const colliding = buildApp(tenant, { html: fixtures.genericWrapperSameHref });
  await startRun(colliding, tenant);
  assert.equal(colliding.locals.lastSummary.state, 'failed');

  const current = await db.query(
    `select id, publication_state, final_game_count from public.hs_opponent_stat_generations
      where opponent_team_id = $1 and is_current`, [tenant.opponentTeamId]);
  assert.equal(current.rowCount, 1);
  assert.equal(current.rows[0].id, verifiedId, 'the prior verified generation remains current');
  assert.equal(current.rows[0].final_game_count, 2);
});

// ── Production-shaped date proofs (HS 2D date-attribution correction) ───
//
// Before this correction, driving twoDateGroupsTwoGamesEach through this exact
// path produced:
//   grp-a=2026-04-11  grp-b=null  grp-c=2026-04-18  grp-d=2026-04-11
// grp-d belongs to April 18 and was handed the PREVIOUS group's date, inside a
// generation reporting officialTotalsComplete. Reversing the DOM moved the
// wrong date onto grp-c and minted a different generation from identical source
// content. These drive the registered route -> real extractor -> collector ->
// mapper -> validation -> repository -> local persist_hs_engine_collection and
// prove every one of those symptoms is gone.

const datesFor = async (opponentTeamId) => {
  const rows = await db.query(
    `select source_game_ref, game_date from public.hs_opponent_games
      where opponent_team_id = $1 order by source_game_ref`, [opponentTeamId]);
  return Object.fromEntries(rows.rows.map((r) => [r.source_game_ref, r.game_date && r.game_date.toISOString().slice(0, 10)]));
};

test('every game in a date group is published with its OWN group date, never its neighbour\'s', { skip }, async () => {
  const tenant = await buildTenant('dtgrp');
  const app = buildApp(tenant, { html: fixtures.twoDateGroupsTwoGamesEach });
  const res = await startRun(app, tenant);
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const summary = app.locals.lastSummary;
  assert.equal(summary.state, 'published_verified');
  assert.equal(summary.finalGameCount, 4, 'all four games survive extraction and capture');

  assert.deepEqual(await datesFor(tenant.opponentTeamId), {
    'grp-a': '2026-04-11', 'grp-b': '2026-04-11',
    'grp-c': '2026-04-18', 'grp-d': '2026-04-18',
  }, 'grp-d is an April 18 game and must never carry April 11 into hs_opponent_games');

  // Raw evidence keeps the text the source actually rendered.
  const evidence = await db.query(
    `select source_game_ref, observed_game_date, diagnostics #>> '{dateResolution,status}' as status,
            diagnostics #>> '{dateResolution,rawText}' as raw
       from public.hs_opponent_import_run_games
      where opponent_import_run_id = $1 order by source_game_ref`, [summary.importRunId || res.body.opponentImportRun.id]);
  assert.equal(evidence.rows.length, 4);
  for (const row of evidence.rows) {
    assert.equal(row.status, 'resolved_date_group', `${row.source_game_ref} records how its date was established`);
    assert.match(row.raw, /^Apr 1[18], 2026$/, `${row.source_game_ref} preserves the source date text`);
  }
});

test('reversing games or whole date groups changes no date and mints no generation', { skip }, async () => {
  const tenant = await buildTenant('dtrev');
  const forwards = buildApp(tenant, { html: fixtures.twoDateGroupsTwoGamesEach });
  await startRun(forwards, tenant);
  const first = forwards.locals.lastSummary;
  assert.equal(first.state, 'published_verified');
  const baseline = await datesFor(tenant.opponentTeamId);

  const hashes = await db.query(
    'select input_set_hash, content_hash from public.hs_opponent_stat_generations where id = $1', [first.generationId]);

  for (const [label, html] of [
    ['games reversed within each group', fixtures.twoDateGroupsGamesReversedWithinGroups],
    ['whole groups reversed', fixtures.twoDateGroupsGroupOrderReversed],
  ]) {
    const variant = buildApp(tenant, { html });
    await startRun(variant, tenant);
    assert.equal(variant.locals.lastSummary.generationId, first.generationId,
      `${label}: identical source content must not mint a new generation`);
    assert.deepEqual(await datesFor(tenant.opponentTeamId), baseline,
      `${label}: every game keeps its own date`);
  }

  const after = await db.query(
    `select id, input_set_hash, content_hash from public.hs_opponent_stat_generations
      where opponent_team_id = $1`, [tenant.opponentTeamId]);
  assert.equal(after.rows.length, 1, 'exactly one generation exists across all three orderings');
  assert.equal(after.rows[0].input_set_hash, hashes.rows[0].input_set_hash, 'DOM order does not move the input-set hash');
  assert.equal(after.rows[0].content_hash, hashes.rows[0].content_hash, 'nor the content hash');
});

test('cosmetic date formatting does not mint a new generation', { skip }, async () => {
  const tenant = await buildTenant('dtfmt');
  const plain = buildApp(tenant, { html: fixtures.dateGroupTwoCompleted });
  await startRun(plain, tenant);
  const first = plain.locals.lastSummary;
  assert.equal(first.state, 'published_verified');

  const varied = buildApp(tenant, { html: fixtures.dateFormatAndWhitespaceVariation });
  await startRun(varied, tenant);
  assert.equal(varied.locals.lastSummary.generationId, first.generationId,
    '"Saturday,   April   11,    2026" is the same day, so it is the same generation');
  const generations = await db.query(
    'select count(*)::int c from public.hs_opponent_stat_generations where opponent_team_id = $1', [tenant.opponentTeamId]);
  assert.equal(generations.rows[0].c, 1);
});

test('a genuine reschedule moves the date and creates the next generation without losing identity', { skip }, async () => {
  const tenant = await buildTenant('dtresc');
  const before = buildApp(tenant, { html: fixtures.rescheduledStableIdBefore });
  await startRun(before, tenant);
  assert.equal(before.locals.lastSummary.state, 'published_schedule_only',
    'two unplayed games are schedule knowledge, never a verified statistical generation');
  assert.deepEqual(await datesFor(tenant.opponentTeamId), { 'resched-1': '2026-04-10', 'resched-2': '2026-04-10' });

  const after = buildApp(tenant, { html: fixtures.rescheduledStableIdAfter });
  await startRun(after, tenant);
  assert.equal(after.locals.lastSummary.state, 'published_verified');
  assert.notEqual(after.locals.lastSummary.generationId, before.locals.lastSummary.generationId,
    'a real change in what the source reported is a real new generation');
  assert.deepEqual(await datesFor(tenant.opponentTeamId), { 'resched-1': '2026-04-17', 'resched-2': '2026-04-17' },
    'the date follows the source');
  const games = await db.query(
    'select count(*)::int c from public.hs_opponent_games where opponent_team_id = $1', [tenant.opponentTeamId]);
  assert.equal(games.rows[0].c, 2, 'the stable upstream ids kept the same two canonical games');
});

test('a doubleheader under one header publishes both halves on that date', { skip }, async () => {
  const tenant = await buildTenant('dtdh');
  const app = buildApp(tenant, { html: fixtures.doubleheaderUnderOneDateHeader });
  await startRun(app, tenant);
  assert.equal(app.locals.lastSummary.state, 'published_verified');
  assert.equal(app.locals.lastSummary.finalGameCount, 2);
  assert.deepEqual(await datesFor(tenant.opponentTeamId), { 'dh-one': '2026-04-11', 'dh-two': '2026-04-11' });
});

// ── Unsafe dates fail closed and preserve verified history ─────────────

test('an ambiguous or conflicting date publishes nothing and preserves the prior verified generation', { skip }, async () => {
  const tenant = await buildTenant('dtfail');
  const good = buildApp(tenant, { html: fixtures.dateGroupTwoCompleted });
  await startRun(good, tenant);
  const verified = good.locals.lastSummary;
  assert.equal(verified.state, 'published_verified');

  for (const [label, html, reason] of [
    ['a header naming two dates', fixtures.dateGroupWithTwoDatesInHeader, 'date_evidence_is_ambiguous'],
    ['a row contradicting its group', fixtures.groupDateWithConflictingGameDate, 'date_conflicts_with_date_group'],
    ['a scheduled game with no date at all', fixtures.dateGroupWithUnrecognizableHeader, 'scheduled_game_without_a_date'],
  ]) {
    const bad = buildApp(tenant, { html });
    const res = await startRun(bad, tenant);
    assert.equal(res.status, 201, `${label}: the run resource is still created`);
    const summary = bad.locals.lastSummary;
    assert.equal(summary.state, 'failed', `${label}: the collection fails closed`);
    assert.equal(summary.failureReason, 'opponent_schedule_date_unresolved', `${label}: with a named reason`);
    assert.ok(summary.unsafeScheduleDates.some((row) => row.reason === reason),
      `${label}: the diagnostic identifies ${reason}`);
    assert.equal(summary.manualReconciliationRequired, true);
    assert.equal(summary.priorVerifiedGenerationPreserved, true);
    assert.equal(bad.locals.trace.some(([kind]) => kind === 'collect'), false,
      `${label}: nothing is even captured once the date is known to be unsafe`);
  }

  const current = await db.query(
    `select id, final_game_count from public.hs_opponent_stat_generations
      where opponent_team_id = $1 and is_current`, [tenant.opponentTeamId]);
  assert.equal(current.rowCount, 1);
  assert.equal(current.rows[0].id, verified.generationId, 'the prior verified generation remains current');
  assert.equal(current.rows[0].final_game_count, 2, 'and still reports both completed games');
  assert.deepEqual(await datesFor(tenant.opponentTeamId), { 'done-alpha': '2026-04-11', 'done-bravo': '2026-04-11' },
    'no rejected candidate wrote a date onto a canonical game');
});

test('a completed game with a stable id but no date is still publishable; an unidentified one is not', { skip }, async () => {
  // gameOutsideAnyDateGroup has one dated game and one completed game whose date
  // the source never expressed. The undated one carries a stable upstream id, so
  // it is anchored and publishable with a null date.
  const tenant = await buildTenant('dtnull');
  const app = buildApp(tenant, { html: fixtures.gameOutsideAnyDateGroup });
  await startRun(app, tenant);
  assert.equal(app.locals.lastSummary.state, 'published_verified');
  assert.deepEqual(await datesFor(tenant.opponentTeamId), { 'grouped-b': '2026-04-18', 'loose-a': null },
    'the null says exactly what the source said, and nothing was invented');

  // A visible schedule anchor with no game id segment has neither a durable
  // identity nor a date it could fall back on.
  const orphan = await buildTenant('dtorph');
  const bad = buildApp(orphan, { html: fixtures.anchorWithNoGameIdSegment });
  await startRun(bad, orphan);
  assert.equal(bad.locals.lastSummary.state, 'failed');
  const games = await db.query(
    'select count(*)::int c from public.hs_opponent_games where opponent_team_id = $1', [orphan.opponentTeamId]);
  assert.equal(games.rows[0].c, 0, 'no phantom canonical game row is created');
});

// ── The same rules inside the SECURITY INVOKER boundary ────────────────

function directDtoFor(tenant, run, over = {}) {
  const { mapHighSchoolOpponentEngineCollection } = require('../src/high-school-engine-persistence-mapper');
  return mapHighSchoolOpponentEngineCollection({
    context: { orgId: tenant.orgId, programId: tenant.programId, seasonId: tenant.seasonId, sourceProvider: 'gamechanger' },
    subject: { opponentTeamId: tenant.opponentTeamId, sourceTeamId: tenant.sourceTeamId, importRunId: run.id },
    capturedGames: [{
      meta: {
        gameDate: '2026-04-01', homeTeam: 'Opp', awayTeam: 'Third', ourSide: 'home',
        capturedAt: '2026-04-01T20:00:00.000Z', gameStatus: 'final', sourceGameId: `direct-${tenant.s}`,
        dateResolutionStatus: 'resolved_date_group', dateSourceKind: 'date_group', rawDateText: 'Apr 1, 2026',
        ...over,
      },
      boxScore: {
        batting: [
          { Player: 'A', TeamSide: 'home', own: true, playerId: 'p1' },
          { Player: 'B', TeamSide: 'away', own: false, playerId: 'p2' },
        ],
        pitching: [],
      },
      plays: [{ inning: 'Bottom 1', batterId: 'p1', text: 'Single. A singles to left field, C pitching.' }],
    }],
  });
}

test('the mapper refuses to build a collection whose date the source did not establish', { skip }, async () => {
  const tenant = await buildTenant('mapdate');
  const run = await importService.startOpponentImportRun({
    orgId: tenant.orgId, programId: tenant.programId, seasonId: tenant.seasonId,
    opponentTeamId: tenant.opponentTeamId, sourceTeamId: tenant.sourceTeamId, triggerKind: 'manual',
  });
  for (const over of [
    { dateResolutionStatus: 'ambiguous', gameDate: null },
    { dateResolutionStatus: 'conflicting', gameDate: null },
    { gameDate: null, gameStatus: 'scheduled' },
  ]) {
    assert.throws(() => directDtoFor(tenant, run, over),
      (error) => error.code === 'OPPONENT_SCHEDULE_DATE_UNRESOLVED',
      `${JSON.stringify(over)} must not be mappable into a publishable collection`);
  }
});

test('the database refuses an unsafe date even when the application checks are bypassed', { skip }, async () => {
  const tenant = await buildTenant('dbdate');
  const { createHighSchoolImportRepository } = require('../src/high-school-import-repository');
  const repository = createHighSchoolImportRepository(admin);
  const run = await importService.startOpponentImportRun({
    orgId: tenant.orgId, programId: tenant.programId, seasonId: tenant.seasonId,
    opponentTeamId: tenant.opponentTeamId, sourceTeamId: tenant.sourceTeamId, triggerKind: 'manual',
  });

  // Built through the mapper so every other field is genuinely well formed, then
  // mutated the way a privileged caller assembling its own DTO could.
  const ambiguous = directDtoFor(tenant, run).dto;
  ambiguous.observations[0].diagnostics.dateResolution.status = 'ambiguous';
  await assert.rejects(
    () => repository.persistEngineCollection(ambiguous),
    (error) => error.code === 'OPPONENT_SCHEDULE_DATE_UNRESOLVED',
    'the SECURITY INVOKER boundary refuses an explicitly ambiguous date',
  );

  const undated = directDtoFor(tenant, run).dto;
  undated.observations[0].gameDate = null;
  undated.observations[0].gameStatus = 'scheduled';
  await assert.rejects(
    () => repository.persistEngineCollection(undated),
    (error) => error.code === 'OPPONENT_SCHEDULE_DATE_UNRESOLVED',
    'nor an unplayed game with no date to anchor it',
  );

  for (const table of ['hs_opponent_stat_generations', 'hs_opponent_games']) {
    const rows = await db.query(
      `select count(*)::int c from public.${table} where opponent_team_id = $1`, [tenant.opponentTeamId]);
    assert.equal(rows.rows[0].c, 0, `${table}: the transaction rolled back completely`);
  }
});

test('the database refuses an unresolved identity, so no phantom game accumulates', { skip }, async () => {
  const tenant = await buildTenant('dbident');
  const { createHighSchoolImportRepository } = require('../src/high-school-import-repository');
  const repository = createHighSchoolImportRepository(admin);
  const run = await importService.startOpponentImportRun({
    orgId: tenant.orgId, programId: tenant.programId, seasonId: tenant.seasonId,
    opponentTeamId: tenant.opponentTeamId, sourceTeamId: tenant.sourceTeamId, triggerKind: 'manual',
  });

  // An observation the engine could not resolve matches nothing, so before this
  // guard every run inserted another canonical row for the same non-game.
  const runTwice = async () => {
    const dto = directDtoFor(tenant, run).dto;
    dto.observations[0].identityMethod = 'unresolvedScoped';
    dto.observations[0].sourceGameRef = null;
    await assert.rejects(
      () => repository.persistEngineCollection(dto),
      (error) => error.code === 'OPPONENT_IDENTITY_UNRESOLVED',
      'the SECURITY INVOKER boundary refuses an unresolvable identity',
    );
  };
  await runTwice();
  await runTwice();

  const games = await db.query(
    'select count(*)::int c from public.hs_opponent_games where opponent_team_id = $1', [tenant.opponentTeamId]);
  assert.equal(games.rows[0].c, 0, 'replay creates no duplicates because nothing is created at all');
  const generations = await db.query(
    'select count(*)::int c from public.hs_opponent_stat_generations where opponent_team_id = $1', [tenant.opponentTeamId]);
  assert.equal(generations.rows[0].c, 0);
});

// ── HS 2D final-review corrections, end to end ─────────────────────────
//
// Everything below drives the registered route -> the REAL extractor against an
// offline DOM fixture -> the real collector -> the real service and repository
// -> the real persist_hs_engine_collection, and then reads the database
// directly. Nothing is asserted from the returned JavaScript object alone.

async function runStateFor(opponentTeamId) {
  const rows = await db.query(
    'select status, failure_stage from public.hs_opponent_import_runs where opponent_team_id = $1 order by created_at, id',
    [opponentTeamId]);
  return rows.rows.map((row) => `${row.status}/${row.failure_stage || '-'}`);
}

async function persistedCounts(opponentTeamId) {
  const one = async (sql) => (await db.query(sql, [opponentTeamId])).rows[0].c;
  return {
    games: await one('select count(*)::int c from public.hs_opponent_games where opponent_team_id = $1'),
    generations: await one('select count(*)::int c from public.hs_opponent_stat_generations where opponent_team_id = $1'),
    runGames: await one(`select count(*)::int c from public.hs_opponent_import_run_games g
      where exists (select 1 from public.hs_opponent_import_runs r
                     where r.id = g.opponent_import_run_id and r.opponent_team_id = $1)`),
    totals: await one(`select count(*)::int c from public.hs_opponent_verified_totals v
      where exists (select 1 from public.hs_opponent_stat_generations g
                     where g.id = v.generation_id and g.opponent_team_id = $1)`),
  };
}

test('unmarked dated text never publishes a date it invented', { skip }, async () => {
  // The two shapes the final independent review reproduced writing a WRONG date
  // into a verified generation. The caption said Mar 3 and the note said Apr 20;
  // neither is a marked schedule date boundary, so neither may reach the
  // database.
  const captioned = await buildTenant('capfix');
  const capApp = buildApp(captioned, { html: fixtures.captionBeforeHeaderlessSchedule });
  await startRun(capApp, captioned);
  assert.deepEqual(await datesFor(captioned.opponentTeamId), { 'cap-a': null },
    'the caption date 2026-03-03 must never be published for this game');

  const noted = await buildTenant('notefix');
  const noteApp = buildApp(noted, { html: fixtures.datedNoteBetweenGames });
  await startRun(noteApp, noted);
  assert.deepEqual(await datesFor(noted.opponentTeamId),
    { 'note-a': '2026-04-11', 'note-b': '2026-04-11' },
    'the note date 2026-04-20 must never reach the game rendered after it');
});

test('the undated-completed-game exception does not extend to an unplayed one', { skip }, async () => {
  // A COMPLETED game with a stable upstream id is anchored by that id, so
  // publishing it with a null date states exactly what the source said. The
  // identical page with an UNPLAYED game has nothing to anchor it, so the whole
  // collection fails closed rather than inventing schedule knowledge.
  const played = await buildTenant('excok');
  const okApp = buildApp(played, { html: fixtures.captionBeforeHeaderlessSchedule });
  await startRun(okApp, played);
  assert.equal(okApp.locals.lastSummary.state, 'published_verified');
  assert.deepEqual(await datesFor(played.opponentTeamId), { 'cap-a': null });
  assert.deepEqual(await runStateFor(played.opponentTeamId), ['succeeded/-']);

  const unplayed = await buildTenant('excbad');
  const badApp = buildApp(unplayed, { html: fixtures.captionBeforeHeaderlessScheduledGame });
  await startRun(badApp, unplayed);
  assert.equal(badApp.locals.lastSummary.state, 'failed');
  assert.equal(badApp.locals.lastSummary.failureReason, 'opponent_schedule_date_unresolved');
  assert.deepEqual(await persistedCounts(unplayed.opponentTeamId),
    { games: 0, generations: 0, runGames: 0, totals: 0 });
  assert.deepEqual(await runStateFor(unplayed.opponentTeamId), ['failed/discovery'],
    'a refused collection settles its run rather than leaving it running');
});

test('an impossible calendar date fails the collection closed before PostgreSQL sees it', { skip }, async () => {
  for (const [name, fixture] of [
    ['Feb 30', fixtures.februaryThirtieth],
    ['Apr 31', fixtures.aprilThirtyFirst],
    ['Feb 29 in a non-leap year', fixtures.nonLeapFebruaryTwentyNinth],
  ]) {
    const tenant = await buildTenant('cal');
    const app = buildApp(tenant, { html: fixture });
    await startRun(app, tenant);
    const summary = app.locals.lastSummary;
    assert.equal(summary.state, 'failed', `${name}: nothing is published`);
    assert.equal(summary.failureReason, 'opponent_schedule_date_unresolved');
    assert.equal(summary.unsafeScheduleDates[0].reason, 'date_is_not_a_real_calendar_date',
      `${name}: named, not a generic persistence failure`);
    assert.deepEqual(await persistedCounts(tenant.opponentTeamId),
      { games: 0, generations: 0, runGames: 0, totals: 0 }, `${name}: zero partial writes`);
    assert.deepEqual(await runStateFor(tenant.opponentTeamId), ['failed/discovery']);
  }

  // A real leap day is still a real date and still publishes.
  const leap = await buildTenant('calok');
  const leapApp = buildApp(leap, { html: fixtures.leapFebruaryTwentyNinth });
  await startRun(leapApp, leap);
  assert.equal(leapApp.locals.lastSummary.state, 'published_verified');
  assert.deepEqual(await datesFor(leap.opponentTeamId), { 'cal-feb29-ok': '2028-02-29' });
});

test('one malformed reference fails the collection closed instead of aborting extraction', { skip }, async () => {
  const tenant = await buildTenant('malref');
  const app = buildApp(tenant, { html: fixtures.malformedHrefBesideValidRow });
  await startRun(app, tenant);
  const summary = app.locals.lastSummary;

  // The valid row was still extracted -- the failure is a refusal to publish an
  // incomplete season, not a crash that lost it.
  const extracted = app.locals.trace.find(([kind]) => kind === 'extracted')[1];
  assert.match(extracted, /mal-ok/, 'the valid row survived extraction');

  assert.equal(summary.state, 'failed');
  assert.equal(summary.failureReason, 'opponent_source_reference_malformed');
  assert.equal(summary.malformedSourceReferences.length, 1);
  assert.equal(summary.manualReconciliationRequired, true);
  assert.deepEqual(await persistedCounts(tenant.opponentTeamId),
    { games: 0, generations: 0, runGames: 0, totals: 0 });
  assert.deepEqual(await runStateFor(tenant.opponentTeamId), ['failed/discovery']);
});

test('every publication-boundary rejection settles its import run as failed', { skip }, async () => {
  // The defect this replaces: 'publication' was not an accepted failure stage,
  // the validator threw, the collector swallowed it, and the run sat 'running'
  // for ever -- blocking the next retry and looking exactly like a hung import.
  const cases = [
    ['unresolved identity', fixtures.anchorWithNoGameIdSegment, 'publication'],
    ['ambiguous date', fixtures.competingMarkedHeaders, 'discovery'],
    ['source-event identity collision', fixtures.genericWrapperSameHref, 'discovery'],
  ];
  for (const [name, html, expectedStage] of cases) {
    if (!html) continue;
    const tenant = await buildTenant('pubstage');
    const app = buildApp(tenant, { html });
    await startRun(app, tenant);
    assert.equal(app.locals.lastSummary.state, 'failed', `${name}: nothing is published`);
    const states = await runStateFor(tenant.opponentTeamId);
    assert.deepEqual(states, [`failed/${expectedStage}`],
      `${name}: the run must be failed at the ${expectedStage} stage, never left running`);
    assert.deepEqual(await persistedCounts(tenant.opponentTeamId),
      { games: 0, generations: 0, runGames: 0, totals: 0 }, `${name}: zero partial writes`);
  }
});

test('replaying an unchanged collection settles the replay run too', { skip }, async () => {
  // Only the INSERT path used to mark a run succeeded, so every idempotent
  // replay -- the normal outcome of a scheduled re-scrape -- stranded a run in
  // 'running' on the SUCCESS path.
  const tenant = await buildTenant('replay');
  const first = buildApp(tenant, { html: fixtures.dateGroupTwoCompleted });
  await startRun(first, tenant);
  const generationId = first.locals.lastSummary.generationId;

  const again = buildApp(tenant, { html: fixtures.dateGroupTwoCompleted });
  await startRun(again, tenant);
  assert.equal(again.locals.lastSummary.generationId, generationId, 'the same generation is reused');

  assert.deepEqual(await runStateFor(tenant.opponentTeamId), ['succeeded/-', 'succeeded/-'],
    'both runs settle; a replay is a success, not an unfinished import');
  const generations = await db.query(
    'select count(*)::int c from public.hs_opponent_stat_generations where opponent_team_id = $1',
    [tenant.opponentTeamId]);
  assert.equal(generations.rows[0].c, 1, 'and no second generation is minted');
});

test('a previously final game cannot be walked back to a non-final status', { skip }, async () => {
  // A genuine upstream retraction is news a human must see. Silently applying it
  // over a verified result -- or, at the idempotent-reuse branch, returning
  // success while the canonical row quietly stays final -- would hide it.
  // ONE game under ONE upstream id, whose status the source walks back. That is
  // a retraction, and it is a different thing from a completeness regression
  // (where the verified game leaves the candidate altogether).
  const tenant = await buildTenant('regress');
  const published = buildApp(tenant, { html: fixtures.sameGameFinal });
  await startRun(published, tenant);
  const before = await datesFor(tenant.opponentTeamId);
  const generationId = published.locals.lastSummary.generationId;

  const regressed = buildApp(tenant, { html: fixtures.sameGameScheduled });
  await startRun(regressed, tenant);
  assert.equal(regressed.locals.lastSummary.state, 'failed');
  assert.equal(regressed.locals.lastSummary.failureReason, 'OPPONENT_GAME_STATUS_REGRESSION',
    'named, so the caller learns what happened rather than seeing a generic failure');
  assert.equal(regressed.locals.lastSummary.manualReconciliationRequired, true);

  assert.deepEqual(await datesFor(tenant.opponentTeamId), before, 'the canonical games are untouched');
  const current = await db.query(
    `select id from public.hs_opponent_stat_generations
      where opponent_team_id = $1 and is_current`, [tenant.opponentTeamId]);
  assert.equal(current.rowCount, 1);
  assert.equal(current.rows[0].id, generationId, 'the prior verified generation is still current');
  assert.deepEqual(await runStateFor(tenant.opponentTeamId), ['succeeded/-', 'failed/publication']);
});

test('the database refuses a status regression even when the application is bypassed', { skip }, async () => {
  // A privileged caller presenting a regressed observation at the SAME
  // inputSetHash used to match the existing generation, reuse it, and return
  // success while the canonical row stayed 'final'.
  const tenant = await buildTenant('regrpc');
  const { createHighSchoolImportRepository } = require('../src/high-school-import-repository');
  const repository = createHighSchoolImportRepository(admin);
  const run = await importService.startOpponentImportRun({
    orgId: tenant.orgId, programId: tenant.programId, seasonId: tenant.seasonId,
    opponentTeamId: tenant.opponentTeamId, sourceTeamId: tenant.sourceTeamId, triggerKind: 'manual',
  });
  const published = await repository.persistEngineCollection(directDtoFor(tenant, run).dto);
  assert.ok(published.id);

  for (const status of ['scheduled', 'postponed', 'cancelled', 'suspended', 'in_progress']) {
    const retry = await importService.startOpponentImportRun({
      orgId: tenant.orgId, programId: tenant.programId, seasonId: tenant.seasonId,
      opponentTeamId: tenant.opponentTeamId, sourceTeamId: tenant.sourceTeamId, triggerKind: 'manual',
    });
    const { dto } = directDtoFor(tenant, retry, { gameStatus: status });
    await assert.rejects(
      () => repository.persistEngineCollection(dto),
      (error) => error.code === 'OPPONENT_GAME_STATUS_REGRESSION',
      `the SECURITY INVOKER boundary refuses final -> ${status}`,
    );
  }

  const games = await db.query(
    'select game_status from public.hs_opponent_games where opponent_team_id = $1', [tenant.opponentTeamId]);
  assert.equal(games.rowCount, 1);
  assert.equal(games.rows[0].game_status, 'final', 'the canonical row never silently changed');
  const generations = await db.query(
    'select count(*)::int c from public.hs_opponent_stat_generations where opponent_team_id = $1',
    [tenant.opponentTeamId]);
  assert.equal(generations.rows[0].c, 1, 'and no generation was minted by a rejected candidate');
});

// ── Date-header semantics, end to end ──────────────────────────────────
//
// Registered route -> REAL extractor against an offline DOM fixture -> real
// collector -> real service and repository -> real persist_hs_engine_collection,
// then the database read directly.

async function runStatesFor(opponentTeamId) {
  const rows = await db.query(
    'select status, failure_stage from public.hs_opponent_import_runs where opponent_team_id = $1 order by created_at, id',
    [opponentTeamId]);
  return rows.rows.map((row) => `${row.status}/${row.failure_stage || '-'}`);
}

async function writtenCounts(opponentTeamId) {
  const one = async (sql) => (await db.query(sql, [opponentTeamId])).rows[0].c;
  return {
    games: await one('select count(*)::int c from public.hs_opponent_games where opponent_team_id = $1'),
    generations: await one('select count(*)::int c from public.hs_opponent_stat_generations where opponent_team_id = $1'),
    runGames: await one(`select count(*)::int c from public.hs_opponent_import_run_games g
      where exists (select 1 from public.hs_opponent_import_runs r
                     where r.id = g.opponent_import_run_id and r.opponent_team_id = $1)`),
    totals: await one(`select count(*)::int c from public.hs_opponent_verified_totals v
      where exists (select 1 from public.hs_opponent_stat_generations g
                     where g.id = v.generation_id and g.opponent_team_id = $1)`),
  };
}

test('no marked administrative header reaches the database, played or not', { skip }, async () => {
  // Thirteen of these were reproduced publishing their embedded date into a
  // verified generation. None may now write anything, and -- because
  // 'unsupported_marked_header' is unresolved evidence rather than silence --
  // the completed-game null-date exception must not absorb the played ones
  // either.
  for (const [name, text] of Object.entries(fixtures.MARKED_ADMINISTRATIVE_HEADERS)) {
    for (const played of [true, false]) {
      const tenant = await buildTenant('adm');
      const app = buildApp(tenant, { html: fixtures.markedHeaderWith(text, { played }) });
      await startRun(app, tenant);
      const summary = app.locals.lastSummary;
      assert.equal(summary.state, 'failed', `${name} (played=${played}): nothing is published`);
      assert.equal(summary.failureReason, 'opponent_schedule_date_unresolved');
      assert.equal(summary.unsafeScheduleDates[0].reason,
        'marked_date_header_is_not_a_readable_schedule_date',
        `${name}: refused by name`);
      assert.deepEqual(await writtenCounts(tenant.opponentTeamId),
        { games: 0, generations: 0, runGames: 0, totals: 0 }, `${name}: zero partial writes`);
      assert.deepEqual(await runStatesFor(tenant.opponentTeamId), ['failed/discovery'],
        `${name}: the run settles rather than lingering`);
    }
  }
});

test('a legitimate schedule header still publishes the date it states', { skip }, async () => {
  // "gates open at 5" was thrown away by the old keyword list: the completed
  // game published with a null date, and the unplayed collection failed
  // outright. Both are pinned.
  const played = await buildTenant('gates');
  const playedApp = buildApp(played, { html: fixtures.markedHeaderWith('Apr 11, 2026 - gates open at 5') });
  await startRun(playedApp, played);
  assert.equal(playedApp.locals.lastSummary.state, 'published_verified');
  assert.deepEqual(await datesFor(played.opponentTeamId), { 'grammar-1': '2026-04-11' },
    'the date the source actually stated is what is stored');

  const unplayed = await buildTenant('gatesu');
  const unplayedApp = buildApp(unplayed, { html: fixtures.markedHeaderWith('Apr 11, 2026 - gates open at 5', { played: false }) });
  await startRun(unplayedApp, unplayed);
  assert.equal(unplayedApp.locals.lastSummary.state, 'published_schedule_only');
  assert.deepEqual(await datesFor(unplayed.opponentTeamId), { 'grammar-1': '2026-04-11' });
});

test('structured header evidence decides the date, and a contradiction fails closed', { skip }, async () => {
  const trusted = await buildTenant('struct');
  const trustedApp = buildApp(trusted, { html: fixtures.structuredValueWithNoText });
  await startRun(trustedApp, trusted);
  assert.deepEqual(await datesFor(trusted.opponentTeamId), { 'st-2': '2026-04-11' },
    'a structured value alone is a complete assertion');

  for (const [name, fixture] of [
    ['structured contradicts visible', fixtures.structuredValueContradictingText],
    ['structured beside administrative prose', fixtures.structuredValueWithAdministrativeProse],
    ['impossible structured value', fixtures.structuredValueImpossible],
  ]) {
    const tenant = await buildTenant('structbad');
    const app = buildApp(tenant, { html: fixture });
    await startRun(app, tenant);
    assert.equal(app.locals.lastSummary.state, 'failed', `${name}: nothing is published`);
    assert.deepEqual(await writtenCounts(tenant.opponentTeamId),
      { games: 0, generations: 0, runGames: 0, totals: 0 });
    assert.deepEqual(await runStatesFor(tenant.opponentTeamId), ['failed/discovery']);
  }
});

test('a marked header outside the schedule component publishes no date into it', { skip }, async () => {
  const tenant = await buildTenant('scope');
  const app = buildApp(tenant, { html: fixtures.markedHeaderOutsideComponent });
  await startRun(app, tenant);
  assert.deepEqual(await datesFor(tenant.opponentTeamId), { 'scope-1': null },
    'the page-level Mar 3 must never reach a game inside the component');
});

test('a non-HTTP schedule reference fails the collection closed', { skip }, async () => {
  for (const [name, fixture] of [
    ['javascript:', fixtures.nonHttpSchemeReferences],
    ['ftp:', fixtures.ftpSchemeReference],
    ['data:', fixtures.dataSchemeReference],
    ['mixed-case javascript:', fixtures.mixedCaseJavascriptScheme],
    ['beside a valid row', fixtures.nonHttpBesideValidRow],
  ]) {
    const tenant = await buildTenant('scheme');
    const app = buildApp(tenant, { html: fixture });
    await startRun(app, tenant);
    const summary = app.locals.lastSummary;
    assert.equal(summary.state, 'failed', `${name}: nothing is published`);
    assert.equal(summary.failureReason, 'opponent_source_reference_malformed', `${name}: named`);
    assert.deepEqual(await writtenCounts(tenant.opponentTeamId),
      { games: 0, generations: 0, runGames: 0, totals: 0 }, `${name}: no canonical game is created`);
    assert.deepEqual(await runStatesFor(tenant.opponentTeamId), ['failed/discovery'],
      `${name}: the run settles as failed`);
  }
});

test('the database refuses an unsupported marked header even when the application is bypassed', { skip }, async () => {
  const tenant = await buildTenant('dbunsup');
  const { createHighSchoolImportRepository } = require('../src/high-school-import-repository');
  const repository = createHighSchoolImportRepository(admin);
  const run = await importService.startOpponentImportRun({
    orgId: tenant.orgId, programId: tenant.programId, seasonId: tenant.seasonId,
    opponentTeamId: tenant.opponentTeamId, sourceTeamId: tenant.sourceTeamId, triggerKind: 'manual',
  });
  // The mapper refuses to build this, so the DTO is assembled from a valid one
  // and the status flipped -- the shape a privileged caller could present.
  const { dto } = directDtoFor(tenant, run);
  dto.observations[0].diagnostics.dateResolution.status = 'unsupported_marked_header';
  dto.observations[0].gameDate = null;
  await assert.rejects(
    () => repository.persistEngineCollection(dto),
    (error) => error.code === 'OPPONENT_SCHEDULE_DATE_UNRESOLVED',
    'the SECURITY INVOKER boundary refuses marked-but-unreadable date evidence',
  );
  const games = await db.query(
    'select count(*)::int c from public.hs_opponent_games where opponent_team_id = $1', [tenant.opponentTeamId]);
  assert.equal(games.rows[0].c, 0, 'and nothing is written');
});

test('the mapper refuses an unsupported marked header before any database call', { skip }, async () => {
  const tenant = await buildTenant('mapunsup');
  const run = await importService.startOpponentImportRun({
    orgId: tenant.orgId, programId: tenant.programId, seasonId: tenant.seasonId,
    opponentTeamId: tenant.opponentTeamId, sourceTeamId: tenant.sourceTeamId, triggerKind: 'manual',
  });
  assert.throws(() => directDtoFor(tenant, run, {
    dateResolutionStatus: 'unsupported_marked_header', gameDate: null,
  }), (error) => error.code === 'OPPONENT_SCHEDULE_DATE_UNRESOLVED');
});
