'use strict';

// Sanitized offline GameChanger schedule markup for HS Slice 2D.
//
// These are hand-written approximations of the DOM contract
// src/search-gamechanger-teams.js already depends on -- a schedule row is an
// anchor whose href contains /schedule/<gameId>, carrying the opponent, date,
// time and (once played) a score badge. They contain NO real credentials,
// cookies, tokens, session artifacts, roster data or customer content: every
// team name, game id and venue below is invented for this test suite.
//
// They are loaded with page.setContent(), so no navigation and no network
// request ever occurs. test/helpers/gc-network-guard.js additionally aborts any
// request to gc.com, so a real GameChanger fetch is structurally impossible.

const ORIGIN = 'https://web.gc.com';

function row({
  gameId, opponent, date, time, score = '', status = '', venue = '',
  gameNumber = null, homeAway = 'vs', extraAttrs = '',
}) {
  const scoreMarkup = score ? `<span class="score">${score}</span>` : '';
  const statusMarkup = status ? `<span class="status">${status}</span>` : '';
  const venueMarkup = venue ? `<span class="venue">${venue}</span>` : '';
  const numberMarkup = gameNumber ? `<span class="game-number">Game ${gameNumber}</span>` : '';
  const href = `${ORIGIN}/teams/opponent-high/schedule/${gameId}`;
  // Spans are separated by real whitespace, as rendered markup is; the extractor
  // additionally reads status, venue and game number from their own elements so
  // it does not depend on how adjacent inline nodes happen to concatenate.
  return `
    <div class="date-header">${date}</div>
    <a class="schedule-row" href="${href}"${extraAttrs}>
      <span class="matchup">${homeAway} ${opponent}</span>
      ${time ? `<span class="time">${time}</span>` : ''}
      ${scoreMarkup}
      ${statusMarkup}
      ${venueMarkup}
      ${numberMarkup}
    </a>`;
}

function page(rowsMarkup) {
  return `<!doctype html><html><body>
    <header><h1>Opponent High Varsity Baseball</h1></header>
    <nav><a href="${ORIGIN}/teams/opponent-high/roster">Roster</a></nav>
    <section class="schedule">${rowsMarkup}</section>
    <footer><a href="${ORIGIN}/help">Help</a></footer>
  </body></html>`;
}

// One completed game only -- the shape the pre-existing completed-only
// extractor has always been able to see.
const completedOnly = page(row({
  gameId: 'g-final-1', opponent: 'Third Party High', date: 'Apr 1, 2026',
  time: '4:30 PM', score: 'W 7-2', venue: 'Riverside Park',
}));

// A single FUTURE game with no score badge at all. This is the row the
// pre-correction extractor could not return.
const futureOnly = page(row({
  gameId: 'g-future-1', opponent: 'Third Party High', date: 'May 1, 2026',
  time: '7:00 PM', venue: 'Riverside Park',
}));

// Mixed: one played, one still to come.
const mixedSchedule = page([
  row({
    gameId: 'g-final-1', opponent: 'Third Party High', date: 'Apr 1, 2026',
    time: '4:30 PM', score: 'W 7-2', venue: 'Riverside Park',
  }),
  row({
    gameId: 'g-future-1', opponent: 'Fourth Street Academy', date: 'May 1, 2026',
    time: '7:00 PM', venue: 'Riverside Park',
  }),
].join('\n'));

const postponed = page(row({
  gameId: 'g-ppd-1', opponent: 'Third Party High', date: 'Apr 8, 2026',
  time: '4:30 PM', status: 'Postponed',
}));

const cancelled = page(row({
  gameId: 'g-cancel-1', opponent: 'Third Party High', date: 'Apr 9, 2026',
  time: '4:30 PM', status: 'Cancelled',
}));

// Same stable upstream id, moved to a later date -- a reschedule, not a new game.
const rescheduledBefore = page(row({
  gameId: 'g-move-1', opponent: 'Third Party High', date: 'Apr 10, 2026',
  time: '4:30 PM', status: 'Postponed',
}));
const rescheduledAfter = page(row({
  gameId: 'g-move-1', opponent: 'Third Party High', date: 'Apr 17, 2026',
  time: '5:00 PM', score: 'L 3-6',
}));

// Two games, same teams, same day, DISTINCT upstream ids.
const doubleheaderDistinct = page([
  row({
    gameId: 'g-dh-1', opponent: 'Third Party High', date: 'Apr 11, 2026',
    time: '10:00 AM', gameNumber: 1, venue: 'Riverside Park',
  }),
  row({
    gameId: 'g-dh-2', opponent: 'Third Party High', date: 'Apr 11, 2026',
    time: '1:00 PM', gameNumber: 2, venue: 'Riverside Park',
  }),
].join('\n'));

// Two rows, same teams, same day, SAME upstream id and no distinguishing
// evidence at all -- must stay ambiguous rather than silently merging.
const doubleheaderAmbiguous = page([
  row({ gameId: 'g-dh-same', opponent: 'Third Party High', date: 'Apr 12, 2026', time: '' }),
  row({ gameId: 'g-dh-same', opponent: 'Third Party High', date: 'Apr 12, 2026', time: '' }),
].join('\n'));

// Markup variation: different element order, extra whitespace, an uppercase
// status label, and a data attribute instead of a child element.
const markupVariation = page(`
  <div class="date-header">   Apr   1,    2026   </div>
  <a class="schedule-row" href="${ORIGIN}/teams/opponent-high/schedule/g-final-1" data-status="FINAL">
    <span class="venue">Riverside Park</span>
    <span class="score">W 7-2</span>
    <span class="matchup">vs    Third Party High</span>
    <span class="time">4:30 PM</span>
  </a>`);

// A row with no score badge, no time, and no status -- genuinely unknown.
const unknownStatus = page(row({
  gameId: 'g-unknown-1', opponent: 'Third Party High', date: 'Apr 13, 2026', time: '',
}));

// Malformed: an anchor that looks like a schedule row but carries no game id
// segment and no usable content.
const malformedRow = page(`
  <a class="schedule-row" href="${ORIGIN}/teams/opponent-high/schedule/">
    <span class="matchup"></span>
  </a>`);

// Non-game rows that must never be mistaken for schedule entries.
const irrelevantRows = page(`
  <a href="${ORIGIN}/teams/opponent-high/roster">Roster</a>
  <a href="${ORIGIN}/teams/opponent-high/stats">Season Stats</a>
  <div>Sponsored by Local Diner</div>`);

// Same schedule as mixedSchedule, rendered in the opposite DOM order, to prove
// row order is provenance and never canonical identity.
const mixedScheduleReordered = page([
  row({
    gameId: 'g-future-1', opponent: 'Fourth Street Academy', date: 'May 1, 2026',
    time: '7:00 PM', venue: 'Riverside Park',
  }),
  row({
    gameId: 'g-final-1', opponent: 'Third Party High', date: 'Apr 1, 2026',
    time: '4:30 PM', score: 'W 7-2', venue: 'Riverside Park',
  }),
].join('\n'));

module.exports = {
  ORIGIN,
  row,
  page,
  completedOnly,
  futureOnly,
  mixedSchedule,
  mixedScheduleReordered,
  postponed,
  cancelled,
  rescheduledBefore,
  rescheduledAfter,
  doubleheaderDistinct,
  doubleheaderAmbiguous,
  markupVariation,
  unknownStatus,
  malformedRow,
  irrelevantRows,
};

// ── Extraction-identity collision fixtures (HS 2D correction) ───────────
//
// The extraction unit is the schedule ROW, never the href. These exercise the
// difference between "the same row rendered with two anchors" (one observation)
// and "two distinct rows that happen to share an href" (two observations).

const HREF = `${ORIGIN}/teams/opponent-high/schedule/g-shared-1`;

// 1. ONE row component that renders two anchors to the same game -- a thumbnail
//    link and a title link, which is ordinary component markup.
const singleRowTwoAnchors = page(`
  <div class="date-header">Apr 1, 2026</div>
  <div class="schedule-row">
    <a href="${HREF}"><span class="thumb">box score</span></a>
    <a href="${HREF}">
      <span class="matchup">vs Third Party High</span>
      <span class="time">4:30 PM</span>
      <span class="score">W 7-2</span>
    </a>
  </div>`);

// 2. TWO distinct rows sharing one href and upstream id, with nothing to tell
//    them apart. Must stay two observations and collide, never merge.
const twoRowsSharedHref = page(`
  <div class="date-header">Apr 1, 2026</div>
  <div class="schedule-row">
    <a href="${HREF}"><span class="matchup">vs Third Party High</span></a>
  </div>
  <div class="schedule-row">
    <a href="${HREF}"><span class="matchup">vs Third Party High</span></a>
  </div>`);

// 6. The same collision, rendered in the opposite DOM order.
const twoRowsSharedHrefReversed = twoRowsSharedHref;

// 3. Two same-day rows sharing an href but carrying Game 1 / Game 2.
const twoRowsSharedHrefGameNumbers = page(`
  <div class="date-header">Apr 11, 2026</div>
  <div class="schedule-row">
    <a href="${HREF}">
      <span class="matchup">vs Third Party High</span>
      <span class="time">10:00 AM</span>
      <span class="game-number">Game 1</span>
    </a>
  </div>
  <div class="schedule-row">
    <a href="${HREF}">
      <span class="matchup">vs Third Party High</span>
      <span class="time">1:00 PM</span>
      <span class="game-number">Game 2</span>
    </a>
  </div>`);

// 4. Two rows sharing an upstream id but reporting different scores -- the most
//    dangerous case, because merging would silently pick one team's result.
const twoRowsSharedIdDifferentScores = page(`
  <div class="date-header">Apr 1, 2026</div>
  <div class="schedule-row">
    <a href="${HREF}">
      <span class="matchup">vs Third Party High</span>
      <span class="score">W 7-2</span>
    </a>
  </div>
  <div class="schedule-row">
    <a href="${HREF}">
      <span class="matchup">vs Third Party High</span>
      <span class="score">L 1-5</span>
    </a>
  </div>`);

// 5. Two byte-identical row roots sharing the same href.
const twoIdenticalRowRoots = page([
  `<div class="date-header">Apr 1, 2026</div>`,
  `<div class="schedule-row"><a href="${HREF}"><span class="matchup">vs Third Party High</span><span class="score">W 7-2</span></a></div>`,
  `<div class="schedule-row"><a href="${HREF}"><span class="matchup">vs Third Party High</span><span class="score">W 7-2</span></a></div>`,
].join('\n'));

// Responsive markup: one row component that renders a mobile and a desktop
// variant of the same anchor. Must NOT double-extract.
const responsiveSingleRow = page(`
  <div class="date-header">Apr 1, 2026</div>
  <li class="schedule-row">
    <a class="mobile-only" href="${HREF}"><span class="matchup">vs Third Party High</span></a>
    <a class="desktop-only" href="${HREF}">
      <span class="matchup">vs Third Party High</span>
      <span class="score">W 7-2</span>
    </a>
  </li>`);

module.exports.SHARED_HREF = HREF;
module.exports.singleRowTwoAnchors = singleRowTwoAnchors;
module.exports.twoRowsSharedHref = twoRowsSharedHref;
module.exports.twoRowsSharedHrefReversed = twoRowsSharedHrefReversed;
module.exports.twoRowsSharedHrefGameNumbers = twoRowsSharedHrefGameNumbers;
module.exports.twoRowsSharedIdDifferentScores = twoRowsSharedIdDifferentScores;
module.exports.twoIdenticalRowRoots = twoIdenticalRowRoots;
module.exports.responsiveSingleRow = responsiveSingleRow;

// ── Generic-wrapper fixtures (HS 2D review correction) ─────────────────
//
// A generic container is NOT a per-game boundary. A date-group `li` or a table
// `tr` routinely holds several games, so accepting the nearest such ancestor
// silently collapsed them into one entry and dropped real games. These fixtures
// pin the corrected rule: only an explicit per-game marker that contains a
// single distinct schedule reference may group anchors.

const gameLink = (id, label, score = '') =>
  `<a href="${ORIGIN}/teams/opponent-high/schedule/${id}">`
  + `<span class="matchup">vs ${label}</span>`
  + (score ? `<span class="score">${score}</span>` : '')
  + `</a>`;

// 1. A date-group <li> holding two DIFFERENT games.
const dateGroupLiTwoGames = page(`
  <li class="date-group">
    <div class="date-header">Apr 11, 2026</div>
    ${gameLink('game-alpha', 'Alpha High', 'W 5-1')}
    ${gameLink('game-beta', 'Beta High', 'L 2-7')}
  </li>`);

// 3a. The same date group with the anchors in the opposite order.
const dateGroupLiTwoGamesReversed = page(`
  <li class="date-group">
    <div class="date-header">Apr 11, 2026</div>
    ${gameLink('game-beta', 'Beta High', 'L 2-7')}
    ${gameLink('game-alpha', 'Alpha High', 'W 5-1')}
  </li>`);

// 2. A table <tr> holding two DIFFERENT games, one per cell.
const tableRowTwoGames = page(`
  <table><tbody><tr>
    <td><div class="date-header">Apr 12, 2026</div>${gameLink('game-gamma', 'Gamma High', 'W 3-0')}</td>
    <td>${gameLink('game-delta', 'Delta High', 'L 1-9')}</td>
  </tr></tbody></table>`);

// 3b. The same table row reversed.
const tableRowTwoGamesReversed = page(`
  <table><tbody><tr>
    <td><div class="date-header">Apr 12, 2026</div>${gameLink('game-delta', 'Delta High', 'L 1-9')}</td>
    <td>${gameLink('game-gamma', 'Gamma High', 'W 3-0')}</td>
  </tr></tbody></table>`);

// 4. A generic wrapper holding two anchors to the SAME href, with no explicit
//    per-game element. This might be one game rendered twice or two ambiguous
//    rows; without affirmative structure it must not be silently merged.
const genericWrapperSameHref = page(`
  <li class="date-group">
    <div class="date-header">Apr 13, 2026</div>
    ${gameLink('game-shared', 'Iota High')}
    ${gameLink('game-shared', 'Iota High')}
  </li>`);

// 5. Two explicit per-game elements nested inside one generic date wrapper.
const nestedExplicitRowsInGenericWrapper = page(`
  <li class="date-group">
    <div class="date-header">Apr 14, 2026</div>
    <div class="schedule-row">${gameLink('game-kappa', 'Kappa High', 'W 8-0')}</div>
    <div class="schedule-row">${gameLink('game-lambda', 'Lambda High', 'L 3-5')}</div>
  </li>`);

// 7. Control: one game per <li>, no explicit marker.
const perGameLiRows = page(`
  <div class="date-header">Apr 15, 2026</div>
  <li>${gameLink('game-mu', 'Mu High', 'W 4-2')}</li>
  <li>${gameLink('game-nu', 'Nu High', 'L 0-3')}</li>`);

// 8. Control: one game per <tr>.
const perGameTrRows = page(`
  <table><tbody>
    <tr><td><div class="date-header">Apr 16, 2026</div>${gameLink('game-xi', 'Xi High', 'W 6-1')}</td></tr>
    <tr><td>${gameLink('game-omicron', 'Omicron High', 'L 2-4')}</td></tr>
  </tbody></table>`);

module.exports.dateGroupLiTwoGames = dateGroupLiTwoGames;
module.exports.dateGroupLiTwoGamesReversed = dateGroupLiTwoGamesReversed;
module.exports.tableRowTwoGames = tableRowTwoGames;
module.exports.tableRowTwoGamesReversed = tableRowTwoGamesReversed;
module.exports.genericWrapperSameHref = genericWrapperSameHref;
module.exports.nestedExplicitRowsInGenericWrapper = nestedExplicitRowsInGenericWrapper;
module.exports.perGameLiRows = perGameLiRows;
module.exports.perGameTrRows = perGameTrRows;

// A generic date-group wrapper in which each game carries its own date header,
// so both rows resolve a date in either DOM order. Used for the production-shaped
// two-game proof, where the point is that a generic wrapper never costs a game.
const dateGroupLiTwoDatedGames = page(`
  <li class="date-group">
    <div class="date-header">Apr 11, 2026</div>
    ${gameLink('game-alpha', 'Alpha High', 'W 5-1')}
    <div class="date-header">Apr 12, 2026</div>
    ${gameLink('game-beta', 'Beta High', 'L 2-7')}
  </li>`);

const dateGroupLiTwoDatedGamesReversed = page(`
  <li class="date-group">
    <div class="date-header">Apr 12, 2026</div>
    ${gameLink('game-beta', 'Beta High', 'L 2-7')}
    <div class="date-header">Apr 11, 2026</div>
    ${gameLink('game-alpha', 'Alpha High', 'W 5-1')}
  </li>`);

const tableRowTwoDatedGames = page(`
  <table><tbody><tr>
    <td><div class="date-header">Apr 13, 2026</div>${gameLink('game-gamma', 'Gamma High', 'W 3-0')}</td>
    <td><div class="date-header">Apr 14, 2026</div>${gameLink('game-delta', 'Delta High', 'L 1-9')}</td>
  </tr></tbody></table>`);

module.exports.dateGroupLiTwoDatedGames = dateGroupLiTwoDatedGames;
module.exports.dateGroupLiTwoDatedGamesReversed = dateGroupLiTwoDatedGamesReversed;
module.exports.tableRowTwoDatedGames = tableRowTwoDatedGames;

// -- Deterministic date-scoping fixtures (HS 2D date-attribution correction) --
//
// A date header governs its own scope and nothing beyond it. These pin that
// contract from both directions: every game inside a group must receive the
// group's date, and no game may ever receive a NEIGHBOURING group's date.
//
// Every team name, game id, venue and date below is invented. There are no
// credentials, cookies, tokens, sessions, rosters or customer records here, and
// nothing is ever fetched: the markup is loaded with page.setContent()/route
// fulfilment and test/helpers/gc-network-guard.js aborts any gc.com request.

// Spans are separated by real whitespace, exactly as rendered markup is. Without
// it adjacent inline nodes concatenate ("Alpha High4:00 PM") and a status the
// source really did express stops being readable.
const dg = (id, label, { score = '', time = '', gameNumber = null, gameDate = '' } = {}) =>
  `<a href="${ORIGIN}/teams/opponent-high/schedule/${id}">`
  + `<span class="matchup">vs ${label}</span> `
  + (gameDate ? `<span class="game-date">${gameDate}</span> ` : '')
  + (time ? `<span class="time">${time}</span> ` : '')
  + (score ? `<span class="score">${score}</span> ` : '')
  + (gameNumber ? `<span class="game-number">Game ${gameNumber}</span>` : '')
  + `</a>`;

const group = (headerText, ...games) =>
  `<li class="date-group"><div class="date-header">${headerText}</div>${games.join('')}</li>`;

// 1. One date group holding two SCHEDULED games.
const dateGroupTwoScheduled = page(group('Apr 11, 2026',
  dg('sched-alpha', 'Alpha High', { time: '4:00 PM' }),
  dg('sched-bravo', 'Bravo High', { time: '7:00 PM' })));

// 2. One date group holding two COMPLETED games.
const dateGroupTwoCompleted = page(group('Apr 11, 2026',
  dg('done-alpha', 'Alpha High', { score: 'W 5-1' }),
  dg('done-bravo', 'Bravo High', { score: 'L 2-7' })));

// 3. One date group holding one completed and one scheduled game.
const dateGroupMixedStatuses = page(group('Apr 11, 2026',
  dg('mixed-alpha', 'Alpha High', { score: 'W 5-1' }),
  dg('mixed-bravo', 'Bravo High', { time: '7:00 PM' })));

// 4. TWO sibling date groups, two games each. This is the exact shape whose
//    fourth game used to inherit the FIRST group's date.
const twoDateGroupsTwoGamesEach = page([
  group('Apr 11, 2026', dg('grp-a', 'Alpha High', { score: 'W 1-0' }), dg('grp-b', 'Bravo High', { score: 'L 0-1' })),
  group('Apr 18, 2026', dg('grp-c', 'Charlie High', { score: 'W 2-0' }), dg('grp-d', 'Delta High', { score: 'L 0-2' })),
].join(''));

// 5. The same two groups with the GAMES reversed inside each group.
const twoDateGroupsGamesReversedWithinGroups = page([
  group('Apr 11, 2026', dg('grp-b', 'Bravo High', { score: 'L 0-1' }), dg('grp-a', 'Alpha High', { score: 'W 1-0' })),
  group('Apr 18, 2026', dg('grp-d', 'Delta High', { score: 'L 0-2' }), dg('grp-c', 'Charlie High', { score: 'W 2-0' })),
].join(''));

// 6. The same two groups with the whole GROUPS reversed.
const twoDateGroupsGroupOrderReversed = page([
  group('Apr 18, 2026', dg('grp-c', 'Charlie High', { score: 'W 2-0' }), dg('grp-d', 'Delta High', { score: 'L 0-2' })),
  group('Apr 11, 2026', dg('grp-a', 'Alpha High', { score: 'W 1-0' }), dg('grp-b', 'Bravo High', { score: 'L 0-1' })),
].join(''));

// 7. Every game carries its own explicit date; there is no group header at all.
const explicitDateOnEveryGame = page(`
  <div class="schedule-row">${dg('own-a', 'Alpha High', { score: 'W 3-1', gameDate: 'Apr 11, 2026' })}</div>
  <div class="schedule-row">${dg('own-b', 'Bravo High', { score: 'L 1-3', gameDate: 'Apr 18, 2026' })}</div>`);

// 8. A group date plus a per-game date that AGREES with it. Confirmation, not
//    conflict.
const groupDateWithMatchingGameDate = page(group('Apr 11, 2026',
  dg('agree-a', 'Alpha High', { score: 'W 4-2', gameDate: 'Apr 11, 2026' }),
  dg('agree-b', 'Bravo High', { score: 'L 2-4' })));

// 9. A group date plus a per-game date that CONTRADICTS it. Must be reported as
//    a conflict, never resolved in either direction.
const groupDateWithConflictingGameDate = page(group('Apr 11, 2026',
  dg('clash-a', 'Alpha High', { score: 'W 4-2', gameDate: 'Apr 25, 2026' }),
  dg('clash-b', 'Bravo High', { score: 'L 2-4' })));

// 10. A date group whose header carries no recognizable date.
const dateGroupWithUnrecognizableHeader = page(
  `<li class="date-group"><div class="date-header">Upcoming Fixtures</div>`
  + dg('nohdr-a', 'Alpha High', { time: '4:00 PM' })
  + dg('nohdr-b', 'Bravo High', { time: '7:00 PM' })
  + `</li>`);

// 11. A game that sits outside every date group.
const gameOutsideAnyDateGroup = page(
  `<div class="schedule-row">${dg('loose-a', 'Alpha High', { score: 'W 6-0' })}</div>`
  + group('Apr 18, 2026', dg('grouped-b', 'Bravo High', { score: 'L 0-6' })));

// 12. Two INDEPENDENT schedule sections. A date in one must never reach the
//     other, in either direction.
const twoIndependentScheduleSections = `<!doctype html><html><body>
  <header><h1>Opponent High Varsity Baseball</h1></header>
  <section class="schedule schedule-varsity">
    ${group('Apr 11, 2026', dg('sec1-a', 'Alpha High', { score: 'W 1-0' }), dg('sec1-b', 'Bravo High', { score: 'L 0-1' }))}
  </section>
  <section class="schedule schedule-jv">
    ${group('May 2, 2026', dg('sec2-a', 'Charlie High', { score: 'W 3-2' }), dg('sec2-b', 'Delta High', { score: 'L 2-3' }))}
  </section>
</body></html>`;

// 13. A rescheduled game keeping its stable upstream id while its group date
//     moves. Identity must survive; the date must follow the source.
const rescheduledStableIdBefore = page(group('Apr 10, 2026',
  dg('resched-1', 'Alpha High', { time: '4:30 PM' }),
  dg('resched-2', 'Bravo High', { time: '7:00 PM' })));
const rescheduledStableIdAfter = page(group('Apr 17, 2026',
  dg('resched-1', 'Alpha High', { score: 'L 3-6' }),
  dg('resched-2', 'Bravo High', { score: 'W 5-1' })));

// 14. A completed doubleheader under ONE date header. Both games are on that
//     date; Game 1 / Game 2 keep them apart.
const doubleheaderUnderOneDateHeader = page(group('Apr 11, 2026',
  dg('dh-one', 'Alpha High', { score: 'W 3-2', time: '10:00 AM', gameNumber: 1 }),
  dg('dh-two', 'Alpha High', { score: 'L 1-4', time: '1:00 PM', gameNumber: 2 })));

// 15. The same doubleheader before it is played.
const futureDoubleheaderUnderOneDateHeader = page(group('May 9, 2026',
  dg('fdh-one', 'Alpha High', { time: '10:00 AM', gameNumber: 1 }),
  dg('fdh-two', 'Alpha High', { time: '1:00 PM', gameNumber: 2 })));

// 16. Malformed header text: a day number no calendar has.
const malformedDateHeaderText = page(group('Apr 99, 2026',
  dg('mal-a', 'Alpha High', { score: 'W 2-1' }),
  dg('mal-b', 'Bravo High', { score: 'L 1-2' })));

// 17. Harmless format and whitespace variation. Must normalize to exactly the
//     same date as dateGroupTwoCompleted, so a cosmetic source change cannot
//     mint a new generation.
const dateFormatAndWhitespaceVariation = page(group('  Saturday,   April   11,    2026  ',
  dg('done-alpha', 'Alpha High', { score: 'W 5-1' }),
  dg('done-bravo', 'Bravo High', { score: 'L 2-7' })));

// 18. A header that names MORE THAN ONE date. Nothing may pick a winner.
const dateGroupWithTwoDatesInHeader = page(group('Apr 11, 2026 - Apr 13, 2026',
  dg('amb-a', 'Alpha High', { score: 'W 2-0' }),
  dg('amb-b', 'Bravo High', { score: 'L 0-2' })));

module.exports.dateGroupTwoScheduled = dateGroupTwoScheduled;
module.exports.dateGroupTwoCompleted = dateGroupTwoCompleted;
module.exports.dateGroupMixedStatuses = dateGroupMixedStatuses;
module.exports.twoDateGroupsTwoGamesEach = twoDateGroupsTwoGamesEach;
module.exports.twoDateGroupsGamesReversedWithinGroups = twoDateGroupsGamesReversedWithinGroups;
module.exports.twoDateGroupsGroupOrderReversed = twoDateGroupsGroupOrderReversed;
module.exports.explicitDateOnEveryGame = explicitDateOnEveryGame;
module.exports.groupDateWithMatchingGameDate = groupDateWithMatchingGameDate;
module.exports.groupDateWithConflictingGameDate = groupDateWithConflictingGameDate;
module.exports.dateGroupWithUnrecognizableHeader = dateGroupWithUnrecognizableHeader;
module.exports.gameOutsideAnyDateGroup = gameOutsideAnyDateGroup;
module.exports.twoIndependentScheduleSections = twoIndependentScheduleSections;
module.exports.rescheduledStableIdBefore = rescheduledStableIdBefore;
module.exports.rescheduledStableIdAfter = rescheduledStableIdAfter;
module.exports.doubleheaderUnderOneDateHeader = doubleheaderUnderOneDateHeader;
module.exports.futureDoubleheaderUnderOneDateHeader = futureDoubleheaderUnderOneDateHeader;
module.exports.malformedDateHeaderText = malformedDateHeaderText;
module.exports.dateFormatAndWhitespaceVariation = dateFormatAndWhitespaceVariation;
module.exports.dateGroupWithTwoDatesInHeader = dateGroupWithTwoDatesInHeader;

// Relative-vs-absolute reference forms for ONE game inside one explicit row.
// These are the same game and must group as one observation, not collide.
module.exports.relativeAndAbsoluteSameGame = page(`
  <div class="date-header">Apr 11, 2026</div>
  <div class="schedule-row">
    <a href="/teams/opponent-high/schedule/rel-abs-1"><span class="thumb">box score</span></a>
    <a href="${ORIGIN}/teams/opponent-high/schedule/rel-abs-1">
      <span class="matchup">vs Alpha High</span><span class="score">W 9-1</span>
    </a>
  </div>`);

// Two genuinely different schedule paths must stay two games even though they
// differ only in their final segment.
module.exports.relativeAndAbsoluteDifferentGames = page(`
  <div class="date-header">Apr 11, 2026</div>
  <div class="schedule-row"><a href="/teams/opponent-high/schedule/rel-abs-1"><span class="matchup">vs Alpha High</span><span class="score">W 9-1</span></a></div>
  <div class="schedule-row"><a href="${ORIGIN}/teams/opponent-high/schedule/rel-abs-2"><span class="matchup">vs Bravo High</span><span class="score">L 1-9</span></a></div>`);

// A visible schedule anchor carrying no game id segment at all: an unresolved
// identity that must never reach a published generation.
module.exports.anchorWithNoGameIdSegment = page(`
  <div class="date-header">Apr 11, 2026</div>
  <div class="schedule-row">
    <a href="${ORIGIN}/teams/opponent-high/schedule/"><span class="matchup">vs Alpha High</span><span class="score">W 3-1</span></a>
  </div>`);

// ── HS 2D final-review correction: unmarked dated text must not govern ──
//
// Everything below carries a real, parseable date in an element the source
// never marked as a schedule date boundary. Before the correction each of these
// governed the games in its parent's subtree, and the first two were reproduced
// publishing a WRONG date into a verified generation. Each must now resolve
// not_expressed: the games survive, and no date is invented for them.
//
// `unmarked` keeps the shape identical across the whole family so the only
// thing under test is which element carries the date and where it sits.
const unmarked = (cls, text) => `<div class="${cls}">${text}</div>`;

// 1. A page-level caption beside a schedule that has no header of its own.
//    Reproduced publishing 2026-03-03 onto a game the source never dated.
module.exports.captionBeforeHeaderlessSchedule = `<!doctype html><html><body>
  <div id="page">
    ${unmarked('page-caption', 'Season opener Mar 3, 2026')}
    <section class="schedule"><div class="date-group">
      ${dg('cap-a', 'Alpha High', { score: 'W 7-2' })}
    </div></section>
  </div></body></html>`;

// 1b. The same shape with an UNPLAYED game. The completed-game exception cannot
//     reach this one -- there is no result to anchor it -- so it must fail
//     closed at the collector rather than publish an undated schedule entry.
module.exports.captionBeforeHeaderlessScheduledGame = `<!doctype html><html><body>
  <div id="page">
    ${unmarked('page-caption', 'Season opener Mar 3, 2026')}
    <section class="schedule"><div class="date-group">
      ${dg('cap-sched', 'Alpha High', { time: '4:00 PM' })}
    </div></section>
  </div></body></html>`;

// 2. An unrelated dated note BETWEEN two games in one date group. Reproduced
//    handing 2026-04-20 to the game after it while the group says Apr 11.
module.exports.datedNoteBetweenGames = page(`
  <div class="date-group">
    <div class="date-header">Apr 11, 2026</div>
    ${dg('note-a', 'Alpha High', { score: 'W 5-1' })}
    ${unmarked('note', 'Roster locked 4/20/2026')}
    ${dg('note-b', 'Bravo High', { score: 'L 2-7' })}
  </div>`);

// 3. A dated note BEFORE the first game, with no marked header anywhere.
module.exports.datedNoteBeforeFirstGame = page(`
  <div class="date-group">
    ${unmarked('note', 'Printed 4/1/2026')}
    ${dg('pre-a', 'Alpha High', { score: 'W 5-1' })}
  </div>`);

// 4. A dated note AFTER the final game. It follows every row, so it governs
//    nothing even under the old rule -- kept so a future change that starts
//    scanning forwards is caught immediately.
module.exports.datedNoteAfterLastGame = page(`
  <div class="date-group">
    <div class="date-header">Apr 11, 2026</div>
    ${dg('post-a', 'Alpha High', { score: 'W 5-1' })}
    ${unmarked('note', 'Updated 4/30/2026')}
  </div>`);

// 5. A tournament title that happens to name a date.
module.exports.datedTournamentTitle = page(`
  ${unmarked('tournament-title', 'Spring Classic Apr 3, 2026')}
  <div class="date-group">${dg('tour-a', 'Alpha High', { score: 'W 5-1' })}</div>`);

// 6. Administrative dates. The last of these is MARKED as a date header, so it
//    proves the qualifier guard and not merely the marker requirement.
module.exports.registrationClosesDate = page(`
  ${unmarked('banner', 'Registration closes Apr 5, 2026')}
  <div class="date-group">${dg('reg-a', 'Alpha High', { score: 'W 5-1' })}</div>`);
module.exports.lastSyncedDate = page(`
  ${unmarked('meta', 'Last synced 4/19/2026')}
  <div class="date-group">${dg('sync-a', 'Alpha High', { score: 'W 5-1' })}</div>`);
module.exports.markedHeaderWithUpdatedQualifier = page(`
  <div class="date-group">
    <div class="date-header">Updated Apr 20, 2026</div>
    ${dg('upd-a', 'Alpha High', { score: 'W 5-1' })}
  </div>`);

// 7. A dated caption INSIDE a date group that has no header of its own.
module.exports.datedCaptionInsideGroup = page(`
  <div class="date-group">
    ${unmarked('caption', 'Photos from 4/2/2026')}
    ${dg('capin-a', 'Alpha High', { score: 'W 5-1' })}
  </div>`);

// 8. A dated caption OUTSIDE the schedule component but sharing its parent.
module.exports.datedCaptionOutsideComponent = `<!doctype html><html><body>
  <div id="page">
    ${unmarked('hero', 'Homecoming Apr 25, 2026')}
    <section class="schedule"><div class="date-group">
      ${dg('hero-a', 'Alpha High', { score: 'W 5-1' })}
    </div></section>
  </div></body></html>`;

// 9. Two schedule components under one common parent, each properly headed.
//    Neither component's date may reach the other.
module.exports.twoComponentsOneParent = `<!doctype html><html><body>
  <div id="page">
    <div class="component">${group('May 5, 2026', dg('comp-a', 'Alpha High', { score: 'W 5-1' }))}</div>
    <div class="component">${group('Apr 5, 2026', dg('comp-b', 'Bravo High', { score: 'L 1-2' }))}</div>
  </div></body></html>`;

// 10. Nested date groups: a month header wrapping a day header. The INNER
//     header is the more specific claim and must win. This is not competition,
//     and treating it as such would publish nothing for a well-formed schedule.
module.exports.nestedDateGroups = page(`
  <div class="month">
    <div class="date-header">Apr 11, 2026</div>
    <div class="date-group">
      <div class="date-header">Apr 18, 2026</div>
      ${dg('nest-a', 'Alpha High', { score: 'W 5-1' })}
    </div>
  </div>`);

// 15. Two MARKED headers back to back before one row, naming different dates.
//     Both credibly claim it, so the row is ambiguous rather than guessed.
module.exports.competingMarkedHeaders = page(`
  <div class="date-group">
    <div class="date-header">Apr 11, 2026</div>
    <div class="date-header">Apr 18, 2026</div>
    ${dg('comp-x', 'Alpha High', { score: 'W 5-1' })}
  </div>`);

// 15b. The same shape naming the SAME date twice: confirmation, not competition.
module.exports.repeatedIdenticalMarkedHeaders = page(`
  <div class="date-group">
    <div class="date-header">Apr 11, 2026</div>
    <div class="date-header">Apr 11, 2026</div>
    ${dg('comp-y', 'Alpha High', { score: 'W 5-1' })}
  </div>`);

// 16/17. Headerless games. The completed one may publish undated under the
//        documented exception; the unplayed one has nothing to anchor it.
module.exports.headerlessCompletedGame = page(`
  <div class="date-group">${dg('bare-final', 'Alpha High', { score: 'W 5-1' })}</div>`);
module.exports.headerlessScheduledGame = page(`
  <div class="date-group">${dg('bare-sched', 'Alpha High', { time: '4:00 PM' })}</div>`);

// 30. The data-attribute header form, so the contract is not accidentally
//     narrowed to the two class selectors.
module.exports.dataAttributeDateHeader = page(`
  <div class="date-group">
    <div data-schedule-date="Apr 11, 2026">Apr 11, 2026</div>
    ${dg('attr-a', 'Alpha High', { score: 'W 5-1' })}
  </div>`);

// ── Impossible calendar dates ──────────────────────────────────────────
module.exports.februaryThirtieth = page(group('Feb 30, 2026',
  dg('cal-feb30', 'Alpha High', { score: 'W 5-1' })));
module.exports.aprilThirtyFirst = page(group('Apr 31, 2026',
  dg('cal-apr31', 'Alpha High', { score: 'W 5-1' })));
module.exports.nonLeapFebruaryTwentyNinth = page(group('Feb 29, 2026',
  dg('cal-feb29-bad', 'Alpha High', { score: 'W 5-1' })));
module.exports.leapFebruaryTwentyNinth = page(group('Feb 29, 2028',
  dg('cal-feb29-ok', 'Alpha High', { score: 'W 5-1' })));

// ── Malformed schedule references ──────────────────────────────────────
//
// A bracketed host the URL parser rejects, sitting beside a perfectly good row.
// Before the correction this threw an untyped TypeError out of extraction and
// took the valid row down with it.
module.exports.malformedHrefBesideValidRow = page(`
  <div class="date-group">
    <div class="date-header">Apr 11, 2026</div>
    ${dg('mal-ok', 'Alpha High', { score: 'W 5-1' })}
    <a class="schedule-row" href="http://[bad/schedule/x"><span class="matchup">vs Bravo High</span> <span class="score">L 1-2</span></a>
  </div>`);

// Two DIFFERENTLY malformed references. Neither may be given an identity, and
// they must not collapse into one shared empty or sentinel identity either.
module.exports.twoDistinctMalformedHrefs = page(`
  <div class="date-group">
    <div class="date-header">Apr 11, 2026</div>
    <a class="schedule-row" href="http://[bad-one/schedule/a"><span class="matchup">vs Alpha High</span> <span class="score">W 5-1</span></a>
    <a class="schedule-row" href="http://[bad-two/schedule/b"><span class="matchup">vs Bravo High</span> <span class="score">L 1-2</span></a>
  </div>`);

// ── Source status regression: ONE game, same upstream id, two statuses ──
//
// Distinct from a completeness regression, which is what happens when a
// previously verified game disappears from the candidate altogether. Here the
// game is still present under the same id and the source has walked its status
// back -- a retraction, which must be surfaced rather than applied silently
// over a verified result.
module.exports.sameGameFinal = page(group('Apr 11, 2026',
  dg('regress-1', 'Alpha High', { score: 'W 5-1' })));
module.exports.sameGameScheduled = page(group('Apr 11, 2026',
  dg('regress-1', 'Alpha High', { time: '4:00 PM' })));
module.exports.sameGamePostponed = page(group('Apr 11, 2026',
  dg('regress-1', 'Alpha High', { time: '4:00 PM' })).replace(
  '</a>', '<span class="status">Postponed</span></a>'));
module.exports.sameGameFinalRescored = page(group('Apr 11, 2026',
  dg('regress-1', 'Alpha High', { score: 'L 1-9' })));

// ── HS 2D date-header semantics: the positive grammar ──────────────────
//
// Structural marking says the SOURCE believes an element is a date header. It
// does not say the text is a schedule date. Everything below is MARKED
// (.date-header) and must still be refused, because the date does not lead the
// text -- which is the shape of every administrative header.
//
// The first thirteen are the phrasings a reviewer reproduced publishing their
// embedded date into a verified generation; the remaining seven were refused by
// the old keyword list and must stay refused now that the list is gone.
const markedHeader = (text, games) =>
  page(`<div class="date-group"><div class="date-header">${text}</div>${games}</div>`);

module.exports.MARKED_ADMINISTRATIVE_HEADERS = Object.freeze({
  seasonOpener: 'Season opener Mar 3, 2026',
  tournamentStart: 'Tournament starts Mar 5, 2026',
  rosterFreeze: 'Roster freeze Mar 12, 2026',
  lastModified: 'Last modified Mar 9, 2026',
  eligibility: 'Eligibility through Mar 20, 2026',
  tryouts: 'Tryouts Mar 4, 2026',
  rainout: 'Rainout announced Mar 14, 2026',
  rescheduleNotice: 'Reschedule notice Mar 15, 2026',
  venueAvailability: 'Venue available Mar 2, 2026',
  ticketSale: 'Tickets on sale Mar 1, 2026',
  published: 'Published Mar 8, 2026',
  effective: 'Effective Mar 10, 2026',
  through: 'Valid through Mar 21, 2026',
  registrationDeadline: 'Registration closes Mar 15, 2026',
  updated: 'Schedule updated Mar 6, 2026',
  lastSynced: 'Last synced Mar 8, 2026',
  scheduleGenerated: 'Schedule generated Mar 10, 2026',
  scoresUpdated: 'Scores updated Mar 11, 2026',
  posted: 'Posted Mar 18, 2026',
  currentAsOf: 'Current as of Mar 7, 2026',
});

// Legitimate schedule headers. Every suffix names a property of the game played
// on that date, and each has a counterpart this codebase already parses.
module.exports.SUPPORTED_SCHEDULE_HEADERS = Object.freeze({
  bareDate: 'Apr 11, 2026',
  weekdayAndDate: 'Saturday, April 11, 2026',
  abbreviatedWeekday: 'Sat. Apr 11, 2026',
  slashForm: '4/11/2026',
  doubleheader: 'Apr 11, 2026 - Doubleheader',
  gameOne: 'Apr 11, 2026 - Game 1',
  gameTwoParenthesised: 'Apr 11, 2026 (Game 2)',
  home: 'Apr 11, 2026 - Home',
  away: 'Apr 11, 2026 - Away',
  seniorNight: 'Apr 11, 2026 - Senior Night',
  gatesOpen: 'Apr 11, 2026 - gates open at 5',
  firstPitch: 'Apr 11, 2026 - first pitch 6:30 PM',
  varsity: 'Apr 11, 2026 - Varsity',
  juniorVarsity: 'Apr 11, 2026 - JV',
  bareTime: 'Apr 11, 2026 - 4:30 PM',
  combined: 'April 11, 2026 - Doubleheader, Home',
});

module.exports.markedHeaderWith = (text, { played = true } = {}) => markedHeader(
  text, dg('grammar-1', 'Alpha High', played ? { score: 'W 5-1' } : { time: '4:00 PM' }));

// Annotation BEFORE the date: still administrative ordering, still refused.
module.exports.annotationBeforeDate = markedHeader('Doubleheader Apr 11, 2026',
  dg('order-1', 'Alpha High', { score: 'W 5-1' }));

// Material prose after an otherwise valid leading date.
module.exports.unsupportedProseAfterDate = markedHeader('Apr 11, 2026 - bus leaves at 3 from the north lot',
  dg('prose-1', 'Alpha High', { score: 'W 5-1' }));

// ── Structured date evidence ───────────────────────────────────────────
//
// These attributes were previously read as bare Boolean markers and their
// VALUES thrown away, so a header could publish a machine-readable date and
// still be read from its prose.
const structuredHeader = (attrs, text, games) =>
  page(`<div class="date-group"><div ${attrs}>${text}</div>${games}</div>`);
const one = (id) => dg(id, 'Alpha High', { score: 'W 5-1' });

module.exports.structuredValueWithMatchingText = structuredHeader('data-schedule-date="2026-04-11"', 'Apr 11, 2026', one('st-1'));
module.exports.structuredValueWithNoText = structuredHeader('data-schedule-date="2026-04-11"', '', one('st-2'));
module.exports.structuredValueContradictingText = structuredHeader('data-schedule-date="2026-04-11"', 'Apr 18, 2026', one('st-3'));
module.exports.structuredValueImpossible = structuredHeader('data-schedule-date="2026-02-30"', 'Apr 11, 2026', one('st-4'));
module.exports.structuredValueWithAdministrativeProse = structuredHeader('data-schedule-date="2026-04-11"', 'Rainout announced Mar 14, 2026', one('st-5'));
module.exports.structuredDateHeaderAttribute = structuredHeader('data-date-header="2026-04-11"', 'Apr 11, 2026', one('st-6'));
module.exports.structuredTimeElement = page(`<div class="date-group"><time class="schedule-date" datetime="2026-04-11">Apr 11</time>${one('st-7')}</div>`);
module.exports.structuredBooleanMarkerOnly = structuredHeader('data-date-header="1"', 'Apr 11, 2026', one('st-8'));

// ── Scope containment ──────────────────────────────────────────────────
//
// A marked header OUTSIDE the schedule component that renders the games must
// not reach into it merely because a shared wrapper contains both.
module.exports.markedHeaderOutsideComponent = `<!doctype html><html><body>
  <div id="page">
    <div class="date-header">Mar 3, 2026</div>
    <section class="schedule"><div class="date-group">${one('scope-1')}</div></section>
  </div></body></html>`;

module.exports.administrativeHeaderBeforeTwoComponents = `<!doctype html><html><body>
  <div id="page">
    <div class="date-header">Schedule updated Mar 6, 2026</div>
    <section class="schedule"><div class="date-group"><div class="date-header">Apr 11, 2026</div>${one('twoc-a')}</div></section>
    <section class="schedule"><div class="date-group"><div class="date-header">Apr 18, 2026</div>${one('twoc-b')}</div></section>
  </div></body></html>`;

module.exports.headerInOneComponentCannotGovernAnother = `<!doctype html><html><body>
  <div id="page">
    <section class="schedule"><div class="date-header">Apr 11, 2026</div></section>
    <section class="schedule"><div class="date-group">${one('cross-1')}</div></section>
  </div></body></html>`;

module.exports.nestedScheduleComponents = `<!doctype html><html><body>
  <section class="schedule">
    <div class="date-header">Apr 11, 2026</div>
    <section class="schedule"><div class="date-group">${one('nestc-1')}</div></section>
  </section></body></html>`;

// ── Non-HTTP schedule references ───────────────────────────────────────
const schemeRow = (href, label) =>
  `<a class="schedule-row" href="${href}"><span class="matchup">vs ${label}</span> <span class="score">W 5-1</span></a>`;
module.exports.nonHttpSchemeReferences = page(`
  <div class="date-group"><div class="date-header">Apr 11, 2026</div>
    ${schemeRow('javascript:void(0)/schedule/js-1', 'Alpha')}
  </div>`);
module.exports.mixedCaseJavascriptScheme = page(`
  <div class="date-group"><div class="date-header">Apr 11, 2026</div>
    ${schemeRow('JaVaScRiPt:void(0)/schedule/js-2', 'Alpha')}
  </div>`);
module.exports.ftpSchemeReference = page(`
  <div class="date-group"><div class="date-header">Apr 11, 2026</div>
    ${schemeRow('ftp://x/schedule/ftp-1', 'Alpha')}
  </div>`);
module.exports.dataSchemeReference = page(`
  <div class="date-group"><div class="date-header">Apr 11, 2026</div>
    ${schemeRow('data:text/html,/schedule/data-1', 'Alpha')}
  </div>`);
module.exports.nonHttpBesideValidRow = page(`
  <div class="date-group"><div class="date-header">Apr 11, 2026</div>
    ${one('scheme-ok')}
    ${schemeRow('javascript:void(0)/schedule/js-3', 'Bravo')}
  </div>`);
module.exports.twoDistinctNonHttpSchemes = page(`
  <div class="date-group"><div class="date-header">Apr 11, 2026</div>
    ${schemeRow('javascript:void(0)/schedule/js-4', 'Alpha')}
    ${schemeRow('ftp://x/schedule/ftp-2', 'Bravo')}
  </div>`);
module.exports.protocolRelativeReference = page(`
  <div class="date-group"><div class="date-header">Apr 11, 2026</div>
    ${schemeRow('//web.gc.com/teams/opponent-high/schedule/pr-1', 'Alpha')}
  </div>`);
