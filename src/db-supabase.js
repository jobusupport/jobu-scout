'use strict';

/**
 * db-supabase.js
 * JoBu Scout — Supabase Database Layer
 *
 * Drop-in async replacement for db.js.
 * Mirrors every exported function from db.js but uses Supabase Postgres.
 *
 * Activated when USE_SUPABASE=true in environment.
 * Loaded transparently by db.js — callers don't change.
 *
 * All functions are async and return Promises.
 * pipeline.js wraps calls with runSync() so existing sync callers still work.
 */

const { createClient } = require('@supabase/supabase-js');

let _supabase = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  if (_supabase) return _supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment.');
  }

  _supabase = createClient(url, key);
  console.log('[db-supabase] Supabase client initialized.');
  return _supabase;
}

async function verifyConnection() {
  const sb = init();
  const { error } = await sb
    .from('teams')
    .select('id', { count: 'exact', head: true });

  if (error) {
    console.error('[db-supabase] Connection check failed:', error.message);
    throw error;
  }

  console.log('[db-supabase] Connected to Supabase');
  return true;
}

function getDb() {
  if (!_supabase) throw new Error('Supabase not initialized. Call db.init() first.');
  return _supabase;
}

// ─── Error helper ─────────────────────────────────────────────────────────────

function check(error, context) {
  if (error) {
    // Surface duplicate key errors the same way SQLite does so pipeline.js
    // duplicate-detection logic keeps working unchanged.
    if (error.code === '23505') {
      throw new Error(`UNIQUE constraint failed: ${context} — ${error.message}`);
    }
    throw new Error(`[db-supabase] ${context}: ${error.message}`);
  }
}

// ─── Teams ────────────────────────────────────────────────────────────────────

function normalizeTeamName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeAgeGroup(value) {
  if (!value) return null;
  const raw = String(value).trim().toUpperCase();
  const match = raw.match(/(\d{1,2})\s*U/);
  return match ? `${match[1]}U` : raw;
}

function normalizeNullable(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function inferSeasonYear(input = {}) {
  const direct = input.seasonYear || input.season_year;
  if (direct !== undefined && direct !== null && String(direct).trim() !== '') {
    const match = String(direct).match(/(20\d{2}|19\d{2})/);
    const year = match ? Number(match[1]) : Number(direct);
    if (Number.isFinite(year)) return year;
  }

  const dateCandidates = [input.gameDate, input.game_date, input.capturedAt, input.captured_at];
  for (const candidate of dateCandidates) {
    if (!candidate) continue;
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed.getFullYear();
  }

  return null;
}

function getProvidedBoolean(input, camelName, snakeName) {
  if (Object.prototype.hasOwnProperty.call(input, camelName)) return Boolean(input[camelName]);
  if (Object.prototype.hasOwnProperty.call(input, snakeName)) return Boolean(input[snakeName]);
  return null;
}

async function findExistingTeam(sb, params) {
  // Primary identity: team_name + age_group + season_year.
  if (params.team_name && params.age_group && params.season_year) {
    const { data, error } = await sb
      .from('teams')
      .select('id')
      .ilike('team_name', params.team_name)
      .eq('age_group', params.age_group)
      .eq('season_year', params.season_year)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1);
    check(error, 'upsertTeam primary lookup');
    if (data?.[0]) return data[0];
  }

  // Fallback identity: team_name + age_group across seasons.
  if (params.team_name && params.age_group) {
    const { data, error } = await sb
      .from('teams')
      .select('id')
      .ilike('team_name', params.team_name)
      .eq('age_group', params.age_group)
      .order('season_year', { ascending: false })
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1);
    check(error, 'upsertTeam fallback lookup');
    if (data?.[0]) return data[0];
  }

  // Safety fallback for legacy rows/sheet imports that may not have age/year yet.
  // This is deliberately exact-name only; GC/PG URLs are season pointers, not identity keys.
  if (params.team_name && (!params.age_group || !params.season_year)) {
    const { data, error } = await sb
      .from('teams')
      .select('id')
      .ilike('team_name', params.team_name)
      .order('season_year', { ascending: false })
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1);
    check(error, 'upsertTeam legacy name lookup');
    if (data?.[0]) return data[0];
  }

  // Do not fuzzy-write automatically. Fuzzy matches should be reviewed before identity merge.
  return null;
}

async function upsertTeam(team) {
  const sb = getDb();

  const isOurTeam = getProvidedBoolean(team, 'isOurTeam', 'is_our_team');

  const params = {
    team_name:      normalizeTeamName(team.teamName       || team.team_name       || ''),
    raw_team_name:  normalizeNullable(team.rawTeamName    || team.raw_team_name),
    gc_search_name: normalizeNullable(team.gcSearchName   || team.gc_search_name),
    gc_team_url:    normalizeNullable(team.gcTeamUrl      || team.gc_team_url),
    pg_team_url:    normalizeNullable(team.pgTeamUrl      || team.pg_team_url),
    classification: normalizeNullable(team.classification),
    age_group:      normalizeAgeGroup(team.age            || team.age_group),
    city:           normalizeNullable(team.city),
    state:          normalizeNullable(team.state),
    season_year:    inferSeasonYear(team),
    season_type:    normalizeNullable(team.seasonType     || team.season_type),
    is_our_team:    isOurTeam,
  };

  if (!params.team_name) {
    throw new Error('upsertTeam requires teamName/team_name');
  }

  const existing = await findExistingTeam(sb, params);

  if (existing) {
    // Update — only send fields that have values. GC/PG URLs are refreshed as season pointers,
    // but they are intentionally not used as identity keys.
    const updates = { team_name: params.team_name, updated_at: new Date().toISOString() };
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && v !== undefined && k !== 'team_name') updates[k] = v;
    }

    const { error } = await sb.from('teams').update(updates).eq('id', existing.id);
    check(error, 'upsertTeam update');
    return existing.id;
  }

  // Insert new. Default target/scouted teams to false unless explicitly marked as Our Team.
  const insertPayload = {
    ...params,
    is_our_team: params.is_our_team === null ? false : params.is_our_team,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await sb.from('teams').insert(insertPayload).select('id').single();
  check(error, 'upsertTeam insert');
  return data.id;
}

async function getTeamByUrl(gcTeamUrl) {
  const { data, error } = await getDb().from('teams').select('*').eq('gc_team_url', gcTeamUrl).maybeSingle();
  check(error, 'getTeamByUrl');
  return data;
}

async function getAllTeams() {
  const { data, error } = await getDb().from('teams').select('*').order('team_name');
  check(error, 'getAllTeams');
  return data || [];
}

// ─── Games ────────────────────────────────────────────────────────────────────

async function insertGame(game) {
  const sb = getDb();

  // Dedup check
  if (game.gcGameId) {
    const { data } = await sb.from('games').select('id').eq('gc_game_id', game.gcGameId).maybeSingle();
    if (data) {
      console.log(`[db-supabase] Game already exists: ${game.gcGameId}`);
      return data.id;
    }
  }

  const { data, error } = await sb.from('games').insert({
    team_id:           game.teamId,
    gc_game_id:        game.gcGameId        || null,
    gc_game_url:       game.gcGameUrl       || null,
    game_date:         game.gameDate        || null,
    game_time:         game.gameTime        || null,
    game_datetime_raw: game.gameDatetimeRaw || null,
    result:            game.result          || null,
    score_us:          game.scoreUs         ?? null,
    score_them:        game.scoreThem       ?? null,
    opponent_name:     game.opponentName    || null,
    location:          game.location        || null,
    season_type:       game.seasonType      || null,
    json_file:         game.jsonFile        || null,
    screenshot_file:   game.screenshotFile  || null,
    captured_at:       game.capturedAt      || new Date().toISOString(),
  }).select('id').single();

  check(error, 'insertGame');
  return data.id;
}

async function updateExistingGame(gameId, game) {
  const { error } = await getDb().from('games').update({
    team_id:           game.teamId,
    gc_game_url:       game.gcGameUrl       || null,
    game_date:         game.gameDate        || null,
    game_time:         game.gameTime        || null,
    game_datetime_raw: game.gameDatetimeRaw || null,
    result:            game.result          || null,
    score_us:          game.scoreUs         ?? null,
    score_them:        game.scoreThem       ?? null,
    opponent_name:     game.opponentName    || null,
    location:          game.location        || null,
    season_type:       game.seasonType      || null,
    json_file:         game.jsonFile        || null,
    screenshot_file:   game.screenshotFile  || null,
    captured_at:       game.capturedAt      || new Date().toISOString(),
  }).eq('id', gameId);
  check(error, 'updateExistingGame');
}

async function getGamesByTeam(teamId) {
  const { data, error } = await getDb().from('games').select('*')
    .eq('team_id', teamId).order('game_date', { ascending: false });
  check(error, 'getGamesByTeam');
  return data || [];
}

async function getGameById(gameId) {
  const { data, error } = await getDb().from('games').select('*').eq('id', gameId).maybeSingle();
  check(error, 'getGameById');
  return data;
}

// ─── Batting Lines ────────────────────────────────────────────────────────────

async function insertBattingLines(lines, gameId) {
  if (!lines.length) return;

  const rows = lines.map(row => ({
    game_id:       gameId,
    team_id:       row.teamId,
    player_name:   row.playerName,
    batting_order: row.battingOrder  ?? null,
    is_our_team:   row.isOurTeam     ? true : false,
    team_side:     row.teamSide      || null,
    team_name_raw: row.teamNameRaw   || null,
    position:      row.position      || null,
    ab:            row.ab            ?? 0,
    r:             row.r             ?? 0,
    h:             row.h             ?? 0,
    rbi:           row.rbi           ?? 0,
    bb:            row.bb            ?? 0,
    so:            row.so            ?? 0,
    avg:           row.avg           ?? null,
    obp:           row.obp           ?? null,
    slg:           row.slg           ?? null,
    doubles:       row.doubles       ?? 0,
    triples:       row.triples       ?? 0,
    hr:            row.hr            ?? 0,
    sb:            row.sb            ?? 0,
    hbp:           row.hbp           ?? 0,
    sac:           row.sac           ?? 0,
    lob:           row.lob           ?? 0,
    raw_json:      row.rawJson       ? JSON.stringify(row.rawJson) : null,
  }));

  const { error } = await getDb().from('batting_lines').insert(rows);
  check(error, 'insertBattingLines');
  console.log(`[db-supabase] Inserted ${rows.length} batting line(s) for game ${gameId}`);
}

// ─── Pitching Lines ───────────────────────────────────────────────────────────

async function insertPitchingLines(lines, gameId) {
  if (!lines.length) return;

  const rows = lines.map(row => ({
    game_id:       gameId,
    team_id:       row.teamId,
    player_name:   row.playerName,
    is_our_team:   row.isOurTeam     ? true : false,
    team_side:     row.teamSide      || null,
    team_name_raw: row.teamNameRaw   || null,
    ip:            row.ip            || null,
    ip_decimal:    row.ipDecimal     ?? null,
    bf:            row.bf            ?? 0,
    pc:            row.pc            ?? 0,
    strikes:       row.strikes       ?? 0,
    h_allowed:     row.hAllowed      ?? 0,
    r_allowed:     row.rAllowed      ?? 0,
    er:            row.er            ?? 0,
    bb:            row.bb            ?? 0,
    so:            row.so            ?? 0,
    hr_allowed:    row.hrAllowed     ?? 0,
    era:           row.era           ?? null,
    whip:          row.whip          ?? null,
    raw_json:      row.rawJson       ? JSON.stringify(row.rawJson) : null,
  }));

  const { error } = await getDb().from('pitching_lines').insert(rows);
  check(error, 'insertPitchingLines');
  console.log(`[db-supabase] Inserted ${rows.length} pitching line(s) for game ${gameId}`);
}

// ─── Play Events ──────────────────────────────────────────────────────────────

async function insertPlayEvents(events, gameId) {
  if (!events.length) return;

  const rows = events.map(row => ({
    game_id:        gameId,
    team_id:        row.teamId,
    sequence_num:   row.sequenceNum   ?? null,
    inning:         row.inning        || null,
    inning_num:     row.inningNum     ?? null,
    inning_half:    row.inningHalf    || null,
    event_type:     row.eventType     || null,
    batter_name:    row.batterName    || null,
    pitcher_name:   row.pitcherName   || null,
    description:    row.description   || null,
    runners_on:     row.runnersOn     || null,
    outs_before:    row.outsBefore    ?? null,
    result_rbi:     row.resultRbi     ?? 0,
    is_scoring_play: row.isScoringPlay ? true : false,
  }));

  const { error } = await getDb().from('play_events').insert(rows);
  check(error, 'insertPlayEvents');
  console.log(`[db-supabase] Inserted ${rows.length} play event(s) for game ${gameId}`);
}

// ─── Clear game detail rows (for reingest replace) ───────────────────────────

async function clearGameDetailRows(gameId) {
  const sb = getDb();
  await sb.from('batting_lines').delete().eq('game_id', gameId);
  await sb.from('pitching_lines').delete().eq('game_id', gameId);
  await sb.from('play_events').delete().eq('game_id', gameId);
}

// ─── Full Atomic Game Write ───────────────────────────────────────────────────

async function writeNormalizedGame(normalized) {
  const { game, battingLines, pitchingLines, playEvents } = normalized;

  // Check for existing game
  let existing = null;
  if (game.gcGameId) {
    const { data } = await getDb().from('games').select('id').eq('gc_game_id', game.gcGameId).maybeSingle();
    existing = data;
  }

  const gameId = existing ? existing.id : await insertGame(game);

  if (existing) {
    await updateExistingGame(gameId, game);
    await clearGameDetailRows(gameId);
  }

  const patchedBatting  = battingLines.map(r  => ({ ...r, gameId }));
  const patchedPitching = pitchingLines.map(r => ({ ...r, gameId }));
  const patchedPlays    = playEvents.map(r    => ({ ...r, gameId }));

  if (patchedBatting.length)  await insertBattingLines(patchedBatting, gameId);
  if (patchedPitching.length) await insertPitchingLines(patchedPitching, gameId);
  if (patchedPlays.length)    await insertPlayEvents(patchedPlays, gameId);

  return {
    gameId,
    replaced: Boolean(existing),
    batters:  patchedBatting.length,
    pitchers: patchedPitching.length,
    plays:    patchedPlays.length,
  };
}

// ─── Query Helpers ────────────────────────────────────────────────────────────

async function getTeamBattingAggregates(teamId) {
  const { data, error } = await getDb().rpc('get_team_batting_aggregates', { p_team_id: teamId });
  check(error, 'getTeamBattingAggregates');
  return data || [];
}

async function getTeamPitchingAggregates(teamId) {
  const { data, error } = await getDb().rpc('get_team_pitching_aggregates', { p_team_id: teamId });
  check(error, 'getTeamPitchingAggregates');
  return data || [];
}

async function getRecentPitchingLines(teamId) {
  const { data, error } = await getDb().rpc('get_recent_pitching_lines', { p_team_id: teamId });
  check(error, 'getRecentPitchingLines');
  return data || [];
}

async function getTeamJerseyMap(teamId) {
  const { data, error } = await getDb()
    .from('batting_lines')
    .select('player_name, raw_json')
    .eq('team_id', teamId)
    .eq('is_our_team', false);
  check(error, 'getTeamJerseyMap batting');

  const map = {};
  for (const row of (data || [])) {
    if (!row.player_name || map[row.player_name]) continue;
    const jersey = extractJerseyFromRaw(row.raw_json);
    if (jersey) map[row.player_name] = jersey;
  }

  // Also check pitching lines for jersey numbers
  const { data: pData } = await getDb()
    .from('pitching_lines')
    .select('player_name, raw_json')
    .eq('team_id', teamId)
    .eq('is_our_team', false);

  for (const row of (pData || [])) {
    if (!row.player_name || map[row.player_name]) continue;
    const jersey = extractJerseyFromRaw(row.raw_json);
    if (jersey) map[row.player_name] = jersey;
  }

  return map;
}

function extractJerseyFromRaw(rawJson) {
  if (!rawJson) return null;
  try {
    const raw = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
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

async function getTeamPlayTendencies(teamId) {
  const { data, error } = await getDb().rpc('get_team_play_tendencies', { p_team_id: teamId });
  check(error, 'getTeamPlayTendencies');
  return data || [];
}

async function getTeamGameResults(teamId) {
  const { data, error } = await getDb().from('games')
    .select('id, game_date, opponent_name, result, score_us, score_them, gc_game_url')
    .eq('team_id', teamId)
    .order('game_date', { ascending: false });
  check(error, 'getTeamGameResults');
  return data || [];
}

async function getActiveRosterPlayers(teamId, lastNGames = 10, minAppearances = 1) {
  const { data, error } = await getDb().rpc('get_active_roster_players', {
    p_team_id:        teamId,
    p_last_n_games:   lastNGames,
    p_min_appearances: minAppearances,
  });
  check(error, 'getActiveRosterPlayers');

  const players = new Set((data || []).map(r => r.player_name));
  return {
    players,
    gameCount: data?.[0]?.game_count ?? 0,
    totalGamesWindow: lastNGames,
  };
}

async function getTeamAnalysisBundle(teamId) {
  const sb = getDb();

  const [
    teamRes, games, batting, pitching, tendencies,
    recentPitchingLines, jerseyMap, activeRoster,
    scoutedBattersAdv, facedBattersAdv, scoutedPitchersAdv, facedPitchersAdv,
  ] = await Promise.all([
    sb.from('teams').select('*').eq('id', teamId).maybeSingle(),
    getTeamGameResults(teamId),
    getTeamBattingAggregates(teamId),
    getTeamPitchingAggregates(teamId),
    getTeamPlayTendencies(teamId),
    getRecentPitchingLines(teamId),
    getTeamJerseyMap(teamId),
    getActiveRosterPlayers(teamId, 10, 1),
    getPlayerAdvancedStats(teamId, 0),
    getPlayerAdvancedStats(teamId, 1),
    getPitcherAdvancedStats(teamId, 0),
    getPitcherAdvancedStats(teamId, 1),
  ]);

  return {
    team:               teamRes.data,
    games,
    batting,
    pitching,
    tendencies,
    recentPitchingLines,
    jerseyMap,
    activeRoster,
    playerAdvanced:     scoutedBattersAdv,
    ourPitchers:        scoutedPitchersAdv,
    oppPitchers:        facedPitchersAdv,
    opponentBatters:    facedBattersAdv,
    meta: {
      gamesAnalyzed: games.length,
      generatedAt:   new Date().toISOString(),
    },
  };
}

// ─── Advanced Stats ───────────────────────────────────────────────────────────

async function upsertPlayerAdvancedStats(teamId, playerName, isOurTeam, stats) {
  const s  = stats;
  const sd = s.swingDecisions ? JSON.stringify(s.swingDecisions) : null;

  const { error } = await getDb().from('player_advanced_stats').upsert({
    team_id:     teamId,
    player_name: playerName,
    is_our_team: isOurTeam ? true : false,
    games:         s.games        ?? 0,
    total_pitches: s.totalPitches ?? 0,
    gb: s.GB ?? 0, fb: s.FB ?? 0, ld: s.LD ?? 0,
    batted_balls: (s.GB ?? 0) + (s.FB ?? 0) + (s.LD ?? 0),
    gb_pct: s.GB_pct ?? null, fb_pct: s.FB_pct ?? null, ld_pct: s.LD_pct ?? null,
    spray_lf: s.spray?.LF ?? 0,  spray_cf: s.spray?.CF ?? 0,
    spray_rf: s.spray?.RF ?? 0,  spray_3b: s.spray?.['3B'] ?? 0,
    spray_ss: s.spray?.SS ?? 0,  spray_2b: s.spray?.['2B'] ?? 0,
    spray_1b: s.spray?.['1B'] ?? 0, spray_pc: s.spray?.P ?? 0,
    spray_lf_pct: s.sprayPct?.LF ?? null,  spray_cf_pct: s.sprayPct?.CF ?? null,
    spray_rf_pct: s.sprayPct?.RF ?? null,  spray_3b_pct: s.sprayPct?.['3B'] ?? null,
    spray_ss_pct: s.sprayPct?.SS ?? null,  spray_2b_pct: s.sprayPct?.['2B'] ?? null,
    spray_1b_pct: s.sprayPct?.['1B'] ?? null, spray_pc_pct: s.sprayPct?.P ?? null,
    risp_ab: s.RISP_AB ?? 0, risp_h: s.RISP_H ?? 0, ba_risp: s.BA_RISP ?? null,
    swing_decisions: sd,
    k_pct: s.K_pct ?? null, bb_pct: s.BB_pct ?? null,
  }, { onConflict: 'team_id,player_name,is_our_team' });

  check(error, 'upsertPlayerAdvancedStats');
}

async function upsertPitcherAdvancedStats(teamId, playerName, isOurTeam, stats) {
  const s = stats;

  const { error } = await getDb().from('pitcher_advanced_stats').upsert({
    team_id:      teamId,
    player_name:  playerName,
    is_our_team:  isOurTeam ? true : false,
    games:        s.games        ?? 0,
    total_pitches: s.totalPitches ?? 0,
    strikes:      s.strikes      ?? 0,
    s_pct:        s.S_pct        ?? null,
    gb: s.GB ?? 0, fb: s.FB ?? 0, ld: s.LD ?? 0,
    gb_pct: s.GB_pct ?? null, fb_pct: s.FB_pct ?? null, ld_pct: s.LD_pct ?? null,
    go_ao:    s.GO_AO    ?? null,
    so_per7:  s.SO_per7  ?? null, bb_per7:   s.BB_per7   ?? null,
    k_pct_bf: s.K_pct_BF ?? null, bb_pct_bf: s.BB_pct_BF ?? null,
    p_per_ip: s.P_per_IP ?? null,
    wp: s.WP ?? 0, bk: s.BK ?? 0, pik: s.PIK ?? 0,
  }, { onConflict: 'team_id,player_name,is_our_team' });

  check(error, 'upsertPitcherAdvancedStats');
}

async function getPlayerAdvancedStats(teamId, isOurTeam = null) {
  let q = getDb().from('player_advanced_stats').select('*').eq('team_id', teamId);
  if (isOurTeam !== null) q = q.eq('is_our_team', isOurTeam ? true : false);
  const { data, error } = await q.order('player_name');
  check(error, 'getPlayerAdvancedStats');
  return data || [];
}

async function getPitcherAdvancedStats(teamId, isOurTeam = null) {
  let q = getDb().from('pitcher_advanced_stats').select('*').eq('team_id', teamId);
  if (isOurTeam !== null) q = q.eq('is_our_team', isOurTeam ? true : false);
  const { data, error } = await q.order('player_name');
  check(error, 'getPitcherAdvancedStats');
  return data || [];
}

// ─── Scouting Reports ─────────────────────────────────────────────────────────

async function insertScoutingReport(report) {
  const { data, error } = await getDb().from('scouting_reports').insert({
    team_id:         report.teamId,
    report_type:     report.reportType     || 'full_scout',
    games_covered:   JSON.stringify(report.gamesCovered || []),
    file_path:       report.filePath       || null,
    file_format:     report.fileFormat     || 'pdf',
    recipient_email: report.recipientEmail || null,
  }).select('id').single();

  check(error, 'insertScoutingReport');
  return data.id;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  init,
  verifyConnection,
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