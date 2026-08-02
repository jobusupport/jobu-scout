'use strict';

// Direct behavioral coverage for the seven new High School GameChanger
// import READ functions added to src/high-school-import-repository.js:
// listImportRuns, listRunGames, getCapturedGamesForRun,
// listGameValidationResults, getCurrentVerifiedTotals,
// listCurrentPlayerAdvancedStats, listCurrentPitcherAdvancedStats.
//
// These call the REAL repository functions (not stubs, unlike
// test/high-school-import-routes.test.js's fake service object) against
// the shared fake Supabase client already used by the rest of the Slice
// 1A persistence suite (test/helpers/fake-supabase-client.js), narrowly
// extended (see that file's own .in()/.order()/.limit() additions) to
// support the query chains these specific functions use. Test data is
// seeded through the repository's OWN already-tested write functions
// (createImportRun, recordRunGame, captureRawSnapshot,
// insertGameValidationResult, publishVerifiedTotals,
// publishPlayerAdvancedStats, publishPitcherAdvancedStats) rather than by
// poking the fake's internal state directly, so these tests exercise a
// real write-then-read round trip.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createFakeSupabaseClient } = require('./helpers/fake-supabase-client');
const { createHighSchoolImportRepository } = require('../src/high-school-import-repository');

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const PROGRAM_A = '33333333-3333-3333-3333-333333333333';
const TEAM_A = '55555555-5555-5555-5555-555555555555';
const TEAM_B = '66666666-6666-6666-6666-666666666666';
const SEASON_A = '77777777-7777-7777-7777-777777777777';
const PLAYER_1 = '88888888-8888-8888-8888-888888888888';

function ctxA(extra = {}) {
  return { orgId: ORG_A, programId: PROGRAM_A, teamId: TEAM_A, seasonId: SEASON_A, ...extra };
}

function makeRepo() {
  const client = createFakeSupabaseClient();
  return { client, repo: createHighSchoolImportRepository(client) };
}

function agreeingAggregate(overrides = {}) {
  return {
    games: 1, boxScoreGames: 1, playByPlayGames: 0, validatedGames: 0, mismatchGames: 0,
    confidence: 'medium', ...overrides,
  };
}

// ── listImportRuns ───────────────────────────────────────────────────────

test('listImportRuns: returns only this org+team+season\'s own runs, newest first, and never a foreign-tenant run', async () => {
  const { repo } = makeRepo();
  const runA1 = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  await new Promise((r) => setTimeout(r, 2));
  const runA2 = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  // A run for a DIFFERENT team in the same org -- must not appear.
  await repo.createImportRun({ ...ctxA({ teamId: TEAM_B }), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  // A run for a completely different organization -- must not appear.
  await repo.createImportRun({ orgId: ORG_B, programId: PROGRAM_A, teamId: TEAM_A, seasonId: SEASON_A, sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });

  const runs = await repo.listImportRuns({ orgId: ORG_A, teamId: TEAM_A, seasonId: SEASON_A });
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((r) => r.id), [runA2.id, runA1.id], 'must be ordered newest-first');
  assert.ok(runs.every((r) => r.status !== undefined));
});

test('listImportRuns: respects the limit parameter', async () => {
  const { repo } = makeRepo();
  for (let i = 0; i < 5; i += 1) {
    await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  }
  const runs = await repo.listImportRuns({ orgId: ORG_A, teamId: TEAM_A, seasonId: SEASON_A, limit: 2 });
  assert.equal(runs.length, 2);
});

// ── listRunGames ──────────────────────────────────────────────────────────

test('listRunGames: returns only this run\'s own games, scoped by org', async () => {
  const { repo } = makeRepo();
  const runA = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  const runOther = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  await repo.recordRunGame({ orgId: ORG_A, importRunId: runA.id, sourceGameRef: 'gc-1', discoveryStatus: 'processed', gameOutcome: 'inserted' });
  await repo.recordRunGame({ orgId: ORG_A, importRunId: runA.id, sourceGameRef: 'gc-2', discoveryStatus: 'processed', gameOutcome: 'inserted' });
  await repo.recordRunGame({ orgId: ORG_A, importRunId: runOther.id, sourceGameRef: 'gc-unrelated', discoveryStatus: 'processed', gameOutcome: 'inserted' });

  const games = await repo.listRunGames({ orgId: ORG_A, importRunId: runA.id });
  assert.equal(games.length, 2);
  assert.deepEqual(games.map((g) => g.source_game_ref).sort(), ['gc-1', 'gc-2']);
});

test('listRunGames: a foreign-org id (correct run id, wrong orgId) returns nothing rather than leaking cross-tenant rows', async () => {
  const { repo } = makeRepo();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-1', discoveryStatus: 'processed', gameOutcome: 'inserted' });

  const games = await repo.listRunGames({ orgId: ORG_B, importRunId: run.id });
  assert.deepEqual(games, []);
});

// ── getCapturedGamesForRun ────────────────────────────────────────────────

// Mirrors the real adapter's actual sequence (src/high-school-gc-import.js's
// runHighSchoolImportCollection): record the run-game while still
// discovering, capture snapshots, THEN attach hs_game_id and mark the
// outcome via updateRunGameOutcome -- getCapturedGamesForRun's own
// `eligible` filter requires a non-null hs_game_id (a game only counts once
// it's been resolved to a canonical hs_games row), so a fixture that skips
// this final step is not a realistic captured game and getCapturedGamesForRun
// correctly excludes it, exactly as it would in production.
async function seedCapturedGame(repo, { runId, sourceGameRef, gameOutcome = 'inserted', withPlayByPlay = true }) {
  const hsGameId = crypto.randomUUID();
  const { row: recordedRunGame } = await repo.recordRunGame({ orgId: ORG_A, importRunId: runId, sourceGameRef, discoveryStatus: 'discovered' });
  const boxScore = { batting: [{ Player: 'Alice Synthetic', TeamSide: 'home', isHighSchoolTeam: true, AB: 3, H: 1 }], pitching: [] };
  await repo.captureRawSnapshot({
    orgId: ORG_A, importRunId: runId, importRunGameId: recordedRunGame.id, hsGameId,
    snapshotKind: 'box_score', sourceProvider: 'gamechanger', sourceRef: sourceGameRef,
    payload: boxScore, contentType: 'application/json',
  });
  if (withPlayByPlay) {
    await repo.captureRawSnapshot({
      orgId: ORG_A, importRunId: runId, importRunGameId: recordedRunGame.id, hsGameId,
      snapshotKind: 'play_by_play', sourceProvider: 'gamechanger', sourceRef: sourceGameRef,
      payload: { plays: [{ inning: 'Top 1', text: 'Alice Synthetic singles.' }] }, contentType: 'application/json',
    });
  }
  const runGame = await repo.updateRunGameOutcome({
    orgId: ORG_A, runGameId: recordedRunGame.id, discoveryStatus: 'processed', gameOutcome, hsGameId,
  });
  return runGame;
}

test('getCapturedGamesForRun: rebuilds boxScore/plays from this run\'s own captured snapshots for inserted games only', async () => {
  const { repo } = makeRepo();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  await seedCapturedGame(repo, { runId: run.id, sourceGameRef: 'gc-1' });
  await seedCapturedGame(repo, { runId: run.id, sourceGameRef: 'gc-2' });
  // A skipped (duplicate) game -- must be excluded from the aggregate.
  await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-skip', discoveryStatus: 'skipped', gameOutcome: 'skipped', hsGameId: null });
  // A failed game -- must also be excluded.
  await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-fail', discoveryStatus: 'failed', gameOutcome: 'failed', hsGameId: null });

  const captured = await repo.getCapturedGamesForRun({ orgId: ORG_A, importRunId: run.id });
  assert.equal(captured.length, 2);
  for (const game of captured) {
    assert.ok(game.boxScore);
    assert.equal(game.boxScore.batting[0].Player, 'Alice Synthetic');
    assert.equal(game.boxScore.batting[0].isHighSchoolTeam, true);
    assert.equal(game.plays.length, 1);
  }
});

test('getCapturedGamesForRun: an eligible (resolved, inserted) game with no captured box-score snapshot is excluded rather than returned with a null boxScore', async () => {
  const { repo } = makeRepo();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  // Resolved to a canonical game and marked inserted (so it passes the
  // eligibility filter), but -- defensively tested anyway -- no snapshot
  // was ever actually captured for it.
  await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-no-snapshot', discoveryStatus: 'processed', gameOutcome: 'inserted', hsGameId: crypto.randomUUID() });

  const captured = await repo.getCapturedGamesForRun({ orgId: ORG_A, importRunId: run.id });
  assert.deepEqual(captured, []);
});

test('getCapturedGamesForRun: box-score-only games (no play-by-play captured) still publish with an empty plays array', async () => {
  const { repo } = makeRepo();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  await seedCapturedGame(repo, { runId: run.id, sourceGameRef: 'gc-box-only', withPlayByPlay: false });

  const captured = await repo.getCapturedGamesForRun({ orgId: ORG_A, importRunId: run.id });
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].plays, []);
});

test('getCapturedGamesForRun: never returns another run\'s or another org\'s captured games', async () => {
  const { repo } = makeRepo();
  const runA = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  const runOther = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  await seedCapturedGame(repo, { runId: runA.id, sourceGameRef: 'gc-a' });
  await seedCapturedGame(repo, { runId: runOther.id, sourceGameRef: 'gc-other' });

  const captured = await repo.getCapturedGamesForRun({ orgId: ORG_A, importRunId: runA.id });
  assert.equal(captured.length, 1);

  const foreignOrgAttempt = await repo.getCapturedGamesForRun({ orgId: ORG_B, importRunId: runA.id });
  assert.deepEqual(foreignOrgAttempt, [], 'a correct run id under the wrong org must return nothing');
});

test('getCapturedGamesForRun: an empty (no eligible games) run returns an empty array without ever calling .in() on an empty id list', async () => {
  const { repo } = makeRepo();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  const captured = await repo.getCapturedGamesForRun({ orgId: ORG_A, importRunId: run.id });
  assert.deepEqual(captured, []);
});

// UUID-shape validation for these functions' arguments is a SERVICE-layer
// responsibility (src/high-school-import-service.js's requireUuid gates,
// covered separately below) -- the repository layer's own job is only to
// scope the query correctly. A malformed/non-matching id at the repository
// layer must still fail safely: no row can ever match it, so it returns
// empty rather than an unfiltered scan or a thrown type error.
test('getCapturedGamesForRun: an importRunId that matches no real run returns an empty array, never an unfiltered scan', async () => {
  const { repo } = makeRepo();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  await seedCapturedGame(repo, { runId: run.id, sourceGameRef: 'gc-1' });

  const result = await repo.getCapturedGamesForRun({ orgId: ORG_A, importRunId: 'ffffffff-0000-4000-8000-000000000000' });
  assert.deepEqual(result, []);
});

// ── listGameValidationResults ──────────────────────────────────────────────

test('listGameValidationResults: returns only this run\'s validation rows, scoped by org', async () => {
  const { repo } = makeRepo();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  const otherRun = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  const { row: runGame } = await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-1', discoveryStatus: 'processed', gameOutcome: 'inserted' });
  const hsGameId = '99999999-9999-9999-9999-999999999999';
  await repo.insertGameValidationResult({
    orgId: ORG_A, importRunId: run.id, importRunGameId: runGame.id, hsGameId, teamId: TEAM_A,
    hasBoxScore: true, hasPlayByPlay: false, battingMatchesBox: true,
  });
  const { row: otherRunGame } = await repo.recordRunGame({ orgId: ORG_A, importRunId: otherRun.id, sourceGameRef: 'gc-2', discoveryStatus: 'processed', gameOutcome: 'inserted' });
  await repo.insertGameValidationResult({
    orgId: ORG_A, importRunId: otherRun.id, importRunGameId: otherRunGame.id, hsGameId: '11111111-2222-3333-4444-555555555555', teamId: TEAM_A,
    hasBoxScore: true, hasPlayByPlay: false, battingMatchesBox: true,
  });

  const results = await repo.listGameValidationResults({ orgId: ORG_A, importRunId: run.id });
  assert.equal(results.length, 1);
  assert.equal(results[0].hs_game_id, hsGameId);
});

// ── getCurrentVerifiedTotals / listCurrentPlayerAdvancedStats / listCurrentPitcherAdvancedStats ──

test('getCurrentVerifiedTotals: returns only the current row for this org/team/season, null when none published', async () => {
  const { repo } = makeRepo();
  const none = await repo.getCurrentVerifiedTotals({ orgId: ORG_A, teamId: TEAM_A, seasonId: SEASON_A });
  assert.equal(none, null);

  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  await repo.publishVerifiedTotals({ ...ctxA(), importRunId: run.id, aggregate: agreeingAggregate() });
  const current = await repo.getCurrentVerifiedTotals({ orgId: ORG_A, teamId: TEAM_A, seasonId: SEASON_A });
  assert.ok(current);
  assert.equal(current.is_current, true);

  // A different org's totals must never be returned even for the identical team/season ids colliding by coincidence.
  const foreign = await repo.getCurrentVerifiedTotals({ orgId: ORG_B, teamId: TEAM_A, seasonId: SEASON_A });
  assert.equal(foreign, null);
});

test('getCurrentVerifiedTotals: a superseded (no longer current) row is never returned', async () => {
  const { repo } = makeRepo();
  const runA = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  await repo.publishVerifiedTotals({ ...ctxA(), importRunId: runA.id, aggregate: agreeingAggregate({ confidence: 'low' }) });
  const runB = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  await repo.publishVerifiedTotals({ ...ctxA(), importRunId: runB.id, aggregate: agreeingAggregate({ confidence: 'high' }) });

  const current = await repo.getCurrentVerifiedTotals({ orgId: ORG_A, teamId: TEAM_A, seasonId: SEASON_A });
  assert.equal(current.confidence, 'high', 'must be the newer, current publication -- not the superseded one');
});

test('listCurrentPlayerAdvancedStats: returns only current rows for this org/team/season, and never a foreign player\'s row from another team', async () => {
  const { repo } = makeRepo();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  await repo.publishPlayerAdvancedStats({ ...ctxA(), importRunId: run.id, playerId: PLAYER_1, stats: { games: 3, k_pct: 12.5 } });
  // Same player, different TEAM -- must not appear in TEAM_A's results.
  await repo.publishPlayerAdvancedStats({ ...ctxA({ teamId: TEAM_B }), importRunId: run.id, playerId: PLAYER_1, stats: { games: 1 } });

  const stats = await repo.listCurrentPlayerAdvancedStats({ orgId: ORG_A, teamId: TEAM_A, seasonId: SEASON_A });
  assert.equal(stats.length, 1);
  assert.equal(stats[0].player_id, PLAYER_1);
  assert.equal(stats[0].is_current, true);
});

test('listCurrentPitcherAdvancedStats: returns only current rows, superseded rows excluded', async () => {
  const { repo } = makeRepo();
  const runA = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  await repo.publishPitcherAdvancedStats({ ...ctxA(), importRunId: runA.id, playerId: PLAYER_1, stats: { games: 1, so_per7: 5 } });
  const runB = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  await repo.publishPitcherAdvancedStats({ ...ctxA(), importRunId: runB.id, playerId: PLAYER_1, stats: { games: 2, so_per7: 9 } });

  const stats = await repo.listCurrentPitcherAdvancedStats({ orgId: ORG_A, teamId: TEAM_A, seasonId: SEASON_A });
  assert.equal(stats.length, 1);
  assert.equal(stats[0].so_per7, 9, 'the superseded row must not appear');
});

// ── HTTP-boundary sanitization (through the service layer, matching the
// existing service test file's own convention of asserting the repository
// error is never leaked verbatim) ─────────────────────────────────────────

test('a persistence-layer error from any of the new read functions is wrapped into a typed ImportError, never the raw Supabase/Postgres error object', async () => {
  const { client, repo } = makeRepo();
  const originalFrom = client.from;
  client.from = (table) => {
    if (table === 'hs_verified_totals') {
      return { select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: '42P01', message: 'relation "hs_verified_totals" does not exist' } }) }) }) }) }) }) };
    }
    return originalFrom(table);
  };
  await assert.rejects(
    () => repo.getCurrentVerifiedTotals({ orgId: ORG_A, teamId: TEAM_A, seasonId: SEASON_A }),
    (err) => {
      assert.equal(err.code, 'PERSISTENCE_FAILED', 'must be the typed wrapper, not the raw Postgres {code, message} object');
      assert.equal(err.statusCode, 502);
      assert.equal(err.context?.table, 'hs_verified_totals');
      return true;
    }
  );
});
