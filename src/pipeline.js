'use strict';

/**
 * pipeline.js
 * Voodoo Scout — Extraction → Normalization → Storage Pipeline
 *
 * Drop-in replacement for the screenshot-only approach.
 * Call processGameJson() after extractGameData() returns a JSON file.
 *
 * Usage (from search-gamechanger-teams.js):
 *   const pipeline = require('./pipeline');
 *   pipeline.init('./voodoo-scout.db');
 *   await pipeline.processGameJson(jsonFilePath, team);
 *
 * Or process an entire team's output directory:
 *   await pipeline.processTeamOutputDir('./output/James Clemens Jets', team);
 *
 * isOpponentTeam flag:
 *   When processExtractResult is called with extractResult.isOpponentTeam=true,
 *   the normalizer flips all isOurTeam values so that the scouted team's players
 *   land in is_our_team=0 — which is what the report queries expect. Use this
 *   whenever ingesting an opponent team's own GC page. For Birmingham Stars'
 *   own live scrape, leave it unset (false).
 */

const fs         = require('fs');
const path       = require('path');
const db         = require('./db');
const { normalizeGameData } = require('./normalizer');
const { processGames }      = require('./stats-engine');

let _initialized = false;

// ─── Async bridge ─────────────────────────────────────────────────────────────
// When USE_SUPABASE=true, db functions return Promises. This helper lets the
// existing synchronous pipeline code call them without rewriting every caller.
// It runs the event loop synchronously using a shared-memory trick via
// Atomics.wait — safe in Node.js worker threads and child processes.
// On the main thread we fall back to a fire-and-forget with error logging.

function runSync(fn) {
  if (process.env.USE_SUPABASE !== 'true') {
    // SQLite path — already synchronous, just call it
    return fn();
  }
  // Supabase path — fn() returns a Promise. We need to block until it resolves.
  // Strategy: spawn the async work and use a SharedArrayBuffer + Atomics to
  // signal completion. This works because Node.js runs the microtask queue
  // while Atomics.wait is sleeping.
  //
  // Simpler alternative used here: synchronous-style wrapper using
  // child_process execFileSync is too heavy. Instead we use the
  // "deasync" pattern via a spin loop — acceptable for a scraper process
  // (not a web server).
  let result, error, done = false;
  fn().then(r => { result = r; done = true; }).catch(e => { error = e; done = true; });
  // Spin until the Promise resolves. Node's event loop processes microtasks
  // between iterations of Atomics.wait, so this works without blocking I/O.
  const sab = new SharedArrayBuffer(4);
  const arr = new Int32Array(sab);
  while (!done) {
    Atomics.wait(arr, 0, 0, 10); // sleep 10ms, then check again
  }
  if (error) throw error;
  return result;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init(dbPath = './voodoo-scout.db') {
  if (_initialized) return;
  db.init(dbPath);
  _initialized = true;
  console.log('[pipeline] Initialized. DB:', dbPath);
}

// ─── Team Registration ────────────────────────────────────────────────────────

/**
 * Ensure a team exists in the DB. Returns teamId.
 * Pass the same team object from read-teams-from-sheet.js.
 */
async function ensureTeam(team) {
  const teamId = await Promise.resolve(db.upsertTeam(team));
  console.log(`[pipeline] Team ID ${teamId}: ${team.teamName}`);
  return teamId;
}

async function getKnownCompleteGamesForTeam(teamId) {
  const getter = typeof db.getCompleteGamesByTeam === 'function'
    ? db.getCompleteGamesByTeam
    : db.getGamesByTeam;

  const games = await Promise.resolve(getter(teamId)) || [];
  return games.map((game) => ({
    id: game.id,
    gcGameId: game.gc_game_id || game.gcGameId || '',
    gcGameUrl: game.gc_game_url || game.gcGameUrl || '',
    gameDate: game.game_date || game.gameDate || null,
    opponentName: game.opponent_name || game.opponentName || '',
  }));
}

// ─── Single Game Processing ───────────────────────────────────────────────────

/**
 * Process one raw JSON file through normalization and into the DB.
 *
 * @param {string} jsonFilePath  - Path to game JSON from extractGameData()
 * @param {number} teamId        - DB team id (from ensureTeam)
 * @param {object} [options]
 * @param {boolean} [options.isOpponentTeam=false] - See module docstring
 * @returns {{ success, gameId, summary }}
 */
async function processGameJson(jsonFilePath, teamId, options = {}) {
  console.log(`\n[pipeline] Processing: ${path.basename(jsonFilePath)}`);

  if (!fs.existsSync(jsonFilePath)) {
    console.error(`[pipeline] File not found: ${jsonFilePath}`);
    return { success: false, error: 'File not found' };
  }

  let rawJson;
  try {
    rawJson = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));
  } catch (err) {
    console.error(`[pipeline] JSON parse error: ${err.message}`);
    return { success: false, error: err.message };
  }

  // Inject file path into meta for traceability
  if (rawJson.meta) {
    rawJson.meta.jsonFile = jsonFilePath;
  }

  let normalized;
  try {
    normalized = normalizeGameData(rawJson, teamId, {
      invertTeamSide: options.isOpponentTeam === true,
    });
  } catch (err) {
    console.error(`[pipeline] Normalization error: ${err.message}`);
    return { success: false, error: err.message };
  }

  console.log(`[pipeline] Normalized:`, normalized._summary);

  let result;
  try {
    result = await Promise.resolve(db.writeNormalizedGame(normalized));
  } catch (err) {
    // Duplicate game is non-fatal
    if (err.message && err.message.includes('UNIQUE constraint')) {
      console.log(`[pipeline] Game already in DB — skipping.`);
      return { success: true, skipped: true };
    }
    console.error(`[pipeline] DB write error: ${err.message}`);
    return { success: false, error: err.message };
  }

  console.log(`[pipeline] Saved game ${result.gameId}: ${result.batters} batters, ${result.pitchers} pitchers, ${result.plays} plays`);

  // Keep advanced stats season-level, not last-game-level.
  // processTeamOutputDir disables this and recalculates once at the end.
  if (options.recalculateStats !== false) {
    try {
      await recalculateTeamStats(teamId, { invertTeamSide: options.isOpponentTeam === true });
    } catch (err) {
      console.warn(`[pipeline] Advanced stats recalculation error: ${err.message}`);
    }
  }

  return {
    success: true,
    gameId:  result.gameId,
    summary: result,
  };
}

// ─── Batch: Entire Team Directory ─────────────────────────────────────────────

/**
 * Scan an output directory for all game JSON files and process them.
 * Skips files that have already been processed (idempotent).
 *
 * @param {string} teamOutputDir  - e.g. "./output/James Clemens Jets"
 * @param {object} team           - Team object from sheet reader
 * @param {object} [options]
 * @param {boolean} [options.isOpponentTeam=false] - See module docstring
 * @returns {{ processed, skipped, failed }}
 */
async function processTeamOutputDir(teamOutputDir, team, options = {}) {
  if (!fs.existsSync(teamOutputDir)) {
    throw new Error(`Team output directory not found: ${teamOutputDir}`);
  }

  const teamId = await ensureTeam(team);

  const jsonFiles = fs.readdirSync(teamOutputDir)
    .filter(f => f.endsWith('.json') && f.startsWith('game-') && f !== 'processed-games.json')
    .map(f => path.join(teamOutputDir, f));

  console.log(`\n[pipeline] Found ${jsonFiles.length} game JSON file(s) in ${teamOutputDir}`);

  const stats = { processed: 0, skipped: 0, failed: 0 };

  for (const jsonFile of jsonFiles) {
    const result = await processGameJson(jsonFile, teamId, {
      ...options,
      recalculateStats: false,
    });
    if (result.success && result.skipped) stats.skipped++;
    else if (result.success)              stats.processed++;
    else                                  stats.failed++;
  }

  if (stats.processed > 0 || options.forceRecalculateStats === true) {
    try {
      await recalculateTeamStats(teamId, { invertTeamSide: options.isOpponentTeam === true });
    } catch (err) {
      console.warn(`[pipeline] Advanced stats recalculation error: ${err.message}`);
    }
  }

  console.log(`\n[pipeline] Team complete: ${JSON.stringify(stats)}`);
  return stats;
}

// ─── Batch: Entire Output Directory ──────────────────────────────────────────

/**
 * Walk the entire output/ directory and process all teams.
 * Useful for initial bulk import.
 *
 * @param {string} outputDir     - e.g. "./output"
 * @param {object[]} teams       - Array from getTeamsFromGoogleSheet()
 * @param {object} [options]
 * @param {boolean} [options.isOpponentTeam=false] - See module docstring
 */
async function processAllOutputDirs(outputDir, teams, options = {}) {
  const teamsByName = new Map(
    teams.map(t => [
      String(t.teamName || t.rawTeamName || '').toLowerCase().trim(),
      t
    ])
  );

  const teamDirs = fs.readdirSync(outputDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_'))
    .map(d => d.name);

  console.log(`\n[pipeline] Found ${teamDirs.length} team directory(s) in ${outputDir}`);

  const totals = { processed: 0, skipped: 0, failed: 0, unmatched: 0 };

  for (const dirName of teamDirs) {
    const matchKey = dirName.toLowerCase().trim();
    const team = teamsByName.get(matchKey)
      || [...teamsByName.values()].find(t =>
          matchKey.includes(String(t.teamName || '').toLowerCase().trim().slice(0, 10))
        );

    if (!team) {
      console.warn(`[pipeline] No team record for directory: ${dirName}`);
      totals.unmatched++;
      continue;
    }

    const dirPath = path.join(outputDir, dirName);
    const stats = await processTeamOutputDir(dirPath, team, options);
    totals.processed += stats.processed;
    totals.skipped   += stats.skipped;
    totals.failed    += stats.failed;
  }

  console.log(`\n[pipeline] All done:`, totals);
  return totals;
}

// ─── Inline Hook for Playwright Scraper ──────────────────────────────────────

/**
 * Call this directly from search-gamechanger-teams.js after extractGameData()
 * returns. No need to go through the filesystem — pass the in-memory result.
 *
 * @param {object} extractResult  - Return value of extractGameData()
 * @param {number} teamId         - DB team id
 *
 * Set extractResult.isOpponentTeam = true when the scrape is for an opponent
 * team's own GC page (reingest path). Leave unset/false for Birmingham Stars'
 * own live scrape so that is_our_team flags are preserved as-is.
 */
async function processExtractResult(extractResult, teamId) {
  if (!extractResult || !extractResult.success) {
    console.warn('[pipeline] Extraction result was not successful — skipping DB write.');
    return { success: false };
  }

  if (!extractResult.gameData) {
    console.warn('[pipeline] No gameData in extract result — skipping DB write.');
    return { success: false };
  }

  const invertTeamSide = extractResult.isOpponentTeam === true;

  let normalized;
  try {
    normalized = normalizeGameData(extractResult.gameData, teamId, { invertTeamSide });
  } catch (err) {
    console.error(`[pipeline] Normalization error: ${err.message}`);
    return { success: false, error: err.message };
  }

  console.log(`[pipeline] Normalized:`, normalized._summary);

  let gameId = null;
  try {
    const result = await Promise.resolve(db.writeNormalizedGame(normalized));
    gameId = result.gameId;
    console.log(`[pipeline] Saved game ${gameId}`);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint')) {
      console.log('[pipeline] Game already in DB — running stats update anyway.');
    } else {
      console.error(`[pipeline] DB write error: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ── Recalculate full-season advanced stats ────────────────────────────────
  // Do NOT upsert advanced stats from only this single game. That creates a
  // last-game-wins bug where swing decisions, spray charts, GB/FB rates, and
  // player advanced rows disappear whenever the latest processed game has
  // incomplete play-by-play. Rebuild from every stored game instead.
  try {
    await recalculateTeamStats(teamId, { invertTeamSide });
  } catch (err) {
    // Non-fatal — log and continue
    console.warn(`[pipeline] Advanced stats recalculation error: ${err.message}`);
  }

  return { success: true, gameId, summary: normalized._summary };
}

/**
 * Run the stats engine on all game JSONs for a team and upsert advanced stats.
 * Called after each game is processed so stats stay current.
 *
 * @param {boolean} invertTeamSide - If true, swap our/opponent buckets before writing.
 */
async function _updateAdvancedStats(teamId, singleGameData, invertTeamSide = false) {
  if (!singleGameData) return;

  const statsResult = processGames([singleGameData]);

  const writes = [];

  if (invertTeamSide) {
    // Scouted opponent team: their players are in statsResult.players (ourSide in
    // the raw JSON), but we need to store them as is_our_team=0.
    // Their opponents (other teams they faced) go into is_our_team=1 — which is
    // meaningless for scouting but keeps the flag consistent with the batting_lines table.
    for (const [name, stats] of Object.entries(statsResult.players || {})) {
      writes.push(Promise.resolve(db.upsertPlayerAdvancedStats(teamId, name, 0, stats)));
    }
    for (const [name, stats] of Object.entries(statsResult.opponentBatters || {})) {
      writes.push(Promise.resolve(db.upsertPlayerAdvancedStats(teamId, name, 1, stats)));
    }
    for (const [name, stats] of Object.entries(statsResult.ourPitchers || {})) {
      writes.push(Promise.resolve(db.upsertPitcherAdvancedStats(teamId, name, 0, stats)));
    }
    for (const [name, stats] of Object.entries(statsResult.pitchers || {})) {
      writes.push(Promise.resolve(db.upsertPitcherAdvancedStats(teamId, name, 1, stats)));
    }
  } else {
    // Normal path: Birmingham Stars' own games
    for (const [name, stats] of Object.entries(statsResult.players || {})) {
      writes.push(Promise.resolve(db.upsertPlayerAdvancedStats(teamId, name, 1, stats)));
    }
    for (const [name, stats] of Object.entries(statsResult.opponentBatters || {})) {
      writes.push(Promise.resolve(db.upsertPlayerAdvancedStats(teamId, name, 0, stats)));
    }
    for (const [name, stats] of Object.entries(statsResult.ourPitchers || {})) {
      writes.push(Promise.resolve(db.upsertPitcherAdvancedStats(teamId, name, 1, stats)));
    }
    for (const [name, stats] of Object.entries(statsResult.pitchers || {})) {
      writes.push(Promise.resolve(db.upsertPitcherAdvancedStats(teamId, name, 0, stats)));
    }
  }

  await Promise.all(writes);

  const playerCount  = Object.keys(statsResult.players || {}).length;
  const pitcherCount = Object.keys(statsResult.pitchers || {}).length;
  console.log(`[pipeline] Advanced stats: ${playerCount} our batters, ${pitcherCount} opp pitchers updated${invertTeamSide ? ' (inverted)' : ''}`);
}

// ─── Full Team Stats Recalculation ───────────────────────────────────────────

/**
 * Read ALL game JSON files for a team and recalculate advanced stats
 * from scratch across all games together. This gives accurate aggregates
 * instead of the last-game-wins problem from single-game upserts.
 *
 * Call this after bulk ingest or whenever stats look wrong.
 *
 * @param {number} teamId
 * @param {object} [options]
 * @param {boolean} [options.invertTeamSide=false] - See module docstring
 */
async function recalculateTeamStats(teamId, options = {}) {
  const invertTeamSide = options.invertTeamSide === true;

  let allGameData;

  if (process.env.USE_SUPABASE === 'true') {
    // Supabase-native: reconstruct game objects directly from
    // batting_lines/pitching_lines.raw_json + play_events, with no
    // dependency on local JSON files ever having existed on disk (or on
    // whichever machine originally ran the scrape). See
    // db-supabase.js:getGameDataForStatsEngine for how this is assembled.
    allGameData = await Promise.resolve(db.getGameDataForStatsEngine(teamId));
  } else {
    // SQLite/local-dev fallback: local game JSON files by stored path.
    const d  = db.getDb();
    const fs = require('fs');
    const games = d.prepare(
      "SELECT json_file, gc_game_id FROM games WHERE team_id = ? AND json_file IS NOT NULL ORDER BY game_date"
    ).all(teamId);

    allGameData = [];
    for (const game of games) {
      if (!game.json_file || !fs.existsSync(game.json_file)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(game.json_file, 'utf8'));
        allGameData.push(raw);
      } catch (e) {
        console.warn(`[pipeline] Could not read ${game.json_file}: ${e.message}`);
      }
    }
  }

  if (!allGameData.length) {
    console.warn(`[pipeline] recalculateTeamStats: no game data found for team ${teamId}`);
    return;
  }

  console.log(`[pipeline] Recalculating stats from ${allGameData.length} game(s) for team ${teamId}${invertTeamSide ? ' (inverted)' : ''}...`);

  // ── Diagnostic logging ──────────────────────────────────────────────────
  // Temporary instrumentation to pin down a real/synthetic-test discrepancy:
  // a hand-built single-game test proves processGames() classifies isOurTeam
  // correctly, but production output doesn't match. Log the actual shape of
  // what got fetched for the first few games so we can see where it diverges.
  for (const g of allGameData.slice(0, 3)) {
    const bat = g.boxScore?.batting || [];
    const pit = g.boxScore?.pitching || [];
    const trueBat = bat.filter(b => b.isOurTeam === true).length;
    const falseBat = bat.filter(b => b.isOurTeam === false).length;
    console.log(`[pipeline][diag] game ${g.meta?.gameId}: batting=${bat.length} (isOurTeam true=${trueBat} false=${falseBat}), pitching=${pit.length}, plays=${(g.plays || []).length}`);
    if (bat.length) {
      console.log(`[pipeline][diag]   sample batting row:`, JSON.stringify(bat[0]));
    }
  }
  console.log(`[pipeline][diag] total games with 0 batting rows: ${allGameData.filter(g => !(g.boxScore?.batting || []).length).length} / ${allGameData.length}`);
  console.log(`[pipeline][diag] total games with 0 plays: ${allGameData.filter(g => !(g.plays || []).length).length} / ${allGameData.length}`);
  // ── End diagnostic logging ──────────────────────────────────────────────

  const statsResult = processGames(allGameData);

  if (statsResult.unattributedErrors && (statsResult.unattributedErrors.ourSide || statsResult.unattributedErrors.opponentSide)) {
    console.log(`[pipeline] Unattributed errors (no name in play text, or name didn't match a roster): our side ${statsResult.unattributedErrors.ourSide}, opponent side ${statsResult.unattributedErrors.opponentSide}`);
  }

  // Persist unattributed error counts on the team row so report.js can
  // surface a transparency note in the Fielding Summary — these are errors
  // whose fielder couldn't be matched to a named roster player, not errors
  // to silently drop.
  const ue = statsResult.unattributedErrors || { ourSide: 0, opponentSide: 0 };
  if (process.env.USE_SUPABASE === 'true') {
    await Promise.resolve(db.getDb().from('teams').update({
      unattributed_errors_our_side: ue.ourSide || 0,
      unattributed_errors_opponent_side: ue.opponentSide || 0,
    }).eq('id', teamId).then(r => r));
  } else {
    db.getDb().prepare(
      "UPDATE teams SET unattributed_errors_our_side = ?, unattributed_errors_opponent_side = ? WHERE id = ?"
    ).run(ue.ourSide || 0, ue.opponentSide || 0, teamId);
  }

  // Wipe existing advanced stats for this team and rewrite from scratch
  if (process.env.USE_SUPABASE === 'true') {
    await Promise.resolve(db.getDb().from('player_advanced_stats').delete().eq('team_id', teamId).then(r => r));
    await Promise.resolve(db.getDb().from('pitcher_advanced_stats').delete().eq('team_id', teamId).then(r => r));
  } else {
    const d = db.getDb();
    d.prepare("DELETE FROM player_advanced_stats WHERE team_id = ?").run(teamId);
    d.prepare("DELETE FROM pitcher_advanced_stats WHERE team_id = ?").run(teamId);
  }

  const writes = [];

  if (invertTeamSide) {
    for (const [name, stats] of Object.entries(statsResult.players || {})) {
      writes.push(Promise.resolve(db.upsertPlayerAdvancedStats(teamId, name, 0, stats)));
    }
    for (const [name, stats] of Object.entries(statsResult.opponentBatters || {})) {
      writes.push(Promise.resolve(db.upsertPlayerAdvancedStats(teamId, name, 1, stats)));
    }
    for (const [name, stats] of Object.entries(statsResult.ourPitchers || {})) {
      writes.push(Promise.resolve(db.upsertPitcherAdvancedStats(teamId, name, 0, stats)));
    }
    for (const [name, stats] of Object.entries(statsResult.pitchers || {})) {
      writes.push(Promise.resolve(db.upsertPitcherAdvancedStats(teamId, name, 1, stats)));
    }
  } else {
    for (const [name, stats] of Object.entries(statsResult.players || {})) {
      writes.push(Promise.resolve(db.upsertPlayerAdvancedStats(teamId, name, 1, stats)));
    }
    for (const [name, stats] of Object.entries(statsResult.opponentBatters || {})) {
      writes.push(Promise.resolve(db.upsertPlayerAdvancedStats(teamId, name, 0, stats)));
    }
    for (const [name, stats] of Object.entries(statsResult.ourPitchers || {})) {
      writes.push(Promise.resolve(db.upsertPitcherAdvancedStats(teamId, name, 1, stats)));
    }
    for (const [name, stats] of Object.entries(statsResult.pitchers || {})) {
      writes.push(Promise.resolve(db.upsertPitcherAdvancedStats(teamId, name, 0, stats)));
    }
  }

  await Promise.all(writes);

  console.log(`[pipeline] Stats recalculated: ${Object.keys(statsResult.players || {}).length} our batters, ${Object.keys(statsResult.opponentBatters || {}).length} opp batters, ${Object.keys(statsResult.ourPitchers || {}).length} our pitchers, ${Object.keys(statsResult.pitchers || {}).length} opp pitchers`);
}

// ─── Analysis Data Retrieval ──────────────────────────────────────────────────

/**
 * Get everything the AI layer needs for a team.
 * Returns a rich JSON bundle ready to feed into Claude.
 */
async function getTeamBundle(teamId) {
  const bundle = await Promise.resolve(db.getTeamAnalysisBundle(teamId)) || {};

  // Report convention: the scouted team is stored as is_our_team=0.
  // Do not overwrite this with is_our_team=1, or opponent players will appear
  // as the scouted team after an inverted/reingested opponent scrape.
  const [
    playerAdvanced0,
    playerAdvanced1,
    pitcherAdvanced0,
    pitcherAdvanced1,
  ] = await Promise.all([
    Promise.resolve(db.getPlayerAdvancedStats(teamId, 0)),
    Promise.resolve(db.getPlayerAdvancedStats(teamId, 1)),
    Promise.resolve(db.getPitcherAdvancedStats(teamId, 0)),
    Promise.resolve(db.getPitcherAdvancedStats(teamId, 1)),
  ]);

  // Report convention: the scouted team should be is_our_team=false.
  // Fallback only protects legacy rows that were written before the side
  // convention was stabilized. The normal path must remain side 0.
  const p0 = Array.isArray(playerAdvanced0) ? playerAdvanced0 : [];
  const p1 = Array.isArray(playerAdvanced1) ? playerAdvanced1 : [];
  const r0 = Array.isArray(pitcherAdvanced0) ? pitcherAdvanced0 : [];
  const r1 = Array.isArray(pitcherAdvanced1) ? pitcherAdvanced1 : [];

  const useLegacySide1ForBatters = p0.length === 0 && p1.length > 0;
  const useLegacySide1ForPitchers = r0.length === 0 && r1.length > 0;

  if (useLegacySide1ForBatters) {
    console.warn('[pipeline] No is_our_team=false player advanced rows found; using legacy is_our_team=true rows as fallback. Run recalculateTeamStats(..., { invertTeamSide: true }) to repair permanently.');
  }
  if (useLegacySide1ForPitchers) {
    console.warn('[pipeline] No is_our_team=false pitcher advanced rows found; using legacy is_our_team=true rows as fallback. Run recalculateTeamStats(..., { invertTeamSide: true }) to repair permanently.');
  }

  bundle.playerAdvanced  = useLegacySide1ForBatters ? p1 : p0;
  bundle.opponentBatters = useLegacySide1ForBatters ? p0 : p1;
  bundle.ourPitchers     = useLegacySide1ForPitchers ? r1 : r0;
  bundle.oppPitchers     = useLegacySide1ForPitchers ? r0 : r1;

  // Parse swing_decisions JSON for each player
  for (const p of [...bundle.playerAdvanced, ...bundle.opponentBatters]) {
    if (p.swing_decisions) {
      try {
        p.swingDecisions = JSON.parse(p.swing_decisions);
      } catch {
        p.swingDecisions = null;
      }
    }
  }

  return bundle;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  init,
  ensureTeam,
  getKnownCompleteGamesForTeam,
  processGameJson,
  processTeamOutputDir,
  processAllOutputDirs,
  processExtractResult,   // ← primary hook for Playwright inline use
  getTeamBundle,
  recalculateTeamStats,
};