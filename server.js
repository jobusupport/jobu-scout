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

// ── Stripe ───────────────────────────────────────────────────────────────────
const { stripe, priceIdFor, tierForPriceId, limitsColumnsForTier } = require('./src/stripe');
const APP_URL = process.env.APP_URL || null;

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
  path.join(ROOT, 'perfectgame-scraper', 'output');

app.set('trust proxy', true);
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
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
  jobs[id].pid        = null;
}

function attachJobProcess(id, proc) {
  if (!jobs[id]) return;
  jobs[id].pid  = proc.pid;
  jobs[id].proc = proc;
}

function stopJobProcess(job) {
  if (!job || !job.proc || !job.pid) return false;

  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(job.pid), '/f', '/t'], { shell: true });
    return true;
  }

  // Child processes are spawned detached on Linux so this kills the whole
  // Playwright/Node process group, not just the parent node process.
  try {
    process.kill(-job.pid, 'SIGTERM');
  } catch {
    try { process.kill(job.pid, 'SIGTERM'); } catch {}
  }

  setTimeout(() => {
    if (job.status === 'running' && job.pid) {
      try { process.kill(-job.pid, 'SIGKILL'); } catch { try { process.kill(job.pid, 'SIGKILL'); } catch {} }
    }
  }, 5000).unref?.();

  return true;
}

function spawnJob(id, cmd, args, cwd, env = {}) {
  const proc = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    shell: false,
    detached: process.platform !== 'win32',
  });
  attachJobProcess(id, proc);
  const onData = chunk => String(chunk).split('\n').filter(Boolean).forEach(l => appendLog(id, l));
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('close', code => {
    if (jobs[id]?.stopping) return finishJob(id, false, -1);
    finishJob(id, code === 0, code);
  });
  return proc;
}

// Shared runStep factory for sequential multi-team jobs
function makeRunStep(id) {
  return function runStep(cmd, args, cwd, env = {}) {
    return new Promise((resolve, reject) => {
      if (jobs[id]?.stopping) return reject(new Error('Job stopped by user'));

      const proc = spawn(cmd, args, {
        cwd,
        shell: false,
        env: { ...process.env, ...env },
        detached: process.platform !== 'win32',
      });
      attachJobProcess(id, proc);
      const onData = chunk => String(chunk).split('\n').filter(Boolean).forEach(l => appendLog(id, l));
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('close', code => {
        if (jobs[id]?.stopping) return reject(new Error('Job stopped by user'));
        jobs[id].proc = null;
        jobs[id].pid  = null;
        return code === 0 ? resolve() : reject(new Error(`Exit ${code}`));
      });
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

async function getTeams(req = null, includeArchived = false) {
  if (USE_SUPABASE) {
    const orgId = await getRequestOrgId(req);

    let query = adminClient
      .from('teams')
      .select('*')
      .eq('org_id', orgId)
      .order('team_name');
    if (!includeArchived) query = query.eq('archived', false);

    const { data: teams, error } = await query;

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
      ${includeArchived ? '' : 'WHERE (t.archived = 0 OR t.archived IS NULL)'}
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


async function getTeamSummary(teamId) {
  if (USE_SUPABASE) {
    const [gamesRes, playsRes, battersRes] = await Promise.all([
      adminClient
        .from('games')
        .select('id, game_date, result')
        .eq('team_id', teamId),
      adminClient
        .from('play_events')
        .select('id', { count: 'exact', head: true })
        .eq('team_id', teamId),
      adminClient
        .from('batting_lines')
        .select('player_name')
        .eq('team_id', teamId)
        .eq('is_our_team', false),
    ]);

    if (gamesRes.error) throw gamesRes.error;
    if (playsRes.error) throw playsRes.error;
    if (battersRes.error) throw battersRes.error;

    const games = gamesRes.data || [];
    const normResult = value => String(value || '').trim().toUpperCase();
    const lastGame = games
      .map(g => g.game_date)
      .filter(Boolean)
      .sort()
      .pop() || null;

    return {
      games: games.length,
      wins: games.filter(g => normResult(g.result) === 'W').length,
      losses: games.filter(g => normResult(g.result) === 'L').length,
      ties: games.filter(g => normResult(g.result) === 'T').length,
      last_game: lastGame,
      plays: playsRes.count || 0,
      batters: new Set((battersRes.data || []).map(b => b.player_name).filter(Boolean)).size,
    };
  }

  const db = getDb();
  try {
    const games = db.prepare(`SELECT game_date, result FROM games WHERE team_id = ?`).all(teamId);
    const plays = db.prepare(`SELECT COUNT(*) as n FROM play_events WHERE team_id = ?`).get(teamId)?.n || 0;
    const batters = db.prepare(`SELECT COUNT(DISTINCT player_name) as n FROM batting_lines WHERE team_id = ? AND is_our_team = 0`).get(teamId)?.n || 0;
    const normResult = value => String(value || '').trim().toUpperCase();
    const lastGame = games.map(g => g.game_date).filter(Boolean).sort().pop() || null;
    return {
      games: games.length,
      wins: games.filter(g => normResult(g.result) === 'W').length,
      losses: games.filter(g => normResult(g.result) === 'L').length,
      ties: games.filter(g => normResult(g.result) === 'T').length,
      last_game: lastGame,
      plays,
      batters,
    };
  } finally {
    db.close();
  }
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

async function getRequestOrgRole(req, orgId) {
  if (!USE_SUPABASE || !req.user?.id) return null;
  const member = await maybeSingleSafe(
    adminClient.from('org_members').select('role').eq('org_id', orgId).eq('user_id', req.user.id).limit(1)
  );
  return member?.role || null;
}

async function requireOrgAdmin(req, res, next) {
  try {
    const orgId = await getRequestOrgId(req);
    const role = await getRequestOrgRole(req, orgId);
    if (role !== 'admin') {
      return res.status(403).json({ error: 'Only an organization admin can manage billing.' });
    }
    req._orgId = orgId;
    next();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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

// ── Billing (Stripe) ───────────────────────────────────────────────────────────

function requestOrigin(req) {
  return APP_URL || `${req.protocol}://${req.get('host')}`;
}

// API versions 2023-08-16+ moved current_period_end off the top-level
// Subscription object and onto each subscription item.
function subscriptionPeriodEnd(subscription) {
  const seconds = subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end;
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

async function findOrgIdFromStripeIds({ orgIdHint, customerId, subscriptionId }) {
  if (orgIdHint) return orgIdHint;
  if (subscriptionId) {
    const row = await maybeSingleSafe(
      adminClient.from('organizations').select('id').eq('stripe_subscription_id', subscriptionId).limit(1)
    );
    if (row?.id) return row.id;
  }
  if (customerId) {
    const row = await maybeSingleSafe(
      adminClient.from('organizations').select('id').eq('stripe_customer_id', customerId).limit(1)
    );
    if (row?.id) return row.id;
  }
  return null;
}

function startOfCurrentMonthIso() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// Checks the org's monthly quota for a report type against usage recorded in
// the `reports` table, then records this generation. Throws (with
// .statusCode = 403) when the quota is already used up.
async function enforceReportQuota(req, { reportType, limitColumn, title, linkedTeamId }) {
  if (!USE_SUPABASE) return;
  const orgId = await getRequestOrgId(req);

  const org = await maybeSingleSafe(
    adminClient.from('organizations').select(limitColumn).eq('id', orgId).limit(1)
  );
  const limit = org?.[limitColumn] ?? 0;

  const { count, error: countError } = await adminClient
    .from('reports')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('report_type', reportType)
    .gte('created_at', startOfCurrentMonthIso());
  if (countError) throw countError;

  if ((count || 0) >= limit) {
    const label = reportType.replace('_', '-');
    const err = new Error(`Monthly limit reached: ${limit} ${label} report${limit === 1 ? '' : 's'}/mo on your current plan. Upgrade your plan for more.`);
    err.statusCode = 403;
    throw err;
  }

  const { error: insertError } = await adminClient.from('reports').insert({
    org_id: orgId,
    created_by: req.user?.id || null,
    linked_team_id: linkedTeamId || null,
    report_type: reportType,
    title,
  });
  if (insertError) throw insertError;
}

// GET /api/billing/status
app.get('/api/billing/status', requireAuth, async (req, res) => {
  try {
    const orgId = await getRequestOrgId(req);
    const role = await getRequestOrgRole(req, orgId);
    const org = await maybeSingleSafe(
      adminClient.from('organizations')
        .select('plan, subscription_status, plan_expires_at, stripe_customer_id, max_opponent_teams, max_reports_per_month, max_self_scout_reports_per_month, max_matchup_reports_per_month, max_users')
        .eq('id', orgId).limit(1)
    );
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    const monthStart = startOfCurrentMonthIso();
    const countSince = async (query) => {
      const { count, error } = await query;
      if (error) throw error;
      return count || 0;
    };
    const [opponentTeams, scoutingUsed, selfScoutUsed, matchupUsed, userCount] = await Promise.all([
      countSince(adminClient.from('teams').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('is_our_team', false).eq('archived', false)),
      countSince(adminClient.from('reports').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('report_type', 'opponent').gte('created_at', monthStart)),
      countSince(adminClient.from('reports').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('report_type', 'self_scout').gte('created_at', monthStart)),
      countSince(adminClient.from('reports').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('report_type', 'matchup').gte('created_at', monthStart)),
      countSince(adminClient.from('org_members').select('id', { count: 'exact', head: true }).eq('org_id', orgId)),
    ]);

    res.json({
      plan: org.plan,
      subscriptionStatus: org.subscription_status,
      planExpiresAt: org.plan_expires_at,
      hasBillingAccount: !!org.stripe_customer_id,
      limits: {
        maxOpponentTeams: org.max_opponent_teams,
        maxReportsPerMonth: org.max_reports_per_month,
        maxSelfScoutReportsPerMonth: org.max_self_scout_reports_per_month,
        maxMatchupReportsPerMonth: org.max_matchup_reports_per_month,
        maxUsers: org.max_users,
      },
      usage: {
        opponentTeams,
        scoutingReportsThisMonth: scoutingUsed,
        selfScoutReportsThisMonth: selfScoutUsed,
        matchupReportsThisMonth: matchupUsed,
        userCount,
      },
      canManageBilling: role === 'admin',
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/billing/create-checkout-session  { tier: 'coach'|'organization', interval: 'month'|'year' }
app.post('/api/billing/create-checkout-session', requireAuth, requireOrgAdmin, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe is not configured on the server' });
  const { tier, interval } = req.body || {};
  const priceId = priceIdFor(tier, interval);
  if (!priceId) {
    return res.status(400).json({ error: "tier must be 'coach' or 'organization' and interval must be 'month' or 'year'" });
  }
  try {
    const orgId = req._orgId;
    const org = await maybeSingleSafe(
      adminClient.from('organizations').select('id, name, stripe_customer_id').eq('id', orgId).limit(1)
    );
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    let customerId = org.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        name: org.name,
        metadata: { org_id: orgId },
      });
      customerId = customer.id;
      await adminClient.from('organizations').update({ stripe_customer_id: customerId }).eq('id', orgId);
    }

    const origin = requestOrigin(req);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/?billing=success`,
      cancel_url: `${origin}/?billing=cancel`,
      metadata: { org_id: orgId, plan_tier: tier },
      subscription_data: { metadata: { org_id: orgId, plan_tier: tier } },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[billing/create-checkout-session]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/create-portal-session
app.post('/api/billing/create-portal-session', requireAuth, requireOrgAdmin, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe is not configured on the server' });
  try {
    const orgId = req._orgId;
    const org = await maybeSingleSafe(
      adminClient.from('organizations').select('stripe_customer_id').eq('id', orgId).limit(1)
    );
    if (!org?.stripe_customer_id) {
      return res.status(400).json({ error: 'This organization has no billing account yet. Subscribe to a plan first.' });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: org.stripe_customer_id,
      return_url: requestOrigin(req),
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[billing/create-portal-session]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/webhooks/stripe — Stripe signature verification requires the raw body,
// captured via the express.json() `verify` hook above (req.rawBody).
app.post('/api/webhooks/stripe', async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).send('Stripe webhook is not configured on the server');
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhooks/stripe] signature verification failed:', err.message);
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  try {
    // Check-then-process-then-record: the dedupe row is only written after
    // processing succeeds, so a mid-processing crash lets Stripe's retry
    // reprocess the event instead of silently deduping a half-applied one.
    const already = await maybeSingleSafe(
      adminClient.from('stripe_webhook_events').select('id').eq('id', event.id).limit(1)
    );
    if (already) return res.json({ received: true, deduped: true });

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode === 'subscription' && session.subscription) {
          const orgId = await findOrgIdFromStripeIds({
            orgIdHint: session.metadata?.org_id,
            customerId: session.customer,
          });
          if (orgId) {
            const subscription = await stripe.subscriptions.retrieve(session.subscription);
            const tier = tierForPriceId(subscription.items.data[0]?.price?.id) || session.metadata?.plan_tier || 'coach';
            await adminClient.from('organizations').update({
              plan: tier,
              stripe_customer_id: session.customer,
              stripe_subscription_id: subscription.id,
              subscription_status: subscription.status,
              plan_expires_at: subscriptionPeriodEnd(subscription),
              ...limitsColumnsForTier(tier),
            }).eq('id', orgId);
          } else {
            console.error('[webhooks/stripe] checkout.session.completed: could not resolve org_id', session.id);
          }
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const orgId = await findOrgIdFromStripeIds({
          orgIdHint: subscription.metadata?.org_id,
          customerId: subscription.customer,
          subscriptionId: subscription.id,
        });
        if (orgId) {
          const tier = tierForPriceId(subscription.items.data[0]?.price?.id);
          await adminClient.from('organizations').update({
            ...(tier ? { plan: tier, ...limitsColumnsForTier(tier) } : {}),
            stripe_subscription_id: subscription.id,
            subscription_status: subscription.status,
            plan_expires_at: subscriptionPeriodEnd(subscription),
          }).eq('id', orgId);
        } else {
          console.error('[webhooks/stripe] customer.subscription.updated: could not resolve org_id', subscription.id);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const orgId = await findOrgIdFromStripeIds({
          orgIdHint: subscription.metadata?.org_id,
          customerId: subscription.customer,
          subscriptionId: subscription.id,
        });
        if (orgId) {
          await adminClient.from('organizations').update({
            plan: 'free',
            stripe_subscription_id: null,
            subscription_status: 'canceled',
            plan_expires_at: null,
            ...limitsColumnsForTier('free'),
          }).eq('id', orgId);
        } else {
          console.error('[webhooks/stripe] customer.subscription.deleted: could not resolve org_id', subscription.id);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const orgId = await findOrgIdFromStripeIds({ customerId: invoice.customer });
        if (orgId) {
          await adminClient.from('organizations').update({ subscription_status: 'past_due' }).eq('id', orgId);
        }
        break;
      }

      default:
        break;
    }

    const { error: insertError } = await adminClient
      .from('stripe_webhook_events')
      .insert({ id: event.id, type: event.type });
    if (insertError && insertError.code !== '23505') throw insertError;

    res.json({ received: true });
  } catch (err) {
    console.error('[webhooks/stripe] handler error:', err);
    res.status(500).json({ error: err.message });
  }
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
    const includeArchived = req.query.includeArchived === 'true';
    const rawTeams = await getTeams(req, includeArchived);
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


app.get('/api/teams/:id/summary', requireAuth, async (req, res) => {
  try {
    if (USE_SUPABASE) await assertTeamInRequestOrg(req, req.params.id);
    res.json(await getTeamSummary(req.params.id));
  } catch (err) {
    console.error('[api/teams/:id/summary]', err);
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

  job.stopping = true;
  appendLog(req.params.id, '✗ Stop requested by user');

  try {
    const stopped = stopJobProcess(job);
    if (!stopped) appendLog(req.params.id, 'No active child process was attached to this job.');
    finishJob(req.params.id, false, -1);
    return res.json({ ok: true, stopped });
  } catch (err) {
    appendLog(req.params.id, `Stop failed: ${err.message}`);
    finishJob(req.params.id, false, -1);
    return res.status(500).json({ error: err.message });
  }
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
    path.join(ROOT, 'perfectgame-scraper'));
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

// Shared env-var builder for the coach-context fields every /api/run/*
// report-generating route now accepts: gameLocation, gameDate, gameTime,
// humanObservations, gameScope, customPrompt. gameScope is informational
// (which endpoint was used drives actual behavior) but is passed through so
// generate-report.js can log/echo it.
function buildReportContextEnv(body = {}) {
  const { gameLocation, gameDate, gameTime, humanObservations, gameScope, customPrompt } = body;
  const env = {};
  if (gameLocation)      env.GAME_LOCATION      = gameLocation;
  if (gameDate)           env.GAME_DATE          = gameDate;
  if (gameTime)           env.GAME_TIME          = gameTime;
  if (humanObservations)  env.HUMAN_OBSERVATIONS = humanObservations;
  if (gameScope)          env.GAME_SCOPE         = gameScope;
  if (customPrompt)       env.CUSTOM_PROMPT      = customPrompt;
  return env;
}

// POST /api/run/report  { teamId, gameLocation?, gameDate?, gameTime?, humanObservations?, gameScope?, customPrompt? }
app.post('/api/run/report', requireAuth, async (req, res) => {
  const { teamId } = req.body;
  const team = (await getTeams(req)).find(t => t.id == teamId);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const title = `Report — ${team.team_name}`;
  try {
    await enforceReportQuota(req, { reportType: 'opponent', limitColumn: 'max_reports_per_month', title, linkedTeamId: team.id });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
  const id = createJob(title);
  appendLog(id, `Generating scouting report for: ${team.team_name}`);
  if (req.body.gameLocation) appendLog(id, `Game location: ${req.body.gameLocation}`);
  if (req.body.gameTime)     appendLog(id, `Game time: ${req.body.gameTime}`);
  if (req.body.humanObservations) appendLog(id, `Coach observations provided (${req.body.humanObservations.length} chars)`);
  if (req.body.customPrompt)      appendLog(id, `Custom prompt provided (${req.body.customPrompt.length} chars)`);
  const env = buildReportContextEnv(req.body);
  spawnJob(id, 'node', ['src/generate-report.js', team.team_name], ROOT, env);
  res.json({ jobId: id });
});

// POST /api/run/self-scout  { gameLocation?, gameDate?, gameTime?, humanObservations?, customPrompt?, ourTeamId? }
app.post('/api/run/self-scout', requireAuth, async (req, res) => {
  try {
    await enforceReportQuota(req, { reportType: 'self_scout', limitColumn: 'max_self_scout_reports_per_month', title: 'Self-Scout Report', linkedTeamId: req.body.ourTeamId });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
  const id = createJob('Self-Scout Report');
  appendLog(id, 'Generating self-scout report for our own team');
  const env = buildReportContextEnv({ ...req.body, gameScope: 'self' });
  if (req.body.ourTeamId) env.OUR_TEAM_ID = req.body.ourTeamId;
  spawnJob(id, 'node', ['src/generate-report.js', '--self-scout'], ROOT, env);
  res.json({ jobId: id });
});

// POST /api/run/matchup  { teamId, gameLocation?, gameDate?, gameTime?, humanObservations?, customPrompt?, ourTeamId? }
// teamId is the OPPONENT team we're building the matchup game plan against.
app.post('/api/run/matchup', requireAuth, async (req, res) => {
  const { teamId } = req.body;
  const team = (await getTeams(req)).find(t => t.id == teamId);
  if (!team) return res.status(404).json({ error: 'Opponent team not found' });
  try {
    await enforceReportQuota(req, { reportType: 'matchup', limitColumn: 'max_matchup_reports_per_month', title: `Matchup — ${team.team_name}`, linkedTeamId: team.id });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
  const id = createJob(`Matchup — ${team.team_name}`);
  appendLog(id, `Generating matchup report: our team vs ${team.team_name}`);
  const env = buildReportContextEnv({ ...req.body, gameScope: 'matchup' });
  if (req.body.ourTeamId) env.OUR_TEAM_ID = req.body.ourTeamId;
  spawnJob(id, 'node', ['src/generate-report.js', '--matchup', team.team_name], ROOT, env);
  res.json({ jobId: id });
});

// POST /api/run/full-pipeline  { teamId, gameLocation?, gameDate?, gameTime?, humanObservations?, gameScope?, customPrompt? }
app.post('/api/run/full-pipeline', requireAuth, async (req, res) => {
  const { teamId, gameLocation, gameDate } = req.body;
  const team = (await getTeams(req)).find(t => t.id == teamId);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  try {
    await enforceReportQuota(req, { reportType: 'opponent', limitColumn: 'max_reports_per_month', title: `Report — ${team.team_name}`, linkedTeamId: team.id });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
  const id      = createJob(`Full Pipeline — ${team.team_name}`);
  const pgRoot  = path.join(ROOT, 'perfectgame-scraper');
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
      const reportEnv = buildReportContextEnv(req.body);
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
  const pgRoot  = path.join(ROOT, 'perfectgame-scraper');
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
    let done = 0, failed = 0, quotaHit = false;
    for (const team of teams) {
      if (jobs[id]?.status !== 'running') break;
      appendLog(id, `\n── [${done+failed+1}/${teams.length}] ${team.team_name} ──`);
      try {
        await enforceReportQuota(req, { reportType: 'opponent', limitColumn: 'max_reports_per_month', title: `Report — ${team.team_name}`, linkedTeamId: team.id });
      } catch (err) {
        appendLog(id, `✗ Stopping: ${err.message}`);
        quotaHit = true;
        break;
      }
      try {
        await runStep('node', ['src/generate-report.js', team.team_name], ROOT);
        appendLog(id, `✓ ${team.team_name} done`); done++;
      } catch (err) {
        appendLog(id, `✗ ${team.team_name} failed: ${err.message}`); failed++;
      }
    }
    finishJob(id, failed === 0 && !quotaHit, 0);
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
  const { teamName, gcTeamUrl, pgTeamUrl, isOurTeam, seasonYear, seasonType } = req.body;
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

      if (!isOurTeam) {
        const org = await maybeSingleSafe(
          adminClient.from('organizations').select('max_opponent_teams').eq('id', orgId).limit(1)
        );
        const { count, error: countError } = await adminClient
          .from('teams')
          .select('id', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .eq('is_our_team', false)
          .eq('archived', false);
        if (countError) throw countError;
        const limit = org?.max_opponent_teams ?? 0;
        if ((count || 0) >= limit) {
          return res.status(403).json({
            error: `Opponent team limit reached: ${limit} on your current plan. Upgrade your plan or archive an existing team to add more.`,
          });
        }
      }

      const { data, error } = await adminClient
        .from('teams')
        .insert({
          org_id: orgId,
          team_name: teamName.trim(),
          gc_team_url: gcTeamUrl || null,
          pg_team_url: pgTeamUrl || null,
          is_our_team: !!isOurTeam,
          season_year: seasonYear || null,
          season_type: seasonType || null,
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


// ── Edit / Remove Team ───────────────────────────────────────────────────────
app.put('/api/teams/:id', requireAuth, async (req, res) => {
  const { teamName, gcTeamUrl, pgTeamUrl, seasonYear, seasonType } = req.body;
  const teamId = req.params.id;

  if (!teamName || !String(teamName).trim()) {
    return res.status(400).json({ error: 'teamName is required' });
  }

  try {
    if (USE_SUPABASE) {
      const orgId = await getRequestOrgId(req);
      await assertTeamInRequestOrg(req, teamId);

      const { data: existingName, error: nameError } = await adminClient
        .from('teams')
        .select('id')
        .eq('org_id', orgId)
        .ilike('team_name', String(teamName).trim())
        .neq('id', teamId)
        .maybeSingle();

      if (nameError) throw nameError;
      if (existingName) {
        return res.status(409).json({ error: `Another opponent already uses the name "${teamName}".` });
      }

      const updates = {
        team_name: String(teamName).trim(),
        gc_team_url: gcTeamUrl ? String(gcTeamUrl).trim() : null,
        pg_team_url: pgTeamUrl ? String(pgTeamUrl).trim() : null,
        updated_at: new Date().toISOString(),
      };
      // Only touch season_year/season_type when explicitly provided (the
      // Opponent edit modal doesn't send these; the My Team edit modal does).
      if (seasonYear !== undefined) updates.season_year = seasonYear || null;
      if (seasonType !== undefined) updates.season_type = seasonType || null;

      const { error } = await adminClient
        .from('teams')
        .update(updates)
        .eq('id', teamId)
        .eq('org_id', orgId);

      if (error) throw error;
      return res.json({ ok: true });
    }

    const db = new (getSQLiteDatabase())(DB_PATH);
    const existing = db.prepare(`SELECT id FROM teams WHERE LOWER(TRIM(team_name)) = LOWER(TRIM(?)) AND id <> ?`).get(teamName, teamId);
    if (existing) { db.close(); return res.status(409).json({ error: `Another opponent already uses the name "${teamName}".` }); }
    db.prepare(`UPDATE teams SET team_name = ?, gc_team_url = ?, pg_team_url = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(String(teamName).trim(), gcTeamUrl || null, pgTeamUrl || null, teamId);
    db.close();
    return res.json({ ok: true });
  } catch (err) {
    console.error('[api/teams/:id PUT]', err);
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/teams/:id', requireAuth, async (req, res) => {
  const teamId = req.params.id;

  try {
    if (USE_SUPABASE) {
      const orgId = await getRequestOrgId(req);
      await assertTeamInRequestOrg(req, teamId);

      const { count: gameCount, error: gamesError } = await adminClient
        .from('games')
        .select('id', { count: 'exact', head: true })
        .eq('team_id', teamId);
      if (gamesError) throw gamesError;

      if ((gameCount || 0) > 0) {
        return res.status(409).json({
          error: `This opponent has ${gameCount} game(s) attached. Remove is blocked to protect scouting history.`,
        });
      }

      await adminClient.from('team_game_urls').delete().eq('team_id', teamId);
      const { error } = await adminClient
        .from('teams')
        .delete()
        .eq('id', teamId)
        .eq('org_id', orgId);
      if (error) throw error;
      return res.json({ ok: true });
    }

    const db = new (getSQLiteDatabase())(DB_PATH);
    const gameCount = db.prepare(`SELECT COUNT(*) AS n FROM games WHERE team_id = ?`).get(teamId)?.n || 0;
    if (gameCount > 0) { db.close(); return res.status(409).json({ error: `This opponent has ${gameCount} game(s) attached. Remove is blocked to protect scouting history.` }); }
    db.prepare(`DELETE FROM team_game_urls WHERE team_id = ?`).run(teamId);
    db.prepare(`DELETE FROM teams WHERE id = ?`).run(teamId);
    db.close();
    return res.json({ ok: true });
  } catch (err) {
    console.error('[api/teams/:id DELETE]', err);
    return res.status(500).json({ error: err.message });
  }
});

// Archive (soft-hide) or restore a team without touching games/stats.
// This is what the dashboard's "×" button calls now instead of DELETE —
// DELETE remains available but stays blocked whenever games are attached.
app.patch('/api/teams/:id/archive', requireAuth, async (req, res) => {
  const teamId = req.params.id;
  const archived = req.body?.archived !== false; // default true

  try {
    if (USE_SUPABASE) {
      const orgId = await getRequestOrgId(req);
      await assertTeamInRequestOrg(req, teamId);

      const { error } = await adminClient
        .from('teams')
        .update({ archived, updated_at: new Date().toISOString() })
        .eq('id', teamId)
        .eq('org_id', orgId);
      if (error) throw error;
      return res.json({ ok: true, archived });
    }

    const db = new (getSQLiteDatabase())(DB_PATH);
    db.prepare(`UPDATE teams SET archived = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(archived ? 1 : 0, teamId);
    db.close();
    return res.json({ ok: true, archived });
  } catch (err) {
    console.error('[api/teams/:id/archive PATCH]', err);
    return res.status(500).json({ error: err.message });
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