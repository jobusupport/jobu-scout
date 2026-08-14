'use strict';

// High School Slice 2B correction pass: one executable test per required
// game-integrity scenario, run against the public engine contract
// (src/engine/baseball-engine.js), each independently proving exactly one
// invariant. All fixtures are synthetic.
//
// IMPORTANT, stated plainly per this file's own findings: this engine
// performs NO game-level deduplication. reconstructBaseballTeamGames()
// treats every entry in its `capturedGames` array as one distinct, real
// game -- it has no concept of a "duplicate" game and does not compare
// entries to each other for identity. Duplicate-ingestion prevention (if a
// caller accidentally submits the same source game twice) is entirely a
// caller-owned responsibility (e.g. a unique constraint on
// team_id+source_game_ref in a persistence layer) -- see SCENARIO 11 below,
// which demonstrates the same source game submitted twice IS silently
// double-counted by this module. This is not a claim that duplicate
// prevention exists; it is proof that it does not, at this layer.
//
// Run with: node --test test/baseball-engine-game-integrity-matrix.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  reconstructBaseballGame,
  reconstructBaseballTeamGames,
  normalizeBaseballGame,
} = require('../src/engine/baseball-engine');

function battingRow(player, side, own, stats = {}) {
  return { Player: player, TeamSide: side, own, ...stats };
}

function fullGame({ gameId, ownSide, plays = [] } = {}) {
  const opponentSide = ownSide === 'home' ? 'away' : 'home';
  return {
    meta: { gameId },
    boxScore: {
      batting: [
        battingRow('A Sample', ownSide, true, { AB: 3, R: 1, H: 2, RBI: 1, BB: 0, SO: 1 }),
        battingRow('B Example', opponentSide, false, { AB: 3, R: 0, H: 1, RBI: 0, BB: 1, SO: 1 }),
      ],
      pitching: [
        battingRow('C Fixture', ownSide, true, { BF: 6, H: 1, BB: 1, SO: 1 }),
        battingRow('D Placeholder', opponentSide, false, { BF: 6, H: 2, BB: 0, SO: 1 }),
      ],
    },
    plays,
  };
}

// ── 1: normal complete game with play-by-play AND box score ────────────────
test('SCENARIO 1 (relevant op: reconstructBaseballGame) -- a complete game with matching box score and play-by-play is fully reconstructed and validated', () => {
  const game = fullGame({
    gameId: 'g1', ownSide: 'home',
    plays: [
      { inning: 'Top 1', text: 'Single. B Example singles to left field, C Fixture pitching.' },
      { inning: 'Bottom 1', text: 'Double. A Sample doubles to right field, D Placeholder pitching.' },
      { inning: 'Bottom 1', text: 'Walk. A Sample walks, D Placeholder pitching.' },
      { inning: 'Bottom 2', text: 'Strikeout. A Sample strikes out swinging, D Placeholder pitching.' },
    ],
  });
  const result = reconstructBaseballGame(game);
  assert.equal(result.hasBoxScore, true);
  assert.equal(result.hasPlayByPlay, true);
  assert.equal(result.own.validation.battingMatchesBox, true);
});

// ── 2: own team home ─────────────────────────────────────────────────────
test('SCENARIO 2 (relevant op: reconstructBaseballGame) -- own team at home: own:true rows on TeamSide "home" resolve to ownSide "home"', () => {
  const result = reconstructBaseballGame(fullGame({ gameId: 'g2', ownSide: 'home' }));
  assert.equal(result.ownSide, 'home');
  assert.equal(result.own.boxBatting.h, 2); // A Sample's box hits
});

// ── 3: own team away ─────────────────────────────────────────────────────
test('SCENARIO 3 (relevant op: reconstructBaseballGame) -- own team away: own:true rows on TeamSide "away" resolve to ownSide "away"', () => {
  const result = reconstructBaseballGame(fullGame({ gameId: 'g3', ownSide: 'away' }));
  assert.equal(result.ownSide, 'away');
  assert.equal(result.own.boxBatting.h, 2);
});

// ── 4: opponent home (own away) ─────────────────────────────────────────
test('SCENARIO 4 (relevant op: reconstructBaseballGame) -- opponent at home: own:false rows on TeamSide "home" resolve to opponentSide "home"', () => {
  const result = reconstructBaseballGame(fullGame({ gameId: 'g4', ownSide: 'away' }));
  assert.equal(result.opponentSide, 'home');
  assert.equal(result.opponent.boxBatting.h, 1); // B Example's box hits
});

// ── 5: opponent away (own home) ─────────────────────────────────────────
test('SCENARIO 5 (relevant op: reconstructBaseballGame) -- opponent away: own:false rows on TeamSide "away" resolve to opponentSide "away"', () => {
  const result = reconstructBaseballGame(fullGame({ gameId: 'g5', ownSide: 'home' }));
  assert.equal(result.opponentSide, 'away');
  assert.equal(result.opponent.boxBatting.h, 1);
});

// ── 6: home/away inversion WITHOUT own/opponent inversion ──────────────────
test('SCENARIO 6 (relevant op: reconstructBaseballGame) -- flipping venue (TeamSide) alone, with every row\'s own value held fixed, flips ownSide/opponentSide but does not change which rows are counted as own', () => {
  const game = fullGame({ gameId: 'g6', ownSide: 'home' });
  const before = reconstructBaseballGame(JSON.parse(JSON.stringify(game)));
  for (const row of [...game.boxScore.batting, ...game.boxScore.pitching]) {
    row.TeamSide = row.TeamSide === 'home' ? 'away' : 'home';
  }
  const after = reconstructBaseballGame(game);
  assert.equal(before.ownSide, 'home');
  assert.equal(after.ownSide, 'away'); // venue inverted
  assert.equal(before.own.boxBatting.h, after.own.boxBatting.h); // own/opponent membership unchanged
  assert.equal(before.opponent.boxBatting.h, after.opponent.boxBatting.h);
});

// ── 7: partial / unfinished game ────────────────────────────────────────
test('SCENARIO 7 (relevant op: reconstructBaseballGame) -- a partial game (box score complete, only some plays captured) still reconstructs from the available plays and reports a non-zero validation delta rather than failing', () => {
  const game = fullGame({
    gameId: 'g7', ownSide: 'home',
    plays: [{ inning: 'Bottom 1', text: 'Double. A Sample doubles to right field, D Placeholder pitching.' }],
  });
  const result = reconstructBaseballGame(game);
  assert.equal(result.hasPlayByPlay, true);
  assert.equal(result.parsedPlateAppearances, 1);
  assert.notEqual(result.own.validation.battingDelta.pa, 0);
});

// ── 8: missing play-by-play with a usable box score ─────────────────────
test('SCENARIO 8 (relevant op: reconstructBaseballGame) -- missing play-by-play entirely: box score is still returned; hasPlayByPlay is false; battingMatchesBox is unconditionally false (never silently "validated")', () => {
  const result = reconstructBaseballGame(fullGame({ gameId: 'g8', ownSide: 'home', plays: [] }));
  assert.equal(result.hasPlayByPlay, false);
  assert.equal(result.own.boxBatting.h, 2); // box score still present and usable
  assert.equal(result.own.validation.battingMatchesBox, false);
});

// ── 9: play-by-play present, box score incomplete ───────────────────────
test('SCENARIO 9 (relevant op: reconstructBaseballGame) -- play-by-play present but pitching box score entirely absent: does not throw; missing pitching totals default to zero, batting still reconstructs', () => {
  const result = reconstructBaseballGame({
    meta: { gameId: 'g9' },
    boxScore: { batting: [battingRow('A Sample', 'home', true, { AB: 1, H: 1 })], pitching: [] },
    plays: [{ inning: 'Bottom 1', text: 'Single. A Sample singles to left field, D Placeholder pitching.' }],
  });
  assert.deepEqual(result.own.boxPitching, { bf: 0, pc: 0, strikes: 0, h: 0, r: 0, er: 0, bb: 0, so: 0, hr: 0, wp: 0, hbp: 0 });
  assert.equal(result.own.reconstructedBatting.h, 1);
});

// ── 10: play-by-play and box-score disagreement ─────────────────────────
test('SCENARIO 10 (relevant op: reconstructBaseballGame) -- a play-by-play/box-score mismatch is detected and the exact delta is reported (see also the dedicated source-precedence test file)', () => {
  const result = reconstructBaseballGame({
    meta: { gameId: 'g10' },
    boxScore: { batting: [battingRow('A Sample', 'home', true, { AB: 3, H: 3 })], pitching: [] }, // box says 3 hits
    plays: [{ inning: 'Bottom 1', text: 'Strikeout. A Sample strikes out swinging, D Placeholder pitching.' }], // pbp says 0 hits
  });
  assert.equal(result.own.validation.battingMatchesBox, false);
  assert.equal(result.own.validation.battingDelta.h, -3);
});

// ── 11: duplicate ingestion of ONE source game (collection-level op) ───────
test('SCENARIO 11 -- submitting the same source game twice produces one logical game', () => {
  const oneGame = fullGame({ gameId: 'g-real-1', ownSide: 'home' });
  const { summary, gameResults } = reconstructBaseballTeamGames('team-x', [oneGame, oneGame]);
  assert.equal(summary.games, 1);
  assert.equal(summary.officialBatting.h, 2);
  assert.deepEqual(gameResults.map((r) => r.gameId), ['g-real-1']);
});

// ── 12: two legitimate distinct games, same two teams, same date ───────────
test('SCENARIO 12 (relevant op: reconstructBaseballTeamGames) -- two genuinely distinct games (different gameId, different plays/totals) between the same two teams remain distinct and are both correctly counted, never merged', () => {
  const gameA = fullGame({ gameId: 'g-same-day-1', ownSide: 'home' });
  const gameB = { meta: { gameId: 'g-same-day-2' }, boxScore: { batting: [battingRow('A Sample', 'home', true, { AB: 4, H: 3 })], pitching: [] }, plays: [] };
  const { summary, gameResults } = reconstructBaseballTeamGames('team-x', [gameA, gameB]);
  assert.equal(summary.games, 2);
  assert.deepEqual(gameResults.map((r) => r.gameId), ['g-same-day-1', 'g-same-day-2']);
  assert.equal(summary.officialBatting.h, 5); // 2 + 3, correctly summed, not merged/overwritten
});

// ── 13: a true doubleheader ──────────────────────────────────────────────
test('SCENARIO 13 (relevant op: reconstructBaseballTeamGames) -- a true doubleheader (2 distinct gameIds, same teams, same calendar date) is not collapsed: both games are retained as separate entries in gameResults and correctly summed in summary', () => {
  const gameOne = { meta: { gameId: 'g-dh-game-1' }, boxScore: { batting: [battingRow('A Sample', 'home', true, { AB: 3, H: 1 })], pitching: [] }, plays: [] };
  const gameTwo = { meta: { gameId: 'g-dh-game-2' }, boxScore: { batting: [battingRow('A Sample', 'away', true, { AB: 3, H: 2 })], pitching: [] }, plays: [] };
  const { summary, gameResults } = reconstructBaseballTeamGames('team-x', [gameOne, gameTwo]);
  assert.equal(gameResults.length, 2);
  assert.equal(gameResults[0].ownSide, 'home');
  assert.equal(gameResults[1].ownSide, 'away'); // second game of the doubleheader played at the other venue -- correctly independent
  assert.equal(summary.games, 2);
  assert.equal(summary.officialBatting.h, 3); // 1 + 2
});

// ── 14: out-of-order source records ─────────────────────────────────────
test('SCENARIO 14 (relevant op: reconstructBaseballGame) -- plays are processed strictly in array order regardless of inning label ordering; a distinct play between two identical plays is still counted correctly', () => {
  const result = reconstructBaseballGame({
    meta: { gameId: 'g14' },
    boxScore: { batting: [battingRow('A Sample', 'home', true, { AB: 2, H: 1 })], pitching: [] },
    plays: [
      { inning: 'Bottom 1', text: 'Single. A Sample singles to left field, D Placeholder pitching.' },
      { inning: 'Bottom 3', text: 'Walk. A Sample walks, D Placeholder pitching.' }, // out of chronological order relative to a 3rd play below, deliberately
      { inning: 'Bottom 2', text: 'Strikeout. A Sample strikes out swinging, D Placeholder pitching.' },
    ],
  });
  assert.equal(result.parsedPlateAppearances, 3);
  assert.equal(result.own.reconstructedBatting.h, 1);
  assert.equal(result.own.reconstructedBatting.bb, 1);
  assert.equal(result.own.reconstructedBatting.so, 1);
});

// ── 15: repeated normalization ───────────────────────────────────────────
test('SCENARIO 15 (relevant op: normalizeBaseballGame) -- normalizing the same rawJson a second time (simulating accidental re-ingestion) produces identical statistical output -- see the dedicated full-object determinism test in baseball-engine.test.js for the deep-equality proof', () => {
  const raw = { meta: { gameDate: '2026-03-01' }, boxScore: { homeBatting: [{ Player: 'A Sample', AB: 3, H: 2 }] }, plays: [] };
  const first = normalizeBaseballGame(raw, 'team-own', 'home');
  const second = normalizeBaseballGame(raw, 'team-own', 'home');
  assert.deepEqual(first.battingLines, second.battingLines);
});

// ── 16: empty input ──────────────────────────────────────────────────────
test('SCENARIO 16 (relevant ops: reconstructBaseballGame, normalizeBaseballGame) -- empty input does not throw for either operation', () => {
  const reconstructed = reconstructBaseballGame({ meta: {}, boxScore: {}, plays: [] });
  assert.equal(reconstructed.hasBoxScore, false);
  const normalized = normalizeBaseballGame({}, 'team-own', 'home');
  assert.deepEqual(normalized.battingLines, []);
});

// ── 17: malformed input ──────────────────────────────────────────────────
test('SCENARIO 17 (relevant ops: reconstructBaseballGame, normalizeBaseballGame) -- malformed input is rejected or safely skipped, never silently miscounted', () => {
  // malformed play entries: skipped, not thrown
  const reconstructed = reconstructBaseballGame({
    meta: { gameId: 'g17' },
    boxScore: { batting: [], pitching: [] },
    plays: [{}, { text: '' }, { text: null }, 'not-an-object'],
  });
  assert.equal(reconstructed.skippedPlays, 4);
  // malformed rawJson: throws with a clear message
  assert.throws(() => normalizeBaseballGame(null, 'team-own', 'home'), /rawJson must be an object/);
  assert.throws(() => normalizeBaseballGame(42, 'team-own', 'home'), /rawJson must be an object/);
});

// ── 18: contradictory side metadata ─────────────────────────────────────
test('SCENARIO 18 (relevant op: reconstructBaseballGame) -- contradictory metadata (two rows on the SAME TeamSide, one own:true and one own:false) is REJECTED: a single venue cannot be both own and opponent within one game', () => {
  assert.throws(
    () => reconstructBaseballGame({
      meta: { gameId: 'g18' },
      boxScore: {
        batting: [
          battingRow('A Sample', 'home', true, { AB: 2, H: 1 }),
          battingRow('Z Weird', 'home', false, { AB: 2, H: 1 }), // same TeamSide as A Sample, but own:false
        ],
        pitching: [],
      },
      plays: [],
    }),
    /contradictory side metadata/,
  );
});
