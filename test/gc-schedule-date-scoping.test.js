'use strict';

// Deterministic date scoping for HS 2D opponent schedules.
//
// Runs the REAL extractor in src/search-gamechanger-teams.js against sanitized
// offline DOM fixtures in a real Chromium page. Nothing here is a stub that
// returns pre-normalized objects: the fixtures are HTML, they are served to the
// page by a route that fulfils only the fixture URL and ABORTS everything else,
// and the assertions are about what the extractor actually parses out of the
// DOM. test/helpers/gc-network-guard.js additionally aborts any request to
// gc.com, so a real GameChanger fetch is structurally impossible.
//
// The defect this file exists to prevent:
//
//   twoDateGroups (before)      grp-a=2026-04-11  grp-b=null
//                               grp-c=2026-04-18  grp-d=2026-04-11  <-- WRONG
//   twoDateGroups (reversed)    grp-c=2026-04-11  <-- the wrong date MOVED
//
// A row used to hunt for a date through its parent's previous sibling, which
// reaches into the PREVIOUS date group's whole subtree. A date header now
// governs exactly its own scope, so a date can never cross a group boundary and
// DOM order can never decide which game is wrong.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

// src/search-gamechanger-teams.js resolves a session path at module load, and
// src/gc-session-loader.js fails closed in test mode unless an EXPLICIT path is
// supplied -- it will never fall back to the production session. This points at
// a synthetic file that deliberately does not exist, the same convention
// test/gc-network-isolation.test.js uses. No session is ever loaded: these tests
// never pass storageState to a browser context.
process.env.GC_AUTH_FILE_PATH = path.join(__dirname, 'this-fixture-does-not-exist-synthetic.json');

const scraper = require('../src/search-gamechanger-teams');
const fixtures = require('./fixtures/gc-schedule-fixtures');

const {
  SCHEDULE_EXTRACTION_MODES,
  DATE_RESOLUTION_STATUSES,
  DATE_SOURCE_KINDS,
  resolveScheduleEntryDate,
} = scraper;
const ALL = SCHEDULE_EXTRACTION_MODES.ALL_SCHEDULE_ENTRIES;

let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { if (browser) await browser.close(); });

async function withPage(html, fn) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('**/*', (route) => {
    if (route.request().url().startsWith('https://web.gc.com/__fixture__')) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    }
    return route.abort();
  });
  try {
    await page.goto('https://web.gc.com/__fixture__/schedule');
    return await fn(page);
  } finally {
    await context.close();
  }
}

const entriesFrom = (html) => withPage(html, (page) => scraper.getVisibleScheduleEntries(page, { mode: ALL }));
const byId = (entries) => Object.fromEntries(entries.map((entry) => [entry.gameId, entry]));
const datesById = (entries) => Object.fromEntries(entries.map((entry) => [entry.gameId, entry.gameDate]));

// ── The pure resolver ──────────────────────────────────────────────────
//
// Exercised directly so the RULES are pinned independently of any markup, and
// so a future markup change cannot quietly satisfy a test by accident.

test('the date resolver prefers a per-game date and treats a matching group date as confirmation', () => {
  const resolved = resolveScheduleEntryDate({
    rowDateTexts: ['Apr 11, 2026'], groupDateTexts: ['Apr 11, 2026'], groupHeaderText: 'Apr 11, 2026',
  });
  assert.equal(resolved.gameDate, '2026-04-11');
  assert.equal(resolved.dateResolutionStatus, DATE_RESOLUTION_STATUSES.RESOLVED_GAME_ROW);
  assert.equal(resolved.dateSourceKind, DATE_SOURCE_KINDS.GAME_ROW);
  assert.equal(resolved.dateConflict, null, 'agreement is confirmation, never a conflict');
});

test('the date resolver reports a conflict instead of choosing between row and group', () => {
  const resolved = resolveScheduleEntryDate({
    rowDateTexts: ['Apr 25, 2026'], groupDateTexts: ['Apr 11, 2026'], groupHeaderText: 'Apr 11, 2026',
  });
  assert.equal(resolved.gameDate, null, 'a contradicted date is never published');
  assert.equal(resolved.dateResolutionStatus, DATE_RESOLUTION_STATUSES.CONFLICTING);
  assert.deepEqual(resolved.dateConflict, {
    reason: 'game_row_contradicts_date_group', gameRowDate: '2026-04-25', dateGroupDate: '2026-04-11',
  }, 'both candidates are preserved so reconciliation can see what disagreed');
});

test('the date resolver reports evidence naming several dates as ambiguous', () => {
  const group = resolveScheduleEntryDate({ groupDateTexts: ['Apr 11, 2026', 'Apr 13, 2026'], groupHeaderText: 'Apr 11, 2026 - Apr 13, 2026' });
  assert.equal(group.gameDate, null);
  assert.equal(group.dateResolutionStatus, DATE_RESOLUTION_STATUSES.AMBIGUOUS);
  assert.deepEqual(group.dateConflict.candidates, ['2026-04-11', '2026-04-13']);

  const row = resolveScheduleEntryDate({ rowDateTexts: ['Apr 11, 2026', 'Apr 12, 2026'] });
  assert.equal(row.gameDate, null);
  assert.equal(row.dateResolutionStatus, DATE_RESOLUTION_STATUSES.AMBIGUOUS);
  assert.equal(row.dateSourceKind, DATE_SOURCE_KINDS.GAME_ROW);
});

test('the date resolver invents nothing when the source expressed no date', () => {
  const resolved = resolveScheduleEntryDate({});
  assert.equal(resolved.gameDate, null);
  assert.equal(resolved.dateResolutionStatus, DATE_RESOLUTION_STATUSES.NOT_EXPRESSED);
  assert.equal(resolved.dateSourceKind, DATE_SOURCE_KINDS.NONE);
});

test('the date resolver ignores order and duplication of equivalent evidence', () => {
  const a = resolveScheduleEntryDate({ groupDateTexts: ['Apr 11, 2026', 'Apr 11, 2026'], groupHeaderText: 'Apr 11, 2026' });
  const b = resolveScheduleEntryDate({ groupDateTexts: ['Apr 11, 2026'], groupHeaderText: 'Apr 11, 2026' });
  assert.deepEqual(a, b, 'the same date repeated is one date, not an ambiguity');
});

// ── A date group governs every game inside it ──────────────────────────

test('every game in a date group receives the group date, whatever its status', async () => {
  for (const [name, html] of [
    ['two scheduled', fixtures.dateGroupTwoScheduled],
    ['two completed', fixtures.dateGroupTwoCompleted],
    ['one of each', fixtures.dateGroupMixedStatuses],
  ]) {
    const entries = await entriesFrom(html);
    assert.equal(entries.length, 2, `${name}: both games survive extraction`);
    assert.ok(entries.every((entry) => entry.gameDate === '2026-04-11'),
      `${name}: the group date reaches every game, not only the one next to the header`);
    assert.ok(entries.every((entry) => entry.dateResolutionStatus === DATE_RESOLUTION_STATUSES.RESOLVED_DATE_GROUP),
      `${name}: and each explains where its date came from`);
  }
  const mixed = await entriesFrom(fixtures.dateGroupMixedStatuses);
  assert.deepEqual(mixed.map((entry) => entry.status).sort(), ['final', 'scheduled'],
    'a shared date never flattens the distinct statuses');
});

test('a date never crosses from one sibling date group into the next', async () => {
  const entries = await entriesFrom(fixtures.twoDateGroupsTwoGamesEach);
  assert.equal(entries.length, 4);
  assert.deepEqual(datesById(entries), {
    'grp-a': '2026-04-11', 'grp-b': '2026-04-11',
    'grp-c': '2026-04-18', 'grp-d': '2026-04-18',
  }, 'grp-d belongs to April 18 and must never inherit April 11 from the previous group');
  assert.ok(entries.every((entry) => entry.dateConflict === null));
});

test('reversing games within a group, or reversing the groups, changes no date', async () => {
  const forwards = datesById(await entriesFrom(fixtures.twoDateGroupsTwoGamesEach));
  const gamesReversed = datesById(await entriesFrom(fixtures.twoDateGroupsGamesReversedWithinGroups));
  const groupsReversed = datesById(await entriesFrom(fixtures.twoDateGroupsGroupOrderReversed));
  assert.deepEqual(gamesReversed, forwards, 'game order within a group is not evidence about dates');
  assert.deepEqual(groupsReversed, forwards, 'group order is not evidence about dates either');
});

test('two independent schedule sections never share a date', async () => {
  const entries = await entriesFrom(fixtures.twoIndependentScheduleSections);
  assert.equal(entries.length, 4);
  assert.deepEqual(datesById(entries), {
    'sec1-a': '2026-04-11', 'sec1-b': '2026-04-11',
    'sec2-a': '2026-05-02', 'sec2-b': '2026-05-02',
  }, 'there is no global last-date-seen that could leak between sections');
});

// ── Per-game dates, absence, and disagreement ──────────────────────────

test('an explicit per-game date is used even with no group header present', async () => {
  const entries = await entriesFrom(fixtures.explicitDateOnEveryGame);
  assert.deepEqual(datesById(entries), { 'own-a': '2026-04-11', 'own-b': '2026-04-18' });
  assert.ok(entries.every((entry) => entry.dateSourceKind === DATE_SOURCE_KINDS.GAME_ROW));
});

test('a per-game date that matches its group is confirmation; one that contradicts it is a conflict', async () => {
  const agreeing = byId(await entriesFrom(fixtures.groupDateWithMatchingGameDate));
  assert.equal(agreeing['agree-a'].gameDate, '2026-04-11');
  assert.equal(agreeing['agree-a'].dateResolutionStatus, DATE_RESOLUTION_STATUSES.RESOLVED_GAME_ROW);
  assert.equal(agreeing['agree-b'].gameDate, '2026-04-11');

  const clashing = byId(await entriesFrom(fixtures.groupDateWithConflictingGameDate));
  assert.equal(clashing['clash-a'].gameDate, null, 'a contradicted date is never guessed');
  assert.equal(clashing['clash-a'].dateResolutionStatus, DATE_RESOLUTION_STATUSES.CONFLICTING);
  assert.equal(clashing['clash-a'].dateConflict.gameRowDate, '2026-04-25');
  assert.equal(clashing['clash-a'].dateConflict.dateGroupDate, '2026-04-11');
  assert.equal(clashing['clash-b'].gameDate, '2026-04-11',
    'one row disagreeing does not poison its neighbour');
});

test('a header naming two dates resolves to no date at all', async () => {
  const entries = await entriesFrom(fixtures.dateGroupWithTwoDatesInHeader);
  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => entry.gameDate === null));
  assert.ok(entries.every((entry) => entry.dateResolutionStatus === DATE_RESOLUTION_STATUSES.AMBIGUOUS));
  assert.ok(entries.every((entry) => entry.dateConflict.reason === 'multiple_date_group_dates'));
});

test('unrecognizable, malformed, or absent headers report not_expressed rather than a guess', async () => {
  for (const [name, html] of [
    ['no date in the header', fixtures.dateGroupWithUnrecognizableHeader],
    ['a day number no calendar has', fixtures.malformedDateHeaderText],
  ]) {
    const entries = await entriesFrom(html);
    assert.equal(entries.length, 2, `${name}: the games themselves still survive`);
    assert.ok(entries.every((entry) => entry.gameDate === null), `${name}: nothing is invented`);
    assert.ok(entries.every((entry) => entry.dateResolutionStatus === DATE_RESOLUTION_STATUSES.NOT_EXPRESSED),
      `${name}: and the absence is stated, not silent`);
  }
});

test('a game outside every date group takes no date from the group beside it', async () => {
  const entries = byId(await entriesFrom(fixtures.gameOutsideAnyDateGroup));
  assert.equal(entries['loose-a'].gameDate, null);
  assert.equal(entries['loose-a'].dateResolutionStatus, DATE_RESOLUTION_STATUSES.NOT_EXPRESSED);
  assert.equal(entries['grouped-b'].gameDate, '2026-04-18', 'the grouped game is unaffected');
});

// ── Reschedules, doubleheaders, and cosmetic variation ─────────────────

test('a reschedule moves the date and keeps the stable upstream identity', async () => {
  const before = byId(await entriesFrom(fixtures.rescheduledStableIdBefore));
  const after = byId(await entriesFrom(fixtures.rescheduledStableIdAfter));
  assert.equal(before['resched-1'].gameDate, '2026-04-10');
  assert.equal(after['resched-1'].gameDate, '2026-04-17', 'the date follows the source');
  assert.equal(before['resched-1'].gameId, after['resched-1'].gameId, 'the identity does not');
  assert.equal(before['resched-2'].gameDate, '2026-04-10',
    'the second game in the group moves with it rather than being left dateless');
  assert.equal(after['resched-2'].gameDate, '2026-04-17');
});

test('both halves of a doubleheader under one header get that date and stay distinct', async () => {
  for (const [name, html, date] of [
    ['completed', fixtures.doubleheaderUnderOneDateHeader, '2026-04-11'],
    ['future', fixtures.futureDoubleheaderUnderOneDateHeader, '2026-05-09'],
  ]) {
    const entries = await entriesFrom(html);
    assert.equal(entries.length, 2, `${name}: two games, not one`);
    assert.ok(entries.every((entry) => entry.gameDate === date), `${name}: both on the header's date`);
    assert.deepEqual(entries.map((entry) => entry.gameNumber).sort(), [1, 2],
      `${name}: the doubleheader discriminator survives`);
    assert.ok(entries.every((entry) => entry.identityCollision === false),
      `${name}: distinct upstream ids are not a collision`);
  }
});

test('harmless date formatting and whitespace do not change the resolved date', async () => {
  const plain = await entriesFrom(fixtures.dateGroupTwoCompleted);
  const varied = await entriesFrom(fixtures.dateFormatAndWhitespaceVariation);
  assert.deepEqual(datesById(varied), datesById(plain),
    '"Saturday,   April   11,    2026" is the same day as "Apr 11, 2026"');
  assert.ok(varied.every((entry) => entry.rawDateText === 'Saturday, April 11, 2026'),
    'raw provenance is kept, but whitespace-collapsed so it cannot mint a generation on its own');
});

// ── Equivalent relative and absolute references ────────────────────────

test('relative and absolute forms of one schedule path are one game, not a collision', async () => {
  const entries = await entriesFrom(fixtures.relativeAndAbsoluteSameGame);
  assert.equal(entries.length, 1, 'the two anchors describe a single game');
  assert.equal(entries[0].rowAnchorCount, 2);
  assert.equal(entries[0].gameId, 'rel-abs-1');
  assert.equal(entries[0].result, 'W', 'the whole row is still read, so the score survives');
  assert.equal(entries[0].identityCollision, false,
    'equivalent reference forms must not be reported as two rows claiming one identity');
});

test('two genuinely different schedule paths stay two distinct games', async () => {
  const entries = await entriesFrom(fixtures.relativeAndAbsoluteDifferentGames);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.gameId).sort(), ['rel-abs-1', 'rel-abs-2']);
  assert.ok(entries.every((entry) => entry.identityCollision === false),
    'normalization must never collapse distinct path segments into each other');
});

test('two separate rows sharing one reference still reach collision handling', async () => {
  const entries = await entriesFrom(fixtures.twoRowsSharedHref);
  assert.equal(entries.length, 2, 'cross-row observations stay separate');
  assert.ok(entries.every((entry) => entry.identityCollision),
    'reference normalization groups anchors within a row, never across rows');
});
