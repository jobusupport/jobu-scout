'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  reconstructBaseballTeamGames,
  computeBaseballStats,
  _internals,
} = require('../src/engine/baseball-engine');

function snapshot(gameId, options = {}) {
  const {
    hits = 1,
    plays = 0,
    complete = false,
    playerId = 'p-a',
    meta = {},
    own = true,
    side = 'home',
  } = options;
  const gameMeta = {
    complete,
    gameDate: '2026-04-01',
    homeTeam: 'Synthetic Home',
    awayTeam: 'Synthetic Away',
    ...meta,
  };
  if (gameId != null) gameMeta.gameId = gameId;
  const batter = { Player: 'A Sample', own, TeamSide: side, AB: hits, H: hits };
  if (playerId != null) batter.playerId = playerId;
  return {
    meta: gameMeta,
    boxScore: { batting: [batter], pitching: [] },
    plays: Array.from({ length: plays }, (_, index) => ({
      ...(playerId == null ? {} : { batterId: playerId }),
      inning: `Bottom ${index + 1}`,
      text: 'Single. A Sample singles to left field, D Pitcher pitching.',
    })),
  };
}

function scheduleGame(startTime, options = {}) {
  return snapshot(null, { ...options, meta: { startTime, ...(options.meta || {}) } });
}

test('identical unresolved records remain two logical games and are never fingerprint-deduplicated', () => {
  const game = snapshot(null);
  const result = reconstructBaseballTeamGames('team', [game, structuredClone(game)]);
  assert.equal(result.summary.games, 2);
  assert.equal(result.gameResults.length, 2);
  assert.deepEqual(result.gameResults.map(({ identity }) => identity.resolved), [false, false]);
  assert.deepEqual(result.gameResults.map(({ identity }) => identity.reconciliation.automaticDeduplication), [false, false]);
  assert.notEqual(result.gameResults[0].identity.key, result.gameResults[1].identity.key);
});

test('indistinguishable unresolved doubleheader games remain separate', () => {
  const first = snapshot(null, { meta: { event: 'Synthetic doubleheader' } });
  const second = structuredClone(first);
  const result = reconstructBaseballTeamGames('team', [first, second]);
  assert.equal(result.summary.games, 2);
  assert.ok(result.gameResults.every(({ identity }) => identity.method === 'unresolvedScoped'));
});

test('reordering identical unresolved inputs produces the same complete output', () => {
  const first = snapshot(null);
  const second = structuredClone(first);
  assert.deepEqual(
    reconstructBaseballTeamGames('team', [first, second]),
    reconstructBaseballTeamGames('team', [second, first]),
  );
});

test('a replay with a proven durable identity is deduplicated', () => {
  const game = snapshot('source-1', { plays: 1 });
  const result = reconstructBaseballTeamGames('team', [game, structuredClone(game)]);
  assert.equal(result.summary.games, 1);
  assert.equal(result.gameResults[0].identity.reconciliation.status, 'deduplicated');
  assert.equal(result.gameResults[0].identity.reconciliation.candidateCount, 2);
});

test('a content fingerprint is diagnostic only and never establishes resolved identity', () => {
  const identity = _internals.canonicalGameIdentity(snapshot(null));
  assert.equal(identity.resolved, false);
  assert.equal(identity.key, null);
  assert.equal(typeof identity.fingerprint, 'string');
});

test('a compatible partial and complete snapshot reconciles without conflict', () => {
  const partial = snapshot('source-2', { hits: 1, plays: 1 });
  delete partial.meta.awayTeam;
  const complete = snapshot('source-2', { hits: 2, plays: 2, complete: true, meta: { scoreUs: 4, scoreThem: 2 } });
  complete.boxScore.batting.push({ Player: 'Opponent Sample', own: false, TeamSide: 'away', AB: 2, H: 0 });
  const result = reconstructBaseballTeamGames('team', [partial, complete]);
  assert.equal(result.summary.officialBatting.h, 2);
  assert.deepEqual(result.gameResults[0].identity.reconciliation.conflictFields, []);
  assert.equal(result.gameResults[0].identity.reconciliation.status, 'reconciled');
});

test('conflicting final scores sharing a durable identity are surfaced', () => {
  const left = snapshot('source-score', { complete: true, meta: { scoreUs: 4, scoreThem: 2 } });
  const right = snapshot('source-score', { complete: true, meta: { scoreUs: 5, scoreThem: 2 } });
  const reconciliation = reconstructBaseballTeamGames('team', [left, right]).gameResults[0].identity.reconciliation;
  assert.equal(reconciliation.status, 'conflict');
  assert.deepEqual(reconciliation.conflictFields, ['scoreUs']);
  assert.equal(reconciliation.candidateFingerprints.length, 2);
});

test('conflicting team and ownership facts sharing a durable identity are surfaced', () => {
  const left = snapshot('source-team');
  const right = snapshot('source-team', { own: false, meta: { homeTeam: 'Different Home' } });
  const reconciliation = reconstructBaseballTeamGames('team', [left, right]).gameResults[0].identity.reconciliation;
  assert.equal(reconciliation.status, 'conflict');
  assert.deepEqual(reconciliation.conflictFields, ['homeTeam', 'ownership.home']);
});

test('conflict reconciliation is deterministic regardless of input order', () => {
  const left = snapshot('source-order', { complete: true, meta: { scoreUs: 4, scoreThem: 2 } });
  const right = snapshot('source-order', { complete: true, meta: { scoreUs: 5, scoreThem: 2 } });
  assert.deepEqual(
    reconstructBaseballTeamGames('team', [left, right]),
    reconstructBaseballTeamGames('team', [right, left]),
  );
});

test('blank, whitespace, and missing schedule discriminators all remain unresolved', () => {
  for (const discriminator of [undefined, '', '   ']) {
    const game = scheduleGame(discriminator);
    if (discriminator === undefined) delete game.meta.startTime;
    const identity = _internals.canonicalGameIdentity(game);
    assert.equal(identity.resolved, false);
    assert.equal(identity.method, 'unresolvedScoped');
  }
});

test('blank higher-priority identity fields do not hide meaningful documented fallbacks', () => {
  const game = scheduleGame('10:00 AM', {
    meta: { sourceGameId: ' ', gameId: 'durable-fallback', scheduledStart: ' ', homeTeamId: '' },
  });
  const durable = _internals.canonicalGameIdentity(game);
  assert.equal(durable.method, 'sourceGameId');
  assert.equal(durable.key, 'source:["durable-fallback"]');

  delete game.meta.gameId;
  const schedule = _internals.canonicalGameIdentity(game);
  assert.equal(schedule.method, 'scheduleComposite');
  assert.equal(schedule.resolved, true);
});

test('same-date games with blank start times do not collapse', () => {
  const game = scheduleGame('   ');
  assert.equal(reconstructBaseballTeamGames('team', [game, structuredClone(game)]).summary.games, 2);
});

test('a complete normalized schedule composite resolves and separates games', () => {
  const first = scheduleGame(' 10:00 AM ');
  const second = scheduleGame('1:00 PM');
  const result = reconstructBaseballTeamGames('team', [first, structuredClone(first), second]);
  assert.equal(result.summary.games, 2);
  assert.ok(result.gameResults.every(({ identity }) => identity.resolved && identity.method === 'scheduleComposite'));
  assert.match(result.gameResults[0].identity.key, /^fallback:\[/);
});

test('fallback identity normalizes whitespace and case without changing meaning', () => {
  const first = scheduleGame(' 10:00 AM ', { meta: { homeTeam: 'SYNTHETIC   HOME' } });
  const second = scheduleGame('10:00 am', { meta: { homeTeam: 'synthetic home' } });
  assert.equal(_internals.canonicalGameIdentity(first).key, _internals.canonicalGameIdentity(second).key);
});

test('structured fallback keys cannot collide when values contain delimiters', () => {
  const left = scheduleGame('C', { meta: { homeTeam: 'A|B', awayTeam: 'D' } });
  const right = scheduleGame('C', { meta: { homeTeam: 'A', awayTeam: 'B|D' } });
  assert.notEqual(_internals.canonicalGameIdentity(left).key, _internals.canonicalGameIdentity(right).key);
});

test('schedule-composite and unresolved collection identities remain distinct in stats', () => {
  const first = scheduleGame('10:00', { plays: 1, playerId: null });
  const second = scheduleGame('13:00', { plays: 1, playerId: null });
  const resolved = computeBaseballStats([second, first]);
  assert.equal(Object.keys(resolved.unresolvedBatters).length, 2);
  assert.ok(Object.values(resolved.unresolvedBatters).every((player) => player.games === 1));
  assert.deepEqual(resolved.gameIdentities.map(({ method }) => method), ['scheduleComposite', 'scheduleComposite']);

  const ambiguousA = snapshot(null, { plays: 1, playerId: null, hits: 1 });
  const ambiguousB = snapshot(null, { plays: 1, playerId: null, hits: 2 });
  const unresolved = computeBaseballStats([ambiguousB, ambiguousA]);
  assert.equal(unresolved.gameIdentities.length, 2);
  assert.ok(unresolved.gameIdentities.every(({ method, resolved: isResolved }) => method === 'unresolvedScoped' && !isResolved));
  assert.equal(Object.keys(unresolved.unresolvedBatters).length, 2);
  assert.deepEqual(unresolved, computeBaseballStats([ambiguousA, ambiguousB]));
});

test('a durable replay counts as one statistical game and exposes durable provenance', () => {
  const game = snapshot('source-stats', { plays: 1 });
  const stats = computeBaseballStats([game, structuredClone(game)]);
  assert.equal(stats.ownBatters['p-a'].PA, 1);
  assert.equal(stats.ownBatters['p-a'].games, 1);
  assert.equal(stats.gameIdentities.length, 1);
  assert.deepEqual(
    { method: stats.gameIdentities[0].method, durable: stats.gameIdentities[0].durable },
    { method: 'sourceGameId', durable: true },
  );
});

test('identity helpers do not mutate input', () => {
  const game = snapshot('source-pure');
  const before = structuredClone(game);
  assert.equal(_internals.canonicalGameIdentity(game).key, 'source:["source-pure"]');
  _internals.reconcileGameCollection([game, structuredClone(game)]);
  assert.deepEqual(game, before);
});
