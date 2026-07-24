'use strict';

// Focused tests for the abbreviated-month-name parsing correction in
// src/normalizer.js's parseDateTimeRaw(). Before this correction, its month
// regex only matched full month names (January, February, ...) -- a
// confirmed production-style raw value using an abbreviated month ("Sat Jun
// 13, 5:00 PM - 6:00 PM CT") produced date: null, which meant explicitGameDate
// (or nothing) silently took over even though the corrected precedence
// (PR #6, `dateTime.date || explicitGameDate`) intends the header-parsed
// date to be authoritative whenever it's actually parseable.
//
// The fix mirrors normalizeDateCandidate()'s already-working, already-tested
// abbreviated-month + optional-period pattern -- copied locally into
// parseDateTimeRaw's own scope rather than shared/refactored across both
// functions, so normalizeDateCandidate's existing, proven behavior is not
// touched at all by this change.
//
// Run with: node --test test/normalizer-abbreviated-months.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDateTimeRaw, normalizeGameMeta } = require('../src/normalizer');

const CURRENT_YEAR = String(new Date().getFullYear());

// ── 1-2. Full month / abbreviated month, both with an explicit year ────────

test('parseDateTimeRaw — full month name with explicit year', () => {
  assert.equal(parseDateTimeRaw('June 13, 2026, 5:00 PM').date, '2026-06-13');
});

test('parseDateTimeRaw — abbreviated month with explicit year (defect reproduction, now fixed)', () => {
  assert.equal(parseDateTimeRaw('Jun 13, 2026, 5:00 PM').date, '2026-06-13');
});

// ── 3. Yearless abbreviated month — deterministic via the current year ─────

test('parseDateTimeRaw — yearless abbreviated month falls back to the current year (existing year-inference behavior, unchanged)', () => {
  assert.equal(parseDateTimeRaw('Sat Jun 13, 5:00 PM - 6:00 PM CT').date, `${CURRENT_YEAR}-06-13`);
});

// ── 4. Abbreviation with a trailing period ──────────────────────────────────

test('parseDateTimeRaw — abbreviation with a trailing period', () => {
  assert.equal(parseDateTimeRaw('Jun. 13, 2026, 5:00 PM').date, '2026-06-13');
});

// ── 5. September variants (the one month whose abbreviation is ambiguous) ──

test('parseDateTimeRaw — all four September forms resolve to month 09', () => {
  assert.equal(parseDateTimeRaw('Sep 5, 2026').date, '2026-09-05');
  assert.equal(parseDateTimeRaw('Sept 5, 2026').date, '2026-09-05');
  assert.equal(parseDateTimeRaw('Sep. 5, 2026').date, '2026-09-05');
  assert.equal(parseDateTimeRaw('Sept. 5, 2026').date, '2026-09-05');
});

// ── 6-7. Weekday prefixes (abbreviated and full) do not block the match ────

test('parseDateTimeRaw — abbreviated weekday prefix ("Sat, Jun 13, 2026")', () => {
  assert.equal(parseDateTimeRaw('Sat, Jun 13, 2026, 5:00 PM').date, '2026-06-13');
});

test('parseDateTimeRaw — full weekday prefix ("Saturday, June 13, 2026")', () => {
  assert.equal(parseDateTimeRaw('Saturday, June 13, 2026, 5:00 PM').date, '2026-06-13');
});

// ── 8. Case-insensitivity ───────────────────────────────────────────────────

test('parseDateTimeRaw — lowercase and mixed-case month text still matches', () => {
  assert.equal(parseDateTimeRaw('sat jun 13, 2026, 5:00 pm').date, '2026-06-13');
  assert.equal(parseDateTimeRaw('SAT JUN 13, 2026, 5:00 PM').date, '2026-06-13');
  assert.equal(parseDateTimeRaw('SaT JuN 13, 2026, 5:00 PM').date, '2026-06-13');
});

// ── 9. Date correctly separated from trailing game-time text ───────────────

test('parseDateTimeRaw — date and time are both extracted correctly from the same string', () => {
  const result = parseDateTimeRaw('Sat Jun 13, 2026, 2:00 PM - 4:30 PM CT');
  assert.equal(result.date, '2026-06-13');
  assert.equal(result.time, '14:00');
});

// ── 10-12. Interaction with the corrected precedence (via normalizeGameMeta) ─

test('normalizeGameMeta — a parsed abbreviated-month header date wins over a conflicting explicitGameDate', () => {
  const game = normalizeGameMeta({
    gameDateTime: 'Sat Jun 13, 2026, 5:00 PM - 6:00 PM CT',
    gameDate: '2026-06-20', // deliberately different
  }, 't1');
  assert.equal(game.gameDate, '2026-06-13');
});

test('normalizeGameMeta — an unparseable header (no month at all) falls back to explicitGameDate', () => {
  const game = normalizeGameMeta({
    gameDateTime: '5:00 PM - 6:00 PM CT', // no date info
    gameDate: '2026-06-20',
  }, 't1');
  assert.equal(game.gameDate, '2026-06-20');
});

test('normalizeGameMeta — a blank header falls back to explicitGameDate', () => {
  const game = normalizeGameMeta({ gameDateTime: '', gameDate: '2026-06-20' }, 't1');
  assert.equal(game.gameDate, '2026-06-20');
});

// ── 13. Existing full-month behavior is unchanged ───────────────────────────

test('parseDateTimeRaw — existing full-month-name behavior is unchanged by this correction', () => {
  assert.equal(parseDateTimeRaw('Sat April 12, 2026, 2:00 PM - 4:30 PM CT').date, '2026-04-12');
});

// ── 14-15. parseDateTimeRaw never supported ISO/slash dates -- still doesn't ─
// (ISO/slash parsing lives in the separate normalizeDateCandidate(), used for
// explicitGameDate -- untouched by this correction, and not this function's job.)

test('parseDateTimeRaw — a bare ISO date string with no month name still does not parse (unchanged; ISO support belongs to normalizeDateCandidate, not this function)', () => {
  assert.equal(parseDateTimeRaw('2026-06-13').date, null);
});

test('parseDateTimeRaw — a bare slash date string with no month name still does not parse (unchanged; slash-date support belongs to normalizeDateCandidate, not this function)', () => {
  assert.equal(parseDateTimeRaw('6/13/2026').date, null);
});

// ── 16-17. Malformed near-matches and unrelated text are rejected ──────────

test('parseDateTimeRaw — malformed near-matches (a capitalized non-month word plus digits) do not produce a false date', () => {
  assert.equal(parseDateTimeRaw('Field 13, Diamond 2').date, null);
  assert.equal(parseDateTimeRaw('Juness 13').date, null); // not a real abbreviation/name
});

test('parseDateTimeRaw — unrelated text with no date information produces no date', () => {
  assert.equal(parseDateTimeRaw('Weather delayed, check back later').date, null);
});

// ── 18. gameDatetimeRaw passthrough is unchanged ────────────────────────────

test('normalizeGameMeta — gameDatetimeRaw still carries the exact original raw string, unaffected by this correction', () => {
  const raw = 'Sat Jun 13, 2026, 5:00 PM - 6:00 PM CT';
  const game = normalizeGameMeta({ gameDateTime: raw }, 't1');
  assert.equal(game.gameDatetimeRaw, raw);
});

// ── 19. Unrelated normalized metadata is unaffected ─────────────────────────

test('normalizeGameMeta — unrelated fields (opponentName, result, scores) are unaffected by the date-parsing correction', () => {
  const game = normalizeGameMeta({
    gameDateTime: 'Sat Jun 13, 2026, 5:00 PM - 6:00 PM CT',
    scoreUs: 5, scoreThem: 3, result: 'W',
    teamCandidates: ['Our Team', 'Rival Ravens'],
  }, 't1');
  assert.equal(game.scoreUs, 5);
  assert.equal(game.scoreThem, 3);
  assert.equal(game.result, 'W');
});

// ── 20. No timezone-induced one-day shift ───────────────────────────────────
// parseDateTimeRaw builds the date string via plain regex-extracted
// year/month/day concatenation -- it never routes through `new
// Date(...).toISOString()` or any other UTC-normalizing step, so a
// late-night local time cannot roll the calendar date forward or back.

test('parseDateTimeRaw — a late-night time does not shift the parsed calendar date (no UTC conversion)', () => {
  assert.equal(parseDateTimeRaw('Jun 13, 2026, 11:58 PM CT').date, '2026-06-13');
});

test('parseDateTimeRaw — an early-morning time does not shift the parsed calendar date (no UTC conversion)', () => {
  assert.equal(parseDateTimeRaw('Jun 13, 2026, 12:01 AM CT').date, '2026-06-13');
});

// ── 21. Every required month abbreviation, not merely Jun/Jul ──────────────

test('parseDateTimeRaw — every required month abbreviation resolves to the correct month number', () => {
  const cases = [
    ['Jan', '01'], ['Feb', '02'], ['Mar', '03'], ['Apr', '04'], ['May', '05'], ['Jun', '06'],
    ['Jul', '07'], ['Aug', '08'], ['Sep', '09'], ['Oct', '10'], ['Nov', '11'], ['Dec', '12'],
  ];
  for (const [abbrev, num] of cases) {
    assert.equal(parseDateTimeRaw(`${abbrev} 15, 2026`).date, `2026-${num}-15`, abbrev);
  }
});

test('parseDateTimeRaw — every full month name still resolves to the correct month number (existing behavior preserved)', () => {
  const cases = [
    ['January', '01'], ['February', '02'], ['March', '03'], ['April', '04'], ['May', '05'], ['June', '06'],
    ['July', '07'], ['August', '08'], ['September', '09'], ['October', '10'], ['November', '11'], ['December', '12'],
  ];
  for (const [name, num] of cases) {
    assert.equal(parseDateTimeRaw(`${name} 15, 2026`).date, `2026-${num}-15`, name);
  }
});
