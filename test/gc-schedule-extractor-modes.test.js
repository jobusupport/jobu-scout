'use strict';

// Runs the REAL extractor in src/search-gamechanger-teams.js against sanitized
// offline DOM fixtures in a real Chromium page.
//
// Nothing here is a stub that returns pre-normalized objects: the fixtures are
// HTML, they are loaded with page.setContent() (no navigation, no network), and
// the assertions are about what the extractor actually parses out of the DOM.
// test/helpers/gc-network-guard.js additionally aborts any request to gc.com,
// so a real GameChanger fetch is structurally impossible from this process.

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

const { SCHEDULE_EXTRACTION_MODES } = scraper;
const ALL = SCHEDULE_EXTRACTION_MODES.ALL_SCHEDULE_ENTRIES;
const COMPLETED = SCHEDULE_EXTRACTION_MODES.COMPLETED_ONLY;

let browser;

test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { if (browser) await browser.close(); });

// setContent needs a real origin for relative-URL resolution; routed to the
// fixture body so no network request is made.
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

const entriesFrom = (html, mode = ALL) => withPage(html, (page) => scraper.getVisibleScheduleEntries(page, { mode }));

// ── Mode contract ──────────────────────────────────────────────────────

test('the extraction mode must be explicit', async () => {
  await withPage(fixtures.completedOnly, async (page) => {
    await assert.rejects(() => scraper.getVisibleScheduleEntries(page), /explicit mode/i);
    await assert.rejects(() => scraper.getVisibleScheduleEntries(page, { mode: 'everything' }), /explicit mode/i);
  });
});

test('completed_only still returns only played games, unchanged', async () => {
  const entries = await entriesFrom(fixtures.mixedSchedule, COMPLETED);
  assert.equal(entries.length, 1, 'the future game must not appear in completed-only mode');
  assert.equal(entries[0].gameId, 'g-final-1');
  assert.equal(entries[0].status, 'final');
});

test('the pre-existing completed-games extractor is untouched by the new mode', async () => {
  const legacy = await withPage(fixtures.mixedSchedule, (page) => scraper.getVisibleCompletedGameEntries(page));
  assert.equal(legacy.length, 1, 'own-team discovery still skips non-final games');
  assert.equal(legacy[0].gameId, 'g-final-1');
  assert.equal(legacy[0].result, 'W');
  // And on a future-only schedule it legitimately finds nothing at all.
  const none = await withPage(fixtures.futureOnly, (page) => scraper.getVisibleCompletedGameEntries(page));
  assert.deepEqual(none, []);
});

// ── The gap this slice closes ──────────────────────────────────────────

test('a future row with no score badge IS returned in all_schedule_entries mode', async () => {
  assert.equal(/W\s*\d+\s*-\s*\d+/.test(fixtures.futureOnly), false,
    'the fixture must genuinely contain no score badge');
  const entries = await entriesFrom(fixtures.futureOnly);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.gameId, 'g-future-1');
  assert.equal(entry.status, 'scheduled');
  assert.equal(entry.result, null, 'a future game has no result');
  assert.equal(entry.gameDate, '2026-05-01');
  assert.equal(entry.scheduledTimeText, '7:00 PM');
  assert.equal(entry.timezoneKnown, false, 'the source exposes no timezone; the uncertainty is explicit');
  assert.equal(entry.counterpartyName, 'Third Party High');
  assert.equal(entry.homeAway, 'home');
  assert.equal(entry.venue, 'Riverside Park');
});

test('a mixed schedule returns both the played and the unplayed game', async () => {
  const entries = await entriesFrom(fixtures.mixedSchedule);
  assert.equal(entries.length, 2);
  const byId = Object.fromEntries(entries.map((e) => [e.gameId, e]));
  assert.equal(byId['g-final-1'].status, 'final');
  assert.equal(byId['g-final-1'].result, 'W');
  assert.equal(byId['g-final-1'].gameDate, '2026-04-01');
  assert.equal(byId['g-future-1'].status, 'scheduled');
  assert.equal(byId['g-future-1'].result, null);
  assert.equal(byId['g-future-1'].gameDate, '2026-05-01');
});

// ── Status mapping ─────────────────────────────────────────────────────

test('postponed and cancelled rows keep their own status and never read as final', async () => {
  const [postponedEntry] = await entriesFrom(fixtures.postponed);
  assert.equal(postponedEntry.status, 'postponed');
  assert.equal(postponedEntry.result, null);
  const [cancelledEntry] = await entriesFrom(fixtures.cancelled);
  assert.equal(cancelledEntry.status, 'cancelled');
  assert.equal(cancelledEntry.result, null);
});

test('an unrecognisable row stays unknown rather than defaulting to scheduled or final', async () => {
  const [entry] = await entriesFrom(fixtures.unknownStatus);
  assert.equal(entry.status, 'unknown');
  assert.equal(entry.scheduledTimeText, null);
});

test('a malformed row yields no fabricated values', async () => {
  const entries = await entriesFrom(fixtures.malformedRow);
  for (const entry of entries) {
    assert.equal(entry.gameId, '', 'no game id is invented');
    assert.equal(entry.status, 'unknown');
    assert.equal(entry.gameDate, null);
    assert.equal(entry.counterpartyName, null);
  }
});

test('non-game rows are not mistaken for schedule entries', async () => {
  const entries = await entriesFrom(fixtures.irrelevantRows);
  assert.deepEqual(entries, [], 'roster, stats and sponsor rows are not schedule rows');
});

// ── Identity evidence ──────────────────────────────────────────────────

test('a reschedule keeps the stable upstream id while the date moves', async () => {
  const [before] = await entriesFrom(fixtures.rescheduledBefore);
  const [after] = await entriesFrom(fixtures.rescheduledAfter);
  assert.equal(before.gameId, after.gameId, 'the same contest keeps one upstream identity');
  assert.equal(before.gameDate, '2026-04-10');
  assert.equal(after.gameDate, '2026-04-17');
  assert.equal(before.status, 'postponed');
  assert.equal(after.status, 'final');
});

test('a same-day doubleheader with distinct ids stays two entries with discriminators', async () => {
  const entries = await entriesFrom(fixtures.doubleheaderDistinct);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.gameId).sort(), ['g-dh-1', 'g-dh-2']);
  assert.deepEqual(entries.map((e) => e.gameDate), ['2026-04-11', '2026-04-11']);
  assert.deepEqual(entries.map((e) => e.gameNumber).sort(), [1, 2]);
  assert.deepEqual(entries.map((e) => e.scheduledTimeText).sort(), ['10:00 AM', '1:00 PM']);
});

test('two indistinguishable same-day rows are preserved and marked as colliding', async () => {
  const entries = await entriesFrom(fixtures.doubleheaderAmbiguous);
  // Two distinct source rows. Collapsing them to one -- which an earlier
  // href-based deduplication did -- would silently discard a game the source
  // actually published. Both survive, both are flagged, and neither is chosen.
  assert.equal(entries.length, 2, 'a shared upstream id must not erase a row');
  assert.ok(entries.every((entry) => entry.identityCollision),
    'the ambiguity reaches the identity layer instead of being resolved here');
  assert.deepEqual(entries[0].collidingRowIndexes, [0, 1]);
  for (const entry of entries) {
    assert.equal(entry.gameNumber, null, 'no game number is fabricated');
    assert.equal(entry.scheduledTimeText, null, 'no start time is fabricated');
  }
});

test('DOM row order does not change what is extracted', async () => {
  const forwards = await entriesFrom(fixtures.mixedSchedule);
  const backwards = await entriesFrom(fixtures.mixedScheduleReordered);
  const identity = (entries) => entries
    .map(({ visibleIndex, ...rest }) => rest)
    .sort((a, b) => (a.gameId < b.gameId ? -1 : 1));
  assert.deepEqual(identity(backwards), identity(forwards),
    'row order is provenance only; everything else is identical');
});

test('whitespace and markup variation do not change the extracted identity', async () => {
  const [plain] = await entriesFrom(fixtures.completedOnly);
  const [varied] = await entriesFrom(fixtures.markupVariation);
  assert.equal(varied.gameId, plain.gameId);
  assert.equal(varied.gameDate, plain.gameDate);
  assert.equal(varied.status, plain.status);
  assert.equal(varied.counterpartyName, plain.counterpartyName);
  assert.equal(varied.result, plain.result);
  assert.equal(varied.scheduledTimeText, plain.scheduledTimeText);
});

// ── Pure classifier ────────────────────────────────────────────────────

test('the status classifier never upgrades an explicit non-final label', () => {
  const { classifyScheduleEntryStatus: classify } = scraper;
  // A stale score alongside an explicit postponement must not read as final.
  assert.equal(classify({ rawStatusText: 'vs Rival Postponed', scoreText: 'W 5-3' }), 'postponed');
  assert.equal(classify({ rawStatusText: 'vs Rival Cancelled', scoreText: 'L 1-2' }), 'cancelled');
  assert.equal(classify({ rawStatusText: 'vs Rival Suspended' }), 'suspended');
  assert.equal(classify({ rawStatusText: 'Top 5', scoreText: '' }), 'in_progress');
  assert.equal(classify({ rawStatusText: 'vs Rival 7:00 PM' }), 'scheduled');
  assert.equal(classify({ rawStatusText: 'vs Rival TBD' }), 'unknown');
  assert.equal(classify({}), 'unknown');
});

// ── Extraction identity: rows, not hrefs (HS 2D correction) ────────────
//
// The extraction unit is the schedule ROW. Deduplication is permitted only on
// affirmative evidence that the SAME row root was observed twice; two distinct
// row roots are always two observations, however identical their content.

test('two anchors inside one row root produce exactly one entry', { skip: false }, async () => {
  const entries = await entriesFrom(fixtures.singleRowTwoAnchors);
  assert.equal(entries.length, 1, 'one row component is one observation');
  assert.equal(entries[0].rowAnchorCount, 2, 'both anchors were recognised as belonging to that row');
  assert.equal(entries[0].identityCollision, false);
  // The whole row is read, so a thumbnail-first row does not lose its score.
  assert.equal(entries[0].result, 'W');
  assert.equal(entries[0].status, 'final');
  assert.equal(entries[0].scheduledTimeText, '4:30 PM');
});

test('responsive markup rendering one row twice does not double-extract', async () => {
  const entries = await entriesFrom(fixtures.responsiveSingleRow);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].rowAnchorCount, 2);
  assert.equal(entries[0].result, 'W', 'the desktop variant carrying the score is still read');
});

test('two distinct row roots sharing one href stay two observations', async () => {
  const entries = await entriesFrom(fixtures.twoRowsSharedHref);
  assert.equal(entries.length, 2, 'a shared href must never erase a row');
  assert.deepEqual(entries.map((e) => e.rowAnchorCount), [1, 1]);
  assert.deepEqual(entries.map((e) => e.gameId), ['g-shared-1', 'g-shared-1']);
  assert.ok(entries.every((e) => e.identityCollision), 'both rows are marked as colliding');
  assert.deepEqual(entries[0].collidingRowIndexes, [0, 1]);
  assert.deepEqual(entries[1].collidingRowIndexes, [0, 1]);
});

test('two byte-identical row roots stay two observations', async () => {
  const entries = await entriesFrom(fixtures.twoIdenticalRowRoots);
  assert.equal(entries.length, 2, 'identical content is not evidence of the same row');
  assert.ok(entries.every((e) => e.identityCollision));
});

test('conflicting scores under one upstream id are both preserved, never combined', async () => {
  const entries = await entriesFrom(fixtures.twoRowsSharedIdDifferentScores);
  assert.equal(entries.length, 2);
  const results = entries.map((e) => e.result).sort();
  assert.deepEqual(results, ['L', 'W'], 'neither row is dropped and no score is merged');
  const scores = entries.map((e) => `${e.scoreUs}-${e.scoreThem}`).sort();
  assert.deepEqual(scores, ['1-5', '7-2']);
  assert.ok(entries.every((e) => e.identityCollision));
});

test('game numbers under one shared href still leave two colliding observations', async () => {
  const entries = await entriesFrom(fixtures.twoRowsSharedHrefGameNumbers);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.gameNumber).sort(), [1, 2]);
  // A discriminator does not make a shared upstream identity safe: the identity
  // layer still has to decide, so the collision is surfaced rather than resolved.
  assert.ok(entries.every((e) => e.identityCollision));
});

test('collision marking is identical when the DOM order is reversed', async () => {
  const forwards = await entriesFrom(fixtures.twoRowsSharedIdDifferentScores);
  const reversed = await entriesFrom(fixtures.twoRowsSharedHrefReversed);
  assert.deepEqual(forwards.map((e) => e.collidingRowIndexes), [[0, 1], [0, 1]]);
  assert.deepEqual(reversed.map((e) => e.collidingRowIndexes), [[0, 1], [0, 1]]);
});

test('a distinct-id doubleheader is NOT a collision', async () => {
  const entries = await entriesFrom(fixtures.doubleheaderDistinct);
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.identityCollision === false),
    'distinct upstream ids are two legitimate games, not a collision');
  assert.deepEqual(entries.map((e) => e.gameId).sort(), ['g-dh-1', 'g-dh-2']);
});

test('an ordinary schedule reports no collision and keeps row index as provenance only', async () => {
  const entries = await entriesFrom(fixtures.mixedSchedule);
  assert.ok(entries.every((e) => e.identityCollision === false));
  assert.deepEqual(entries.map((e) => e.visibleIndex).sort(), [0, 1]);
  const reordered = await entriesFrom(fixtures.mixedScheduleReordered);
  const withoutProvenance = (list) => list
    .map(({ visibleIndex, ...rest }) => rest)
    .sort((a, b) => (a.gameId < b.gameId ? -1 : 1));
  assert.deepEqual(withoutProvenance(reordered), withoutProvenance(entries),
    'reversing DOM order changes only the provenance index');
});

test('the collision detector is deterministic and never selects a winner', () => {
  const { detectSourceEventIdentityCollisions } = require('../src/high-school-opponent-gc-import');
  const rows = [
    { sourceGameRef: 'a', sourceRowIndex: 1, gameDate: '2026-04-01', gameStatus: 'final', startTime: null, gameNumber: null, rawStatusText: 'W 7-2' },
    { sourceGameRef: 'a', sourceRowIndex: 0, gameDate: '2026-04-01', gameStatus: 'final', startTime: null, gameNumber: null, rawStatusText: 'L 1-5' },
    { sourceGameRef: 'b', sourceRowIndex: 2, gameDate: '2026-04-02', gameStatus: 'final', startTime: null, gameNumber: null, rawStatusText: '' },
  ];
  const forwards = detectSourceEventIdentityCollisions(rows);
  const backwards = detectSourceEventIdentityCollisions([...rows].reverse());
  assert.equal(forwards.length, 1, 'only the genuinely duplicated identity collides');
  assert.equal(forwards[0].sourceGameRef, 'a');
  assert.deepEqual(forwards[0].sourceRowIndexes, [0, 1], 'indexes are sorted, so order cannot change the diagnostic');
  assert.equal(forwards[0].observations.length, 2, 'both observations are retained for reconciliation');
  assert.deepEqual(backwards, forwards, 'input order does not change the result');
  // A row with no upstream identifier cannot collide on one.
  assert.deepEqual(detectSourceEventIdentityCollisions([
    { sourceGameRef: null, sourceRowIndex: 0 }, { sourceGameRef: null, sourceRowIndex: 1 },
  ]), []);
});

// ── Generic wrappers are not per-game boundaries (HS 2D review correction) ──
//
// Before the correction a date-group `li` or a table `tr` was accepted as the
// nearest row root, so every game under it collapsed into ONE entry and the
// extras vanished with collision=false. Measured then:
//   dateGroupLi  entries=1 ids=["game-AAA"] collision=false
//   tableRow     entries=1 ids=["game-CCC"] collision=false
// The assertions below pin the corrected behaviour.

const ids = (entries) => entries.map((entry) => entry.gameId).sort();
const results = (entries) => entries.map((entry) => entry.result).sort();

test('a date-group li holding two distinct games yields two entries', async () => {
  const entries = await entriesFrom(fixtures.dateGroupLiTwoGames);
  assert.equal(entries.length, 2, 'a generic wrapper is not a per-game boundary');
  assert.deepEqual(ids(entries), ['game-alpha', 'game-beta']);
  assert.deepEqual(results(entries), ['L', 'W'], 'both scores survive; neither game is discarded');
  assert.ok(entries.every((entry) => entry.identityCollision === false),
    'two genuinely distinct games are not a collision');
  assert.ok(entries.every((entry) => entry.rowAnchorCount === 1),
    'each game is its own observation, not a merged row');
});

test('a table tr holding two distinct games yields two entries', async () => {
  const entries = await entriesFrom(fixtures.tableRowTwoGames);
  assert.equal(entries.length, 2);
  assert.deepEqual(ids(entries), ['game-delta', 'game-gamma']);
  assert.deepEqual(results(entries), ['L', 'W']);
  assert.ok(entries.every((entry) => entry.identityCollision === false));
});

test('reversing anchor order inside a generic wrapper never changes which games survive', async () => {
  const forwardsLi = await entriesFrom(fixtures.dateGroupLiTwoGames);
  const reversedLi = await entriesFrom(fixtures.dateGroupLiTwoGamesReversed);
  const forwardsTr = await entriesFrom(fixtures.tableRowTwoGames);
  const reversedTr = await entriesFrom(fixtures.tableRowTwoGamesReversed);

  // Identity, score and collision classification are order-independent.
  const identity = (list) => list
    .map(({ gameId, result, scoreUs, scoreThem, status, identityCollision }) =>
      ({ gameId, result, scoreUs, scoreThem, status, identityCollision }))
    .sort((a, b) => (a.gameId < b.gameId ? -1 : 1));
  assert.deepEqual(identity(reversedLi), identity(forwardsLi));
  assert.deepEqual(identity(reversedTr), identity(forwardsTr));
  assert.deepEqual(ids(reversedLi), ['game-alpha', 'game-beta'], 'DOM order never decides which game survives');
  assert.deepEqual(ids(reversedTr), ['game-delta', 'game-gamma']);

  // KNOWN LIMITATION, asserted rather than hidden: when a date-group container
  // holds the header INSIDE it above several games, only the game adjacent to
  // that header resolves a date within the deliberately narrow date scope. The
  // rest report gameDate = null rather than borrowing a neighbouring row's
  // date. That is order-dependent, so it is pinned here as a gap for follow-up,
  // not asserted as correct. Widening the scope to fix it was tried and
  // rejected: it made rows adopt each other's dates.
  const datedCount = (list) => list.filter((entry) => entry.gameDate).length;
  assert.equal(datedCount(forwardsLi), 1, 'date-group headers reach only the adjacent game today');
  assert.equal(datedCount(reversedLi), 1);
  assert.ok(forwardsLi.every((entry) => entry.gameDate === null || entry.gameDate === '2026-04-11'),
    'no row ever adopts a date that is not its own group header');
});

test('a generic wrapper holding two same-href anchors over-reports and collides rather than merging', async () => {
  const entries = await entriesFrom(fixtures.genericWrapperSameHref);
  assert.equal(entries.length, 2, 'without an explicit per-game boundary nothing may be merged');
  assert.deepEqual(ids(entries), ['game-shared', 'game-shared']);
  assert.ok(entries.every((entry) => entry.identityCollision),
    'the ambiguity is surfaced for reconciliation, not silently resolved');
  assert.deepEqual(entries[0].collidingRowIndexes, [0, 1]);
});

test('explicit per-game rows nested in a generic wrapper are each their own game', async () => {
  const entries = await entriesFrom(fixtures.nestedExplicitRowsInGenericWrapper);
  assert.equal(entries.length, 2);
  assert.deepEqual(ids(entries), ['game-kappa', 'game-lambda']);
  assert.deepEqual(results(entries), ['L', 'W']);
  assert.ok(entries.every((entry) => entry.identityCollision === false));
});

test('an explicit per-game row with several anchors for ONE game is still one entry', async () => {
  const entries = await entriesFrom(fixtures.singleRowTwoAnchors);
  assert.equal(entries.length, 1, 'affirmative per-game markup may group anchors');
  assert.equal(entries[0].rowAnchorCount, 2);
  assert.equal(entries[0].result, 'W', 'the whole row is read, so the score is not lost');
  assert.equal(entries[0].identityCollision, false);
});

test('ordinary per-game li and tr markup still yields one entry per game', async () => {
  const li = await entriesFrom(fixtures.perGameLiRows);
  assert.equal(li.length, 2);
  assert.deepEqual(ids(li), ['game-mu', 'game-nu']);
  assert.deepEqual(results(li), ['L', 'W']);
  const tr = await entriesFrom(fixtures.perGameTrRows);
  assert.equal(tr.length, 2);
  assert.deepEqual(ids(tr), ['game-omicron', 'game-xi']);
  assert.deepEqual(results(tr), ['L', 'W']);
  assert.ok([...li, ...tr].every((entry) => entry.identityCollision === false));
});

test('no generic wrapper case ever reports fewer entries than distinct games present', async () => {
  // The invariant the correction exists to guarantee: grouping may never reduce
  // the number of distinct games the source published.
  const cases = [
    ['dateGroupLiTwoGames', fixtures.dateGroupLiTwoGames, 2],
    ['dateGroupLiTwoGamesReversed', fixtures.dateGroupLiTwoGamesReversed, 2],
    ['tableRowTwoGames', fixtures.tableRowTwoGames, 2],
    ['tableRowTwoGamesReversed', fixtures.tableRowTwoGamesReversed, 2],
    ['nestedExplicitRowsInGenericWrapper', fixtures.nestedExplicitRowsInGenericWrapper, 2],
    ['perGameLiRows', fixtures.perGameLiRows, 2],
    ['perGameTrRows', fixtures.perGameTrRows, 2],
  ];
  for (const [name, html, distinctGames] of cases) {
    const entries = await entriesFrom(html);
    const distinctIds = new Set(entries.map((entry) => entry.gameId).filter(Boolean));
    assert.equal(distinctIds.size, distinctGames, `${name}: every distinct game must survive extraction`);
  }
});
