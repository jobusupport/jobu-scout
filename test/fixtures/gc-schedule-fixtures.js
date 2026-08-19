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
