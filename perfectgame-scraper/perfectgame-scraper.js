require("dotenv").config();

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { chromium } = require("playwright");
const { scrapeTeamSprayData } = require("./pg-spray-scraper");
const { buildTeamSprayData }  = require("./gc-spray-engine");
// For SQLite access (gc-spray-engine needs the GC database):
const sqlite3 = require("sqlite3").verbose();
const GC_DB_PATH = process.env.GC_DB_PATH ||
  require("path").join(__dirname, "../gamechanger-scraper/database/gamechanger.db");

function isLikelyPerfectGameTeamUrl(value) {
  const v = String(value || "").trim();
  if (!v) return false;
  if (/perfectgame\.org/i.test(v)) return true;
  if (/^\/.*(team|teams).*?(team=|teamid=|id=)/i.test(v)) return true;
  if (/^(team|teams)\/.*?(team=|teamid=|id=)/i.test(v)) return true;
  return false;
}

const CLI_ARGS = process.argv.slice(2);
const CLI_SINGLE_TEAM_URL = isLikelyPerfectGameTeamUrl(CLI_ARGS[0]) ? CLI_ARGS[0] : "";
const CLI_SINGLE_TEAM_NAME = CLI_SINGLE_TEAM_URL ? (CLI_ARGS[1] || "") : "";
const ENV_SINGLE_TEAM_URL = isLikelyPerfectGameTeamUrl(process.env.PG_TEAM_URL) ? process.env.PG_TEAM_URL : "";
  
const AUTH_FILE = path.join(__dirname, "perfectgame-auth.json");
const OUTPUT_ROOT = path.join(__dirname, "output");

// Run-state files do not belong in the team output folders.
// Keep screenshots and scouting artifacts in ./output, and keep cache/log/state here.
const RUN_STATE_ROOT = process.env.PG_RUN_STATE_DIR
  ? path.resolve(process.env.PG_RUN_STATE_DIR)
  : path.join(__dirname, "perfectgame-run-state");

const TEAM_URLS_FILE = path.join(RUN_STATE_ROOT, "Team URLs.txt");
const PROCESSED_GAMES_FILE = path.join(RUN_STATE_ROOT, "processed-games.json");
const FAILED_TEAMS_DIR = path.join(RUN_STATE_ROOT, "failed-teams");
const FAILED_TEAMS_FILE = path.join(FAILED_TEAMS_DIR, "failed-teams.txt");
const FAILED_GAMES_DIR = path.join(RUN_STATE_ROOT, "failed-games");

const DEFAULT_SINGLE_TEAM_URL =
  CLI_SINGLE_TEAM_URL ||
  ENV_SINGLE_TEAM_URL ||
  "";

const DEFAULT_SINGLE_TEAM_NAME =
  CLI_SINGLE_TEAM_NAME ||
  process.env.PG_TEAM_NAME ||
  "";

const TEAMS_CSV =
  process.env.PG_TEAMS_CSV ||
  (CLI_SINGLE_TEAM_URL ? CLI_ARGS[2] : CLI_ARGS[0]) ||
  path.join(__dirname, "teams.csv");

// Same Google Sheet CSV source used by the GameChanger scraper.
// Put this in the Perfect Game .env too, or run this scraper from a folder whose .env already has it.
const GOOGLE_SHEET_CSV_URL = process.env.GOOGLE_SHEET_CSV_URL || "";

const HEADLESS = String(process.env.PG_HEADLESS || "false").toLowerCase() === "true";
const FORCE_REFRESH = String(process.env.PG_FORCE_REFRESH || "false").toLowerCase() === "true";

const TARGET_YEAR = process.env.PG_TARGET_YEAR || "2026";

const VIEWPORT = {
  width: Number(process.env.PG_VIEWPORT_WIDTH || 1600),
  height: Number(process.env.PG_VIEWPORT_HEIGHT || 1200)
};

function envMs(name, defaultValue = 0) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

// Timing is now controlled from .env. Defaults are intentionally light.
// Increase these values in .env when PG is slow or screenshots are inconsistent.
const SPRAY_CLICK_DELAY_MS = envMs("PG_SPRAY_CLICK_DELAY_MS", 0);
const SPRAY_RENDER_DELAY_MS = envMs("PG_SPRAY_RENDER_DELAY_MS", 0);
const SPRAY_CLOSE_DELAY_MS = envMs("PG_SPRAY_CLOSE_DELAY_MS", 0);
const STATS_VIEW_DELAY_MS = envMs("PG_STATS_VIEW_DELAY_MS", 0);
const PITCH_BY_PITCH_SLICE_DELAY_MS = envMs("PG_PITCH_BY_PITCH_SLICE_DELAY_MS", 0);
const PITCH_BY_PITCH_SLICE_HEIGHT = Number(process.env.PG_PITCH_BY_PITCH_SLICE_HEIGHT || 700);
const PG_ACTION_DELAY_MS = envMs("PG_ACTION_DELAY_MS", 0);
const PG_AFTER_CLICK_DELAY_MS = envMs("PG_AFTER_CLICK_DELAY_MS", 0);
const PG_PAGE_LOAD_DELAY_MS = envMs("PG_PAGE_LOAD_DELAY_MS", 0);
const PG_BOX_SCORE_SCREENSHOT_DELAY_MS = envMs("PG_BOX_SCORE_SCREENSHOT_DELAY_MS", 0);
const PG_PITCH_BY_PITCH_SCREENSHOT_DELAY_MS = envMs("PG_PITCH_BY_PITCH_SCREENSHOT_DELAY_MS", 0);
const PG_BETWEEN_GAMES_DELAY_MS = envMs("PG_BETWEEN_GAMES_DELAY_MS", 0);
const PG_KEEP_DEBUG = String(process.env.PG_KEEP_DEBUG || "false").toLowerCase() === "true";
const PG_REMOVE_STALE_GAME_FOLDERS = String(process.env.PG_REMOVE_STALE_GAME_FOLDERS || "true").toLowerCase() !== "false";

// Retry controls are intentionally centralized in .env.
// Defaults: one retry pass after all teams finish, no added retry delay unless you set one.
const PG_CAPTURE_RETRY_PASSES = Number(process.env.PG_CAPTURE_RETRY_PASSES || 1);
const PG_RETRY_DELAY_MS = envMs("PG_RETRY_DELAY_MS", 0);
const PG_GOOGLE_SHEET_FETCH_ATTEMPTS = Number(process.env.PG_GOOGLE_SHEET_FETCH_ATTEMPTS || 3);
const PG_GOOGLE_SHEET_FETCH_RETRY_DELAY_MS = envMs("PG_GOOGLE_SHEET_FETCH_RETRY_DELAY_MS", 2500);
const PG_GOOGLE_SHEET_FETCH_TIMEOUT_MS = envMs("PG_GOOGLE_SHEET_FETCH_TIMEOUT_MS", 45000);

const LOGS_DIR = path.join(RUN_STATE_ROOT, "logs");
const CAPTURE_FAILURES_JSONL = path.join(LOGS_DIR, "capture-failures.jsonl");
const CAPTURE_FAILURES_TXT = path.join(LOGS_DIR, "capture-failures.txt");
const RETRY_SUMMARY_FILE = path.join(LOGS_DIR, "retry-summary.json");
const STARTUP_REPORT_JSON = path.join(LOGS_DIR, "startup-team-load-report.json");
const STARTUP_REPORT_TXT = path.join(LOGS_DIR, "startup-team-load-report.txt");
let STARTUP_REPORT = null;

const POPUP_WAIT_ATTEMPTS = 10;
const POPUP_WAIT_BETWEEN_ATTEMPTS_MS = 2000;

function ensureDirectory(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeRm(targetPath) {
  try {
    if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {
    // best-effort cleanup only
  }
}

function appendCaptureFailureLog(entry) {
  ensureDirectory(LOGS_DIR);

  const record = {
    timestamp: timestamp(),
    ...entry
  };

  try {
    fs.appendFileSync(CAPTURE_FAILURES_JSONL, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // best-effort logging only
  }

  try {
    const line = [
      `[${record.timestamp}]`,
      `type=${record.type || "unknown"}`,
      `team=${record.team_name || ""}`,
      `gameId=${record.game_id || ""}`,
      `phase=${record.phase || ""}`,
      `attempt=${record.attempt || ""}`,
      `reason=${record.error || record.reason || ""}`,
      `url=${record.url || ""}`
    ].join(" | ");

    fs.appendFileSync(CAPTURE_FAILURES_TXT, line + "\n", "utf8");
  } catch {
    // best-effort logging only
  }
}

function removeMatchingTree(rootDir, predicate) {
  if (!rootDir || !fs.existsSync(rootDir)) return;

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);

    if (predicate(fullPath, entry)) {
      safeRm(fullPath);
      continue;
    }

    if (entry.isDirectory()) {
      removeMatchingTree(fullPath, predicate);
      try {
        if (fs.existsSync(fullPath) && fs.readdirSync(fullPath).length === 0 && /^_tmp_/i.test(entry.name)) {
          safeRm(fullPath);
        }
      } catch {
        // ignore
      }
    }
  }
}

function cleanupTeamArtifacts(teamDir) {
  if (!teamDir || !fs.existsSync(teamDir)) return;

  removeMatchingTree(teamDir, (fullPath, entry) => {
    const name = entry.name || path.basename(fullPath);
    if (entry.isDirectory() && /^_tmp_/i.test(name)) return true;
    if (entry.isDirectory() && /^_?fullpage[-_ ]?crop/i.test(name)) return true;
    if (entry.isFile() && /-debug-loaded\.png$/i.test(name)) return true;
    if (entry.isFile() && /-debug-full-page\.png$/i.test(name)) return true;
    if (entry.isFile() && /no-stats-page\.png$/i.test(name)) return true;
    if (entry.isFile() && /no-stats-table-detected\.png$/i.test(name)) return true;
    return false;
  });

  if (!PG_KEEP_DEBUG) {
    safeRm(path.join(teamDir, "debug"));
  }
}

function cleanExistingGamesFolder(gamesDir, allowedGameIds) {
  if (!PG_REMOVE_STALE_GAME_FOLDERS) return;
  if (!gamesDir || !fs.existsSync(gamesDir)) return;

  const allowed = new Set(Array.from(allowedGameIds || []).map(String));

  for (const entry of fs.readdirSync(gamesDir, { withFileTypes: true })) {
    const fullPath = path.join(gamesDir, entry.name);
    const name = entry.name || "";

    if (entry.isDirectory()) {
      const idMatch = name.match(/GameID-(\d+)/i) || name.match(/game-?(\d{5,})/i) || name.match(/(\d{5,})/);
      const id = idMatch ? idMatch[1] : "";

      if (!id || !allowed.has(id)) {
        safeRm(fullPath);
      }
    }
  }
}

function stableGameFolderName(game, boxMeta) {
  // Keep the game folder short and stable. Earlier versions used long descriptive
  // folder names plus long screenshot names, which can exceed Windows MAX_PATH
  // and trigger sharp/pngsave "No such file or directory" write errors.
  const id = String(game?.gameId || "unknown");
  return cleanFileName(`GameID-${id}`);
}

function timestamp() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value || "")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function stripTeamRecord(value) {
  return normalizeText(value)
    .replace(/\(\s*\d+\s*-\s*\d+\s*-\s*\d+\s+in\s+\d{4}\s*\)/gi, "")
    .replace(/\(\s*\d+\s*-\s*\d+\s*-\s*\d+\s*\)/g, "")
    .replace(/\(\s*\d+\s*-\s*\d+\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldSkipTeamByName(value) {
  return /\(\s*0\s*-\s*0\s*-\s*0\s+in\s+2026\s*\)/i.test(String(value || ""));
}

function cleanFolderName(value) {
  const cleaned = stripTeamRecord(value || "unknown-team")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || "unknown-team";
}

function cleanFileName(value) {
  return String(value || "unknown")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/[^\w\s.-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 140) || "unknown";
}

function uniqueFilePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;

  const parsed = path.parse(filePath);

  for (let i = 2; i < 1000; i++) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${i}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }

  throw new Error(`Could not create unique file path for ${filePath}`);
}

function normalizePgUrl(url) {
  const value = String(url || "").trim();

  if (!value) return "";
  if (!isLikelyPerfectGameTeamUrl(value)) return "";

  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `https://www.perfectgame.org${value}`;

  return `https://www.perfectgame.org/${value.replace(/^\/+/, "")}`;
}

function absolutePgUrl(href, baseUrl = "https://www.perfectgame.org/") {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return normalizePgUrl(href);
  }
}

function getQueryParam(url, key) {
  try {
    return new URL(url).searchParams.get(key);
  } catch {
    return "";
  }
}

function parseCsvLine(line) {
  const out = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"' && line[i + 1] === '"') {
      current += '"';
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (ch === "," && !inQuotes) {
      out.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  out.push(current);
  return out.map(x => x.trim());
}

function getFirstValue(row, possibleNames) {
  for (const name of possibleNames) {
    const key = normalizeKey(name);
    if (
      row[key] !== undefined &&
      row[key] !== null &&
      String(row[key]).trim() !== ""
    ) {
      return String(row[key]).trim();
    }
  }

  return "";
}

function rowToTeam(row) {
  const rawTeamName = getFirstValue(row, [
    "Team Name",
    "teamName",
    "Team",
    "team",
    "Name",
    "Opponent",
    "opponent"
  ]);

  const classification = getFirstValue(row, [
    "Classification",
    "classification",
    "Class",
    "class"
  ]);

  const from = getFirstValue(row, [
    "From",
    "from"
  ]);

  const city = getFirstValue(row, [
    "City",
    "city",
    "Hometown",
    "hometown",
    "Location",
    "location",
    "From",
    "from"
  ]);

  const state = getFirstValue(row, [
    "State",
    "state"
  ]);

  const status = getFirstValue(row, [
    "Status",
    "status"
  ]);

  // This is the important part: the Perfect Game scraper now reads the same sheet
  // as the GameChanger scraper, but it uses PG-specific URL columns when present.
  const pgTeamUrl = getFirstValue(row, [
    // Your shared GameChanger/Perfect Game sheet stores the Perfect Game URL here.
    "Team Page",
    "team page",
    "PG Team URL",
    "Perfect Game Team URL",
    "PerfectGame Team URL",
    "Perfect Game URL",
    "PerfectGame URL",
    "PG URL",
    "DiamondKast URL",
    "DiamondKast Team URL",
    "DK URL"
  ]);

  // Keep these fields because the same sheet also has GameChanger columns.
  // We do not use gcTeamUrl for PG scraping, but preserving it makes debugging easier.
  const gcSearchName = getFirstValue(row, [
    "GC Search Name",
    "gcSearchName",
    "GameChanger Search Name",
    "Gamechanger Search Name",
    "GC Name"
  ]);

  const gcTeamUrl = getFirstValue(row, [
    "GC Team URL",
    "GameChanger Team URL",
    "Gamechanger Team URL",
    "GameChanger URL",
    "Gamechanger URL",
    "GC URL"
  ]);

  const teamName = stripTeamRecord(rawTeamName);

  return {
    rawTeamName,
    teamName,
    pgTeamUrl: normalizePgUrl(pgTeamUrl),
    gcSearchName,
    gcTeamUrl,
    classification,
    from,
    city,
    state,
    status
  };
}

function parseCsvTextToRows(csvText) {
  const text = String(csvText || "").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter(line => line.trim());

  if (!lines.length) return [];

  const headers = parseCsvLine(lines[0]).map(h => normalizeKey(h));
  const rows = [];

  for (const line of lines.slice(1)) {
    const values = parseCsvLine(line);
    const row = {};

    headers.forEach((header, index) => {
      row[header] = values[index] || "";
    });

    rows.push(row);
  }

  return rows;
}


function analyzeTeamLoadRows(rawRows, sourceType, sourceRef) {
  const teamUrlCache = loadTeamUrlCache();
  const mapped = rawRows.map((row, index) => {
    const team = rowToTeam(row);
    team.source_row_number = index + 2;
    team.source_index = index + 1;
    return team;
  });

  const included = [];
  const skipped = [];
  const warnings = [];

  for (const team of mapped) {
    const reasons = [];
    const warningReasons = [];
    const rawName = team.rawTeamName || team.teamName || "";
    const cachedUrl = getKnownTeamUrl(team, teamUrlCache);

    if (!team.teamName) {
      reasons.push("missing team name");
    }

    if (team.status && team.status.toLowerCase() !== "pending") {
      reasons.push(`status is ${team.status}`);
    }

    if (shouldSkipTeamByName(rawName)) {
      warningReasons.push("team record is 0-0-0 in 2026; processTeam will skip it");
    }

    if (!cachedUrl) {
      warningReasons.push("no Perfect Game URL found in sheet or Team URLs.txt cache");
    }

    const record = {
      row: team.source_row_number,
      team_name: team.teamName || team.rawTeamName || "",
      raw_team_name: team.rawTeamName || "",
      status: team.status || "",
      classification: team.classification || "",
      from: team.from || "",
      pg_team_url: team.pgTeamUrl || "",
      cached_or_final_url: cachedUrl || "",
      warnings: warningReasons
    };

    if (reasons.length) {
      skipped.push({ ...record, reasons });
    } else {
      included.push(record);
      if (warningReasons.length) warnings.push(record);
    }
  }

  return {
    generated_at: timestamp(),
    source_type: sourceType,
    source: sourceRef || "",
    raw_row_count: rawRows.length,
    queued_count: included.length,
    skipped_count: skipped.length,
    warning_count: warnings.length,
    first_queued_team: included.length ? included[0] : null,
    queued_teams: included,
    skipped_rows: skipped,
    warning_rows: warnings
  };
}

function writeStartupReport(report) {
  STARTUP_REPORT = report;
  ensureDirectory(LOGS_DIR);

  fs.writeFileSync(STARTUP_REPORT_JSON, JSON.stringify(report, null, 2), "utf8");

  const lines = [];
  lines.push("Perfect Game Startup Team Load Report");
  lines.push("====================================");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Source type: ${report.source_type}`);
  lines.push(`Source: ${report.source}`);
  lines.push(`Raw rows: ${report.raw_row_count}`);
  lines.push(`Queued teams: ${report.queued_count}`);
  lines.push(`Skipped rows: ${report.skipped_count}`);
  lines.push(`Warning rows: ${report.warning_count}`);
  lines.push(`First queued team: ${report.first_queued_team ? `${report.first_queued_team.team_name} (row ${report.first_queued_team.row})` : "none"}`);
  lines.push("");
  lines.push("Queued teams:");

  for (const team of report.queued_teams) {
    const warningText = team.warnings && team.warnings.length ? ` | warnings: ${team.warnings.join("; ")}` : "";
    lines.push(`  Row ${team.row}: ${team.team_name || "(blank)"} | status=${team.status || "blank"} | url=${team.cached_or_final_url || "missing"}${warningText}`);
  }

  lines.push("");
  lines.push("Skipped rows:");

  if (!report.skipped_rows.length) {
    lines.push("  none");
  } else {
    for (const row of report.skipped_rows) {
      lines.push(`  Row ${row.row}: ${row.team_name || row.raw_team_name || "(blank)"} | reasons: ${row.reasons.join("; ")}`);
    }
  }

  fs.writeFileSync(STARTUP_REPORT_TXT, lines.join("\n"), "utf8");

  console.log("");
  console.log("=================================================");
  console.log("Perfect Game Startup Team Load Report");
  console.log("=================================================");
  console.log(`Source type: ${report.source_type}`);
  console.log(`Source: ${report.source}`);
  console.log(`Raw rows: ${report.raw_row_count}`);
  console.log(`Queued teams: ${report.queued_count}`);
  console.log(`Skipped rows: ${report.skipped_count}`);
  console.log(`Warning rows: ${report.warning_count}`);
  console.log(`First queued team: ${report.first_queued_team ? `${report.first_queued_team.team_name} (row ${report.first_queued_team.row})` : "none"}`);
  console.log(`Report JSON: ${STARTUP_REPORT_JSON}`);
  console.log(`Report TXT: ${STARTUP_REPORT_TXT}`);
  console.log("=================================================");
  console.log("");
}

function filterTeamRows(teams) {
  return teams
    .filter((row) => row.teamName)
    .filter((row) => {
      // Match the GameChanger scraper behavior: only process blank status or Pending.
      if (!row.status) return true;
      return row.status.toLowerCase() === "pending";
    });
}

function readTeamsCsv(csvPath) {
  if (!fs.existsSync(csvPath)) return [];

  const csvText = fs.readFileSync(csvPath, "utf8");
  const rawRows = parseCsvTextToRows(csvText);
  writeStartupReport(analyzeTeamLoadRows(rawRows, "local-csv", csvPath));
  return filterTeamRows(rawRows.map((row, index) => ({
    ...rowToTeam(row),
    source_row_number: index + 2,
    source_index: index + 1
  })));
}

async function captureAndBuildSprayData(page, context, teamName, teamDir) {
  const CAPTURE_SPRAY = String(process.env.PG_CAPTURE_SPRAY_CHARTS || "true").toLowerCase() !== "false";
  if (!CAPTURE_SPRAY) {
    console.log(`[Spray] PG_CAPTURE_SPRAY_CHARTS=false — skipping spray chart capture`);
    return { skipped: true };
  }

  let pgSprayData = null;

  // ── Phase A: PG spray chart scraping (authenticated browser) ──────────────
  try {
    console.log(`[Spray] Starting PG spray chart scrape for ${teamName}...`);
    pgSprayData = await scrapeTeamSprayData(page, context, teamName, teamDir);
    console.log(`[Spray] PG spray complete: ${pgSprayData.players.length} players captured`);
  } catch (err) {
    console.error(`[Spray] PG spray scrape failed for ${teamName}: ${err.message}`);
    // Non-fatal: continue to GC phase even if PG spray fails
    pgSprayData = { team: teamName, players: [], roster: [], errors: [err.message] };
  }

  // ── Phase B: GC play-by-play zone engine ──────────────────────────────────
  // Open the GC SQLite database
  const db = await new Promise((resolve, reject) => {
    const d = new sqlite3.Database(GC_DB_PATH, sqlite3.OPEN_READONLY, (err) => {
      if (err) reject(err);
      else resolve(d);
    });
  }).catch((err) => {
    console.error(`[Spray] Cannot open GC database at ${GC_DB_PATH}: ${err.message}`);
    return null;
  });

  if (!db) {
    console.warn(`[Spray] GC database unavailable — heat maps and discrepancy report skipped`);
    return { pgSprayData, gcSprayData: null };
  }

  let gcResult = null;
  try {
    gcResult = await buildTeamSprayData(db, teamName, pgSprayData, teamDir);
    console.log(`[Spray] GC spray engine complete: ${gcResult.gcSprayData.playerCount} players, ${gcResult.discrepancyCount} discrepancies`);
  } catch (err) {
    console.error(`[Spray] GC spray engine failed for ${teamName}: ${err.message}`);
  } finally {
    await new Promise((resolve) => db.close(resolve)).catch(() => {});
  }

  return { pgSprayData, gcResult };
}

async function fetchTextWithRetry(url, options = {}) {
  const attempts = Number(options.attempts || 1);
  const retryDelayMs = Number(options.retryDelayMs || 0);
  const timeoutMs = Number(options.timeoutMs || 45000);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 Playwright PerfectGame Scraper"
        }
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      return await response.text();
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      console.log(`Google Sheet CSV fetch failed on attempt ${attempt}/${attempts}: ${error.message}`);

      if (attempt < attempts && retryDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  throw lastError;
}

async function getTeamsFromGoogleSheet() {
  if (!GOOGLE_SHEET_CSV_URL) return [];

  console.log("Reading Perfect Game teams from the same Google Sheet CSV used by GameChanger...");

  const csvText = await fetchTextWithRetry(GOOGLE_SHEET_CSV_URL, {
    attempts: PG_GOOGLE_SHEET_FETCH_ATTEMPTS,
    retryDelayMs: PG_GOOGLE_SHEET_FETCH_RETRY_DELAY_MS,
    timeoutMs: PG_GOOGLE_SHEET_FETCH_TIMEOUT_MS
  });

  if (csvText.trim().startsWith("<!DOCTYPE html") || csvText.includes("<html")) {
    throw new Error(
      "GOOGLE_SHEET_CSV_URL returned an HTML page instead of CSV. Use the published Google Sheets CSV URL."
    );
  }

  const rawRows = parseCsvTextToRows(csvText);
  writeStartupReport(analyzeTeamLoadRows(rawRows, "google-sheet-csv", GOOGLE_SHEET_CSV_URL));
  return filterTeamRows(rawRows.map((row, index) => ({
    ...rowToTeam(row),
    source_row_number: index + 2,
    source_index: index + 1
  })));
}

function loadTeamUrlCache() {
  const cache = new Map();

  if (!fs.existsSync(TEAM_URLS_FILE)) return cache;

  const lines = fs.readFileSync(TEAM_URLS_FILE, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.toLowerCase().startsWith("team name")) continue;

    let teamName = "";
    let teamUrl = "";

    const tabParts = trimmed.split("\t");
    if (tabParts.length >= 2) {
      teamName = tabParts[0].trim();
      teamUrl = tabParts.slice(1).join("\t").trim();
    } else {
      const equalParts = trimmed.split("=");
      if (equalParts.length >= 2) {
        teamName = equalParts[0].trim();
        teamUrl = equalParts.slice(1).join("=").trim();
      }
    }

    if (teamName && teamUrl) {
      cache.set(normalizeKey(stripTeamRecord(teamName)), normalizePgUrl(teamUrl));
    }
  }

  return cache;
}

function saveTeamUrlCache(cache) {
  ensureDirectory(OUTPUT_ROOT);

  const lines = ["Team Name\tPerfect Game Team URL"];

  for (const [teamName, teamUrl] of Array.from(cache.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!teamName || !teamUrl) continue;
    lines.push(`${teamName}\t${teamUrl}`);
  }

  fs.writeFileSync(TEAM_URLS_FILE, lines.join("\n"), "utf8");
}

function getKnownTeamUrl(team, cache) {
  const sheetUrl = normalizePgUrl(team.pgTeamUrl);
  if (sheetUrl) return sheetUrl;

  const keys = [
    team.teamName,
    team.rawTeamName,
    stripTeamRecord(team.teamName),
    stripTeamRecord(team.rawTeamName)
  ]
    .map(normalizeKey)
    .filter(Boolean);

  for (const key of keys) {
    const cached = normalizePgUrl(cache.get(key));
    if (cached) return cached;
  }

  return "";
}

function rememberTeamUrl(teamName, teamUrl, cache) {
  const name = stripTeamRecord(teamName);
  const url = normalizePgUrl(teamUrl);

  if (!name || !url) return;

  cache.set(normalizeKey(name), url);
  saveTeamUrlCache(cache);
}

function loadProcessedGames() {
  if (!fs.existsSync(PROCESSED_GAMES_FILE)) return {};

  try {
    return JSON.parse(fs.readFileSync(PROCESSED_GAMES_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveProcessedGames(processed) {
  ensureDirectory(OUTPUT_ROOT);
  fs.writeFileSync(PROCESSED_GAMES_FILE, JSON.stringify(processed, null, 2), "utf8");
}

function getProcessedTeamKey(teamName, teamUrl) {
  const teamId = getQueryParam(teamUrl, "team");
  const orgTeamId = getQueryParam(teamUrl, "orgteamid");
  const orgId = getQueryParam(teamUrl, "orgid");

  if (teamId || orgTeamId || orgId) {
    return [teamId, orgTeamId, orgId].filter(Boolean).join("-");
  }

  return normalizeKey(stripTeamRecord(teamName));
}

function isGameProcessed(processed, teamKey, gameId) {
  return Boolean(processed?.[teamKey]?.games?.[gameId]);
}

function markGameProcessed(processed, teamKey, gameId, data) {
  if (!processed[teamKey]) {
    processed[teamKey] = {
      games: {}
    };
  }

  processed[teamKey].games[gameId] = {
    processed_at: timestamp(),
    ...data
  };

  saveProcessedGames(processed);
}

function logFailedTeam(teamName, teamUrl, reason, extra = {}) {
  ensureDirectory(FAILED_TEAMS_DIR);

  const line = [
    `[${timestamp()}]`,
    `Team: ${teamName || "Unknown"}`,
    `URL: ${teamUrl || "Not found"}`,
    `Reason: ${reason}`,
    Object.keys(extra).length ? `Extra: ${JSON.stringify(extra)}` : ""
  ].filter(Boolean).join(" | ");

  fs.appendFileSync(FAILED_TEAMS_FILE, line + "\n", "utf8");

  const safeName = cleanFileName(teamName || "unknown-team");
  const detailPath = uniqueFilePath(path.join(FAILED_TEAMS_DIR, `${safeName}.txt`));

  fs.writeFileSync(
    detailPath,
    [
      `Team: ${teamName || "Unknown"}`,
      `URL: ${teamUrl || "Not found"}`,
      `Failed At: ${timestamp()}`,
      `Reason: ${reason}`,
      "",
      JSON.stringify(extra, null, 2)
    ].join("\n"),
    "utf8"
  );
}

async function dismissCookieAndPolicyOverlay(page) {
  // Perfect Game commonly shows a cookie/media banner at the top of the page.
  // First try to click the real "Got it" button so the page state is clean.
  const clicked = await page.evaluate(() => {
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 0 &&
        rect.height > 0;
    }

    const candidates = Array.from(document.querySelectorAll('button,input[type="button"],input[type="submit"],a,div,span'));

    for (const el of candidates) {
      const text = String(el.innerText || el.textContent || el.value || "")
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase();

      if (isVisible(el) && ["GOT IT", "GOT IT!", "ACCEPT", "I ACCEPT", "OK"].includes(text)) {
        el.click();
        return true;
      }
    }

    return false;
  }).catch(() => false);

  if (clicked) await page.waitForTimeout(900);

  // If the banner is still sitting over the page, hide only obvious cookie/media overlays.
  await page.evaluate(() => {
    function hideElement(el) {
      el.style.display = "none";
      el.style.visibility = "hidden";
      el.style.opacity = "0";
      el.style.pointerEvents = "none";
      el.style.height = "0";
      el.style.minHeight = "0";
      el.style.maxHeight = "0";
      el.style.overflow = "hidden";
    }

    const all = Array.from(document.querySelectorAll("body *"));

    for (const el of all) {
      const text = String(el.innerText || el.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase();

      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      const isCookieOrMedia =
        text.includes("COOKIE POLICY") ||
        text.includes("MEDIA USAGE UPDATE") ||
        text.includes("THIS WEBSITE USES COOKIES") ||
        text.includes("ANY RECORDING, PHOTOGRAPHY, OR FOOTAGE FROM PG EVENTS");

      const isOverlaySized =
        rect.width > window.innerWidth * 0.45 &&
        rect.height > 50 &&
        (style.position === "fixed" || style.position === "sticky" || rect.top < 120 || rect.bottom > window.innerHeight - 160);

      if (isCookieOrMedia && isOverlaySized) hideElement(el);
    }

    document.body.style.paddingBottom = "0px";
    document.documentElement.style.paddingBottom = "0px";
  }).catch(() => {});
}

async function closeFloatingVideo(page) {
  // PG sometimes opens a bottom-right video player. The visible close control is usually
  // a yellow circle with a white X. Click the close button when possible, then hide leftovers.
  await page.evaluate(() => {
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 0 &&
        rect.height > 0;
    }

    function center(rect) {
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }

    const floatingContainers = Array.from(document.querySelectorAll("body *"))
      .filter(el => {
        if (!isVisible(el)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const text = String(el.innerText || el.textContent || "").toUpperCase();
        const hasMedia = !!el.querySelector('video,iframe,[class*="video" i],[id*="video" i],.jwplayer');
        const isBottomRight = rect.left > window.innerWidth * 0.35 && rect.top > window.innerHeight * 0.35;
        const isFloating = style.position === "fixed" || style.position === "sticky" || style.zIndex !== "auto";
        const largeEnough = rect.width > 180 && rect.height > 120;
        return largeEnough && isBottomRight && (isFloating || hasMedia || text.includes("WATCH") || text.includes("REPLAY"));
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (br.width * br.height) - (ar.width * ar.height);
      });

    for (const container of floatingContainers) {
      const crect = container.getBoundingClientRect();
      const possibleClosers = Array.from(container.querySelectorAll('button,a,span,div,[role="button"],svg'))
        .concat(Array.from(document.querySelectorAll('button,a,span,div,[role="button"],svg')))
        .filter(el => isVisible(el))
        .map(el => ({ el, rect: el.getBoundingClientRect(), text: String(el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim().toUpperCase() }))
        .filter(item => {
          const r = item.rect;
          const c = center(r);
          const nearContainerTopRight =
            c.x >= crect.right - 90 && c.x <= crect.right + 35 &&
            c.y >= crect.top - 35 && c.y <= crect.top + 90;
          const looksLikeX = item.text === "X" || item.text === "×" || item.text.includes("CLOSE");
          const smallRoundish = r.width <= 70 && r.height <= 70 && r.width >= 8 && r.height >= 8;
          return nearContainerTopRight && (looksLikeX || smallRoundish);
        })
        .sort((a, b) => {
          const ac = center(a.rect);
          const bc = center(b.rect);
          const ad = Math.hypot(ac.x - crect.right, ac.y - crect.top);
          const bd = Math.hypot(bc.x - crect.right, bc.y - crect.top);
          return ad - bd;
        });

      if (possibleClosers.length) {
        possibleClosers[0].el.click();
        return true;
      }
    }

    return false;
  }).catch(() => false);

  await page.waitForTimeout(700);

  await page.addStyleTag({
    content: `
      iframe[src*="youtube"],
      iframe[src*="vimeo"],
      iframe[src*="doubleclick"],
      iframe[src*="googlesyndication"],
      iframe[src*="adservice"],
      iframe[src*="imasdk"],
      .jwplayer,
      [id*="floatingVideo" i],
      [class*="floatingVideo" i],
      [id*="stickyVideo" i],
      [class*="stickyVideo" i],
      [class*="video-player" i],
      [id*="video-player" i] {
        display: none !important;
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `
  }).catch(() => {});
}

async function handlePageInterruptions(page) {
  await dismissCookieAndPolicyOverlay(page).catch(() => {});
  await closeFloatingVideo(page).catch(() => {});
}

async function safeHideFloatingJunk(page) {
  await closeFloatingVideo(page).catch(() => {});
  await page.addStyleTag({
    content: `
      iframe[src*="youtube"],
      iframe[src*="vimeo"],
      iframe[src*="doubleclick"],
      iframe[src*="googlesyndication"],
      iframe[src*="adservice"],
      iframe[src*="imasdk"],
      .jwplayer,
      [id*="floatingVideo" i],
      [class*="floatingVideo" i],
      [id*="stickyVideo" i],
      [class*="stickyVideo" i],
      [class*="video-player" i],
      [id*="video-player" i] {
        display: none !important;
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `
  }).catch(() => {});
}

async function removeLargeFloatingElementsButKeepStats(page) {
  await page.evaluate(() => {
    const protectedWords = [
      "DIAMONDKAST",
      "PLAYER",
      "AVG",
      "OBP",
      "SLG",
      "STATS",
      "BATTING",
      "PITCHING",
      "SPRAY",
      "CLOSE",
      "TEAM SCHEDULE",
      "BOX",
      "FINAL"
    ];

    const elements = Array.from(document.querySelectorAll("body *"));

    for (const el of elements) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const text = (el.innerText || "").toUpperCase();

      const isProtected = protectedWords.some(word => text.includes(word));
      const isFloating = style.position === "fixed" || style.position === "sticky";
      const isLarge = rect.width > 200 && rect.height > 100;
      const isBottomRight = rect.right > window.innerWidth * 0.45 && rect.bottom > window.innerHeight * 0.45;

      const isCookieOrMedia =
        text.includes("COOKIE POLICY") ||
        text.includes("MEDIA USAGE UPDATE") ||
        text.includes("THIS WEBSITE USES COOKIES");

      if ((isFloating && isLarge && isBottomRight && !isProtected) || isCookieOrMedia) {
        el.style.display = "none";
        el.style.visibility = "hidden";
        el.style.opacity = "0";
        el.style.pointerEvents = "none";
      }
    }
  }).catch(() => {});
}

async function getTeamNameFromPage(page) {
  const result = await page.evaluate(() => {
    function cleanText(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function stripRecord(value) {
      return cleanText(value)
        .replace(/\(\s*\d+\s*-\s*\d+\s*-\s*\d+\s+in\s+\d{4}\s*\)/gi, "")
        .replace(/\(\s*\d+\s*-\s*\d+\s*-\s*\d+\s*\)/g, "")
        .replace(/\(\s*\d+\s*-\s*\d+\s*\)/g, "")
        .trim();
    }

    function isBadTeamName(text) {
      const upper = text.toUpperCase();

      const badPhrases = [
        "SPEND MORE",
        "SAVE MORE",
        "REGISTER TODAY",
        "INDIVIDUAL PLAYER SPOTS",
        "NATIONAL CHAMPIONSHIP",
        "WORLD'S LARGEST",
        "PERFECT GAME",
        "COOKIE POLICY",
        "MEDIA USAGE",
        "TEAM LEADERS",
        "TEAM SCHEDULE",
        "FULL ROSTER",
        "AWARDS",
        "STATS",
        "SIGN IN",
        "CREATE ACCOUNT",
        "EVENTS",
        "SHOWCASES",
        "SOFTBALL",
        "RANKINGS",
        "RECRUITING",
        "PG SHOP",
        "PG TEAM SALES",
        "DIAMONDKAST",
        "BATTING",
        "PITCHING",
        "STANDARD",
        "ADVANCED",
        "HOMETOWN",
        "ORGANIZATION",
        "CLASSIFICATION",
        "PG RECORD",
        "PERSONNEL",
        "TEAM POINTS",
        "LEADERBOARD",
        "SCHEDULE"
      ];

      return badPhrases.some(p => upper.includes(p));
    }

    const bodyText = cleanText(document.body.innerText || "");
    const lines = bodyText.split(/\n+/).map(cleanText).filter(Boolean);
    const candidates = [];

    for (let i = 0; i < lines.length; i++) {
      const upper = lines[i].toUpperCase();

      if (upper.startsWith("HOMETOWN") && i > 0) {
        for (let back = 1; back <= 10; back++) {
          const possible = stripRecord(lines[i - back]);

          if (!possible) continue;
          if (possible.length < 3 || possible.length > 90) continue;
          if (isBadTeamName(possible)) continue;

          candidates.push({
            text: possible,
            source: `line-before-hometown-${back}`,
            score: 500 - back
          });

          break;
        }
      }
    }

    const title = stripRecord(document.title || "");
    if (title && !isBadTeamName(title)) {
      candidates.push({ text: title, source: "document-title", score: 100 });
    }

    candidates.sort((a, b) => b.score - a.score);

    return {
      best: candidates.length ? candidates[0].text : "",
      candidates: candidates.slice(0, 30)
    };
  }).catch(() => ({ best: "", candidates: [] }));

  return result;
}

async function clickText(page, text, options = {}) {
  const exact = options.exact !== false;
  const timeout = options.timeout || 4000;

  const byLocator = await page.getByText(text, { exact })
    .first()
    .click({ force: true, timeout })
    .then(() => true)
    .catch(() => false);

  if (byLocator) {
    await page.waitForTimeout(options.afterMs ?? PG_AFTER_CLICK_DELAY_MS);
    return true;
  }

  const byEvaluate = await page.evaluate(({ text, exact }) => {
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();

      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    function normalized(value) {
      return String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
    }

    const target = normalized(text);
    const elements = Array.from(document.querySelectorAll("a,button,input,span,div,label,td"));

    const match = elements.find(el => {
      const value = normalized(el.innerText || el.textContent || el.value || "");
      return isVisible(el) && (exact ? value === target : value.includes(target));
    });

    if (!match) return false;

    match.click();
    return true;
  }, { text, exact }).catch(() => false);

  if (byEvaluate) {
    await page.waitForTimeout(options.afterMs ?? PG_AFTER_CLICK_DELAY_MS);
    return true;
  }

  return false;
}

async function expandAllScheduleGames(page) {
  await handlePageInterruptions(page);

  // PG usually has "See All Games" above and below the schedule.
  // One click is often enough, but clicking visible duplicates is harmless.
  for (let i = 0; i < 3; i++) {
    const clicked = await clickText(page, "See All Games", { exact: true, timeout: 2500, afterMs: PG_AFTER_CLICK_DELAY_MS });
    if (!clicked) break;
  }

  await handlePageInterruptions(page);
}

async function getFinalBoxGamesFromSchedule(page) {
  return await page.evaluate(() => {
    function clean(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function abs(href) {
      try {
        return new URL(href, window.location.href).toString();
      } catch {
        return href || "";
      }
    }

    function getGameId(text, href) {
      const fromText = clean(text).match(/GameID:\s*(\d+)/i);
      if (fromText) return fromText[1];

      const fromHref = String(href || "").match(/(?:gameid|GameID|gameId|ID)=?(\d+)/);
      if (fromHref) return fromHref[1];

      const anyDigits = String(href || "").match(/(\d{5,})/);
      return anyDigits ? anyDigits[1] : "";
    }

    function closestUsefulRow(el) {
      let current = el;

      for (let depth = 0; depth < 8 && current; depth++) {
        const text = clean(current.innerText || current.textContent || "");
        const upper = text.toUpperCase();

        if (upper.includes("FINAL") && upper.includes("GAMEID")) {
          return current;
        }

        current = current.parentElement;
      }

      return el.closest("tr") || el.closest(".row") || el.parentElement;
    }

    const links = Array.from(document.querySelectorAll("a"))
      .filter(a => clean(a.innerText || a.textContent).toUpperCase() === "BOX");

    const games = [];

    for (const link of links) {
      const row = closestUsefulRow(link);
      const rowText = clean(row ? row.innerText || row.textContent : link.parentElement?.innerText || "");
      const upper = rowText.toUpperCase();

      if (!upper.includes("FINAL")) continue;

      const href = abs(link.getAttribute("href") || link.href || "");
      if (!href) continue;

      const gameId = getGameId(rowText, href);
      if (!gameId) continue;

      const scoreMatch = rowText.match(/\b([WL]),?\s*([0-9]+)\s*-\s*([0-9]+)/i);
      const opponentMatch = rowText.match(/@\s*([^\n\r]+?)(?:\s+\(\d+-\d+-\d+\)|\s+14U|\s+13U|\s+15U|\s+16U|\s+17U|\s+18U|$)/i);

      games.push({
        gameId,
        href,
        rowText,
        result: scoreMatch ? scoreMatch[1].toUpperCase() : "",
        score: scoreMatch ? `${scoreMatch[2]}-${scoreMatch[3]}` : "",
        opponent: opponentMatch ? clean(opponentMatch[1]) : ""
      });
    }

    const seen = new Set();

    return games.filter(game => {
      if (seen.has(game.gameId)) return false;
      seen.add(game.gameId);
      return true;
    });
  }).catch(() => []);
}

async function clickVisibleTextOption(page, text, occurrence = 0) {
  await handlePageInterruptions(page);

  const clickedByLocator = await page.getByText(text, { exact: true })
    .nth(occurrence)
    .click({ force: true, timeout: 3500 })
    .then(() => true)
    .catch(() => false);

  if (clickedByLocator) {
    await page.waitForTimeout(PG_AFTER_CLICK_DELAY_MS);
    await handlePageInterruptions(page);
    return true;
  }

  const clickedByEvaluate = await page.evaluate(({ text, occurrence }) => {
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();

      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    function normalized(value) {
      return String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
    }

    const target = normalized(text);
    const elements = Array.from(document.querySelectorAll("button,label,span,div,td,a,input[type='button'],input[type='submit']"));
    const matches = elements.filter(el => isVisible(el) && normalized(el.innerText || el.textContent || el.value) === target);
    const selected = matches[occurrence];

    if (!selected) return false;

    selected.scrollIntoView({ block: "center", inline: "center" });

    const labelFor = selected.getAttribute("for");

    if (labelFor) {
      const input = document.getElementById(labelFor);
      if (input) {
        input.click();
        return true;
      }
    }

    selected.click();

    const parent = selected.parentElement;
    if (parent) {
      const input = parent.querySelector('input[type="radio"],input[type="checkbox"]');
      if (input) {
        input.click();
        return true;
      }
    }

    return true;
  }, { text, occurrence }).catch(() => false);

  await page.waitForTimeout(PG_AFTER_CLICK_DELAY_MS);
  await handlePageInterruptions(page);
  return clickedByEvaluate;
}


async function scrollToStatsSection(page) {
  await handlePageInterruptions(page);

  await page.evaluate(() => {
    function clean(value) {
      return String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
    }

    const elements = Array.from(document.querySelectorAll("h1,h2,h3,h4,div,span,section,td"));
    const statsHeading = elements
      .map(el => ({ el, text: clean(el.innerText || el.textContent || ""), rect: el.getBoundingClientRect() }))
      .filter(item => item.text === "STATS" && item.rect.width > 0 && item.rect.height > 0)
      .sort((a, b) => a.rect.top - b.rect.top)[0];

    if (statsHeading) {
      const y = Math.max(0, statsHeading.rect.top + window.scrollY - 80);
      window.scrollTo(0, y);
      return;
    }

    const statsControl = elements
      .map(el => ({ el, text: clean(el.innerText || el.textContent || ""), rect: el.getBoundingClientRect() }))
      .filter(item => item.text.includes("BATTING STATS") || item.text.includes("PITCHING STATS"))
      .sort((a, b) => a.rect.top - b.rect.top)[0];

    if (statsControl) {
      const y = Math.max(0, statsControl.rect.top + window.scrollY - 100);
      window.scrollTo(0, y);
    }
  }).catch(() => {});

  await page.waitForTimeout(PG_AFTER_CLICK_DELAY_MS);
  await handlePageInterruptions(page);
}

async function clickStatsControl(page, text) {
  await scrollToStatsSection(page);

  const clicked = await page.evaluate((targetText) => {
    function clean(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function isVisible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 0 &&
        rect.height > 0;
    }

    function absBox(el) {
      const rect = el.getBoundingClientRect();
      return {
        top: rect.top + window.scrollY,
        bottom: rect.bottom + window.scrollY,
        left: rect.left + window.scrollX,
        right: rect.right + window.scrollX,
        width: rect.width,
        height: rect.height
      };
    }

    function textOf(el) {
      if (!el) return "";
      if (el.tagName === "INPUT") return clean(el.value || "");
      return clean(el.innerText || el.textContent || "");
    }

    const normalizedTarget = clean(targetText).toUpperCase();
    const all = Array.from(document.querySelectorAll("button,a,label,span,div,td,li,input[type='button'],input[type='submit']"));
    const visible = all
      .filter(isVisible)
      .map(el => ({ el, text: textOf(el), upper: textOf(el).toUpperCase(), box: absBox(el), tag: el.tagName.toUpperCase() }))
      .filter(item => item.text);

    const statsHeading = visible
      .filter(item => item.upper === "STATS")
      .sort((a, b) => a.box.top - b.box.top)[0];

    const statsTabs = visible
      .filter(item => item.upper === "BATTING STATS" || item.upper === "PITCHING STATS")
      .sort((a, b) => a.box.top - b.box.top);

    const statsTop = statsHeading ? Math.max(0, statsHeading.box.top - 40) : (statsTabs[0] ? Math.max(0, statsTabs[0].box.top - 80) : window.scrollY);
    const statsBottom = Math.max(statsTop + 200, window.scrollY + window.innerHeight + 1600);

    let matches = visible
      .filter(item => item.upper === normalizedTarget)
      .filter(item => item.box.top >= statsTop && item.box.top <= statsBottom)
      .filter(item => item.box.width <= 360 && item.box.height <= 90)
      .filter(item => {
        const href = item.el.getAttribute && item.el.getAttribute("href");
        if (!href) return true;
        // Prevent accidentally clicking the site navigation Schedule/Leaders links while targeting stat controls.
        if (/schedule|standings|roster|results|bracket|leaders|topperformers/i.test(href)) return false;
        return true;
      })
      .sort((a, b) => {
        const enabledA = /active|selected|btn-primary|btn-dark/i.test(a.el.className || "") ? 1 : 0;
        const enabledB = /active|selected|btn-primary|btn-dark/i.test(b.el.className || "") ? 1 : 0;
        const topDelta = Math.abs(a.box.top - window.scrollY) - Math.abs(b.box.top - window.scrollY);
        return enabledA - enabledB || topDelta || a.box.top - b.box.top;
      });

    if (!matches.length) {
      // Fallback: look inside the visible stats panel only.
      const panelCandidates = Array.from(document.querySelectorAll("div,section,table"))
        .filter(isVisible)
        .map(el => ({ el, box: absBox(el), upper: clean(el.innerText || el.textContent || "").toUpperCase() }))
        .filter(item => item.box.top >= statsTop && item.upper.includes("PLAYER") && (item.upper.includes("TEAM TOTALS") || item.upper.includes("AVG") || item.upper.includes("OPS") || item.upper.includes("ERA")))
        .sort((a, b) => a.box.top - b.box.top);

      for (const panel of panelCandidates) {
        const controls = Array.from(panel.el.parentElement ? panel.el.parentElement.querySelectorAll("button,a,label,span,div,td,input[type='button']") : [])
          .filter(isVisible)
          .map(el => ({ el, text: textOf(el), upper: textOf(el).toUpperCase(), box: absBox(el) }))
          .filter(item => item.upper === normalizedTarget && item.box.width <= 360 && item.box.height <= 90);
        if (controls.length) {
          matches = controls.sort((a, b) => a.box.top - b.box.top);
          break;
        }
      }
    }

    const selected = matches[0];
    if (!selected) return { clicked: false, reason: `No visible stats control matched ${targetText}` };

    selected.el.scrollIntoView({ block: "center", inline: "center" });

    const labelFor = selected.el.getAttribute && selected.el.getAttribute("for");
    if (labelFor) {
      const input = document.getElementById(labelFor);
      if (input) {
        input.click();
        return { clicked: true, method: "label-for", text: selected.text };
      }
    }

    const inputInside = selected.el.querySelector ? selected.el.querySelector('input[type="radio"],input[type="checkbox"],input[type="button"]') : null;
    if (inputInside) {
      inputInside.click();
      return { clicked: true, method: "child-input", text: selected.text };
    }

    const parentInput = selected.el.parentElement ? selected.el.parentElement.querySelector('input[type="radio"],input[type="checkbox"],input[type="button"]') : null;
    if (parentInput) {
      parentInput.click();
      return { clicked: true, method: "parent-input", text: selected.text };
    }

    selected.el.click();
    return { clicked: true, method: "direct", text: selected.text };
  }, text).catch(error => ({ clicked: false, reason: error.message }));

  await page.waitForTimeout(PG_AFTER_CLICK_DELAY_MS);
  await handlePageInterruptions(page);
  return clicked;
}

async function waitForStatsTableChange(page, expectedCategory, previousSignature = "") {
  await page.waitForFunction(({ expectedCategory, previousSignature }) => {
    function clean(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function isVisible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 450 &&
        rect.height > 60;
    }

    const tables = Array.from(document.querySelectorAll("table")).filter(isVisible);
    for (const table of tables) {
      const text = clean(table.innerText || table.textContent || "");
      const upper = text.toUpperCase();
      if (!upper.includes("PLAYER")) continue;

      const isPitching = upper.includes(" IP ") || upper.includes(" ERA") || upper.includes(" SO") || upper.includes(" PC");
      const isBatting = upper.includes(" OPS") || upper.includes(" AVG") || upper.includes(" OBP") || upper.includes(" SLG") || upper.includes(" AB");

      if (expectedCategory.toUpperCase().includes("PITCH") && !isPitching) continue;
      if (expectedCategory.toUpperCase().includes("BAT") && !isBatting) continue;

      const signature = upper.slice(0, 500);
      if (!previousSignature || signature !== previousSignature) return true;
    }

    return false;
  }, { expectedCategory, previousSignature }, { timeout: Number(process.env.PG_STATS_TABLE_WAIT_MS || 8000) }).catch(() => {});

  await page.waitForTimeout(STATS_VIEW_DELAY_MS);
  await handlePageInterruptions(page);
}

async function getCurrentStatsTableSignature(page, expectedCategory = "") {
  return await page.evaluate((expectedCategory) => {
    function clean(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function isVisible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 450 &&
        rect.height > 60;
    }

    const tables = Array.from(document.querySelectorAll("table")).filter(isVisible);
    for (const table of tables) {
      const text = clean(table.innerText || table.textContent || "");
      const upper = text.toUpperCase();
      if (!upper.includes("PLAYER")) continue;
      const isPitching = upper.includes(" IP ") || upper.includes(" ERA") || upper.includes(" SO") || upper.includes(" PC");
      const isBatting = upper.includes(" OPS") || upper.includes(" AVG") || upper.includes(" OBP") || upper.includes(" SLG") || upper.includes(" AB");
      if (expectedCategory.toUpperCase().includes("PITCH") && !isPitching) continue;
      if (expectedCategory.toUpperCase().includes("BAT") && !isBatting) continue;
      return upper.slice(0, 500);
    }
    return "";
  }, expectedCategory).catch(() => "");
}

async function selectStatsView(page, category, view) {
  console.log(`Selecting stats view: ${category} / ${view}`);

  await scrollToStatsSection(page);
  const previousSignature = await getCurrentStatsTableSignature(page, category);

  const categoryClicked = await clickStatsControl(page, category);
  if (!categoryClicked.clicked) {
    console.log(`Warning: could not click category option "${category}": ${categoryClicked.reason || "unknown"}`);
  }

  await waitForStatsTableChange(page, category, previousSignature);

  const beforeViewSignature = await getCurrentStatsTableSignature(page, category);
  const viewClicked = await clickStatsControl(page, view);
  if (!viewClicked.clicked) {
    console.log(`Warning: could not click view option "${view}": ${viewClicked.reason || "unknown"}`);
  }

  await waitForStatsTableChange(page, category, beforeViewSignature);
  await scrollToStatsSection(page);
}

async function getStatsGrid(page, expectedCategory = "", expectedView = "") {
  const handle = await page.evaluateHandle(({ expectedCategory, expectedView }) => {
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 0 &&
        rect.height > 0;
    }

    function clean(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function upperText(el) {
      return clean(el.innerText || el.textContent || "").toUpperCase();
    }

    function box(el) {
      const rect = el.getBoundingClientRect();
      return { top: rect.top + window.scrollY, bottom: rect.bottom + window.scrollY, width: rect.width, height: rect.height };
    }

    const cat = String(expectedCategory || "").toUpperCase();
    const view = String(expectedView || "").toUpperCase();
    const wantsPitching = cat.includes("PITCH");
    const wantsBatting = cat.includes("BAT");
    const wantsBattedBall = view.includes("BATTED");
    const wantsAdvanced = view.includes("ADVANCED");

    const statsAnchor = Array.from(document.querySelectorAll("h1,h2,h3,h4,div,span"))
      .filter(isVisible)
      .map(el => ({ el, txt: upperText(el), box: box(el) }))
      .filter(item => item.txt === "STATS" || item.txt === "BATTING STATS" || item.txt === "PITCHING STATS")
      .sort((a, b) => a.box.top - b.box.top)[0];
    const minTop = statsAnchor ? Math.max(0, statsAnchor.box.top - 40) : 0;

    function scoreTable(table) {
      if (!isVisible(table)) return -1;
      const rect = table.getBoundingClientRect();
      const b = box(table);
      const text = clean(table.innerText || table.textContent || "");
      const upper = text.toUpperCase();

      if (b.top < minTop) return -1;
      if (rect.width < 450 || rect.height < 45) return -1;
      if (!upper.includes("PLAYER")) return -1;

      // Hard reject schedule/event tables. They caused false captures named as batted-ball stats.
      if (upper.includes("TEAM SCHEDULE") || upper.includes("GAMEID:") || upper.includes("PROBABLE PITCHERS")) return -1;

      const isPitching = (upper.includes(" IP") || upper.includes("IP ")) && (upper.includes(" ERA") || upper.includes(" SO") || upper.includes(" BB") || upper.includes(" PC") || upper.includes("AVG-FB"));
      const isBatting = upper.includes(" OPS") || upper.includes(" AVG") || upper.includes(" OBP") || upper.includes(" SLG") || upper.includes(" AB");
      const isBattedBall = upper.includes("GO/AO") || upper.includes("GB%") || upper.includes("AIR%") || upper.includes("PULL%") || upper.includes("OPPO%") || upper.includes("HR/FB") || upper.includes("GIDP");
      const isAdvanced = upper.includes("BABIP") || upper.includes("ISO") || upper.includes("BB%") || upper.includes("K%") || upper.includes("PA") || upper.includes("OPS");

      if (wantsPitching && !isPitching && !(wantsBattedBall && isBattedBall)) return -1;
      if (wantsBatting && !isBatting && !isBattedBall) return -1;
      if (wantsBattedBall && !isBattedBall) return -1;
      if (wantsAdvanced && !isAdvanced && !isBattedBall) return -1;

      let score = rect.width + rect.height + text.length / 20;
      if (upper.includes("TEAM TOTALS")) score += 1000;
      if (isBattedBall) score += 800;
      if (isPitching) score += wantsPitching ? 350 : 0;
      if (isBatting) score += wantsBatting ? 350 : 0;
      return score;
    }

    const candidates = Array.from(document.querySelectorAll("table"))
      .map(table => ({ table, score: scoreTable(table), top: box(table).top }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || a.top - b.top);

    return candidates.length ? candidates[0].table : null;
  }, { expectedCategory, expectedView });

  const element = handle.asElement();
  if (!element) return null;

  const box = await element.boundingBox().catch(() => null);
  if (!box || box.width < 300 || box.height < 50) return null;

  return {
    selector: "resolved-visible-stats-table",
    locator: element
  };
}

async function captureCurrentStatsGrid(page, outputPath, label, expectedCategory = "", expectedView = "") {
  await handlePageInterruptions(page);
  await safeHideFloatingJunk(page);
  await removeLargeFloatingElementsButKeepStats(page);

  const grid = await getStatsGrid(page, expectedCategory, expectedView);

  if (!grid) {
    console.log(`No stats grid found for ${label}.`);
    if (PG_KEEP_DEBUG) {
      await page.screenshot({ path: outputPath.replace(/\.png$/i, "-debug-full-page.png"), fullPage: true }).catch(() => {});
    }
    return {
      captured: false,
      reason: "No visible DiamondKast stats table found",
      file: outputPath
    };
  }

  await grid.locator.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(STATS_VIEW_DELAY_MS);
  await handlePageInterruptions(page);

  await grid.locator.screenshot({
    path: outputPath
  });

  console.log(`Saved ${label} stats screenshot: ${outputPath}`);

  return {
    captured: true,
    selector: grid.selector,
    file: outputPath
  };
}

async function extractAllStatsTables(page, statsTablesDir, teamName) {
  ensureDirectory(statsTablesDir);

  const results = [];
  const safeTeam = cleanFileName(teamName || "team");

  const views = [
    { category: "Batting Stats",  clickCategory: "Batting Stats",  view: "Standard",    key: "batting_standard"    },
    { category: "Batting Stats",  clickCategory: "Batting Stats",  view: "Advanced",    key: "batting_advanced"    },
    { category: "Batting Stats",  clickCategory: "Batting Stats",  view: "Batted Ball", key: "batting_batted_ball" },
    { category: "Pitching Stats", clickCategory: "Pitching Stats", view: "Standard",    key: "pitching_standard"   },
    { category: "Pitching Stats", clickCategory: "Pitching Stats", view: "Advanced",    key: "pitching_advanced"   },
    { category: "Pitching Stats", clickCategory: "Pitching Stats", view: "Batted Ball", key: "pitching_batted_ball" },
  ];

  const combined = {};

  for (const item of views) {
    await selectStatsView(page, item.clickCategory, item.view);

    const rows = await page.evaluate(({ expectedCategory, expectedView }) => {
      function clean(v) {
        return String(v || "").replace(/s+/g, " ").trim();
      }
      function isVisible(el) {
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== "none" && s.visibility !== "hidden" &&
               Number(s.opacity || 1) > 0 && r.width > 400 && r.height > 40;
      }

      let statsTable = null;
      for (const t of Array.from(document.querySelectorAll("table"))) {
        if (!isVisible(t)) continue;
        const text = clean(t.innerText || "").toUpperCase();
        const cat = expectedCategory.toUpperCase();
        const isBatting  = text.includes("OPS") || text.includes("AVG");
        const isPitching = (text.includes(" IP") || text.includes("IP ")) && text.includes("ERA");
        if (cat.includes("PITCH") && !isPitching) continue;
        if (cat.includes("BAT")   && !isBatting)  continue;
        if (!text.includes("PLAYER")) continue;
        if (text.includes("TEAM SCHEDULE")) continue;
        statsTable = t;
        break;
      }

      if (!statsTable) return { headers: [], rows: [] };

      const headerRow = statsTable.querySelector("thead tr") || statsTable.querySelector("tr");
      const headers = headerRow
        ? Array.from(headerRow.querySelectorAll("th,td")).map(th => clean(th.innerText || th.textContent || ""))
        : [];

      const dataRows = [];
      const tbody = statsTable.querySelector("tbody") || statsTable;
      for (const row of Array.from(tbody.querySelectorAll("tr"))) {
        const cells = Array.from(row.querySelectorAll("td"));
        if (!cells.length) continue;
        const rowData = {};
        cells.forEach((cell, i) => {
          const header = headers[i] || ("col_" + i);
          rowData[header] = clean(cell.innerText || cell.textContent || "");
        });
        const firstVal = Object.values(rowData)[0] || "";
        if (!firstVal || firstVal.toUpperCase() === "PLAYER") continue;
        dataRows.push(rowData);
      }

      return { headers, rows: dataRows };
    }, { expectedCategory: item.category, expectedView: item.view }).catch(() => ({ headers: [], rows: [] }));

    combined[item.key] = rows;

    results.push({
      category:  item.category,
      view:      item.view,
      key:       item.key,
      captured:  rows.rows.length > 0,
      row_count: rows.rows.length,
    });

    console.log("  Extracted " + rows.rows.length + " rows: " + item.category + " / " + item.view);
  }

  const outputFile = path.join(statsTablesDir, safeTeam + "-stats.json");
  fs.writeFileSync(outputFile, JSON.stringify({
    team:        teamName,
    captured_at: new Date().toISOString(),
    ...combined,
  }, null, 2), "utf8");

  console.log("  Stats JSON written → " + path.basename(outputFile));

  await selectStatsView(page, "Batting Stats", "Standard").catch(() => {});

  return { outputFile, views: results, combined };
}

async function findPopupForPlayer(page, playerName, label = "popup") {
  const normalizedPlayerName = normalizeKey(playerName);

  for (let attempt = 1; attempt <= POPUP_WAIT_ATTEMPTS; attempt++) {
    const candidates = await getVisiblePopupCandidates(page);

    if (candidates.length > 0) {
      const withPlayerName = candidates.find(candidate =>
        normalizeKey(candidate.text).includes(normalizedPlayerName)
      );

      if (withPlayerName) {
        console.log(`${label} for ${playerName} found on attempt ${attempt} and player name matched.`);
        return withPlayerName;
      }

      console.log(`${label} visible on attempt ${attempt}, but player name did not match yet.`);
      console.log(`Visible popup text sample: ${candidates[0].text.substring(0, 150)}`);
    } else {
      console.log(`No visible ${label} candidate yet for ${playerName}, attempt ${attempt}.`);
    }

    await page.waitForTimeout(POPUP_WAIT_BETWEEN_ATTEMPTS_MS);
  }

  const fallbackCandidates = await getVisiblePopupCandidates(page);

  if (fallbackCandidates.length > 0) {
    console.log(`Using largest visible popup as fallback for ${playerName}.`);
    return fallbackCandidates[0];
  }

  return null;
}

function makeSafeClip(box, viewportWidth = VIEWPORT.width, viewportHeight = VIEWPORT.height) {
  const padding = 16;

  const x = Math.max(0, Math.floor(box.x - padding));
  const y = Math.max(0, Math.floor(box.y - padding));
  const right = Math.min(viewportWidth, Math.ceil(box.x + box.width + padding));
  const bottom = Math.min(viewportHeight, Math.ceil(box.y + box.height + padding));

  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y)
  };
}

async function clickVisibleCloseButton(page, playerName = "") {
  const clicked = await page.evaluate(() => {
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();

      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    }

    function textOf(el) {
      if (el.tagName === "INPUT") return (el.value || "").trim();
      return (el.innerText || el.textContent || "").trim();
    }

    const candidates = Array.from(
      document.querySelectorAll('button,input[type="button"],input[type="submit"],a,span,div')
    )
      .filter(isVisible)
      .map(el => {
        const rect = el.getBoundingClientRect();
        return {
          el,
          text: textOf(el).replace(/\s+/g, " ").trim().toUpperCase(),
          area: rect.width * rect.height,
          y: rect.y
        };
      })
      .filter(item => item.text === "CLOSE" || item.text === "X" || item.text === "×")
      .sort((a, b) => {
        if (a.text === "CLOSE" && b.text !== "CLOSE") return -1;
        if (a.text !== "CLOSE" && b.text === "CLOSE") return 1;
        return a.area - b.area;
      });

    if (!candidates.length) return false;

    candidates[0].el.click();
    return true;
  }).catch(() => false);

  if (clicked) {
    console.log(`Clicked CLOSE button${playerName ? ` for ${playerName}` : ""}.`);
    await page.waitForTimeout(SPRAY_CLOSE_DELAY_MS);
    return true;
  }

  console.log(`Could not find visible CLOSE button${playerName ? ` for ${playerName}` : ""}. Trying Escape.`);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(SPRAY_CLOSE_DELAY_MS);

  return false;
}

async function waitForPopupToDisappear(page, playerName = "") {
  for (let attempt = 1; attempt <= 10; attempt++) {
    const candidates = await getVisiblePopupCandidates(page);

    if (!candidates.length) return true;

    if (playerName) {
      const stillHasPlayerPopup = candidates.some(candidate =>
        normalizeKey(candidate.text).includes(normalizeKey(playerName))
      );

      if (!stillHasPlayerPopup) return true;
    }

    await page.waitForTimeout(1000);
  }

  return false;
}

async function forceCloseAnyOpenPopup(page) {
  const candidates = await getVisiblePopupCandidates(page);
  if (!candidates.length) return;

  await clickVisibleCloseButton(page);
  await waitForPopupToDisappear(page);
}

async function screenshotPopupWindow(page, popup, filePath) {
  const clip = makeSafeClip(popup.box, VIEWPORT.width, VIEWPORT.height);

  await handlePageInterruptions(page);

  await page.screenshot({
    path: filePath,
    clip
  });
}

async function captureSprayCharts(page, gridSelector, sprayDir) {
  const results = [];
  const rowCount = await page.locator(`${gridSelector} tbody tr`).count().catch(() => 0);

  console.log(`Found ${rowCount} player rows for spray chart pass.`);

  for (let i = 0; i < rowCount; i++) {
    await forceCloseAnyOpenPopup(page);
    await page.waitForTimeout(SPRAY_CLOSE_DELAY_MS);
    await handlePageInterruptions(page);

    const row = page.locator(`${gridSelector} tbody tr`).nth(i);
    const cells = row.locator("td");
    const cellCount = await cells.count().catch(() => 0);

    if (cellCount < 3) continue;

    const playerName = await cells.nth(2).innerText().catch(() => "");
    const cleanPlayer = cleanFileName(playerName);

    if (!playerName || playerName.toUpperCase() === "PLAYER") continue;

    console.log(`Trying spray chart for row ${i + 1}: ${playerName}...`);

    const sprayCell = cells.nth(1);

    const candidates = [
      sprayCell.locator("a").first(),
      sprayCell.locator("img").first(),
      sprayCell.locator("input").first(),
      sprayCell.locator("button").first(),
      sprayCell.locator("[onclick]").first(),
      sprayCell.locator("*").first()
    ];

    let sprayButton = null;

    for (const candidate of candidates) {
      if (await candidate.count().catch(() => 0)) {
        const visible = await candidate.isVisible().catch(() => false);
        if (visible) {
          sprayButton = candidate;
          break;
        }
      }
    }

    if (!sprayButton) {
      results.push({ player: playerName, captured: false, reason: "No visible spray icon/button found" });
      continue;
    }

    await sprayButton.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(1000);

    const beforeClickPath = path.join(
      sprayDir,
      `${String(i + 1).padStart(2, "0")}-${cleanPlayer}-spray-before-click.png`
    );

    await page.screenshot({ path: beforeClickPath, fullPage: false }).catch(() => {});

    let newPage = null;

    const newPagePromise = page.context().waitForEvent("page", { timeout: 7000 })
      .then(p => {
        newPage = p;
        return p;
      })
      .catch(() => null);

    console.log(`Clicking spray icon for ${playerName}...`);

    await sprayButton.click({ force: true }).catch(async () => {
      await page.waitForTimeout(1000);
      await sprayButton.click({ force: true }).catch(() => {});
    });

    await page.waitForTimeout(SPRAY_CLICK_DELAY_MS);
    await newPagePromise;

    const fileName = `${String(i + 1).padStart(2, "0")}-${cleanPlayer}-spray-chart.png`;
    const filePath = path.join(sprayDir, fileName);

    if (newPage) {
      console.log(`Spray chart opened new page/window for ${playerName}.`);

      await newPage.waitForLoadState("domcontentloaded").catch(() => {});
      await newPage.waitForTimeout(SPRAY_RENDER_DELAY_MS);
      await safeHideFloatingJunk(newPage);
      await dismissCookieAndPolicyOverlay(newPage);

      await newPage.screenshot({ path: filePath, fullPage: false });

      await newPage.close().catch(() => {});
      await page.waitForTimeout(SPRAY_CLOSE_DELAY_MS);

      results.push({ player: playerName, captured: true, method: "new_page", file: filePath });
      console.log(`Saved spray chart for ${playerName}: ${filePath}`);
      continue;
    }

    console.log(`Looking for spray chart popup for ${playerName}...`);

    const popup = await findPopupForPlayer(page, playerName, "spray chart popup");

    if (popup && popup.box) {
      await page.waitForTimeout(SPRAY_RENDER_DELAY_MS);
      await handlePageInterruptions(page);

      const refreshedPopup = await findPopupForPlayer(page, playerName, "spray chart popup");
      const finalPopup = refreshedPopup && refreshedPopup.box ? refreshedPopup : popup;

      await screenshotPopupWindow(page, finalPopup, filePath);

      results.push({
        player: playerName,
        captured: true,
        method: "modal_popup_player_matched_clipped_screenshot",
        popup_text_sample: finalPopup.text.substring(0, 200),
        file: filePath
      });

      console.log(`Saved spray chart window for ${playerName}: ${filePath}`);

      await clickVisibleCloseButton(page, playerName);

      const disappeared = await waitForPopupToDisappear(page, playerName);

      if (!disappeared) {
        console.log(`Warning: spray chart popup may still be open after trying to close ${playerName}.`);
        await page.screenshot({
          path: path.join(sprayDir, `${String(i + 1).padStart(2, "0")}-${cleanPlayer}-spray-after-close-warning.png`),
          fullPage: false
        }).catch(() => {});
      }
    } else {
      const debugPath = path.join(sprayDir, `${String(i + 1).padStart(2, "0")}-${cleanPlayer}-spray-debug.png`);

      await handlePageInterruptions(page);
      await page.screenshot({ path: debugPath, fullPage: false });

      await clickVisibleCloseButton(page, playerName);
      await waitForPopupToDisappear(page, playerName);

      results.push({
        player: playerName,
        captured: false,
        reason: "Clicked spray icon but could not identify popup after waiting",
        debug_file: debugPath
      });

      console.log(`Saved spray debug screenshot for ${playerName}: ${debugPath}`);
    }

    await page.waitForTimeout(SPRAY_CLOSE_DELAY_MS);
  }

  return results;
}

function deletePngFilesContainingBeforeClick(rootDir) {
  if (!fs.existsSync(rootDir)) return [];

  const deleted = [];

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      const lowerName = entry.name.toLowerCase();

      if (lowerName.endsWith(".png") && lowerName.includes("-before-click")) {
        fs.unlinkSync(fullPath);
        deleted.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return deleted;
}

async function forceRenderFullPage(page, options = {}) {
  const step = Number(options.step || 700);
  const delayMs = Number(options.delayMs || 350);
  const maxScrolls = Number(options.maxScrolls || 35);

  await handlePageInterruptions(page);

  const totalHeight = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    return Math.max(
      doc.scrollHeight,
      body ? body.scrollHeight : 0,
      doc.clientHeight
    );
  }).catch(() => VIEWPORT.height);

  let y = 0;
  let scrolls = 0;

  while (y < totalHeight && scrolls < maxScrolls) {
    await page.evaluate(yValue => window.scrollTo(0, yValue), y).catch(() => {});
    await page.waitForTimeout(delayMs);
    await handlePageInterruptions(page);
    y += step;
    scrolls++;
  }

  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(delayMs);
  await handlePageInterruptions(page);
}

async function getBoxScoreClip(page) {
  await handlePageInterruptions(page);

  // PG lazy-renders some of the lower box-score content, especially the pitching tables.
  // If we calculate the clip too early, we only capture the batting tables and miss the
  // pitching tables below the Batting Summary. Scroll the page first to force everything
  // in the Box Score tab to render, then calculate the bottom cutoff.
  await forceRenderFullPage(page, {
    step: 650,
    delayMs: 300,
    maxScrolls: 30
  });

  return await page.evaluate(() => {
    function isVisible(el) {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 0 &&
        rect.height > 0;
    }

    function clean(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function visibleBox(el) {
      if (!el || !isVisible(el)) return null;
      const rect = el.getBoundingClientRect();
      return {
        top: rect.top + window.scrollY,
        bottom: rect.bottom + window.scrollY,
        left: rect.left + window.scrollX,
        right: rect.right + window.scrollX,
        width: rect.width,
        height: rect.height
      };
    }

    function textUpper(el) {
      return clean(el.innerText || el.textContent || "").toUpperCase();
    }

    const doc = document.documentElement;
    const body = document.body;

    const width = Math.max(doc.scrollWidth, body ? body.scrollWidth : 0, doc.clientWidth);
    const height = Math.max(doc.scrollHeight, body ? body.scrollHeight : 0, doc.clientHeight);

    // IMPORTANT: do NOT use broad classes like .GameRecap here. PG uses "Game Recap"
    // text in the black hero/header area too. We only want the narrative article block
    // below the full box score, which has pnlGameRecap/lblContent/RecapSubTitle-style markup.
    const narrativeCandidates = Array.from(document.querySelectorAll([
      '#ContentTopLevel_ContentPlaceHolder1_pnlGameRecap',
      '[id*="pnlGameRecap" i]',
      '#ContentTopLevel_ContentPlaceHolder1_lblContent',
      '[id*="lblContent" i]',
      '.RecapSubTitle'
    ].join(',')))
      .map(visibleBox)
      .filter(Boolean)
      .filter(box => box.top > 600)
      .sort((a, b) => a.top - b.top);

    const narrativeTop = narrativeCandidates.length ? narrativeCandidates[0].top : null;

    const candidates = [];

    // Collect the actual stat tables and the text immediately around them. This catches:
    // - two batting tables
    // - Batting Summary sections
    // - two pitching tables below the summaries
    for (const el of Array.from(document.querySelectorAll('table, tbody, tr, div, section'))) {
      const box = visibleBox(el);
      if (!box) continue;
      if (box.width < 250 || box.height < 10) continue;
      if (narrativeTop && box.top >= narrativeTop - 5) continue;

      const upper = textUpper(el);

      const isBattingTable =
        upper.includes('BATTING') &&
        upper.includes('AB') &&
        upper.includes('OPS');

      const isPitchingTable =
        upper.includes('PITCHING') &&
        upper.includes('IP') &&
        upper.includes('ER') &&
        (upper.includes('AVG-FB') || upper.includes('T-FB') || upper.includes('PC') || upper.includes('SO'));

      const isSummary =
        upper.includes('BATTING SUMMARY') ||
        upper.includes('RBI:') ||
        upper.includes('1B:') ||
        upper.includes('2B:') ||
        upper.includes('3B:');

      const isScoreHeader =
        upper.includes('FINAL') ||
        upper.includes('GAME RECAP') ||
        upper.includes('BOX SCORE') ||
        upper.includes('PITCH BY PITCH');

      if (isBattingTable || isPitchingTable || isSummary || isScoreHeader) {
        candidates.push({
          top: box.top,
          bottom: box.bottom,
          left: box.left,
          right: box.right,
          width: box.width,
          height: box.height,
          kind: isPitchingTable ? 'pitching' : isBattingTable ? 'batting' : isSummary ? 'summary' : 'header'
        });
      }
    }

    // The strongest signal for the desired bottom is the lower edge of the pitching tables.
    const pitchingBottoms = candidates
      .filter(c => c.kind === 'pitching')
      .map(c => c.bottom);

    const allCandidateBottoms = candidates.map(c => c.bottom);

    let bottom = 0;

    if (pitchingBottoms.length) {
      bottom = Math.max(...pitchingBottoms) + 35;
    } else if (allCandidateBottoms.length) {
      bottom = Math.max(...allCandidateBottoms) + 50;
    }

    if (narrativeTop) {
      if (!bottom || bottom > narrativeTop) bottom = narrativeTop - 12;
      // If the pitching tables are above the narrative, include everything up to just before narrative.
      // This is usually safest because the narrative is exactly the content Troy does not want.
      if (pitchingBottoms.length && narrativeTop > Math.max(...pitchingBottoms)) {
        bottom = Math.min(narrativeTop - 12, Math.max(...pitchingBottoms) + 45);
      }
    }

    if (!bottom || bottom < 1000) {
      // Fallback: many PG box-score pages with replay need about 1500-1800 px to include pitching tables.
      bottom = Math.min(height, 1900);
    }

    bottom = Math.max(900, Math.min(bottom, height));

    return {
      x: 0,
      y: 0,
      width: Math.min(width, 2400),
      height: bottom,
      pageWidth: width,
      pageHeight: height,
      cutoffSelector: narrativeTop ? 'actual-narrative-recap-block' : 'pitching-table-bottom-fallback',
      detectedPitchingTables: pitchingBottoms.length,
      candidateCount: candidates.length
    };
  });
}


function cleanGameImageFileName(value) {
  // Windows-safe, but preserves commas because Troy specifically wanted the date formatted with a comma.
  return String(value || "unknown")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 110) || "unknown";
}

function formatGameTimeForFile(dateText, timeText) {
  const rawDate = String(dateText || "").trim();
  const rawTime = String(timeText || "").trim().toUpperCase();

  if (!rawDate || !rawTime) return "date-time-not-found";

  const dateMatch = rawDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const timeMatch = rawTime.match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);

  if (!dateMatch || !timeMatch) {
    return cleanGameImageFileName(`${rawDate}-${rawTime}`);
  }

  const monthNumber = Number(dateMatch[1]);
  const dayNumber = Number(dateMatch[2]);
  const yearNumber = Number(dateMatch[3]);
  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const ampm = timeMatch[3].toUpperCase();

  if (ampm === "PM" && hour !== 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;

  const start = new Date(yearNumber, monthNumber - 1, dayNumber, hour, minute, 0);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function fmtTime(d) {
    let h = d.getHours();
    const m = d.getMinutes();
    const suffix = h >= 12 ? "PM" : "AM";
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}${String(m).padStart(2, "0")}-${suffix}`;
  }

  return `${weekdays[start.getDay()]}-${months[start.getMonth()]}-${start.getDate()},-${fmtTime(start)}-${fmtTime(end)}-CT`;
}

async function extractBoxScoreMetadata(page, fallbackTeamName, game) {
  await handlePageInterruptions(page);

  const metadata = await page.evaluate(() => {
    function clean(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    const bodyText = clean(document.body ? document.body.innerText : "");
    const dateTimeMatch = bodyText.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)/i);

    const teamCandidates = [];
    const seen = new Set();

    function addTeam(name) {
      let value = clean(name)
        .replace(/^\d+\s+/, "")
        .replace(/\s+\d+$/, "")
        .trim();

      if (!value) return;
      if (/^(Gm|Game|Final|Recap|Pitch|Box|Roster|Pitching|AB|R|H|E)$/i.test(value)) return;
      if (value.length < 3 || value.length > 80) return;

      const key = value.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      teamCandidates.push(value);
    }

    // Best source: scoreboard rows. They generally look like:
    // Team Name 0 0 4 0 1 0 X 5 2 3
    for (const el of Array.from(document.querySelectorAll('tr, .row, div'))) {
      const text = clean(el.innerText || el.textContent || "");
      if (!text) continue;
      if (text.length > 220) continue;
      if (!/\b[0-9X]\b\s+\b[0-9X]\b/i.test(text)) continue;
      if (!/(\sR\s+H\s+E|\s\d+\s+\d+\s+\d+\s*$)/i.test(text)) continue;

      const withoutHeaders = text.replace(/\b(?:1|2|3|4|5|6|7|R|H|E)\b/g, " ").replace(/\s+/g, " ").trim();
      const match = text.match(/^(.+?)\s+(?:\d|X)\s+(?:\d|X)\s+(?:\d|X)/i);
      if (match) addTeam(match[1]);
      else addTeam(withoutHeaders);
    }

    // Fallback: top headline/score area often has separate team names around scores.
    const topText = clean(bodyText.slice(0, 2500));
    const lines = topText.split(/\s{2,}|\n/).map(clean).filter(Boolean);
    for (const line of lines) {
      const m = line.match(/^(.+?)\s+\d+$/);
      if (m && !/^(Gm|Final)$/i.test(m[1])) addTeam(m[1]);
    }

    return {
      dateText: dateTimeMatch ? dateTimeMatch[1] : "",
      timeText: dateTimeMatch ? dateTimeMatch[2].toUpperCase().replace(/\s+/g, " ") : "",
      teams: teamCandidates.slice(0, 2),
      rawTopText: topText
    };
  }).catch(() => ({ dateText: "", timeText: "", teams: [], rawTopText: "" }));

  let teamA = metadata.teams && metadata.teams[0] ? metadata.teams[0] : fallbackTeamName || "Team-A";
  let teamB = metadata.teams && metadata.teams[1] ? metadata.teams[1] : game?.opponent || "Opponent";

  teamA = stripTeamRecord(teamA);
  teamB = stripTeamRecord(teamB);

  const dateTimePart = formatGameTimeForFile(metadata.dateText, metadata.timeText);
  const base = cleanGameImageFileName(`game-box-score-${teamA}-vs-${teamB}-${dateTimePart}`);

  return {
    ...metadata,
    teamA,
    teamB,
    dateTimePart,
    boxScoreBaseName: base,
    pitchByPitchBaseName: base.replace(/^game-box-score-/, "game-pitch-by-pitch-")
  };
}

async function getFullBoxScoreCrop(page) {
  await handlePageInterruptions(page);

  await forceRenderFullPage(page, {
    step: Number(process.env.PG_BOX_SCORE_RENDER_STEP_PX || 550),
    delayMs: Number(process.env.PG_BOX_SCORE_RENDER_DELAY_MS || 0),
    maxScrolls: Number(process.env.PG_BOX_SCORE_RENDER_MAX_SCROLLS || 45)
  });

  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(PG_BOX_SCORE_SCREENSHOT_DELAY_MS);
  await handlePageInterruptions(page);

  await page.addStyleTag({
    content: `
      iframe[style*="fixed"],
      div[style*="fixed"],
      button[style*="fixed"],
      [class*="intercom" i],
      [id*="intercom" i],
      [class*="chat" i],
      [id*="chat" i],
      [class*="launcher" i],
      [id*="launcher" i] {
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `
  }).catch(() => {});

  return await page.evaluate(() => {
    function isVisible(el) {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 0 &&
        rect.height > 0;
    }

    function box(el) {
      if (!el || !isVisible(el)) return null;
      const rect = el.getBoundingClientRect();
      return {
        top: rect.top + window.scrollY,
        bottom: rect.bottom + window.scrollY,
        left: rect.left + window.scrollX,
        right: rect.right + window.scrollX,
        width: rect.width,
        height: rect.height
      };
    }

    function clean(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function upper(el) {
      return clean(el.innerText || el.textContent || "").toUpperCase();
    }

    const doc = document.documentElement;
    const body = document.body;
    const pageWidth = Math.max(doc.clientWidth, body ? body.clientWidth : 0, window.innerWidth || 0);
    const pageHeight = Math.max(doc.scrollHeight, body ? body.scrollHeight : 0, doc.clientHeight);

    // 1) Preferred cutoff: the actual white narrative recap card below the box-score tables.
    // Do not confuse this with the black top header that also says "Game Recap".
    const narrativeSelectors = [
      '#ContentTopLevel_ContentPlaceHolder1_pnlGameRecap',
      '[id*="pnlGameRecap" i]',
      '#ContentTopLevel_ContentPlaceHolder1_lblRecapTitle',
      '[id*="lblRecapTitle" i]',
      '#ContentTopLevel_ContentPlaceHolder1_lblContent',
      '[id*="lblContent" i]',
      '#ContentTopLevel_ContentPlaceHolder1_pnlRecapTopPerformers',
      '[id*="pnlRecapTopPerformers" i]',
      '.RecapSubTitle'
    ];

    const narrativeCandidates = [];
    for (const el of Array.from(document.querySelectorAll(narrativeSelectors.join(',')))) {
      const b = box(el);
      if (!b) continue;
      if (b.top < 650) continue;
      const txt = upper(el);
      const id = String(el.id || '').toLowerCase();
      let top = b.top;

      const card = el.closest('.my-5.bg-white, .bg-white.rounded-3, .rounded-3, [id*="pnlGameRecap" i]');
      const cardBox = box(card);
      if (cardBox && cardBox.top >= 650 && cardBox.top <= b.top + 20) {
        top = cardBox.top;
      }

      if (id.includes('lblrecaptitle') || id.includes('lblcontent') || id.includes('pnlgamerecap') || id.includes('pnlrecaptopperformers') || txt.includes('HIGHLIGHTS')) {
        narrativeCandidates.push(top);
      }
    }

    let cropBottom = narrativeCandidates.length ? Math.min(...narrativeCandidates) - 12 : 0;

    // 2) Backup cutoff: find first large white/gray article card below the stats tables that contains highlights/top performers.
    if (!cropBottom || cropBottom < 900) {
      const articleCards = Array.from(document.querySelectorAll('div,section'))
        .map(el => ({ el, b: box(el), txt: upper(el) }))
        .filter(item => item.b && item.b.top > 700 && item.b.width > 500 && item.b.height > 120)
        .filter(item => item.txt.includes('HIGHLIGHTS') || item.txt.includes('TOP PERFORMERS'))
        .sort((a, b) => a.b.top - b.b.top);
      if (articleCards.length) cropBottom = articleCards[0].b.top - 12;
    }

    // 3) Last fallback: crop just below the last real pitching/batting table and summary block.
    // Only use tables and compact summary text, never broad divs that include the narrative.
    if (!cropBottom || cropBottom < 900 || cropBottom > pageHeight - 300) {
      const bottoms = [];
      const tables = Array.from(document.querySelectorAll('table')).map(el => ({ el, b: box(el), txt: upper(el) })).filter(x => x.b);
      for (const item of tables) {
        if (item.b.width < 300 || item.b.height < 25) continue;
        if (item.txt.includes('BATTING') && item.txt.includes('AB') && item.txt.includes('OPS')) bottoms.push(item.b.bottom);
        if (item.txt.includes('PITCHING') && item.txt.includes('IP') && (item.txt.includes('ER') || item.txt.includes('SO') || item.txt.includes('PC') || item.txt.includes('AVG-FB'))) bottoms.push(item.b.bottom);
      }

      const summaries = Array.from(document.querySelectorAll('div,p,span'))
        .map(el => ({ el, b: box(el), txt: upper(el) }))
        .filter(item => item.b && item.b.top > 650 && item.b.width > 250 && item.b.height < 220)
        .filter(item => item.txt.includes('BATTING SUMMARY') || item.txt.startsWith('RBI:') || item.txt.startsWith('1B:') || item.txt.startsWith('2B:') || item.txt.startsWith('3B:'));
      for (const item of summaries) bottoms.push(item.b.bottom);

      if (bottoms.length) cropBottom = Math.max(...bottoms) + 35;
    }

    if (!cropBottom || cropBottom < 900) cropBottom = Math.min(pageHeight, 2400);
    cropBottom = Math.max(900, Math.min(cropBottom, pageHeight));

    return {
      x: 0,
      y: 0,
      width: pageWidth,
      height: Math.ceil(cropBottom),
      pageHeight,
      usedNarrativeCutoff: narrativeCandidates.length > 0,
      narrativeTop: narrativeCandidates.length ? Math.min(...narrativeCandidates) : null
    };
  });
}

async function captureFullPageThenCrop(page, crop, outputPath, options = {}) {
  ensureDirectory(path.dirname(outputPath));

  const tempDir = fs.mkdtempSync(path.join(path.dirname(outputPath), "_tmp_fullpage_crop_"));
  const fullPath = path.join(tempDir, "full-page.png");

  try {
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.waitForTimeout(Number(options.beforeScreenshotDelayMs || 0));
    await handlePageInterruptions(page);

    await page.screenshot({
      path: fullPath,
      fullPage: true,
      animations: "disabled"
    });

    const image = sharp(fullPath);
    const metadata = await image.metadata();

    const extract = {
      left: Math.max(0, Math.floor(crop.x || 0)),
      top: Math.max(0, Math.floor(crop.y || 0)),
      width: Math.min(metadata.width || crop.width, Math.floor(crop.width || metadata.width || VIEWPORT.width)),
      height: Math.min((metadata.height || crop.height), Math.floor(crop.height || metadata.height || VIEWPORT.height))
    };

    if (extract.left + extract.width > metadata.width) extract.width = metadata.width - extract.left;
    if (extract.top + extract.height > metadata.height) extract.height = metadata.height - extract.top;

    if (extract.width <= 0 || extract.height <= 0) {
      throw new Error(`Invalid crop dimensions: ${JSON.stringify(extract)}`);
    }

    await sharp(fullPath)
      .extract(extract)
      .png()
      .toFile(outputPath);

    return {
      file: outputPath,
      fullPageCapturedThenCropped: true,
      crop,
      extract,
      sourceImage: {
        width: metadata.width,
        height: metadata.height
      }
    };
  } finally {
    safeRm(tempDir);
  }
}


async function clickDiamondKastTab(page, tabText) {
  await handlePageInterruptions(page);

  const result = await page.evaluate((tabText) => {
    function clean(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function isVisible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 0 &&
        rect.height > 0;
    }

    function scoreCandidate(el, target) {
      const rect = el.getBoundingClientRect();
      const text = clean(el.innerText || el.textContent || "").toUpperCase();
      const parentText = clean(
        (el.closest("ul,nav,.nav,.tabs,.tab-content,.card,section,div") || el.parentElement || el).innerText || ""
      ).toUpperCase();

      let score = 0;

      if (text === target) score += 1000;
      if (parentText.includes("BOX SCORE") && parentText.includes("PITCH BY PITCH")) score += 500;
      if (parentText.includes("GAME RECAP")) score += 100;
      if (rect.top > 250) score += 150;
      if (rect.top > 250 && rect.top < 900) score += 200;
      if (["A", "BUTTON", "LI", "SPAN"].includes(el.tagName.toUpperCase())) score += 50;
      if ((el.getAttribute("href") || "").toUpperCase().includes("PITCH")) score += 100;

      // Penalize anything in the global nav/header area.
      if (rect.top < 180) score -= 1000;

      return score;
    }

    const target = clean(tabText).toUpperCase();
    const all = Array.from(document.querySelectorAll("a,button,span,div,li,[role='tab']"));

    const candidates = all
      .filter(isVisible)
      .map(el => ({
        el,
        text: clean(el.innerText || el.textContent || "").toUpperCase(),
        rect: el.getBoundingClientRect(),
        href: el.getAttribute("href") || ""
      }))
      .filter(item => item.text === target)
      .map(item => ({
        ...item,
        score: scoreCandidate(item.el, target)
      }))
      .sort((a, b) => b.score - a.score || a.rect.top - b.rect.top);

    const selected = candidates[0];

    if (!selected) {
      return {
        clicked: false,
        reason: `Could not find visible ${tabText} tab`,
        candidates: []
      };
    }

    selected.el.scrollIntoView({ block: "center", inline: "center" });
    selected.el.click();

    return {
      clicked: true,
      text: selected.text,
      top: selected.rect.top,
      href: selected.href,
      score: selected.score,
      candidate_count: candidates.length
    };
  }, tabText).catch(error => ({
    clicked: false,
    reason: error.message
  }));

  await page.waitForTimeout(PG_AFTER_CLICK_DELAY_MS || 1500);
  await handlePageInterruptions(page);

  if (!result.clicked) {
    // Fallback with Playwright's text locator.
    const clickedByLocator = await page.getByText(tabText, { exact: true })
      .last()
      .click({ force: true, timeout: 4000 })
      .then(() => true)
      .catch(() => false);

    if (clickedByLocator) {
      await page.waitForTimeout(PG_AFTER_CLICK_DELAY_MS || 1500);
      await handlePageInterruptions(page);
      return {
        clicked: true,
        method: "playwright-text-last"
      };
    }
  }

  return result;
}

async function waitForPitchByPitchContent(page) {
  const verified = await page.waitForFunction(() => {
    function clean(value) {
      return String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
    }

    function isVisible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 0 &&
        rect.height > 0;
    }

    function box(el) {
      const rect = el.getBoundingClientRect();
      return {
        top: rect.top + window.scrollY,
        bottom: rect.bottom + window.scrollY,
        height: rect.height,
        width: rect.width
      };
    }

    const playPattern = /(TOP|BOTTOM)\s+\d|CALLED STRIKE|SWINGING STRIKE|STRIKEOUT|STRUCK OUT|SINGLED|DOUBLED|TRIPLED|HOMERED|WALKED|HIT BY PITCH|GROUNDED|FLIED|LINED|POPPED|FOULED|STOLE|ADVANCED|SCORED|PITCHING CHANGE|DEFENSIVE SUBSTITUTION/;

    const pitchTabs = Array.from(document.querySelectorAll("a,button,span,div,li,[role='tab']"))
      .filter(el => isVisible(el) && clean(el.innerText || el.textContent || "") === "PITCH BY PITCH")
      .map(el => ({ el, b: box(el) }))
      .filter(item => item.b.top > 180)
      .sort((a, b) => a.b.top - b.b.top);

    if (!pitchTabs.length) return false;

    const tabBottom = pitchTabs[0].b.bottom;

    const panels = Array.from(document.querySelectorAll("div,section,form,table,tbody"))
      .filter(isVisible)
      .map(el => ({ el, b: box(el), text: clean(el.innerText || el.textContent || "") }))
      .filter(item => item.b.top >= tabBottom - 20 && item.b.height > 120 && item.b.width > 300)
      .filter(item => playPattern.test(item.text))
      .filter(item => {
        // Hard reject the Box Score content. It was being captured as pitch-by-pitch chunks.
        const text = item.text;
        if (text.includes("BATTING SUMMARY")) return false;
        if (text.includes("BOX SCORE") && text.includes("PITCHING") && text.includes("BATTING")) return false;
        if (text.includes("AVG-FB") || text.includes("T-FB")) return false;
        if (text.includes(" OPS ") && text.includes(" SLG ") && text.includes(" OBP ")) return false;
        return true;
      })
      .sort((a, b) => b.b.height - a.b.height);

    return panels.length > 0;
  }, {}, { timeout: Number(process.env.PG_PITCH_BY_PITCH_WAIT_MS || 15000) })
    .then(() => true)
    .catch(() => false);

  await page.waitForTimeout(PG_PITCH_BY_PITCH_SCREENSHOT_DELAY_MS || 1000);
  await handlePageInterruptions(page);

  if (!verified) {
    const debugDir = path.join(RUN_STATE_ROOT, "logs");
    ensureDirectory(debugDir);

    const debugPath = path.join(debugDir, `pitch-by-pitch-not-verified-${Date.now()}.png`);

    await page.screenshot({
      path: debugPath,
      fullPage: true
    }).catch(() => {});

    throw new Error(`Clicked Pitch By Pitch tab, but pitch-by-pitch content was not verified. Debug screenshot: ${debugPath}`);
  }

  return true;
}

async function getPitchByPitchClip(page) {
  await handlePageInterruptions(page);

  // Do NOT pre-scroll the entire Pitch By Pitch page here.
  // Previous versions did a render walk to the bottom, returned to the top,
  // and then the chunk capture only grabbed the currently visible slice.
  // This function now only calculates a broad document range. The actual
  // screenshot routine scrolls and captures each visible viewport chunk.
  const clip = await page.evaluate(() => {
    function clean(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function upper(value) {
      return clean(value).toUpperCase();
    }

    function isVisible(el) {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 0 &&
        rect.height > 0;
    }

    function visibleBox(el) {
      if (!el || !isVisible(el)) return null;
      const rect = el.getBoundingClientRect();
      return {
        top: rect.top + window.scrollY,
        bottom: rect.bottom + window.scrollY,
        left: rect.left + window.scrollX,
        right: rect.right + window.scrollX,
        width: rect.width,
        height: rect.height
      };
    }

    const doc = document.documentElement;
    const body = document.body;
    const pageWidth = Math.max(doc.scrollWidth, body ? body.scrollWidth : 0, doc.clientWidth, window.innerWidth || 0);
    const pageHeight = Math.max(doc.scrollHeight, body ? body.scrollHeight : 0, doc.clientHeight, window.innerHeight || 0);

    const pitchTabs = Array.from(document.querySelectorAll("a,button,span,div,li,[role='tab']"))
      .filter(el => isVisible(el) && upper(el.innerText || el.textContent || "") === "PITCH BY PITCH")
      .map(el => ({ el, box: visibleBox(el) }))
      .filter(item => item.box && item.box.top > 180)
      .sort((a, b) => a.box.top - b.box.top);

    if (!pitchTabs.length) {
      return {
        found: false,
        reason: "No visible Pitch By Pitch tab found"
      };
    }

    const tab = pitchTabs[0].box;
    const startY = Math.max(0, tab.top - 12);

    // Preferred bottom: just before recap/article/footer content.
    const bottomCandidates = [];

    const recapSelectors = [
      '#ContentTopLevel_ContentPlaceHolder1_pnlGameRecap',
      '[id*="pnlGameRecap" i]',
      '[id*="lblContent" i]',
      '[id*="lblRecap" i]',
      '.RecapSubTitle'
    ];

    for (const el of Array.from(document.querySelectorAll(recapSelectors.join(',')))) {
      const b = visibleBox(el);
      if (!b) continue;
      if (b.top > tab.bottom + 200) bottomCandidates.push(b.top - 12);
    }

    // Backup bottom: first obvious footer below the tab.
    for (const el of Array.from(document.querySelectorAll('footer, [id*="footer" i], [class*="footer" i]'))) {
      const b = visibleBox(el);
      if (!b) continue;
      if (b.top > tab.bottom + 300) bottomCandidates.push(b.top - 12);
    }

    let endY = bottomCandidates.length ? Math.min(...bottomCandidates) : pageHeight;

    if (!endY || endY <= startY + 400) {
      endY = pageHeight;
    }

    return {
      found: true,
      x: 0,
      y: startY,
      width: Math.min(pageWidth, 2200),
      height: Math.max(400, endY - startY),
      pageWidth,
      pageHeight,
      source: "pitch-by-pitch-tab-to-bottom-visible-scroll",
      tabTop: tab.top,
      tabBottom: tab.bottom,
      endY
    };
  });

  if (!clip || !clip.found) {
    throw new Error(`Could not determine pitch-by-pitch capture area: ${clip?.reason || "unknown reason"}`);
  }

  return clip;
}

async function captureClipStitched(page, clip, outputPath, options = {}) {
  ensureDirectory(path.dirname(outputPath));

  const maxSingleHeight = options.maxSingleHeight || 12000;
  const sliceHeight = options.sliceHeight || Math.max(500, VIEWPORT.height - 120);

  const pageSize = await page.evaluate(() => ({
    width: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0, document.documentElement.clientWidth),
    height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, document.documentElement.clientHeight)
  })).catch(() => ({ width: clip.pageWidth || VIEWPORT.width, height: clip.pageHeight || VIEWPORT.height }));

  const normalizedClip = {
    x: Math.max(0, Math.floor(clip.x || 0)),
    y: Math.max(0, Math.floor(clip.y || 0)),
    width: Math.max(1, Math.min(Math.floor(clip.width || VIEWPORT.width), Math.floor(pageSize.width - Math.max(0, clip.x || 0)))),
    height: Math.max(1, Math.min(Math.floor(clip.height || VIEWPORT.height), Math.floor(pageSize.height - Math.max(0, clip.y || 0))))
  };

  const sliceDelayMs = Number(options.sliceDelayMs || 0);

  if (normalizedClip.height <= maxSingleHeight) {
    await page.evaluate(y => window.scrollTo(0, Math.max(0, y - 120)), normalizedClip.y).catch(() => {});
    await page.waitForTimeout(sliceDelayMs || 350);
    await handlePageInterruptions(page);

    await page.screenshot({
      path: outputPath,
      clip: normalizedClip
    });

    return {
      file: outputPath,
      stitched: false,
      slices: 1,
      clip: normalizedClip
    };
  }

  const tempDir = path.join(path.dirname(outputPath), `_tmp_${path.parse(outputPath).name}`);
  ensureDirectory(tempDir);

  const sliceFiles = [];

  try {
    let offset = 0;
    let index = 0;

    while (offset < normalizedClip.height) {
      const currentHeight = Math.min(sliceHeight, normalizedClip.height - offset);
      const y = normalizedClip.y + offset;

      const slicePath = path.join(tempDir, `${String(index).padStart(3, "0")}.png`);

      await page.evaluate(yValue => window.scrollTo(0, Math.max(0, yValue - 140)), y).catch(() => {});
      await page.waitForTimeout(sliceDelayMs || 1200);
      await handlePageInterruptions(page);
      await page.waitForTimeout(350);

      await page.screenshot({
        path: slicePath,
        clip: {
          x: normalizedClip.x,
          y,
          width: normalizedClip.width,
          height: currentHeight
        }
      });

      sliceFiles.push({
        path: slicePath,
        top: offset,
        height: currentHeight
      });

      offset += currentHeight;
      index++;
    }

    const composites = sliceFiles.map(slice => ({
      input: slice.path,
      top: slice.top,
      left: 0
    }));

    await sharp({
      create: {
        width: normalizedClip.width,
        height: normalizedClip.height,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      }
    })
      .composite(composites)
      .png()
      .toFile(outputPath);

    return {
      file: outputPath,
      stitched: true,
      slices: sliceFiles.length,
      clip: normalizedClip
    };
  } finally {
    safeRm(tempDir);
  }
}



async function markPitchByPitchScrollContainer(page) {
  await handlePageInterruptions(page);

  return await page.evaluate(() => {
    function clean(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function upper(value) {
      return clean(value).toUpperCase();
    }

    function isVisible(el) {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth;
    }

    function box(el) {
      const rect = el.getBoundingClientRect();
      return {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        pageTop: rect.top + window.scrollY,
        pageBottom: rect.bottom + window.scrollY
      };
    }

    function isBoxScoreText(textUpper) {
      return (
        textUpper.includes("BATTING SUMMARY") ||
        textUpper.includes("AVG-FB") ||
        textUpper.includes("T-FB") ||
        (textUpper.includes(" OPS ") && textUpper.includes(" OBP ") && textUpper.includes(" SLG ")) ||
        (textUpper.includes("BOX SCORE") && textUpper.includes("BATTING") && textUpper.includes("PITCHING"))
      );
    }

    const playPattern = /(TOP|BOTTOM)\s+\d|CALLED STRIKE|SWINGING STRIKE|STRIKEOUT|STRUCK OUT|SINGLED|DOUBLED|TRIPLED|HOMERED|WALKED|HIT BY PITCH|GROUNDED|FLIED|LINED|POPPED|FOULED|STOLE|ADVANCED|SCORED|PITCHING CHANGE|DEFENSIVE SUBSTITUTION|MPH\s+(FASTBALL|CURVEBALL|SLIDER|CHANGEUP)|\bBALL\b|\bFOUL\b|\bOUT\b/i;

    for (const el of Array.from(document.querySelectorAll('[data-pg-pbp-scroll-container="true"]'))) {
      el.removeAttribute('data-pg-pbp-scroll-container');
    }

    const pitchTabs = Array.from(document.querySelectorAll("a,button,span,div,li,[role='tab']"))
      .filter(el => isVisible(el) && upper(el.innerText || el.textContent || "") === "PITCH BY PITCH")
      .map(el => ({ el, b: box(el) }))
      .filter(item => item.b.pageTop > 180)
      .sort((a, b) => a.b.pageTop - b.b.pageTop);

    const tabBottom = pitchTabs.length ? pitchTabs[0].b.pageBottom : 0;

    const candidates = Array.from(document.querySelectorAll('div,section,main,article,form'))
      .filter(isVisible)
      .map(el => {
        const b = box(el);
        const text = clean(el.innerText || el.textContent || "");
        const textUpper = text.toUpperCase();
        const scrollHeight = el.scrollHeight || 0;
        const clientHeight = el.clientHeight || 0;
        const overflowY = window.getComputedStyle(el).overflowY;
        return { el, b, text, textUpper, scrollHeight, clientHeight, overflowY };
      })
      .filter(item => item.b.pageTop >= tabBottom - 50)
      .filter(item => item.b.width >= 450 && item.b.height >= 220)
      .filter(item => item.scrollHeight > item.clientHeight + 150)
      .filter(item => /auto|scroll|overlay/i.test(item.overflowY) || item.scrollHeight > item.clientHeight + 250)
      .filter(item => playPattern.test(item.text))
      .filter(item => !isBoxScoreText(item.textUpper))
      .map(item => {
        const scrollExtra = item.scrollHeight - item.clientHeight;
        const textScore = Math.min(2500, item.text.length / 4);
        const score = scrollExtra * 3 + item.b.height + item.b.width / 4 + textScore;
        return { ...item, score };
      })
      .sort((a, b) => b.score - a.score);

    const selected = candidates[0];

    if (!selected) {
      return {
        found: false,
        reason: 'No internal scroll container found; will use document/page chunk fallback.'
      };
    }

    selected.el.setAttribute('data-pg-pbp-scroll-container', 'true');
    selected.el.scrollTop = 0;

    return {
      found: true,
      box: selected.b,
      scrollHeight: selected.scrollHeight,
      clientHeight: selected.clientHeight,
      scrollExtra: selected.scrollHeight - selected.clientHeight,
      overflowY: selected.overflowY,
      sample: selected.text.slice(0, 500),
      candidateCount: candidates.length
    };
  }).catch(error => ({ found: false, reason: error.message }));
}

async function capturePitchByPitchScrollableContainerChunks(page, outputDir, baseName, options = {}) {
  ensureDirectory(outputDir);

  const containerInfo = await markPitchByPitchScrollContainer(page);

  if (!containerInfo || !containerInfo.found) {
    return {
      usedScrollableContainer: false,
      reason: containerInfo?.reason || 'No scrollable pitch-by-pitch container found'
    };
  }

  console.log(`Pitch-by-pitch uses internal scroll container: visibleHeight=${containerInfo.clientHeight}, scrollHeight=${containerInfo.scrollHeight}, candidates=${containerInfo.candidateCount || 0}`);

  const sliceDelayMs = Number(options.sliceDelayMs || PITCH_BY_PITCH_SLICE_DELAY_MS || 0);
  const overlap = Number(options.overlap || process.env.PG_PITCH_BY_PITCH_CHUNK_OVERLAP || 80);
  const safeBaseName = cleanGameImageFileName(baseName || "game-pitch-by-pitch");

  const chunkFiles = [];
  let index = 1;

  let metrics = await page.evaluate(() => {
    const el = document.querySelector('[data-pg-pbp-scroll-container="true"]');
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height
    };
  });

  if (!metrics) {
    return {
      usedScrollableContainer: false,
      reason: 'Marked pitch-by-pitch scroll container disappeared before capture'
    };
  }

  const step = Math.max(200, Math.floor(metrics.clientHeight - overlap));
  const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  const seenScrollTops = new Set();
  let scrollTop = 0;

  while (true) {
    await page.evaluate(value => {
      const el = document.querySelector('[data-pg-pbp-scroll-container="true"]');
      if (el) el.scrollTop = value;
    }, scrollTop).catch(() => {});

    await page.waitForTimeout(sliceDelayMs || 800);
    await handlePageInterruptions(page);
    await page.waitForTimeout(250);

    metrics = await page.evaluate(() => {
      const el = document.querySelector('[data-pg-pbp-scroll-container="true"]');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        scrollTop: Math.round(el.scrollTop),
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      };
    });

    if (!metrics) break;

    const actualTop = Math.round(metrics.scrollTop || 0);
    const key = String(actualTop);

    if (seenScrollTops.has(key) && chunkFiles.length) {
      break;
    }

    seenScrollTops.add(key);

    const chunkFileName = `${safeBaseName}-chunk-${String(index).padStart(3, "0")}.png`;
    const chunkPath = path.join(outputDir, chunkFileName);

    const clip = {
      x: Math.max(0, Math.floor(metrics.x)),
      y: Math.max(0, Math.floor(metrics.y)),
      width: Math.max(1, Math.min(Math.floor(metrics.width), VIEWPORT.width - Math.max(0, Math.floor(metrics.x)))),
      height: Math.max(1, Math.min(Math.floor(metrics.height), VIEWPORT.height - Math.max(0, Math.floor(metrics.y))))
    };

    await page.screenshot({
      path: chunkPath,
      clip,
      animations: "disabled"
    });

    chunkFiles.push({
      index,
      file: chunkPath,
      scrollTop: actualTop,
      clip
    });

    if (actualTop >= maxScrollTop - 5) {
      break;
    }

    const nextTop = Math.min(maxScrollTop, actualTop + step);
    if (nextTop <= actualTop) break;

    scrollTop = nextTop;
    index++;

    if (index > Number(process.env.PG_PITCH_BY_PITCH_MAX_CHUNKS || 80)) {
      console.log('Warning: reached PG_PITCH_BY_PITCH_MAX_CHUNKS while capturing internal pitch-by-pitch scroll container.');
      break;
    }
  }

  await page.evaluate(() => {
    const el = document.querySelector('[data-pg-pbp-scroll-container="true"]');
    if (el) el.scrollTop = 0;
  }).catch(() => {});

  return {
    captured: chunkFiles.length > 0,
    mode: "internal-scroll-container-chunked",
    stitched: false,
    usedScrollableContainer: true,
    chunk_count: chunkFiles.length,
    chunk_height: Math.round(metrics?.clientHeight || containerInfo.clientHeight || 0),
    overlap,
    scrollHeight: containerInfo.scrollHeight,
    clientHeight: containerInfo.clientHeight,
    chunks: chunkFiles
  };
}

async function capturePitchByPitchChunks(page, clip, outputDir, baseName, options = {}) {
  ensureDirectory(outputDir);

  // Capture what is actually visible while scrolling down the Pitch By Pitch view.
  // This fixes the failure mode where the page scrolls to the bottom first, jumps back
  // to the top, captures one small card, and closes the tab.
  const safeBaseName = cleanGameImageFileName(baseName || "game-pitch-by-pitch");
  const overlap = Number(options.overlap || process.env.PG_PITCH_BY_PITCH_CHUNK_OVERLAP || 120);
  const sliceDelayMs = Number(options.sliceDelayMs || PITCH_BY_PITCH_SLICE_DELAY_MS || 0);
  const maxChunks = Number(process.env.PG_PITCH_BY_PITCH_MAX_CHUNKS || 120);

  await handlePageInterruptions(page);

  const pageSize = await page.evaluate(() => ({
    width: Math.max(
      document.documentElement.scrollWidth,
      document.body ? document.body.scrollWidth : 0,
      document.documentElement.clientWidth,
      window.innerWidth || 0
    ),
    height: Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
      document.documentElement.clientHeight,
      window.innerHeight || 0
    ),
    viewportWidth: window.innerWidth || document.documentElement.clientWidth,
    viewportHeight: window.innerHeight || document.documentElement.clientHeight
  })).catch(() => ({
    width: clip.pageWidth || VIEWPORT.width,
    height: clip.pageHeight || VIEWPORT.height,
    viewportWidth: VIEWPORT.width,
    viewportHeight: VIEWPORT.height
  }));

  const startY = Math.max(0, Math.floor(clip.y || 0));
  const endY = Math.min(
    Math.floor(pageSize.height),
    Math.max(startY + 300, Math.floor((clip.y || 0) + (clip.height || pageSize.height)))
  );

  const viewportHeight = Math.max(400, Math.floor(pageSize.viewportHeight || VIEWPORT.height));
  const viewportWidth = Math.max(400, Math.floor(pageSize.viewportWidth || VIEWPORT.width));

  const topPadding = Number(process.env.PG_PITCH_BY_PITCH_VIEWPORT_TOP_PADDING || 12);
  const bottomPadding = Number(process.env.PG_PITCH_BY_PITCH_VIEWPORT_BOTTOM_PADDING || 20);
  const captureHeight = Math.max(250, viewportHeight - topPadding - bottomPadding);
  const step = Math.max(200, captureHeight - overlap);

  const chunkFiles = [];
  const seenY = new Set();
  let index = 1;
  let scrollY = startY;

  while (scrollY < endY && index <= maxChunks) {
    await page.evaluate(yValue => window.scrollTo(0, Math.max(0, yValue)), scrollY).catch(() => {});
    await page.waitForTimeout(sliceDelayMs || 700);
    await handlePageInterruptions(page);
    await page.waitForTimeout(250);

    const metrics = await page.evaluate(() => ({
      scrollY: Math.round(window.scrollY || document.documentElement.scrollTop || 0),
      pageHeight: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, document.documentElement.clientHeight),
      viewportWidth: window.innerWidth || document.documentElement.clientWidth,
      viewportHeight: window.innerHeight || document.documentElement.clientHeight
    })).catch(() => ({
      scrollY,
      pageHeight: pageSize.height,
      viewportWidth,
      viewportHeight
    }));

    const actualY = Math.round(metrics.scrollY || 0);
    const key = String(actualY);

    if (seenY.has(key) && chunkFiles.length) {
      break;
    }
    seenY.add(key);

    const remainingDocument = Math.max(1, endY - actualY);
    const currentHeight = Math.max(
      1,
      Math.min(
        captureHeight,
        remainingDocument,
        Math.floor((metrics.viewportHeight || viewportHeight) - topPadding - bottomPadding)
      )
    );

    if (currentHeight < 80 && chunkFiles.length) {
      break;
    }

    const chunkFileName = `${safeBaseName}-chunk-${String(index).padStart(3, "0")}.png`;
    const chunkPath = path.join(outputDir, chunkFileName);

    // Important: this clip is viewport-relative after scrolling, not document-y based.
    await page.screenshot({
      path: chunkPath,
      clip: {
        x: 0,
        y: topPadding,
        width: Math.min(Math.floor(metrics.viewportWidth || viewportWidth), VIEWPORT.width || viewportWidth),
        height: currentHeight
      },
      animations: "disabled"
    });

    chunkFiles.push({
      index,
      file: chunkPath,
      scrollY: actualY,
      document_range: {
        from: actualY + topPadding,
        to: actualY + topPadding + currentHeight
      },
      clip: {
        x: 0,
        y: topPadding,
        width: Math.min(Math.floor(metrics.viewportWidth || viewportWidth), VIEWPORT.width || viewportWidth),
        height: currentHeight
      }
    });

    if (actualY + currentHeight >= endY - 10) {
      break;
    }

    const nextY = Math.min(endY - 1, actualY + step);
    if (nextY <= actualY) {
      break;
    }

    scrollY = nextY;
    index++;
  }

  if (index > maxChunks) {
    console.log('Warning: reached PG_PITCH_BY_PITCH_MAX_CHUNKS while capturing visible pitch-by-pitch scroll chunks.');
  }

  await page.evaluate(yValue => window.scrollTo(0, Math.max(0, yValue)), startY).catch(() => {});
  await page.waitForTimeout(300);

  return {
    captured: chunkFiles.length > 0,
    mode: "visible-window-scroll-chunked",
    stitched: false,
    usedScrollableContainer: false,
    chunk_count: chunkFiles.length,
    chunk_height: captureHeight,
    overlap,
    source_clip: {
      x: clip.x || 0,
      y: startY,
      width: clip.width || pageSize.width,
      height: endY - startY,
      source: clip.source || "unknown"
    },
    chunks: chunkFiles
  };
}

async function openBoxPage(context, sourcePage, href) {
  const url = absolutePgUrl(href, sourcePage.url());

  const page = await context.newPage();

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.waitForLoadState("networkidle", { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(PG_PAGE_LOAD_DELAY_MS);
  await handlePageInterruptions(page);

  return page;
}

// ---------------------------------------------------------------------------
// extractBoxScoreData — reads box score as structured JSON from the DOM
// Returns { linescore, batting, pitching, rawText }
// ---------------------------------------------------------------------------
async function extractBoxScoreData(page) {
  return await page.evaluate(() => {
    function clean(v) {
      return String(v || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
    }

    function tableToRows(table) {
      const headers = [];
      const rows = [];
      const headerRow = table.querySelector("thead tr") || table.querySelector("tr");
      if (headerRow) {
        Array.from(headerRow.querySelectorAll("th,td")).forEach(th => {
          headers.push(clean(th.innerText || th.textContent || ""));
        });
      }
      const tbody = table.querySelector("tbody") || table;
      for (const row of Array.from(tbody.querySelectorAll("tr"))) {
        const cells = Array.from(row.querySelectorAll("td,th"));
        if (!cells.length) continue;
        const rowData = {};
        cells.forEach((cell, i) => {
          rowData[headers[i] || ("col_" + i)] = clean(cell.innerText || cell.textContent || "");
        });
        const firstVal = Object.values(rowData)[0] || "";
        if (!firstVal || firstVal.toUpperCase() === "PLAYER") continue;
        rows.push(rowData);
      }
      return { headers, rows };
    }

    function isVisible(el) {
      const s = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" &&
             Number(s.opacity || 1) > 0 && r.width > 50 && r.height > 0;
    }

    const result = {
      linescore: null,
      batting:   [],
      pitching:  [],
      rawText:   clean((document.body || {}).innerText || "").slice(0, 5000)
    };

    // Find all visible tables
    const tables = Array.from(document.querySelectorAll("table")).filter(isVisible);

    for (const table of tables) {
      const text = clean(table.innerText || "").toUpperCase();

      // Linescore: contains inning numbers + R H E
      if (text.includes(" R ") && text.includes(" H ") && text.includes(" E ") &&
          (text.includes(" 1 ") || text.includes(" 2 ") || text.includes(" 3 "))) {
        if (!result.linescore) result.linescore = tableToRows(table);
        continue;
      }

      // Batting lines: player rows with AB, R, H, RBI
      if (text.includes(" AB ") && text.includes(" R ") && text.includes(" H ") && text.includes(" RBI ")) {
        result.batting.push(tableToRows(table));
        continue;
      }

      // Pitching lines: IP, H, R, ER, BB, SO
      if ((text.includes(" IP ") || text.includes("IP ")) && text.includes(" BB ") && text.includes(" SO ")) {
        result.pitching.push(tableToRows(table));
      }
    }

    // Also try AG Grid containers (DiamondKast uses custom grid classes)
    const agContainers = Array.from(document.querySelectorAll(
      '[class*="BoxScore"],[class*="boxscore"],[class*="LineScore"],[class*="linescore"],' +
      '[class*="awayLineup"],[class*="homeLineup"],[class*="AwayLineup"],[class*="HomeLineup"]'
    )).filter(isVisible);

    for (const container of agContainers) {
      const text = clean(container.innerText || "").toUpperCase();
      const rows = [];
      // Read row by row from the container
      const rowEls = container.querySelectorAll('[class*="Row"],[class*="row"],[role="row"]');
      for (const rowEl of Array.from(rowEls)) {
        const cells = Array.from(rowEl.querySelectorAll(
          '[class*="Cell"],[class*="cell"],[role="gridcell"],[role="columnheader"]'
        ));
        if (!cells.length) continue;
        const rowData = cells.map(cell => clean(cell.innerText || cell.textContent || ""));
        if (rowData.some(v => v)) rows.push(rowData);
      }
      if (rows.length > 1) {
        const containerClass = container.className || "";
        if (/lineup|batting|batter/i.test(containerClass)) {
          result.batting.push({ agGrid: true, rows });
        } else if (/linescore|score/i.test(containerClass)) {
          result.linescore = result.linescore || { agGrid: true, rows };
        }
      }
    }

    return result;
  }).catch(() => ({ linescore: null, batting: [], pitching: [], rawText: "" }));
}

// ---------------------------------------------------------------------------
// extractPitchByPitchData — reads play-by-play text from the DOM as JSON
// Returns array of play event objects
// ---------------------------------------------------------------------------
async function extractPitchByPitchData(page) {
  return await page.evaluate(() => {
    function clean(v) {
      return String(v || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
    }

    function isVisible(el) {
      const s = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" &&
             Number(s.opacity || 1) > 0 && r.width > 100 && r.height > 0;
    }

    const playPattern = /(TOP|BOTTOM)\s+\d|CALLED STRIKE|SWINGING STRIKE|STRIKEOUT|STRUCK OUT|SINGLED|DOUBLED|TRIPLED|HOMERED|WALKED|HIT BY PITCH|GROUNDED|FLIED|LINED|POPPED|FOULED|STOLE|ADVANCED|SCORED|PITCHING CHANGE|DEFENSIVE SUBSTITUTION/i;
    const inningPattern = /^(TOP|BOTTOM)\s+(\d+)/i;

    const plays = [];
    let currentInning = "";
    let currentHalf = "";

    // Find the pitch-by-pitch panel — largest visible div containing play text
    const panels = Array.from(document.querySelectorAll("div,section,table,tbody"))
      .filter(isVisible)
      .map(el => {
        const text = clean(el.innerText || el.textContent || "");
        return { el, text, len: text.length };
      })
      .filter(item => playPattern.test(item.text) && item.len > 200)
      .filter(item => {
        // Reject box score content
        const upper = item.text.toUpperCase();
        return !upper.includes("BATTING SUMMARY") &&
               !(upper.includes("BOX SCORE") && upper.includes("PITCHING") && upper.includes("BATTING")) &&
               !upper.includes("AVG-FB");
      })
      .sort((a, b) => b.len - a.len);

    if (!panels.length) return plays;

    const panel = panels[0].el;

    // Walk all text nodes and block-level elements to extract play lines
    const lines = [];
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while ((node = walker.nextNode())) {
      const text = clean(node.nodeValue || "");
      if (text.length > 3) lines.push(text);
    }

    // Also try direct child elements for structured play rows
    const rowCandidates = Array.from(panel.querySelectorAll(
      "tr,li,p,div[class*='play' i],div[class*='event' i],div[class*='row' i]"
    ));

    const allLines = new Set([...lines]);
    for (const row of rowCandidates) {
      const text = clean(row.innerText || row.textContent || "");
      if (text.length > 5 && text.length < 500) allLines.add(text);
    }

    // Parse lines into structured play objects
    for (const line of allLines) {
      const inningMatch = line.match(inningPattern);
      if (inningMatch) {
        currentHalf   = inningMatch[1].toUpperCase() === "TOP" ? "top" : "bottom";
        currentInning = inningMatch[2];
        continue;
      }

      if (!playPattern.test(line)) continue;
      if (line.length < 8 || line.length > 400) continue;

      // Parse batter and pitcher from common formats:
      // "Dylan Harcrow singled to left field"
      // "Jackson Thomas struck out swinging. Pitcher: John Smith"
      let batter = "", pitcher = "", description = line;

      const pitcherMatch = line.match(/[Pp]itcher[:\s]+([A-Z][a-z]+ [A-Z][a-z]+)/);
      if (pitcherMatch) pitcher = pitcherMatch[1];

      // Determine play type
      let eventType = "play";
      const upper = line.toUpperCase();
      if (/PITCHING CHANGE|DEFENSIVE SUB/i.test(line)) eventType = "substitution";
      else if (/SCORED|HOME RUN|HOMERED/i.test(line)) eventType = "scoring_play";
      else if (/STRIKEOUT|STRUCK OUT/i.test(line)) eventType = "strikeout";
      else if (/WALKED|WALK/i.test(line)) eventType = "walk";
      else if (/SINGLED|DOUBLED|TRIPLED|HIT/i.test(line)) eventType = "hit";
      else if (/GROUNDED|FLIED|LINED|POPPED|OUT/i.test(line)) eventType = "out";
      else if (/STOLE|STOLEN BASE/i.test(line)) eventType = "stolen_base";

      plays.push({
        inning:      currentInning,
        half:        currentHalf,
        event_type:  eventType,
        description: line,
        pitcher,
      });
    }

    return plays;
  }).catch(() => []);
}

async function captureGameBoxAndPitchByPitch(context, teamPage, game, gamesDir, teamNameForFile = "") {
  ensureDirectory(gamesDir);

  const boxPage = await openBoxPage(context, teamPage, game.href);
  let gameDir = gamesDir;

  try {
    await handlePageInterruptions(boxPage);
    await boxPage.waitForTimeout(PG_ACTION_DELAY_MS);

    // Capture the full rendered page first, then crop down to the full box score.
    // This avoids cutting off pitching tables when DiamondKast lazy-renders content.
    const boxMeta = await extractBoxScoreMetadata(boxPage, teamNameForFile, game);
    gameDir = path.join(gamesDir, stableGameFolderName(game, boxMeta));

    // Stable game folder: one folder per GameID. Remove previous duplicate/partial captures for this game.
    safeRm(gameDir);
    ensureDirectory(gameDir);

    await handlePageInterruptions(boxPage);
    await boxPage.waitForTimeout(PG_ACTION_DELAY_MS);

    // Extract box score as structured JSON
    const boxData = await extractBoxScoreData(boxPage);
    const boxJsonPath = path.join(gameDir, `${boxMeta.boxScoreBaseName}.json`);
    fs.writeFileSync(boxJsonPath, JSON.stringify({ metadata: boxMeta, ...boxData }, null, 2), "utf8");
    console.log(`Saved box score JSON for game ${game.gameId}: ${boxJsonPath}`);

    const boxResult = { captured: true, file: boxJsonPath, metadata: boxMeta };

    await boxPage.waitForTimeout(PG_ACTION_DELAY_MS);

    const pitchClicked = await clickDiamondKastTab(boxPage, "Pitch By Pitch");

    let pitchResult = {
      captured: false,
      reason: pitchClicked.reason || "Could not click Pitch By Pitch tab"
    };

    if (pitchClicked.clicked) {
      await waitForPitchByPitchContent(boxPage);

      // Extract play-by-play as structured JSON
      const plays = await extractPitchByPitchData(boxPage);
      const pitchJsonPath = path.join(gameDir, `${boxMeta.pitchByPitchBaseName}.json`);
      fs.writeFileSync(pitchJsonPath, JSON.stringify({ game_id: game.gameId, plays }, null, 2), "utf8");

      pitchResult = {
        captured:    plays.length > 0,
        play_count:  plays.length,
        file:        pitchJsonPath,
      };

      if (!pitchResult.captured) {
        throw new Error(`Pitch By Pitch tab opened for game ${game.gameId}, but no plays were extracted.`);
      }

      console.log(`Extracted ${plays.length} pitch-by-pitch plays for game ${game.gameId}: ${pitchJsonPath}`);
    }

    await boxPage.close().catch(() => {});

    cleanupTeamArtifacts(path.dirname(gamesDir));

    return {
      success: true,
      gameId: game.gameId,
      href: game.href,
      rowText: game.rowText,
      game_folder: gameDir,
      box_score: boxResult,
      pitch_by_pitch: pitchResult
    };
  } catch (error) {
    // Do not create "error" screenshots in the games folder. They were being mistaken for bad
    // final captures. The error is logged in failed-games.txt instead.
    await boxPage.close().catch(() => {});
    cleanupTeamArtifacts(path.dirname(gamesDir));
    throw error;
  }
}

async function captureTeamStatsTables(page, teamDir, teamName) {
  const statsTablesDir = path.join(teamDir, "stats-tables");
  const debugDir = path.join(teamDir, "debug");

  ensureDirectory(statsTablesDir);
  if (PG_KEEP_DEBUG) ensureDirectory(debugDir);

  console.log("Capturing requested Perfect Game stats tables...");

  await handlePageInterruptions(page);
  await safeHideFloatingJunk(page);
  await removeLargeFloatingElementsButKeepStats(page);

  await selectStatsView(page, "Batting Stats", "Standard");

  const grid = await getStatsGrid(page, "Batting Stats");

  if (!grid) {
    console.log("No visible DiamondKast stats table found after selecting Batting / Standard.");

    if (PG_KEEP_DEBUG) {
      await page.screenshot({
        path: path.join(debugDir, "no-stats-table-detected.png"),
        fullPage: true
      }).catch(() => {});
    }

    return {
      success: true,
      no_stats_recorded: true,
      stats_table_screenshots: []
    };
  }

  console.log("Stats grid found. Capturing batting/pitching standard, advanced, and batted-ball tables...");
  const rosterResult = await extractRosterData(page);
fs.writeFileSync(
  path.join(teamDir, `${safeTeam}-roster.json`),
  JSON.stringify({ team: teamName, captured_at: new Date().toISOString(), ...rosterResult }, null, 2),
  "utf8"
);

  const statsData = await extractAllStatsTables(page, statsTablesDir, teamName);

  return {
    success: true,
    no_stats_recorded: statsData.views.filter(x => x.captured).length === 0,
    stats_table_count: statsData.views.filter(x => x.captured).length,
    stats_table_file: statsData.outputFile,
    stats_tables: statsData.combined,
  };
}

async function setupRouting(page) {
  await page.route("**/*", route => {
    const request = route.request();
    const url = request.url().toLowerCase();
    const resourceType = request.resourceType();

    if (
      url.includes("googlesyndication") ||
      url.includes("doubleclick") ||
      url.includes("adservice") ||
      url.includes("imasdk") ||
      url.includes("prebid") ||
      url.includes("taboola") ||
      url.includes("outbrain") ||
      resourceType === "font"
    ) {
      return route.abort();
    }

    return route.continue();
  }).catch(() => {});
}


function countPngFilesRecursive(rootDir, maxCount = 9999) {
  if (!rootDir || !fs.existsSync(rootDir)) return 0;

  let count = 0;

  function walk(dir) {
    if (count >= maxCount) return;

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (count >= maxCount) return;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith(".png")) {
        count++;
      }
    }
  }

  walk(rootDir);
  return count;
}

function countRootPngFiles(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) return 0;

  try {
    return fs.readdirSync(rootDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
      .length;
  } catch {
    return 0;
  }
}

function getExpectedGameDir(gamesDir, game) {
  return path.join(gamesDir, stableGameFolderName(game, null));
}

function isGameCapturePresentOnDisk(gamesDir, game) {
  const gameDir = getExpectedGameDir(gamesDir, game);

  if (!fs.existsSync(gameDir)) {
    return false;
  }

  const rootPngCount = countRootPngFiles(gameDir);
  const allPngCount = countPngFilesRecursive(gameDir, 2);

  // A valid captured game should at least have the box-score PNG in the game folder root.
  // Pitch-by-pitch chunks live under pitch-by-pitch-chunks, but we do not require them here
  // because some PG games may not expose Pitch By Pitch. The key bug this fixes is when
  // processed-games.json says a game was processed but the actual GameID folder is missing
  // or empty, causing future runs to skip it forever.
  return rootPngCount > 0 || allPngCount > 0;
}

function shouldCaptureGame(processed, teamKey, game, gamesDir) {
  if (FORCE_REFRESH) {
    return true;
  }

  const markedProcessed = isGameProcessed(processed, teamKey, game.gameId);

  if (!markedProcessed) {
    return true;
  }

  const existsOnDisk = isGameCapturePresentOnDisk(gamesDir, game);

  if (!existsOnDisk) {
    console.log(`Game ${game.gameId} is marked processed, but the capture folder/files are missing. Re-capturing it.`);
    return true;
  }

  return false;
}

async function processTeam(context, team, teamUrlCache, processed) {
  const requestedName = stripTeamRecord(team.teamName || team.rawTeamName || DEFAULT_SINGLE_TEAM_NAME);

  if (shouldSkipTeamByName(team.rawTeamName || team.teamName)) {
    console.log(`Skipping ${team.rawTeamName || team.teamName} because it is 0-0-0 in 2026.`);
    return {
      success: true,
      skipped: true,
      reason: "Team name contains (0-0-0 in 2026)",
      team_name: team.rawTeamName || team.teamName
    };
  }

  const teamUrl = getKnownTeamUrl(team, teamUrlCache);

  if (!teamUrl) {
    logFailedTeam(requestedName, "", "No Perfect Game team URL found in input or Team URLs.txt cache.", { team });
    return {
      success: false,
      team_name: requestedName,
      reason: "No Perfect Game team URL found"
    };
  }

  console.log("");
  console.log("=================================================");
  console.log(`Processing team: ${requestedName || teamUrl}`);
  console.log(`URL: ${teamUrl}`);
  console.log("=================================================");

  // Close any stale pages from previous runs before opening a fresh one
  for (const stalePage of context.pages()) {
    await stalePage.close().catch(() => {});
  }

  const page = await context.newPage();
  await setupRouting(page);

  try {
    await page.goto(teamUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await handlePageInterruptions(page);

    const detected = await getTeamNameFromPage(page);
    const detectedTeamName = stripTeamRecord(detected.best || "");
    const finalTeamName = stripTeamRecord(requestedName || detectedTeamName || `PG Team ${getQueryParam(teamUrl, "team") || ""}`.trim());
    const folderName = cleanFolderName(finalTeamName);
    const teamDir = path.join(OUTPUT_ROOT, folderName);
    const debugDir = path.join(teamDir, "debug");
    const gamesDir = path.join(teamDir, "games");

    ensureDirectory(teamDir);
    if (PG_KEEP_DEBUG) ensureDirectory(debugDir);
    ensureDirectory(gamesDir);

    rememberTeamUrl(finalTeamName, page.url() || teamUrl, teamUrlCache);

    if (PG_KEEP_DEBUG) {
      fs.writeFileSync(
        path.join(debugDir, "team-name-candidates.json"),
        JSON.stringify({
          requested_team_name: requestedName,
          detected_team_name: detectedTeamName,
          final_team_name_used: finalTeamName,
          detection_details: detected
        }, null, 2),
        "utf8"
      );

      await page.screenshot({
        path: path.join(debugDir, "team-page-loaded.png"),
        fullPage: true
      }).catch(() => {});
    }

    // Always refresh the team-level stats tables on every team run, even when there
    // are no new games to capture. These six screenshots are intentionally not
    // tied to processed-games.json because team stats can change after a game is
    // already marked processed.
    console.log("Always updating latest team stats tables...");
    let statsTables = await captureTeamStatsTables(page, teamDir, finalTeamName);
    const sprayResult = await captureAndBuildSprayData(page, context, finalTeamName, teamDir);

    // Reload the team page after stats-tab navigation so the schedule starts from
    // a clean page state before clicking See All Games.
    await page.goto(teamUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await handlePageInterruptions(page);
    await safeHideFloatingJunk(page);
    await removeLargeFloatingElementsButKeepStats(page);

    console.log("Opening team schedule and clicking See All Games...");
    await expandAllScheduleGames(page);

    if (PG_KEEP_DEBUG) {
      await page.screenshot({
        path: path.join(debugDir, "schedule-expanded.png"),
        fullPage: true
      }).catch(() => {});
    }

    const scheduleGames = await getFinalBoxGamesFromSchedule(page);

    if (PG_KEEP_DEBUG) {
      fs.writeFileSync(
        path.join(teamDir, "schedule-final-box-games.json"),
        JSON.stringify(scheduleGames, null, 2),
        "utf8"
      );
    }

    if (!scheduleGames.length) {
      logFailedTeam(finalTeamName, teamUrl, "No Final games with BOX link found on expanded schedule.", {
        current_url: page.url()
      });

      cleanupTeamArtifacts(teamDir);

      await page.close().catch(() => {});

      return {
        success: false,
        team_name: finalTeamName,
        team_folder: teamDir,
        reason: "No Final games with BOX link found",
        stats_tables: statsTables
      };
    }

    cleanExistingGamesFolder(gamesDir, scheduleGames.map(game => game.gameId));

    const teamKey = getProcessedTeamKey(finalTeamName, teamUrl);
    const newGames = scheduleGames.filter(game => shouldCaptureGame(processed, teamKey, game, gamesDir));

    console.log(`Final/BOX games found: ${scheduleGames.length}`);
    console.log(`New games to capture: ${newGames.length}`);

    const capturedGames = [];
    const failedGames = [];

    for (const game of newGames) {
      try {
        console.log(`Capturing game ${game.gameId}...`);
        const result = await captureGameBoxAndPitchByPitch(context, page, game, gamesDir, finalTeamName);

        capturedGames.push(result);

        markGameProcessed(processed, teamKey, game.gameId, {
          team_name: finalTeamName,
          team_url: teamUrl,
          game_url: game.href,
          opponent: game.opponent,
          result: game.result,
          score: game.score,
          game_folder: result.game_folder
        });

        await page.waitForTimeout(PG_BETWEEN_GAMES_DELAY_MS);
      } catch (error) {
        console.log(`Failed to capture game ${game.gameId}: ${error.message}`);

        failedGames.push({
          game,
          error: error.message,
          first_failed_at: timestamp(),
          attempts: 1
        });

        ensureDirectory(FAILED_GAMES_DIR);
        fs.appendFileSync(
          path.join(FAILED_GAMES_DIR, `${cleanFileName(finalTeamName || 'team')}-failed-games.txt`),
          `[${timestamp()}] Team ${finalTeamName} | GameID ${game.gameId} | ${game.href} | ${error.message}\n`,
          "utf8"
        );

        appendCaptureFailureLog({
          type: "game-capture",
          phase: "initial",
          attempt: 1,
          team_name: finalTeamName,
          team_url: teamUrl,
          game_id: game.gameId,
          url: game.href,
          error: error.message
        });

        await page.waitForTimeout(PG_BETWEEN_GAMES_DELAY_MS);
      }
    }

    console.log("Team stats tables were refreshed at the start of this team run.");

    const output = {
      success: true,
      captured_at: timestamp(),
      source_url: teamUrl,
      final_page_url: page.url(),
      team_name: finalTeamName,
      requested_team_name: requestedName,
      detected_team_name: detectedTeamName,
      team_folder: teamDir,
      team_key: teamKey,
      schedule_game_count: scheduleGames.length,
      new_game_count: newGames.length,
      captured_game_count: capturedGames.length,
      failed_game_count: failedGames.length,
      schedule_games: scheduleGames,
      captured_games: capturedGames,
      failed_games: failedGames,
      stats_tables: statsTables,
      spray_charts: sprayResult
    };

    fs.writeFileSync(
      path.join(teamDir, "perfectgame-output.json"),
      JSON.stringify(output, null, 2),
      "utf8"
    );

    cleanupTeamArtifacts(teamDir);

    await page.close().catch(() => {});

    return output;
  } catch (error) {
    const safeTeamName = cleanFolderName(requestedName || "unknown-team");
    const errorDir = path.join(OUTPUT_ROOT, safeTeamName, "error");
    ensureDirectory(errorDir);

    const errorScreenshotPath = path.join(errorDir, "error-page.png");

    await dismissCookieAndPolicyOverlay(page).catch(() => {});
    await page.screenshot({ path: errorScreenshotPath, fullPage: true }).catch(() => {});

    cleanupTeamArtifacts(path.join(OUTPUT_ROOT, safeTeamName));

    logFailedTeam(requestedName, teamUrl, error.message, {
      current_url: page.url(),
      screenshot: errorScreenshotPath
    });

    await page.close().catch(() => {});

    return {
      success: false,
      team_name: requestedName,
      source_url: teamUrl,
      error: error.message,
      screenshot: errorScreenshotPath
    };
  }
}

async function retryFailedGameCaptures(context, results, processed) {
  const retrySummary = {
    started_at: timestamp(),
    retry_passes_configured: PG_CAPTURE_RETRY_PASSES,
    retry_attempts: [],
    recovered_count: 0,
    still_failed_count: 0
  };

  const retryPasses = Math.max(0, Number.isFinite(PG_CAPTURE_RETRY_PASSES) ? PG_CAPTURE_RETRY_PASSES : 0);
  if (retryPasses <= 0) {
    retrySummary.finished_at = timestamp();
    ensureDirectory(LOGS_DIR);
    fs.writeFileSync(RETRY_SUMMARY_FILE, JSON.stringify(retrySummary, null, 2), "utf8");
    return retrySummary;
  }

  for (let pass = 1; pass <= retryPasses; pass++) {
    console.log(`\n=================================================`);
    console.log(`Retry pass ${pass}/${retryPasses} for failed game captures`);
    console.log(`=================================================`);

    let attemptedThisPass = 0;
    let recoveredThisPass = 0;

    for (const teamResult of results) {
      if (!teamResult || !teamResult.success || !Array.isArray(teamResult.failed_games) || !teamResult.failed_games.length) continue;

      const remainingFailures = [];
      const teamName = teamResult.team_name || teamResult.requested_team_name || "unknown-team";
      const teamUrl = teamResult.source_url || teamResult.final_page_url || "https://www.perfectgame.org/";
      const teamDir = teamResult.team_folder || path.join(OUTPUT_ROOT, cleanFolderName(teamName));
      const gamesDir = path.join(teamDir, "games");
      const teamKey = teamResult.team_key || getProcessedTeamKey(teamName, teamUrl);

      ensureDirectory(gamesDir);

      const teamPage = await context.newPage();
      try {
        await teamPage.goto(teamUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
        await teamPage.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
        await teamPage.waitForTimeout(PG_PAGE_LOAD_DELAY_MS);
        await handlePageInterruptions(teamPage);

        for (const failed of teamResult.failed_games) {
          const game = failed.game || failed;
          attemptedThisPass++;

          try {
            if (PG_RETRY_DELAY_MS > 0) await teamPage.waitForTimeout(PG_RETRY_DELAY_MS);
            console.log(`Retrying ${teamName} game ${game.gameId || "unknown"}...`);

            const retryResult = await captureGameBoxAndPitchByPitch(context, teamPage, game, gamesDir, teamName);

            if (!Array.isArray(teamResult.captured_games)) teamResult.captured_games = [];
            teamResult.captured_games.push({ ...retryResult, recovered_on_retry_pass: pass });

            markGameProcessed(processed, teamKey, game.gameId, {
              team_name: teamName,
              team_url: teamUrl,
              game_url: game.href,
              opponent: game.opponent,
              result: game.result,
              score: game.score,
              game_folder: retryResult.game_folder,
              recovered_on_retry_pass: pass
            });

            recoveredThisPass++;
            retrySummary.recovered_count++;

            retrySummary.retry_attempts.push({
              timestamp: timestamp(),
              pass,
              success: true,
              team_name: teamName,
              game_id: game.gameId,
              url: game.href,
              game_folder: retryResult.game_folder
            });
          } catch (error) {
            const updatedFailure = {
              ...failed,
              game,
              error: error.message,
              attempts: Number(failed.attempts || 1) + 1,
              last_failed_at: timestamp(),
              last_retry_pass: pass
            };

            remainingFailures.push(updatedFailure);

            appendCaptureFailureLog({
              type: "game-capture",
              phase: "retry",
              attempt: updatedFailure.attempts,
              retry_pass: pass,
              team_name: teamName,
              team_url: teamUrl,
              game_id: game.gameId,
              url: game.href,
              error: error.message
            });

            retrySummary.retry_attempts.push({
              timestamp: timestamp(),
              pass,
              success: false,
              team_name: teamName,
              game_id: game.gameId,
              url: game.href,
              error: error.message
            });
          }
        }
      } finally {
        await teamPage.close().catch(() => {});
        cleanupTeamArtifacts(teamDir);
      }

      teamResult.failed_games = remainingFailures;
      teamResult.failed_game_count = remainingFailures.length;
      teamResult.captured_game_count = Array.isArray(teamResult.captured_games) ? teamResult.captured_games.length : 0;
      teamResult.retry_last_updated_at = timestamp();

      fs.writeFileSync(
        path.join(teamDir, "perfectgame-output.json"),
        JSON.stringify(teamResult, null, 2),
        "utf8"
      );
    }

    retrySummary.retry_attempts.push({
      timestamp: timestamp(),
      pass,
      pass_summary: true,
      attempted: attemptedThisPass,
      recovered: recoveredThisPass
    });

    if (attemptedThisPass === 0 || recoveredThisPass === 0) {
      // If there are no failures, or nothing recovered this pass, extra passes are unlikely to help.
      // Keep this from grinding for hours on a tournament-day PG outage.
      break;
    }
  }

  retrySummary.still_failed_count = results.reduce((sum, r) => sum + (Array.isArray(r.failed_games) ? r.failed_games.length : 0), 0);
  retrySummary.finished_at = timestamp();
  ensureDirectory(LOGS_DIR);
  fs.writeFileSync(RETRY_SUMMARY_FILE, JSON.stringify(retrySummary, null, 2), "utf8");
  return retrySummary;
}

async function buildTeamList() {
  if (DEFAULT_SINGLE_TEAM_URL) {
    const singleTeam = {
      rawTeamName: DEFAULT_SINGLE_TEAM_NAME,
      teamName: stripTeamRecord(DEFAULT_SINGLE_TEAM_NAME),
      pgTeamUrl: normalizePgUrl(DEFAULT_SINGLE_TEAM_URL),
      status: "",
      source_row_number: 1,
      source_index: 1
    };

    writeStartupReport({
      generated_at: timestamp(),
      source_type: "single-team-command-line",
      source: DEFAULT_SINGLE_TEAM_URL,
      raw_row_count: 1,
      queued_count: 1,
      skipped_count: 0,
      warning_count: singleTeam.pgTeamUrl ? 0 : 1,
      first_queued_team: {
        row: 1,
        team_name: singleTeam.teamName || singleTeam.rawTeamName || "",
        raw_team_name: singleTeam.rawTeamName || "",
        status: "",
        pg_team_url: singleTeam.pgTeamUrl,
        cached_or_final_url: singleTeam.pgTeamUrl,
        warnings: singleTeam.pgTeamUrl ? [] : ["no Perfect Game URL supplied"]
      },
      queued_teams: [{
        row: 1,
        team_name: singleTeam.teamName || singleTeam.rawTeamName || "",
        raw_team_name: singleTeam.rawTeamName || "",
        status: "",
        pg_team_url: singleTeam.pgTeamUrl,
        cached_or_final_url: singleTeam.pgTeamUrl,
        warnings: singleTeam.pgTeamUrl ? [] : ["no Perfect Game URL supplied"]
      }],
      skipped_rows: [],
      warning_rows: singleTeam.pgTeamUrl ? [] : [{ row: 1, team_name: singleTeam.teamName || singleTeam.rawTeamName || "", warnings: ["no Perfect Game URL supplied"] }]
    });

    return [singleTeam];
  }

  let sheetTeams = [];
  try {
    sheetTeams = await getTeamsFromGoogleSheet();
  } catch (error) {
    console.log(`Google Sheet team load failed: ${error.message}`);
    appendCaptureFailureLog({
      type: "team-list",
      phase: "google-sheet-fetch",
      attempt: PG_GOOGLE_SHEET_FETCH_ATTEMPTS,
      url: GOOGLE_SHEET_CSV_URL,
      error: error.message
    });
  }

  if (sheetTeams.length) {
    return deduplicateTeams(sheetTeams);
  }

  const csvTeams = readTeamsCsv(TEAMS_CSV);

  if (csvTeams.length) return deduplicateTeams(csvTeams);

  return [];
}

function deduplicateTeams(teams) {
  const seen = new Set();
  return teams.filter(t => {
    const key = normalizePgUrl(t.pgTeamUrl || t.pg_team_url || '') ||
                normalizeKey(t.teamName || t.rawTeamName || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

(async () => {
  ensureDirectory(OUTPUT_ROOT);
  ensureDirectory(RUN_STATE_ROOT);
  ensureDirectory(FAILED_TEAMS_DIR);
  ensureDirectory(FAILED_GAMES_DIR);
  ensureDirectory(LOGS_DIR);

  if (!fs.existsSync(AUTH_FILE)) {
    console.error(JSON.stringify({
      success: false,
      error: `Missing auth file: ${AUTH_FILE}. Run save-perfectgame-session.js first.`
    }, null, 2));

    process.exit(1);
  }

  const teams = await buildTeamList();

  if (!teams.length) {
    console.error(JSON.stringify({
      success: false,
      error: `No team URL was supplied. The scraper checked GOOGLE_SHEET_CSV_URL and ${TEAMS_CSV}, but no teams were found. Use the same published Google Sheet CSV URL as the GameChanger scraper, or create teams.csv.`
    }, null, 2));

    process.exit(1);
  }

  const teamUrlCache = loadTeamUrlCache();
  const processed = loadProcessedGames();

  const browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: Number(process.env.PG_SLOW_MO || 100)
  });

  const context = await browser.newContext({
    storageState: AUTH_FILE,
    viewport: VIEWPORT,
    deviceScaleFactor: 1
  });

  const results = [];

  try {
    for (const team of teams) {
      try {
        const result = await processTeam(context, team, teamUrlCache, processed);
        results.push(result);
      } catch (error) {
        const teamName = team.teamName || team.rawTeamName || "unknown-team";
        const teamUrl = getKnownTeamUrl(team, teamUrlCache) || team.pgTeamUrl || "";

        appendCaptureFailureLog({
          type: "team-process",
          phase: "initial",
          attempt: 1,
          team_name: teamName,
          team_url: teamUrl,
          url: teamUrl,
          error: error.message
        });

        results.push({
          success: false,
          team_name: teamName,
          source_url: teamUrl,
          error: error.message
        });
      }
    }

    const retrySummary = await retryFailedGameCaptures(context, results, processed);

    const summaryPath = path.join(RUN_STATE_ROOT, "perfectgame-run-summary.json");

    fs.writeFileSync(summaryPath, JSON.stringify({
      success: true,
      captured_at: timestamp(),
      team_count: teams.length,
      successful_count: results.filter(r => r.success).length,
      failed_count: results.filter(r => !r.success).length,
      failed_game_count: results.reduce((sum, r) => sum + (Array.isArray(r.failed_games) ? r.failed_games.length : 0), 0),
      retry_summary: retrySummary,
      startup_report: STARTUP_REPORT,
      logs: {
        startup_report_json: STARTUP_REPORT_JSON,
        startup_report_txt: STARTUP_REPORT_TXT,
        capture_failures_jsonl: CAPTURE_FAILURES_JSONL,
        capture_failures_txt: CAPTURE_FAILURES_TXT,
        retry_summary: RETRY_SUMMARY_FILE
      },
      results
    }, null, 2), "utf8");

    console.log(JSON.stringify({
      success: true,
      summary: summaryPath,
      startup_report_json: STARTUP_REPORT_JSON,
      startup_report_txt: STARTUP_REPORT_TXT,
      retry_summary: RETRY_SUMMARY_FILE,
      capture_failures_log: CAPTURE_FAILURES_TXT,
      team_count: teams.length,
      successful_count: results.filter(r => r.success).length,
      failed_count: results.filter(r => !r.success).length,
      failed_game_count: results.reduce((sum, r) => sum + (Array.isArray(r.failed_games) ? r.failed_games.length : 0), 0)
    }, null, 2));

    await browser.close();
  } catch (error) {
    console.error(JSON.stringify({
      success: false,
      error: error.message
    }, null, 2));

    await browser.close();
    process.exit(1);
  }
})();