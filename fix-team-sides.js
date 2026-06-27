'use strict';
/**
 * fix-team-sides.js
 * Voodoo Scout — One-time DB fix for is_our_team inversion
 *
 * The batting_lines, pitching_lines, player_advanced_stats, and
 * pitcher_advanced_stats tables all have is_our_team flags set from the
 * *scouted team's* perspective (their players = 1, opponents = 0).
 * The report queries expect the opposite: scouted team's players = 0.
 *
 * This script flips is_our_team for every opponent team in the DB
 * (i.e., everyone except Birmingham Stars / your own team).
 *
 * Run once from the gamechanger-scraper root:
 *   node fix-team-sides.js
 *
 * Safe to run multiple times — it will detect already-fixed teams
 * by checking if the scouted team's players are already in is_our_team=0.
 */

require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'voodoo-scout.db');
const db = new Database(DB_PATH);

// ── Config: team names that are YOUR team (Birmingham Stars variants) ─────────
// These teams should NOT be inverted — their own players stay in is_our_team=1.
const OUR_TEAM_PATTERNS = [
  'birmingham stars',
  'birmingham',
  // Add others here if needed, e.g. 'james clemens'
];

function isOurTeam(teamName) {
  const lower = (teamName || '').toLowerCase();
  return OUR_TEAM_PATTERNS.some(p => lower.includes(p));
}

// ── Main fix ──────────────────────────────────────────────────────────────────
const teams = db.prepare('SELECT id, team_name FROM teams ORDER BY id').all();

console.log(`\nFound ${teams.length} team(s) in DB\n`);

let fixed = 0;
let skipped = 0;

db.transaction(() => {
  for (const team of teams) {
    const { id: teamId, team_name: teamName } = team;

    if (isOurTeam(teamName)) {
      console.log(`[SKIP] [${teamId}] ${teamName} — this is your team, not inverting`);
      skipped++;
      continue;
    }

    // Count batting lines per side to understand current state
    const counts = db.prepare(`
      SELECT is_our_team, COUNT(*) as cnt, 
             GROUP_CONCAT(DISTINCT team_name_raw) as team_names
      FROM batting_lines 
      WHERE team_id = ?
      GROUP BY is_our_team
    `).all(teamId);

    if (!counts.length) {
      console.log(`[SKIP] [${teamId}] ${teamName} — no batting_lines`);
      skipped++;
      continue;
    }

    // Find which team_name_raw values belong to the scouted team
    // They'll be in is_our_team=1 (wrong) before the fix
    const our1 = counts.find(r => r.is_our_team === 1);
    const our0 = counts.find(r => r.is_our_team === 0);

    // Detect if already fixed: scouted team's name should be in is_our_team=0
    // after fix. We check by seeing if the team_name_raw contains the team name
    // in the is_our_team=0 bucket.
    const teamNameLower = teamName.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();
    const firstWord = teamNameLower.split(' ')[0];

    const alreadyFixed = our0 && (our0.team_names || '').toLowerCase().includes(firstWord);

    if (alreadyFixed) {
      console.log(`[OK]   [${teamId}] ${teamName} — already correct (scouted team in is_our_team=0)`);
      skipped++;
      continue;
    }

    console.log(`[FIX]  [${teamId}] ${teamName}`);
    if (our1) console.log(`       is_our_team=1 (${our1.cnt} rows): ${our1.team_names}`);
    if (our0) console.log(`       is_our_team=0 (${our0.cnt} rows): ${our0.team_names}`);

    // Flip is_our_team: use a temp value (2) to avoid UNIQUE constraint conflicts
    // batting_lines has UNIQUE(gc_game_id, team_id, player_name, is_our_team) or similar

    // Step 1: set all is_our_team=1 → 2 (temp)
    db.prepare(`UPDATE batting_lines SET is_our_team = 2 WHERE team_id = ? AND is_our_team = 1`).run(teamId);
    // Step 2: set all is_our_team=0 → 1
    db.prepare(`UPDATE batting_lines SET is_our_team = 1 WHERE team_id = ? AND is_our_team = 0`).run(teamId);
    // Step 3: set all is_our_team=2 → 0
    db.prepare(`UPDATE batting_lines SET is_our_team = 0 WHERE team_id = ? AND is_our_team = 2`).run(teamId);

    // Same for pitching_lines
    db.prepare(`UPDATE pitching_lines SET is_our_team = 2 WHERE team_id = ? AND is_our_team = 1`).run(teamId);
    db.prepare(`UPDATE pitching_lines SET is_our_team = 1 WHERE team_id = ? AND is_our_team = 0`).run(teamId);
    db.prepare(`UPDATE pitching_lines SET is_our_team = 0 WHERE team_id = ? AND is_our_team = 2`).run(teamId);

    // Same for player_advanced_stats
    db.prepare(`UPDATE player_advanced_stats SET is_our_team = 2 WHERE team_id = ? AND is_our_team = 1`).run(teamId);
    db.prepare(`UPDATE player_advanced_stats SET is_our_team = 1 WHERE team_id = ? AND is_our_team = 0`).run(teamId);
    db.prepare(`UPDATE player_advanced_stats SET is_our_team = 0 WHERE team_id = ? AND is_our_team = 2`).run(teamId);

    // Same for pitcher_advanced_stats
    db.prepare(`UPDATE pitcher_advanced_stats SET is_our_team = 2 WHERE team_id = ? AND is_our_team = 1`).run(teamId);
    db.prepare(`UPDATE pitcher_advanced_stats SET is_our_team = 1 WHERE team_id = ? AND is_our_team = 0`).run(teamId);
    db.prepare(`UPDATE pitcher_advanced_stats SET is_our_team = 0 WHERE team_id = ? AND is_our_team = 2`).run(teamId);

    // Verify after fix
    const after = db.prepare(`
      SELECT is_our_team, COUNT(*) as cnt,
             GROUP_CONCAT(DISTINCT team_name_raw) as team_names
      FROM batting_lines WHERE team_id = ? GROUP BY is_our_team
    `).all(teamId);
    for (const r of after) {
      console.log(`       → after: is_our_team=${r.is_our_team} (${r.cnt} rows): ${r.team_names}`);
    }

    fixed++;
  }
})();

console.log(`\n✓ Done. Fixed: ${fixed}  Skipped: ${skipped}`);
console.log('\nNext step: re-run your report for FS Bulldogs to verify players now appear correctly.');

db.close();