'use strict';

// Focused tests for the game-date precedence correction in
// src/normalizer.js's normalizeGameMeta(): gameDate now resolves as
// `dateTime.date || explicitGameDate` (parsed from the combined
// gameDateTime string first, falling back to an explicit schedule-card
// date field only when no datetime string was present/parseable) --
// reversed from the prior `explicitGameDate || dateTime.date`, per the
// confirmed correction from the legacy-copy review.
//
// Run with: node --test test/normalizer-game-date.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeGameMeta } = require('../src/normalizer');

test('normalizeGameMeta — gameDate prefers the parsed datetime date over an explicit schedule-card date when both are present and differ', () => {
  const meta = {
    gameDateTime: 'Sat April 12, 2026, 2:00 PM - 4:30 PM CT',
    gameDate: '2026-04-15', // deliberately different, to prove precedence
  };
  const game = normalizeGameMeta(meta, 't1');
  assert.equal(game.gameDate, '2026-04-12');
});

test('normalizeGameMeta — falls back to the explicit schedule-card date when no gameDateTime string is present', () => {
  const meta = { gameDate: '2026-04-15' };
  const game = normalizeGameMeta(meta, 't1');
  assert.equal(game.gameDate, '2026-04-15');
});

test('normalizeGameMeta — falls back to the explicit schedule-card date when gameDateTime has no parseable date (e.g. time-only, or unrecognized format)', () => {
  const meta = { gameDateTime: '2:00 PM - 4:30 PM CT', gameDate: '2026-04-15' };
  const game = normalizeGameMeta(meta, 't1');
  assert.equal(game.gameDate, '2026-04-15');
});

test('normalizeGameMeta — uses the parsed datetime date when no explicit schedule-card date field is present at all', () => {
  const meta = { gameDateTime: 'Sat April 12, 2026, 2:00 PM - 4:30 PM CT' };
  const game = normalizeGameMeta(meta, 't1');
  assert.equal(game.gameDate, '2026-04-12');
});

test('normalizeGameMeta — gameDate is null when neither source produces a date', () => {
  const meta = {};
  const game = normalizeGameMeta(meta, 't1');
  assert.equal(game.gameDate, null);
});

test('normalizeGameMeta — recognizes any of the accepted explicit-date field name variants as the fallback', () => {
  const variants = [
    { game_date: '2026-05-01' },
    { scheduleGameDate: '2026-05-01' },
    { schedule_game_date: '2026-05-01' },
    { scheduleDate: '2026-05-01' },
    { schedule_date: '2026-05-01' },
    { date: '2026-05-01' },
  ];
  for (const meta of variants) {
    const game = normalizeGameMeta(meta, 't1');
    assert.equal(game.gameDate, '2026-05-01', JSON.stringify(meta));
  }
});

test('normalizeGameMeta — recognizes any of the accepted raw-datetime field name variants as the primary source', () => {
  const variants = [
    { gameDateTime: 'April 12, 2026, 2:00 PM' },
    { gameDatetimeRaw: 'April 12, 2026, 2:00 PM' },
    { game_datetime_raw: 'April 12, 2026, 2:00 PM' },
    { dateTime: 'April 12, 2026, 2:00 PM' },
  ];
  for (const meta of variants) {
    const game = normalizeGameMeta(meta, 't1');
    assert.equal(game.gameDate, '2026-04-12', JSON.stringify(meta));
  }
});

// ── Known, pre-existing tradeoff (not introduced by this correction) ───────
// parseDateTimeRaw() defaults to the CURRENT calendar year when the raw
// datetime string has no explicit 4-digit year (see its own year fallback:
// `yearMatch ? yearMatch[1] : new Date().getFullYear()`). With the
// corrected precedence, that year-defaulted date now wins over a correct,
// year-explicit schedule-card date whenever both are present and the
// datetime string omits its year. This is the confirmed, intended
// precedence per this correction -- documented here explicitly so it's a
// visible, intentional tradeoff rather than a silent surprise.
test('normalizeGameMeta — DOCUMENTED TRADEOFF: a year-less gameDateTime still wins over a year-correct explicit date (defaults to the current year)', () => {
  const meta = {
    gameDateTime: 'Sat April 12, 2:00 PM - 4:30 PM CT', // no year
    gameDate: '2024-04-12', // correct historical year
  };
  const game = normalizeGameMeta(meta, 't1');
  const currentYear = String(new Date().getFullYear());
  assert.equal(game.gameDate, `${currentYear}-04-12`);
  assert.notEqual(game.gameDate, '2024-04-12');
});
