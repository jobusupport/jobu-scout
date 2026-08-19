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
