'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeBaseballStats } = require('../src/engine/baseball-engine');

function game(id, batting, plays, ourSide = 'home') {
  return { meta: { gameId: id, ourSide }, boxScore: { batting, pitching: [] }, plays };
}

test('same-named players with different durable IDs remain separate and correct', () => {
  const stats = computeBaseballStats([game('g1', [
    { Player: 'Jordan Smith', own: true, TeamSide: 'home', playerId: 'p1' },
    { Player: 'Jordan Smith', own: true, TeamSide: 'home', playerId: 'p2' },
  ], [
    { batterId: 'p1', text: 'Single. Jordan Smith singles to left field, D Pitcher pitching.' },
    { batterId: 'p2', text: 'Double. Jordan Smith doubles to right field, D Pitcher pitching.' },
  ])]);
  assert.deepEqual(Object.keys(stats.ownBatters).sort(), ['p1', 'p2']);
  assert.equal(stats.ownBatters.p1.singles, 1);
  assert.equal(stats.ownBatters.p2.doubles, 1);
});

test('same name on opposing sides is separated using inning and durable IDs', () => {
  const stats = computeBaseballStats([game('g2', [
    { Player: 'J Smith', own: true, TeamSide: 'home', playerId: 'own-j' },
    { Player: 'J Smith', own: false, TeamSide: 'away', playerId: 'opp-j' },
  ], [
    { inning: 'Bottom 1', batterId: 'own-j', text: 'Single. J Smith singles to left field, D Pitcher pitching.' },
    { inning: 'Top 2', batterId: 'opp-j', text: 'Double. J Smith doubles to right field, D Pitcher pitching.' },
  ])]);
  assert.equal(stats.ownBatters['own-j'].H, 1);
  assert.equal(stats.opponentBatters['opp-j'].doubles, 1);
});

test('stable ID accumulates through a name change with deterministic canonical name', () => {
  const games = [
    game('g3a', [{ Player: 'Zed Alias', own: true, TeamSide: 'home', playerId: 'p3' }], [{ batterId: 'p3', text: 'Single. Zed Alias singles to left field, D Pitcher pitching.' }]),
    game('g3b', [{ Player: 'Alpha Name', own: true, TeamSide: 'home', playerId: 'p3' }], [{ batterId: 'p3', text: 'Walk. Alpha Name walks, D Pitcher pitching.' }]),
  ];
  const forward = computeBaseballStats(games);
  const reverse = computeBaseballStats([...games].reverse());
  assert.deepEqual(forward, reverse);
  assert.equal(forward.ownBatters.p3.PA, 2);
  assert.equal(forward.ownBatters.p3.name, 'Alpha Name');
});

test('aliases without a shared ID remain separate', () => {
  const stats = computeBaseballStats([game('g4', [
    { Player: 'Alex One', own: true, TeamSide: 'home', playerId: 'p4a' },
    { Player: 'A One', own: true, TeamSide: 'home', playerId: 'p4b' },
  ], [
    { batterId: 'p4a', text: 'Single. Alex One singles to left field, D Pitcher pitching.' },
    { batterId: 'p4b', text: 'Walk. A One walks, D Pitcher pitching.' },
  ])]);
  assert.deepEqual(Object.keys(stats.ownBatters).sort(), ['p4a', 'p4b']);
});

test('missing IDs are explicit and isolated by game context', () => {
  const stats = computeBaseballStats([
    game('g5a', [{ Player: 'A Sample', own: true, TeamSide: 'home' }], [{ text: 'Single. A Sample singles to left field, D Pitcher pitching.' }]),
    game('g5b', [{ Player: 'A Sample', own: true, TeamSide: 'home' }], [{ text: 'Walk. A Sample walks, D Pitcher pitching.' }]),
  ]);
  assert.deepEqual(stats.ownBatters, {});
  assert.equal(Object.keys(stats.unresolvedBatters).length, 2);
  for (const value of Object.values(stats.unresolvedBatters)) assert.equal(value.identity.resolved, false);
});

test('one durable ID with conflicting names resolves deterministically', () => {
  const a = game('g6a', [{ Player: 'Zulu', own: true, TeamSide: 'home', playerId: 'p6' }], [{ batterId: 'p6', text: 'Single. Zulu singles to left field, D Pitcher pitching.' }]);
  const b = game('g6b', [{ Player: 'Alpha', own: true, TeamSide: 'home', playerId: 'p6' }], [{ batterId: 'p6', text: 'Single. Alpha singles to left field, D Pitcher pitching.' }]);
  assert.deepEqual(computeBaseballStats([a, b]), computeBaseballStats([b, a]));
  assert.equal(computeBaseballStats([a, b]).ownBatters.p6.name, 'Alpha');
});
