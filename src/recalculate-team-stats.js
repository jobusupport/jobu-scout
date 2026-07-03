'use strict';

/**
 * recalculate-team-stats.js
 *
 * Rebuilds player_advanced_stats and pitcher_advanced_stats from the stored
 * GameChanger game data in Supabase. Run this after fixing play_events or after
 * deploying stats-engine/parser changes.
 *
 * Usage:
 *   USE_SUPABASE=true node src/recalculate-team-stats.js "6-4-3 DP 14U Jags"
 *   USE_SUPABASE=true GAME_INVERT_TEAM_SIDE=true node src/recalculate-team-stats.js "Team Name"
 */

require('dotenv').config();
const path = require('path');
const db = require('./db');
const pipeline = require('./pipeline');

const DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, '..', 'voodoo-scout.db');

function normalize(value) {
  return String(value || '').toLowerCase().trim();
}

async function findTeam(nameOrId) {
  const teams = await Promise.resolve(db.getAllTeams());
  const q = normalize(nameOrId);

  const byId = teams.find(t => normalize(t.id) === q);
  if (byId) return byId;

  const exact = teams.filter(t => normalize(t.team_name) === q || normalize(t.raw_team_name) === q);
  if (exact.length === 1) return exact[0];

  const partial = teams.filter(t => normalize(t.team_name).includes(q) || normalize(t.raw_team_name).includes(q));
  if (partial.length === 1) return partial[0];

  if (partial.length > 1) {
    console.log(`Multiple teams match "${nameOrId}":`);
    for (const t of partial) console.log(`  [${t.id}] ${t.team_name}`);
    throw new Error('Be more specific or use the team ID.');
  }

  throw new Error(`No team matched: ${nameOrId}`);
}

async function main() {
  const arg = process.argv.slice(2).join(' ').trim();
  if (!arg) throw new Error('Usage: node src/recalculate-team-stats.js "Team Name or ID"');

  pipeline.init(DB_PATH);
  const team = await findTeam(arg);
  const invertTeamSide = process.env.GAME_INVERT_TEAM_SIDE === 'true';

  console.log(`[recalc] Team: ${team.team_name} (${team.id})`);
  console.log(`[recalc] invertTeamSide=${invertTeamSide}`);

  await pipeline.recalculateTeamStats(team.id, { invertTeamSide });

  const bundle = await pipeline.getTeamBundle(team.id);
  console.log(`[recalc] Scouted batters advanced: ${(bundle.playerAdvanced || []).length}`);
  console.log(`[recalc] Scouted pitchers advanced: ${(bundle.ourPitchers || []).length}`);
  console.log('[recalc] Done. Now regenerate the report.');
}

main().catch(err => {
  console.error('[recalc] Failed:', err.stack || err.message || err);
  process.exit(1);
});
