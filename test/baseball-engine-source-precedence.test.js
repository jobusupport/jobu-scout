'use strict';

// High School Slice 2B correction pass: establishes and pins the EXACT
// source-precedence rule when box-score and play-by-play data disagree, for
// each public engine operation that consumes both. All fixtures are
// synthetic, and each conflicting fixture below is deliberately constructed
// so the two sources cannot both be correct (the box score's AB/H/BB/SO
// totals are numerically incompatible with what the supplied plays would
// produce).
//
// THE RULE (reconstructBaseballGame / reconstructBaseballTeamGames):
//   Box score is the sole authoritative source for `own.boxBatting` /
//   `own.boxPitching` (and the `opponent.*` equivalents) -- these fields are
//   returned EXACTLY as given in the box score, never adjusted, blended, or
//   overwritten by play-by-play reconstruction, no matter how badly the two
//   disagree. Play-by-play reconstruction is returned as a SEPARATE,
//   parallel field (`own.reconstructedBatting` /
//   `own.reconstructedPitchingDefense`) that is never merged into the box
//   fields -- it is diagnostic/tendency data only, and its trustworthiness
//   is exposed via `own.validation.battingMatchesBox` (false whenever any
//   of ab/h/bb/so/hbp differs from the box by more than 1). There is no
//   field-specific precedence beyond this split -- the box side of the
//   split is always box, the reconstructed side is always play-by-play, for
//   every field within battingTotals.
//
// THE RULE (computeBaseballStats): this operation does not consume box-score
// NUMERIC totals (AB/H/R/RBI/etc.) at all -- see the second test below. Box
// rows are used only to build the own/opponent player-name membership sets;
// every counting statistic in the returned ownBatters/opponentBatters/
// ownPitchers/opponentPitchers maps comes exclusively from play-by-play
// text. There is therefore no "box vs. play-by-play conflict" to resolve
// for this operation's numeric output -- it never had two numeric sources
// in the first place, and this is stated here explicitly rather than left
// to be assumed.
//
// Run with: node --test test/baseball-engine-source-precedence.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { reconstructBaseballGame, computeBaseballStats } = require('../src/engine/baseball-engine');

test('reconstructBaseballGame -- box score wins for own.boxBatting: a badly conflicting play-by-play never changes the returned box totals', () => {
  const result = reconstructBaseballGame({
    meta: { gameId: 'g-conflict' },
    boxScore: {
      // Box score says: 3 AB, 3 H (implausibly, a perfect 1.000 average).
      batting: [{ Player: 'A Sample', TeamSide: 'home', own: true, AB: 3, H: 3, BB: 0, SO: 0 }],
      pitching: [],
    },
    // Play-by-play says something the box score directly contradicts: one
    // strikeout (0 hits, +1 AB, +1 SO) and nothing else -- the two sources
    // cannot both be describing the same at-bats.
    plays: [{ inning: 'Bottom 1', text: 'Strikeout. A Sample strikes out swinging, D Placeholder pitching.' }],
  });
  // The box totals are returned completely unchanged by the conflicting PBP.
  assert.equal(result.own.boxBatting.ab, 3);
  assert.equal(result.own.boxBatting.h, 3);
  assert.equal(result.own.boxBatting.so, 0);
  // The play-by-play reconstruction is available separately, unmerged.
  assert.equal(result.own.reconstructedBatting.ab, 1);
  assert.equal(result.own.reconstructedBatting.h, 0);
  assert.equal(result.own.reconstructedBatting.so, 1);
  // The conflict is exposed via validation, not silently resolved.
  assert.equal(result.own.validation.battingMatchesBox, false);
  assert.deepEqual(result.own.validation.battingDelta, { pa: -2, ab: -2, h: -3, bb: 0, so: 1, hbp: 0, doubles: 0, triples: 0, hr: 0 });
});

test('reconstructBaseballGame -- box score wins even when play-by-play is entirely absent (no reconstruction to compare, box still authoritative and returned)', () => {
  const result = reconstructBaseballGame({
    meta: { gameId: 'g-no-pbp' },
    boxScore: { batting: [{ Player: 'A Sample', TeamSide: 'home', own: true, AB: 4, H: 2 }], pitching: [] },
    plays: [],
  });
  assert.equal(result.own.boxBatting.h, 2);
  assert.equal(result.own.reconstructedBatting.h, 0); // nothing to reconstruct
  assert.equal(result.own.validation.battingMatchesBox, false); // no PBP means never "validated", per isValidated()
});

test('computeBaseballStats -- box-score numeric totals (AB/H/etc.) are NEVER read; every counting stat comes exclusively from play-by-play, even when the box score is deliberately absurd', () => {
  const stats = computeBaseballStats([{
    meta: { gameId: 'g-conflict' },
    boxScore: {
      // Deliberately impossible box totals that a real GameChanger page
      // could never produce (99 AB / 99 H in one game).
      batting: [{ Player: 'A Sample', own: true, TeamSide: 'home', AB: 99, H: 99 }],
    },
    plays: [{ text: 'Single. A Sample singles to left field, D Placeholder pitching.' }],
  }]);
  assert.equal(stats.ownBatters['A Sample'].AB, 1); // from the ONE play, not 99
  assert.equal(stats.ownBatters['A Sample'].H, 1);
});
