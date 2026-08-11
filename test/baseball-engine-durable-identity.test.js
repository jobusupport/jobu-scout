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

test('batting and fielding contributions merge into one durable batter record', () => {
  const stats = computeBaseballStats([game('field-1', [
    { Player: 'Bailey Example', own: true, TeamSide: 'home', playerId: 'bailey-id' },
    { Player: 'Rival Hitter', own: false, TeamSide: 'away', playerId: 'rival-id' },
  ], [
    { inning: 'Bottom 1', batterId: 'bailey-id', text: 'Single. Bailey Example singles to left field, Dana Pitcher pitching.' },
    { inning: 'Top 2', batterId: 'rival-id', fielderId: 'bailey-id', text: 'Error. Rival Hitter reaches on an error by shortstop Bailey Example, Dana Pitcher pitching.' },
  ])]);

  assert.deepEqual(Object.keys(stats.ownBatters), ['bailey-id']);
  assert.equal(stats.ownBatters['bailey-id'].playerId, 'bailey-id');
  assert.equal(stats.ownBatters['bailey-id'].H, 1);
  assert.equal(stats.ownBatters['bailey-id'].E, 1);
  assert.equal(stats.ownBatters['bailey-id'].games, 1);
});

test('same-named opposing fielders remain separate by side and explicit ID', () => {
  const batting = [
    { Player: 'Bailey Example', own: true, TeamSide: 'home', playerId: 'own-bailey' },
    { Player: 'Bailey Example', own: false, TeamSide: 'away', playerId: 'opp-bailey' },
    { Player: 'Own Hitter', own: true, TeamSide: 'home', playerId: 'own-hitter' },
    { Player: 'Away Hitter', own: false, TeamSide: 'away', playerId: 'away-hitter' },
  ];
  const plays = [
    { inning: 'Top 1', batterId: 'away-hitter', fielderId: 'own-bailey', text: 'Error. Away Hitter reaches on an error by shortstop Bailey Example, Dana Pitcher pitching.' },
    { inning: 'Bottom 1', batterId: 'own-hitter', fielderId: 'opp-bailey', text: 'Error. Own Hitter reaches on an error by shortstop Bailey Example, Dana Pitcher pitching.' },
  ];
  const stats = computeBaseballStats([game('field-2', batting, plays)]);

  assert.equal(stats.ownBatters['own-bailey'].E, 1);
  assert.equal(stats.opponentBatters['opp-bailey'].E, 1);
  assert.equal(stats.ownBatters['opp-bailey'], undefined);
  assert.equal(stats.opponentBatters['own-bailey'], undefined);
});

test('explicit fielder ID remains authoritative across a display-name variation', () => {
  const stats = computeBaseballStats([game('field-id', [
    { Player: 'Bailey Example', own: true, TeamSide: 'home', playerId: 'bailey-id' },
    { Player: 'Away Hitter', own: false, TeamSide: 'away', playerId: 'away-id' },
  ], [
    { inning: 'Top 1', batterId: 'away-id', fielderId: 'bailey-id', text: 'Error. Away Hitter reaches on an error by shortstop Bailey Changed, Dana Pitcher pitching.' },
  ])]);

  assert.equal(stats.ownBatters['bailey-id'].E, 1);
  assert.equal(stats.ownBatters['bailey-id'].playerId, 'bailey-id');
  assert.equal(stats.unresolvedBatters['bailey-id'], undefined);
});

test('same-named opposing fielders use inning-derived defense side without arbitrary own bias', () => {
  const batting = [
    { Player: 'Bailey Example', own: true, TeamSide: 'home', playerId: 'own-bailey' },
    { Player: 'Bailey Example', own: false, TeamSide: 'away', playerId: 'opp-bailey' },
    { Player: 'Own Hitter', own: true, TeamSide: 'home', playerId: 'own-hitter' },
    { Player: 'Away Hitter', own: false, TeamSide: 'away', playerId: 'away-hitter' },
  ];
  const plays = [
    { inning: 'Top 1', batterId: 'away-hitter', text: 'Error. Away Hitter reaches on an error by shortstop Bailey Example, Dana Pitcher pitching.' },
    { inning: 'Bottom 1', batterId: 'own-hitter', text: 'Error. Own Hitter reaches on an error by shortstop Bailey Example, Dana Pitcher pitching.' },
  ];
  const forward = computeBaseballStats([game('field-3', batting, plays)]);

  assert.equal(forward.ownBatters['own-bailey'].E, 1);
  assert.equal(forward.opponentBatters['opp-bailey'].E, 1);
});

test('ambiguous fielder name without side or ID is explicitly unresolved', () => {
  const stats = computeBaseballStats([game('field-4', [
    { Player: 'Bailey Example', own: true, TeamSide: 'home', playerId: 'own-bailey' },
    { Player: 'Bailey Example', own: false, TeamSide: 'away', playerId: 'opp-bailey' },
  ], [
    { text: 'Error. Unknown Hitter reaches on an error by shortstop Bailey Example, Dana Pitcher pitching.' },
  ])]);

  assert.equal(stats.ownBatters['own-bailey'], undefined);
  assert.equal(stats.opponentBatters['opp-bailey'], undefined);
  const unresolved = Object.values(stats.unresolvedBatters);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].E, 1);
  assert.equal(unresolved[0].identity.resolved, false);
  assert.equal(unresolved[0].identity.side, null);
});

test('fielder without an ID remains unresolved but retains known side context', () => {
  const stats = computeBaseballStats([game('field-5', [
    { Player: 'Bailey Example', own: true, TeamSide: 'home' },
    { Player: 'Away Hitter', own: false, TeamSide: 'away', playerId: 'away-hitter' },
  ], [
    { inning: 'Top 1', batterId: 'away-hitter', text: 'Error. Away Hitter reaches on an error by shortstop Bailey Example, Dana Pitcher pitching.' },
  ])]);

  const unresolved = Object.values(stats.unresolvedBatters);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].E, 1);
  assert.equal(unresolved[0].identity.side, 'own');
  assert.match(unresolved[0].identity.context, /:own:fielder$/);
});

test('durable fielding totals are deterministic under alternate game ordering', () => {
  const first = game('field-order-a', [
    { Player: 'Bailey Example', own: true, TeamSide: 'home', playerId: 'bailey-id' },
    { Player: 'Away Hitter', own: false, TeamSide: 'away', playerId: 'away-a' },
  ], [
    { inning: 'Top 1', batterId: 'away-a', fielderId: 'bailey-id', text: 'Error. Away Hitter reaches on an error by shortstop Bailey Example, Dana Pitcher pitching.' },
  ]);
  const second = game('field-order-b', [
    { Player: 'Bailey Example', own: true, TeamSide: 'home', playerId: 'bailey-id' },
    { Player: 'Other Hitter', own: false, TeamSide: 'away', playerId: 'away-b' },
  ], [
    { inning: 'Top 2', batterId: 'away-b', fielderId: 'bailey-id', text: 'Error. Other Hitter reaches on an error by shortstop Bailey Example, Dana Pitcher pitching.' },
  ]);

  const forward = computeBaseballStats([first, second]);
  const reverse = computeBaseballStats([second, first]);
  assert.deepEqual(forward, reverse);
  assert.equal(forward.ownBatters['bailey-id'].E, 2);
  assert.equal(forward.ownBatters['bailey-id'].games, 2);
});
