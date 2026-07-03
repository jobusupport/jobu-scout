'use strict';

/**
 * fix-play-event-names.js
 *
 * Clears legacy corrupt play_events.batter_name values that do not match either
 * box-score roster for the same game, then recalculates advanced stats.
 *
 * Usage:
 *   USE_SUPABASE=true node src/fix-play-event-names.js "6-4-3 DP 14U Jags"
 *   USE_SUPABASE=true node src/fix-play-event-names.js 8058e65c-254a-40f0-a2e4-64833f6ff30e
 */

require('dotenv').config();
const path = require('path');
const db = require('./db');
const pipeline = require('./pipeline');

const DB_PATH = path.join(__dirname, '..', 'voodoo-scout.db');

db.init(DB_PATH);

function normalize(value) {
  return String(value || '').toLowerCase().trim();
}

function nameKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

async function findTeam(nameOrId) {
  const teams = await Promise.resolve(db.getAllTeams());
  const wanted = normalize(nameOrId);
  const byId = teams.find(t => normalize(t.id) === wanted);
  if (byId) return byId;

  const exact = teams.filter(t => normalize(t.team_name) === wanted || normalize(t.raw_team_name) === wanted);
  if (exact.length === 1) return exact[0];

  const partial = teams.filter(t => normalize(t.team_name).includes(wanted) || normalize(t.raw_team_name).includes(wanted));
  if (partial.length === 1) return partial[0];

  if (partial.length > 1) {
    console.log(`Multiple teams matched "${nameOrId}":`);
    for (const t of partial) console.log(`  [${t.id}] ${t.team_name}`);
    throw new Error('Be more specific or use the team ID.');
  }

  throw new Error(`No team matched "${nameOrId}".`);
}

async function fetchAll(makeQuery, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await makeQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    const batch = data || [];
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}

async function fixSupabase(teamId) {
  const sb = db.getDb();

  const games = await fetchAll(() => sb.from('games').select('id').eq('team_id', teamId));
  const gameIds = games.map(g => g.id);
  if (!gameIds.length) return { games: 0, scanned: 0, cleared: 0 };

  const battingRows = await fetchAll(() => sb.from('batting_lines').select('game_id, player_name').in('game_id', gameIds));
  const rosterByGame = new Map();
  for (const row of battingRows) {
    if (!rosterByGame.has(row.game_id)) rosterByGame.set(row.game_id, new Set());
    rosterByGame.get(row.game_id).add(nameKey(row.player_name));
  }

  const playRows = await fetchAll(() => sb.from('play_events').select('id, game_id, batter_name').in('game_id', gameIds));
  const toClear = playRows.filter(row => {
    const current = String(row.batter_name || '').trim();
    if (!current) return false;
    const roster = rosterByGame.get(row.game_id);
    return roster && !roster.has(nameKey(current));
  });

  for (let i = 0; i < toClear.length; i += 500) {
    const ids = toClear.slice(i, i + 500).map(r => r.id);
    const { error } = await sb.from('play_events').update({ batter_name: null }).in('id', ids);
    if (error) throw error;
  }

  return { games: gameIds.length, scanned: playRows.length, cleared: toClear.length };
}

function fixSqlite(teamId) {
  const d = db.getDb();
  const result = d.prepare(`
    update play_events
    set batter_name = null
    where game_id in (select id from games where team_id = ?)
      and batter_name is not null
      and trim(batter_name) <> ''
      and not exists (
        select 1
        from batting_lines bl
        where bl.game_id = play_events.game_id
          and lower(replace(bl.player_name, ' ', '')) = lower(replace(play_events.batter_name, ' ', ''))
      )
  `).run(teamId);
  return { cleared: result.changes };
}

async function main() {
  const nameOrId = process.argv.slice(2).join(' ').trim();
  if (!nameOrId) throw new Error('Usage: node src/fix-play-event-names.js "Team Name or ID"');

  const team = await findTeam(nameOrId);
  console.log(`[fix] Team: ${team.team_name} (${team.id})`);

  const result = process.env.USE_SUPABASE === 'true'
    ? await fixSupabase(team.id)
    : fixSqlite(team.id);

  console.log(`[fix] Cleared ${result.cleared} bad batter_name value(s).`);

  console.log('[fix] Recalculating advanced stats...');
  await pipeline.recalculateTeamStats(team.id, {
    invertTeamSide: process.env.GAME_INVERT_TEAM_SIDE === 'true',
  });
  console.log('[fix] Done. Generate the report again without --skip-recalc.');
}

main().catch(err => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
