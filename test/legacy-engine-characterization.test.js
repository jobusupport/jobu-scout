'use strict';

// High School Slice 2B, Phase 2: behavioral characterization tests for the
// CURRENT, UNMODIFIED src/game-reconstructor.js, written and run against the
// legacy baseline BEFORE any extraction. All fixtures below are synthetic
// (fabricated team/player names and play text) -- none are copied from
// voodoo-scout.db, a real GameChanger page, or any real customer/team/coach
// data. This file does not modify game-reconstructor.js; it only records and
// pins its existing behavior, including one significant, verified hazard
// (see "OWNERSHIP INVERSION HAZARD" below) that the new pure engine's
// explicit own/opponent contract (src/engine/baseball-engine.js) exists to
// eliminate at its own boundary.
//
// Run with: node --test test/legacy-engine-characterization.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  reconstructGame,
  reconstructTeamGames,
  buildRosterContext,
  parsePlay,
  detectEventType,
} = require('../src/game-reconstructor');

function battingRow(player, side, isOurTeam, stats = {}) {
  return { Player: player, TeamSide: side, isOurTeam, ...stats };
}

function pitchingRow(player, side, isOurTeam, stats = {}) {
  return { Player: player, TeamSide: side, isOurTeam, ...stats };
}

// ── Scenario 1: normal complete game, own team at HOME ─────────────────────
// isOurTeam:true is the naive, unqualified reading of "this row belongs to
// our own team" -- exactly what a new caller unfamiliar with this file's
// internal vocabulary would write.
function ownHomeGame() {
  return {
    meta: { gameId: 'synthetic-g1', gameDate: '2026-03-01', opponentName: 'Maple Grove Foxes' },
    boxScore: {
      batting: [
        battingRow('A Sample', 'home', true, { AB: 3, R: 1, H: 2, RBI: 1, BB: 0, SO: 1 }),
        battingRow('B Example', 'away', false, { AB: 3, R: 0, H: 1, RBI: 0, BB: 1, SO: 1 }),
      ],
      pitching: [
        pitchingRow('C Fixture', 'home', true, { BF: 6, H: 1, BB: 1, SO: 1 }),
        pitchingRow('D Placeholder', 'away', false, { BF: 6, H: 2, BB: 0, SO: 1 }),
      ],
    },
    plays: [
      { inning: 'Top 1', text: 'Single. B Example singles to left field, C Fixture pitching.' },
      { inning: 'Top 1', text: 'Strikeout. D Placeholder strikes out swinging, C Fixture pitching.' },
      { inning: 'Bottom 1', text: 'Double. A Sample doubles to right field, D Placeholder pitching.' },
      { inning: 'Bottom 1', text: 'Walk. A Sample walks, D Placeholder pitching.' },
      { inning: 'Bottom 1', text: 'Strikeout. A Sample strikes out looking, D Placeholder pitching.' },
    ],
  };
}

test('CHARACTERIZATION -- OWNERSHIP INVERSION HAZARD: isOurTeam:true for the home team lands those rows in result.opponent, not result.scouted', () => {
  const result = reconstructGame(ownHomeGame());
  // scoutedSide/scouted bucket is derived from isOurTeam === false (the away,
  // "not our team" rows in this fixture) -- NOT from isOurTeam === true.
  assert.equal(result.scoutedSide, 'away');
  assert.equal(result.opponentSide, 'home');
  // A Sample (isOurTeam:true, home) accrued 2 box hits but is counted under
  // result.opponent, never result.scouted -- pinning the exact hazard this
  // slice's own/opponent contract is designed to remove at its boundary.
  assert.equal(result.opponent.boxBatting.h, 2);
  assert.equal(result.scouted.boxBatting.h, 1);
});

test('CHARACTERIZATION -- reconstructGame produces a fully populated result for a complete game with matching box score and play-by-play', () => {
  const result = reconstructGame(ownHomeGame());
  assert.equal(result.hasBoxScore, true);
  assert.equal(result.hasPlayByPlay, true);
  assert.equal(result.parsedPlateAppearances, 5);
  assert.equal(result.skippedPlays, 0);
  assert.equal(result.duplicateSkips, 0);
  assert.equal(result.unmatchedBatters, 0);
  assert.equal(result.unmatchedPitchers, 0);
  assert.equal(result.scouted.validation.battingMatchesBox, true);
  assert.deepEqual(result.warnings, []);
});

// ── Scenario 2/3: own team AWAY, and home/away independence from side identity ──
test('CHARACTERIZATION -- home/away venue is independent of the scouted/opponent bucket: swapping TeamSide values while keeping isOurTeam fixed flips scoutedSide but not which rows are counted as scouted', () => {
  const game = ownHomeGame();
  // Flip venue only (home<->away) without touching isOurTeam.
  for (const row of [...game.boxScore.batting, ...game.boxScore.pitching]) {
    row.TeamSide = row.TeamSide === 'home' ? 'away' : 'home';
  }
  const result = reconstructGame(game);
  assert.equal(result.scoutedSide, 'home'); // venue flipped
  assert.equal(result.scouted.boxBatting.h, 1); // still B Example's totals -- bucket membership unchanged
  assert.equal(result.opponent.boxBatting.h, 2); // still A Sample's totals
});

// ── Scenario 4: opponent-side reconstruction populated independently ───────
test('CHARACTERIZATION -- result.opponent is reconstructed from play-by-play independently of result.scouted', () => {
  const result = reconstructGame(ownHomeGame());
  assert.equal(result.opponent.reconstructedBatting.doubles, 1); // A Sample's double
  assert.equal(result.opponent.reconstructedBatting.bb, 1); // A Sample's walk
  assert.equal(result.scouted.reconstructedBatting.h, 1); // B Example's single
});

// ── Scenario 5: partial/unfinished game (few plays, box score still full innings) ──
test('CHARACTERIZATION -- a partial game (box score present, only some plays captured) still reconstructs from what play-by-play exists and reports a non-zero delta rather than failing', () => {
  const game = ownHomeGame();
  game.plays = game.plays.slice(0, 1); // only the very first play captured
  const result = reconstructGame(game);
  assert.equal(result.hasPlayByPlay, true);
  assert.equal(result.parsedPlateAppearances, 1);
  assert.notEqual(result.scouted.validation.battingDelta.pa, 0);
});

// ── Scenario 6: missing play-by-play entirely, usable box score ────────────
test('CHARACTERIZATION -- missing play-by-play: hasPlayByPlay is false, battingMatchesBox is unconditionally false, and a specific warning is emitted', () => {
  const game = {
    meta: { gameId: 'g-no-pbp' },
    boxScore: {
      batting: [
        battingRow('A Sample', 'home', false, { AB: 3, H: 1 }),
        battingRow('B Example', 'away', true, { AB: 3, H: 1 }),
      ],
      pitching: [],
    },
    plays: [],
  };
  const result = reconstructGame(game);
  assert.equal(result.hasPlayByPlay, false);
  assert.equal(result.scouted.validation.battingMatchesBox, false);
  assert.deepEqual(result.warnings, ['No play-by-play rows for this game; official totals use box score only.']);
});

// ── Scenario 7: play-by-play present, box score incomplete (no pitching rows at all) ──
test('CHARACTERIZATION -- an incomplete box score (batting rows present, pitching rows entirely absent) still processes without throwing; missing pitching totals default to zero', () => {
  const game = {
    meta: { gameId: 'g-no-pitching-box' },
    boxScore: {
      batting: [battingRow('A Sample', 'home', false, { AB: 1, H: 1 })],
      pitching: [],
    },
    plays: [{ inning: 'Bottom 1', text: 'Single. A Sample singles to left field, D Placeholder pitching.' }],
  };
  const result = reconstructGame(game);
  assert.deepEqual(result.scouted.boxPitching, {
    bf: 0, pc: 0, strikes: 0, h: 0, r: 0, er: 0, bb: 0, so: 0, hr: 0, wp: 0, hbp: 0,
  });
  assert.equal(result.scouted.reconstructedBatting.h, 1);
});

// ── Scenario 8: play-by-play/box-score disagreement ─────────────────────────
test('CHARACTERIZATION -- a play-by-play/box-score mismatch is detected (battingMatchesBox:false) and the exact delta is pinned', () => {
  const game = {
    meta: { gameId: 'g-mismatch' },
    boxScore: { batting: [battingRow('A Sample', 'home', false, { AB: 3, H: 3 })], pitching: [] },
    plays: [{ inning: 'Bottom 1', text: 'Strikeout. A Sample strikes out swinging, D Placeholder pitching.' }],
  };
  const result = reconstructGame(game);
  assert.equal(result.scouted.validation.battingMatchesBox, false);
  assert.deepEqual(result.scouted.validation.battingDelta, {
    pa: -2, ab: -2, h: -3, bb: 0, so: 1, hbp: 0, doubles: 0, triples: 0, hr: 0,
  });
});

// ── Scenario 9: duplicate ingestion (identical play line repeated) ─────────
test('CHARACTERIZATION -- an exact duplicate consecutive play line is skipped via duplicateSkips and not double-counted', () => {
  const game = {
    meta: { gameId: 'g-dup' },
    boxScore: { batting: [battingRow('A Sample', 'home', false, { AB: 1, H: 1 })], pitching: [] },
    plays: [
      { inning: 'Bottom 1', text: 'Single. A Sample singles to left field, D Placeholder pitching.' },
      { inning: 'Bottom 1', text: 'Single. A Sample singles to left field, D Placeholder pitching.' },
    ],
  };
  const result = reconstructGame(game);
  assert.equal(result.parsedPlateAppearances, 1);
  assert.equal(result.duplicateSkips, 1);
  assert.equal(result.scouted.reconstructedBatting.h, 1);
});

// ── Scenario 10: two distinct games, same two teams, same day (doubleheader) ──
test('CHARACTERIZATION -- reconstructTeamGames aggregates multiple distinct games independently and correctly sums/mismatches across them', () => {
  const gameA = {
    meta: { gameId: 'g-dh-1' },
    boxScore: { batting: [battingRow('A Sample', 'home', false, { AB: 3, H: 1 })], pitching: [] },
    plays: [],
  };
  const gameB = {
    meta: { gameId: 'g-dh-2' },
    boxScore: { batting: [battingRow('A Sample', 'home', false, { AB: 3, H: 3 })], pitching: [] },
    plays: [{ inning: 'Bottom 1', text: 'Strikeout. A Sample strikes out swinging, D Placeholder pitching.' }],
  };
  const { summary, gameResults } = reconstructTeamGames('team-x', [gameA, gameB]);
  assert.equal(gameResults.length, 2);
  assert.equal(summary.games, 2);
  assert.equal(summary.boxScoreGames, 2);
  assert.equal(summary.playByPlayGames, 1);
  assert.equal(summary.mismatchGames, 1);
  assert.equal(summary.officialBatting.ab, 6); // 3 + 3, summed across both games
  assert.equal(summary.officialBatting.h, 4); // 1 + 3
});

// ── Scenario 11: duplicate player names on the SAME roster ─────────────────
test('CHARACTERIZATION -- two same-first-initial-and-last-name players on one roster collapse to a single alias-map entry (first full name written wins); the ambiguous initial+last alias resolves to whichever was added first', () => {
  const players = ['Jordan Smith', 'James Smith'];
  const ctx = buildRosterContext({
    boxScore: {
      batting: players.map((p) => battingRow(p, 'home', false, {})),
      pitching: [],
    },
  });
  // Both share "J Smith" as their initial+last alias; the alias map is a
  // first-write-wins Map (see makeAliasMap's `if (!map.has(key))` guard).
  assert.equal(ctx.scoutedAliasMap.get('j smith'), 'Jordan Smith');
  // The bare last name "Smith" is ambiguous (used by 2 players) and is
  // therefore NOT added as an alias at all (only unique last names qualify).
  assert.equal(ctx.scoutedAliasMap.has('smith'), false);
  // Each full name still resolves to itself.
  assert.equal(ctx.scoutedAliasMap.get('jordan smith'), 'Jordan Smith');
  assert.equal(ctx.scoutedAliasMap.get('james smith'), 'James Smith');
});

// ── Scenario 12: same player name on OPPOSING teams, disambiguated by side ──
test('CHARACTERIZATION -- an identical player name on both rosters is disambiguated by offense side (inning parity), not merged into one player', () => {
  const game = {
    meta: { gameId: 'g-samename' },
    boxScore: {
      batting: [
        battingRow('J Smith', 'home', false, { AB: 2, H: 1 }),
        battingRow('J Smith', 'away', true, { AB: 2, H: 1 }),
      ],
      pitching: [],
    },
    plays: [
      { inning: 'Bottom 1', text: 'Single. J Smith singles to left field, D Placeholder pitching.' }, // bottom = home = scouted side
      { inning: 'Top 2', text: 'Double. J Smith doubles to right field, C Fixture pitching.' }, // top = away = opponent side
    ],
  };
  const result = reconstructGame(game);
  assert.equal(result.scouted.reconstructedBatting.h, 1);
  assert.equal(result.opponent.reconstructedBatting.h, 1);
  assert.equal(result.opponent.reconstructedBatting.doubles, 1);
});

// ── Scenario 13: missing optional box-score fields default to 0 ────────────
test('CHARACTERIZATION -- missing numeric box-score fields (no AB/R/H/etc. keys at all) default to 0 rather than throwing or producing NaN', () => {
  const result = reconstructGame({
    meta: { gameId: 'g-missing-fields' },
    boxScore: { batting: [{ Player: 'A Sample', TeamSide: 'home', isOurTeam: false }], pitching: [] },
    plays: [],
  });
  assert.deepEqual(result.scouted.boxBatting, {
    pa: 0, ab: 0, r: 0, h: 0, rbi: 0, bb: 0, so: 0, hbp: 0,
    doubles: 0, triples: 0, hr: 0, sb: 0, sac: 0,
    ground_out: 0, fly_out: 0, line_out: 0, pop_out: 0, batted_balls: 0,
  });
});

// ── Scenario 14: unknown/unresolved player identity in play-by-play ────────
test('CHARACTERIZATION -- a play naming a batter absent from both rosters is still counted (attributed by inning-derived side), and tallied in unmatchedBatters rather than silently dropped', () => {
  const result = reconstructGame({
    meta: { gameId: 'g-unmatched' },
    boxScore: { batting: [battingRow('A Sample', 'home', false, { AB: 1 })], pitching: [] },
    plays: [{ inning: 'Bottom 1', text: 'Single. Z Nobody singles to left field, D Placeholder pitching.' }],
  });
  assert.equal(result.unmatchedBatters, 1);
  assert.equal(result.scouted.reconstructedBatting.h, 1); // still attributed to the scouted side via inning parity
  assert.equal(result.opponent.reconstructedBatting.h, 0);
});

// ── Scenario 16: empty input ────────────────────────────────────────────────
test('CHARACTERIZATION -- reconstructGame({}) does not throw and returns an all-zero/all-null result shape', () => {
  const result = reconstructGame({});
  assert.equal(result.gameId, null);
  assert.equal(result.hasBoxScore, false);
  assert.equal(result.hasPlayByPlay, false);
  assert.equal(result.scoutedSide, null);
  assert.equal(result.opponentSide, null);
  assert.deepEqual(result.scouted.validation.battingDelta, {
    pa: 0, ab: 0, h: 0, bb: 0, so: 0, hbp: 0, doubles: 0, triples: 0, hr: 0,
  });
});

// ── Scenario 17: malformed play entries ─────────────────────────────────────
test('CHARACTERIZATION -- malformed play entries (empty object, empty text, null text, non-object) are all skipped via skippedPlays without throwing', () => {
  const result = reconstructGame({
    meta: { gameId: 'g-malformed' },
    boxScore: { batting: [], pitching: [] },
    plays: [{}, { text: '' }, { text: null }, 'not-an-object'],
  });
  assert.equal(result.skippedPlays, 4);
  assert.equal(result.parsedPlateAppearances, 0);
});

// ── Scenario 18: out-of-order records ───────────────────────────────────────
test('CHARACTERIZATION -- plays are processed strictly in array order; a non-adjacent exact repeat is STILL deduped (dedupe keys accumulate across the whole game, not just the immediately preceding play), while a distinct play in between is counted normally', () => {
  const result = reconstructGame({
    meta: { gameId: 'g-out-of-order' },
    boxScore: { batting: [battingRow('A Sample', 'home', false, { AB: 2, H: 1 })], pitching: [] },
    plays: [
      { inning: 'Bottom 1', text: 'Single. A Sample singles to left field, D Placeholder pitching.' },
      { inning: 'Bottom 3', text: 'Walk. A Sample walks, D Placeholder pitching.' }, // distinct play in between
      { inning: 'Bottom 1', text: 'Single. A Sample singles to left field, D Placeholder pitching.' }, // identical to play 1, non-adjacent
    ],
  });
  // The non-adjacent repeat is caught by keptKeys (a whole-game Set, not an
  // adjacent-only check), so it is deduped despite the intervening play.
  assert.equal(result.duplicateSkips, 1);
  assert.equal(result.parsedPlateAppearances, 2); // the single (once) + the walk
  assert.equal(result.scouted.reconstructedBatting.h, 1);
  assert.equal(result.scouted.reconstructedBatting.bb, 1);
});

// ── detectEventType / parsePlay direct unit coverage (previously untested) ──
test('CHARACTERIZATION -- detectEventType recognizes prefix-anchored and phrase-based event labels', () => {
  assert.equal(detectEventType('Single. A Sample singles to left.'), 'single');
  assert.equal(detectEventType('A Sample singles to left.'), 'single'); // phrase fallback, no leading label
  assert.equal(detectEventType('completely unrecognized text with no event verb'), null);
  assert.equal(detectEventType(''), null);
});

test('CHARACTERIZATION -- parsePlay returns null for a label-only description with no narrative', () => {
  const ctx = buildRosterContext({ boxScore: { batting: [battingRow('A Sample', 'home', false, {})], pitching: [] } });
  assert.equal(parsePlay({ inning: 'Bottom 1', text: 'Single' }, ctx), null);
});
