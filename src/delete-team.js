'use strict';

/**
 * delete-teams.js
 * Removes teams 66 and 81 (and all cascading data) from voodoo-scout.db.
 * Run from your project root: node delete-teams.js
 */

const db = require('./db');

const TARGET_IDS = [66, 81];

db.init('./voodoo-scout.db');
const conn = db.getDb();

// Preview what we're about to delete
console.log('\n[preview] Teams to be deleted:');
const preview = conn.prepare(
  `SELECT id, team_name, gc_team_url, pg_team_url FROM teams WHERE id IN (${TARGET_IDS.join(',')})`
).all();

if (preview.length === 0) {
  console.log('  No teams found with those IDs. Nothing to do.');
  process.exit(0);
}

preview.forEach(t => {
  console.log(`  [${t.id}] ${t.team_name}`);
  console.log(`        gc: ${t.gc_team_url || '(none)'}`);
  console.log(`        pg: ${t.pg_team_url || '(none)'}`);
});

// Delete — ON DELETE CASCADE handles games, batting_lines, pitching_lines,
// play_events, player_advanced_stats, pitcher_advanced_stats, scouting_reports
const result = conn.prepare(
  `DELETE FROM teams WHERE id IN (${TARGET_IDS.join(',')})`
).run();

console.log(`\n[done] Deleted ${result.changes} team(s).\n`);