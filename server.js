'use strict';

require('dotenv').config();
const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const { spawn } = require('child_process');
const Database  = require('better-sqlite3');

// ── Supabase ─────────────────────────────────────────────────────────────────
const { createClient } = require('@supabase/supabase-js');
const adminClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
function getDb() { return new Database(DB_PATH, { readonly: true }); }

function getTeams() {
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

function getTeamStats(teamId) {
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

function hasGameUrls(teamId) {
  try {
    const db  = getDb();
    const row = db.prepare(`SELECT COUNT(*) as n FROM team_game_urls WHERE team_id = ?`).get(teamId);
    db.close();
    return row.n > 0;
  } catch { return false; }
}

function cleanTeamName(name) {
  return (name || '').replace(/\([\d-]+ in \d{4}\)/g, '').trim();
}

// ── Auth middleware ──────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const jwt = header.replace('Bearer ', '').trim();
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

app.get('/api/teams', requireAuth, (req, res) => {
  const teams = getTeams().map(t => ({
    ...t,
    hasGC:       !!t.gc_team_url || hasGameUrls(t.id),
    hasPG:       hasPGData(t.team_name),
    hasGameUrls: hasGameUrls(t.id),
    stats:       getTeamStats(t.id),
  }));
  res.json(teams);
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
  if (token && process.env.SUPABASE_URL) {
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
app.post('/api/run/gc-scraper', (req, res) => {
  const team = getTeams().find(t => t.id == req.body.teamId);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const id = createJob(`GC Scraper — ${team.team_name}`);
  appendLog(id, `Starting GameChanger scraper for: ${team.team_name}`);
  if (!team.gc_team_url && hasGameUrls(team.id)) {
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
app.post('/api/run/pg-scraper', (req, res) => {
  const team = getTeams().find(t => t.id == req.body.teamId);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const id = createJob(`PG Scraper — ${team.team_name}`);
  appendLog(id, `Starting Perfect Game scraper for: ${team.team_name}`);
  spawnJob(id, 'node', ['perfectgame-scraper.js', team.pg_team_url || '', team.team_name],
    path.join(ROOT, '..', 'perfectgame-scraper'));
  res.json({ jobId: id });
});

// POST /api/run/reingest
app.post('/api/run/reingest', (req, res) => {
  const team  = req.body.teamId ? getTeams().find(t => t.id == req.body.teamId) : null;
  const label = team ? `Reingest — ${team.team_name}` : 'Reingest — All Teams';
  const id    = createJob(label);
  appendLog(id, label);
  spawnJob(id, 'node', team ? ['reingest-games.js', team.team_name] : ['reingest-games.js', '--all'], ROOT);
  res.json({ jobId: id });
});

// POST /api/run/report  { teamId, gameLocation?, gameDate? }
app.post('/api/run/report', (req, res) => {
  const { teamId, gameLocation, gameDate } = req.body;
  const team = getTeams().find(t => t.id == teamId);
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
app.post('/api/run/full-pipeline', (req, res) => {
  const { teamId, gameLocation, gameDate } = req.body;
  const team = getTeams().find(t => t.id == teamId);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const id      = createJob(`Full Pipeline — ${team.team_name}`);
  const pgRoot  = path.join(ROOT, '..', 'perfectgame-scraper');
  const noGC    = !team.gc_team_url && hasGameUrls(team.id);
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
app.post('/api/run/all-gc', (req, res) => {
  const teams   = getTeams().filter(t => t.gc_team_url || hasGameUrls(t.id));
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
        if (!team.gc_team_url && hasGameUrls(team.id)) {
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
app.post('/api/run/all-pg', (req, res) => {
  const teams   = getTeams().filter(t => t.pg_team_url);
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
app.post('/api/run/all-reports', (req, res) => {
  const teams   = getTeams().filter(t => t.game_count > 0);
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
app.get('/api/teams/:id/games', requireAuth, (req, res) => {
  try {
    const db    = getDb();
    const games = db.prepare(`
      SELECT id, gc_game_id, gc_game_url, game_date, game_time,
             result, score_us, score_them, opponent_name, location, season_type
      FROM games
      WHERE team_id = ?
      ORDER BY game_date DESC
    `).all(req.params.id);
    db.close();
    res.json(games);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Team Game URLs ───────────────────────────────────────────────────────────
app.get('/api/teams/:id/game-urls', requireAuth, (req, res) => {
  try {
    const db   = getDb();
    const urls = db.prepare(`SELECT * FROM team_game_urls WHERE team_id = ? ORDER BY created_at`).all(req.params.id);
    db.close();
    res.json(urls);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/teams/:id/game-urls', (req, res) => {
  const { gc_game_url, label = '', box_side = 'away' } = req.body;
  if (!['away','home'].includes(box_side)) return res.status(400).json({ error: 'box_side must be away or home' });
  try {
    const db   = new Database(DB_PATH);
    const info = db.prepare(
      `INSERT INTO team_game_urls (team_id, gc_game_url, label, box_side) VALUES (?, ?, ?, ?)`
    ).run(req.params.id, (gc_game_url || '').trim(), label.trim(), box_side);
    db.close();
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/teams/:id/game-urls/:urlId', (req, res) => {
  const { gc_game_url, label, box_side } = req.body;
  try {
    const db = new Database(DB_PATH);
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

app.delete('/api/teams/:id/game-urls/:urlId', (req, res) => {
  try {
    const db = new Database(DB_PATH);
    db.prepare(`DELETE FROM team_game_urls WHERE id = ? AND team_id = ?`).run(req.params.urlId, req.params.id);
    db.close();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Add Team ─────────────────────────────────────────────────────────────────
app.post('/api/teams/add', (req, res) => {
  const { teamName, gcTeamUrl, pgTeamUrl } = req.body;
  if (!teamName) return res.status(400).json({ error: 'teamName is required' });
  try {
    const db       = new Database(DB_PATH);
    const existing = db.prepare(`SELECT id FROM teams WHERE LOWER(TRIM(team_name)) = LOWER(TRIM(?))`).get(teamName);
    if (existing) { db.close(); return res.status(409).json({ error: `"${teamName}" already exists (id ${existing.id})` }); }
    const info = db.prepare(`INSERT INTO teams (team_name, gc_team_url, pg_team_url) VALUES (@teamName, @gcTeamUrl, @pgTeamUrl)`)
      .run({ teamName, gcTeamUrl: gcTeamUrl || null, pgTeamUrl: pgTeamUrl || null });
    db.close();
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Sync Google Sheet ────────────────────────────────────────────────────────
app.post('/api/settings/sheet', async (req, res) => {
  const { csvUrl, replace = false } = req.body;
  if (!csvUrl || !csvUrl.includes('output=csv')) {
    return res.status(400).json({ error: 'Must be a published Google Sheet CSV URL (must contain output=csv)' });
  }
  try {
    const testFetch = await fetch(csvUrl);
    if (!testFetch.ok) return res.status(400).json({ error: `Could not fetch sheet: HTTP ${testFetch.status}.` });
    const csvText = await testFetch.text();
    if (!csvText || csvText.trim().startsWith('<!')) return res.status(400).json({ error: 'URL did not return CSV data.' });

    const envPath = path.join(ROOT, '.env');
    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    envContent = envContent.includes('TEAMS_CSV_URL=')
      ? envContent.replace(/TEAMS_CSV_URL=.*/g, `TEAMS_CSV_URL=${csvUrl}`)
      : envContent + `\nTEAMS_CSV_URL=${csvUrl}`;
    fs.writeFileSync(envPath, envContent);
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

    const db           = new Database(DB_PATH);
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