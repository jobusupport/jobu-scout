'use strict';

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

// Write GC auth session from environment variable on startup
const gcAuthPath = '/app/storage/gamechanger-auth.json';
if (process.env.GC_AUTH_JSON) {
  try {
    require('fs').mkdirSync('/app/storage', { recursive: true });
    require('fs').writeFileSync(gcAuthPath, process.env.GC_AUTH_JSON, 'utf8');
    console.log('[startup] GC auth written from env var');
  } catch (e) {
    console.error('[startup] Failed to write GC auth:', e.message);
  }
}
// Railway should provide USE_SUPABASE=true, but production should still use
// Supabase whenever the Supabase connection config is present. This prevents
// an accidental production fallback to the local SQLite layer.
const hasSupabaseRuntimeConfig = Boolean(
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const explicitUseSupabase =
  String(process.env.USE_SUPABASE || '').trim().toLowerCase() === 'true';
const shouldUseSupabase =
  explicitUseSupabase ||
  (process.env.NODE_ENV === 'production' && hasSupabaseRuntimeConfig);

process.env.USE_SUPABASE = shouldUseSupabase ? 'true' : 'false';

console.log('[env] Runtime config:', {
  NODE_ENV: process.env.NODE_ENV,
  USE_SUPABASE: process.env.USE_SUPABASE,
  explicitUseSupabase,
  shouldUseSupabase,
  hasSupabaseUrl: !!process.env.SUPABASE_URL,
  hasSupabaseAnonKey: !!process.env.SUPABASE_ANON_KEY,
  hasSupabaseServiceRoleKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
  DASHBOARD_PORT: process.env.DASHBOARD_PORT
});

const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const { spawn } = require('child_process');
let SQLiteDatabase = null;

// ── Supabase ─────────────────────────────────────────────────────────────────
const { createClient } = require('@supabase/supabase-js');

const USE_SUPABASE = String(process.env.USE_SUPABASE || '').trim().toLowerCase() === 'true';
const HAS_SUPABASE_CONFIG = Boolean(
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_ANON_KEY &&
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const adminClient = HAS_SUPABASE_CONFIG
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

let pipelineDb = null;
if (USE_SUPABASE) {
  pipelineDb = require('./src/db');
  pipelineDb.init();
  if (typeof pipelineDb.verifyConnection === 'function') {
    pipelineDb.verifyConnection().catch(err => {
      console.error('[startup] Supabase verification failed:', err.message);
    });
  }
}

const app  = express();
const PORT = process.env.DASHBOARD_PORT || 3333;
const ROOT = __dirname;
const DB_PATH     = path.join(ROOT, 'voodoo-scout.db');
const REPORTS_DIR = process.env.REPORTS_DIR || path.join(ROOT, 'reports');
const PG_ROOT     = process.env.PG_OUTPUT_ROOT ||
  path.join(ROOT, '..', 'perfectgame-scraper', 'output');

app.use(express.json());
app.use('/reports', express.static(REPORTS_DIR));
app.use(express.static(path.join(ROOT, 'dashboard')));

// ── Job store ───────────────────────────────────────────────────────────────
const jobs = {};
let jobSeq = 1;

function createJob(label) {
  const id = String(jobSeq++);
  jobs[id] = { id, label, status: 'running', logs: [], startedAt: Date.now(), pid: null, proc: null };
  return id;
}
function appendLog(id, line) {
  if (jobs[id]) jobs[id].logs.push({ t: Date.now(), line });
}
function finishJob(id, success, exitCode) {
  if (!jobs[id]) return;
  jobs[id].status     = success ? 'done' : 'failed';
  jobs[id].exitCode   = exitCode;
  jobs[id].finishedAt = Date.now();
  jobs[id].proc       = null;
}
function spawnJob(id, cmd, args, cwd, env = {}) {
  const proc = spawn(cmd, args, {
    cwd, env: { ...process.env, ...env }, shell: false,
  });
  jobs[id].pid  = proc.pid;
  jobs[id].proc = proc;
  const onData = chunk => String(chunk).split('\n').filter(Boolean).forEach(l => appendLog(id, l));
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('close', code => finishJob(id, code === 0, code));
  return proc;
}

// Shared runStep factory for sequential multi-team jobs
function makeRunStep(id) {
  return function runStep(cmd, args, cwd, env = {}) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, {
        cwd, shell: false, env: { ...process.env, ...env },
      });
      const onData = chunk => String(chunk).split('\n').filter(Boolean).forEach(l => appendLog(id, l));
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Exit ${code}`)));
    });
  };
}

// ── DB helpers ──────────────────────────────────────────────────────────────
function getSQLiteDatabase() {
  if (!SQLiteDatabase) SQLiteDatabase = require('better-sqlite3');
  return SQLiteDatabase;
}

function getDb() {
  if (USE_SUPABASE) {
    throw new Error('SQLite access requested while USE_SUPABASE=true');
  }
  const Database = getSQLiteDatabase();
  return new Database(DB_PATH, { readonly: true });
}

async function getTeams(req = null) {
  if (USE_SUPABASE) {
    const orgId = await getRequestOrgId(req);

    const { data: teams, error } = await adminClient
      .from('teams')
      .select('*')
      .eq('org_id', orgId)
      .order('team_name');

    if (error) throw error;
    if (!teams?.length) return [];

    const ids = teams.map(t => t.id);
    const { data: games, error: gamesError } = await adminClient
      .from('games')
      .select('id, team_id, game_date, result')
      .in('team_id', ids);

    if (gamesError) throw gamesError;

    const gameMap = new Map();
    for (const game of games || []) {
      const row = gameMap.get(game.team_id) || { game_count: 0, last_game: null };
      row.game_count += 1;
      if (game.game_date && (!row.last_game || game.game_date > row.last_game)) row.last_game = game.game_date;
      gameMap.set(game.team_id, row);
    }

    return teams.map(team => ({
      ...team,
      game_count: gameMap.get(team.id)?.game_count || 0,
      last_game:  gameMap.get(team.id)?.last_game  || null,
    }));
  }

  try {
    const db    = getDb();
    const teams = db.prepare(`
      SELECT t.*, COUNT(DISTINCT g.id) AS game_count, MAX(g.game_date) AS last_game
      FROM teams t LEFT JOIN games g ON g.team_id = t.id
      GROUP BY t.id ORDER BY t.team_name
    `).all();
    db.close();
    return teams;
  } catch { return []; }
}

async function getTeamStats(teamId) {
  if (USE_SUPABASE) {
    const [{ data: games, error: gamesError }, { count: plays, error: playsError }, { data: batters, error: battersError }] = await Promise.all([
      adminClient.from('games').select('result').eq('team_id', teamId),
      adminClient.from('play_events').select('id', { count: 'exact', head: true }).eq('team_id', teamId),
      adminClient.from('batting_lines').select('player_name').eq('team_id', teamId).eq('is_our_team', false),
    ]);

    if (gamesError) throw gamesError;
    if (playsError) throw playsError;
    if (battersError) throw battersError;

    return {
      wins:    (games || []).filter(g => g.result === 'W').length,
      losses:  (games || []).filter(g => g.result === 'L').length,
      plays:   plays || 0,
      batters: new Set((batters || []).map(b => b.player_name).filter(Boolean)).size,
    };
  }

  try {
    const db      = getDb();
    const games   = db.prepare(`SELECT result FROM games WHERE team_id = ?`).all(teamId);
    const plays   = db.prepare(`SELECT COUNT(*) as n FROM play_events WHERE team_id = ?`).get(teamId);
    const batters = db.prepare(`SELECT COUNT(DISTINCT player_name) as n FROM batting_lines WHERE team_id = ? AND is_our_team = 0`).get(teamId);
    db.close();
    return { wins: games.filter(g=>g.result==='W').length, losses: games.filter(g=>g.result==='L').length, plays: plays.n, batters: batters.n };
  } catch { return {}; }
}

function getReports() {
  try {
    if (!fs.existsSync(REPORTS_DIR)) return [];
    return fs.readdirSync(REPORTS_DIR)
      .filter(f => f.endsWith('.pdf') || f.endsWith('.docx'))
      .map(f => { const s = fs.statSync(path.join(REPORTS_DIR, f)); return { name: f, size: s.size, mtime: s.mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

function hasPGData(teamName) {
  if (!fs.existsSync(PG_ROOT)) return false;
  return fs.readdirSync(PG_ROOT).some(d => d.toLowerCase().includes(teamName.toLowerCase().split(' ')[0]));
}

async function hasGameUrls(teamId) {
  if (USE_SUPABASE) {
    const { count, error } = await adminClient
      .from('team_game_urls')
      .select('id', { count: 'exact', head: true })
      .eq('team_id', teamId);
    if (error) throw error;
    return (count || 0) > 0;
  }

  try {
    const db  = getDb();
    const row = db.prepare(`SELECT COUNT(*) as n FROM team_game_urls WHERE team_id = ?`).get(teamId);
    db.close();
    return row.n > 0;
  } catch { return false; }
}

async function getTeamGames(teamId) {
  if (USE_SUPABASE) {
    const { data, error } = await adminClient
      .from('games')
      .select('id, gc_game_id, gc_game_url, game_date, game_time, result, score_us, score_them, opponent_name, location, season_type')
      .eq('team_id', teamId)
      .order('game_date', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  const db    = getDb();
  const games = db.prepare(`
    SELECT id, gc_game_id, gc_game_url, game_date, game_time,
           result, score_us, score_them, opponent_name, location, season_type
    FROM games
    WHERE team_id = ?
    ORDER BY game_date DESC
  `).all(teamId);
  db.close();
  return games;
}

async function getTeamGameUrls(teamId) {
  if (USE_SUPABASE) {
    const { data, error } = await adminClient
      .from('team_game_urls')
      .select('*')
      .eq('team_id', teamId)
      .order('created_at');
    if (error) throw error;
    return data || [];
  }

  const db   = getDb();
  const urls = db.prepare(`SELECT * FROM team_game_urls WHERE team_id = ? ORDER BY created_at`).all(teamId);
  db.close();
  return urls;
}

function cleanTeamName(name) {
  return (name || '').replace(/\([\d-]+ in \d{4}\)/g, '').trim();
}

function isMissingRelationError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  const code = String(err?.code || '').toUpperCase();

  return (
    // Missing table/relation
    (msg.includes('relation') && msg.includes('does not exist')) ||
    msg.includes('could not find the table') ||

    // Missing column in Supabase/PostgREST schema cache. This lets optional
    // customer schemas work without requiring profiles.org_id specifically.
    (msg.includes('column') && msg.includes('does not exist')) ||
    msg.includes('could not find') && msg.includes('column') ||
    code === '42703' ||
    code === 'PGRST204' ||

    // Generic PostgREST schema cache miss
    msg.includes('schema cache')
  );
}

async function maybeSingleSafe(query) {
  try {
    const { data, error } = await query.maybeSingle();
    if (error) {
      if (isMissingRelationError(error)) return null;
      throw error;
    }
    return data || null;
  } catch (err) {
    if (isMissingRelationError(err)) return null;
    throw err;
  }
}

async function selectSafe(query) {
  try {
    const { data, error } = await query;
    if (error) {
      if (isMissingRelationError(error)) return [];
      throw error;
    }
    return data || [];
  } catch (err) {
    if (isMissingRelationError(err)) return [];
    throw err;
  }
}

async function getRequestOrgId(req) {
  if (!USE_SUPABASE) return null;

  if (req?._orgId) return req._orgId;

  const user = req?.user || null;
  const userId = user?.id || null;
  const userEmail = user?.email || null;

  const metadataOrgId =
    user?.app_metadata?.org_id ||
    user?.user_metadata?.org_id ||
    user?.org_id ||
    null;

  if (metadataOrgId) {
    req._orgId = metadataOrgId;
    return metadataOrgId;
  }

  if (!userId && !userEmail) {
    throw new Error('Unable to determine the current user. Please sign out and sign back in.');
  }

  // Common schema: profiles.id = auth.users.id, profiles.org_id
  if (userId) {
    const profileById = await maybeSingleSafe(
      adminClient.from('profiles').select('org_id').eq('id', userId).limit(1)
    );
    if (profileById?.org_id) {
      req._orgId = profileById.org_id;
      return profileById.org_id;
    }
  }

  if (userEmail) {
    const profileByEmail = await maybeSingleSafe(
      adminClient.from('profiles').select('org_id').ilike('email', userEmail).limit(1)
    );
    if (profileByEmail?.org_id) {
      req._orgId = profileByEmail.org_id;
      return profileByEmail.org_id;
    }
  }

  // Common schema: org_members.user_id / org_members.email -> org_id
  if (userId) {
    const memberByUserId = await maybeSingleSafe(
      adminClient.from('org_members').select('org_id').eq('user_id', userId).limit(1)
    );
    if (memberByUserId?.org_id) {
      req._orgId = memberByUserId.org_id;
      return memberByUserId.org_id;
    }
  }

  if (userEmail) {
    const memberByEmail = await maybeSingleSafe(
      adminClient.from('org_members').select('org_id').ilike('email', userEmail).limit(1)
    );
    if (memberByEmail?.org_id) {
      req._orgId = memberByEmail.org_id;
      return memberByEmail.org_id;
    }
  }

  // Alternate naming sometimes used by SaaS templates.
  if (userId) {
    const membershipByUserId = await maybeSingleSafe(
      adminClient.from('memberships').select('org_id').eq('user_id', userId).limit(1)
    );
    if (membershipByUserId?.org_id) {
      req._orgId = membershipByUserId.org_id;
      return membershipByUserId.org_id;
    }
  }

  // Safe customer-friendly fallback for single-org installs:
  // no manual Railway variable, but we refuse to guess when more than one org exists.
  const orgs = await selectSafe(adminClient.from('orgs').select('id').limit(2));
  if (orgs.length === 1) {
    req._orgId = orgs[0].id;
    return orgs[0].id;
  }

  const organizations = await selectSafe(adminClient.from('organizations').select('id').limit(2));
  if (organizations.length === 1) {
    req._orgId = organizations[0].id;
    return organizations[0].id;
  }

  throw new Error(
    `No organization could be resolved for ${userEmail || userId}. ` +
    'Create a profiles.org_id or org_members row for this user so teams can be assigned to the correct customer organization.'
  );
}

async function assertTeamInRequestOrg(req, teamId) {
  if (!USE_SUPABASE) return;
  const orgId = await getRequestOrgId(req);
  const { data, error } = await adminClient
    .from('teams')
    .select('id')
    .eq('id', teamId)
    .eq('org_id', orgId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error('Team not found for this organization.');
}

// ── Auth middleware ──────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const jwt = header.replace('Bearer ', '').trim();
  if (!adminClient) {
    return res.status(500).json({ error: 'Supabase auth is not configured on the server' });
  }
  const { data, error } = await adminClient.auth.getUser(jwt);
  if (error || !data?.user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.user = data.user;
  req.jwt  = jwt;
  next();
}

// ── Auth routes ──────────────────────────────────────────────────────────────

// POST /api/auth/login  { email, password }
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  if (!HAS_SUPABASE_CONFIG) {
    return res.status(500).json({ error: 'Supabase auth is not configured on the server' });
  }
  const anonClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );
  const { data, error } = await anonClient.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });
  res.json({
    ok:           true,
    accessToken:  data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt:    data.session.expires_at,
    user: { id: data.user.id, email: data.user.email },
  });
});

// POST /api/auth/logout
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  try { await adminClient.auth.admin.signOut(req.jwt); } catch {}
  res.json({ ok: true });
});

// GET /api/auth/me
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ id: req.user.id, email: req.user.email });
});

// POST /api/auth/refresh  { refreshToken }
app.post('/api/auth/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
  if (!HAS_SUPABASE_CONFIG) {
    return res.status(500).json({ error: 'Supabase auth is not configured on the server' });
  }
  const anonClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );
  const { data, error } = await anonClient.auth.refreshSession({ refresh_token: refreshToken });
  if (error) return res.status(401).json({ error: error.message });
  res.json({
    accessToken:  data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt:    data.session.expires_at,
  });
});

// ── API ─────────────────────────────────────────────────────────────────────
app.get('/api/debug/auth', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const authPath = '/app/storage/gamechanger-auth.json';
  const exists = fs.existsSync(authPath);
  const cwd = process.cwd();
  const storageContents = fs.existsSync('/app/storage') 
    ? fs.readdirSync('/app/storage') 
    : 'directory does not exist';
  const appContents = fs.readdirSync('/app');
  
  res.json({ authPath, exists, cwd, storageContents, appContents });
});

app.get('/api/teams', requireAuth, async (req, res) => {
  try {
    const rawTeams = await getTeams(req);
    const teams = await Promise.all(rawTeams.map(async t => {
      const hasUrls = await hasGameUrls(t.id);
      return {
        ...t,
        hasGC:       !!t.gc_team_url || hasUrls,
        hasPG:       hasPGData(t.team_name),
        hasGameUrls: hasUrls,
        stats:       await getTeamStats(t.id),
      };
    }));
    res.json(teams);
  } catch (err) {
    console.error('[api/teams]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports', requireAuth, (req, res) => res.json(getReports()));

app.get('/api/jobs/:id', requireAuth, (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ ...job, proc: undefined }); // don't serialize proc
});

app.get('/api/jobs/:id/stream', async (req, res) => {
  // EventSource can't send custom headers — accept token via query param
  const token = req.query.token;
  if (token && adminClient) {
    const { data, error } = await adminClient.auth.getUser(token);
    if (error || !data?.user) return res.status(401).end();
  }

  const job = jobs[req.params.id];
  if (!job) return res.status(404).end();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  let cursor = 0;
  const send = () => {
    while (cursor < job.logs.length) res.write(`data: ${JSON.stringify(job.logs[cursor++])}\n\n`);
    if (job.status !== 'running') {
      res.write(`data: ${JSON.stringify({ done: true, status: job.status })}\n\n`);
      clearInterval(timer); res.end();
    }
  };
  const timer = setInterval(send, 300);
  send();
  req.on('close', () => clearInterval(timer));
});

// POST /api/jobs/:id/stop
app.post('/api/jobs/:id/stop', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'running') return res.json({ ok: true, message: 'Job already finished' });
  try {
    if (job.proc && job.pid) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(job.pid), '/f', '/t'], { shell: true });
      } else {
        process.kill(-job.proc.pid, 'SIGTERM');
      }
    }
    appendLog(req.params.id, '✗ Job stopped by user');
    finishJob(req.params.id, false, -1);
  } catch {
    finishJob(req.params.id, false, -1);
  }
  res.json({ ok: true });
});

// POST /api/run/gc-scraper
app.post('/api/run/gc-scraper', requireAuth, async (req, res) => {
  const team = (await getTeams(req)).find(t => t.id == req.body.teamId);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const id = createJob(`GC Scraper — ${team.team_name}`);
  appendLog(id, `Starting GameChanger scraper for: ${team.team_name}`);
  if (!team.gc_team_url && await hasGameUrls(team.id)) {
    appendLog(id, `No team URL — scraping via individual game URLs`);
    spawnJob(id, 'node', ['src/scrape-game-urls.js', `"${cleanTeamName(team.team_name)}"`], ROOT);
  } else {
    const env = {};
    if (team.gc_team_url) env.GC_TEAM_URL = team.gc_team_url;
    env.GC_TEST_TEAM_CONTAINS = team.gc_search_name || team.team_name;
    spawnJob(id, 'node', ['src/search-gamechanger-teams.js'], ROOT, env);
  }
  res.json({ jobId: id });
});

// POST /api/run/pg-scraper
app.post('/api/run/pg-scraper', requireAuth, async (req, res) => {
  const team = (await getTeams(req)).find(t => t.id == req.body.teamId);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const id = createJob(`PG Scraper — ${team.team_name}`);
  appendLog(id, `Starting Perfect Game scraper for: ${team.team_name}`);
  spawnJob(id, 'node', ['perfectgame-scraper.js', team.pg_team_url || '', team.team_name],
    path.join(ROOT, '..', 'perfectgame-scraper'));
  res.json({ jobId: id });
});

// POST /api/run/reingest
app.post('/api/run/reingest', requireAuth, async (req, res) => {
  const team  = req.body.teamId ? (await getTeams(req)).find(t => t.id == req.body.teamId) : null;
  const label = team ? `Reingest — ${team.team_name}` : 'Reingest — All Teams';
  const id    = createJob(label);
  appendLog(id, label);
  spawnJob(id, 'node', team ? ['reingest-games.js', team.team_name] : ['reingest-games.js', '--all'], ROOT);
  res.json({ jobId: id });
});

// POST /api/run/report  { teamId, gameLocation?, gameDate? }
app.post('/api/run/report', requireAuth, async (req, res) => {
  const { teamId, gameLocation, gameDate } = req.body;
  const team = (await getTeams(req)).find(t => t.id == teamId);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const id = createJob(`Report — ${team.team_name}`);
  appendLog(id, `Generating scouting report for: ${team.team_name}`);
  if (gameLocation) appendLog(id, `Game location: ${gameLocation}`);
  const env = {};
  if (gameLocation) env.GAME_LOCATION = gameLocation;
  if (gameDate)     env.GAME_DATE     = gameDate;
  spawnJob(id, 'node', ['src/generate-report.js', team.team_name], ROOT, env);
  res.json({ jobId: id });
});

// POST /api/run/full-pipeline  { teamId, gameLocation?, gameDate? }
app.post('/api/run/full-pipeline', requireAuth, async (req, res) => {
  const { teamId, gameLocation, gameDate } = req.body;
  const team = (await getTeams(req)).find(t => t.id == teamId);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const id      = createJob(`Full Pipeline — ${team.team_name}`);
  const pgRoot  = path.join(ROOT, '..', 'perfectgame-scraper');
  const noGC    = !team.gc_team_url && await hasGameUrls(team.id);
  const runStep = makeRunStep(id);
  appendLog(id, `Running full pipeline for: ${team.team_name}`);
  appendLog(id, `Steps: GC Scrape → PG Scrape → Reingest → Generate Report`);
  (async () => {
    try {
      appendLog(id, '── Step 1/4: GameChanger Scraper ──');
      if (noGC) {
        await runStep('node', ['src/scrape-game-urls.js', `"${cleanTeamName(team.team_name)}"`], ROOT);
      } else {
        const gcEnv = {};
        if (team.gc_team_url) gcEnv.GC_TEAM_URL = team.gc_team_url;
        gcEnv.GC_TEST_TEAM_CONTAINS = team.gc_search_name || team.team_name;
        await runStep('node', ['src/search-gamechanger-teams.js'], ROOT, gcEnv);
      }
      appendLog(id, '── Step 2/4: Perfect Game Scraper ──');
      await runStep('node', ['perfectgame-scraper.js', team.pg_team_url || '', team.team_name], pgRoot);
      appendLog(id, '── Step 3/4: Reingest & Stats ──');
      await runStep('node', ['reingest-games.js', team.team_name], ROOT);
      appendLog(id, '── Step 4/4: Generate Report ──');
      const reportEnv = {};
      if (gameLocation) reportEnv.GAME_LOCATION = gameLocation;
      if (gameDate)     reportEnv.GAME_DATE     = gameDate;
      await runStep('node', ['src/generate-report.js', team.team_name], ROOT, reportEnv);
      finishJob(id, true, 0);
      appendLog(id, `✓ Pipeline complete for ${team.team_name}`);
    } catch (err) {
      appendLog(id, `✗ Pipeline failed: ${err.message}`);
      finishJob(id, false, 1);
    }
  })();
  res.json({ jobId: id });
});

// POST /api/run/all-gc — scrape all teams GC
app.post('/api/run/all-gc', requireAuth, async (req, res) => {
  const allTeams = await getTeams(req);
  const teamsWithUrlFlags = await Promise.all(allTeams.map(async t => ({ ...t, _hasGameUrls: await hasGameUrls(t.id) })));
  const teams   = teamsWithUrlFlags.filter(t => t.gc_team_url || t._hasGameUrls);
  if (!teams.length) return res.status(400).json({ error: 'No teams with GC URLs or game URLs' });
  const id      = createJob(`GC Scrape All (${teams.length} teams)`);
  const runStep = makeRunStep(id);
  appendLog(id, `Queuing GC scrape for ${teams.length} team(s)...`);
  (async () => {
    let done = 0, failed = 0;
    for (const team of teams) {
      if (jobs[id]?.status !== 'running') break;
      appendLog(id, `\n── [${done+failed+1}/${teams.length}] ${team.team_name} ──`);
      try {
        if (!team.gc_team_url && team._hasGameUrls) {
          await runStep('node', ['src/scrape-game-urls.js', `"${cleanTeamName(team.team_name)}"`], ROOT);
        } else {
          const env = {};
          if (team.gc_team_url) env.GC_TEAM_URL = team.gc_team_url;
          env.GC_TEST_TEAM_CONTAINS = team.gc_search_name || team.team_name;
          await runStep('node', ['src/search-gamechanger-teams.js'], ROOT, env);
        }
        appendLog(id, `✓ ${team.team_name} done`); done++;
      } catch (err) {
        appendLog(id, `✗ ${team.team_name} failed: ${err.message}`); failed++;
      }
    }
    finishJob(id, failed === 0, 0);
    appendLog(id, `\n── Complete: ${done} succeeded, ${failed} failed ──`);
  })();
  res.json({ jobId: id });
});

// POST /api/run/all-pg — scrape all teams PG
app.post('/api/run/all-pg', requireAuth, async (req, res) => {
  const teams   = (await getTeams(req)).filter(t => t.pg_team_url);
  if (!teams.length) return res.status(400).json({ error: 'No teams with PG URLs' });
  const id      = createJob(`PG Scrape All (${teams.length} teams)`);
  const pgRoot  = path.join(ROOT, '..', 'perfectgame-scraper');
  const runStep = makeRunStep(id);
  appendLog(id, `Queuing PG scrape for ${teams.length} team(s)...`);
  (async () => {
    let done = 0, failed = 0;
    for (const team of teams) {
      if (jobs[id]?.status !== 'running') break;
      appendLog(id, `\n── [${done+failed+1}/${teams.length}] ${team.team_name} ──`);
      try {
        await runStep('node', ['perfectgame-scraper.js', team.pg_team_url, team.team_name], pgRoot);
        appendLog(id, `✓ ${team.team_name} done`); done++;
      } catch (err) {
        appendLog(id, `✗ ${team.team_name} failed: ${err.message}`); failed++;
      }
    }
    finishJob(id, failed === 0, 0);
    appendLog(id, `\n── Complete: ${done} succeeded, ${failed} failed ──`);
  })();
  res.json({ jobId: id });
});

// POST /api/run/all-reports — generate reports for all teams with games
app.post('/api/run/all-reports', requireAuth, async (req, res) => {
  const teams   = (await getTeams(req)).filter(t => t.game_count > 0);
  if (!teams.length) return res.status(400).json({ error: 'No teams with game data' });
  const id      = createJob(`Reports All (${teams.length} teams)`);
  const runStep = makeRunStep(id);
  appendLog(id, `Generating reports for ${teams.length} team(s)...`);
  (async () => {
    let done = 0, failed = 0;
    for (const team of teams) {
      if (jobs[id]?.status !== 'running') break;
      appendLog(id, `\n── [${done+failed+1}/${teams.length}] ${team.team_name} ──`);
      try {
        await runStep('node', ['src/generate-report.js', team.team_name], ROOT);
        appendLog(id, `✓ ${team.team_name} done`); done++;
      } catch (err) {
        appendLog(id, `✗ ${team.team_name} failed: ${err.message}`); failed++;
      }
    }
    finishJob(id, failed === 0, 0);
    appendLog(id, `\n── Complete: ${done} succeeded, ${failed} failed ──`);
  })();
  res.json({ jobId: id });
});

// ── Serve dashboard ─────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'dashboard', 'index.html')));

// ── Team Games ───────────────────────────────────────────────────────────────
app.get('/api/teams/:id/games', requireAuth, async (req, res) => {
  try {
    res.json(await getTeamGames(req.params.id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Team Game URLs ───────────────────────────────────────────────────────────
app.get('/api/teams/:id/game-urls', requireAuth, async (req, res) => {
  try {
    res.json(await getTeamGameUrls(req.params.id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/teams/:id/game-urls', requireAuth, async (req, res) => {
  const { gc_game_url, label = '', box_side = 'away' } = req.body;
  if (!['away','home'].includes(box_side)) return res.status(400).json({ error: 'box_side must be away or home' });
  try {
    if (USE_SUPABASE) {
      await assertTeamInRequestOrg(req, req.params.id);
      const { data, error } = await adminClient
        .from('team_game_urls')
        .insert({ team_id: req.params.id, gc_game_url: (gc_game_url || '').trim(), label: label.trim(), box_side })
        .select('id')
        .single();
      if (error) throw error;
      return res.json({ ok: true, id: data.id });
    }

    const db   = new (getSQLiteDatabase())(DB_PATH);
    const info = db.prepare(
      `INSERT INTO team_game_urls (team_id, gc_game_url, label, box_side) VALUES (?, ?, ?, ?)`
    ).run(req.params.id, (gc_game_url || '').trim(), label.trim(), box_side);
    db.close();
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/teams/:id/game-urls/:urlId', requireAuth, async (req, res) => {
  const { gc_game_url, label, box_side } = req.body;
  try {
    if (USE_SUPABASE) {
      await assertTeamInRequestOrg(req, req.params.id);
      const updates = {};
      if (gc_game_url !== undefined) updates.gc_game_url = gc_game_url;
      if (label !== undefined)       updates.label       = label;
      if (box_side !== undefined)    updates.box_side    = box_side;
      const { error } = await adminClient
        .from('team_game_urls')
        .update(updates)
        .eq('id', req.params.urlId)
        .eq('team_id', req.params.id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    const db = new (getSQLiteDatabase())(DB_PATH);
    db.prepare(`
      UPDATE team_game_urls SET
        gc_game_url = COALESCE(?, gc_game_url),
        label       = COALESCE(?, label),
        box_side    = COALESCE(?, box_side)
      WHERE id = ? AND team_id = ?
    `).run(gc_game_url ?? null, label ?? null, box_side ?? null, req.params.urlId, req.params.id);
    db.close();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/teams/:id/game-urls/:urlId', requireAuth, async (req, res) => {
  try {
    if (USE_SUPABASE) {
      await assertTeamInRequestOrg(req, req.params.id);
      const { error } = await adminClient
        .from('team_game_urls')
        .delete()
        .eq('id', req.params.urlId)
        .eq('team_id', req.params.id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    const db = new (getSQLiteDatabase())(DB_PATH);
    db.prepare(`DELETE FROM team_game_urls WHERE id = ? AND team_id = ?`).run(req.params.urlId, req.params.id);
    db.close();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Add Team ─────────────────────────────────────────────────────────────────
app.post('/api/teams/add', requireAuth, async (req, res) => {
  const { teamName, gcTeamUrl, pgTeamUrl } = req.body;
  if (!teamName) return res.status(400).json({ error: 'teamName is required' });

  try {
    if (USE_SUPABASE) {
      const orgId = await getRequestOrgId(req);

      const { data: existing, error: findError } = await adminClient
        .from('teams')
        .select('id')
        .eq('org_id', orgId)
        .ilike('team_name', teamName.trim())
        .maybeSingle();

      if (findError) throw findError;
      if (existing) {
        return res.status(409).json({
          error: `"${teamName}" already exists in this organization (id ${existing.id})`,
        });
      }

      const { data, error } = await adminClient
        .from('teams')
        .insert({
          org_id: orgId,
          team_name: teamName.trim(),
          gc_team_url: gcTeamUrl || null,
          pg_team_url: pgTeamUrl || null,
          is_our_team: false,
        })
        .select('id')
        .single();

      if (error) throw error;
      return res.json({ ok: true, id: data.id });
    }

    const db       = new (getSQLiteDatabase())(DB_PATH);
    const existing = db.prepare(`SELECT id FROM teams WHERE LOWER(TRIM(team_name)) = LOWER(TRIM(?))`).get(teamName);
    if (existing) { db.close(); return res.status(409).json({ error: `"${teamName}" already exists (id ${existing.id})` }); }
    const info = db.prepare(`INSERT INTO teams (team_name, gc_team_url, pg_team_url) VALUES (@teamName, @gcTeamUrl, @pgTeamUrl)`)
      .run({ teamName, gcTeamUrl: gcTeamUrl || null, pgTeamUrl: pgTeamUrl || null });
    db.close();
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    console.error('[api/teams/add]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Sync Google Sheet ────────────────────────────────────────────────────────
app.post('/api/settings/sheet', requireAuth, async (req, res) => {
  const { csvUrl, replace = false } = req.body;
  if (!csvUrl || !csvUrl.includes('output=csv')) {
    return res.status(400).json({ error: 'Must be a published Google Sheet CSV URL (must contain output=csv)' });
  }
  try {
    const testFetch = await fetch(csvUrl);
    if (!testFetch.ok) return res.status(400).json({ error: `Could not fetch sheet: HTTP ${testFetch.status}.` });
    const csvText = await testFetch.text();
    if (!csvText || csvText.trim().startsWith('<!')) return res.status(400).json({ error: 'URL did not return CSV data.' });

    if (process.env.NODE_ENV !== 'production') {
      const envPath = path.join(ROOT, '.env');
      let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
      envContent = envContent.includes('TEAMS_CSV_URL=')
        ? envContent.replace(/TEAMS_CSV_URL=.*/g, `TEAMS_CSV_URL=${csvUrl}`)
        : envContent + `\nTEAMS_CSV_URL=${csvUrl}`;
      fs.writeFileSync(envPath, envContent);
    }
    process.env.TEAMS_CSV_URL = csvUrl;

    function parseCsvLine(line) {
      const out = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; continue; }
        if (ch === '"') { inQuotes = !inQuotes; continue; }
        if (ch === ',' && !inQuotes) { out.push(current); current = ''; continue; }
        current += ch;
      }
      out.push(current);
      return out.map(v => v.trim());
    }
    function normHeader(value) {
      return String(value || '')
        .replace(/^﻿/, '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    }

    const rows = csvText
      .split(/\r?\n/)
      .filter(l => l.trim())
      .map(parseCsvLine);
    const headers = rows[0].map(normHeader);
    function col(row, ...names) {
      for (const name of names) {
        const idx = headers.indexOf(normHeader(name));
        if (idx !== -1 && row[idx] && row[idx].trim()) return row[idx].trim();
      }
      return null;
    }

    if (USE_SUPABASE) {
      const orgId = await getRequestOrgId(req);

      let added = 0;
      let updated = 0;
      let skipped = 0;
      let removed = 0;
      let keptWithGames = 0;

      if (replace) {
        const sheetNames = new Set();

        for (let i = 1; i < rows.length; i++) {
          const row  = rows[i];
          const name = col(row, 'team_name', 'team name', 'team', 'name');

          if (name && !name.startsWith('_')) {
            sheetNames.add(name.toLowerCase().trim());
          }
        }

        const { data: existingTeams, error: existingError } = await adminClient
          .from('teams')
          .select('id, team_name')
          .eq('org_id', orgId);

        if (existingError) throw existingError;

        for (const t of existingTeams || []) {
          const normalizedName = String(t.team_name || '').toLowerCase().trim();

          if (sheetNames.has(normalizedName)) continue;

          const { count: linkedGameCount, error: linkedGameError } = await adminClient
            .from('games')
            .select('id', { count: 'exact', head: true })
            .eq('team_id', t.id);

          if (linkedGameError) throw linkedGameError;

          if ((linkedGameCount || 0) > 0) {
            keptWithGames++;
            console.log(`[sheet-sync] Keeping team with linked games: ${t.team_name}`);
            continue;
          }

          const { error: deleteError } = await adminClient
            .from('teams')
            .delete()
            .eq('id', t.id)
            .eq('org_id', orgId);

          if (deleteError) throw deleteError;
          removed++;
        }
      }

      for (let i = 1; i < rows.length; i++) {
        const row      = rows[i];
        const teamName = col(row, 'team_name', 'team name', 'team', 'name');

        if (!teamName || teamName.startsWith('_')) {
          skipped++;
          continue;
        }

        const gcTeamUrl =
          col(
            row,
            'gc_team_url',
            'gc team url',
            'gc_url',
            'gamechanger_url',
            'gamechanger team url',
            'gamechanger url'
          ) || null;

        const pgTeamUrl =
          col(
            row,
            'pg_team_url',
            'pg team url',
            'pg_url',
            'perfectgame_url',
            'perfect game url',
            'perfect_game_url',
            'perfect_game_team_url',
            'perfect game team url',
            'team_page',
            'team page'
          ) || null;

        const { data: existing, error: findError } = await adminClient
          .from('teams')
          .select('id')
          .eq('org_id', orgId)
          .ilike('team_name', teamName.trim())
          .maybeSingle();

        if (findError) throw findError;

        if (existing) {
          const updates = {
            updated_at: new Date().toISOString(),
          };

          if (gcTeamUrl) updates.gc_team_url = gcTeamUrl;
          if (pgTeamUrl) updates.pg_team_url = pgTeamUrl;

          const { error } = await adminClient
            .from('teams')
            .update(updates)
            .eq('id', existing.id)
            .eq('org_id', orgId);

          if (error) throw error;
          updated++;
        } else {
          const { error } = await adminClient
            .from('teams')
            .insert({
              org_id: orgId,
              team_name: teamName.trim(),
              gc_team_url: gcTeamUrl,
              pg_team_url: pgTeamUrl,
              is_our_team: false,
            });

          if (error) throw error;
          added++;
        }
      }

      const msg = replace
        ? `Synced ${added} new, ${updated} updated, ${removed} removed, ${keptWithGames} kept because they have games.`
        : `Synced ${added} new, ${updated} updated from sheet.`;

      return res.json({
        ok: true,
        added,
        updated,
        removed,
        keptWithGames,
        skipped,
        message: msg,
      });
    }

    const db           = new (getSQLiteDatabase())(DB_PATH);
    const findExisting = db.prepare(`SELECT id FROM teams WHERE LOWER(TRIM(team_name)) = LOWER(TRIM(?))`);
    const insertTeam   = db.prepare(`INSERT INTO teams (team_name, gc_team_url, pg_team_url) VALUES (@teamName, @gcTeamUrl, @pgTeamUrl)`);
    const updateTeam   = db.prepare(`UPDATE teams SET gc_team_url = COALESCE(@gcTeamUrl, gc_team_url), pg_team_url = COALESCE(@pgTeamUrl, pg_team_url), updated_at = datetime('now') WHERE id = @id`);
    const deleteTeam   = db.prepare(`DELETE FROM teams WHERE id = ?`);

    let added = 0, updated = 0, skipped = 0, removed = 0;
    db.transaction(() => {
      if (replace) {
        const sheetNames = new Set();
        for (let i = 1; i < rows.length; i++) {
          const row  = rows[i];
          const name = col(row, 'team_name', 'team name', 'team', 'name');
          if (name && !name.startsWith('_')) sheetNames.add(name.toLowerCase().trim());
        }
        for (const t of db.prepare(`SELECT id, team_name FROM teams`).all()) {
          if (!sheetNames.has(t.team_name.toLowerCase().trim())) { deleteTeam.run(t.id); removed++; }
        }
      }
      for (let i = 1; i < rows.length; i++) {
        const row      = rows[i];
        const teamName = col(row, 'team_name', 'team name', 'team', 'name');
        if (!teamName || teamName.startsWith('_')) { skipped++; continue; }
        const gcTeamUrl = col(row, 'gc_team_url', 'gc team url', 'gc_url', 'gamechanger_url', 'gamechanger team url', 'gamechanger url') || null;
        const pgTeamUrl = col(row, 'pg_team_url', 'pg team url', 'pg_url', 'perfectgame_url', 'perfect game url', 'perfect_game_url', 'perfect_game_team_url', 'perfect game team url', 'team_page', 'team page') || null;
        const existing  = findExisting.get(teamName);
        if (existing) { updateTeam.run({ id: existing.id, gcTeamUrl, pgTeamUrl }); updated++; }
        else { insertTeam.run({ teamName, gcTeamUrl, pgTeamUrl }); added++; }
      }
    })();
    db.close();

    const msg = replace
      ? `Synced ${added} new, ${updated} updated, ${removed} removed.`
      : `Synced ${added} new, ${updated} updated from sheet.`;
    res.json({ ok: true, added, updated, removed, skipped, message: msg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎯 Voodoo Scout Dashboard`);
  console.log(`   http://localhost:${PORT}\n`);
});