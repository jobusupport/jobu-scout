/**
 * fix-tennessee-yard-stats.js
 *
 * One-off fix: rebuilds player_advanced_stats / pitcher_advanced_stats for
 * Tennessee Yard 14U from ALL scraped games (not just the last one scraped),
 * so swing_decisions and other advanced stats reflect the full season again.
 *
 * Run from project root:
 *   node src/fix-tennessee-yard-stats.js
 *
 * Requires USE_SUPABASE=true in your environment (or .env, loaded by db.js).
 */

const path = require('path');
const db = require('./db');
const pipeline = require('./pipeline'); // safe to require before db.init() executes — db.js's exports get mutated in place when init() runs below, and pipeline.js shares that same module reference

const TEAM_ID = '6cd35c46-9996-4f83-8048-92e9f0ff9058'; // Tennessee Yard 14U

async function main() {
  // Required even in Supabase mode — init() is what delegates db.js's exports
  // over to db-supabase.js when USE_SUPABASE=true. The path arg is ignored
  // in that case, but the call itself is mandatory before any db/pipeline
  // function will work.
  db.init(path.join(__dirname, '..', 'voodoo-scout.db'));

  console.log(`[fix] Recalculating advanced stats for team ${TEAM_ID}...`);

  // invertTeamSide: false because Tennessee Yard was scraped as the scouted
  // (opponent) team — their players already land in is_our_team=0 via the
  // normal (non-inverted) path. Flip to true ONLY if this team was originally
  // ingested via an inverted scrape (check pipeline.js comments at line ~335
  // if unsure, or just compare swing_decisions output against expectations
  // after running once).
  await pipeline.recalculateTeamStats(TEAM_ID, { invertTeamSide: false });

  console.log('[fix] Done. Regenerate the report to confirm swing decisions now reflect the full season.');
}

main().catch(err => {
  console.error('[fix] Failed:', err.stack || err);
  process.exit(1);
});