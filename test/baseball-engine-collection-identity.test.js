'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reconstructBaseballTeamGames, computeBaseballStats, _internals } = require('../src/engine/baseball-engine');

function snapshot(gameId, { hits = 1, plays = 0, complete = false } = {}) {
  return { meta: { gameId, complete, gameDate: '2026-04-01', homeTeam: 'Synthetic Home', awayTeam: 'Synthetic Away' }, boxScore: { batting: [{ Player: 'A Sample', playerId: 'p-a', own: true, TeamSide: 'home', AB: hits, H: hits }], pitching: [] }, plays: Array.from({ length: plays }, (_, i) => ({ batterId: 'p-a', inning: `Bottom ${i + 1}`, text: 'Single. A Sample singles to left field, D Pitcher pitching.' })) };
}

test('identical replay and duplicate snapshots are counted once', () => {
  const game = snapshot('source-1', { hits: 1, plays: 1 });
  const result = reconstructBaseballTeamGames('team', [game, structuredClone(game)]);
  assert.equal(result.summary.games, 1); assert.equal(result.summary.officialBatting.h, 1);
});

test('partial-to-complete reconciliation selects the most complete snapshot independent of order', () => {
  const partial = snapshot('source-2', { hits: 1, plays: 1 });
  const complete = snapshot('source-2', { hits: 2, plays: 2, complete: true });
  const a = reconstructBaseballTeamGames('team', [partial, complete]);
  const b = reconstructBaseballTeamGames('team', [complete, partial]);
  assert.deepEqual(a, b); assert.equal(a.summary.officialBatting.h, 2);
});

test('equal-completeness conflicting snapshots use deterministic canonical tie-break', () => {
  const left = snapshot('source-3', { hits: 1, plays: 1 });
  const right = snapshot('source-3', { hits: 2, plays: 1 });
  assert.deepEqual(reconstructBaseballTeamGames('team', [left, right]), reconstructBaseballTeamGames('team', [right, left]));
});

test('true doubleheaders remain distinct by source ID', () => {
  assert.equal(reconstructBaseballTeamGames('team', [snapshot('dh-1'), snapshot('dh-2')]).summary.games, 2);
});

test('fallback identity uses date, teams, and schedule discriminator', () => {
  const first = snapshot(null); const second = snapshot(null);
  delete first.meta.gameId; delete second.meta.gameId; first.meta.startTime = '10:00'; second.meta.startTime = '13:00';
  const result = reconstructBaseballTeamGames('team', [first, structuredClone(first), second]);
  assert.equal(result.summary.games, 2); assert.ok(result.gameResults.every((game) => game.identity.method === 'scheduleComposite'));
});

test('ambiguous fallback identity is explicit and only exact replays collapse', () => {
  const first = snapshot(null, { hits: 1 }); delete first.meta.gameId;
  const distinct = snapshot(null, { hits: 2 }); delete distinct.meta.gameId;
  const result = reconstructBaseballTeamGames('team', [first, structuredClone(first), distinct]);
  assert.equal(result.summary.games, 2); assert.ok(result.gameResults.every((game) => game.identity.resolved === false));
});

test('stats collection also deduplicates source replays', () => {
  const game = snapshot('source-stats', { plays: 1 });
  assert.equal(computeBaseballStats([game, structuredClone(game)]).ownBatters['p-a'].PA, 1);
});

test('canonical identity helpers do not mutate input', () => {
  const game = snapshot('source-pure'); const before = structuredClone(game);
  assert.equal(_internals.canonicalGameIdentity(game).key, 'source:source-pure');
  _internals.reconcileGameCollection([game, structuredClone(game)]); assert.deepEqual(game, before);
});
