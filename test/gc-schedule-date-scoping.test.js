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

test('unrecognizable, malformed, or absent headers never guess, and say WHICH kind of nothing they found', async () => {
  // Two different absences, deliberately reported differently. A header with no
  // date in it means the source said nothing, which is ordinary. A header naming
  // a day no calendar has means the source said something impossible, which is
  // evidence of an upstream or parsing fault a reviewer needs to see -- so it is
  // 'invalid', not folded into the same bucket as silence. Neither invents a
  // date, and both keep the games themselves.
  for (const [name, html, expected] of [
    ['no date in the header', fixtures.dateGroupWithUnrecognizableHeader, DATE_RESOLUTION_STATUSES.NOT_EXPRESSED],
    ['a day number no calendar has', fixtures.malformedDateHeaderText, DATE_RESOLUTION_STATUSES.INVALID],
  ]) {
    const entries = await entriesFrom(html);
    assert.equal(entries.length, 2, `${name}: the games themselves still survive`);
    assert.ok(entries.every((entry) => entry.gameDate === null), `${name}: nothing is invented`);
    assert.ok(entries.every((entry) => entry.dateResolutionStatus === expected),
      `${name}: expected every row to report ${expected}`);
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

// ── HS 2D final-review correction ──────────────────────────────────────
//
// The affirmative date-header contract. DATE_HEADER_SELECTOR used to be passed
// into the page and ignored, so any short element containing a parseable date
// governed every row in its parent's subtree. Two shapes were reproduced
// publishing a WRONG date into a verified generation; both are pinned here
// alongside the whole family of unmarked dated text they belong to.

test('the pure resolver reports an impossible calendar date as invalid, not as silence', () => {
  const impossible = resolveScheduleEntryDate({ groupDateTexts: ['Feb 30, 2026'], groupHeaderText: 'Feb 30, 2026' });
  assert.equal(impossible.gameDate, null);
  assert.equal(impossible.dateResolutionStatus, DATE_RESOLUTION_STATUSES.INVALID);
  assert.equal(impossible.dateConflict.reason, 'date_group_date_is_not_a_real_calendar_date');

  const silent = resolveScheduleEntryDate({});
  assert.equal(silent.dateResolutionStatus, DATE_RESOLUTION_STATUSES.NOT_EXPRESSED,
    'saying nothing and saying something impossible are different answers');
});

test('real calendar arithmetic decides which days exist', () => {
  const { isRealCalendarDate } = scraper;
  for (const [y, m, d, expected] of [
    [2026, 2, 28, true], [2026, 2, 29, false], [2028, 2, 29, true], [2026, 2, 30, false],
    [2026, 4, 30, true], [2026, 4, 31, false], [2026, 12, 31, true], [2026, 13, 1, false],
    [2026, 1, 0, false], [2026, 0, 1, false], [1900, 2, 29, false], [2000, 2, 29, true],
  ]) {
    assert.equal(isRealCalendarDate(y, m, d), expected, `${y}-${m}-${d} should be ${expected}`);
  }
});

test('an impossible calendar date never normalizes to a nearby real one', () => {
  const { normalizeScheduleDateText } = scraper;
  assert.equal(normalizeScheduleDateText('Feb 30, 2026'), null);
  assert.equal(normalizeScheduleDateText('Apr 31, 2026'), null);
  assert.equal(normalizeScheduleDateText('2/30/2026'), null);
  assert.equal(normalizeScheduleDateText('Feb 29, 2026'), null);
  assert.equal(normalizeScheduleDateText('Feb 29, 2028'), '2028-02-29');
  assert.equal(normalizeScheduleDateText('Apr 30, 2026'), '2026-04-30');
});

// The two shapes the final review reproduced publishing a wrong date.

test('a page caption beside a headerless schedule dates nothing', async () => {
  const entries = await entriesFrom(fixtures.captionBeforeHeaderlessSchedule);
  assert.equal(entries.length, 1, 'the game itself survives');
  assert.equal(entries[0].gameDate, null, 'the caption date 2026-03-03 is NOT adopted');
  assert.equal(entries[0].dateResolutionStatus, DATE_RESOLUTION_STATUSES.NOT_EXPRESSED);
  assert.equal(entries[0].dateSourceKind, DATE_SOURCE_KINDS.NONE);
});

test('an unrelated dated note between two games governs neither of them', async () => {
  const entries = byId(await entriesFrom(fixtures.datedNoteBetweenGames));
  // Before the correction note-b took 2026-04-20 from the note. Its group says
  // Apr 11, and that is the only marked claim on it.
  assert.equal(entries['note-a'].gameDate, '2026-04-11');
  assert.equal(entries['note-b'].gameDate, '2026-04-11',
    'the note date 2026-04-20 must never reach the game after it');
  assert.equal(entries['note-b'].dateSourceKind, DATE_SOURCE_KINDS.DATE_GROUP);
});

test('no unmarked dated element anywhere can govern a game', async () => {
  for (const [name, fixture] of [
    ['a note before the first game', fixtures.datedNoteBeforeFirstGame],
    ['a note after the last game', fixtures.datedNoteAfterLastGame],
    ['a tournament title', fixtures.datedTournamentTitle],
    ['a registration deadline', fixtures.registrationClosesDate],
    ['a last-synced stamp', fixtures.lastSyncedDate],
    ['a caption inside the group', fixtures.datedCaptionInsideGroup],
    ['a caption outside the component', fixtures.datedCaptionOutsideComponent],
  ]) {
    const entries = await entriesFrom(fixture);
    const governed = entries.filter((entry) => entry.gameDate !== null);
    // datedNoteAfterLastGame carries a real marked header, so its game IS dated;
    // what matters is that the note's own date is not the one that won.
    for (const entry of governed) {
      assert.equal(entry.gameDate, '2026-04-11', `${name}: only a marked header may date a game`);
    }
    for (const entry of entries.filter((e) => e.gameDate === null)) {
      assert.equal(entry.dateResolutionStatus, DATE_RESOLUTION_STATUSES.NOT_EXPRESSED,
        `${name}: the absence is stated, not silent`);
    }
  }
});

test('a MARKED header whose text is not a readable schedule date is refused BY NAME', async () => {
  // This used to report not_expressed, which conflated two different things:
  // "the source said nothing" and "the source marked a date header and said
  // something this parser will not interpret". Only the first may reach the
  // completed-game null-date exception, so they now carry different statuses.
  const entries = await entriesFrom(fixtures.markedHeaderWithUpdatedQualifier);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].gameDate, null,
    '"Updated Apr 20, 2026" is a date about the schedule, not a date games are played on');
  assert.equal(entries[0].dateResolutionStatus, DATE_RESOLUTION_STATUSES.UNSUPPORTED_MARKED_HEADER,
    'marked-but-unreadable is unresolved evidence, not silence');
  assert.equal(entries[0].dateConflict.reason, 'date_does_not_lead_the_header',
    'and the diagnostic says WHY the grammar refused it');
});

test('the data-attribute header form is accepted, so the contract is not just two classes', async () => {
  const entries = await entriesFrom(fixtures.dataAttributeDateHeader);
  assert.equal(entries[0].gameDate, '2026-04-11');
  assert.equal(entries[0].dateSourceKind, DATE_SOURCE_KINDS.DATE_GROUP);
});

test('two schedule components under one parent never share a date', async () => {
  const entries = byId(await entriesFrom(fixtures.twoComponentsOneParent));
  assert.equal(entries['comp-a'].gameDate, '2026-05-05');
  assert.equal(entries['comp-b'].gameDate, '2026-04-05');
});

test('a nested month header yields to the day header inside it', async () => {
  const entries = await entriesFrom(fixtures.nestedDateGroups);
  assert.equal(entries[0].gameDate, '2026-04-18',
    'the innermost header is the more specific claim, and nesting is not competition');
  assert.equal(entries[0].dateResolutionStatus, DATE_RESOLUTION_STATUSES.RESOLVED_DATE_GROUP);
});

test('two marked headers naming different dates make the row ambiguous, not a guess', async () => {
  const competing = await entriesFrom(fixtures.competingMarkedHeaders);
  assert.equal(competing[0].gameDate, null);
  assert.equal(competing[0].dateResolutionStatus, DATE_RESOLUTION_STATUSES.AMBIGUOUS);

  const repeated = await entriesFrom(fixtures.repeatedIdenticalMarkedHeaders);
  assert.equal(repeated[0].gameDate, '2026-04-11',
    'the same date twice is confirmation, not competition');
  assert.equal(repeated[0].dateResolutionStatus, DATE_RESOLUTION_STATUSES.RESOLVED_DATE_GROUP);
});

test('a headerless game is undated whether or not it has been played', async () => {
  for (const [name, fixture] of [
    ['completed', fixtures.headerlessCompletedGame],
    ['scheduled', fixtures.headerlessScheduledGame],
  ]) {
    const entries = await entriesFrom(fixture);
    assert.equal(entries[0].gameDate, null, `${name}: nothing is invented`);
    assert.equal(entries[0].dateResolutionStatus, DATE_RESOLUTION_STATUSES.NOT_EXPRESSED);
  }
});

test('an impossible calendar date in a header is reported as invalid through the real DOM', async () => {
  for (const [name, fixture] of [
    ['Feb 30', fixtures.februaryThirtieth],
    ['Apr 31', fixtures.aprilThirtyFirst],
    ['Feb 29 in a non-leap year', fixtures.nonLeapFebruaryTwentyNinth],
  ]) {
    const entries = await entriesFrom(fixture);
    assert.equal(entries[0].gameDate, null, `${name}: no nearby real day is substituted`);
    assert.equal(entries[0].dateResolutionStatus, DATE_RESOLUTION_STATUSES.INVALID, `${name}: reported as invalid`);
  }
  const leap = await entriesFrom(fixtures.leapFebruaryTwentyNinth);
  assert.equal(leap[0].gameDate, '2028-02-29', 'a real leap day is still a real date');
});

test('one malformed href neither throws out of extraction nor takes the valid rows with it', async () => {
  const entries = await entriesFrom(fixtures.malformedHrefBesideValidRow);
  assert.equal(entries.length, 2, 'both rows survive; extraction does not abort');
  const valid = entries.find((entry) => entry.gameId === 'mal-ok');
  const broken = entries.find((entry) => entry.sourceReferenceMalformed);
  assert.ok(valid, 'the valid row is still extracted with its identity intact');
  assert.equal(valid.sourceReferenceMalformed, false);
  assert.ok(broken, 'the malformed row is surfaced rather than silently dropped');
  assert.equal(broken.gameId, '', 'no identity is fabricated for it');
  assert.equal(broken.href, '', 'and no href is invented either');
});

test('two differently malformed references never collapse into one shared identity', async () => {
  const entries = await entriesFrom(fixtures.twoDistinctMalformedHrefs);
  assert.equal(entries.length, 2, 'both rows survive as distinct observations');
  assert.ok(entries.every((entry) => entry.sourceReferenceMalformed), 'both are flagged');
  assert.ok(entries.every((entry) => entry.identityCollision === false),
    'an empty identity is not an identity, so they are not reported as colliding on one');
});

// ── The positive schedule-header grammar ───────────────────────────────
//
// Structural marking says the SOURCE believes an element is a date header. It
// does not say the text is a schedule date. The previous boundary was a list of
// forbidden words, which failed both ways: it missed synonyms of its own entries
// and published their dates, and it matched ordinary game-day language and threw
// a legitimate header away.

const { parseScheduleHeaderText, parseStructuredHeaderDate } = scraper;

test('the grammar refuses every administrative header, whatever the wording', () => {
  // Twenty phrasings, thirteen of which a reviewer reproduced publishing their
  // embedded date. None depends on a keyword: each is refused because the date
  // does not LEAD the text, which is the shape administrative prose always has.
  for (const [name, text] of Object.entries(fixtures.MARKED_ADMINISTRATIVE_HEADERS)) {
    const parsed = parseScheduleHeaderText(text);
    assert.equal(parsed.kind, 'unsupported', `${name}: ${JSON.stringify(text)} must not be readable as a schedule date`);
    assert.equal(parsed.date, null, `${name}: and must yield no date`);
  }
});

test('the grammar accepts a leading date with a supported annotation', () => {
  for (const [name, text] of Object.entries(fixtures.SUPPORTED_SCHEDULE_HEADERS)) {
    const parsed = parseScheduleHeaderText(text);
    assert.equal(parsed.kind, 'date', `${name}: ${JSON.stringify(text)} is a legitimate schedule header`);
    assert.equal(parsed.date, '2026-04-11', `${name}: resolves to the day it names`);
  }
});

test('the grammar distinguishes ambiguous, invalid, absent and unsupported', () => {
  assert.equal(parseScheduleHeaderText('Apr 11 - Apr 13, 2026').kind, 'ambiguous');
  assert.equal(parseScheduleHeaderText('Feb 30, 2026').kind, 'invalid');
  assert.equal(parseScheduleHeaderText('Apr 99, 2026').kind, 'invalid');
  assert.equal(parseScheduleHeaderText('No date at all').kind, 'none');
  assert.equal(parseScheduleHeaderText('').kind, 'none');
  // A date that leads but is followed by material prose.
  const prose = parseScheduleHeaderText('Apr 11, 2026 - bus leaves at 3 from the north lot');
  assert.equal(prose.kind, 'unsupported');
  assert.equal(prose.reason, 'unsupported_text_follows_the_date');
  // An annotation BEFORE the date is administrative ordering, not a header.
  const ordered = parseScheduleHeaderText('Doubleheader Apr 11, 2026');
  assert.equal(ordered.kind, 'unsupported');
  assert.equal(ordered.reason, 'date_does_not_lead_the_header');
});

test('structured header values are parsed, validated, and not mistaken for booleans', () => {
  assert.equal(parseStructuredHeaderDate('2026-04-11'), '2026-04-11');
  assert.equal(parseStructuredHeaderDate('Apr 11, 2026'), '2026-04-11');
  assert.equal(parseStructuredHeaderDate('2026-02-30'), 'invalid');
  assert.equal(parseStructuredHeaderDate('Feb 30, 2026'), 'invalid');
  assert.equal(parseStructuredHeaderDate('1'), null, 'an ordinary boolean marker carries no date');
  assert.equal(parseStructuredHeaderDate(''), null);
});

test('no marked administrative header resolves a date through the real DOM', async () => {
  for (const [name, text] of Object.entries(fixtures.MARKED_ADMINISTRATIVE_HEADERS)) {
    const entries = await entriesFrom(fixtures.markedHeaderWith(text));
    assert.equal(entries.length, 1, `${name}: the game itself survives`);
    assert.equal(entries[0].gameDate, null, `${name}: ${JSON.stringify(text)} must publish no date`);
    assert.equal(entries[0].dateResolutionStatus, DATE_RESOLUTION_STATUSES.UNSUPPORTED_MARKED_HEADER,
      `${name}: refused BY NAME, not folded into silence`);
  }
});

test('every supported schedule header still resolves through the real DOM', async () => {
  for (const [name, text] of Object.entries(fixtures.SUPPORTED_SCHEDULE_HEADERS)) {
    const entries = await entriesFrom(fixtures.markedHeaderWith(text));
    assert.equal(entries[0].gameDate, '2026-04-11', `${name}: ${JSON.stringify(text)} must resolve`);
    assert.equal(entries[0].dateResolutionStatus, DATE_RESOLUTION_STATUSES.RESOLVED_DATE_GROUP);
  }
});

test('"gates open at 5" is a schedule header, not an administrative one', async () => {
  // The keyword list matched `opens?` and threw this away, which silently
  // published a completed game with a null date and failed an unplayed
  // collection outright. Both halves are pinned here.
  for (const played of [true, false]) {
    const entries = await entriesFrom(fixtures.markedHeaderWith('Apr 11, 2026 - gates open at 5', { played }));
    assert.equal(entries[0].gameDate, '2026-04-11', `played=${played}: the date the source stated is kept`);
    assert.equal(entries[0].dateResolutionStatus, DATE_RESOLUTION_STATUSES.RESOLVED_DATE_GROUP);
  }
});

// ── Structured date evidence ───────────────────────────────────────────

test('a structured value outranks presentation and is validated', async () => {
  const matching = await entriesFrom(fixtures.structuredValueWithMatchingText);
  assert.equal(matching[0].gameDate, '2026-04-11');

  const noText = await entriesFrom(fixtures.structuredValueWithNoText);
  assert.equal(noText[0].gameDate, '2026-04-11', 'a structured value alone is enough');

  const attribute = await entriesFrom(fixtures.structuredDateHeaderAttribute);
  assert.equal(attribute[0].gameDate, '2026-04-11');

  const timeElement = await entriesFrom(fixtures.structuredTimeElement);
  assert.equal(timeElement[0].gameDate, '2026-04-11', '<time datetime> is a structured value');

  const booleanOnly = await entriesFrom(fixtures.structuredBooleanMarkerOnly);
  assert.equal(booleanOnly[0].gameDate, '2026-04-11',
    'data-date-header="1" is an ordinary marker; the visible header still governs');
});

test('structured and visible dates that disagree are conflicting, never silently preferred', async () => {
  const contradiction = await entriesFrom(fixtures.structuredValueContradictingText);
  assert.equal(contradiction[0].gameDate, null);
  assert.equal(contradiction[0].dateResolutionStatus, DATE_RESOLUTION_STATUSES.CONFLICTING);
  assert.equal(contradiction[0].dateConflict.reason, 'date_group_structured_value_contradicts_visible_date');

  const withProse = await entriesFrom(fixtures.structuredValueWithAdministrativeProse);
  assert.equal(withProse[0].gameDate, null,
    'a structured value beside a contradicting administrative date is a conflict, not a resolution');
  assert.equal(withProse[0].dateResolutionStatus, DATE_RESOLUTION_STATUSES.CONFLICTING);
});

test('an impossible structured value is invalid', async () => {
  const entries = await entriesFrom(fixtures.structuredValueImpossible);
  assert.equal(entries[0].gameDate, null);
  assert.equal(entries[0].dateResolutionStatus, DATE_RESOLUTION_STATUSES.INVALID);
});

// ── Affirmative scope ──────────────────────────────────────────────────

test('a marked header outside the schedule component cannot reach into it', async () => {
  const entries = await entriesFrom(fixtures.markedHeaderOutsideComponent);
  assert.equal(entries[0].gameDate, null,
    'a shared page wrapper is not a relationship between a header and a game');
  assert.equal(entries[0].dateResolutionStatus, DATE_RESOLUTION_STATUSES.NOT_EXPRESSED,
    'from inside the component the source expressed nothing at all');
});

test('a page-level header cannot govern either of two components that head themselves', async () => {
  const entries = byId(await entriesFrom(fixtures.administrativeHeaderBeforeTwoComponents));
  assert.equal(entries['twoc-a'].gameDate, '2026-04-11');
  assert.equal(entries['twoc-b'].gameDate, '2026-04-18');
});

test('one component\'s header never governs another component', async () => {
  const entries = await entriesFrom(fixtures.headerInOneComponentCannotGovernAnother);
  assert.equal(entries[0].gameDate, null, 'Apr 11 belongs to the component that declared it');
});

test('a header in an outer component still governs a nested one it contains', async () => {
  const entries = await entriesFrom(fixtures.nestedScheduleComponents);
  assert.equal(entries[0].gameDate, null,
    'the nested component is the row\'s nearest component, and it declares no header');
});

// ── HTTP(S)-only schedule references ───────────────────────────────────

test('a non-HTTP scheme never becomes a source identity', async () => {
  for (const [name, fixture] of [
    ['javascript:', fixtures.nonHttpSchemeReferences],
    ['JaVaScRiPt:', fixtures.mixedCaseJavascriptScheme],
    ['ftp:', fixtures.ftpSchemeReference],
    ['data:', fixtures.dataSchemeReference],
  ]) {
    const entries = await entriesFrom(fixture);
    assert.equal(entries.length, 1, `${name}: the row is surfaced, not silently dropped`);
    assert.equal(entries[0].gameId, '', `${name}: no identity is manufactured from it`);
    assert.equal(entries[0].href, '', `${name}: and no href is invented`);
    assert.equal(entries[0].sourceReferenceMalformed, true, `${name}: it is named as unusable`);
  }
});

test('a rejected scheme beside a valid row loses neither, and two rejected ones stay distinct', async () => {
  const mixed = await entriesFrom(fixtures.nonHttpBesideValidRow);
  assert.equal(mixed.length, 2);
  assert.ok(mixed.some((e) => e.gameId === 'scheme-ok' && e.sourceReferenceMalformed === false),
    'the valid row keeps its identity');
  assert.ok(mixed.some((e) => e.sourceReferenceMalformed === true), 'the rejected one is flagged');

  const two = await entriesFrom(fixtures.twoDistinctNonHttpSchemes);
  assert.equal(two.length, 2, 'both survive as distinct observations');
  assert.ok(two.every((e) => e.sourceReferenceMalformed), 'both are rejected');
  assert.ok(two.every((e) => e.identityCollision === false),
    'no shared sentinel merges two differently rejected references');
});

test('protocol-relative and absolute HTTP(S) references are still accepted', async () => {
  const entries = await entriesFrom(fixtures.protocolRelativeReference);
  assert.equal(entries[0].gameId, 'pr-1');
  assert.equal(entries[0].sourceReferenceMalformed, false);
});
