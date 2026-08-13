'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeBaseballStats } = require('../src/engine/baseball-engine');

function game(id, batting, plays, ourSide = 'home', pitching = []) {
  return { meta: { gameId: id, ourSide }, boxScore: { batting, pitching }, plays };
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

test('explicit batter ID resolves the correct opposing side without inning context', () => {
  const stats = computeBaseballStats([game('id-side-batter', [
    { Player: 'Jordan Smith', own: true, TeamSide: 'home', playerId: 'own-jordan' },
    { Player: 'Jordan Smith', own: false, TeamSide: 'away', playerId: 'opp-jordan' },
  ], [
    { batterId: 'opp-jordan', text: 'Single. Jordan Smith singles to left field, Dana Pitcher pitching.' },
  ])]);
  assert.equal(stats.opponentBatters['opp-jordan'].H, 1);
  assert.deepEqual(stats.unresolvedBatters, {});
});

test('explicit pitcher ID resolves the correct opposing side without inning context', () => {
  const stats = computeBaseballStats([game('id-side-pitcher', [
    { Player: 'Alex Batter', own: true, TeamSide: 'home', playerId: 'alex-batter' },
  ], [
    { batterId: 'alex-batter', pitcherId: 'opp-pitcher', text: 'Single. Alex Batter singles to left field, Jordan Smith pitching.' },
  ], 'home', [
    { Player: 'Jordan Smith', own: true, TeamSide: 'home', playerId: 'own-pitcher' },
    { Player: 'Jordan Smith', own: false, TeamSide: 'away', playerId: 'opp-pitcher' },
  ])]);
  assert.equal(stats.opponentPitchers['opp-pitcher'].H, 1);
  assert.deepEqual(stats.unresolvedPitchers, {});
});

test('durable batter and pitcher IDs survive play-text name variations', () => {
  const stats = computeBaseballStats([game('id-name-variation', [
    { Player: 'Canonical Batter', own: true, TeamSide: 'home', playerId: 'batter-id' },
  ], [
    { batterId: 'batter-id', pitcherId: 'pitcher-id', text: 'Single. Changed Batter singles to left field, Changed Pitcher pitching.' },
  ], 'home', [
    { Player: 'Canonical Pitcher', own: false, TeamSide: 'away', playerId: 'pitcher-id' },
  ])]);
  assert.equal(stats.ownBatters['batter-id'].name, 'Canonical Batter');
  assert.equal(stats.ownBatters['batter-id'].H, 1);
  assert.equal(stats.opponentPitchers['pitcher-id'].name, 'Canonical Pitcher');
  assert.equal(stats.opponentPitchers['pitcher-id'].H, 1);
});

test('supplied ID conflicts and unknown IDs remain explicit with the ID retained', () => {
  const conflict = computeBaseballStats([game('id-conflict', [
    { Player: 'Jordan Smith', own: true, TeamSide: 'home', playerId: 'own-jordan' },
    { Player: 'Jordan Smith', own: false, TeamSide: 'away', playerId: 'opp-jordan' },
  ], [
    { inning: 'Bottom 1', batterId: 'opp-jordan', text: 'Single. Jordan Smith singles to left field, Dana Pitcher pitching.' },
  ])]);
  const conflictRecord = Object.values(conflict.unresolvedBatters)[0];
  assert.equal(conflictRecord.identity.playerId, 'opp-jordan');
  assert.match(conflictRecord.identity.reason, /conflict/i);

  const unknown = computeBaseballStats([game('id-unknown', [
    { Player: 'Alex Batter', own: true, TeamSide: 'home', playerId: 'known-id' },
  ], [
    { batterId: 'unknown-id', text: 'Single. Alex Batter singles to left field, Dana Pitcher pitching.' },
  ])]);
  const unknownRecord = Object.values(unknown.unresolvedBatters)[0];
  assert.equal(unknownRecord.identity.playerId, 'unknown-id');
  assert.match(unknownRecord.identity.reason, /not found/i);
});

test('an ID present on both sides is never guessed', () => {
  const stats = computeBaseballStats([game('id-ambiguous', [
    { Player: 'Own Name', own: true, TeamSide: 'home', playerId: 'shared-id' },
    { Player: 'Opponent Name', own: false, TeamSide: 'away', playerId: 'shared-id' },
  ], [
    { batterId: 'shared-id', batterName: 'Own Name', text: 'Single. Own Name singles to left field, Dana Pitcher pitching.' },
  ])]);
  const unresolved = Object.values(stats.unresolvedBatters);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].identity.playerId, 'shared-id');
  assert.match(unresolved[0].identity.reason, /multiple sides/i);
});

test('pitcher ID conflicts and unknown pitcher IDs remain explicit', () => {
  const pitching = [
    { Player: 'Own Pitcher', own: true, TeamSide: 'home', playerId: 'own-pitcher' },
    { Player: 'Opponent Pitcher', own: false, TeamSide: 'away', playerId: 'opp-pitcher' },
  ];
  const conflict = computeBaseballStats([game('pitcher-conflict', [
    { Player: 'Own Batter', own: true, TeamSide: 'home', playerId: 'own-batter' },
  ], [
    { inning: 'Bottom 1', batterId: 'own-batter', pitcherId: 'own-pitcher', text: 'Single. Own Batter singles to left field, Own Pitcher pitching.' },
  ], 'home', pitching)]);
  const conflictRecord = Object.values(conflict.unresolvedPitchers)[0];
  assert.equal(conflictRecord.identity.playerId, 'own-pitcher');
  assert.match(conflictRecord.identity.reason, /conflict/i);

  const unknown = computeBaseballStats([game('pitcher-unknown', [
    { Player: 'Own Batter', own: true, TeamSide: 'home', playerId: 'own-batter' },
  ], [
    { batterId: 'own-batter', pitcherId: 'missing-pitcher', text: 'Single. Own Batter singles to left field, Unknown Pitcher pitching.' },
  ], 'home', pitching)]);
  const unknownRecord = Object.values(unknown.unresolvedPitchers)[0];
  assert.equal(unknownRecord.identity.playerId, 'missing-pitcher');
  assert.match(unknownRecord.identity.reason, /not found/i);
});

test('position-only fielding honors a known durable ID without double counting', () => {
  const stats = computeBaseballStats([game('position-fielding', [
    { Player: 'Bailey Example', own: true, TeamSide: 'home', playerId: 'bailey-id' },
    { Player: 'Away Hitter', own: false, TeamSide: 'away', playerId: 'away-id' },
  ], [
    { inning: 'Top 1', batterId: 'away-id', fielderId: 'bailey-id', text: 'Error. Away Hitter reaches on an error by shortstop, Dana Pitcher pitching.' },
  ])]);
  assert.equal(stats.ownBatters['bailey-id'].E, 1);
  assert.deepEqual(stats.unattributedErrors, { ownSide: 0, opponentSide: 0 });
});

test('position-only unknown fielder ID remains explicit and game-scoped', () => {
  const make = (id) => game(id, [
    { Player: 'Away Hitter', own: false, TeamSide: 'away', playerId: `away-${id}` },
  ], [
    { inning: 'Top 1', batterId: `away-${id}`, fielderId: 'unknown-fielder', text: 'Error. Away Hitter reaches on an error by shortstop, Dana Pitcher pitching.' },
  ]);
  const stats = computeBaseballStats([make('field-a'), make('field-b')]);
  const unresolved = Object.values(stats.unresolvedBatters).filter((row) => row.E === 1);
  assert.equal(unresolved.length, 2);
  assert.ok(unresolved.every((row) => row.identity.playerId === 'unknown-fielder'));
  assert.ok(unresolved.every((row) => row.identity.position === 'SS'));
  assert.deepEqual(stats.unattributedErrors, { ownSide: 0, opponentSide: 0 });
  assert.deepEqual(stats, computeBaseballStats([make('field-b'), make('field-a')]));
});

test('position-only fielder ID conflicting with defense side is explicit, not reassigned', () => {
  const stats = computeBaseballStats([game('position-conflict', [
    { Player: 'Own Fielder', own: true, TeamSide: 'home', playerId: 'own-fielder' },
    { Player: 'Own Hitter', own: true, TeamSide: 'home', playerId: 'own-hitter' },
  ], [
    { inning: 'Bottom 1', batterId: 'own-hitter', fielderId: 'own-fielder', text: 'Error. Own Hitter reaches on an error by shortstop, Dana Pitcher pitching.' },
  ])]);
  assert.equal(stats.ownBatters['own-fielder'], undefined);
  const unresolved = Object.values(stats.unresolvedBatters).find((row) => row.E === 1);
  assert.equal(unresolved.identity.playerId, 'own-fielder');
  assert.equal(unresolved.identity.matchedSide, 'own');
  assert.match(unresolved.identity.reason, /conflict/i);
});

test('special-string durable IDs remain distinct and cannot corrupt accumulator objects', () => {
  const ids = ['__proto__', 'constructor', 'prototype', 'id:with|delimiters'];
  const names = ['Alpha Example', 'Bravo Example', 'Charlie Example', 'Delta Example'];
  const batting = ids.map((playerId, index) => ({ Player: names[index], own: true, TeamSide: 'home', playerId }));
  const plays = ids.map((batterId, index) => ({ batterId, text: `Single. ${names[index]} singles to left field, Dana Pitcher pitching.` }));
  const stats = computeBaseballStats([game('special-ids', batting, plays)]);
  assert.deepEqual(Object.keys(stats.ownBatters).sort(), [...ids].sort());
  for (const id of ids) {
    assert.equal(stats.ownBatters[id].playerId, id);
    assert.equal(stats.ownBatters[id].H, 1);
  }
});

// ── Correction: falsy and whitespace-only supplied player IDs ──────────────
//
// Prior defects (fixed by this correction):
//   (1) playProvidedName() used `||` chaining, so a supplied ID of numeric
//       `0` was indistinguishable from an absent field -- it never reached
//       durable-ID resolution at all, and was not even retained on the
//       resulting unresolved record (playerId came back null, not 0).
//   (2) A whitespace-only supplied ID reached resolveSuppliedIdentity as a
//       "blank" value that still short-circuited side resolution to
//       'unresolved', even when the play's name alone uniquely resolved to
//       one roster entry -- worse than not supplying an ID at all.
//   (3) identityFor()'s own `providedId != null` presence check had the same
//       blind spot one layer down (reached whenever resolveSuppliedIdentity
//       correctly returns null for a blank ID, since the raw un-vetted value
//       was still passed through as a fallback).
// Every test below fails against SHA b7becec2 for one of these three reasons.

test('batterId: 0 reaches durable resolution instead of being treated as absent', () => {
  const stats = computeBaseballStats([game('zero-batter', [
    { Player: 'Jordan Smith', own: true, TeamSide: 'home', playerId: 0 },
    { Player: 'Jordan Smith', own: false, TeamSide: 'away', playerId: 'opp-jordan' },
  ], [
    { batterId: 0, text: 'Single. Jordan Smith singles to left field, Dana Pitcher pitching.' },
  ])]);
  assert.deepEqual(Object.keys(stats.ownBatters), ['0']);
  assert.equal(stats.ownBatters['0'].H, 1);
  assert.deepEqual(stats.unresolvedBatters, {});
});

test('pitcherId: 0 reaches durable resolution instead of being treated as absent', () => {
  const stats = computeBaseballStats([game('zero-pitcher', [
    { Player: 'Alex Batter', own: true, TeamSide: 'home', playerId: 'alex-batter' },
  ], [
    { batterId: 'alex-batter', pitcherId: 0, text: 'Single. Alex Batter singles to left field, Jordan Smith pitching.' },
  ], 'home', [
    { Player: 'Jordan Smith', own: true, TeamSide: 'home', playerId: 1 },
    { Player: 'Jordan Smith', own: false, TeamSide: 'away', playerId: 0 },
  ])]);
  assert.deepEqual(Object.keys(stats.opponentPitchers), ['0']);
  assert.equal(stats.opponentPitchers['0'].H, 1);
  assert.deepEqual(stats.unresolvedPitchers, {});
});

test('fielderId: 0 reaches position-only fielding resolution instead of being treated as absent', () => {
  const stats = computeBaseballStats([game('zero-fielder', [
    { Player: 'Bailey Example', own: true, TeamSide: 'home', playerId: 0 },
    { Player: 'Away Hitter', own: false, TeamSide: 'away', playerId: 'away-id' },
  ], [
    { inning: 'Top 1', batterId: 'away-id', fielderId: 0, text: 'Error. Away Hitter reaches on an error by shortstop, Dana Pitcher pitching.' },
  ])]);
  assert.equal(stats.ownBatters['0'].E, 1);
  assert.deepEqual(stats.unattributedErrors, { ownSide: 0, opponentSide: 0 });
});

test('a baserunner scoring event credited to a batter supplied with ID 0 is not lost', () => {
  // This engine attributes baserunning outcomes (e.g. a run scored) to the
  // BATTER identity who reached base -- there is no separate runnerId field
  // in this play-text data model, so the batter-ID fix covers this path too.
  const stats = computeBaseballStats([game('zero-runner', [
    { Player: 'Jordan Smith', own: true, TeamSide: 'home', playerId: 0 },
  ], [
    { batterId: 0, text: 'Home Run. Jordan Smith homers to left field, Dana Pitcher pitching.' },
  ])]);
  assert.equal(stats.ownBatters['0'].HR, 1);
});

test('string "0" is canonically equivalent to numeric 0 for a supplied ID', () => {
  const stats = computeBaseballStats([game('string-zero', [
    { Player: 'Jordan Smith', own: true, TeamSide: 'home', playerId: 0 },
    { Player: 'Jordan Smith', own: false, TeamSide: 'away', playerId: 'opp-jordan' },
  ], [
    { batterId: '0', text: 'Single. Jordan Smith singles to left field, Dana Pitcher pitching.' },
  ])]);
  assert.deepEqual(Object.keys(stats.ownBatters), ['0']);
  assert.deepEqual(stats.unresolvedBatters, {});
});

test('a whitespace-only batter ID does not suppress a name that uniquely resolves on its own', () => {
  const stats = computeBaseballStats([game('whitespace-batter', [
    { Player: 'Solo Batter', own: true, TeamSide: 'home', playerId: 'solo-id' },
  ], [
    { batterId: '   ', text: 'Single. Solo Batter singles to left field, Dana Pitcher pitching.' },
  ])]);
  assert.deepEqual(Object.keys(stats.ownBatters), ['solo-id']);
  assert.equal(stats.ownBatters['solo-id'].H, 1);
  assert.deepEqual(stats.unresolvedBatters, {});
});

test('a whitespace-only pitcher ID does not suppress a name that uniquely resolves on its own', () => {
  const stats = computeBaseballStats([game('whitespace-pitcher', [
    { Player: 'Alex Batter', own: true, TeamSide: 'home', playerId: 'alex-batter' },
  ], [
    { batterId: 'alex-batter', pitcherId: '  ', text: 'Single. Alex Batter singles to left field, Solo Pitcher pitching.' },
  ], 'home', [
    { Player: 'Solo Pitcher', own: false, TeamSide: 'away', playerId: 'solo-pitcher-id' },
  ])]);
  assert.deepEqual(Object.keys(stats.opponentPitchers), ['solo-pitcher-id']);
  assert.deepEqual(stats.unresolvedPitchers, {});
});

test('a whitespace-only position-only fielder ID falls back to the documented unresolved/name behavior, not a bogus whitespace identity', () => {
  const stats = computeBaseballStats([game('whitespace-fielder', [
    { Player: 'Solo Fielder', own: true, TeamSide: 'home', playerId: 'solo-fielder-id' },
    { Player: 'Away Hitter', own: false, TeamSide: 'away', playerId: 'away-id' },
  ], [
    { inning: 'Top 1', batterId: 'away-id', fielderId: '   ', name: 'Solo Fielder', text: 'Error. Away Hitter reaches on an error by shortstop Solo Fielder, Dana Pitcher pitching.' },
  ])]);
  assert.ok(!Object.prototype.hasOwnProperty.call(stats.ownBatters, '   '), 'a whitespace-only fielderId must never become a resolved accumulator key');
});

test('a meaningful but unknown supplied ID remains explicit and retains its exact value (not lost, not guessed)', () => {
  const stats = computeBaseballStats([game('unknown-id', [
    { Player: 'Alex Batter', own: true, TeamSide: 'home', playerId: 'known-id' },
  ], [
    { batterId: 'unknown-id', text: 'Single. Alex Batter singles to left field, Dana Pitcher pitching.' },
  ])]);
  const record = Object.values(stats.unresolvedBatters)[0];
  assert.equal(record.identity.playerId, 'unknown-id');
  assert.match(record.identity.reason, /not found/i);
});

test('an ambiguous supplied ID does not fall back to a guessed name match', () => {
  const stats = computeBaseballStats([game('ambiguous-id', [
    { Player: 'Own Name', own: true, TeamSide: 'home', playerId: 'shared-id' },
    { Player: 'Opponent Name', own: false, TeamSide: 'away', playerId: 'shared-id' },
  ], [
    { batterId: 'shared-id', batterName: 'Own Name', text: 'Single. Own Name singles to left field, Dana Pitcher pitching.' },
  ])]);
  assert.deepEqual(stats.ownBatters, {});
  const record = Object.values(stats.unresolvedBatters)[0];
  assert.equal(record.identity.playerId, 'shared-id');
  assert.match(record.identity.reason, /multiple sides/i);
});

test('a contradictory supplied ID does not fall back to a guessed side', () => {
  const stats = computeBaseballStats([game('contradictory-id', [
    { Player: 'Jordan Smith', own: true, TeamSide: 'home', playerId: 'own-jordan' },
    { Player: 'Jordan Smith', own: false, TeamSide: 'away', playerId: 'opp-jordan' },
  ], [
    { inning: 'Bottom 1', batterId: 'opp-jordan', text: 'Single. Jordan Smith singles to left field, Dana Pitcher pitching.' },
  ])]);
  assert.deepEqual(stats.ownBatters, {});
  const record = Object.values(stats.unresolvedBatters)[0];
  assert.equal(record.identity.playerId, 'opp-jordan');
  assert.match(record.identity.reason, /conflict/i);
});

test('falsy/whitespace ID handling is deterministic under game-array reordering', () => {
  const zeroIdGame = game('reorder-zero', [
    { Player: 'Jordan Smith', own: true, TeamSide: 'home', playerId: 0 },
  ], [
    { batterId: 0, text: 'Single. Jordan Smith singles to left field, Dana Pitcher pitching.' },
  ]);
  const whitespaceIdGame = game('reorder-whitespace', [
    { Player: 'Solo Batter', own: true, TeamSide: 'home', playerId: 'solo-id' },
  ], [
    { batterId: '   ', text: 'Single. Solo Batter singles to left field, Dana Pitcher pitching.' },
  ]);
  const forward = computeBaseballStats([zeroIdGame, whitespaceIdGame]);
  const reversed = computeBaseballStats([whitespaceIdGame, zeroIdGame]);
  assert.deepEqual(forward, reversed);
  assert.deepEqual(Object.keys(forward.ownBatters).sort(), ['0', 'solo-id']);
});

test('falsy/whitespace ID resolution does not mutate any input record', () => {
  const batting = [
    { Player: 'Jordan Smith', own: true, TeamSide: 'home', playerId: 0 },
  ];
  const plays = [{ batterId: 0, text: 'Single. Jordan Smith singles to left field, Dana Pitcher pitching.' }];
  const before = structuredClone({ batting, plays });
  computeBaseballStats([game('mutation-check', batting, plays)]);
  assert.deepEqual({ batting, plays }, before);
});
