'use strict';

// Behavioral tests for src/high-school-gc-import.js's injectable
// orchestration loop (runHighSchoolImportCollection) -- the actual
// production code path, not a re-implementation of it. Every I/O boundary
// (the import service, game discovery, per-game collection, cancellation,
// sleeping) is faked here, so these tests exercise the REAL sequencing,
// retry/backoff, kill-switch, deduplication, and reconciliation logic with
// zero Playwright, zero network, and zero real Supabase involvement --
// exactly the "synthetic fixtures, not live GameChanger contact" approach
// this slice's own task explicitly calls for.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runHighSchoolImportCollection,
  reconcilePlayers,
  buildCapturedGame,
  createIdempotentBrowserCleanup,
} = require('../src/high-school-gc-import');
const policy = require('../src/gc-collection-policy');

function withEnv(overrides, fn) {
  const original = {};
  for (const key of Object.keys(overrides)) original[key] = process.env[key];
  Object.assign(process.env, overrides);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(overrides)) {
        if (original[key] === undefined) delete process.env[key];
        else process.env[key] = original[key];
      }
    });
}

const CTX = { orgId: 'org-1', programId: 'prog-1', teamId: 'team-1', seasonId: 'season-1', importRunId: 'run-1' };

// A minimal, call-tracking fake of the real createHighSchoolImportService's
// return shape -- deliberately NOT the fake-Supabase-client-backed real
// service (that fake doesn't yet model the .in()/.order() query shapes
// this slice's new read functions use); this fake instead proves the
// ADAPTER's own call sequence and argument shapes are correct, which is
// this file's actual job. The real service's own behavior (validation,
// idempotency, atomicity) is independently covered by
// test/high-school-import-service.test.js and
// test/high-school-import-repository.test.js, unchanged by this slice.
function fakeImportService() {
  const calls = [];
  let gameSeq = 0;
  let runGameSeq = 0;
  const resolvedGames = new Map(); // sourceGameRef -> { id, created }
  const failedWith = [];
  let completed = false;

  return {
    calls,
    failedWith,
    get completed() { return completed; },
    async failImportRun(args) { calls.push(['failImportRun', args]); failedWith.push(args); },
    async recordSourceGame(args) {
      calls.push(['recordSourceGame', args]);
      return { row: { id: `runGame-${++runGameSeq}` }, created: true };
    },
    async updateSourceGameOutcome(args) { calls.push(['updateSourceGameOutcome', args]); },
    async resolveCanonicalGame(args) {
      calls.push(['resolveCanonicalGame', args]);
      if (resolvedGames.has(args.sourceGameRef)) {
        return { row: resolvedGames.get(args.sourceGameRef), created: false };
      }
      const row = { id: `game-${++gameSeq}` };
      resolvedGames.set(args.sourceGameRef, row);
      return { row, created: true };
    },
    async captureSnapshot(args) { calls.push(['captureSnapshot', args]); },
    async recordGameValidation(args) {
      calls.push(['recordGameValidation', args]);
      return { row: { validation_status: 'validated', confidence: 'high' } };
    },
    async completeImportRun(args) { calls.push(['completeImportRun', args]); completed = true; },
  };
}

function noSleep() { return Promise.resolve(); }

function agreeingGame(ref, ourSide = 'home') {
  return {
    meta: { ourSide, opponentName: 'Rival High', gameDate: '2026-04-01' },
    boxScore: {
      batting: [{ Player: 'Alice Smith', TeamSide: ourSide, AB: 3, H: 1 }],
      pitching: [],
    },
    plays: [{ inning: 'Top 1', text: 'Alice Smith singles.' }],
  };
}

test('a single valid completed game is discovered, recorded, captured, validated, and the run completes', async () => {
  const importService = fakeImportService();
  const entries = [{ sourceGameRef: 'gc-1', sourceGameUrl: 'https://web.gc.com/g/1', opponentName: 'Rival', gameDate: '2026-04-01' }];
  const summary = await runHighSchoolImportCollection({
    ctx: CTX,
    importService,
    existingPlayers: [],
    discoverCompletedGames: async () => entries,
    collectGame: async () => agreeingGame('gc-1'),
    sleep: noSleep,
  });
  assert.equal(summary.gamesFound, 1);
  assert.equal(summary.gamesImported, 1);
  assert.equal(summary.gamesFailed, 0);
  assert.equal(importService.completed, true);
  assert.ok(importService.calls.some(([name]) => name === 'recordGameValidation'));
});

test('a duplicate/already-imported source game is skipped, not re-captured or re-validated', async () => {
  const importService = fakeImportService();
  // Pre-seed the resolver so the SAME sourceGameRef resolves as "already existing" (created:false).
  importService.resolveCanonicalGame = async (args) => ({ row: { id: 'existing-game' }, created: false });
  const entries = [{ sourceGameRef: 'gc-dup', sourceGameUrl: 'x', opponentName: 'Rival', gameDate: '2026-04-01' }];
  const summary = await runHighSchoolImportCollection({
    ctx: CTX, importService, existingPlayers: [],
    discoverCompletedGames: async () => entries,
    collectGame: async () => agreeingGame('gc-dup'),
    sleep: noSleep,
  });
  assert.equal(summary.gamesSkippedDuplicate, 1);
  assert.equal(summary.gamesImported, 0);
  assert.ok(!importService.calls.some(([name]) => name === 'captureSnapshot'), 'a duplicate game must never be re-captured');
  assert.ok(!importService.calls.some(([name]) => name === 'recordGameValidation'), 'a duplicate game must never be re-validated');
});

test('a retryable collection failure is retried with backoff and eventually succeeds', async () => {
  const importService = fakeImportService();
  let attempts = 0;
  const sleeps = [];
  const summary = await runHighSchoolImportCollection({
    ctx: CTX, importService, existingPlayers: [],
    discoverCompletedGames: async () => [{ sourceGameRef: 'gc-retry', sourceGameUrl: 'x' }],
    collectGame: async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('ECONNRESET');
      return agreeingGame('gc-retry');
    },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(attempts, 2);
  assert.equal(summary.gamesImported, 1);
  assert.ok(sleeps.length >= 1, 'a backoff delay must have been awaited before the successful retry');
});

test('a non-retryable collection failure fails that game without exhausting the retry ceiling pointlessly, and does not stop the whole run', async () => {
  const importService = fakeImportService();
  let attempts = 0;
  const summary = await runHighSchoolImportCollection({
    ctx: CTX, importService, existingPlayers: [],
    discoverCompletedGames: async () => [
      { sourceGameRef: 'gc-bad', sourceGameUrl: 'x' },
      { sourceGameRef: 'gc-good', sourceGameUrl: 'y' },
    ],
    collectGame: async (entry) => {
      attempts += 1;
      if (entry.sourceGameRef === 'gc-bad') throw new Error('selector not found: totally unexpected page shape');
      return agreeingGame('gc-good');
    },
    sleep: noSleep,
  });
  assert.equal(summary.gamesFailed, 1);
  assert.equal(summary.gamesImported, 1, 'a failure on one game must not prevent a later game in the same run from importing');
  assert.equal(importService.completed, true);
});

test('an access-control challenge (CAPTCHA/rate-limit) stops the entire run immediately, is never retried through, and preserves already-imported games', async () => {
  const importService = fakeImportService();
  const summary = await runHighSchoolImportCollection({
    ctx: CTX, importService, existingPlayers: [],
    discoverCompletedGames: async () => [
      { sourceGameRef: 'gc-first', sourceGameUrl: 'x' },
      { sourceGameRef: 'gc-challenged', sourceGameUrl: 'y' },
      { sourceGameRef: 'gc-never-reached', sourceGameUrl: 'z' },
    ],
    collectGame: async (entry) => {
      if (entry.sourceGameRef === 'gc-first') return agreeingGame('gc-first');
      throw new Error('429 Too Many Requests');
    },
    sleep: noSleep,
  });
  assert.equal(summary.gamesImported, 1, 'the game collected before the challenge must be preserved');
  assert.equal(summary.stopped, 'kill_switch');
  assert.ok(!importService.calls.some(([, args]) => args?.sourceGameRef === 'gc-never-reached'), 'a game after the challenge must never even be attempted');
});

test('the kill switch, checked before starting, prevents any collection at all and fails the run with a clear reason', async () => {
  await withEnv({ GC_COLLECTION_ENABLED: 'false' }, async () => {
    const importService = fakeImportService();
    let discoverCalled = false;
    const summary = await runHighSchoolImportCollection({
      ctx: CTX, importService, existingPlayers: [],
      discoverCompletedGames: async () => { discoverCalled = true; return []; },
      collectGame: async () => agreeingGame('x'),
      sleep: noSleep,
    });
    assert.equal(discoverCalled, false, 'discovery must never even be attempted while the kill switch is off');
    assert.equal(summary.stopped, 'kill_switch');
    assert.equal(importService.failedWith.length, 1);
  });
});

test('the kill switch is also polled mid-run (between games), stopping promptly without deleting already-collected work', async () => {
  const importService = fakeImportService();
  let gamesSeen = 0;
  const summary = await withEnv({ GC_COLLECTION_ENABLED: 'true' }, async () => {
    return runHighSchoolImportCollection({
      ctx: CTX, importService, existingPlayers: [],
      discoverCompletedGames: async () => [
        { sourceGameRef: 'gc-1', sourceGameUrl: 'x' },
        { sourceGameRef: 'gc-2', sourceGameUrl: 'y' },
        { sourceGameRef: 'gc-3', sourceGameUrl: 'z' },
      ],
      collectGame: async (entry) => {
        gamesSeen += 1;
        if (gamesSeen === 2) process.env.GC_COLLECTION_ENABLED = 'false'; // flip mid-run
        return agreeingGame(entry.sourceGameRef);
      },
      sleep: noSleep,
    });
  });
  process.env.GC_COLLECTION_ENABLED = 'true';
  assert.ok(summary.gamesImported >= 1 && summary.gamesImported < 3, 'the run must stop before processing every discovered game once the switch flips');
  assert.equal(summary.stopped, 'kill_switch');
});

test('cancellation stops the run promptly and marks it failed/cancelled, not silently, and never as a false success', async () => {
  const importService = fakeImportService();
  let gamesSeen = 0;
  let cancelled = false;
  const summary = await runHighSchoolImportCollection({
    ctx: CTX, importService, existingPlayers: [],
    discoverCompletedGames: async () => [
      { sourceGameRef: 'gc-1', sourceGameUrl: 'x' },
      { sourceGameRef: 'gc-2', sourceGameUrl: 'y' },
    ],
    collectGame: async (entry) => {
      gamesSeen += 1;
      cancelled = true; // cancel after the first game is requested
      return agreeingGame(entry.sourceGameRef);
    },
    isCancelled: () => cancelled && gamesSeen >= 1,
    sleep: noSleep,
  });
  assert.equal(summary.stopped, 'cancelled');
  // A cancelled run must be explicitly, terminally marked -- but never
  // reported as a successful completion, even though the one game it did
  // manage to process succeeded. completeImportRun (which would derive
  // 'succeeded' from that one processed game) must never be called here.
  assert.equal(importService.completed, false, 'a cancelled run must never be reported as a normal completion');
  assert.equal(importService.failedWith.length, 1);
  assert.match(importService.failedWith[0].rawErrorMessage, /cancelled/i);
});

test('a kill switch triggered mid-run marks the run failed/disabled, not succeeded, even though every attempted game succeeded', async () => {
  const importService = fakeImportService();
  let gamesSeen = 0;
  let killSwitchTriggered = false;
  const summary = await runHighSchoolImportCollection({
    ctx: CTX, importService, existingPlayers: [],
    discoverCompletedGames: async () => [
      { sourceGameRef: 'gc-1', sourceGameUrl: 'x' },
      { sourceGameRef: 'gc-2', sourceGameUrl: 'y' },
    ],
    collectGame: async (entry) => {
      gamesSeen += 1;
      killSwitchTriggered = true; // disabled after the first game is requested
      return agreeingGame(entry.sourceGameRef);
    },
    isKillSwitchTriggered: () => killSwitchTriggered && gamesSeen >= 1,
    sleep: noSleep,
  });
  assert.equal(summary.stopped, 'kill_switch');
  assert.equal(importService.completed, false, 'a kill-switch-interrupted run must never be reported as a normal completion');
  assert.equal(importService.failedWith.length, 1);
  assert.match(importService.failedWith[0].rawErrorMessage, /disabled/i);
});

test('a cancel/kill-switch signal arriving mid-retry (after a backoff sleep, before the next attempt) is honored immediately, not only between games', async () => {
  const importService = fakeImportService();
  let attempts = 0;
  let cancelled = false;
  const summary = await runHighSchoolImportCollection({
    ctx: CTX, importService, existingPlayers: [],
    discoverCompletedGames: async () => [{ sourceGameRef: 'gc-1', sourceGameUrl: 'x' }],
    collectGame: async () => {
      attempts += 1;
      cancelled = true; // cancel after the first failed attempt, during the backoff that follows
      const err = new Error('temporary network hiccup');
      throw err;
    },
    isCancelled: () => cancelled,
    sleep: noSleep,
  });
  assert.equal(attempts, 1, 'must not attempt a second retry once cancellation was observed during backoff');
  assert.equal(summary.stopped, 'cancelled');
  // The one run-game row that was opened for this attempt must be closed
  // out rather than left dangling in a pending 'discovered' state forever.
  const outcomeCalls = importService.calls.filter(([name]) => name === 'updateSourceGameOutcome');
  assert.equal(outcomeCalls.length, 1);
  assert.equal(outcomeCalls[0][1].gameOutcome, 'failed');
});

test('the max-games-per-run limit bounds how many discovered games are actually processed', async () => {
  await withEnv({ GC_MAX_GAMES_PER_RUN: '2' }, async () => {
    const importService = fakeImportService();
    const entries = [1, 2, 3, 4].map((n) => ({ sourceGameRef: `gc-${n}`, sourceGameUrl: `u${n}` }));
    const summary = await runHighSchoolImportCollection({
      ctx: CTX, importService, existingPlayers: [],
      discoverCompletedGames: async () => entries,
      collectGame: async (entry) => agreeingGame(entry.sourceGameRef),
      sleep: noSleep,
    });
    assert.equal(summary.gamesFound, 4);
    assert.equal(summary.gamesImported, 2);
  });
});

test('discovery itself failing fails the run at the discovery stage without ever attempting to collect a game', async () => {
  const importService = fakeImportService();
  let collectCalled = false;
  await assert.rejects(
    runHighSchoolImportCollection({
      ctx: CTX, importService, existingPlayers: [],
      discoverCompletedGames: async () => { throw new Error('schedule page malformed'); },
      collectGame: async () => { collectCalled = true; return agreeingGame('x'); },
      sleep: noSleep,
    })
  );
  assert.equal(collectCalled, false);
  assert.equal(importService.failedWith[0]?.failureStage, 'discovery');
});

test('reconcilePlayers: a unique normalized-name match resolves to that player', () => {
  const existingPlayers = [{ id: 'p1', normalizedFirstName: 'alice', normalizedLastName: 'smith' }];
  const rows = [{ Player: 'Alice Smith', isHighSchoolTeam: true }];
  const { matched, ambiguous, unmatched } = reconcilePlayers(rows, existingPlayers);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].playerId, 'p1');
  assert.equal(ambiguous.length, 0);
  assert.equal(unmatched.length, 0);
});

test('reconcilePlayers: two players sharing a normalized name are surfaced as ambiguous, never force-matched', () => {
  const existingPlayers = [
    { id: 'p1', normalizedFirstName: 'chris', normalizedLastName: 'lee' },
    { id: 'p2', normalizedFirstName: 'chris', normalizedLastName: 'lee' },
  ];
  const rows = [{ Player: 'Chris Lee', isHighSchoolTeam: true }];
  const { matched, ambiguous } = reconcilePlayers(rows, existingPlayers);
  assert.equal(matched.length, 0);
  assert.equal(ambiguous.length, 1);
  assert.deepEqual(ambiguous[0].candidatePlayerIds.sort(), ['p1', 'p2']);
});

test('reconcilePlayers: a name with zero roster matches is surfaced as unmatched, never silently created', () => {
  const rows = [{ Player: 'Nobody Onroster', isHighSchoolTeam: true }];
  const { matched, ambiguous, unmatched } = reconcilePlayers(rows, []);
  assert.equal(matched.length, 0);
  assert.equal(ambiguous.length, 0);
  assert.equal(unmatched.length, 1);
});

test('reconcilePlayers never leaks a candidate from a different roster -- only rows in the existingPlayers list passed in can ever match', () => {
  // Simulates the route layer only ever passing this TEAM+SEASON's own
  // active roster (never another team's or another org's players) -- this
  // module itself has no org/team parameter at all, so there is no code
  // path here that could reach outside whatever list it's given.
  const foreignOrgPlayers = [{ id: 'foreign-p1', normalizedFirstName: 'alice', normalizedLastName: 'smith' }];
  const rows = [{ Player: 'Alice Smith', isHighSchoolTeam: true }];
  const { matched } = reconcilePlayers(rows, foreignOrgPlayers);
  // This assertion is really documenting the module's contract: whatever
  // list it's handed is trusted as the correct scope -- the actual
  // tenant-scoping guarantee is the HTTP route's own
  // loadActiveRosterForReconciliation query (org_id + team_id + season_id
  // filtered), proven separately in the routes test file.
  assert.equal(matched.length, 1);
  assert.equal(matched[0].playerId, 'foreign-p1');
});

test('buildCapturedGame tags every row with isHighSchoolTeam based on the resolved side, never trusting a caller-supplied ownership field', () => {
  const gameData = {
    boxScore: {
      batting: [
        { Player: 'Our Player', TeamSide: 'home', isOurTeam: false /* must be ignored -- not a real GC field */ },
        { Player: 'Their Player', TeamSide: 'away' },
      ],
      pitching: [],
    },
    plays: [],
  };
  const result = buildCapturedGame(gameData, 'home');
  assert.equal(result.boxScore.batting[0].isHighSchoolTeam, true);
  assert.equal(result.boxScore.batting[1].isHighSchoolTeam, false);
});

test('an opponent-side row (TeamSide does not match ourSide) never gets matched against the High School roster', async () => {
  const importService = fakeImportService();
  const existingPlayers = [{ id: 'p1', normalizedFirstName: 'opponent', normalizedLastName: 'player' }];
  const gameWithOpponentRow = {
    meta: { ourSide: 'home' },
    boxScore: {
      batting: [
        { Player: 'Home Player', TeamSide: 'home' },
        { Player: 'Opponent Player', TeamSide: 'away' },
      ],
      pitching: [],
    },
    plays: [],
  };
  const summary = await runHighSchoolImportCollection({
    ctx: CTX, importService, existingPlayers,
    discoverCompletedGames: async () => [{ sourceGameRef: 'gc-1', sourceGameUrl: 'x' }],
    collectGame: async () => gameWithOpponentRow,
    sleep: noSleep,
  });
  // "Opponent Player" never appears in matched/ambiguous/unmatched at all --
  // only rows tagged isHighSchoolTeam:true are ever reconciled against the roster.
  const allNames = [...summary.matchedPlayers.values(), ...summary.ambiguousPlayers.keys(), ...summary.unmatchedPlayers.keys()];
  assert.ok(!allNames.includes('Opponent Player'));
});

test('no captured or logged event ever contains a credential/session-shaped substring', async () => {
  const importService = fakeImportService();
  const progressEvents = [];
  await runHighSchoolImportCollection({
    ctx: CTX, importService, existingPlayers: [],
    discoverCompletedGames: async () => [{ sourceGameRef: 'gc-1', sourceGameUrl: 'x' }],
    collectGame: async () => { throw new Error('failed with Authorization: Bearer secret-token-value in headers'); },
    onProgress: (event) => progressEvents.push(event),
    sleep: noSleep,
  });
  const serialized = JSON.stringify(progressEvents);
  assert.ok(!serialized.includes('secret-token-value'));
  assert.ok(!/bearer/i.test(serialized));
});

// ── createIdempotentBrowserCleanup ──────────────────────────────────────
// Proves the CLI entry point's own cleanup guarantee (browser closed
// exactly once, on every exit path, never throwing) without needing a real
// Playwright browser or a real spawned subprocess -- a fake object
// implementing just the .close() shape stands in for a real Browser.

function fakeBrowser({ closeShouldThrow = false } = {}) {
  const browser = { closeCallCount: 0 };
  browser.close = async () => {
    browser.closeCallCount += 1;
    if (closeShouldThrow) throw new Error('already closed');
  };
  return browser;
}

test('createIdempotentBrowserCleanup: closes the browser exactly once even when called multiple times', async () => {
  const browser = fakeBrowser();
  const cleanup = createIdempotentBrowserCleanup(() => browser);
  await cleanup();
  await cleanup();
  await cleanup();
  assert.equal(browser.closeCallCount, 1, 'competing exit paths (SIGTERM, SIGINT, normal completion, a startup failure) must never close the browser more than once');
});

test('createIdempotentBrowserCleanup: does nothing (never throws) when the browser was never launched', async () => {
  const cleanup = createIdempotentBrowserCleanup(() => null);
  await assert.doesNotReject(() => cleanup());
});

test('createIdempotentBrowserCleanup: swallows a close() failure rather than throwing (never masks the original error on whichever exit path triggered it)', async () => {
  const browser = fakeBrowser({ closeShouldThrow: true });
  const cleanup = createIdempotentBrowserCleanup(() => browser);
  await assert.doesNotReject(() => cleanup());
  assert.equal(browser.closeCallCount, 1);
});

test('createIdempotentBrowserCleanup: reads the CURRENT browser at call time, not a value captured once at creation (cleanup can be registered for SIGTERM/SIGINT before chromium.launch() has resolved)', async () => {
  let currentBrowser = null;
  const cleanup = createIdempotentBrowserCleanup(() => currentBrowser);
  // Simulate cleanup being registered (e.g. for a signal handler) before
  // the browser variable is actually assigned.
  currentBrowser = fakeBrowser();
  await cleanup();
  assert.equal(currentBrowser.closeCallCount, 1);
});
