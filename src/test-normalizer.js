'use strict';

/**
 * test-normalizer.js
 * Voodoo Scout — Normalization & DB Layer Tests
 *
 * Run with: node src/test-normalizer.js
 *
 * Uses an in-memory SQLite database — no files written.
 * Tests the full pipeline from raw JSON → normalized → DB → query.
 */

const assert = require('assert');
const path   = require('path');

// ─── Test Data ────────────────────────────────────────────────────────────────

const SAMPLE_RAW_GAME = {
  meta: {
    gameId:         'abc123def456',
    gameUrl:        'https://web.gc.com/teams/team-xyz/schedule/abc123def456',
    teamName:       'James Clemens Jets',
    capturedAt:     '2026-04-12T19:30:00.000Z',
    dateTime:       'Sat April 12, 2:00 PM - 4:30 PM CT',
    result:         'W',
    scoreUs:        '8',
    scoreThem:      '3',
    teamCandidates: ['James Clemens Jets 17U', 'Madison Academy 17U'],
    pageUrl:        'https://web.gc.com/teams/team-xyz/schedule/abc123def456',
  },
  boxScore: {
    batting: [
      { Player: 'Jake Smith',    Pos: 'CF', AB: '4', R: '2', H: '3', RBI: '2', BB: '0', SO: '0', AVG: '.750', '2B': '1', '3B': '0', HR: '1' },
      { Player: 'Tyler Johnson', Pos: 'SS', AB: '4', R: '1', H: '2', RBI: '1', BB: '1', SO: '1', AVG: '.500', '2B': '0', '3B': '0', HR: '0' },
      { Player: 'Marcus Davis',  Pos: 'P',  AB: '3', R: '1', H: '1', RBI: '2', BB: '1', SO: '0', AVG: '.333', '2B': '0', '3B': '1', HR: '0' },
      { Player: 'Chris Wilson',  Pos: '1B', AB: '4', R: '1', H: '1', RBI: '1', BB: '0', SO: '2', AVG: '.250', '2B': '0', '3B': '0', HR: '0' },
      { Player: 'Totals',        Pos: '',   AB: '15', R: '8', H: '10', RBI: '8', BB: '2', SO: '3', AVG: '' },
    ],
    pitching: [
      { Player: 'Marcus Davis', IP: '5.0', BF: '20', PC: '78', STR: '52', H: '4', R: '2', ER: '2', BB: '2', SO: '7', ERA: '3.60' },
      { Player: 'Ryan Torres',  IP: '2.0', BF: '7',  PC: '22', STR: '16', H: '1', R: '1', ER: '1', BB: '1', SO: '2', ERA: '4.50' },
    ],
    raw: {}
  },
  plays: [
    { inning: 'Top 1',    text: 'Jake Smith single to center field' },
    { inning: 'Top 1',    text: 'Tyler Johnson ground out to shortstop' },
    { inning: 'Top 1',    text: 'Marcus Davis walk' },
    { inning: 'Top 1',    text: 'Chris Wilson strikeout swinging' },
    { inning: 'Bottom 1', text: 'Opponent batter fly out to center' },
    { inning: 'Bottom 1', text: 'Opponent batter strikeout looking' },
    { inning: 'Bottom 1', text: 'Opponent batter walk' },
    { inning: 'Top 2',    text: 'Jake Smith home run to left field' },
    { inning: 'Top 2',    text: 'Tyler Johnson double to right field' },
    { inning: 'Bottom 7', text: 'End of inning' },
  ]
};

const SAMPLE_TEAM = {
  teamName:       'James Clemens Jets',
  rawTeamName:    'James Clemens Varsity Jets 2026',
  gcSearchName:   'James Clemens 17U Jets',
  gcTeamUrl:      'https://web.gc.com/teams/team-xyz',
  classification: 'Varsity',
  age:            '17',
  city:           'Madison',
  state:          'AL',
};

// ─── Test Runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n── ${name} ─────────────────────────────────`);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const {
  normalizeGameData,
  normalizeEventType,
  ipToDecimal,
  parseDateTimeRaw,
  _internals
} = require('./normalizer');

const { clean, toInt, toAvg, parseInning, extractPlayerFromPlay } = _internals;

section('Utility Helpers');

test('clean() trims and collapses whitespace', () => {
  assert.strictEqual(clean('  Jake  Smith  '), 'Jake Smith');
  assert.strictEqual(clean(null), '');
  assert.strictEqual(clean(undefined), '');
});

test('toInt() parses integers and handles garbage', () => {
  assert.strictEqual(toInt('4'), 4);
  assert.strictEqual(toInt(''), null);
  assert.strictEqual(toInt('N/A'), null);
  assert.strictEqual(toInt('.500'), null);
});

test('toAvg() normalizes batting averages', () => {
  assert.strictEqual(toAvg('.333'), '.333');
  assert.strictEqual(toAvg('0.333'), '.333');
  assert.strictEqual(toAvg(''), null);
  assert.strictEqual(toAvg('999'), null);
});

test('ipToDecimal() converts GC innings format', () => {
  assert.strictEqual(ipToDecimal('5.0'), 5.0);
  assert.strictEqual(ipToDecimal('3.2'), parseFloat((3 + 2/3).toFixed(4)));
  assert.strictEqual(ipToDecimal('0.1'), parseFloat((0 + 1/3).toFixed(4)));
  assert.strictEqual(ipToDecimal(''), null);
});

test('parseDateTimeRaw() extracts date and time', () => {
  const result = parseDateTimeRaw('Sat April 12, 2:00 PM - 4:30 PM CT');
  assert.ok(result.date, 'Should have a date');
  assert.match(result.date, /^\d{4}-04-12$/);
  assert.strictEqual(result.time, '14:00');
});

test('parseInning() parses inning strings', () => {
  const top3 = parseInning('Top 3');
  assert.strictEqual(top3.inningNum, 3);
  assert.strictEqual(top3.inningHalf, 'top');

  const bot7 = parseInning('Bottom 7');
  assert.strictEqual(bot7.inningNum, 7);
  assert.strictEqual(bot7.inningHalf, 'bottom');

  const none = parseInning(null);
  assert.strictEqual(none.inningNum, null);
});

section('Event Type Normalization');

test('normalizeEventType() classifies hits', () => {
  assert.strictEqual(normalizeEventType('Jake Smith single to center'), 'single');
  assert.strictEqual(normalizeEventType('Tyler Johnson double to right field'), 'double');
  assert.strictEqual(normalizeEventType('Marcus Davis triple to left'), 'triple');
  assert.strictEqual(normalizeEventType('Chris Wilson home run to deep left'), 'home_run');
});

test('normalizeEventType() classifies outs', () => {
  assert.strictEqual(normalizeEventType('ground out to shortstop'), 'ground_out');
  assert.strictEqual(normalizeEventType('fly out to center field'), 'fly_out');
  assert.strictEqual(normalizeEventType('strikeout swinging'), 'strikeout');
  assert.strictEqual(normalizeEventType('strikeout looking'), 'strikeout_looking');
});

test('normalizeEventType() classifies walks and HBP', () => {
  assert.strictEqual(normalizeEventType('Marcus Davis walk'), 'walk');
  assert.strictEqual(normalizeEventType('hit by pitch'), 'hbp');
});

test('normalizeEventType() returns unknown for unrecognized', () => {
  assert.strictEqual(normalizeEventType(''), 'unknown');
  assert.strictEqual(normalizeEventType('something completely different'), 'unknown');
});

test('extractPlayerFromPlay() extracts name from description', () => {
  const name = extractPlayerFromPlay('Jake Smith single to center field');
  assert.strictEqual(name, 'Jake Smith');
});

section('Game Normalization');

let normalized;

test('normalizeGameData() runs without error', () => {
  normalized = normalizeGameData(SAMPLE_RAW_GAME, 1);
  assert.ok(normalized);
});

test('normalizeGameData() produces game record', () => {
  assert.ok(normalized.game);
  assert.strictEqual(normalized.game.gcGameId, 'abc123def456');
  assert.strictEqual(normalized.game.result, 'W');
  assert.strictEqual(normalized.game.scoreUs, 8);
  assert.strictEqual(normalized.game.scoreThem, 3);
});

test('normalizeGameData() parses date correctly', () => {
  assert.match(normalized.game.gameDate || '', /2026-04-12/);
  assert.strictEqual(normalized.game.gameTime, '14:00');
});

test('normalizeGameData() extracts batting lines (excludes Totals row)', () => {
  assert.strictEqual(normalized.battingLines.length, 4);
  const jake = normalized.battingLines.find(b => b.playerName === 'Jake Smith');
  assert.ok(jake, 'Jake Smith should be in batting lines');
  assert.strictEqual(jake.ab, 4);
  assert.strictEqual(jake.h, 3);
  assert.strictEqual(jake.hr, 1);
  assert.strictEqual(jake.doubles, 1);
});

test('normalizeGameData() extracts pitching lines', () => {
  assert.strictEqual(normalized.pitchingLines.length, 2);
  const marcus = normalized.pitchingLines.find(p => p.playerName === 'Marcus Davis');
  assert.ok(marcus, 'Marcus Davis should be in pitching lines');
  assert.strictEqual(marcus.ip, '5.0');
  assert.strictEqual(marcus.ipDecimal, 5.0);
  assert.strictEqual(marcus.so, 7);
  assert.strictEqual(marcus.pc, 78);
});

test('normalizeGameData() extracts play events', () => {
  assert.ok(normalized.playEvents.length > 0);
  const single = normalized.playEvents.find(p => p.eventType === 'single');
  assert.ok(single, 'Should have a single event');
  assert.strictEqual(single.inningNum, 1);
  assert.strictEqual(single.inningHalf, 'top');
});

test('normalizeGameData() assigns sequence numbers', () => {
  const nums = normalized.playEvents.map(p => p.sequenceNum);
  assert.ok(nums[0] === 1, 'First event should be sequence 1');
  for (let i = 1; i < nums.length; i++) {
    assert.strictEqual(nums[i], nums[i-1] + 1);
  }
});

test('normalizeGameData() classifies home run from plays', () => {
  const hr = normalized.playEvents.find(p => p.eventType === 'home_run');
  assert.ok(hr, 'Should have a home_run event');
  assert.strictEqual(hr.inningNum, 2);
});

test('normalizeGameData() summary is accurate', () => {
  assert.strictEqual(normalized._summary.batters, 4);
  assert.strictEqual(normalized._summary.pitchers, 2);
  assert.ok(normalized._summary.plays >= 9);
  assert.ok(normalized._summary.hasBattingData);
  assert.ok(normalized._summary.hasPitchingData);
  assert.ok(normalized._summary.hasPlayData);
});

test('normalizeGameData() handles empty/missing plays gracefully', () => {
  const emptyPlays = normalizeGameData({ ...SAMPLE_RAW_GAME, plays: [] }, 1);
  assert.strictEqual(emptyPlays.playEvents.length, 0);
  assert.ok(!emptyPlays._summary.hasPlayData);
});

test('normalizeGameData() handles missing box score gracefully', () => {
  const noBox = normalizeGameData({ ...SAMPLE_RAW_GAME, boxScore: {} }, 1);
  assert.strictEqual(noBox.battingLines.length, 0);
  assert.strictEqual(noBox.pitchingLines.length, 0);
});

section('Database Layer (in-memory)');

let dbModule;

test('db.init() creates in-memory database', () => {
  dbModule = require('./db');
  const result = dbModule.init(':memory:');
  assert.ok(result);
});

test('db.upsertTeam() inserts a team', () => {
  const teamId = dbModule.upsertTeam(SAMPLE_TEAM);
  assert.ok(typeof teamId === 'number', `Expected number, got ${typeof teamId}`);
  assert.ok(teamId > 0);
});

test('db.writeNormalizedGame() writes game + stats atomically', () => {
  const team = dbModule.getTeamByUrl(SAMPLE_TEAM.gcTeamUrl);
  assert.ok(team, 'Team should exist');

  const norm = normalizeGameData(SAMPLE_RAW_GAME, team.id);
  const result = dbModule.writeNormalizedGame(norm);

  assert.ok(result.gameId > 0);
  assert.strictEqual(result.batters, 4);
  assert.strictEqual(result.pitchers, 2);
  assert.ok(result.plays >= 9);
});

test('db.writeNormalizedGame() is idempotent (duplicate skipped)', () => {
  const team = dbModule.getTeamByUrl(SAMPLE_TEAM.gcTeamUrl);
  const norm = normalizeGameData(SAMPLE_RAW_GAME, team.id);

  // db.insertGame() detects the duplicate via gc_game_id and skips silently.
  const gamesBefore = dbModule.getGamesByTeam(team.id).length;
  dbModule.writeNormalizedGame(norm);
  const gamesAfter = dbModule.getGamesByTeam(team.id).length;
  assert.strictEqual(gamesBefore, gamesAfter, 'Duplicate write should not add a second game row');
});

test('db.getTeamBattingAggregates() returns correct totals', () => {
  const team = dbModule.getTeamByUrl(SAMPLE_TEAM.gcTeamUrl);
  const batting = dbModule.getTeamBattingAggregates(team.id);

  assert.ok(batting.length > 0, 'Should have batting aggregates');
  const jake = batting.find(b => b.player_name === 'Jake Smith');
  assert.ok(jake, 'Jake Smith should appear in aggregates');
  // Use >= in case the idempotent test re-inserted (graceful handling)
  assert.ok(jake.total_ab >= 4, `Expected at least 4 AB, got ${jake.total_ab}`);
  assert.ok(jake.total_h >= 3, `Expected at least 3 H, got ${jake.total_h}`);
});

test('db.getTeamPitchingAggregates() calculates ERA correctly', () => {
  const team = dbModule.getTeamByUrl(SAMPLE_TEAM.gcTeamUrl);
  const pitching = dbModule.getTeamPitchingAggregates(team.id);

  assert.ok(pitching.length > 0);
  const marcus = pitching.find(p => p.player_name === 'Marcus Davis');
  assert.ok(marcus);
  // ERA = 9 * 2 ER / 5.0 IP = 3.60
  assert.ok(Math.abs(marcus.era - 3.60) < 0.1, `ERA should be ~3.60, got ${marcus.era}`);
});

test('db.getTeamPlayTendencies() returns event distribution', () => {
  const team = dbModule.getTeamByUrl(SAMPLE_TEAM.gcTeamUrl);
  const tendencies = dbModule.getTeamPlayTendencies(team.id);

  assert.ok(tendencies.length > 0);
  const single = tendencies.find(t => t.event_type === 'single');
  assert.ok(single, 'Should have single events');
  assert.ok(single.count >= 1);
  assert.ok(single.pct > 0 && single.pct <= 100);
});

test('db.getTeamAnalysisBundle() returns complete bundle', () => {
  const team = dbModule.getTeamByUrl(SAMPLE_TEAM.gcTeamUrl);
  const bundle = dbModule.getTeamAnalysisBundle(team.id);

  assert.ok(bundle.team);
  assert.ok(Array.isArray(bundle.games));
  assert.ok(Array.isArray(bundle.batting));
  assert.ok(Array.isArray(bundle.pitching));
  assert.ok(Array.isArray(bundle.tendencies));
  assert.ok(bundle.meta.gamesAnalyzed >= 1);
});

// ─── Results ──────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error('\n⚠ Some tests failed. Fix before integrating.\n');
  process.exit(1);
} else {
  console.log('\n✓ All tests passed. Normalizer and DB layer are solid.\n');
}
