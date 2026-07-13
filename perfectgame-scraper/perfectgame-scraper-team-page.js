require("dotenv").config();

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { chromium } = require("playwright");

const AUTH_FILE = path.join(__dirname, "perfectgame-auth.json");
const OUTPUT_ROOT = path.join(__dirname, "output");

const TEAM_URLS_FILE = path.join(OUTPUT_ROOT, "Team URLs.txt");
const PROCESSED_GAMES_FILE = path.join(OUTPUT_ROOT, "processed-games.json");
const FAILED_TEAMS_DIR = path.join(OUTPUT_ROOT, "failed-teams");
const FAILED_TEAMS_FILE = path.join(FAILED_TEAMS_DIR, "failed-teams.txt");

const DEFAULT_SINGLE_TEAM_URL =
  process.argv[2] ||
  process.env.PG_TEAM_URL ||
  "";

const DEFAULT_SINGLE_TEAM_NAME =
  process.argv[3] ||
  process.env.PG_TEAM_NAME ||
  "";

const TEAMS_CSV =
  process.env.PG_TEAMS_CSV ||
  process.argv[4] ||
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

const SPRAY_CLICK_DELAY_MS = 5000;
const SPRAY_RENDER_DELAY_MS = 5000;
const SPRAY_CLOSE_DELAY_MS = 2500;
const STATS_VIEW_DELAY_MS = 3000;
const POPUP_WAIT_ATTEMPTS = 10;
const POPUP_WAIT_BETWEEN_ATTEMPTS_MS = 2000;

function ensureDirectory(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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

  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `https://www.perfectgame.org${value}`;

  return value;
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
  return filterTeamRows(parseCsvTextToRows(csvText).map(rowToTeam));
}

async function getTeamsFromGoogleSheet() {
  if (!GOOGLE_SHEET_CSV_URL) return [];

  console.log("Reading Perfect Game teams from the same Google Sheet CSV used by GameChanger...");

  const response = await fetch(GOOGLE_SHEET_CSV_URL);

  if (!response.ok) {
    throw new Error(`Failed to fetch Google Sheet CSV. Status: ${response.status}`);
  }

  const csvText = await response.text();

  if (csvText.trim().startsWith("<!DOCTYPE html") || csvText.includes("<html")) {
    throw new Error(
      "GOOGLE_SHEET_CSV_URL returned an HTML page instead of CSV. Use the published Google Sheets CSV URL."
    );
  }

  return filterTeamRows(parseCsvTextToRows(csvText).map(rowToTeam));
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
  await page.evaluate(() => {
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

    const elements = Array.from(
      document.querySelectorAll('button,input[type="button"],input[type="submit"],a,div,span')
    );

    const gotIt = elements.find(el => {
      const text = ((el.innerText || el.textContent || el.value || "") + "")
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase();

      return isVisible(el) && (text === "GOT IT!" || text === "GOT IT");
    });

    if (gotIt) gotIt.click();
  }).catch(() => {});

  await page.waitForTimeout(800);

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
      const text = ((el.innerText || el.textContent || "") + "")
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase();

      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      const isPolicyOverlay =
        text.includes("COOKIE POLICY") ||
        text.includes("MEDIA USAGE UPDATE") ||
        text.includes("THIS WEBSITE USES COOKIES") ||
        text.includes("ANY RECORDING, PHOTOGRAPHY, OR FOOTAGE FROM PG EVENTS");

      const isLargeBottomOverlay =
        rect.width > window.innerWidth * 0.5 &&
        rect.height > 80 &&
        rect.top > window.innerHeight * 0.35 &&
        (
          style.position === "fixed" ||
          style.position === "sticky" ||
          text.includes("COOKIE") ||
          text.includes("MEDIA USAGE")
        );

      if (isPolicyOverlay || isLargeBottomOverlay) hideElement(el);
    }

    document.body.style.paddingBottom = "0px";
    document.documentElement.style.paddingBottom = "0px";
  }).catch(() => {});
}

async function safeHideFloatingJunk(page) {
  await page.addStyleTag({
    content: `
      iframe[src*="youtube"],
      iframe[src*="vimeo"],
      iframe[src*="doubleclick"],
      iframe[src*="googlesyndication"],
      iframe[src*="adservice"],
      iframe[src*="imasdk"],
      .jwplayer,
      [id*="floatingVideo"],
      [class*="floatingVideo"],
      [id*="FloatingVideo"],
      [class*="FloatingVideo"],
      [id*="stickyVideo"],
      [class*="stickyVideo"],
      [id*="StickyVideo"],
      [class*="StickyVideo"] {
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
    await page.waitForTimeout(options.afterMs || 1000);
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
    await page.waitForTimeout(options.afterMs || 1000);
    return true;
  }

  return false;
}

async function expandAllScheduleGames(page) {
  await dismissCookieAndPolicyOverlay(page);

  // PG usually has "See All Games" above and below the schedule.
  // One click is often enough, but clicking visible duplicates is harmless.
  for (let i = 0; i < 3; i++) {
    const clicked = await clickText(page, "See All Games", { exact: true, timeout: 2500, afterMs: 1200 });
    if (!clicked) break;
  }

  await dismissCookieAndPolicyOverlay(page);
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
  const clickedByLocator = await page.getByText(text, { exact: true })
    .nth(occurrence)
    .click({ force: true, timeout: 3000 })
    .then(() => true)
    .catch(() => false);

  if (clickedByLocator) {
    await page.waitForTimeout(700);
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
    const elements = Array.from(document.querySelectorAll("label,span,div,td,a"));
    const matches = elements.filter(el => isVisible(el) && normalized(el.innerText || el.textContent) === target);
    const selected = matches[occurrence];

    if (!selected) return false;

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

  await page.waitForTimeout(700);
  return clickedByEvaluate;
}

async function selectStatsView(page, category, view) {
  console.log(`Selecting stats view: ${category} / ${view}`);

  await dismissCookieAndPolicyOverlay(page);

  const categoryClicked = await clickVisibleTextOption(page, category);
  if (!categoryClicked) console.log(`Warning: could not click category option "${category}".`);

  await page.waitForTimeout(1000);

  const viewClicked = await clickVisibleTextOption(page, view);
  if (!viewClicked) console.log(`Warning: could not click view option "${view}".`);

  await page.waitForTimeout(STATS_VIEW_DELAY_MS);
  await dismissCookieAndPolicyOverlay(page);
}

async function getStatsGrid(page) {
  const selectors = [
    'div[id*="rgDKBattingStats"]',
    'div[id*="rgDKPitchingStats"]',
    '[id*="rgDKBattingStats"]',
    '[id*="rgDKPitchingStats"]',
    'table[id*="rgDKBattingStats"]',
    'table[id*="rgDKPitchingStats"]'
  ];

  for (const selector of selectors) {
    const locators = page.locator(selector);
    const count = await locators.count().catch(() => 0);

    for (let i = 0; i < count; i++) {
      const loc = locators.nth(i);

      if (await loc.isVisible().catch(() => false)) {
        const box = await loc.boundingBox().catch(() => null);

        if (box && box.width > 300 && box.height > 80) {
          return {
            selector,
            locator: loc
          };
        }
      }
    }
  }

  return null;
}

async function captureCurrentStatsGrid(page, outputPath, label) {
  await dismissCookieAndPolicyOverlay(page);
  await safeHideFloatingJunk(page);
  await removeLargeFloatingElementsButKeepStats(page);

  const grid = await getStatsGrid(page);

  if (!grid) {
    console.log(`No stats grid found for ${label}.`);
    return {
      captured: false,
      reason: "No visible DiamondKast stats grid found",
      file: outputPath
    };
  }

  await grid.locator.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(800);

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

async function captureAllStatsTables(page, statsTablesDir) {
  ensureDirectory(statsTablesDir);

  const captures = [];

  const views = [
    { category: "Batting", view: "Standard", filename: "01-batting-standard.png", label: "batting-standard" },
    { category: "Batting", view: "Advanced", filename: "02-batting-advanced.png", label: "batting-advanced" },
    { category: "Batting", view: "Batted Ball", filename: "03-batting-batted-ball.png", label: "batting-batted-ball" },
    { category: "Pitching", view: "Standard", filename: "04-pitching-standard.png", label: "pitching-standard" },
    { category: "Pitching", view: "Advanced", filename: "05-pitching-advanced.png", label: "pitching-advanced" },
    { category: "Pitching", view: "Batted Ball", filename: "06-pitching-batted-ball.png", label: "pitching-batted-ball" }
  ];

  for (const item of views) {
    await selectStatsView(page, item.category, item.view);

    const outputPath = path.join(statsTablesDir, item.filename);
    const result = await captureCurrentStatsGrid(page, outputPath, item.label);

    captures.push({
      category: item.category,
      view: item.view,
      ...result
    });
  }

  await selectStatsView(page, "Batting", "Standard");

  return captures;
}

async function extractRowsFromGrid(page, gridSelector) {
  return await page.$$eval(`${gridSelector} tbody tr`, trs => {
    return trs
      .map(tr => {
        const cells = [...tr.querySelectorAll("td")].map(td => td.innerText.trim());

        if (cells.length < 8) return null;

        return {
          player: cells[2] || "",
          state: cells[3] || "",
          ops: cells[4] || "",
          avg: cells[5] || "",
          obp: cells[6] || "",
          slg: cells[7] || "",
          games: cells[8] || "",
          at_bats: cells[9] || "",
          runs: cells[10] || "",
          hits: cells[11] || "",
          doubles: cells[12] || "",
          triples: cells[13] || "",
          home_runs: cells[14] || "",
          rbi: cells[15] || "",
          walks: cells[16] || "",
          strikeouts: cells[17] || "",
          stolen_bases: cells[18] || "",
          caught_stealing: cells[19] || "",
          wg: cells[20] || ""
        };
      })
      .filter(Boolean)
      .filter(row => row.player && row.player.toUpperCase() !== "PLAYER");
  });
}

async function getVisiblePopupCandidates(page) {
  return await page.evaluate(() => {
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();

      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 250 &&
        rect.height > 200 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    }

    const selector = [
      ".RadWindow",
      ".rwWindowContent",
      '[role="dialog"]',
      ".modal",
      '[id*="Spray"]',
      '[class*="Spray"]',
      '[id*="spray"]',
      '[class*="spray"]',
      '[id*="Chart"]',
      '[class*="Chart"]',
      '[id*="chart"]',
      '[class*="chart"]'
    ].join(",");

    const elements = Array.from(document.querySelectorAll(selector));

    return elements
      .filter(isVisible)
      .map((el, index) => {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();

        return {
          index,
          tag: el.tagName,
          id: el.id || "",
          className: typeof el.className === "string" ? el.className : "",
          text,
          box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          area: rect.width * rect.height
        };
      })
      .sort((a, b) => b.area - a.area);
  }).catch(() => []);
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

  await dismissCookieAndPolicyOverlay(page);

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
    await dismissCookieAndPolicyOverlay(page);

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
      await dismissCookieAndPolicyOverlay(page);

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

      await dismissCookieAndPolicyOverlay(page);
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

async function getBoxScoreClip(page) {
  return await page.evaluate(() => {
    function firstVisible(selectors) {
      for (const selector of selectors) {
        const elements = Array.from(document.querySelectorAll(selector));
        for (const el of elements) {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);

          if (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0
          ) {
            return {
              selector,
              top: rect.top + window.scrollY,
              bottom: rect.bottom + window.scrollY,
              left: rect.left + window.scrollX,
              right: rect.right + window.scrollX
            };
          }
        }
      }

      return null;
    }

    const doc = document.documentElement;
    const body = document.body;

    const width = Math.max(
      doc.scrollWidth,
      body ? body.scrollWidth : 0,
      doc.clientWidth
    );

    const height = Math.max(
      doc.scrollHeight,
      body ? body.scrollHeight : 0,
      doc.clientHeight
    );

    const recap = firstVisible([
      "#ContentTopLevel_ContentPlaceHolder1_pnlGameRecap",
      '[id*="pnlGameRecap"]',
      "#pnlGameRecap",
      ".GameRecap",
      ".game-recap"
    ]);

    const fallbackBottomElement = firstVisible([
      '[id*="rgPitching"]',
      '[id*="Pitching"] table',
      'table:has-text("Pitching")'
    ]);

    let bottom = recap ? Math.max(300, recap.top - 12) : 0;

    if (!bottom && fallbackBottomElement) {
      bottom = fallbackBottomElement.bottom + 80;
    }

    if (!bottom || bottom < 300) {
      bottom = Math.min(height, 4200);
    }

    return {
      x: 0,
      y: 0,
      width: Math.min(width, 2200),
      height: Math.min(bottom, height),
      pageWidth: width,
      pageHeight: height,
      cutoffSelector: recap ? recap.selector : ""
    };
  });
}

async function getPitchByPitchClip(page) {
  return await page.evaluate(() => {
    function clean(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function visibleBox(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        rect.width <= 0 ||
        rect.height <= 0
      ) {
        return null;
      }

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

    const width = Math.max(
      doc.scrollWidth,
      body ? body.scrollWidth : 0,
      doc.clientWidth
    );

    const height = Math.max(
      doc.scrollHeight,
      body ? body.scrollHeight : 0,
      doc.clientHeight
    );

    const recap = Array.from(document.querySelectorAll('#ContentTopLevel_ContentPlaceHolder1_pnlGameRecap,[id*="pnlGameRecap"]'))
      .map(visibleBox)
      .filter(Boolean)
      .sort((a, b) => a.top - b.top)[0];

    const candidateSelectors = [
      '[id*="PitchByPitch"]',
      '[id*="Pitch"]',
      '[class*="pitch"]',
      '[class*="Pitch"]',
      '.tab-content',
      'form'
    ];

    const candidates = [];

    for (const selector of candidateSelectors) {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        const box = visibleBox(el);
        if (!box) continue;

        const text = clean(el.innerText || el.textContent || "");
        const upper = text.toUpperCase();

        const hasBaseballWords =
          upper.includes("STRIKE") ||
          upper.includes("BALL") ||
          upper.includes("SINGLED") ||
          upper.includes("DOUBLED") ||
          upper.includes("STRUCK") ||
          upper.includes("WALKED") ||
          upper.includes("GROUNDED") ||
          upper.includes("FLIED") ||
          upper.includes("POPPED") ||
          upper.includes("RUNNER") ||
          upper.includes("PITCH");

        if (hasBaseballWords && box.height > 200) {
          candidates.push({
            selector,
            top: box.top,
            bottom: box.bottom,
            left: box.left,
            right: box.right,
            width: box.width,
            height: box.height,
            score: box.height + text.length / 30
          });
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);

    if (candidates.length) {
      const selected = candidates[0];
      const y = Math.max(0, selected.top - 20);
      const bottom = recap ? Math.min(recap.top - 12, selected.bottom + 20) : selected.bottom + 20;

      return {
        x: 0,
        y,
        width: Math.min(width, 2200),
        height: Math.max(200, Math.min(bottom - y, height - y)),
        pageWidth: width,
        pageHeight: height,
        source: selected.selector
      };
    }

    const navCandidates = Array.from(document.querySelectorAll("a,span,div"))
      .filter(el => clean(el.innerText || el.textContent).toUpperCase() === "PITCH BY PITCH")
      .map(visibleBox)
      .filter(Boolean)
      .sort((a, b) => a.top - b.top);

    const y = navCandidates.length ? Math.max(0, navCandidates[0].bottom + 10) : 0;
    const bottom = recap ? Math.max(y + 200, recap.top - 12) : Math.min(height, y + 5000);

    return {
      x: 0,
      y,
      width: Math.min(width, 2200),
      height: Math.max(200, Math.min(bottom - y, height - y)),
      pageWidth: width,
      pageHeight: height,
      source: "fallback-between-tab-and-recap"
    };
  });
}

async function captureClipStitched(page, clip, outputPath, options = {}) {
  ensureDirectory(path.dirname(outputPath));

  const maxSingleHeight = options.maxSingleHeight || 12000;
  const sliceHeight = options.sliceHeight || Math.max(500, VIEWPORT.height - 120);

  const normalizedClip = {
    x: Math.max(0, Math.floor(clip.x || 0)),
    y: Math.max(0, Math.floor(clip.y || 0)),
    width: Math.max(1, Math.floor(clip.width || VIEWPORT.width)),
    height: Math.max(1, Math.floor(clip.height || VIEWPORT.height))
  };

  if (normalizedClip.height <= maxSingleHeight) {
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

  let offset = 0;
  let index = 0;

  while (offset < normalizedClip.height) {
    const currentHeight = Math.min(sliceHeight, normalizedClip.height - offset);
    const y = normalizedClip.y + offset;

    const slicePath = path.join(tempDir, `${String(index).padStart(3, "0")}.png`);

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

  fs.rmSync(tempDir, { recursive: true, force: true });

  return {
    file: outputPath,
    stitched: true,
    slices: sliceFiles.length,
    clip: normalizedClip
  };
}

async function openBoxPage(context, sourcePage, href) {
  const url = absolutePgUrl(href, sourcePage.url());

  const page = await context.newPage();

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await dismissCookieAndPolicyOverlay(page);

  return page;
}

async function captureGameBoxAndPitchByPitch(context, teamPage, game, gamesDir) {
  ensureDirectory(gamesDir);

  const gameSafe = cleanFileName(`game-${game.gameId}${game.opponent ? "-" + game.opponent : ""}`);

  const boxPage = await openBoxPage(context, teamPage, game.href);

  const debugPath = path.join(gamesDir, `${gameSafe}-debug-loaded.png`);

  try {
    await boxPage.screenshot({ path: debugPath, fullPage: false }).catch(() => {});

    await dismissCookieAndPolicyOverlay(boxPage);

    const boxClip = await getBoxScoreClip(boxPage);
    const boxPath = path.join(gamesDir, `${gameSafe}-box-score.png`);
    const boxResult = await captureClipStitched(boxPage, boxClip, boxPath);

    console.log(`Saved box score screenshot for game ${game.gameId}: ${boxPath}`);

    const pitchClicked = await clickText(boxPage, "Pitch By Pitch", {
      exact: true,
      timeout: 6000,
      afterMs: 2500
    });

    let pitchResult = {
      captured: false,
      reason: "Could not click Pitch By Pitch tab"
    };

    if (pitchClicked) {
      await dismissCookieAndPolicyOverlay(boxPage);
      await boxPage.waitForTimeout(1500);

      const pitchClip = await getPitchByPitchClip(boxPage);
      const pitchPath = path.join(gamesDir, `${gameSafe}-pitch-by-pitch.png`);
      pitchResult = await captureClipStitched(boxPage, pitchClip, pitchPath, {
        maxSingleHeight: 9000,
        sliceHeight: Math.max(500, VIEWPORT.height - 180)
      });

      pitchResult.captured = true;
      console.log(`Saved pitch-by-pitch screenshot for game ${game.gameId}: ${pitchPath}`);
    }

    await boxPage.close().catch(() => {});

    return {
      success: true,
      gameId: game.gameId,
      href: game.href,
      rowText: game.rowText,
      box_score: boxResult,
      pitch_by_pitch: pitchResult
    };
  } catch (error) {
    await boxPage.screenshot({
      path: path.join(gamesDir, `${gameSafe}-error.png`),
      fullPage: true
    }).catch(() => {});

    await boxPage.close().catch(() => {});

    throw error;
  }
}

async function captureTeamStatsAndSprayCharts(page, teamDir) {
  const statsTablesDir = path.join(teamDir, "stats-tables");
  const sprayDir = path.join(teamDir, "spray-charts");
  const debugDir = path.join(teamDir, "debug");

  ensureDirectory(statsTablesDir);
  ensureDirectory(sprayDir);
  ensureDirectory(debugDir);

  console.log("Selecting Batting / Standard...");
  await selectStatsView(page, "Batting", "Standard");

  const grid = await getStatsGrid(page);

  if (!grid) {
    console.log("No DiamondKast batting grid found. Treating this as no stats recorded yet.");

    await page.screenshot({
      path: path.join(teamDir, "no-stats-page.png"),
      fullPage: true
    });

    return {
      success: true,
      no_stats_recorded: true,
      rows: [],
      stats_table_screenshots: [],
      spray_charts: [],
      deleted_spray_before_click_png_files: []
    };
  }

  console.log(`Stats grid found with selector: ${grid.selector}`);

  await grid.locator.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(1000);
  await dismissCookieAndPolicyOverlay(page);

  const tableScreenshotPath = path.join(teamDir, "diamondkast-batting-grid.png");

  await grid.locator.screenshot({ path: tableScreenshotPath });
  console.log(`Saved batting grid screenshot: ${tableScreenshotPath}`);

  const rows = await extractRowsFromGrid(page, grid.selector);

  const statsJsonPath = path.join(teamDir, "diamondkast-batting-stats.json");
  fs.writeFileSync(statsJsonPath, JSON.stringify(rows, null, 2), "utf8");

  console.log(`Saved batting stats JSON: ${statsJsonPath}`);
  console.log(`Extracted player rows: ${rows.length}`);

  console.log("Capturing all requested stats table screenshots...");
  const statsTableScreenshots = await captureAllStatsTables(page, statsTablesDir);

  await selectStatsView(page, "Batting", "Standard");

  let sprayCharts = [];

  if (rows.length > 0) {
    await safeHideFloatingJunk(page);
    await removeLargeFloatingElementsButKeepStats(page);
    await dismissCookieAndPolicyOverlay(page);

    const battingStandardGrid = await getStatsGrid(page);

    if (!battingStandardGrid) {
      throw new Error("Could not reselect Batting / Standard grid before spray chart capture.");
    }

    sprayCharts = await captureSprayCharts(page, battingStandardGrid.selector, sprayDir);
  } else {
    console.log("Stats grid exists, but no player rows were extracted. Skipping spray charts.");
  }

  await forceCloseAnyOpenPopup(page);

  const deletedSprayBeforeClickPngFiles = deletePngFilesContainingBeforeClick(sprayDir);

  return {
    success: true,
    no_stats_recorded: rows.length === 0,
    row_count: rows.length,
    batting_grid_screenshot: tableScreenshotPath,
    stats_json_file: statsJsonPath,
    stats_table_screenshot_count: statsTableScreenshots.filter(x => x.captured).length,
    stats_table_screenshots: statsTableScreenshots,
    spray_chart_count: sprayCharts.filter(x => x.captured).length,
    spray_charts: sprayCharts,
    deleted_spray_before_click_png_files: deletedSprayBeforeClickPngFiles,
    rows
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

  const page = await context.newPage();
  await setupRouting(page);

  try {
    await page.goto(teamUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await dismissCookieAndPolicyOverlay(page);

    const detected = await getTeamNameFromPage(page);
    const detectedTeamName = stripTeamRecord(detected.best || "");
    const finalTeamName = stripTeamRecord(requestedName || detectedTeamName || `PG Team ${getQueryParam(teamUrl, "team") || ""}`.trim());
    const folderName = cleanFolderName(finalTeamName);
    const teamDir = path.join(OUTPUT_ROOT, folderName);
    const debugDir = path.join(teamDir, "debug");
    const gamesDir = path.join(teamDir, "games");

    ensureDirectory(teamDir);
    ensureDirectory(debugDir);
    ensureDirectory(gamesDir);

    rememberTeamUrl(finalTeamName, page.url() || teamUrl, teamUrlCache);

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

    console.log("Opening team schedule and clicking See All Games...");
    await expandAllScheduleGames(page);

    await page.screenshot({
      path: path.join(debugDir, "schedule-expanded.png"),
      fullPage: true
    }).catch(() => {});

    const scheduleGames = await getFinalBoxGamesFromSchedule(page);

    fs.writeFileSync(
      path.join(teamDir, "schedule-final-box-games.json"),
      JSON.stringify(scheduleGames, null, 2),
      "utf8"
    );

    if (!scheduleGames.length) {
      logFailedTeam(finalTeamName, teamUrl, "No Final games with BOX link found on expanded schedule.", {
        current_url: page.url()
      });

      await page.close().catch(() => {});

      return {
        success: false,
        team_name: finalTeamName,
        team_folder: teamDir,
        reason: "No Final games with BOX link found"
      };
    }

    const teamKey = getProcessedTeamKey(finalTeamName, teamUrl);
    const newGames = FORCE_REFRESH
      ? scheduleGames
      : scheduleGames.filter(game => !isGameProcessed(processed, teamKey, game.gameId));

    console.log(`Final/BOX games found: ${scheduleGames.length}`);
    console.log(`New games to capture: ${newGames.length}`);

    const capturedGames = [];
    const failedGames = [];

    for (const game of newGames) {
      try {
        console.log(`Capturing game ${game.gameId}...`);
        const result = await captureGameBoxAndPitchByPitch(context, page, game, gamesDir);

        capturedGames.push(result);

        markGameProcessed(processed, teamKey, game.gameId, {
          team_name: finalTeamName,
          team_url: teamUrl,
          game_url: game.href,
          opponent: game.opponent,
          result: game.result,
          score: game.score
        });
      } catch (error) {
        console.log(`Failed to capture game ${game.gameId}: ${error.message}`);

        failedGames.push({
          game,
          error: error.message
        });

        fs.appendFileSync(
          path.join(teamDir, "failed-games.txt"),
          `[${timestamp()}] GameID ${game.gameId} | ${game.href} | ${error.message}\n`,
          "utf8"
        );
      }
    }

    let statsAndSpray = {
      skipped: true,
      reason: "No new games found since last run"
    };

    if (newGames.length > 0) {
      console.log("New game data was captured. Updating team stats and spray charts...");

      await page.goto(teamUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000
      });

      await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2000);
      await dismissCookieAndPolicyOverlay(page);
      await safeHideFloatingJunk(page);
      await removeLargeFloatingElementsButKeepStats(page);

      statsAndSpray = await captureTeamStatsAndSprayCharts(page, teamDir);
    } else {
      console.log("No new games since last run. Skipping stats table and spray chart capture.");
    }

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
      stats_and_spray: statsAndSpray
    };

    fs.writeFileSync(
      path.join(teamDir, "perfectgame-output.json"),
      JSON.stringify(output, null, 2),
      "utf8"
    );

    await page.close().catch(() => {});

    return output;
  } catch (error) {
    const safeTeamName = cleanFolderName(requestedName || "unknown-team");
    const errorDir = path.join(OUTPUT_ROOT, safeTeamName, "error");
    ensureDirectory(errorDir);

    const errorScreenshotPath = path.join(errorDir, "error-page.png");

    await dismissCookieAndPolicyOverlay(page).catch(() => {});
    await page.screenshot({ path: errorScreenshotPath, fullPage: true }).catch(() => {});

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

async function buildTeamList() {
  if (DEFAULT_SINGLE_TEAM_URL) {
    return [{
      rawTeamName: DEFAULT_SINGLE_TEAM_NAME,
      teamName: stripTeamRecord(DEFAULT_SINGLE_TEAM_NAME),
      pgTeamUrl: normalizePgUrl(DEFAULT_SINGLE_TEAM_URL)
    }];
  }

  const sheetTeams = await getTeamsFromGoogleSheet();

  if (sheetTeams.length) {
    return sheetTeams;
  }

  const csvTeams = readTeamsCsv(TEAMS_CSV);

  if (csvTeams.length) return csvTeams;

  return [];
}

(async () => {
  ensureDirectory(OUTPUT_ROOT);
  ensureDirectory(FAILED_TEAMS_DIR);

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
      const result = await processTeam(context, team, teamUrlCache, processed);
      results.push(result);
    }

    const summaryPath = path.join(OUTPUT_ROOT, "perfectgame-run-summary.json");

    fs.writeFileSync(summaryPath, JSON.stringify({
      success: true,
      captured_at: timestamp(),
      team_count: teams.length,
      successful_count: results.filter(r => r.success).length,
      failed_count: results.filter(r => !r.success).length,
      results
    }, null, 2), "utf8");

    console.log(JSON.stringify({
      success: true,
      summary: summaryPath,
      team_count: teams.length,
      successful_count: results.filter(r => r.success).length,
      failed_count: results.filter(r => !r.success).length
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
