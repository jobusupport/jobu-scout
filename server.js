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

// ── Admin panel ──────────────────────────────────────────────────────────────
const createAdminRouter = require('./src/admin-api');
const {
  resolveSupportSession,
  blockWriteDuringReadOnlySupport,
} = require('./src/admin-lib');

// ── Product capabilities (Phase 2 Slice 1) ───────────────────────────────────
const { getOrganizationCapabilities } = require('./src/product-capabilities');

// ── Trusted organization resolution (extracted for database-free testing) ────
const { resolveTrustedOrgId, buildAcceptedMembershipsQuery, mapErrorToResponse } = require('./src/org-resolution');
const { asyncHandler, buildFinalErrorHandler } = require('./src/express-helpers');

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

// Admin panel — a separate, hand-written static page (not run through the
// dashboard bundler). Auth/authorization is re-verified client-side against
// GET /api/admin/status before it renders anything, and every /api/admin/*
// route independently requires requireAuth + requireJobuAdmin server-side.
app.get(['/admin', '/admin/*splat'], (req, res) => res.sendFile(path.join(ROOT, 'admin', 'index.html')));

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

// Thin wrapper around src/org-resolution.js's resolveTrustedOrgId -- the
// actual trust decisions, every ignored input, and every fail-closed
// branch live there now (and are unit-tested there, database-free, via
// dependency injection), specifically so that logic is exercised by the
// normal `npm test` run rather than only by gated, skipped-by-default
// integration tests. This wrapper supplies the one thing that needs a
// real database: `lookupAcceptedMemberships`, wired to the real
// adminClient (service-role -- see org-resolution.js's header comment for
// why RLS is not in play for this query) via selectSafe, exactly as
// before. It also restores the memoization the previous inline
// implementation had (`req._orgId = ...`), so a request that calls
// getRequestOrgId more than once (e.g. assertTeamInRequestOrg calling it
// after a route handler already did) still only performs the lookup once.
async function getRequestOrgId(req) {
  if (!USE_SUPABASE) return null;

  const orgId = await resolveTrustedOrgId(req, {
    lookupAcceptedMemberships: (userId) =>
      selectSafe(buildAcceptedMembershipsQuery(adminClient, userId)),
  });

  req._orgId = orgId;
  return orgId;
}

// Sends a safe error response for any error caught around a
// getRequestOrgId call (directly, or via requireOrgAdmin/
// assertTeamInRequestOrg/assertOrgActive/enforceReportQuota). Logs the
// real error in full, server-side, then maps it via
// src/org-resolution.js's mapErrorToResponse -- a typed error (with a
// `.statusCode` already set) forwards its own safe, pre-authored
// `.message`; anything else becomes a generic 500. `context` is just a
// label for the server-side log line, matching the existing
// `[module-name] description: err` convention already used elsewhere in
// this file (e.g. src/admin-lib.js's logAdminAction catch block). Always
// `return`ed by its caller so no code runs after the response is sent.
function sendResolverError(res, err, context) {
  console.error(`[${context}]`, err);
  const { statusCode, message } = mapErrorToResponse(err);
  return res.status(statusCode).json({ error: message });
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

// Blocks resource-consuming actions (report generation, scraper runs) for a
// suspended/cancelled org. Scoped to the /api/run/* trigger endpoints only —
// browsing existing data on a suspended org is intentionally still allowed
// in this pass (a full suspended-account UX is a deliberate follow-up).
async function assertOrgActive(req) {
  if (!USE_SUPABASE) return;
  const orgId = await getRequestOrgId(req);
  const org = await maybeSingleSafe(
    adminClient.from('organizations').select('status').eq('id', orgId).limit(1)
  );
  if (org && org.status !== 'active') {
    const err = new Error(
      org.status === 'suspended'
        ? 'This account is suspended. Contact support@jobuscout.com for help.'
        : 'This account is no longer active. Contact support@jobuscout.com for help.'
    );
    err.statusCode = 403;
    throw err;
  }
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
    return sendResolverError(res, err, 'requireOrgAdmin');
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

app.use('/api/admin', createAdminRouter({ requireAuth }));

// ── Auth routes ──────────────────────────────────────────────────────────────

// POST /api/auth/signup  { email, password, orgName, tier?, interval? }
// Creates a brand-new org + its first (admin) user. The org is always created
// on the free plan — for a paid tier this kicks off a Stripe Checkout Session
// and the org is upgraded by the existing webhook handler once payment
// actually completes, so paid features are never granted before payment.
//
// The new user's email is auto-confirmed at creation (no verification email)
// since the project has no custom SMTP configured yet and Supabase's default
// mailer isn't reliable for real delivery — see scripts/check-email-delivery.js.
app.post('/api/auth/signup', async (req, res) => {
  if (!HAS_SUPABASE_CONFIG) {
    return res.status(500).json({ error: 'Supabase auth is not configured on the server' });
  }
  const { email, password, orgName } = req.body || {};
  const tier = req.body?.tier || 'free';
  const interval = req.body?.interval;

  if (!email || !password || !orgName) {
    return res.status(400).json({ error: 'email, password, and orgName are required' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (!['free', 'coach', 'organization'].includes(tier)) {
    return res.status(400).json({ error: "tier must be 'free', 'coach', or 'organization'" });
  }
  if (tier !== 'free' && !priceIdFor(tier, interval)) {
    return res.status(400).json({ error: "interval must be 'month' or 'year' for a paid tier" });
  }

  let userId = null;
  let orgId = null;
  try {
    const { data: userData, error: userError } = await adminClient.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (userError) {
      const status = /already registered|already exists/i.test(userError.message) ? 409 : 400;
      return res.status(status).json({ error: userError.message });
    }
    userId = userData.user.id;

    const slug = `${slugify(orgName)}-${userId.slice(0, 6)}`;
    const { data: org, error: orgError } = await adminClient.from('organizations').insert({
      name: orgName,
      slug,
      contact_email: email,
      plan: 'free',
      ...limitsColumnsForTier('free'),
    }).select('id, name').single();
    if (orgError) throw orgError;
    orgId = org.id;

    const { error: memberError } = await adminClient.from('org_members').insert({
      org_id: orgId, user_id: userId, role: 'admin', accepted_at: new Date().toISOString(),
    });
    if (memberError) throw memberError;

    const anonClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data: signInData, error: signInError } = await anonClient.auth.signInWithPassword({ email, password });
    if (signInError) throw signInError;

    let checkoutUrl = null;
    if (tier !== 'free') {
      checkoutUrl = await startCheckoutForOrg({
        orgId, orgName: org.name, email, existingCustomerId: null, tier, interval, origin: requestOrigin(req),
      });
    }

    res.json({
      ok: true,
      accessToken: signInData.session.access_token,
      refreshToken: signInData.session.refresh_token,
      expiresAt: signInData.session.expires_at,
      user: { id: signInData.user.id, email: signInData.user.email },
      checkoutUrl,
    });
  } catch (err) {
    console.error('[auth/signup]', err);
    // Best-effort cleanup so a mid-signup failure doesn't leave an orphaned org/user behind.
    if (orgId) await adminClient.from('organizations').delete().eq('id', orgId).catch(() => {});
    if (userId) await adminClient.auth.admin.deleteUser(userId).catch(() => {});
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

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

// POST /api/auth/forgot-password  { email }
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email is required' });
  if (!HAS_SUPABASE_CONFIG) {
    return res.status(500).json({ error: 'Supabase auth is not configured on the server' });
  }
  const anonClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const redirectTo = `${requestOrigin(req)}/?reset=1`;
  const { error } = await anonClient.auth.resetPasswordForEmail(email, { redirectTo });
  // Supabase silently no-ops (no error) for an email with no matching account,
  // so there's no enumeration risk in surfacing a real error here — any error
  // means the send itself failed (rate limit, unauthorized address, SMTP
  // misconfiguration), which the caller needs to know about.
  if (error) {
    console.error('[auth/forgot-password]', error.message);
    return res.status(502).json({ error: `Could not send reset email: ${error.message}` });
  }
  res.json({ ok: true, message: 'If an account exists for that email, a reset link has been sent.' });
});

// POST /api/auth/reset-password  { accessToken, newPassword }
app.post('/api/auth/reset-password', async (req, res) => {
  const { accessToken, newPassword } = req.body || {};
  if (!accessToken || !newPassword) {
    return res.status(400).json({ error: 'accessToken and newPassword are required' });
  }
  if (String(newPassword).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (!adminClient) {
    return res.status(500).json({ error: 'Supabase auth is not configured on the server' });
  }
  const { data, error } = await adminClient.auth.getUser(accessToken);
  if (error || !data?.user) {
    return res.status(401).json({ error: 'Reset link is invalid or has expired. Request a new one.' });
  }
  const { error: updateError } = await adminClient.auth.admin.updateUserById(data.user.id, { password: newPassword });
  if (updateError) return res.status(400).json({ error: updateError.message });
  res.json({ ok: true });
});

// ── Billing (Stripe) ───────────────────────────────────────────────────────────

function requestOrigin(req) {
  return APP_URL || `${req.protocol}://${req.get('host')}`;
}

// Creates (or reuses) a Stripe customer for the org and starts a subscription
// Checkout Session. Shared by the in-app upgrade flow and signup.
async function startCheckoutForOrg({ orgId, orgName, email, existingCustomerId, tier, interval, origin }) {
  const priceId = priceIdFor(tier, interval);
  if (!priceId) {
    const err = new Error("tier must be 'coach' or 'organization' and interval must be 'month' or 'year'");
    err.statusCode = 400;
    throw err;
  }

  let customerId = existingCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email,
      name: orgName,
      metadata: { org_id: orgId },
    });
    customerId = customer.id;
    await adminClient.from('organizations').update({ stripe_customer_id: customerId }).eq('id', orgId);
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${origin}/?billing=success`,
    cancel_url: `${origin}/?billing=cancel`,
    metadata: { org_id: orgId, plan_tier: tier },
    subscription_data: { metadata: { org_id: orgId, plan_tier: tier } },
  });
  return session.url;
}

function slugify(name) {
  return String(name).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'org';
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

// Checks the org's quota for a report type against usage recorded in the
// `reports` table, then records this generation. Throws (with
// .statusCode = 403) when the quota is already used up.
//
// Free-tier orgs get a one-time (lifetime) allotment rather than a monthly
// one — the count never resets — so the quota window is only bounded to the
// current calendar month for paid tiers.
async function enforceReportQuota(req, { reportType, limitColumn, title, linkedTeamId }) {
  if (!USE_SUPABASE) return null;
  await assertOrgActive(req);
  const orgId = await getRequestOrgId(req);

  const org = await maybeSingleSafe(
    adminClient.from('organizations').select(`plan, ${limitColumn}`).eq('id', orgId).limit(1)
  );
  const limit = org?.[limitColumn] ?? 0;
  const isLifetime = org?.plan === 'free';

  let query = adminClient
    .from('reports')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('report_type', reportType);
  if (!isLifetime) query = query.gte('created_at', startOfCurrentMonthIso());

  const { count, error: countError } = await query;
  if (countError) throw countError;

  if ((count || 0) >= limit) {
    const label = reportType.replace('_', '-');
    const err = new Error(
      isLifetime
        ? `Lifetime limit reached: ${limit} ${label} report${limit === 1 ? '' : 's'} on the free plan. Upgrade your plan for more.`
        : `Monthly limit reached: ${limit} ${label} report${limit === 1 ? '' : 's'}/mo on your current plan. Upgrade your plan for more.`
    );
    err.statusCode = 403;
    throw err;
  }

  const { data: inserted, error: insertError } = await adminClient.from('reports').insert({
    org_id: orgId,
    created_by: req.user?.id || null,
    linked_team_id: linkedTeamId || null,
    report_type: reportType,
    title,
  }).select('id').single();
  if (insertError) throw insertError;
  return { reportId: inserted.id, orgId };
}

// Env vars consumed by src/analyzer.js's callClaude() to attribute AI usage
// events to the right tenant/report — the report-generation script runs as a
// spawned child process, so this is passed the same way GAME_LOCATION etc.
// already are (see buildReportContextEnv above), not via a function param.
function buildUsageEnv(req, quota) {
  const env = {};
  if (req.user?.id) env.JOBU_USAGE_USER_ID = req.user.id;
  if (quota?.orgId) env.JOBU_USAGE_ORG_ID = quota.orgId;
  if (quota?.reportId) env.JOBU_USAGE_REPORT_ID = quota.reportId;
  return env;
}

// GET /api/product/capabilities
//
// Read-only. Not called by the current dashboard -- nothing in
// dashboard-src/ references this endpoint, and no route in this file is
// gated on it yet (see src/product-capabilities.js's requireProductAccess,
// which is implemented but intentionally unmounted in Phase 2 Slice 1).
// resolveSupportSession runs first specifically so a support-view request
// resolves capabilities for the target org being supported, never the
// admin's own -- see the precedence rules in
// docs/architecture/PHASE_2_PRODUCT_CAPABILITY_RFC.md §11.
app.get('/api/product/capabilities', requireAuth, resolveSupportSession, async (req, res) => {
  try {
    const orgId = await getRequestOrgId(req);
    const capabilities = await getOrganizationCapabilities(orgId);
    res.json(capabilities);
  } catch (err) {
    // Authentication (401) and admin authorization (403) failures never
    // reach this handler; they're already handled by requireAuth and
    // requireJobuAdmin before this route runs. This branch is only for
    // organization-lookup or capability-configuration failures --
    // see sendResolverError's own comment for the forwarding rule.
    return sendResolverError(res, err, 'api/product/capabilities');
  }
});

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

    const isLifetime = org.plan === 'free';
    const monthStart = startOfCurrentMonthIso();
    const countSince = async (query) => {
      const { count, error } = await query;
      if (error) throw error;
      return count || 0;
    };
    const reportCount = (reportType) => {
      let q = adminClient.from('reports').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('report_type', reportType);
      if (!isLifetime) q = q.gte('created_at', monthStart);
      return countSince(q);
    };
    const [opponentTeams, scoutingUsed, selfScoutUsed, matchupUsed, userCount] = await Promise.all([
      countSince(adminClient.from('teams').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('is_our_team', false).eq('archived', false)),
      reportCount('opponent'),
      reportCount('self_scout'),
      reportCount('matchup'),
      countSince(adminClient.from('org_members').select('id', { count: 'exact', head: true }).eq('org_id', orgId)),
    ]);

    res.json({
      plan: org.plan,
      subscriptionStatus: org.subscription_status,
      planExpiresAt: org.plan_expires_at,
      hasBillingAccount: !!org.stripe_customer_id,
      reportLimitsAreLifetime: isLifetime,
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
    return sendResolverError(res, err, 'api/billing/status');
  }
});

// POST /api/billing/create-checkout-session  { tier: 'coach'|'organization', interval: 'month'|'year' }
app.post('/api/billing/create-checkout-session', requireAuth, requireOrgAdmin, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe is not configured on the server' });
  const { tier, interval } = req.body || {};
  try {
    const orgId = req._orgId;
    const org = await maybeSingleSafe(
      adminClient.from('organizations').select('id, name, stripe_customer_id').eq('id', orgId).limit(1)
    );
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    const url = await startCheckoutForOrg({
      orgId, orgName: org.name, email: req.user.email, existingCustomerId: org.stripe_customer_id,
      tier, interval, origin: requestOrigin(req),
    });
    res.json({ url });
  } catch (err) {
    console.error('[billing/create-checkout-session]', err);
    res.status(err.statusCode || 500).json({ error: err.message });
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

app.get('/api/teams', requireAuth, resolveSupportSession, asyncHandler(async (req, res) => {
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
    return sendResolverError(res, err, 'api/teams');
  }
}));


app.get('/api/teams/:id/summary', requireAuth, resolveSupportSession, async (req, res) => {
  try {
    if (USE_SUPABASE) await assertTeamInRequestOrg(req, req.params.id);
    res.json(await getTeamSummary(req.params.id));
  } catch (err) {
    return sendResolverError(res, err, 'api/teams/:id/summary');
  }
});

app.get('/api/reports', requireAuth, resolveSupportSession, (req, res) => res.json(getReports()));

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
app.post('/api/run/gc-scraper', requireAuth, resolveSupportSession, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
  await assertOrgActive(req);
  const team = (await getTeams(req)).find(t => t.id == req.body.teamId);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const id = createJob(`PSG Analysis — ${team.team_name}`);
  appendLog(id, `Starting PSG analysis for: ${team.team_name}`);
  if (!team.gc_team_url && await hasGameUrls(team.id)) {
    appendLog(id, `No team URL — analyzing via individual game URLs`);
    spawnJob(id, 'node', ['src/scrape-game-urls.js', `"${cleanTeamName(team.team_name)}"`], ROOT);
  } else {
    const env = {};
    if (team.gc_team_url) env.GC_TEAM_URL = team.gc_team_url;
    env.GC_TEST_TEAM_CONTAINS = team.gc_search_name || team.team_name;
    spawnJob(id, 'node', ['src/search-gamechanger-teams.js'], ROOT, env);
  }
  res.json({ jobId: id });
}));

// POST /api/run/pg-scraper
app.post('/api/run/pg-scraper', requireAuth, resolveSupportSession, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
  await assertOrgActive(req);
  const team = (await getTeams(req)).find(t => t.id == req.body.teamId);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const id = createJob(`PSP Analysis — ${team.team_name}`);
  appendLog(id, `Starting PSP analysis for: ${team.team_name}`);
  spawnJob(id, 'node', ['perfectgame-scraper.js', team.pg_team_url || '', team.team_name],
    path.join(ROOT, 'perfectgame-scraper'));
  res.json({ jobId: id });
}));

// POST /api/run/reingest
app.post('/api/run/reingest', requireAuth, resolveSupportSession, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
  await assertOrgActive(req);
  const team  = req.body.teamId ? (await getTeams(req)).find(t => t.id == req.body.teamId) : null;
  const label = team ? `Reingest — ${team.team_name}` : 'Reingest — All Teams';
  const id    = createJob(label);
  appendLog(id, label);
  spawnJob(id, 'node', team ? ['reingest-games.js', team.team_name] : ['reingest-games.js', '--all'], ROOT);
  res.json({ jobId: id });
}));

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
app.post('/api/run/report', requireAuth, resolveSupportSession, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
  const { teamId } = req.body;
  const team = (await getTeams(req)).find(t => t.id == teamId);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const title = `Report — ${team.team_name}`;
  let quota;
  try {
    quota = await enforceReportQuota(req, { reportType: 'opponent', limitColumn: 'max_reports_per_month', title, linkedTeamId: team.id });
  } catch (err) {
    return sendResolverError(res, err, 'api/run/report');
  }
  const id = createJob(title);
  appendLog(id, `Generating scouting report for: ${team.team_name}`);
  if (req.body.gameLocation) appendLog(id, `Game location: ${req.body.gameLocation}`);
  if (req.body.gameTime)     appendLog(id, `Game time: ${req.body.gameTime}`);
  if (req.body.humanObservations) appendLog(id, `Coach observations provided (${req.body.humanObservations.length} chars)`);
  if (req.body.customPrompt)      appendLog(id, `Custom prompt provided (${req.body.customPrompt.length} chars)`);
  const env = { ...buildReportContextEnv(req.body), ...buildUsageEnv(req, quota) };
  spawnJob(id, 'node', ['src/generate-report.js', team.team_name], ROOT, env);
  res.json({ jobId: id });
}));

// POST /api/run/self-scout  { gameLocation?, gameDate?, gameTime?, humanObservations?, customPrompt?, ourTeamId? }
app.post('/api/run/self-scout', requireAuth, resolveSupportSession, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
  let quota;
  try {
    quota = await enforceReportQuota(req, { reportType: 'self_scout', limitColumn: 'max_self_scout_reports_per_month', title: 'Self-Scout Report', linkedTeamId: req.body.ourTeamId });
  } catch (err) {
    return sendResolverError(res, err, 'api/run/self-scout');
  }
  const id = createJob('Self-Scout Report');
  appendLog(id, 'Generating self-scout report for our own team');
  const env = { ...buildReportContextEnv({ ...req.body, gameScope: 'self' }), ...buildUsageEnv(req, quota) };
  if (req.body.ourTeamId) env.OUR_TEAM_ID = req.body.ourTeamId;
  spawnJob(id, 'node', ['src/generate-report.js', '--self-scout'], ROOT, env);
  res.json({ jobId: id });
}));

// POST /api/run/matchup  { teamId, gameLocation?, gameDate?, gameTime?, humanObservations?, customPrompt?, ourTeamId? }
// teamId is the OPPONENT team we're building the matchup game plan against.
app.post('/api/run/matchup', requireAuth, resolveSupportSession, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
  const { teamId } = req.body;
  const team = (await getTeams(req)).find(t => t.id == teamId);
  if (!team) return res.status(404).json({ error: 'Opponent team not found' });
  let quota;
  try {
    quota = await enforceReportQuota(req, { reportType: 'matchup', limitColumn: 'max_matchup_reports_per_month', title: `Matchup — ${team.team_name}`, linkedTeamId: team.id });
  } catch (err) {
    return sendResolverError(res, err, 'api/run/matchup');
  }
  const id = createJob(`Matchup — ${team.team_name}`);
  appendLog(id, `Generating matchup report: our team vs ${team.team_name}`);
  const env = { ...buildReportContextEnv({ ...req.body, gameScope: 'matchup' }), ...buildUsageEnv(req, quota) };
  if (req.body.ourTeamId) env.OUR_TEAM_ID = req.body.ourTeamId;
  spawnJob(id, 'node', ['src/generate-report.js', '--matchup', team.team_name], ROOT, env);
  res.json({ jobId: id });
}));

// POST /api/run/full-pipeline  { teamId, gameLocation?, gameDate?, gameTime?, humanObservations?, gameScope?, customPrompt? }
app.post('/api/run/full-pipeline', requireAuth, resolveSupportSession, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
  const { teamId, gameLocation, gameDate } = req.body;
  const team = (await getTeams(req)).find(t => t.id == teamId);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  let quota;
  try {
    quota = await enforceReportQuota(req, { reportType: 'opponent', limitColumn: 'max_reports_per_month', title: `Report — ${team.team_name}`, linkedTeamId: team.id });
  } catch (err) {
    return sendResolverError(res, err, 'api/run/full-pipeline');
  }
  const id      = createJob(`Full Pipeline — ${team.team_name}`);
  const pgRoot  = path.join(ROOT, 'perfectgame-scraper');
  const noGC    = !team.gc_team_url && await hasGameUrls(team.id);
  const runStep = makeRunStep(id);
  appendLog(id, `Running full pipeline for: ${team.team_name}`);
  appendLog(id, `Steps: PSG Analysis → PSP Analysis → Reingest → Generate Report`);
  (async () => {
    try {
      appendLog(id, '── Step 1/4: PSG Analysis ──');
      if (noGC) {
        await runStep('node', ['src/scrape-game-urls.js', `"${cleanTeamName(team.team_name)}"`], ROOT);
      } else {
        const gcEnv = {};
        if (team.gc_team_url) gcEnv.GC_TEAM_URL = team.gc_team_url;
        gcEnv.GC_TEST_TEAM_CONTAINS = team.gc_search_name || team.team_name;
        await runStep('node', ['src/search-gamechanger-teams.js'], ROOT, gcEnv);
      }
      appendLog(id, '── Step 2/4: PSP Analysis ──');
      await runStep('node', ['perfectgame-scraper.js', team.pg_team_url || '', team.team_name], pgRoot);
      appendLog(id, '── Step 3/4: Reingest & Stats ──');
      await runStep('node', ['reingest-games.js', team.team_name], ROOT);
      appendLog(id, '── Step 4/4: Generate Report ──');
      const reportEnv = { ...buildReportContextEnv(req.body), ...buildUsageEnv(req, quota) };
      await runStep('node', ['src/generate-report.js', team.team_name], ROOT, reportEnv);
      finishJob(id, true, 0);
      appendLog(id, `✓ Pipeline complete for ${team.team_name}`);
    } catch (err) {
      appendLog(id, `✗ Pipeline failed: ${err.message}`);
      finishJob(id, false, 1);
    }
  })();
  res.json({ jobId: id });
}));

// POST /api/run/all-gc — scrape all teams GC
app.post('/api/run/all-gc', requireAuth, resolveSupportSession, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
  await assertOrgActive(req);
  const allTeams = await getTeams(req);
  const teamsWithUrlFlags = await Promise.all(allTeams.map(async t => ({ ...t, _hasGameUrls: await hasGameUrls(t.id) })));
  const teams   = teamsWithUrlFlags.filter(t => t.gc_team_url || t._hasGameUrls);
  if (!teams.length) return res.status(400).json({ error: 'No teams with GC URLs or game URLs' });
  const id      = createJob(`PSG Analysis — All (${teams.length} teams)`);
  const runStep = makeRunStep(id);
  appendLog(id, `Queuing PSG analysis for ${teams.length} team(s)...`);
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
}));

// POST /api/run/all-pg — scrape all teams PG
app.post('/api/run/all-pg', requireAuth, resolveSupportSession, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
  await assertOrgActive(req);
  const teams   = (await getTeams(req)).filter(t => t.pg_team_url);
  if (!teams.length) return res.status(400).json({ error: 'No teams with PG URLs' });
  const id      = createJob(`PSP Analysis — All (${teams.length} teams)`);
  const pgRoot  = path.join(ROOT, 'perfectgame-scraper');
  const runStep = makeRunStep(id);
  appendLog(id, `Queuing PSP analysis for ${teams.length} team(s)...`);
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
}));

// POST /api/run/all-reports — generate reports for all teams with games
app.post('/api/run/all-reports', requireAuth, resolveSupportSession, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
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
      let quota;
      try {
        quota = await enforceReportQuota(req, { reportType: 'opponent', limitColumn: 'max_reports_per_month', title: `Report — ${team.team_name}`, linkedTeamId: team.id });
      } catch (err) {
        // Same forwarding rule as an HTTP response, applied to this job
        // log instead: a typed error's own safe message is fine to show;
        // anything else (e.g. a raw DB error from enforceReportQuota's
        // internal count/insert calls) is replaced with a generic message
        // rather than leaked into a log the coach can read.
        appendLog(id, `✗ Stopping: ${mapErrorToResponse(err).message}`);
        quotaHit = true;
        break;
      }
      try {
        await runStep('node', ['src/generate-report.js', team.team_name], ROOT, buildUsageEnv(req, quota));
        appendLog(id, `✓ ${team.team_name} done`); done++;
      } catch (err) {
        appendLog(id, `✗ ${team.team_name} failed: ${err.message}`); failed++;
      }
    }
    finishJob(id, failed === 0 && !quotaHit, 0);
    appendLog(id, `\n── Complete: ${done} succeeded, ${failed} failed ──`);
  })();
  res.json({ jobId: id });
}));

// ── Serve dashboard ─────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'dashboard', 'index.html')));

// ── Team Games ───────────────────────────────────────────────────────────────
app.get('/api/teams/:id/games', requireAuth, resolveSupportSession, async (req, res) => {
  try {
    res.json(await getTeamGames(req.params.id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Team Game URLs ───────────────────────────────────────────────────────────
app.get('/api/teams/:id/game-urls', requireAuth, resolveSupportSession, async (req, res) => {
  try {
    res.json(await getTeamGameUrls(req.params.id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/teams/:id/game-urls', requireAuth, resolveSupportSession, blockWriteDuringReadOnlySupport, async (req, res) => {
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
  } catch (err) { return sendResolverError(res, err, 'api/teams/:id/game-urls POST'); }
});

app.put('/api/teams/:id/game-urls/:urlId', requireAuth, resolveSupportSession, blockWriteDuringReadOnlySupport, async (req, res) => {
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
  } catch (err) { return sendResolverError(res, err, 'api/teams/:id/game-urls PUT'); }
});

app.delete('/api/teams/:id/game-urls/:urlId', requireAuth, resolveSupportSession, blockWriteDuringReadOnlySupport, async (req, res) => {
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
  } catch (err) { return sendResolverError(res, err, 'api/teams/:id/game-urls DELETE'); }
});

// ── Team Roster (Players) ───────────────────────────────────────────────────
function normalizePositions(value) {
  const parts = Array.isArray(value) ? value : String(value || '').split(',');
  return parts.map(v => String(v).trim()).filter(Boolean).join(',');
}

app.get('/api/teams/:id/players', requireAuth, resolveSupportSession, async (req, res) => {
  try {
    if (USE_SUPABASE) {
      await assertTeamInRequestOrg(req, req.params.id);
      const { data, error } = await adminClient
        .from('roster_players')
        .select('*')
        .eq('team_id', req.params.id)
        .order('last_name');
      if (error) throw error;
      return res.json(data || []);
    }

    const db   = getDb();
    const rows = db.prepare(`SELECT * FROM roster_players WHERE team_id = ? ORDER BY last_name, first_name`).all(req.params.id);
    db.close();
    res.json(rows);
  } catch (err) { return sendResolverError(res, err, 'api/teams/:id/players GET'); }
});

app.post('/api/teams/:id/players', requireAuth, resolveSupportSession, blockWriteDuringReadOnlySupport, async (req, res) => {
  const { firstName, lastName, jerseyNumber, handedness, positions, isPickup, availabilityStatus, unavailableUntil, injuryReturnDate } = req.body;
  if (!firstName || !lastName) return res.status(400).json({ error: 'firstName and lastName are required' });
  if (availabilityStatus !== undefined && !['available', 'unavailable', 'injured'].includes(availabilityStatus)) {
    return res.status(400).json({ error: 'availabilityStatus must be available, unavailable, or injured' });
  }
  const status = availabilityStatus || 'available';

  try {
    if (USE_SUPABASE) {
      await assertTeamInRequestOrg(req, req.params.id);
      const { data, error } = await adminClient
        .from('roster_players')
        .insert({
          team_id: req.params.id,
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          jersey_number: jerseyNumber ? String(jerseyNumber).trim() : null,
          handedness: handedness || null,
          positions: normalizePositions(positions),
          is_pickup: !!isPickup,
          availability_status: status,
          unavailable_until: status === 'unavailable' ? (unavailableUntil || null) : null,
          injury_return_date: status === 'injured' ? (injuryReturnDate || null) : null,
        })
        .select('id')
        .single();
      if (error) throw error;
      return res.json({ ok: true, id: data.id });
    }

    const db   = new (getSQLiteDatabase())(DB_PATH);
    const info = db.prepare(`
      INSERT INTO roster_players (team_id, first_name, last_name, jersey_number, handedness, positions, is_pickup, availability_status, unavailable_until, injury_return_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id, firstName.trim(), lastName.trim(),
      jerseyNumber ? String(jerseyNumber).trim() : null,
      handedness || null, normalizePositions(positions), isPickup ? 1 : 0,
      status,
      status === 'unavailable' ? (unavailableUntil || null) : null,
      status === 'injured' ? (injuryReturnDate || null) : null
    );
    db.close();
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) { return sendResolverError(res, err, 'api/teams/:id/players POST'); }
});

app.put('/api/teams/:id/players/:playerId', requireAuth, resolveSupportSession, blockWriteDuringReadOnlySupport, async (req, res) => {
  const { firstName, lastName, jerseyNumber, handedness, positions, isPickup, availabilityStatus, unavailableUntil, injuryReturnDate } = req.body;
  if (availabilityStatus !== undefined && !['available', 'unavailable', 'injured'].includes(availabilityStatus)) {
    return res.status(400).json({ error: 'availabilityStatus must be available, unavailable, or injured' });
  }

  try {
    if (USE_SUPABASE) {
      await assertTeamInRequestOrg(req, req.params.id);
      const updates = {};
      if (firstName !== undefined)    updates.first_name    = firstName.trim();
      if (lastName !== undefined)     updates.last_name     = lastName.trim();
      if (jerseyNumber !== undefined) updates.jersey_number = jerseyNumber ? String(jerseyNumber).trim() : null;
      if (handedness !== undefined)   updates.handedness    = handedness || null;
      if (positions !== undefined)    updates.positions     = normalizePositions(positions);
      if (isPickup !== undefined)     updates.is_pickup     = !!isPickup;
      if (availabilityStatus !== undefined) {
        updates.availability_status = availabilityStatus;
        updates.unavailable_until   = availabilityStatus === 'unavailable' ? (unavailableUntil || null) : null;
        updates.injury_return_date  = availabilityStatus === 'injured'     ? (injuryReturnDate || null) : null;
      }
      const { error } = await adminClient.from('roster_players').update(updates).eq('id', req.params.playerId).eq('team_id', req.params.id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    const db       = new (getSQLiteDatabase())(DB_PATH);
    const existing = db.prepare(`SELECT * FROM roster_players WHERE id = ? AND team_id = ?`).get(req.params.playerId, req.params.id);
    if (!existing) { db.close(); return res.status(404).json({ error: 'Player not found' }); }

    const next = {
      first_name:          firstName !== undefined ? firstName.trim() : existing.first_name,
      last_name:           lastName !== undefined ? lastName.trim() : existing.last_name,
      jersey_number:       jerseyNumber !== undefined ? (jerseyNumber ? String(jerseyNumber).trim() : null) : existing.jersey_number,
      handedness:          handedness !== undefined ? (handedness || null) : existing.handedness,
      positions:           positions !== undefined ? normalizePositions(positions) : existing.positions,
      is_pickup:           isPickup !== undefined ? (isPickup ? 1 : 0) : existing.is_pickup,
      availability_status: availabilityStatus !== undefined ? availabilityStatus : existing.availability_status,
      unavailable_until:   existing.unavailable_until,
      injury_return_date:  existing.injury_return_date,
    };
    if (availabilityStatus !== undefined) {
      next.unavailable_until  = availabilityStatus === 'unavailable' ? (unavailableUntil || null) : null;
      next.injury_return_date = availabilityStatus === 'injured'     ? (injuryReturnDate || null) : null;
    }

    db.prepare(`
      UPDATE roster_players SET
        first_name = ?, last_name = ?, jersey_number = ?, handedness = ?, positions = ?,
        is_pickup = ?, availability_status = ?, unavailable_until = ?, injury_return_date = ?,
        updated_at = datetime('now')
      WHERE id = ? AND team_id = ?
    `).run(
      next.first_name, next.last_name, next.jersey_number, next.handedness, next.positions,
      next.is_pickup, next.availability_status, next.unavailable_until, next.injury_return_date,
      req.params.playerId, req.params.id
    );
    db.close();
    res.json({ ok: true });
  } catch (err) { return sendResolverError(res, err, 'api/teams/:id/players/:playerId PUT'); }
});

app.delete('/api/teams/:id/players/:playerId', requireAuth, resolveSupportSession, blockWriteDuringReadOnlySupport, async (req, res) => {
  try {
    if (USE_SUPABASE) {
      await assertTeamInRequestOrg(req, req.params.id);
      const { error } = await adminClient.from('roster_players').delete().eq('id', req.params.playerId).eq('team_id', req.params.id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    const db = new (getSQLiteDatabase())(DB_PATH);
    db.prepare(`DELETE FROM roster_players WHERE id = ? AND team_id = ?`).run(req.params.playerId, req.params.id);
    db.close();
    res.json({ ok: true });
  } catch (err) { return sendResolverError(res, err, 'api/teams/:id/players/:playerId DELETE'); }
});

// Seeds the roster from player names already captured by PSG analysis (distinct
// player_name values on this team's own side of batting/pitching lines), so a
// coach doesn't have to retype a whole lineup by hand. Skips anyone whose
// first+last name already exists on the roster; jersey/handedness/positions
// are left blank for the coach to fill in via edit.
app.post('/api/teams/:id/players/seed-from-games', requireAuth, resolveSupportSession, blockWriteDuringReadOnlySupport, async (req, res) => {
  try {
    let existingNames, distinctNames;

    if (USE_SUPABASE) {
      await assertTeamInRequestOrg(req, req.params.id);
      const { data: existing, error: exErr } = await adminClient
        .from('roster_players').select('first_name,last_name').eq('team_id', req.params.id);
      if (exErr) throw exErr;
      existingNames = new Set((existing || []).map(p => `${p.first_name} ${p.last_name}`.trim().toLowerCase()));

      const [{ data: bat, error: batErr }, { data: pit, error: pitErr }] = await Promise.all([
        adminClient.from('batting_lines').select('player_name').eq('team_id', req.params.id).eq('is_our_team', false),
        adminClient.from('pitching_lines').select('player_name').eq('team_id', req.params.id).eq('is_our_team', false),
      ]);
      if (batErr) throw batErr;
      if (pitErr) throw pitErr;
      distinctNames = [...new Set([...(bat || []), ...(pit || [])].map(r => r.player_name).filter(Boolean))];
    } else {
      const db = getDb();
      const existing = db.prepare(`SELECT first_name, last_name FROM roster_players WHERE team_id = ?`).all(req.params.id);
      existingNames = new Set(existing.map(p => `${p.first_name} ${p.last_name}`.trim().toLowerCase()));
      const rows = db.prepare(`
        SELECT DISTINCT player_name FROM batting_lines WHERE team_id = ? AND is_our_team = 0
        UNION
        SELECT DISTINCT player_name FROM pitching_lines WHERE team_id = ? AND is_our_team = 0
      `).all(req.params.id, req.params.id);
      distinctNames = rows.map(r => r.player_name).filter(Boolean);
      db.close();
    }

    const toAdd = [];
    for (const rawName of distinctNames) {
      const trimmed = rawName.trim();
      if (!trimmed || existingNames.has(trimmed.toLowerCase())) continue;
      const parts     = trimmed.split(/\s+/);
      const lastName  = parts.length > 1 ? parts.pop() : parts[0];
      const firstName = parts.length ? parts.join(' ') : lastName;
      toAdd.push({ firstName, lastName });
      existingNames.add(trimmed.toLowerCase());
    }

    if (!toAdd.length) return res.json({ ok: true, added: 0 });

    if (USE_SUPABASE) {
      const { error } = await adminClient.from('roster_players').insert(
        toAdd.map(p => ({ team_id: req.params.id, first_name: p.firstName, last_name: p.lastName }))
      );
      if (error) throw error;
    } else {
      const db   = new (getSQLiteDatabase())(DB_PATH);
      const stmt = db.prepare(`INSERT INTO roster_players (team_id, first_name, last_name) VALUES (?, ?, ?)`);
      const insertMany = db.transaction(rows => { for (const r of rows) stmt.run(req.params.id, r.firstName, r.lastName); });
      insertMany(toAdd);
      db.close();
    }

    res.json({ ok: true, added: toAdd.length });
  } catch (err) { return sendResolverError(res, err, 'api/teams/:id/players/seed-from-games'); }
});

// ── Add Team ─────────────────────────────────────────────────────────────────
app.post('/api/teams/add', requireAuth, resolveSupportSession, blockWriteDuringReadOnlySupport, async (req, res) => {
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
    return sendResolverError(res, err, 'api/teams/add');
  }
});


// ── Edit / Remove Team ───────────────────────────────────────────────────────
app.put('/api/teams/:id', requireAuth, resolveSupportSession, blockWriteDuringReadOnlySupport, async (req, res) => {
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
    return sendResolverError(res, err, 'api/teams/:id PUT');
  }
});

app.delete('/api/teams/:id', requireAuth, resolveSupportSession, blockWriteDuringReadOnlySupport, async (req, res) => {
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
    return sendResolverError(res, err, 'api/teams/:id DELETE');
  }
});

// Archive (soft-hide) or restore a team without touching games/stats.
// This is what the dashboard's "×" button calls now instead of DELETE —
// DELETE remains available but stays blocked whenever games are attached.
app.patch('/api/teams/:id/archive', requireAuth, resolveSupportSession, blockWriteDuringReadOnlySupport, async (req, res) => {
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
    return sendResolverError(res, err, 'api/teams/:id/archive PATCH');
  }
});

// ── Sync Google Sheet ────────────────────────────────────────────────────────
app.post('/api/settings/sheet', requireAuth, resolveSupportSession, blockWriteDuringReadOnlySupport, async (req, res) => {
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
    return sendResolverError(res, err, 'api/settings/sheet');
  }
});

// ── Terminal error handler ──────────────────────────────────────────────────
// Mounted after every route (required for Express to recognize a 4-arg
// function as an error handler, and for it to actually receive errors
// forwarded by asyncHandler-wrapped routes via next(err)). Catches
// anything an affected route's own local try/catch didn't -- see
// src/express-helpers.js for the full reasoning and the res.headersSent
// safety check.
app.use(buildFinalErrorHandler(mapErrorToResponse));

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎯 Voodoo Scout Dashboard`);
  console.log(`   http://localhost:${PORT}\n`);
});