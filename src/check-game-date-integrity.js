/**
 * check-game-date-integrity.js
 *
 * Diagnostic: finds teams where scraped games have suspiciously collapsed
 * game_date values — i.e. many games, against many different opponents, all
 * sharing the exact same date. This is the root cause behind PitchSmart
 * reports that show impossible things like "352 pitches across 5 outings"
 * on a single day: the scraper's date-resolution heuristic failed for that
 * team's schedule page layout and stamped every game with one date.
 *
 * This does NOT fix anything — it only detects it. Any team it flags needs
 * to be re-scraped (after deploying the search-gamechanger-teams.js fix)
 * with GC_REPROCESS_ALL_COMPLETED_GAMES=true, since games are matched and
 * updated in place by gc_game_id/gc_game_url.
 *
 * Usage:
 *   railway run node src/check-game-date-integrity.js
 *   node src/check-game-date-integrity.js          (local, if USE_SUPABASE=true)
 */

'use strict';

const db = require('./db');

async function main() {
  db.init(process.env.SQLITE_DB_PATH || require('path').join(__dirname, '..', 'voodoo-scout.db'));

  const teams = await Promise.resolve(db.getAllTeams());
  if (!Array.isArray(teams) || !teams.length) {
    console.log('No teams found.');
    return;
  }

  console.log(`Checking ${teams.length} team(s) for collapsed game_date values...\n`);

  const flagged = [];

  for (const team of teams) {
    const games = await Promise.resolve(
      typeof db.getGamesByTeam === 'function' ? db.getGamesByTeam(team.id) : []
    );
    if (!Array.isArray(games) || games.length < 4) continue;

    const byDate = {};
    for (const g of games) {
      const date = g.game_date || g.gameDate;
      if (!date) continue;
      if (!byDate[date]) byDate[date] = new Set();
      if (g.opponent_name) byDate[date].add(g.opponent_name);
    }

    const distinctDates = Object.keys(byDate).length;
    const totalGames = games.length;

    // Flag: very few distinct dates relative to games played, with several
    // different opponents piled onto the same date. A real doubleheader is
    // 2 opponents on one date; anything higher on ONE date is a red flag.
    for (const [date, opponents] of Object.entries(byDate)) {
      if (opponents.size > 2) {
        flagged.push({
          team: team.team_name,
          teamId: team.id,
          date,
          distinctOpponentsOnDate: opponents.size,
          totalGames,
          distinctDatesOverall: distinctDates,
        });
      }
    }
  }

  if (!flagged.length) {
    console.log('No date-collapse issues found. All teams look OK.');
    return;
  }

  console.log(`FOUND ${flagged.length} suspect date bucket(s):\n`);
  for (const f of flagged) {
    console.log(`  ${f.team} (${f.teamId})`);
    console.log(`    Date ${f.date}: ${f.distinctOpponentsOnDate} different opponents on the same date`);
    console.log(`    Team totals: ${f.totalGames} games across ${f.distinctDatesOverall} distinct date(s)`);
    console.log('');
  }
  console.log('These teams need to be re-scraped after deploying the date-resolution fix.');
  console.log('Example (single team, force reprocess):');
  console.log('  GC_TEST_TEAM_CONTAINS="<team name>" GC_REPROCESS_ALL_COMPLETED_GAMES=true node src/search-gamechanger-teams.js');
}

main().catch(err => {
  console.error('check-game-date-integrity.js failed:', err.stack || err);
  process.exit(1);
});
