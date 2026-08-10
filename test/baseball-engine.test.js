'use strict';

// High School Slice 2B: behavioral tests for the new pure engine boundary,
// src/engine/baseball-engine.js. All fixtures are synthetic (fabricated
// team/player names and play text) -- none copied from voodoo-scout.db, a
// real GameChanger page, or real customer/team/coach data.
//
// Run with: node --test test/baseball-engine.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  reconstructBaseballGame,
  reconstructBaseballTeamGames,
  computeBaseballStats,
  normalizeBaseballGame,
} = require('../src/engine/baseball-engine');

function battingRow(player, side, own, stats = {}) {
  return { Player: player, TeamSide: side, own, ...stats };
}

function ownHomeGame() {
  return {
    meta: { gameId: 'synthetic-g1', gameDate: '2026-03-01', opponentName: 'Maple Grove Foxes' },
    boxScore: {
      batting: [
        battingRow('A Sample', 'home', true, { AB: 3, R: 1, H: 2, RBI: 1, BB: 0, SO: 1 }),
        battingRow('B Example', 'away', false, { AB: 3, R: 0, H: 1, RBI: 0, BB: 1, SO: 1 }),
      ],
      pitching: [
        battingRow('C Fixture', 'home', true, { BF: 6, H: 1, BB: 1, SO: 1 }),
        battingRow('D Placeholder', 'away', false, { BF: 6, H: 2, BB: 0, SO: 1 }),
      ],
    },
    plays: [
      { inning: 'Top 1', text: 'Single. B Example singles to left field, C Fixture pitching.' },
      { inning: 'Bottom 1', text: 'Double. A Sample doubles to right field, D Placeholder pitching.' },
      { inning: 'Bottom 1', text: 'Walk. A Sample walks, D Placeholder pitching.' },
    ],
  };
}

// ── The fix: own/opponent bucketing is now correct and explicit ────────────

test('reconstructBaseballGame -- own:true rows are counted under result.own (fixing the legacy inversion hazard), own:false under result.opponent', () => {
  const result = reconstructBaseballGame(ownHomeGame());
  assert.equal(result.ownSide, 'home');
  assert.equal(result.opponentSide, 'away');
  assert.equal(result.own.boxBatting.h, 2); // A Sample's box hits
  assert.equal(result.opponent.boxBatting.h, 1); // B Example's box hits
  assert.equal(result.own.reconstructedBatting.doubles, 1); // A Sample's double from PBP
  assert.equal(result.own.reconstructedBatting.bb, 1); // A Sample's walk from PBP
});

test('reconstructBaseballGame -- home/away venue is independent of own/opponent: flipping TeamSide alone flips ownSide but not which rows are own', () => {
  const game = ownHomeGame();
  for (const row of [...game.boxScore.batting, ...game.boxScore.pitching]) {
    row.TeamSide = row.TeamSide === 'home' ? 'away' : 'home';
  }
  const result = reconstructBaseballGame(game);
  assert.equal(result.ownSide, 'away'); // venue flipped
  assert.equal(result.own.boxBatting.h, 2); // still A Sample -- own bucket membership unchanged by venue
});

test('reconstructBaseballGame -- opponent side is reconstructed from play-by-play independently of own', () => {
  const result = reconstructBaseballGame(ownHomeGame());
  assert.equal(result.opponent.reconstructedBatting.h, 1); // B Example's single
});

// ── Explicit-own enforcement: never guessed, never defaulted ───────────────

test('reconstructBaseballGame -- throws when a batting row is missing the required own field', () => {
  assert.throws(
    () => reconstructBaseballGame({ boxScore: { batting: [{ Player: 'X', TeamSide: 'home' }], pitching: [] }, plays: [] }),
    /is missing the required explicit "own" boolean/,
  );
});

test('reconstructBaseballGame -- throws when own is present but not a boolean', () => {
  assert.throws(
    () => reconstructBaseballGame({ boxScore: { batting: [{ Player: 'X', TeamSide: 'home', own: 'yes' }], pitching: [] }, plays: [] }),
    /own must be a boolean/,
  );
  assert.throws(
    () => reconstructBaseballGame({ boxScore: { batting: [{ Player: 'X', TeamSide: 'home', own: 1 }], pitching: [] }, plays: [] }),
    /own must be a boolean/,
  );
});

test('reconstructBaseballGame -- throws for a pitching row missing own, independently of the batting rows being valid', () => {
  assert.throws(
    () => reconstructBaseballGame({
      boxScore: {
        batting: [battingRow('A Sample', 'home', true, {})],
        pitching: [{ Player: 'C Fixture', TeamSide: 'home' }],
      },
      plays: [],
    }),
    /boxScore\.pitching\[0\] is missing the required explicit "own" boolean/,
  );
});

test('computeBaseballStats -- throws when a boxScore row is missing own', () => {
  assert.throws(
    () => computeBaseballStats([{ meta: { gameId: 'g1' }, boxScore: { batting: [{ Player: 'X' }] }, plays: [] }]),
    /is missing the required explicit "own" boolean/,
  );
});

test('normalizeBaseballGame -- throws when ownSide is missing or not exactly "home"/"away"', () => {
  const raw = { meta: {}, boxScore: {}, plays: [] };
  assert.throws(() => normalizeBaseballGame(raw, 'team-1', undefined), /ownSide is required/);
  assert.throws(() => normalizeBaseballGame(raw, 'team-1', 'north'), /ownSide is required/);
  assert.throws(() => normalizeBaseballGame(raw, 'team-1', 'Home'), /ownSide is required/); // case-sensitive, never guessed
});

// ── Purity: no input mutation, deterministic output ─────────────────────────

test('reconstructBaseballGame -- does not mutate its input game object', () => {
  const game = ownHomeGame();
  const snapshot = JSON.parse(JSON.stringify(game));
  reconstructBaseballGame(game);
  assert.deepEqual(game, snapshot);
});

test('reconstructBaseballGame -- deterministic: identical input produces identical output across repeated calls', () => {
  const game = ownHomeGame();
  const r1 = reconstructBaseballGame(game);
  const r2 = reconstructBaseballGame(game);
  assert.deepEqual(r1, r2);
});

test('computeBaseballStats -- does not mutate its input games array', () => {
  const games = [{
    meta: { gameId: 'g1' },
    boxScore: { batting: [battingRow('A Sample', 'home', true, {})] },
    plays: [{ text: 'Single. A Sample singles to left field, D Placeholder pitching.' }],
  }];
  const snapshot = JSON.parse(JSON.stringify(games));
  computeBaseballStats(games);
  assert.deepEqual(games, snapshot);
});

// ── Game integrity: reconstructBaseballTeamGames aggregates correctly ──────

test('reconstructBaseballTeamGames -- aggregates own/opponent-translated results across multiple games and renames each game result to own/opponent vocabulary', () => {
  const gameA = ownHomeGame();
  const gameB = {
    meta: { gameId: 'synthetic-g2' },
    boxScore: { batting: [battingRow('A Sample', 'away', true, { AB: 2, H: 2 })], pitching: [] },
    plays: [],
  };
  const { summary, gameResults } = reconstructBaseballTeamGames('team-x', [gameA, gameB]);
  assert.equal(gameResults.length, 2);
  assert.equal(gameResults[0].ownSide, 'home');
  assert.equal(gameResults[1].ownSide, 'away');
  assert.equal(summary.games, 2);
  assert.equal(summary.officialBatting.h, 4); // A Sample's 2 (game A) + 2 (game B)
});

test('reconstructBaseballTeamGames -- throws for a non-array capturedGames argument', () => {
  assert.throws(() => reconstructBaseballTeamGames('team-x', 'not-an-array'), /capturedGames must be an array/);
});

// ── Statistical behavior: computeBaseballStats own/opponent bucketing ──────

test('computeBaseballStats -- buckets batters/pitchers into ownBatters/opponentBatters/ownPitchers/opponentPitchers using each row\'s explicit own field', () => {
  const stats = computeBaseballStats([{
    meta: { gameId: 'g1' },
    boxScore: {
      batting: [
        battingRow('A Sample', 'home', true, {}),
        battingRow('B Example', 'away', false, {}),
      ],
    },
    plays: [
      { text: 'Single. A Sample singles to left field, D Placeholder pitching.' },
      { text: 'Strikeout. B Example strikes out swinging, C Fixture pitching.' },
    ],
  }]);
  assert.deepEqual(Object.keys(stats.ownBatters), ['A Sample']);
  assert.deepEqual(Object.keys(stats.opponentBatters), ['B Example']);
  assert.equal(stats.ownBatters['A Sample'].H, 1);
  assert.equal(stats.opponentBatters['B Example'].SO, 1);
});

// ── Player identity: name collisions across rosters still disambiguate ─────

test('reconstructBaseballGame -- an identical player name on both own and opponent rosters is disambiguated by side, not merged', () => {
  const result = reconstructBaseballGame({
    meta: { gameId: 'g-samename' },
    boxScore: {
      batting: [
        battingRow('J Smith', 'home', true, { AB: 2, H: 1 }),
        battingRow('J Smith', 'away', false, { AB: 2, H: 1 }),
      ],
      pitching: [],
    },
    plays: [
      { inning: 'Bottom 1', text: 'Single. J Smith singles to left field, D Placeholder pitching.' }, // bottom = home = own
      { inning: 'Top 2', text: 'Double. J Smith doubles to right field, C Fixture pitching.' }, // top = away = opponent
    ],
  });
  assert.equal(result.own.reconstructedBatting.h, 1);
  assert.equal(result.opponent.reconstructedBatting.h, 1);
  assert.equal(result.opponent.reconstructedBatting.doubles, 1);
});

// ── normalizeBaseballGame: explicit ownSide, own field alongside legacy isOurTeam ──

test('normalizeBaseballGame -- ownSide is explicit and independent of rawJson.meta.ourSide; adds an own boolean alongside isOurTeam', () => {
  const raw = {
    meta: { gameDate: '2026-03-01', opponentName: 'Maple Grove Foxes' }, // no ourSide at all
    boxScore: {
      awayBatting: [{ Player: 'B Example', AB: 3, H: 1 }],
      homeBatting: [{ Player: 'A Sample', AB: 3, H: 2 }],
    },
    plays: [],
  };
  const result = normalizeBaseballGame(raw, 'team-own', 'home');
  const bySide = Object.fromEntries(result.battingLines.map((b) => [b.playerName, { isOurTeam: b.isOurTeam, own: b.own }]));
  assert.deepEqual(bySide['A Sample'], { isOurTeam: 1, own: true });
  assert.deepEqual(bySide['B Example'], { isOurTeam: 0, own: false });
});

test('normalizeBaseballGame -- every row still carries the placeholder gameId \'__pending__\'', () => {
  const raw = { meta: {}, boxScore: { homeBatting: [{ Player: 'A Sample', AB: 1, H: 1 }] }, plays: [] };
  const result = normalizeBaseballGame(raw, 'team-own', 'home');
  assert.equal(result.battingLines[0].gameId, '__pending__');
});

test('normalizeBaseballGame -- does not mutate its rawJson input', () => {
  const raw = { meta: { gameDate: '2026-03-01' }, boxScore: { homeBatting: [{ Player: 'A Sample', AB: 1 }] }, plays: [] };
  const snapshot = JSON.parse(JSON.stringify(raw));
  normalizeBaseballGame(raw, 'team-own', 'home');
  assert.deepEqual(raw, snapshot);
});

// ── Empty / malformed input ──────────────────────────────────────────────

test('reconstructBaseballGame -- an empty boxScore (no rows at all) does not throw and produces an all-zero result', () => {
  const result = reconstructBaseballGame({ meta: {}, boxScore: {}, plays: [] });
  assert.equal(result.hasBoxScore, false);
  assert.equal(result.ownSide, null);
  assert.equal(result.opponentSide, null);
});

test('computeBaseballStats -- an empty games array returns empty stat buckets', () => {
  const stats = computeBaseballStats([]);
  assert.deepEqual(stats.ownBatters, {});
  assert.deepEqual(stats.opponentBatters, {});
});
