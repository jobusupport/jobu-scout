'use strict';

/**
 * pg-reader.js — Voodoo Scout Perfect Game data reader
 *
 * Reads PG scraper output and provides:
 *  - Pitcher velocity profiles (inning-by-inning)
 *  - Jersey numbers (from box score batting/pitching rows)
 *  - Spray chart data (from pg-spray-data.json)
 *  - Stats tables
 */

const fs   = require('fs');
const path = require('path');

const PG_OUTPUT_ROOT = process.env.PG_OUTPUT_ROOT ||
  path.join(__dirname, '..', 'perfectgame-scraper', 'output');

function toNum(v) {
  const n = parseFloat(String(v || '').replace(/[^\d.-]/g, ''));
  return isNaN(n) ? null : n;
}

/** "28 Luke Stembridge C" → { jersey: "28", name: "Luke Stembridge" } */
function parseJerseyName(raw) {
  const str = String(raw || '').trim();
  const m = str.match(/^(\d+)\s+(.+?)(?:\s+[A-Z]{1,2})?$/);
  if (m) return { jersey: m[1], name: m[2].trim() };
  return { jersey: null, name: str };
}

function findTeamFolder(teamName) {
  if (!fs.existsSync(PG_OUTPUT_ROOT)) return null;
  const dirs = fs.readdirSync(PG_OUTPUT_ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name);

  // Normalize: strip age/class suffixes like "14U", "14Major", "14AAA", "14U National"
  const normalize = s => s.toLowerCase()
    .replace(/\s*\d{2}[a-z]*\s*(major|national|elite|aaa|aa|select|premier)?/gi, '')
    .replace(/\s+/g, ' ').trim();

  const normTarget = normalize(teamName);
  const lower = teamName.toLowerCase();

  // 1. Exact match
  const exact = dirs.find(d => d.toLowerCase() === lower);
  if (exact) return path.join(PG_OUTPUT_ROOT, exact);

  // 2. Normalized exact match
  const normExact = dirs.find(d => normalize(d) === normTarget);
  if (normExact) return path.join(PG_OUTPUT_ROOT, normExact);

  // 3. Partial match (folder name contained in team name or vice versa)
  const partial = dirs.find(d => {
    const dl = d.toLowerCase();
    return dl.includes(lower) || lower.includes(dl) ||
           normalize(d).includes(normTarget) || normTarget.includes(normalize(d));
  });
  return partial ? path.join(PG_OUTPUT_ROOT, partial) : null;
}

// ── Jersey Numbers ────────────────────────────────────────────────────────────
// Read from GC SQLite database raw_json field (Jersey field from GameChanger)
function extractJerseyNumbers(teamFolder) {
  const GC_DB_PATH = process.env.GC_DB_PATH ||
    path.join(__dirname, '..', 'voodoo-scout.db');

  if (!fs.existsSync(GC_DB_PATH)) {
    console.log(`[pg-reader] No GC database found at ${GC_DB_PATH} — jersey numbers unavailable`);
    return {};
  }

  try {
    const Database = require('better-sqlite3');
    const db = new Database(GC_DB_PATH, { readonly: true });

    const rows = db.prepare(`
      SELECT DISTINCT player_name, raw_json
      FROM batting_lines
      WHERE is_our_team = 1 AND raw_json IS NOT NULL
      ORDER BY player_name
    `).all();
    db.close();

    const jerseyMap = {};
    for (const row of rows) {
      try {
        const raw = JSON.parse(row.raw_json);
        const jersey = raw.Jersey || raw.jersey;
        if (jersey && String(jersey).trim()) {
          jerseyMap[row.player_name] = String(jersey).trim();
        }
      } catch {}
    }
    return jerseyMap;
  } catch (err) {
    console.log(`[pg-reader] Could not read jersey numbers from DB: ${err.message}`);
    return {};
  }
}

// ── Spray Chart Data ──────────────────────────────────────────────────────────
function readSprayData(teamFolder) {
  // Try multiple possible locations for the spray data file
  const candidates = [
    path.join(teamFolder, 'pg-spray-data.json'),
    path.join(teamFolder, 'spray-charts', 'pg-spray-data.json'),
    path.join(teamFolder, 'gc-spray-data.json'),
  ];
  const sprayPath = candidates.find(p => fs.existsSync(p));
  if (!sprayPath) {
    console.log(`[pg-reader] No spray data file found. Checked:\n  ${candidates.join('\n  ')}`);
    return null;
  }
  console.log(`[pg-reader] Found spray data at: ${sprayPath}`);
  try {
    // Strip BOM if present, handle Windows encoding
    let raw = fs.readFileSync(sprayPath, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const d = JSON.parse(raw);
    const players = d.players || d.Players || [];
    if (!players.length) {
      console.log(`[pg-reader] Spray file found but players array is empty`);
      return null;
    }
    const byPlayer = {};
    for (const player of players) {
      const name = player.player || player.name || player.Player || player.Name;
      if (name) byPlayer[name] = player;
    }
    console.log(`[pg-reader] Loaded spray data for ${Object.keys(byPlayer).length} player(s)`);
    return byPlayer;
  } catch (err) {
    console.error(`[pg-reader] Failed to read spray data: ${err.message}`);
    return null;
  }
}

// ── Velocity Profiles ─────────────────────────────────────────────────────────
function buildVeloProfiles(teamFolder) {
  const gamesDir = path.join(teamFolder, 'games');
  if (!fs.existsSync(gamesDir)) return {};

  const pitcherData = {}; // name → { inningKey → [speeds] }

  for (const gameFolder of fs.readdirSync(gamesDir)) {
    const dir = path.join(gamesDir, gameFolder);
    if (!fs.statSync(dir).isDirectory()) continue;

    // Source 1: pitch-by-pitch JSONs (per-pitch speeds)
    for (const file of fs.readdirSync(dir)) {
      if (!file.startsWith('game-pitch-by-pitch-') || !file.endsWith('.json')) continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); }
      catch { continue; }

      for (const pitch of (d.pitches || [])) {
        if (!pitch.speed || !pitch.pitcher) continue;
        const name = pitch.pitcher;
        const key  = pitch.inning_label || (pitch.inning ? `Inn ${pitch.inning}` : '?');
        if (!pitcherData[name]) pitcherData[name] = {};
        if (!pitcherData[name][key]) pitcherData[name][key] = [];
        pitcherData[name][key].push(pitch.speed);
      }

      // Accept pre-summarized format too
      if (!(d.pitches || []).length && d.pitcherVeloByInning) {
        for (const [pitcher, innings] of Object.entries(d.pitcherVeloByInning)) {
          if (!pitcherData[pitcher]) pitcherData[pitcher] = {};
          for (const [inn, s] of Object.entries(innings)) {
            if (!pitcherData[pitcher][inn]) pitcherData[pitcher][inn] = [];
            for (let i = 0; i < (s.count || 1); i++) pitcherData[pitcher][inn].push(s.avg);
          }
        }
      }
    }

    // Source 2: box score fallback (avg FB per game)
    for (const file of fs.readdirSync(dir)) {
      if (!file.startsWith('game-box-score-') || !file.endsWith('.json')) continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); }
      catch { continue; }

      for (const table of (d.pitching || [])) {
        for (const row of (table.rows || [])) {
          const { name } = parseJerseyName(row.Pitching || row.Player || '');
          if (!name || name.toUpperCase() === 'TEAM') continue;
          const avgFB = toNum(row['AVG-FB']);
          if (avgFB && avgFB > 0) {
            if (!pitcherData[name]) pitcherData[name] = {};
            if (!pitcherData[name]['game_avg']) pitcherData[name]['game_avg'] = [];
            pitcherData[name]['game_avg'].push(avgFB);
          }
        }
      }
    }
  }

  // Build profiles
  const profiles = {};
  for (const [name, inningMap] of Object.entries(pitcherData)) {
    const inningKeys = Object.keys(inningMap).filter(k => k !== 'game_avg');

    // Sort inning keys: "Top 1" < "Bot 1" < "Top 2" ...
    inningKeys.sort((a, b) => {
      const parse = s => {
        const m = s.match(/(Top|Bot|Inn)\s*(\d+)/i);
        if (!m) return 999;
        const n = parseInt(m[2]) * 2 + (m[1].toLowerCase() === 'bot' ? 1 : 0);
        return n;
      };
      return parse(a) - parse(b);
    });

    const byInning = {};
    const allSpeeds = [];

    for (const key of inningKeys) {
      const velos = inningMap[key];
      if (!velos.length) continue;
      const avg = Math.round(velos.reduce((a, b) => a + b, 0) / velos.length);
      byInning[key] = { avg, max: Math.max(...velos), min: Math.min(...velos), count: velos.length };
      allSpeeds.push(...velos);
    }

    const gameAvgs = inningMap['game_avg'] || [];
    if (!allSpeeds.length && gameAvgs.length) allSpeeds.push(...gameAvgs);
    if (!allSpeeds.length) continue;

    const topFB = Math.max(...allSpeeds);
    const avgFB = Math.round(allSpeeds.reduce((a, b) => a + b, 0) / allSpeeds.length);

    // Trend: compare first vs last inning averages
    let trend = 'unknown', trendNote = null;
    if (inningKeys.length >= 2) {
      const first = byInning[inningKeys[0]]?.avg;
      const last  = byInning[inningKeys[inningKeys.length - 1]]?.avg;
      if (first && last) {
        const drop = first - last;
        if (drop >= 3) {
          trend = 'declining';
          trendNote = `Drops ~${drop} mph from ${inningKeys[0]} (${first}) to ${inningKeys[inningKeys.length-1]} (${last}) — attack late in outings`;
        } else if (drop <= -2) {
          trend = 'improving';
          trendNote = `Gains ${Math.abs(drop)} mph as outing progresses`;
        } else {
          trend = 'stable';
          trendNote = `Consistent velocity (${first}→${last} mph)`;
        }
      }
    }

    const inningStr = inningKeys.map(k => `${k}:${byInning[k].avg}`).join(' → ');
    const veloString = `FB: ${avgFB}-${topFB} mph` + (inningStr ? ` [${inningStr}]` : '');

    profiles[name] = { byInning, topFB, avgFB, trend, trendNote, veloString, hasInningData: inningKeys.length >= 2 };
  }
  return profiles;
}

// ── Stats Table ───────────────────────────────────────────────────────────────
function readStatsTable(teamFolder) {
  const statsDir = path.join(teamFolder, 'stats-tables');
  if (!fs.existsSync(statsDir)) return null;
  const files = fs.readdirSync(statsDir).filter(f => f.endsWith('-stats.json'));
  if (!files.length) return null;
  try { return JSON.parse(fs.readFileSync(path.join(statsDir, files[0]), 'utf8')); }
  catch { return null; }
}

// ── Public API ────────────────────────────────────────────────────────────────
function getPGDataForTeam(teamName) {
  const teamFolder = findTeamFolder(teamName);
  if (!teamFolder) {
    console.log(`[pg-reader] No PG output folder found for: ${teamName}`);
    return null;
  }
  console.log(`[pg-reader] Reading PG data from: ${teamFolder}`);

  const pitcherVelo = buildVeloProfiles(teamFolder);
  const jerseyMap   = extractJerseyNumbers(teamFolder);
  const sprayData   = readSprayData(teamFolder);
  const statsTable  = readStatsTable(teamFolder);

  console.log(`[pg-reader] ${Object.keys(pitcherVelo).length} pitchers, ${Object.keys(jerseyMap).length} jersey numbers, ${sprayData ? Object.keys(sprayData).length : 0} spray profiles`);

  return { pitcherVelo, jerseyMap, sprayData, statsTable, teamFolder };
}

module.exports = { getPGDataForTeam, findTeamFolder, parseJerseyName };