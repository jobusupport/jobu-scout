'use strict';

// High School Slice 2B, Phase 2: behavioral characterization tests for
// src/normalizer.js's own/opponent (isOurTeam) semantics, determinism,
// input-mutation, and malformed/empty-input handling -- gaps not covered by
// the existing test/normalizer-game-date.test.js or
// test/normalizer-abbreviated-months.test.js (which focus on date parsing).
// All fixtures are synthetic. This file does not modify normalizer.js.
//
// Run with: node --test test/legacy-normalizer-own-opponent-characterization.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeGameData } = require('../src/normalizer');

function rawGame(overrides = {}) {
  return {
    meta: { ourSide: 'home', gameDate: '2026-03-01', opponentName: 'Maple Grove Foxes' },
    boxScore: {
      awayBatting: [{ Player: 'B Example', AB: 3, R: 0, H: 1, BB: 1, SO: 1 }],
      homeBatting: [{ Player: 'A Sample', AB: 3, R: 1, H: 2, RBI: 1, SO: 1 }],
      awayPitching: [{ Player: 'D Placeholder', BF: 6, H: 2, SO: 1 }],
      homePitching: [{ Player: 'C Fixture', BF: 6, H: 1, BB: 1, SO: 1 }],
    },
    plays: [
      { inning: 'Top 1', text: 'Single. B Example singles to left field, C Fixture pitching.' },
      { inning: 'Bottom 1', text: 'Double. A Sample doubles to right field, D Placeholder pitching.' },
    ],
    ...overrides,
  };
}

test('CHARACTERIZATION -- normalizeGameData\'s isOurTeam has straightforward (non-inverted) semantics: 1 for rows on meta.ourSide, 0 for the other side', () => {
  const result = normalizeGameData(rawGame(), 'team-own');
  const bySide = Object.fromEntries(result.battingLines.map((b) => [b.playerName, b.isOurTeam]));
  assert.equal(bySide['A Sample'], 1); // home, matches meta.ourSide:'home'
  assert.equal(bySide['B Example'], 0); // away
});

test('CHARACTERIZATION -- flipping meta.ourSide to away flips which side is isOurTeam:1, independent of any other field', () => {
  const raw = rawGame();
  raw.meta.ourSide = 'away';
  const result = normalizeGameData(raw, 'team-own');
  const bySide = Object.fromEntries(result.battingLines.map((b) => [b.playerName, b.isOurTeam]));
  assert.equal(bySide['A Sample'], 0);
  assert.equal(bySide['B Example'], 1);
});

test('CHARACTERIZATION -- options.invertTeamSide flips every row\'s isOurTeam after the ourSide resolution, for ingesting an opponent\'s own GC page', () => {
  const result = normalizeGameData(rawGame(), 'team-own', { invertTeamSide: true });
  const bySide = Object.fromEntries(result.battingLines.map((b) => [b.playerName, b.isOurTeam]));
  assert.equal(bySide['A Sample'], 0); // was 1, now inverted
  assert.equal(bySide['B Example'], 1); // was 0, now inverted
});

test('CHARACTERIZATION -- every normalized row carries the literal placeholder gameId \'__pending__\', never a real id, at normalization time', () => {
  const result = normalizeGameData(rawGame(), 'team-own');
  for (const row of [...result.battingLines, ...result.pitchingLines]) {
    assert.equal(row.gameId, '__pending__');
  }
});

test('CHARACTERIZATION -- normalizeGameData is deterministic for its battingLines/pitchingLines/playEvents output and does not mutate its rawJson input', () => {
  const raw = rawGame();
  const rawSnapshot = JSON.parse(JSON.stringify(raw));
  const run1 = normalizeGameData(raw, 'team-own');
  const run2 = normalizeGameData(raw, 'team-own');
  assert.deepEqual(run1.battingLines, run2.battingLines);
  assert.deepEqual(run1.pitchingLines, run2.pitchingLines);
  assert.deepEqual(run1.playEvents, run2.playEvents);
  assert.deepEqual(raw, rawSnapshot);
});

test('CHARACTERIZATION -- normalizeGameData throws a clear error for non-object rawJson (null, primitive)', () => {
  assert.throws(() => normalizeGameData(null, 'team-own'), /rawJson must be an object/);
  assert.throws(() => normalizeGameData(42, 'team-own'), /rawJson must be an object/);
  assert.throws(() => normalizeGameData('x', 'team-own'), /rawJson must be an object/);
});

test('CHARACTERIZATION -- normalizeGameData({}) does not throw; returns empty batting/pitching/play arrays and an all-null game meta (except a live capturedAt timestamp)', () => {
  const result = normalizeGameData({}, 'team-own');
  assert.deepEqual(result.battingLines, []);
  assert.deepEqual(result.pitchingLines, []);
  assert.deepEqual(result.playEvents, []);
  assert.equal(result.game.gameDate, null);
  assert.equal(result.game.opponentName, null);
  // NOTE (impurity, documented not fixed): normalizeGameMeta stamps
  // capturedAt with the real wall-clock time, so `game.capturedAt` is the
  // one non-deterministic field in an otherwise pure normalizeGameData
  // call -- it does not affect any statistical value.
  assert.equal(typeof result.game.capturedAt, 'string');
});

test('CHARACTERIZATION -- repeated normalization of the same already-normalized-shaped input is idempotent for statistical fields', () => {
  // "Already normalized" input here means re-feeding the same rawJson a
  // second time (simulating accidental re-ingestion of the same source
  // payload) -- normalizeGameData has no internal state, so this is safe.
  const raw = rawGame();
  const first = normalizeGameData(raw, 'team-own');
  const second = normalizeGameData(raw, 'team-own');
  assert.deepEqual(
    first.battingLines.map((b) => ({ playerName: b.playerName, ab: b.ab, h: b.h, isOurTeam: b.isOurTeam })),
    second.battingLines.map((b) => ({ playerName: b.playerName, ab: b.ab, h: b.h, isOurTeam: b.isOurTeam })),
  );
});
