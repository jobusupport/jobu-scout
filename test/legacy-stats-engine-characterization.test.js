'use strict';

// High School Slice 2B, Phase 2: behavioral characterization tests for the
// CURRENT, UNMODIFIED src/stats-engine.js processGames() -- previously
// covered only indirectly (via src/pipeline.js). All fixtures are synthetic.
// Pins own/opponent bucketing behavior and the documented own-vs-opponent
// roster-fallback ASYMMETRY (batters default to "track all as own" when no
// own-roster is known; pitchers default the opposite way, to "opponent")
// that the new pure engine's explicit contract must not silently inherit.
//
// Run with: node --test test/legacy-stats-engine-characterization.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { processGames } = require('../src/stats-engine');

function game({ ourSide = 'home', homeBatting = [], awayBatting = [], homePitching = [], awayPitching = [], plays = [], gameId = 'g1' } = {}) {
  return {
    meta: { gameId, ourSide },
    boxScore: { homeBatting, awayBatting, homePitching, awayPitching },
    plays,
  };
}

test('CHARACTERIZATION -- processGames buckets batters into players (own) vs opponentBatters (opponent) using each row\'s own isOurTeam flag', () => {
  const stats = processGames([
    game({
      homeBatting: [{ Player: 'A Sample', isOurTeam: true, TeamSide: 'home' }],
      awayBatting: [{ Player: 'B Example', isOurTeam: false, TeamSide: 'away' }],
      plays: [
        { text: 'Single. A Sample singles to left field, D Placeholder pitching.' },
        { text: 'Strikeout. B Example strikes out swinging, C Fixture pitching.' },
      ],
    }),
  ]);
  assert.deepEqual(Object.keys(stats.players), ['A Sample']);
  assert.deepEqual(Object.keys(stats.opponentBatters), ['B Example']);
  assert.equal(stats.players['A Sample'].H, 1);
  assert.equal(stats.opponentBatters['B Example'].SO, 1);
});

test('CHARACTERIZATION -- ASYMMETRIC ROSTER FALLBACK: with no own-batter roster known, all batters default to "own" (players); with no own-pitcher roster known, all pitchers default to "opponent" (pitchers), never ourPitchers', () => {
  // No boxScore rows at all -> ourBatterNames/ourPitcherNames are both empty sets.
  const stats = processGames([
    game({
      homeBatting: [], awayBatting: [], homePitching: [], awayPitching: [],
      plays: [
        { text: 'Single. A Sample singles to left field, D Placeholder pitching.' },
      ],
    }),
  ]);
  // Batter fallback: ourBatterNames.size === 0 -> isOurBatter defaults true -> "players" (own).
  assert.deepEqual(Object.keys(stats.players), ['A Sample']);
  assert.deepEqual(Object.keys(stats.opponentBatters), []);
  // Pitcher fallback: ourPitcherNames.size === 0 -> isOurPitcher defaults false -> "pitchers" (opponent), never ourPitchers.
  assert.deepEqual(Object.keys(stats.ourPitchers), []);
  assert.deepEqual(Object.keys(stats.pitchers), ['D Placeholder']);
});

test('CHARACTERIZATION -- finalizeStats computes BA/OBP/SLG/OPS from raw counting stats using the exact legacy formulas', () => {
  const stats = processGames([
    game({
      homeBatting: [{ Player: 'A Sample', isOurTeam: true, TeamSide: 'home' }],
      awayBatting: [],
      plays: [
        { text: 'Single. A Sample singles to left field, D Placeholder pitching.' },
        { text: 'Walk. A Sample walks, D Placeholder pitching.' },
        { text: 'Strikeout. A Sample strikes out swinging, D Placeholder pitching.' },
      ],
    }),
  ]);
  const a = stats.players['A Sample'];
  assert.equal(a.PA, 3);
  assert.equal(a.AB, 2); // single + strikeout are AB events; walk is not
  assert.equal(a.H, 1);
  assert.equal(a.BB, 1);
  assert.equal(a.SO, 1);
  assert.equal(a.BA, 0.5); // 1/2
  assert.equal(a.OBP, +((1 + 1 + 0) / 3).toFixed(3)); // (H+BB+HBP)/PA = 2/3 = 0.667
  assert.equal(a.SLG, 0.5); // TB(1)/AB(2)
  assert.equal(a.OPS, +(a.OBP + a.SLG).toFixed(3));
});

test('CHARACTERIZATION -- a fielding error is attributed to the named fielder independently of whether the batter in the same play resolved', () => {
  const stats = processGames([
    game({
      homeBatting: [{ Player: 'A Sample', isOurTeam: true, TeamSide: 'home' }],
      awayBatting: [{ Player: 'Bailey Example', isOurTeam: false, TeamSide: 'away' }],
      plays: [
        // batter name unresolvable ("Nobody" is on neither roster) but the
        // error is still attributed to the named fielder -- fielder
        // attribution runs independently of batter resolution (see
        // stats-engine.js's own comment on this, around extractFielders).
        { text: 'Error. Nobody reaches on an error by shortstop Bailey Example, D Placeholder pitching.' },
      ],
    }),
  ]);
  assert.equal(stats.opponentBatters['Bailey Example'].E, 1);
  assert.deepEqual(stats.unattributedErrors, { ourSide: 0, opponentSide: 0 });
});

test('CHARACTERIZATION -- undocumented gap: extractFielders\' name pattern requires each name word to be 2+ characters, so a single-initial-formatted fielder name (GC\'s common "B Example" style, handled elsewhere in this codebase) is NOT captured -- the error falls through to unattributedErrors instead of crediting a player', () => {
  const stats = processGames([
    game({
      homeBatting: [{ Player: 'A Sample', isOurTeam: true, TeamSide: 'home' }],
      awayBatting: [{ Player: 'B Example', isOurTeam: false, TeamSide: 'away' }], // single-initial first name
      plays: [
        { text: 'Error. Nobody reaches on an error by shortstop B Example, D Placeholder pitching.' },
      ],
    }),
  ]);
  assert.deepEqual(stats.opponentBatters, {}); // no credit given, despite "B Example" being a real roster player
  assert.deepEqual(stats.unattributedErrors, { ourSide: 0, opponentSide: 1 });
});

test('CHARACTERIZATION -- games from two different gameIds are tracked separately in each player\'s games Set (finalized to a count)', () => {
  const stats = processGames([
    game({
      gameId: 'g1',
      homeBatting: [{ Player: 'A Sample', isOurTeam: true, TeamSide: 'home' }],
      plays: [{ text: 'Single. A Sample singles to left field, D Placeholder pitching.' }],
    }),
    game({
      gameId: 'g2',
      homeBatting: [{ Player: 'A Sample', isOurTeam: true, TeamSide: 'home' }],
      plays: [{ text: 'Walk. A Sample walks, D Placeholder pitching.' }],
    }),
  ]);
  assert.equal(stats.players['A Sample'].games, 2);
});

test('CHARACTERIZATION -- empty games array returns empty finalized stat maps without throwing', () => {
  const stats = processGames([]);
  assert.deepEqual(stats.players, {});
  assert.deepEqual(stats.opponentBatters, {});
  assert.deepEqual(stats.ourPitchers, {});
  assert.deepEqual(stats.pitchers, {});
  assert.deepEqual(stats.unattributedErrors, { ourSide: 0, opponentSide: 0 });
});

test('CHARACTERIZATION -- IDENTITY HAZARD: a display name present on BOTH the own and opponent roster in one game causes every play mentioning that name to be attributed to "own", even though the play could equally belong to the opponent -- processGames has no side-aware play attribution, only a bare ourBatterNames.has(name) membership check', () => {
  const stats = processGames([
    game({
      homeBatting: [{ Player: 'J Smith', isOurTeam: true, TeamSide: 'home' }],
      awayBatting: [{ Player: 'J Smith', isOurTeam: false, TeamSide: 'away' }],
      plays: [{ text: 'Single. J Smith singles to left field, D Placeholder pitching.' }],
    }),
  ]);
  assert.deepEqual(Object.keys(stats.players), ['J Smith']); // always "own", regardless of which real player it was
  assert.deepEqual(Object.keys(stats.opponentBatters), []);
});

test('CHARACTERIZATION -- IDENTITY HAZARD: two different players sharing one display name on the SAME roster are silently merged into a single accumulator entry (their plate appearances are combined as if one person)', () => {
  const stats = processGames([
    game({
      homeBatting: [{ Player: 'Jordan Smith', isOurTeam: true, TeamSide: 'home' }],
      plays: [
        { text: 'Single. Jordan Smith singles to left field, D Placeholder pitching.' },
        { text: 'Strikeout. Jordan Smith strikes out swinging, C Fixture pitching.' },
      ],
    }),
  ]);
  assert.deepEqual(Object.keys(stats.players), ['Jordan Smith']);
  assert.equal(stats.players['Jordan Smith'].PA, 2); // both plate appearances merged into one entry, regardless of whether they were the same real person
});

test('CHARACTERIZATION -- a play with unparseable/garbage text is silently skipped, not thrown', () => {
  const stats = processGames([
    game({
      homeBatting: [{ Player: 'A Sample', isOurTeam: true, TeamSide: 'home' }],
      plays: [{ text: 'completely unrecognized narrative with no event verb at all' }, { text: '' }, {}],
    }),
  ]);
  assert.deepEqual(stats.players, {});
});
