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

// ─── Org helpers ──────────────────────────────────────────────────────────────

const _teamOrgCache = new Map();
const _tableOrgColumnCache = new Map();

function isMissingColumnError(error, columnName = 'org_id') {
  if (!error) return false;
  const message = String(error.message || '').toLowerCase();
  return message.includes(`column ${columnName}`) && message.includes('does not exist');
}

async function tableHasOrgId(tableName) {
  if (_tableOrgColumnCache.has(tableName)) return _tableOrgColumnCache.get(tableName);

  const { error } = await getDb()
    .from(tableName)
    .select('org_id', { count: 'exact', head: true })
    .limit(1);

  if (isMissingColumnError(error, 'org_id')) {
    _tableOrgColumnCache.set(tableName, false);
    return false;
  }

  if (error) {
    // Do not hide permissions or other real DB issues.
    check(error, `${tableName} org_id capability check`);
  }

  _tableOrgColumnCache.set(tableName, true);
  return true;
}

async function getOrgIdForTeam(teamId) {
  const normalizedTeamId = Number(teamId);
  const cacheKey = Number.isFinite(normalizedTeamId) ? String(normalizedTeamId) : String(teamId || '');

  if (!cacheKey) throw new Error('getOrgIdForTeam requires teamId');
  if (_teamOrgCache.has(cacheKey)) return _teamOrgCache.get(cacheKey);

  const { data, error } = await getDb()
    .from('teams')
    .select('id, org_id')
    .eq('id', teamId)
    .maybeSingle();

  check(error, 'getOrgIdForTeam');

  if (!data) throw new Error(`Team ${teamId} not found while resolving org_id`);
  if (!data.org_id) throw new Error(`Team ${teamId} does not have org_id`);

  _teamOrgCache.set(cacheKey, data.org_id);
  return data.org_id;
}

async function getSingleOrgIdFallback() {
  for (const tableName of ['orgs', 'organizations']) {
    try {
      const { data, error } = await getDb().from(tableName).select('id').limit(2);
      if (isMissingColumnError(error, 'id')) continue;
      if (error) {
        const msg = String(error.message || '').toLowerCase();
        if (msg.includes('could not find the table') || msg.includes('does not exist')) continue;
        check(error, `${tableName} single-org fallback`);
      }
      if (Array.isArray(data) && data.length === 1 && data[0]?.id) return data[0].id;
    } catch (err) {
      const msg = String(err.message || '').toLowerCase();
      if (msg.includes('does not exist') || msg.includes('could not find the table')) continue;
      throw err;
    }
  }
  return null;
}

async function resolveOrgIdForTeamUpsert(team) {
  const provided = normalizeNullable(team.orgId || team.org_id);
  if (provided) return provided;
  return await getSingleOrgIdFallback();
}

async function addOrgIdIfSupported(tableName, payload, orgId) {
  if (!orgId) return payload;
  if (tableName === 'games' || await tableHasOrgId(tableName)) {
    return { org_id: orgId, ...payload };
  }
  return payload;
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

function numericOrNull(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed === '-' || trimmed.toUpperCase() === 'N/A') return null;
    const cleaned = trimmed.replace(/,/g, '').replace(/%$/, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function numericOrZero(value) {
  const n = numericOrNull(value);
  return n === null ? 0 : n;
}

function serializeRawJsonForTextColumn(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.trim() || null;
  try { return JSON.stringify(value); } catch { return String(value); }
}


function extractGcGameIdFromUrl(value) {
  const match = String(value || '').match(/\/schedule\/([^/?#]+)/i);
  return match ? match[1] : '';
}

function normalizeGcGameIdFromGame(game) {
  return normalizeNullable(game.gcGameId || game.gc_game_id) || extractGcGameIdFromUrl(game.gcGameUrl || game.gc_game_url) || null;
}

async function findExistingGameByGcIdentity(sb, orgId, game) {
  const gcGameId = normalizeGcGameIdFromGame(game);
  const gcGameUrl = normalizeNullable(game.gcGameUrl || game.gc_game_url);

  if (gcGameId) {
    const { data, error } = await sb
      .from('games')
      .select('id')
      .eq('org_id', orgId)
      .eq('gc_game_id', gcGameId)
      .maybeSingle();
    check(error, 'findExistingGameByGcIdentity gc_game_id');
    if (data) return data;
  }

  if (gcGameUrl) {
    const { data, error } = await sb
      .from('games')
      .select('id')
      .eq('org_id', orgId)
      .eq('gc_game_url', gcGameUrl)
      .maybeSingle();
    check(error, 'findExistingGameByGcIdentity gc_game_url');
    if (data) return data;
  }

  return null;
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

function applyOrgScope(query, params) {
  return params.org_id ? query.eq('org_id', params.org_id) : query;
}

async function findExistingTeam(sb, params) {
  // Primary identity: team_name + age_group + season_year.
  if (params.team_name && params.age_group && params.season_year) {
    const { data, error } = await applyOrgScope(sb
      .from('teams')
      .select('id')
      .ilike('team_name', params.team_name)
      .eq('age_group', params.age_group), params)
      .eq('season_year', params.season_year)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1);
    check(error, 'upsertTeam primary lookup');
    if (data?.[0]) return data[0];
  }

  // Fallback identity: team_name + age_group across seasons.
  if (params.team_name && params.age_group) {
    const { data, error } = await applyOrgScope(sb
      .from('teams')
      .select('id')
      .ilike('team_name', params.team_name)
      .eq('age_group', params.age_group), params)
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
    const { data, error } = await applyOrgScope(sb
      .from('teams')
      .select('id')
      .ilike('team_name', params.team_name), params)
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
  const resolvedOrgId = await resolveOrgIdForTeamUpsert(team);

  const isOurTeam = getProvidedBoolean(team, 'isOurTeam', 'is_our_team');

  const params = {
    org_id:         resolvedOrgId,
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

async function getAllTeams(includeArchived = false) {
  let q = getDb().from('teams').select('*').order('team_name');
  if (!includeArchived) q = q.eq('archived', false);
  const { data, error } = await q;
  check(error, 'getAllTeams');
  return data || [];
}

/**
 * Archive (soft-hide) or restore a team. Does not touch games, batting_lines,
 * pitching_lines, play_events, or advanced stats — all history stays intact.
 * Used when a coach stops playing an opponent but doesn't want to lose data.
 */
async function setTeamArchived(teamId, archived) {
  const { error } = await getDb()
    .from('teams')
    .update({ archived: !!archived, updated_at: new Date().toISOString() })
    .eq('id', teamId);
  check(error, 'setTeamArchived');
  return true;
}

// ─── Games ────────────────────────────────────────────────────────────────────

async function insertGame(game) {
  const sb = getDb();
  const orgId = normalizeNullable(game.orgId || game.org_id) || await getOrgIdForTeam(game.teamId);
  const ourTeamId = game.ourTeamId || game.our_team_id || game.teamId;
  const opponentId = game.opponentId || game.opponent_id || game.teamId;
  const gcGameId = normalizeGcGameIdFromGame(game);

  // Dedup check scoped to the team's org. This protects against duplicate rows
  // even when an older write had only gc_game_url or the normalized object
  // did not carry gcGameId cleanly.
  const existing = await findExistingGameByGcIdentity(sb, orgId, { ...game, gcGameId });
  if (existing) {
    console.log(`[db-supabase] Game already exists: ${gcGameId || game.gcGameUrl || existing.id}`);
    return existing.id;
  }

  const payload = {
    org_id:            orgId,
    team_id:           game.teamId,
    our_team_id:       ourTeamId,
    opponent_id:       opponentId,
    gc_game_id:        gcGameId             || null,
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
  };

  const { data, error } = await sb.from('games').insert(payload).select('id').single();

  check(error, 'insertGame');
  return data.id;
}

async function updateExistingGame(gameId, game) {
  const orgId = normalizeNullable(game.orgId || game.org_id) || await getOrgIdForTeam(game.teamId);
  const ourTeamId = game.ourTeamId || game.our_team_id || game.teamId;
  const opponentId = game.opponentId || game.opponent_id || game.teamId;
  const gcGameId = normalizeGcGameIdFromGame(game);
  const { error } = await getDb().from('games').update({
    org_id:            orgId,
    team_id:           game.teamId,
    our_team_id:       ourTeamId,
    opponent_id:       opponentId,
    gc_game_id:        gcGameId             || null,
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
  }).eq('id', gameId).eq('org_id', orgId);
  check(error, 'updateExistingGame');
}

async function getGamesByTeam(teamId) {
  const { data, error } = await getDb().from('games').select('*')
    .eq('team_id', teamId).order('game_date', { ascending: false });
  check(error, 'getGamesByTeam');
  return data || [];
}

/**
 * Reconstruct game objects in the exact shape stats-engine.js's
 * processGames() expects — { meta: { gameId }, boxScore: { batting,
 * pitching }, plays: [{ inning, text }] } — directly from Supabase, with no
 * dependency on local JSON files ever having existed on disk.
 *
 * This works because:
 *  - batting_lines/pitching_lines.raw_json stores the box score row exactly
 *    as scraped (including isOurTeam/TeamSide), so JSON.parse(raw_json)
 *    reproduces the original row verbatim.
 *  - play_events.description/.inning are the same text/inning fields
 *    normalizePlayEvent() derived from the original play.text/play.inning,
 *    so { inning, text: description } reconstructs the original plays[] shape.
 *
 * Used by pipeline.js's recalculateTeamStats() so full-season stat
 * recalculation (swing decisions, spray%, RISP, errors, etc.) works
 * regardless of which machine originally ran the scrape.
 */
async function getGameDataForStatsEngine(teamId) {
  const sb = getDb();

  const { data: games, error: gamesError } = await sb.from('games')
    .select('id, game_date, opponent_name, result, score_us, score_them, gc_game_url')
    .eq('team_id', teamId);
  check(gamesError, 'getGameDataForStatsEngine games');
  if (!games || !games.length) return [];

  const gameIds = games.map(g => g.id);

  async function fetchAllRows(makeQuery, context, pageSize = 1000) {
    const rows = [];
    let from = 0;

    while (true) {
      const to = from + pageSize - 1;
      const { data, error } = await makeQuery().range(from, to);
      check(error, context);

      const batch = data || [];
      rows.push(...batch);

      if (batch.length < pageSize) break;
      from += pageSize;
    }

    return rows;
  }

  const [battingRows, pitchingRows, playRows] = await Promise.all([
    fetchAllRows(
      () => sb.from('batting_lines')
        .select('game_id, player_name, team_name_raw, team_side, is_our_team, raw_json')
        .in('game_id', gameIds),
      'getGameDataForStatsEngine batting_lines'
    ),
    fetchAllRows(
      () => sb.from('pitching_lines')
        .select('game_id, player_name, team_name_raw, team_side, is_our_team, raw_json')
        .in('game_id', gameIds),
      'getGameDataForStatsEngine pitching_lines'
    ),
    fetchAllRows(
      () => sb.from('play_events')
        .select('game_id, inning, description, sequence_num, event_type, batter_name, pitcher_name')
        .in('game_id', gameIds),
      'getGameDataForStatsEngine play_events'
    ),
  ]);

  function parseRawJson(value) {
    if (!value) return null;

    // Older Supabase rows were written to a TEXT column as JSON.stringify(row.rawJson)
    // even though row.rawJson was already a JSON string. That produces values like:
    //   "{\"Player\":\"Smith\", ...}"
    // Parse repeatedly until we reach the actual object. This keeps old rows usable.
    let parsed = value;
    for (let i = 0; i < 3 && typeof parsed === 'string'; i++) {
      const trimmed = parsed.trim();
      if (!trimmed) return null;
      try { parsed = JSON.parse(trimmed); } catch { return null; }
    }

    return parsed && typeof parsed === 'object' ? parsed : null;
  }

  function rowForStatsEngine(row) {
    const parsed = parseRawJson(row.raw_json) || {};
    return {
      ...parsed,
      Player:     parsed.Player || parsed.Name || row.player_name,
      Name:       parsed.Name || parsed.Player || row.player_name,
      TeamName:   parsed.TeamName || parsed.teamName || row.team_name_raw || null,
      TeamSide:   parsed.TeamSide || parsed.teamSide || row.team_side || null,
      isOurTeam:  row.is_our_team === true,
    };
  }

  const battingByGame = {};
  for (const row of battingRows || []) {
    if (!battingByGame[row.game_id]) battingByGame[row.game_id] = [];
    battingByGame[row.game_id].push(rowForStatsEngine(row));
  }

  const pitchingByGame = {};
  for (const row of pitchingRows || []) {
    if (!pitchingByGame[row.game_id]) pitchingByGame[row.game_id] = [];
    pitchingByGame[row.game_id].push(rowForStatsEngine(row));
  }

  // Group plays by game, then sort each game's plays by sequence_num — do
  // NOT rely on Supabase's row order across an .in() query spanning multiple
  // games, since sequence_num resets per game and a flat order-by would
  // interleave games incorrectly.
  const playsByGame = {};
  for (const row of playRows || []) {
    if (!playsByGame[row.game_id]) playsByGame[row.game_id] = [];
    playsByGame[row.game_id].push(row);
  }
  for (const gameId of Object.keys(playsByGame)) {
    playsByGame[gameId].sort((a, b) => (a.sequence_num ?? 0) - (b.sequence_num ?? 0));
  }

  return games.map(g => ({
    meta: {
      gameId: g.id,
      gameDate: g.game_date || null,
      opponentName: g.opponent_name || null,
      result: g.result || null,
      scoreUs: g.score_us ?? null,
      scoreThem: g.score_them ?? null,
      gcGameUrl: g.gc_game_url || null,
    },
    boxScore: {
      batting:  battingByGame[g.id]  || [],
      pitching: pitchingByGame[g.id] || [],
    },
    plays: (playsByGame[g.id] || []).map(row => ({
      inning: row.inning,
      text: row.description,
      eventType: row.event_type || null,
      batterName: row.batter_name || null,
      pitcherName: row.pitcher_name || null,
    })),
  }));
}

async function getCompleteGamesByTeam(teamId) {
  const sb = getDb();

  const { data: games, error: gamesError } = await sb
    .from('games')
    .select('id, gc_game_id, gc_game_url, game_date, game_time, captured_at, opponent_name')
    .eq('team_id', teamId)
    .order('game_date', { ascending: true })
    .order('captured_at', { ascending: true });
  check(gamesError, 'getCompleteGamesByTeam games');

  if (!games || games.length === 0) return [];

  const gameIds = games.map((game) => game.id);

  const [battingRes, pitchingRes, playsRes] = await Promise.all([
    sb.from('batting_lines').select('game_id').in('game_id', gameIds),
    sb.from('pitching_lines').select('game_id').in('game_id', gameIds),
    sb.from('play_events').select('game_id').in('game_id', gameIds),
  ]);

  check(battingRes.error, 'getCompleteGamesByTeam batting_lines');
  check(pitchingRes.error, 'getCompleteGamesByTeam pitching_lines');
  check(playsRes.error, 'getCompleteGamesByTeam play_events');

  const battingGameIds = new Set((battingRes.data || []).map((row) => row.game_id));
  const pitchingGameIds = new Set((pitchingRes.data || []).map((row) => row.game_id));
  const playGameIds = new Set((playsRes.data || []).map((row) => row.game_id));

  return games
    .filter((game) => battingGameIds.has(game.id) && pitchingGameIds.has(game.id) && playGameIds.has(game.id))
    .map((game) => ({
      ...game,
      gcGameId: game.gc_game_id || '',
      gcGameUrl: game.gc_game_url || '',
    }));
}

async function getGameById(gameId) {
  const { data, error } = await getDb().from('games').select('*').eq('id', gameId).maybeSingle();
  check(error, 'getGameById');
  return data;
}

// ─── Batting Lines ────────────────────────────────────────────────────────────

async function insertBattingLines(lines, gameId) {
  if (!lines.length) return;

  const orgId = normalizeNullable(lines[0].orgId || lines[0].org_id) || await getOrgIdForTeam(lines[0].teamId);
  const includeOrgId = await tableHasOrgId('batting_lines');

  const rows = lines.map(row => {
    const payload = {
      game_id:       gameId,
      team_id:       row.teamId,
      player_name:   row.playerName,
      batting_order: numericOrNull(row.battingOrder),
      is_our_team:   row.isOurTeam     ? true : false,
      team_side:     row.teamSide      || null,
      team_name_raw: row.teamNameRaw   || null,
      position:      row.position      || null,
      ab:            numericOrZero(row.ab),
      r:             numericOrZero(row.r),
      h:             numericOrZero(row.h),
      rbi:           numericOrZero(row.rbi),
      bb:            numericOrZero(row.bb),
      so:            numericOrZero(row.so),
      avg:           numericOrNull(row.avg),
      obp:           numericOrNull(row.obp),
      slg:           numericOrNull(row.slg),
      doubles:       numericOrZero(row.doubles),
      triples:       numericOrZero(row.triples),
      hr:            numericOrZero(row.hr),
      sb:            numericOrZero(row.sb),
      hbp:           numericOrZero(row.hbp),
      sac:           numericOrZero(row.sac),
      lob:           numericOrZero(row.lob),
      raw_json:      serializeRawJsonForTextColumn(row.rawJson),
    };
    if (includeOrgId) payload.org_id = orgId;
    return payload;
  });

  const { error } = await getDb().from('batting_lines').insert(rows);
  check(error, 'insertBattingLines');
  console.log(`[db-supabase] Inserted ${rows.length} batting line(s) for game ${gameId}`);
}

// ─── Pitching Lines ───────────────────────────────────────────────────────────

async function insertPitchingLines(lines, gameId) {
  if (!lines.length) return;

  const orgId = normalizeNullable(lines[0].orgId || lines[0].org_id) || await getOrgIdForTeam(lines[0].teamId);
  const includeOrgId = await tableHasOrgId('pitching_lines');

  const rows = lines.map(row => {
    const payload = {
      game_id:       gameId,
      team_id:       row.teamId,
      player_name:   row.playerName,
      is_our_team:   row.isOurTeam     ? true : false,
      team_side:     row.teamSide      || null,
      team_name_raw: row.teamNameRaw   || null,
      ip:            row.ip            || null,
      ip_decimal:    numericOrNull(row.ipDecimal),
      bf:            numericOrZero(row.bf),
      pc:            numericOrZero(row.pc),
      strikes:       numericOrZero(row.strikes),
      h_allowed:     numericOrZero(row.hAllowed),
      r_allowed:     numericOrZero(row.rAllowed),
      er:            numericOrZero(row.er),
      bb:            numericOrZero(row.bb),
      so:            numericOrZero(row.so),
      hr_allowed:    numericOrZero(row.hrAllowed),
      era:           numericOrNull(row.era),
      whip:          numericOrNull(row.whip),
      raw_json:      serializeRawJsonForTextColumn(row.rawJson),
    };
    if (includeOrgId) payload.org_id = orgId;
    return payload;
  });

  const { error } = await getDb().from('pitching_lines').insert(rows);
  check(error, 'insertPitchingLines');
  console.log(`[db-supabase] Inserted ${rows.length} pitching line(s) for game ${gameId}`);
}

// ─── Play Events ──────────────────────────────────────────────────────────────

async function insertPlayEvents(events, gameId) {
  if (!events.length) return;

  const orgId = normalizeNullable(events[0].orgId || events[0].org_id) || await getOrgIdForTeam(events[0].teamId);
  const includeOrgId = await tableHasOrgId('play_events');

  const rows = events.map(row => {
    const payload = {
      game_id:        gameId,
      team_id:        row.teamId,
      sequence_num:   numericOrNull(row.sequenceNum),
      inning:         row.inning        || null,
      inning_num:     numericOrNull(row.inningNum),
      inning_half:    row.inningHalf    || null,
      event_type:     row.eventType     || null,
      batter_name:    row.batterName    || null,
      pitcher_name:   row.pitcherName   || null,
      description:    row.description   || null,
      runners_on:     row.runnersOn     || null,
      outs_before:    numericOrNull(row.outsBefore),
      result_rbi:     numericOrZero(row.resultRbi),
      is_scoring_play: row.isScoringPlay ? true : false,
    };
    if (includeOrgId) payload.org_id = orgId;
    return payload;
  });

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
  const orgId = normalizeNullable(game.orgId || game.org_id) || await getOrgIdForTeam(game.teamId);
  const scopedGame = { ...game, orgId };

  // Check for existing game, scoped to the team's org.
  const normalizedGcGameId = normalizeGcGameIdFromGame(scopedGame);
  if (normalizedGcGameId) scopedGame.gcGameId = normalizedGcGameId;
  const existing = await findExistingGameByGcIdentity(getDb(), orgId, scopedGame);

  const gameId = existing ? existing.id : await insertGame(scopedGame);

  if (existing) {
    await updateExistingGame(gameId, scopedGame);
    await clearGameDetailRows(gameId);
  }

  const patchedBatting  = battingLines.map(r  => ({ ...r, gameId, orgId }));
  const patchedPitching = pitchingLines.map(r => ({ ...r, gameId, orgId }));
  const patchedPlays    = playEvents.map(r    => ({ ...r, gameId, orgId }));

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

// Per-game batting_lines rows (player_name + position only) for the scouted
// team, used to build the Fielding Summary's position breakdown. Not
// aggregated like the function above — each row is one game's line, since a
// player's position can vary game to game.
async function getRawBattingLines(teamId) {
  const { data, error } = await getDb().from('batting_lines')
    .select('player_name, position')
    .eq('team_id', teamId)
    .eq('is_our_team', false);
  check(error, 'getRawBattingLines');
  return data || [];
}

async function getTeamPitchingAggregates(teamId) {
  const { data, error } = await getDb().rpc('get_team_pitching_aggregates', { p_team_id: teamId });
  check(error, 'getTeamPitchingAggregates');
  return data || [];
}

async function getRecentPitchingLines(teamId) {
  const sb = getDb();

  // Do not use the legacy RPC here. It has produced rows where every outing
  // inherits the report date / latest date, which breaks PitchSmart by making
  // a pitcher appear to throw several historical outings on the same day.
  // Pull the per-game date directly from games via the game_id relationship.
  const { data, error } = await sb
    .from('pitching_lines')
    .select(`
      id, game_id, team_id, player_name, is_our_team, team_side, team_name_raw,
      ip, ip_decimal, bf, pc, strikes, h_allowed, r_allowed, er, bb, so,
      hr_allowed, era, whip, raw_json,
      games!inner(game_date, opponent_name)
    `)
    .eq('team_id', teamId)
    .order('game_id', { ascending: false });

  check(error, 'getRecentPitchingLines direct');

  return (data || []).map(row => ({
    ...row,
    game_date: row.games?.game_date || null,
    opponent_name: row.games?.opponent_name || null,
  }));
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

async function getLatestVerifiedTeamTotals(teamId) {
  try {
    const { data, error } = await getDb()
      .from('derived_team_verified_totals')
      .select('*')
      .eq('team_id', teamId)
      .maybeSingle();

    // The migration may not exist yet on a fresh environment. Do not break
    // report generation; analyzer.js will fall back to box-score aggregates.
    if (error) {
      const msg = String(error.message || '').toLowerCase();
      if (msg.includes('does not exist') || msg.includes('could not find the table')) return null;
      check(error, 'getLatestVerifiedTeamTotals');
    }

    return data || null;
  } catch (err) {
    const msg = String(err.message || '').toLowerCase();
    if (msg.includes('does not exist') || msg.includes('could not find the table')) return null;
    throw err;
  }
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

/**
 * Empirical batting-order tendency per opponent hitter, computed from actual
 * lineup cards (batting_lines.batting_order) in the last N scouted games —
 * not an estimate. Supabase-native: no raw SQL, aggregation done in JS since
 * the row counts here are small (one team's roster x N games).
 */
async function getTeamLineupOrder(teamId, lastNGames = 10) {
  const sb = getDb();

  const { data: recentGames, error: gamesErr } = await sb
    .from('games')
    .select('id')
    .eq('team_id', teamId)
    .order('game_date', { ascending: false })
    .limit(lastNGames);
  check(gamesErr, 'getTeamLineupOrder games');

  const gameIds = (recentGames || []).map(g => g.id);
  if (!gameIds.length) return [];

  const { data: lines, error: linesErr } = await sb
    .from('batting_lines')
    .select('player_name, batting_order')
    .eq('team_id', teamId)
    .eq('is_our_team', false)
    .in('game_id', gameIds)
    .not('batting_order', 'is', null)
    .gt('batting_order', 0);
  check(linesErr, 'getTeamLineupOrder batting_lines');

  const byPlayer = {};
  for (const row of (lines || [])) {
    if (!row.player_name) continue;
    if (!byPlayer[row.player_name]) byPlayer[row.player_name] = { orders: [], starts: 0 };
    byPlayer[row.player_name].orders.push(row.batting_order);
    byPlayer[row.player_name].starts++;
  }

  const result = Object.entries(byPlayer).map(([player_name, v]) => {
    const avgOrder = v.orders.reduce((sum, o) => sum + o, 0) / v.orders.length;
    const counts = {};
    for (const o of v.orders) counts[o] = (counts[o] || 0) + 1;
    const mostCommonOrder = Number(
      Object.entries(counts).sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0][0]
    );
    return {
      player_name,
      avg_order: Math.round(avgOrder * 10) / 10,
      starts: v.starts,
      most_common_order: mostCommonOrder,
    };
  });

  result.sort((a, b) => a.avg_order - b.avg_order);
  return result;
}

async function getTeamAnalysisBundle(teamId) {
  const sb = getDb();

  const [
    teamRes, games, batting, pitching, tendencies,
    recentPitchingLines, jerseyMap, activeRoster,
    scoutedBattersAdv, facedBattersAdv, scoutedPitchersAdv, facedPitchersAdv,
    rawBattingLines, verifiedTotals, lineupOrder,
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
    getRawBattingLines(teamId),
    getLatestVerifiedTeamTotals(teamId),
    getTeamLineupOrder(teamId, 10),
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
    rawBattingLines,
    verifiedTotals,
    lineupOrder,
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
  const orgId = await getOrgIdForTeam(teamId);
  const payload = {
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
	bunts: s.BUNT ?? 0,
	errors: s.E ?? 0,
  };
  if (await tableHasOrgId('player_advanced_stats')) payload.org_id = orgId;

  const { error } = await getDb().from('player_advanced_stats').upsert(payload, { onConflict: 'team_id,player_name,is_our_team' });

  check(error, 'upsertPlayerAdvancedStats');
}

async function upsertPitcherAdvancedStats(teamId, playerName, isOurTeam, stats) {
  const s = stats;
  const orgId = await getOrgIdForTeam(teamId);
  const payload = {
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
	errors: s.E ?? 0,
  };
  if (await tableHasOrgId('pitcher_advanced_stats')) payload.org_id = orgId;

  const { error } = await getDb().from('pitcher_advanced_stats').upsert(payload, { onConflict: 'team_id,player_name,is_our_team' });

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

// ─── Handedness ─────────────────────────────────────────────────────────────
// Scraped from GC "Edit Player" modals (see search-gamechanger-teams.js) into
// player_handedness. Coverage is partial — most teams have never had this
// scraped, so callers must treat an empty/missing result as "not tracked for
// this team" rather than inferring bats/throws from names, stats, or spray
// charts. bats/throws values are 'L' | 'R' | 'S' (switch) | 'Unknown'.
async function getTeamHandedness(teamId) {
  const { data, error } = await getDb()
    .from('player_handedness')
    .select('jersey_number, full_name, bats, throws')
    .eq('team_id', teamId);
  check(error, 'getTeamHandedness');
  return (data || []).filter(r => r.full_name);
}

// Used by scrape-handedness.js to decide which roster rows can be skipped
// on a re-scrape (jersey_number match, falling back to match_key = last
// name + first initial). NOTE: unlike getTeamHandedness() above, this
// intentionally does NOT filter out rows with a missing full_name — a row
// missing full_name would mean buildMatchKey() has nothing to dedupe
// against anyway, and dropping it here would just cause that player to be
// re-captured every run instead of surfacing the gap.
async function getExistingHandednessForTeam(teamId) {
  const { data, error } = await getDb()
    .from('player_handedness')
    .select('jersey_number, match_key, full_name, bats, throws')
    .eq('team_id', teamId);
  check(error, 'getExistingHandednessForTeam');
  return data || [];
}

// Upsert one captured player's handedness. onConflict target assumes a
// unique constraint on (team_id, match_key) — CONFIRM this constraint
// actually exists on player_handedness before relying on this (check with
// Supabase:list_tables verbose:true or information_schema.table_constraints).
// If the real constraint is on (team_id, jersey_number) instead, change
// onConflict below to match — a mismatched onConflict target makes Postgres
// throw on the very first upsert rather than silently doing the wrong thing.
async function upsertPlayerHandedness(teamId, player = {}) {
  const payload = {
    team_id:       teamId,
    jersey_number: player.jerseyNumber != null ? String(player.jerseyNumber) : null,
    first_name:    player.firstName || null,
    last_name:     player.lastName  || null,
    full_name:     player.fullName  || null,
    match_key:     player.matchKey  || null,
    bats:          player.bats      || 'Unknown',
    throws:        player.throws    || 'Unknown',
    updated_at:    new Date().toISOString(),
  };
  const { error } = await getDb()
    .from('player_handedness')
    .upsert(payload, { onConflict: 'team_id,match_key' });
  check(error, 'upsertPlayerHandedness');
}

// ─── Scouting Reports ─────────────────────────────────────────────────────────

async function insertScoutingReport(report) {
  const payload = {
    team_id:         report.teamId,
    report_type:     report.reportType     || 'full_scout',
    games_covered:   JSON.stringify(report.gamesCovered || []),
    file_path:       report.filePath       || null,
    file_format:     report.fileFormat     || 'pdf',
    recipient_email: report.recipientEmail || null,
  };
  if (await tableHasOrgId('scouting_reports')) {
    payload.org_id = normalizeNullable(report.orgId || report.org_id) || await getOrgIdForTeam(report.teamId);
  }

  const { data, error } = await getDb().from('scouting_reports').insert(payload).select('id').single();

  check(error, 'insertScoutingReport');
  return data.id;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  init,
  verifyConnection,
  getDb,
  getRawBattingLines,
  getGameDataForStatsEngine,
  // Teams
  upsertTeam,
  getTeamByUrl,
  getAllTeams,
  setTeamArchived,
  // Games
  insertGame,
  getGamesByTeam,
  getCompleteGamesByTeam,
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
  getTeamLineupOrder,
  // Reports
  insertScoutingReport,
  // Advanced stats
  upsertPlayerAdvancedStats,
  upsertPitcherAdvancedStats,
  getPlayerAdvancedStats,
  getPitcherAdvancedStats,
  getTeamHandedness,
  getExistingHandednessForTeam,
  upsertPlayerHandedness,
};