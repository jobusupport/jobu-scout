/**
 * recalculate-all-teams.js
 *
 * Runs recalculateTeamStats() for every team in the database using the new
 * Supabase-native reconstruction (db-supabase.js:getGameDataForStatsEngine),
 * which rebuilds game objects from batting_lines/pitching_lines.raw_json +
 * play_events instead of reading local JSON files. This is what actually
 * recovers full-season swing decisions, spray%, RISP, and fielding errors
 * for Tennessee Yard and USA Prime Southeast Scout, and works identically
 * whether run from Railway or your laptop.
 *
 * Usage:
 *   railway run node src/recalculate-all-teams.js
 *
 * Or for a single team:
 *   railway run node src/recalculate-all-teams.js "Tennessee Yard 14U"
 */

const path = require('path');
const db = require('./db');
const pipeline = require('./pipeline');

async function main() {
  db.init(path.join(__dirname, '..', 'voodoo-scout.db'));

  const nameFilter = process.argv.slice(2).join(' ').trim().toLowerCase() || null;

  const teams = await Promise.resolve(db.getAllTeams());
  if (!Array.isArray(teams) || !teams.length) {
    console.log('No teams found.');
    return;
  }

  const targets = nameFilter
    ? teams.filter(t => (t.team_name || '').toLowerCase().includes(nameFilter))
    : teams;

  if (!targets.length) {
    console.log(`No teams matched "${nameFilter}".`);
    return;
  }

  console.log(`Recalculating stats for ${targets.length} team(s)...\n`);

  for (const team of targets) {
    console.log(`${'='.repeat(60)}`);
    console.log(`${team.team_name} (${team.id})`);
    console.log('='.repeat(60));
    try {
      // invertTeamSide: false — these teams were ingested as the scouted
      // (opponent) side, i.e. already is_our_team=false. Only pass true if
      // this particular team was ingested via an inverted scrape.
      await pipeline.recalculateTeamStats(team.id, { invertTeamSide: false });
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      console.error(err.stack || err);
    }
    console.log('');
  }

  console.log('Done. Regenerate reports to confirm swing decisions, spray%, and fielding errors now reflect the full season.');
}

main().catch(err => {
  console.error('recalculate-all-teams.js failed:', err.stack || err);
  process.exit(1);
});
