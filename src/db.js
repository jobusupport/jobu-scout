'use strict';

/**
 * db.js
 * Voodoo Scout — SQLite Database Layer
 *
 * Wraps better-sqlite3 with typed insert/query methods.
 * All writes use prepared statements and run inside transactions.
 *
 * Usage:
 *   const db = require('./db');
 *   db.init('./voodoo-scout.db');
 *   const teamId = db.upsertTeam({ teamName: 'James Clemens Jets', ... });
 *   db.insertGame(normalizedGame, teamId);
 */

const fs   = require('fs');
const path = require('path');

let _db = null;  // module-level singleton

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * Initialize the database. Runs migrations, returns db instance.
 * Call once at app startup.
 */
function init(dbPath = './voodoo-scout.db') {
  // ── Supabase switch ──────────────────────────────────────────────────────
  // When USE_SUPABASE=true, transparently delegate everything to db-supabase.js.
  // All callers (pipeline.js, reingest-games.js, etc.) stay completely unchanged.
  if (process.env.USE_SUPABASE === 'true') {
    const sbDb = require('./db-supabase');
    sbDb.init();
    // Replace every export on this module with the async Supabase version.
    // pipeline.js will call these via runSync() which handles the Promise.
    Object.assign(module.exports, sbDb);
    return sbDb.getDb();
  }
  // ────────────────────────────────────────────────────────────────────────

  if (_db) return _db;

  const Database = require('better-sqlite3');
  _db = new Database(dbPath, { verbose: null });

  // Performance pragmas
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');

  // Run base schema migration
  const migrationPath = path.join(__dirname, '..', 'migrations', '001_initial_schema.sql');
  if (fs.existsSync(migrationPath)) {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    _db.exec(sql);
  }

  // Also run 002 if it exists as a separate file
  const migration002 = path.join(__dirname, '..', 'migrations', '002_advanced_stats.sql');
  if (fs.existsSync(migration002)) {
    _db.exec(fs.readFileSync(migration002, 'utf8'));
  }

  // Always ensure advanced stats tables exist (inline fallback)
  _db.exec(`
    CREATE TABLE IF NOT EXISTS player_advanced_stats (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id          INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      player_name      TEXT    NOT NULL,
      is_our_team      INTEGER NOT NULL DEFAULT 1,
      generated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      games            INTEGER,
      total_pitches    INTEGER,
      gb INTEGER, fb INTEGER, ld INTEGER, batted_balls INTEGER,
      gb_pct REAL, fb_pct REAL, ld_pct REAL,
      spray_lf INTEGER, spray_cf INTEGER, spray_rf INTEGER,
      spray_3b INTEGER, spray_ss INTEGER, spray_2b INTEGER,
      spray_1b INTEGER, spray_pc INTEGER,
      spray_lf_pct REAL, spray_cf_pct REAL, spray_rf_pct REAL,
      spray_3b_pct REAL, spray_ss_pct REAL, spray_2b_pct REAL,
      spray_1b_pct REAL, spray_pc_pct REAL,
      risp_ab INTEGER, risp_h INTEGER, ba_risp REAL,
      swing_decisions TEXT,
      k_pct REAL, bb_pct REAL,
      UNIQUE (team_id, player_name, is_our_team)
    );
    CREATE TABLE IF NOT EXISTS pitcher_advanced_stats (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id          INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      player_name      TEXT    NOT NULL,
      is_our_team      INTEGER NOT NULL DEFAULT 1,
      generated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      games INTEGER, total_pitches INTEGER, strikes INTEGER,
      s_pct REAL, gb INTEGER, fb INTEGER, ld INTEGER,
      gb_pct REAL, fb_pct REAL, ld_pct REAL, go_ao REAL,
      so_per7 REAL, bb_per7 REAL, k_pct_bf REAL, bb_pct_bf REAL,
      p_per_ip REAL, wp INTEGER, bk INTEGER, pik INTEGER,
      UNIQUE (team_id, player_name, is_our_team)
    );
    CREATE INDEX IF NOT EXISTS idx_player_adv_team  ON player_advanced_stats(team_id);
    CREATE INDEX IF NOT EXISTS idx_pitcher_adv_team ON pitcher_advanced_stats(team_id);
  `);

  console.log('[db] Schema initialized.');

  return _db;
}

function getDb() {
  if (!_db) throw new Error('Database not initialized. Call db.init() first.');
  return _db;
}

// ─── Teams ────────────────────────────────────────────────────────────────────

/**
 * Insert or update a team. Returns the team's DB id.
 */
function upsertTeam(team) {
  const db = getDb();

  const params = {
    teamName:       team.teamName       || team.team_name       || '',
    rawTeamName:    team.rawTeamName    || team.raw_team_name   || null,
    gcSearchName:   team.gcSearchName   || team.gc_search_name  || null,
    gcTeamUrl:      team.gcTeamUrl      || team.gc_team_url     || null,
    pgTeamUrl:      team.pgTeamUrl      || team.pg_team_url     || null,
    classification: team.classification || null,
    ageGroup:       team.age            || team.age_group       || null,
    city:           team.city           || null,
    state:          team.state          || null,
    seasonYear:     team.seasonYear     || team.season_year     || null,
    seasonType:     team.seasonType     || team.season_type     || null,
  };

  // Look up existing team by GC URL first, then by name
  let existing = null;
  if (params.gcTeamUrl) {
    existing = db.prepare(`SELECT id FROM teams WHERE gc_team_url = ?`).get(params.gcTeamUrl);
  }
  if (!existing && params.teamName) {
    existing = db.prepare(
      `SELECT id FROM teams WHERE LOWER(TRIM(team_name)) = LOWER(TRIM(?))`
    ).get(params.teamName);
  }

  if (existing) {
    // Update existing record
    db.prepare(`
      UPDATE teams SET
        team_name      = @teamName,
        raw_team_name  = @rawTeamName,
        gc_search_name = @gcSearchName,
        gc_team_url    = COALESCE(@gcTeamUrl, gc_team_url),
        pg_team_url    = COALESCE(@pgTeamUrl, pg_team_url),
        classification = COALESCE(@classification, classification),
        age_group      = COALESCE(@ageGroup, age_group),
        city           = COALESCE(@city, city),
        state          = COALESCE(@state, state),
        season_year    = COALESCE(@seasonYear, season_year),
        season_type    = COALESCE(@seasonType, season_type),
        updated_at     = datetime('now')
      WHERE id = @id
    `).run({ ...params, id: existing.id });
    return existing.id;
  }

  // Insert new record
  const info = db.prepare(`
    INSERT INTO teams (
      team_name, raw_team_name, gc_search_name, gc_team_url, pg_team_url,
      classification, age_group, city, state, season_year, season_type, updated_at
    ) VALUES (
      @teamName, @rawTeamName, @gcSearchName, @gcTeamUrl, @pgTeamUrl,
      @classification, @ageGroup, @city, @state, @seasonYear, @seasonType,
      datetime('now')
    )
  `).run(params);
  return info.lastInsertRowid;
}

function getTeamByUrl(gcTeamUrl) {
  return getDb().prepare(`SELECT * FROM teams WHERE gc_team_url = ?`).get(gcTeamUrl);
}

function getAllTeams() {
  return getDb().prepare(`SELECT * FROM teams ORDER BY team_name`).all();
}

// ─── Games ────────────────────────────────────────────────────────────────────

/**
 * Insert a normalized game record. Returns the new game id.
 * Skips insert if gc_game_id already exists (idempotent).
 */
function insertGame(game) {
  const db = getDb();

  // Check duplicate
  if (game.gcGameId) {
    const existing = db.prepare(
      `SELECT id FROM games WHERE gc_game_id = ?`
    ).get(game.gcGameId);
    if (existing) {
      console.log(`[db] Game already exists: ${game.gcGameId}`);
      return existing.id;
    }
  }

  const stmt = db.prepare(`
    INSERT INTO games (
      team_id, gc_game_id, gc_game_url,
      game_date, game_time, game_datetime_raw,
      result, score_us, score_them, opponent_name,
      location, season_type, json_file, screenshot_file, captured_at
    ) VALUES (
      @teamId, @gcGameId, @gcGameUrl,
      @gameDate, @gameTime, @gameDatetimeRaw,
      @result, @scoreUs, @scoreThem, @opponentName,
      @location, @seasonType, @jsonFile, @screenshotFile, @capturedAt
    )
  `);

  const info = stmt.run({
    teamId:          game.teamId,
    gcGameId:        game.gcGameId        || null,
    gcGameUrl:       game.gcGameUrl       || null,
    gameDate:        game.gameDate        || null,
    gameTime:        game.gameTime        || null,
    gameDatetimeRaw: game.gameDatetimeRaw || null,
    result:          game.result          || null,
    scoreUs:         game.scoreUs         ?? null,
    scoreThem:       game.scoreThem       ?? null,
    opponentName:    game.opponentName    || null,
    location:        game.location        || null,
    seasonType:      game.seasonType      || null,
    jsonFile:        game.jsonFile        || null,
    screenshotFile:  game.screenshotFile  || null,
    capturedAt:      game.capturedAt      || new Date().toISOString(),
  });

  return info.lastInsertRowid;
}

function getGamesByTeam(teamId) {
  return getDb().prepare(
    `SELECT * FROM games WHERE team_id = ? ORDER BY game_date DESC`
  ).all(teamId);
}

function getGameById(gameId) {
  return getDb().prepare(`SELECT * FROM games WHERE id = ?`).get(gameId);
}

// ─── Batting Lines ────────────────────────────────────────────────────────────

function insertBattingLines(lines, gameId) {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT INTO batting_lines (
      game_id, team_id, player_name, batting_order, is_our_team, team_side, team_name_raw, position,
      ab, r, h, rbi, bb, so, avg, obp, slg,
      doubles, triples, hr, sb, hbp, sac, lob, raw_json
    ) VALUES (
      @gameId, @teamId, @playerName, @battingOrder, @isOurTeam, @teamSide, @teamNameRaw, @position,
      @ab, @r, @h, @rbi, @bb, @so, @avg, @obp, @slg,
      @doubles, @triples, @hr, @sb, @hbp, @sac, @lob, @rawJson
    )
  `);

  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      stmt.run({ ...row, gameId });
    }
  });

  insertMany(lines);
  console.log(`[db] Inserted ${lines.length} batting line(s) for game ${gameId}`);
}

// ─── Pitching Lines ───────────────────────────────────────────────────────────

function insertPitchingLines(lines, gameId) {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT INTO pitching_lines (
      game_id, team_id, player_name, is_our_team, team_side, team_name_raw,
      ip, ip_decimal, bf, pc, strikes,
      h_allowed, r_allowed, er, bb, so, hr_allowed,
      era, whip, raw_json
    ) VALUES (
      @gameId, @teamId, @playerName, @isOurTeam, @teamSide, @teamNameRaw,
      @ip, @ipDecimal, @bf, @pc, @strikes,
      @hAllowed, @rAllowed, @er, @bb, @so, @hrAllowed,
      @era, @whip, @rawJson
    )
  `);

  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      stmt.run({ ...row, gameId });
    }
  });

  insertMany(lines);
  console.log(`[db] Inserted ${lines.length} pitching line(s) for game ${gameId}`);
}

// ─── Play Events ──────────────────────────────────────────────────────────────

function insertPlayEvents(events, gameId) {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT INTO play_events (
      game_id, team_id, sequence_num,
      inning, inning_num, inning_half,
      event_type, batter_name, pitcher_name,
      description, runners_on, outs_before,
      result_rbi, is_scoring_play
    ) VALUES (
      @gameId, @teamId, @sequenceNum,
      @inning, @inningNum, @inningHalf,
      @eventType, @batterName, @pitcherName,
      @description, @runnersOn, @outsBefore,
      @resultRbi, @isScoringPlay
    )
  `);

  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      stmt.run({ ...row, gameId });
    }
  });

  insertMany(events);
  console.log(`[db] Inserted ${events.length} play event(s) for game ${gameId}`);
}

// ─── Full Game Write (Atomic) ─────────────────────────────────────────────────

/**
 * Write a fully normalized game (from normalizer.js) to the DB atomically.
 * Returns { gameId, batters, pitchers, plays }
 */
function clearGameDetailRows(gameId) {
  const db = getDb();
  db.prepare('DELETE FROM batting_lines WHERE game_id = ?').run(gameId);
  db.prepare('DELETE FROM pitching_lines WHERE game_id = ?').run(gameId);
  db.prepare('DELETE FROM play_events WHERE game_id = ?').run(gameId);
}

function updateExistingGame(gameId, game) {
  getDb().prepare(`
    UPDATE games SET
      team_id = @teamId,
      gc_game_url = @gcGameUrl,
      game_date = @gameDate,
      game_time = @gameTime,
      game_datetime_raw = @gameDatetimeRaw,
      result = @result,
      score_us = @scoreUs,
      score_them = @scoreThem,
      opponent_name = @opponentName,
      location = @location,
      season_type = @seasonType,
      json_file = @jsonFile,
      screenshot_file = @screenshotFile,
      captured_at = @capturedAt
    WHERE id = @gameId
  `).run({
    gameId,
    teamId:          game.teamId,
    gcGameUrl:       game.gcGameUrl       || null,
    gameDate:        game.gameDate        || null,
    gameTime:        game.gameTime        || null,
    gameDatetimeRaw: game.gameDatetimeRaw || null,
    result:          game.result          || null,
    scoreUs:         game.scoreUs         ?? null,
    scoreThem:       game.scoreThem       ?? null,
    opponentName:    game.opponentName    || null,
    location:        game.location        || null,
    seasonType:      game.seasonType      || null,
    jsonFile:        game.jsonFile        || null,
    screenshotFile:  game.screenshotFile  || null,
    capturedAt:      game.capturedAt      || new Date().toISOString(),
  });
}

function writeNormalizedGame(normalized) {
  const db = getDb();

  return db.transaction(() => {
    const { game, battingLines, pitchingLines, playEvents } = normalized;

    let existing = null;
    if (game.gcGameId) {
      existing = db.prepare('SELECT id FROM games WHERE gc_game_id = ?').get(game.gcGameId);
    }

    const gameId = existing ? existing.id : insertGame(game);

    // Re-ingest must be replace-not-append. Without this, running a side-fix or
    // reingest can leave both old and corrected rows under the same game.
    if (existing) {
      updateExistingGame(gameId, game);
      clearGameDetailRows(gameId);
    }

    // Patch gameId into related rows
    const patchedBatting  = battingLines.map(r  => ({ ...r,  gameId }));
    const patchedPitching = pitchingLines.map(r => ({ ...r, gameId }));
    const patchedPlays    = playEvents.map(r    => ({ ...r,  gameId }));

    if (patchedBatting.length)  insertBattingLines(patchedBatting, gameId);
    if (patchedPitching.length) insertPitchingLines(patchedPitching, gameId);
    if (patchedPlays.length)    insertPlayEvents(patchedPlays, gameId);

    return {
      gameId,
      replaced: Boolean(existing),
      batters:  patchedBatting.length,
      pitchers: patchedPitching.length,
      plays:    patchedPlays.length,
    };
  })();
}

// ─── Query Helpers (for AI analysis layer) ───────────────────────────────────

/**
 * Aggregate batting stats for a team across all stored games.
 * Returns one row per player, summed.
 */
function getTeamBattingAggregates(teamId) {
  return getDb().prepare(`
    SELECT
      0                         AS is_our_team,
      player_name,
      COUNT(DISTINCT game_id)  AS games,
      COALESCE(SUM(ab), 0)      AS total_ab,
      COALESCE(SUM(h), 0)       AS total_h,
      COALESCE(SUM(r), 0)       AS total_r,
      COALESCE(SUM(rbi), 0)     AS total_rbi,
      COALESCE(SUM(bb), 0)      AS total_bb,
      COALESCE(SUM(so), 0)      AS total_so,
      COALESCE(SUM(doubles), 0) AS total_2b,
      COALESCE(SUM(triples), 0) AS total_3b,
      COALESCE(SUM(hr), 0)      AS total_hr,
      COALESCE(SUM(sb), 0)      AS total_sb,
      COALESCE(SUM(hbp), 0)     AS total_hbp,
      COALESCE(SUM(sac), 0)     AS total_sac,
      ROUND(
        CAST(COALESCE(SUM(h), 0) AS REAL) / NULLIF(COALESCE(SUM(ab), 0), 0), 3
      )                        AS batting_avg,
      ROUND(
        CAST(COALESCE(SUM(h), 0) + COALESCE(SUM(bb), 0) + COALESCE(SUM(hbp), 0) AS REAL)
        / NULLIF(COALESCE(SUM(ab), 0) + COALESCE(SUM(bb), 0) + COALESCE(SUM(hbp), 0) + COALESCE(SUM(sac), 0), 0), 3
      )                        AS obp,
      ROUND(
        CAST(
          (COALESCE(SUM(h), 0) - COALESCE(SUM(doubles), 0) - COALESCE(SUM(triples), 0) - COALESCE(SUM(hr), 0))
          + (2 * COALESCE(SUM(doubles), 0))
          + (3 * COALESCE(SUM(triples), 0))
          + (4 * COALESCE(SUM(hr), 0))
        AS REAL) / NULLIF(COALESCE(SUM(ab), 0), 0), 3
      )                        AS slg
    FROM batting_lines
    WHERE team_id = ?
      AND is_our_team = 0
    GROUP BY player_name
    ORDER BY total_ab DESC
  `).all(teamId);
}
/**
 * Aggregate pitching stats for a team across all stored games.
 */
function getTeamPitchingAggregates(teamId) {
  return getDb().prepare(`
    SELECT
      0                                AS is_our_team,
      player_name,
      COUNT(DISTINCT game_id)          AS games,
      SUM(ip_decimal)                  AS total_ip,
      SUM(bf)                          AS total_bf,
      SUM(pc)                          AS total_pitches,
      SUM(h_allowed)                   AS total_h,
      SUM(r_allowed)                   AS total_r,
      SUM(er)                          AS total_er,
      SUM(bb)                          AS total_bb,
      SUM(so)                          AS total_so,
      ROUND(
        CAST(SUM(so) AS REAL) / NULLIF(SUM(bb), 0), 2
      )                                AS k_bb_ratio,
      ROUND(
        9.0 * SUM(er) / NULLIF(SUM(ip_decimal), 0), 2
      )                                AS era,
      ROUND(
        (CAST(SUM(bb) AS REAL) + SUM(h_allowed))
        / NULLIF(SUM(ip_decimal), 0), 3
      )                                AS whip,
      ROUND(
        CAST(SUM(pc) AS REAL) / NULLIF(SUM(ip_decimal), 0), 1
      )                                AS pitches_per_ip
    FROM pitching_lines
    WHERE team_id = ?
      AND is_our_team = 0
    GROUP BY player_name
    ORDER BY total_ip DESC
  `).all(teamId);
}

function getRecentPitchingLines(teamId) {
  return getDb().prepare(`
    SELECT
      p.player_name,
      p.is_our_team,
      p.team_side,
      p.team_name_raw,
      p.ip,
      p.ip_decimal,
      p.bf,
      p.pc AS pitch_count,
      p.strikes,
      g.game_date,
      g.game_time,
      g.game_datetime_raw,
      g.opponent_name,
      g.gc_game_id
    FROM pitching_lines p
    JOIN games g ON g.id = p.game_id
    WHERE p.team_id = ?
      AND p.is_our_team = 0
      AND g.game_date IS NOT NULL
    ORDER BY g.game_date DESC, p.player_name
  `).all(teamId);
}

/**
 * Returns players who appeared (batted OR pitched) for the scouted team
 * in at least MIN_APPEARANCES of the last LAST_N games.
 * Used to filter the report to "likely active roster" players.
 */
function getActiveRosterPlayers(teamId, lastNGames = 10, minAppearances = 1) {
  const db = getDb();

  // Get the IDs of the last N games for this team
  const recentGameIds = db.prepare(`
    SELECT DISTINCT g.id
    FROM games g
    WHERE g.id IN (
      SELECT DISTINCT bl.game_id FROM batting_lines bl
      WHERE bl.team_id = ? AND bl.is_our_team = 0
      UNION
      SELECT DISTINCT pl.game_id FROM pitching_lines pl
      WHERE pl.team_id = ? AND pl.is_our_team = 0
    )
    AND g.game_date IS NOT NULL
    ORDER BY g.game_date DESC
    LIMIT ?
  `).all(teamId, teamId, lastNGames).map(r => r.id);

  if (!recentGameIds.length) return { players: new Set(), gameCount: 0 };

  const placeholders = recentGameIds.map(() => '?').join(',');

  // Count appearances per player across batting + pitching lines
  const rows = db.prepare(`
    SELECT player_name, COUNT(DISTINCT game_id) AS app_count
    FROM (
      SELECT player_name, game_id FROM batting_lines
      WHERE team_id = ? AND is_our_team = 0 AND game_id IN (${placeholders})
      UNION ALL
      SELECT player_name, game_id FROM pitching_lines
      WHERE team_id = ? AND is_our_team = 0 AND game_id IN (${placeholders})
    )
    GROUP BY player_name
    HAVING COUNT(DISTINCT game_id) >= ?
  `).all(teamId, ...recentGameIds, teamId, ...recentGameIds, minAppearances);

  return {
    players: new Set(rows.map(r => r.player_name)),
    gameCount: recentGameIds.length,
    totalGamesWindow: lastNGames,
  };
}

function extractJerseyFromRaw(rawJson) {
  if (!rawJson) return null;

  try {
    const raw = JSON.parse(rawJson);
    const direct = raw.Jersey || raw.jersey || raw.Number || raw.number;
    if (direct !== undefined && direct !== null && String(direct).trim() !== '') {
      return String(direct).replace(/^#/, '').trim();
    }

    const info = raw.PlayerInfo || raw.playerInfo || '';
    const m = String(info).match(/#\s*([A-Za-z0-9-]+)/);
    if (m) return m[1].trim();
  } catch {}

  const m = String(rawJson).match(/#\s*([A-Za-z0-9-]+)/);
  return m ? m[1].trim() : null;
}

function getTeamJerseyMap(teamId) {
  const rows = getDb().prepare(`
    SELECT player_name, raw_json
    FROM batting_lines
    WHERE team_id = ? AND is_our_team = 0
    UNION ALL
    SELECT player_name, raw_json
    FROM pitching_lines
    WHERE team_id = ? AND is_our_team = 0
  `).all(teamId, teamId);

  const map = {};
  for (const row of rows) {
    if (!row.player_name || map[row.player_name]) continue;
    const jersey = extractJerseyFromRaw(row.raw_json);
    if (jersey) map[row.player_name] = jersey;
  }
  return map;
}

/**
 * Get play-by-play tendencies: event type distribution for a team.
 */
function getTeamPlayTendencies(teamId) {
  return getDb().prepare(`
    SELECT
      event_type,
      COUNT(*)                           AS count,
      ROUND(
        100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1
      )                                  AS pct
    FROM play_events
    WHERE team_id = ?
      AND event_type != 'unknown'
      AND event_type != 'end_inning'
    GROUP BY event_type
    ORDER BY count DESC
  `).all(teamId);
}

/**
 * Get all game results for a team (for win/loss context in AI prompts).
 */
function getTeamGameResults(teamId) {
  return getDb().prepare(`
    SELECT
      id, game_date, opponent_name,
      result, score_us, score_them,
      gc_game_url
    FROM games
    WHERE team_id = ?
    ORDER BY game_date DESC
  `).all(teamId);
}

/**
 * Build a full context bundle for AI analysis — one query per team.
 * Returns everything the AI layer needs as a single object.
 */
function getTeamAnalysisBundle(teamId) {
  const team      = getDb().prepare(`SELECT * FROM teams WHERE id = ?`).get(teamId);
  const games     = getTeamGameResults(teamId);
  const batting   = getTeamBattingAggregates(teamId);
  const pitching  = getTeamPitchingAggregates(teamId);
  const tendencies = getTeamPlayTendencies(teamId);
  const recentPitchingLines = getRecentPitchingLines(teamId);
  const jerseyMap = getTeamJerseyMap(teamId);
  const activeRoster = getActiveRosterPlayers(teamId, 10, 1);

  // Report convention: when scouting an opponent team's own GC page, that
  // scouted team's players are stored as is_our_team=0. The teams they faced
  // are stored as is_our_team=1.
  const scoutedBattersAdv = getPlayerAdvancedStats(teamId, 0);
  const facedBattersAdv   = getPlayerAdvancedStats(teamId, 1);
  const scoutedPitchersAdv = getPitcherAdvancedStats(teamId, 0);
  const facedPitchersAdv   = getPitcherAdvancedStats(teamId, 1);

  return {
    team,
    games,
    batting,    // scouted team batters only (is_our_team=0)
    pitching,   // scouted team pitchers only (is_our_team=0)
    tendencies,
    recentPitchingLines,
    jerseyMap,
    activeRoster,     // { players: Set<string>, gameCount, totalGamesWindow }
    playerAdvanced:  scoutedBattersAdv,  // advanced batting for scouted team
    ourPitchers:     scoutedPitchersAdv, // advanced pitching for scouted team
    oppPitchers:     facedPitchersAdv,   // pitchers from teams the scouted team faced
    opponentBatters: facedBattersAdv,    // alias used by report.js oppBatMap
    meta: {
      gamesAnalyzed: games.length,
      generatedAt:   new Date().toISOString(),
    }
  };
}

// ─── Scouting Reports ─────────────────────────────────────────────────────────

function insertScoutingReport(report) {
  const stmt = getDb().prepare(`
    INSERT INTO scouting_reports (
      team_id, report_type, games_covered,
      file_path, file_format, recipient_email
    ) VALUES (
      @teamId, @reportType, @gamesCovered,
      @filePath, @fileFormat, @recipientEmail
    )
  `);

  const info = stmt.run({
    teamId:         report.teamId,
    reportType:     report.reportType     || 'full_scout',
    gamesCovered:   JSON.stringify(report.gamesCovered || []),
    filePath:       report.filePath       || null,
    fileFormat:     report.fileFormat     || 'pdf',
    recipientEmail: report.recipientEmail || null,
  });

  return info.lastInsertRowid;
}


// ─── Advanced Stats ───────────────────────────────────────────────────────────

/**
 * Upsert player advanced stats (from stats-engine).
 * One row per team+player+side — updates on re-run.
 */
function upsertPlayerAdvancedStats(teamId, playerName, isOurTeam, stats) {
  const db = getDb();
  const s  = stats;

  const sd = s.swingDecisions ? JSON.stringify(s.swingDecisions) : null;

  db.prepare(`
    INSERT INTO player_advanced_stats (
      team_id, player_name, is_our_team,
      games, total_pitches,
      gb, fb, ld, batted_balls, gb_pct, fb_pct, ld_pct,
      spray_lf, spray_cf, spray_rf, spray_3b, spray_ss, spray_2b, spray_1b, spray_pc,
      spray_lf_pct, spray_cf_pct, spray_rf_pct, spray_3b_pct,
      spray_ss_pct, spray_2b_pct, spray_1b_pct, spray_pc_pct,
      risp_ab, risp_h, ba_risp,
      swing_decisions, k_pct, bb_pct
    ) VALUES (
      @teamId, @playerName, @isOurTeam,
      @games, @totalPitches,
      @gb, @fb, @ld, @battedBalls, @gbPct, @fbPct, @ldPct,
      @sprayLf, @sprayCf, @sprayRf, @spray3b, @spraySs, @spray2b, @spray1b, @sprayPc,
      @sprayLfPct, @sprayCfPct, @sprayRfPct, @spray3bPct,
      @spraySsPct, @spray2bPct, @spray1bPct, @sprayPcPct,
      @rispAb, @rispH, @baRisp,
      @swingDecisions, @kPct, @bbPct
    )
    ON CONFLICT(team_id, player_name, is_our_team) DO UPDATE SET
      games         = excluded.games,
      total_pitches = excluded.total_pitches,
      gb = excluded.gb, fb = excluded.fb, ld = excluded.ld,
      batted_balls  = excluded.batted_balls,
      gb_pct = excluded.gb_pct, fb_pct = excluded.fb_pct, ld_pct = excluded.ld_pct,
      spray_lf = excluded.spray_lf, spray_cf = excluded.spray_cf,
      spray_rf = excluded.spray_rf, spray_3b = excluded.spray_3b,
      spray_ss = excluded.spray_ss, spray_2b = excluded.spray_2b,
      spray_1b = excluded.spray_1b, spray_pc = excluded.spray_pc,
      spray_lf_pct = excluded.spray_lf_pct, spray_cf_pct = excluded.spray_cf_pct,
      spray_rf_pct = excluded.spray_rf_pct, spray_3b_pct = excluded.spray_3b_pct,
      spray_ss_pct = excluded.spray_ss_pct, spray_2b_pct = excluded.spray_2b_pct,
      spray_1b_pct = excluded.spray_1b_pct, spray_pc_pct = excluded.spray_pc_pct,
      risp_ab = excluded.risp_ab, risp_h = excluded.risp_h, ba_risp = excluded.ba_risp,
      swing_decisions = excluded.swing_decisions,
      k_pct = excluded.k_pct, bb_pct = excluded.bb_pct,
      generated_at = datetime('now')
  `).run({
    teamId, playerName, isOurTeam: isOurTeam ? 1 : 0,
    games:        s.games        ?? 0,
    totalPitches: s.totalPitches ?? 0,
    gb: s.GB ?? 0, fb: s.FB ?? 0, ld: s.LD ?? 0,
    battedBalls: (s.GB ?? 0) + (s.FB ?? 0) + (s.LD ?? 0),
    gbPct: s.GB_pct ?? null, fbPct: s.FB_pct ?? null, ldPct: s.LD_pct ?? null,
    sprayLf: s.spray?.LF ?? 0,  sprayCf: s.spray?.CF ?? 0,
    sprayRf: s.spray?.RF ?? 0,  spray3b: s.spray?.['3B'] ?? 0,
    spraySs: s.spray?.SS ?? 0,  spray2b: s.spray?.['2B'] ?? 0,
    spray1b: s.spray?.['1B'] ?? 0, sprayPc: s.spray?.P ?? 0,
    sprayLfPct: s.sprayPct?.LF ?? null,  sprayCfPct: s.sprayPct?.CF ?? null,
    sprayRfPct: s.sprayPct?.RF ?? null,  spray3bPct: s.sprayPct?.['3B'] ?? null,
    spraySsPct: s.sprayPct?.SS ?? null,  spray2bPct: s.sprayPct?.['2B'] ?? null,
    spray1bPct: s.sprayPct?.['1B'] ?? null, sprayPcPct: s.sprayPct?.P ?? null,
    rispAb: s.RISP_AB ?? 0, rispH: s.RISP_H ?? 0, baRisp: s.BA_RISP ?? null,
    swingDecisions: sd,
    kPct: s.K_pct ?? null, bbPct: s.BB_pct ?? null,
  });
}

function upsertPitcherAdvancedStats(teamId, playerName, isOurTeam, stats) {
  const db = getDb();
  const s  = stats;

  db.prepare(`
    INSERT INTO pitcher_advanced_stats (
      team_id, player_name, is_our_team,
      games, total_pitches, strikes, s_pct,
      gb, fb, ld, gb_pct, fb_pct, ld_pct, go_ao,
      so_per7, bb_per7, k_pct_bf, bb_pct_bf, p_per_ip,
      wp, bk, pik
    ) VALUES (
      @teamId, @playerName, @isOurTeam,
      @games, @totalPitches, @strikes, @sPct,
      @gb, @fb, @ld, @gbPct, @fbPct, @ldPct, @goAo,
      @soPer7, @bbPer7, @kPctBf, @bbPctBf, @pPerIp,
      @wp, @bk, @pik
    )
    ON CONFLICT(team_id, player_name, is_our_team) DO UPDATE SET
      games = excluded.games, total_pitches = excluded.total_pitches,
      strikes = excluded.strikes, s_pct = excluded.s_pct,
      gb = excluded.gb, fb = excluded.fb, ld = excluded.ld,
      gb_pct = excluded.gb_pct, fb_pct = excluded.fb_pct, ld_pct = excluded.ld_pct,
      go_ao = excluded.go_ao,
      so_per7 = excluded.so_per7, bb_per7 = excluded.bb_per7,
      k_pct_bf = excluded.k_pct_bf, bb_pct_bf = excluded.bb_pct_bf,
      p_per_ip = excluded.p_per_ip,
      wp = excluded.wp, bk = excluded.bk, pik = excluded.pik,
      generated_at = datetime('now')
  `).run({
    teamId, playerName, isOurTeam: isOurTeam ? 1 : 0,
    games:        s.games        ?? 0,
    totalPitches: s.totalPitches ?? 0,
    strikes:      s.strikes      ?? 0,
    sPct:    s.S_pct    ?? null,
    gb: s.GB ?? 0, fb: s.FB ?? 0, ld: s.LD ?? 0,
    gbPct: s.GB_pct ?? null, fbPct: s.FB_pct ?? null, ldPct: s.LD_pct ?? null,
    goAo:    s.GO_AO   ?? null,
    soPer7:  s.SO_per7 ?? null, bbPer7:  s.BB_per7  ?? null,
    kPctBf:  s.K_pct_BF ?? null, bbPctBf: s.BB_pct_BF ?? null,
    pPerIp:  s.P_per_IP ?? null,
    wp: s.WP ?? 0, bk: s.BK ?? 0, pik: s.PIK ?? 0,
  });
}

function getPlayerAdvancedStats(teamId, isOurTeam = null) {
  if (isOurTeam !== null && isOurTeam !== undefined) {
    return getDb().prepare(`
      SELECT * FROM player_advanced_stats
      WHERE team_id = ? AND is_our_team = ?
      ORDER BY player_name
    `).all(teamId, isOurTeam);
  }
  return getDb().prepare(`
    SELECT * FROM player_advanced_stats
    WHERE team_id = ?
    ORDER BY player_name
  `).all(teamId);
}

function getPitcherAdvancedStats(teamId, isOurTeam = null) {
  if (isOurTeam !== null && isOurTeam !== undefined) {
    return getDb().prepare(`
      SELECT * FROM pitcher_advanced_stats
      WHERE team_id = ? AND is_our_team = ?
      ORDER BY player_name
    `).all(teamId, isOurTeam);
  }
  return getDb().prepare(`
    SELECT * FROM pitcher_advanced_stats
    WHERE team_id = ?
    ORDER BY player_name
  `).all(teamId);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  init,
  getDb,
  // Teams
  upsertTeam,
  getTeamByUrl,
  getAllTeams,
  // Games
  insertGame,
  getGamesByTeam,
  getGameById,
  // Stats
  insertBattingLines,
  insertPitchingLines,
  insertPlayEvents,
  // Atomic write
  writeNormalizedGame,
  // Analysis queries
  getTeamBattingAggregates,
  getTeamPitchingAggregates,
  getRecentPitchingLines,
  getTeamJerseyMap,
  getTeamPlayTendencies,
  getTeamGameResults,
  getTeamAnalysisBundle,
  getActiveRosterPlayers,
  // Reports
  insertScoutingReport,
  // Advanced stats
  upsertPlayerAdvancedStats,
  upsertPitcherAdvancedStats,
  getPlayerAdvancedStats,
  getPitcherAdvancedStats,
};