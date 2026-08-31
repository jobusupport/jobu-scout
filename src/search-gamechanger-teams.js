require("dotenv").config();

const { chromium } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { getTeamsFromGoogleSheet } = require("./read-teams-from-sheet");
const pipeline = require("./pipeline");
const db = require("./db");
const { requireJobOrgContext } = require("./job-org-context");
const { captureTeamHandednessByUrl } = require("./scrape-handedness");
const { getStorageStatePath } = require("./gc-session-loader");
const { resolveOrgOutputRoot, resolveTeamOutputDir, resolveOrgSubdir } = require("./output-paths");
const { isValidUuid } = require("./report-access");

// ─── Constants ────────────────────────────────────────────────────────────────

// Resolved through the single shared helper (src/gc-session-loader.js) every
// other GameChanger session producer/consumer uses -- GC_AUTH_FILE_PATH is a
// real, end-to-end configurable location, not a value only some callers
// understand. Defaults to the exact same repo-relative path this constant
// always resolved to, so existing deployments are unaffected.
const STORAGE_STATE = getStorageStatePath();
const TEST_TEAM_CONTAINS = process.env.GC_TEST_TEAM_CONTAINS || "";

// Security Slice T3H: every output/ path in this file is now derived from
// this job's own organization root (output/<orgId>/...), never the shared,
// legacy flat output/ tree. This cannot be a module-level constant the way
// it was before -- the trusted orgId is only known once requireJobOrgContext()
// has run inside main()/scrapeTeamById(), both of which set this exactly
// once, immediately after that call succeeds, before any output/ path is
// touched. Every output-path helper below reads it (never re-derives org
// context from the environment itself, and never accepts one from a team
// object, spreadsheet row, or any other untrusted source) and throws if it
// is still unset, so a code path that somehow ran before org context was
// established fails closed instead of silently touching a shared directory.
let CURRENT_JOB_ORG_ID = null;

function requireCurrentJobOrgId() {
  if (!CURRENT_JOB_ORG_ID) {
    throw new Error(
      'Internal error: an output/ path was requested before organization context was established. ' +
      'This must never happen -- requireJobOrgContext() is required to run first in main()/scrapeTeamById(), ' +
      'or setCurrentJobOrgId() must be called first by an external caller (see scrape-game-urls.js).'
    );
  }
  return CURRENT_JOB_ORG_ID;
}

// Security Slice T3H: scrape-game-urls.js requires this file as a library
// and calls extractGameData()/getTeamOutputDir() directly -- it never runs
// through main()/scrapeTeamById() above, so CURRENT_JOB_ORG_ID would
// otherwise still be unset and every output/ path lookup would throw. This
// is the only supported way an external caller may set it; it still
// requires an already-validated org id (isValidUuid), the same contract
// requireJobOrgContext() enforces, so a caller cannot smuggle in an
// unvalidated value through this seam.
function setCurrentJobOrgId(orgId) {
  if (!isValidUuid(orgId)) {
    throw new Error('setCurrentJobOrgId requires a valid organization id.');
  }
  CURRENT_JOB_ORG_ID = orgId;
}

function failedMatchesDir() {
  return resolveOrgSubdir(requireCurrentJobOrgId(), "_failed-team-matches");
}

function failedGameCapturesDir() {
  return resolveOrgSubdir(requireCurrentJobOrgId(), "_failed-game-captures");
}

function teamUrlsFilePath() {
  return path.join(resolveOrgOutputRoot(requireCurrentJobOrgId()), "Team URLs.txt");
}

const GC_GAME_MAX_ATTEMPTS = Math.max(1, Number(process.env.GC_GAME_MAX_ATTEMPTS || 3));
const GC_GAME_EXTRACTION_TIMEOUT_MS = Math.max(30000, Number(process.env.GC_GAME_EXTRACTION_TIMEOUT_MS || 180000));
const GC_GAME_DB_WRITE_TIMEOUT_MS = Math.max(30000, Number(process.env.GC_GAME_DB_WRITE_TIMEOUT_MS || 90000));
const GC_PLAYS_EXTRACTION_TIMEOUT_MS = Math.max(15000, Number(process.env.GC_PLAYS_EXTRACTION_TIMEOUT_MS || 60000));
const GC_SKIP_PLAYS = process.env.GC_SKIP_PLAYS === 'true';

// Handedness capture (see scrape-handedness.js). Runs once per opponent team
// after that team's completed games have been captured, navigating directly
// to that team's own already-resolved GC URL (no Our-Team-to-Opponents-list
// detour — see captureHandednessForTeam below for why). Off by default is
// NOT the intent here — this defaults ON — but GC_SKIP_HANDEDNESS=true lets
// you disable it for a faster run while iterating on other parts of the
// scraper. GC_HANDEDNESS_FORCE_REFRESH=true re-captures every roster player
// instead of skipping ones already in player_handedness.
const GC_SKIP_HANDEDNESS = process.env.GC_SKIP_HANDEDNESS === 'true';
const GC_HANDEDNESS_FORCE_REFRESH = process.env.GC_HANDEDNESS_FORCE_REFRESH === 'true';

const DB_PATH = path.join(__dirname, "..", "voodoo-scout.db");

const TARGET_SEASON_YEAR = process.env.GC_TARGET_YEAR || "2026";
const TARGET_SEASON_WORDS = (process.env.GC_ACCEPTED_SEASONS || "spring,summer")
  .split(",")
  .map((season) => season.trim().toLowerCase())
  .filter(Boolean);

// Screenshot fallback: set GC_SCREENSHOT_FALLBACK=true in .env to also
// capture a box score PNG in addition to structured JSON extraction.
const SCREENSHOT_FALLBACK = process.env.GC_SCREENSHOT_FALLBACK === "true";

// ─── Utility Functions ────────────────────────────────────────────────────────

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTeamUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  if (value.startsWith("/teams/")) return `https://web.gc.com${value}`;
  if (value.startsWith("teams/")) return `https://web.gc.com/${value}`;
  return value;
}

function getTeamCacheKeys(team) {
  const keys = new Set();
  const values = [team.teamName, team.rawTeamName, team.gcSearchName];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized) keys.add(normalized);
  }
  return Array.from(keys);
}

function loadTeamUrlCache() {
  const cache = new Map();
  const teamUrlsFile = teamUrlsFilePath();
  if (!fs.existsSync(teamUrlsFile)) return cache;

  const text = fs.readFileSync(teamUrlsFile, "utf8");
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.toLowerCase().startsWith("team name")) continue;

    const tabParts = trimmed.split("\t");
    if (tabParts.length >= 2) {
      const teamName = tabParts[0].trim();
      const teamUrl = normalizeTeamUrl(tabParts.slice(1).join("\t").trim());
      if (teamName && teamUrl) cache.set(normalizeText(teamName), teamUrl);
      continue;
    }

    const equalsParts = trimmed.split("=");
    if (equalsParts.length >= 2) {
      const teamName = equalsParts[0].trim();
      const teamUrl = normalizeTeamUrl(equalsParts.slice(1).join("=").trim());
      if (teamName && teamUrl) cache.set(normalizeText(teamName), teamUrl);
    }
  }

  return cache;
}

function saveTeamUrlCache(cache) {
  const teamUrlsFile = teamUrlsFilePath(); // resolveOrgOutputRoot() inside already ensures the org root exists
  const rows = Array.from(cache.entries())
    .filter(([teamName, teamUrl]) => teamName && teamUrl)
    .sort((a, b) => a[0].localeCompare(b[0]));

  const lines = ["Team Name\tGameChanger Team URL"];
  for (const [teamName, teamUrl] of rows) {
    lines.push(`${teamName}\t${teamUrl}`);
  }

  fs.writeFileSync(teamUrlsFile, lines.join("\n"), "utf8");
  console.log(`Updated Team URLs file: ${teamUrlsFile}`);
}

function getKnownTeamUrl(team, teamUrlCache) {
  const sheetUrl = normalizeTeamUrl(team.gcTeamUrl);
  if (sheetUrl) {
    console.log(`Found PSG Team URL in spreadsheet: ${sheetUrl}`);
    return sheetUrl;
  }
  const keys = getTeamCacheKeys(team);
  for (const key of keys) {
    const cachedUrl = normalizeTeamUrl(teamUrlCache.get(key));
    if (cachedUrl) {
      console.log(`Found PSG Team URL in Team URLs.txt cache: ${cachedUrl}`);
      return cachedUrl;
    }
  }
  return "";
}

function rememberTeamUrl(team, teamUrl, teamUrlCache) {
  const normalizedUrl = normalizeTeamUrl(teamUrl);
  if (!normalizedUrl) return;
  const displayName = team.teamName || team.rawTeamName || team.gcSearchName;
  if (displayName) teamUrlCache.set(normalizeText(displayName), normalizedUrl);
  const keys = getTeamCacheKeys(team);
  for (const key of keys) teamUrlCache.set(key, normalizedUrl);
  saveTeamUrlCache(teamUrlCache);
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeFileName(value) {
  return String(value || "unknown")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeFileNameCompact(value) {
  return sanitizeFileName(value)
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

// ─── Handedness capture wiring ─────────────────────────────────────────────

/**
 * Best-effort wrapper around scrape-handedness.js's captureTeamHandednessByUrl.
 * Never throws — a handedness-capture failure must not take down the game
 * scrape for this team.
 *
 * IMPORTANT: this does NOT navigate Our Team -> Opponents -> search/match.
 * That approach required fuzzy-matching this team's name against every
 * other opponent's name inside one big rendered list (GameChanger renders
 * ~40 opponent rows on one page for a well-traveled team), which kept
 * mis-clicking a wrapper element that concatenates every row's text into
 * one blob — see scoreOpponentText's history. We're already standing on
 * this exact team's own resolved GC page (resolvedTeamUrl, captured right
 * after clickBestTeamResult/processTeamFromKnownUrl found it) — so we just
 * navigate straight back to it and open its Roster tab. No searching, no
 * matching against the other ~40 teams, nothing to mis-click.
 */
async function captureHandednessForTeam(page, team, teamId, resolvedTeamUrl) {
  if (GC_SKIP_HANDEDNESS) {
    console.log('[handedness] Skipping (GC_SKIP_HANDEDNESS=true).');
    return;
  }
  if (team.isOurTeam || team.is_our_team) {
    console.log('[handedness] Skipping — this is our own team, not an opponent.');
    return;
  }
  if (!resolvedTeamUrl) {
    console.warn(`[handedness] Skipping "${team.teamName}" — no resolved PSG team URL was passed through from the game-capture step.`);
    return;
  }

  console.log('');
  console.log(`[handedness] Capturing batting/throwing hand for "${team.teamName}" roster (${resolvedTeamUrl})...`);
  try {
    const result = await captureTeamHandednessByUrl({
      page,
      teamGcUrl: resolvedTeamUrl,
      teamId,
      db,
      forceRefresh: GC_HANDEDNESS_FORCE_REFRESH,
      teamName: team.teamName,
      // Security Slice T3H: this job's own trusted org id, so any debug
      // dump scrape-handedness.js writes (GC_HANDEDNESS_DEBUG_HTML=true
      // only) is staged under the same org-scoped output/ root as
      // everything else in this file, never the shared flat tree.
      orgId: requireCurrentJobOrgId(),
    });
    console.log(`[handedness] "${team.teamName}": captured ${result.captured}, skipped ${result.skipped}, failed ${result.failed}.`);
  } catch (error) {
    console.error(`[handedness] Capture failed for "${team.teamName}": ${error.message}`);
    console.error(error.stack || '');
    console.error('[handedness] Continuing — this does not block game data capture.');
  }
}


async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });

  try {
    return await Promise.race([Promise.resolve(promise), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function uniqueFilePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const parsed = path.parse(filePath);
  for (let i = 2; i < 1000; i++) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${i}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not create unique file path for: ${filePath}`);
}

function getAcceptedSeasonLabel() {
  const seasons = TARGET_SEASON_WORDS
    .map((season) => season.charAt(0).toUpperCase() + season.slice(1))
    .join(" or ");
  return `${seasons} ${TARGET_SEASON_YEAR}`;
}

function getSeasonRegexText() {
  const escapedSeasons = TARGET_SEASON_WORDS.map(escapeRegex).join("|");
  return `${escapedSeasons}|${escapeRegex(TARGET_SEASON_YEAR)}|\\d{1,2}U|Staff|players`;
}

function getTeamOutputDir(team) {
  const folderName = sanitizeFileName(team.teamName || team.rawTeamName || "team");
  return resolveTeamOutputDir(requireCurrentJobOrgId(), folderName);
}

function getFailedMatchReportPath(team) {
  const dir = failedMatchesDir();
  const baseName = sanitizeFileNameCompact(team.teamName || team.rawTeamName || "unknown-team");
  return path.join(dir, `${baseName}.txt`);
}

function simplifyTeamNameForSearch(teamName) {
  return String(teamName || "")
    .replace(/\s*\(\d+\s*[-–—]\s*\d+\s*[-–—]\s*\d+\s+in\s+\d{4}\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSearchTerms(team) {
  const raw = simplifyTeamNameForSearch(team.teamName);
  const gcSearchName = simplifyTeamNameForSearch(team.gcSearchName || "");
  const terms = new Set();

  function addTerm(value) {
    const cleaned = String(value || "").replace(/\s+/g, " ").trim();
    if (cleaned.length >= 3) terms.add(cleaned);
  }

  addTerm(gcSearchName);
  addTerm(raw);

  const parts = raw.split(/\s+-\s+/);
  const beforeDash = parts[0] || "";
  const afterDash = parts.slice(1).join(" ");

  addTerm(beforeDash);
  addTerm(afterDash);
  addTerm(raw.replace(/\b\d{1,2}\s*U\b/gi, ""));
  addTerm(raw.replace(/\s+-\s+.*$/i, ""));
  addTerm(beforeDash.replace(/\bNational\b/gi, ""));
  addTerm(raw.replace(/\s+-\s+.*$/i, "").replace(/\bNational\b/gi, ""));
  addTerm(raw.replace(/\s+-\s+.*$/i, "").replace(/\bNational\b/gi, "").replace(/\b\d{1,2}\s*U\b/gi, ""));
  addTerm(beforeDash.replace(/\b\d{1,2}\s*U\b/gi, "").replace(/\b(AL|GA|TN|MS|FL|TX|LA|NC|SC|KY)\b/gi, ""));

  const words = raw
    .replace(/\b\d{1,2}\s*U\b/gi, "")
    .replace(/\s+-\s+.*$/i, "")
    .split(/\s+/)
    .filter(Boolean);

  if (words.length >= 2) addTerm(words.slice(1).join(" "));
  if (words.length >= 3) addTerm(words.slice(1, 3).join(" "));
  if (words.length >= 5) addTerm(words.slice(0, 5).join(" "));
  if (words.length >= 4) addTerm(words.slice(0, 4).join(" "));
  if (words.length >= 3) addTerm(words.slice(0, 3).join(" "));
  if (words.length >= 2) addTerm(words.slice(0, 2).join(" "));

  const teamSuffixMatch = raw.match(/\bTeam\s+.+$/i);
  if (teamSuffixMatch) addTerm(teamSuffixMatch[0]);

  return Array.from(terms);
}

function selectTeamsToProcess(teams) {
  if (!TEST_TEAM_CONTAINS) {
    console.log("");
    console.log("No GC_TEST_TEAM_CONTAINS value set. Processing every team from the spreadsheet.");
    return teams;
  }

  const target = normalizeText(TEST_TEAM_CONTAINS);

  const exactishMatches = teams.filter((team) => {
    const combined = normalizeText(
      `${team.rawTeamName} ${team.teamName} ${team.gcSearchName || ""} ${team.classification} ${team.from} ${team.city}`
    );
    return combined.includes(target);
  });

  if (exactishMatches.length > 0) {
    console.log("");
    console.log(`GC_TEST_TEAM_CONTAINS is set. Processing ${exactishMatches.length} matching team(s).`);
    return exactishMatches;
  }

  const partialWords = target.split(" ").filter((word) => word.length >= 3);

  const scored = teams
    .map((team) => {
      const combined = normalizeText(
        `${team.rawTeamName} ${team.teamName} ${team.gcSearchName || ""} ${team.classification} ${team.from} ${team.city}`
      );
      let score = 0;
      for (const word of partialWords) {
        if (combined.includes(word)) score += 1;
      }
      return { team, score };
    })
    .sort((a, b) => b.score - a.score);

  if (scored[0] && scored[0].score > 0) {
    console.log("");
    console.log("No exact test-team match found, using closest spreadsheet match:");
    console.log(scored[0].team);
    return [scored[0].team];
  }

  throw new Error(`Could not find test team in Google Sheet using: ${TEST_TEAM_CONTAINS}`);
}

// ─── Popup / Click Helpers ────────────────────────────────────────────────────

async function dismissDontMissOutPopup(page) {
  const candidates = [
    page.getByRole("button", { name: /maybe later/i }),
    page.getByText(/maybe later/i)
  ];

  for (const locator of candidates) {
    try {
      await locator.first().waitFor({ state: "visible", timeout: 2500 });
      console.log('Detected "Don\'t miss out" popup. Clicking Maybe later...');
      await locator.first().click();
      await page.waitForTimeout(1000);
      console.log("Popup dismissed.");
      return true;
    } catch {
      // Popup did not appear.
    }
  }

  return false;
}

async function safeClick(page, locator, description = "element") {
  await dismissDontMissOutPopup(page);
  await locator.first().waitFor({ state: "visible", timeout: 10000 });
  await locator.first().click();
  await page.waitForTimeout(1000);
  await dismissDontMissOutPopup(page);
  console.log(`Clicked ${description}`);
}

// ─── Search / Team Matching ───────────────────────────────────────────────────

async function submitTeamSearch(page, team, searchTerm) {
  console.log("");
  console.log("====================================");
  console.log(`Searching PSG for: ${searchTerm}`);
  console.log(`Raw spreadsheet name: ${team.rawTeamName}`);
  console.log(`Clean team name: ${team.teamName}`);
  console.log(`PSG search name: ${team.gcSearchName || "Not provided"}`);
  console.log(`Classification: ${team.classification || "Not provided"}`);
  console.log(`Target age: ${team.age || "Not provided"}`);
  console.log(`Target From/city: ${team.from || team.city || "Not provided"}`);
  console.log(`Accepted seasons: ${getAcceptedSeasonLabel()}`);
  console.log("====================================");

  const searchUrl = `https://web.gc.com/search?search=${encodeURIComponent(searchTerm)}`;
  console.log(`Navigating directly to search URL: ${searchUrl}`);

  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  try {
    await page.waitForLoadState("networkidle", { timeout: 15000 });
  } catch {
    // GameChanger may keep background requests open.
  }

  await page.waitForTimeout(3000);
  await dismissDontMissOutPopup(page);

  console.log("Search page loaded.");
  console.log(`Search URL: ${page.url()}`);
  return true;
}

async function pageHasNoResults(page) {
  const noResults = page.getByText(/no results found/i);
  try {
    await noResults.waitFor({ state: "visible", timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

async function getResultTextFromElement(element) {
  return await element.evaluate((el) => {
    function clean(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    let bestText = clean(el.innerText);
    let node = el;

    for (let depth = 0; depth < 8 && node; depth++) {
      const text = clean(node.innerText);
      const rect = node.getBoundingClientRect();
      const looksLikeResult =
        /\b\d{1,2}U\b/i.test(text) ||
        /summer|spring|fall|winter/i.test(text) ||
        /staff|players/i.test(text);
      const reasonableSize =
        rect.width > 250 &&
        rect.height > 20 &&
        text.length >= bestText.length &&
        text.length < 1500;
      if (looksLikeResult && reasonableSize) bestText = text;
      node = node.parentElement;
    }

    return bestText;
  });
}

async function getCandidateResultCards(page) {
  const candidates = [];
  const seen = new Set();

  async function addCandidate(locator, hrefOverride = "") {
    try {
      const box = await locator.boundingBox();
      if (!box || box.width < 100 || box.height < 10) return;

      const href = hrefOverride || (await locator.getAttribute("href").catch(() => "")) || "";
      const cardText = await getResultTextFromElement(locator);
      const fullText = normalizeText(`${cardText} ${href}`);

      if (!fullText) return;
      if (fullText.includes("home") && fullText.includes("support") && fullText.includes("get the app")) return;

      const hasAnyAllowedSeasonWord = TARGET_SEASON_WORDS.some((season) => fullText.includes(season));
      if (
        !hasAnyAllowedSeasonWord &&
        !fullText.includes(TARGET_SEASON_YEAR) &&
        !/\b\d{1,2}u\b/i.test(fullText) &&
        !fullText.includes("staff") &&
        !fullText.includes("players")
      ) return;

      const hasTeamHref = Boolean(href && href.toLowerCase().includes("/teams/"));
      const key = `${href}|${cardText}`;
      if (seen.has(key)) return;
      seen.add(key);

      candidates.push({
        locator,
        linkText: cardText,
        cardText,
        href,
        rawText: cardText,
        hasTeamHref,
        textLength: String(cardText || "").length
      });
    } catch {
      // Ignore bad candidate.
    }
  }

  const teamLinks = page.locator('a[href*="/teams/"]');
  const teamLinkCount = await teamLinks.count();
  for (let i = 0; i < teamLinkCount; i++) {
    const link = teamLinks.nth(i);
    const href = (await link.getAttribute("href").catch(() => "")) || "";
    await addCandidate(link, href);
  }

  const fallbackCandidates = page.locator("a, [role='link'], div").filter({
    hasText: new RegExp(getSeasonRegexText(), "i")
  });
  const fallbackCount = await fallbackCandidates.count();
  for (let i = 0; i < fallbackCount; i++) {
    await addCandidate(fallbackCandidates.nth(i));
  }

  return candidates;
}

function extractAgeGroupsFromText(value) {
  const text = String(value || "");
  const matches = [...text.matchAll(/\b(\d{1,2})\s*U\b/gi)];
  return matches.map((match) => match[1]);
}

function hasTargetSeason(fullText) {
  const text = normalizeText(fullText);
  const hasAllowedSeason = TARGET_SEASON_WORDS.some((season) => text.includes(season));
  return hasAllowedSeason && text.includes(TARGET_SEASON_YEAR);
}

function scoreCandidate(candidate, team) {
  const fullTextRaw = `${candidate.linkText} ${candidate.cardText} ${candidate.href}`;
  const fullText = normalizeText(fullTextRaw);
  const targetTeamName = normalizeText(team.teamName);
  const targetCity = normalizeText(team.from || team.city);
  const targetState = normalizeText(team.state);
  const targetAge = String(team.age || "").trim();
  const foundAges = extractAgeGroupsFromText(fullTextRaw);
  let score = 0;
  const reasons = [];

  if (!hasTargetSeason(fullText)) {
    return {
      score: -999,
      reasons: [`rejected: target season not found, expected ${getAcceptedSeasonLabel()}`],
      rawText: fullTextRaw
    };
  }

  score += 60;
  reasons.push(getAcceptedSeasonLabel());

  if (targetAge && foundAges.length > 0 && !foundAges.includes(targetAge)) {
    return {
      score: -999,
      reasons: [`rejected: wrong age group, found ${foundAges.join(", ")}U, expected ${targetAge}U`],
      rawText: fullTextRaw
    };
  }

  if (targetCity && !fullText.includes(targetCity)) {
    return {
      score: -999,
      reasons: [`rejected: city/location mismatch, expected ${team.from || team.city}`],
      rawText: fullTextRaw
    };
  }

  if (targetAge) {
    const ageURegex = new RegExp(`\\b${escapeRegex(targetAge)}\\s*u\\b`, "i");
    if (ageURegex.test(fullTextRaw)) {
      score += 50;
      reasons.push(`${targetAge}U`);
    } else {
      score -= 25;
      reasons.push(`missing expected ${targetAge}U`);
    }
  }

  if (targetCity && fullText.includes(targetCity)) {
    score += 40;
    reasons.push(`From/city: ${team.from || team.city}`);
  }

  if (targetState && fullText.includes(targetState)) {
    score += 5;
    reasons.push(`state: ${team.state}`);
  }

  if (targetTeamName && fullText.includes(targetTeamName)) {
    score += 35;
    reasons.push("full team name");
  } else {
    const words = targetTeamName
      .split(" ")
      .filter((word) => {
        if (word.length < 3) return false;
        if (["the", "and", "team", "national"].includes(word)) return false;
        if (/^\d{1,2}u$/.test(word)) return false;
        return true;
      });
    const matchedWords = words.filter((word) => fullText.includes(word));
    if (matchedWords.length) {
      score += Math.min(35, matchedWords.length * 8);
      reasons.push(`partial team words: ${matchedWords.join(", ")}`);
    }
  }

  if (candidate.hasTeamHref) {
    score += 20;
    reasons.push("clickable team href");
  }

  if (candidate.textLength > 800) {
    score -= 25;
    reasons.push("large parent container penalty");
  }

  return { score, reasons, rawText: fullTextRaw };
}

function appendSearchAttemptDebug(debugInfo, searchTerm, candidates, scored) {
  debugInfo.searchAttempts.push({
    searchTerm,
    candidateCount: candidates.length,
    candidates: scored.map((candidate) => ({
      score: candidate.score,
      reasons: candidate.reasons,
      hasTeamHref: candidate.hasTeamHref,
      textLength: candidate.textLength,
      linkText: candidate.linkText,
      href: candidate.href,
      cardText: candidate.cardText,
      rawText: candidate.rawText || candidate.cardText
    }))
  });
}

async function writeFailedMatchReport(team, searchTerms, debugInfo) {
  const reportPath = getFailedMatchReportPath(team);
  const lines = [];

  lines.push("GameChanger Team Match Failure Report");
  lines.push("=====================================");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("Spreadsheet Team");
  lines.push("----------------");
  lines.push(`Raw Team Name: ${team.rawTeamName || ""}`);
  lines.push(`Clean Team Name: ${team.teamName || ""}`);
  lines.push(`GC Search Name: ${team.gcSearchName || ""}`);
  lines.push(`Classification: ${team.classification || ""}`);
  lines.push(`Expected Age: ${team.age || ""}`);
  lines.push(`From/City: ${team.from || team.city || ""}`);
  lines.push(`State: ${team.state || ""}`);
  lines.push(`Accepted Seasons: ${getAcceptedSeasonLabel()}`);
  lines.push("");
  lines.push("Search Terms Tried");
  lines.push("------------------");
  for (const term of searchTerms) lines.push(`- ${term}`);
  lines.push("");

  if (!debugInfo.searchAttempts.length) {
    lines.push("No search attempts were recorded.");
  }

  for (const attempt of debugInfo.searchAttempts) {
    lines.push("");
    lines.push("Search Attempt");
    lines.push("--------------");
    lines.push(`Search Term: ${attempt.searchTerm}`);
    lines.push(`Candidate Count: ${attempt.candidateCount}`);

    if (!attempt.candidates.length) {
      lines.push("No candidate results captured.");
      continue;
    }

    for (let i = 0; i < attempt.candidates.length; i++) {
      const candidate = attempt.candidates[i];
      lines.push("");
      lines.push(`Candidate ${i + 1}`);
      lines.push(`Score: ${candidate.score}`);
      lines.push(`Has Team Href: ${candidate.hasTeamHref ? "yes" : "no"}`);
      lines.push(`Text Length: ${candidate.textLength || ""}`);
      lines.push(`Reasons: ${candidate.reasons.join("; ") || "none"}`);
      lines.push(`Href: ${candidate.href || "N/A"}`);
      lines.push(`Link Text: ${candidate.linkText || ""}`);
      lines.push("Captured Text:");
      lines.push(candidate.cardText || candidate.rawText || "");
    }
  }

  fs.writeFileSync(reportPath, lines.join("\n"), "utf8");
  console.log("");
  console.log(`Wrote failed match report: ${reportPath}`);
}

async function chooseBestTeamResult(page, team, searchTerm, debugInfo) {
  console.log("");
  console.log("Looking for candidate result cards...");

  const candidates = await getCandidateResultCards(page);

  if (!candidates.length) {
    console.log("No candidate team result cards found.");
    appendSearchAttemptDebug(debugInfo, searchTerm, [], []);
    return null;
  }

  const scored = candidates
    .map((candidate) => {
      const result = scoreCandidate(candidate, team);
      return {
        ...candidate,
        score: result.score,
        reasons: result.reasons,
        rawText: result.rawText || candidate.rawText || candidate.cardText,
        hasTeamHref: Boolean(candidate.href && candidate.href.toLowerCase().includes("/teams/")),
        textLength: String(candidate.cardText || "").length
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (Number(b.hasTeamHref) !== Number(a.hasTeamHref)) return Number(b.hasTeamHref) - Number(a.hasTeamHref);
      return a.textLength - b.textLength;
    });

  appendSearchAttemptDebug(debugInfo, searchTerm, candidates, scored);

  console.log("");
  console.log("Candidate matches:");
  console.log("==================");
  for (const candidate of scored.slice(0, 10)) {
    console.log("");
    console.log(`Score: ${candidate.score}`);
    console.log(`Has team href: ${candidate.hasTeamHref ? "yes" : "no"}`);
    console.log(`Text length: ${candidate.textLength}`);
    console.log(`Reasons: ${candidate.reasons.join(", ") || "none"}`);
    console.log(`Href: ${candidate.href || "N/A"}`);
    console.log(`Card text: ${candidate.cardText}`);
  }

  const best = scored[0];

  if (!best || best.score < 140) {
    console.log("");
    console.log("No confident match found from these results.");
    return null;
  }

  if (!best.hasTeamHref) {
    console.log("");
    console.log("Best match does not have a clickable /teams/ href. Not clicking it.");
    return null;
  }

  console.log("");
  console.log("Best clickable match selected:");
  console.log("==============================");
  console.log(`Score: ${best.score}`);
  console.log(`Reasons: ${best.reasons.join(", ")}`);
  console.log(`Href: ${best.href}`);
  console.log(`Card text: ${best.cardText}`);
  return best;
}

// ─── Navigation Helpers ───────────────────────────────────────────────────────

function toAbsoluteUrl(value, baseUrl) {
  try {
    return new URL(String(value || ''), baseUrl || 'https://web.gc.com').toString();
  } catch {
    return '';
  }
}

async function findScheduleUrlOnCurrentPage(page) {
  const currentUrl = page.url();
  if (/\/schedule(?:[/?#]|$)/i.test(currentUrl)) return currentUrl;

  const hrefs = await page.locator('a[href*="/schedule"]').evaluateAll((links) =>
    links.map((link) => link.getAttribute('href')).filter(Boolean)
  ).catch(() => []);

  for (const href of hrefs) {
    const absolute = toAbsoluteUrl(href, currentUrl);
    if (/\/teams\/[^/]+\/[^/]+\/schedule(?:[/?#]|$)/i.test(absolute)) return absolute;
  }

  return '';
}

async function openSchedulePage(page, label = 'team page') {
  console.log(`Looking for Schedule page from ${label}...`);
  await dismissDontMissOutPopup(page);

  const directScheduleUrl = await findScheduleUrlOnCurrentPage(page);
  if (directScheduleUrl) {
    console.log(`[psg] Opening schedule URL directly: ${directScheduleUrl}`);
    await page.goto(directScheduleUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    try {
      await page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch {
      // GameChanger may keep background requests open.
    }
    await page.waitForTimeout(2000);
    await dismissDontMissOutPopup(page);
    console.log(`Schedule URL/page: ${page.url()}`);
    return true;
  }

  console.log('[psg] No direct schedule href found. Falling back to clicking the Schedule tab.');
  return await clickScheduleTab(page);
}

async function clickScheduleTab(page) {
  console.log("Looking for Schedule tab...");

  const scheduleCandidates = [
    page.getByRole("link", { name: /^schedule$/i }),
    page.getByRole("button", { name: /^schedule$/i }),
    page.getByText(/^schedule$/i),
    page.locator('a:has-text("SCHEDULE")'),
    page.locator('button:has-text("SCHEDULE")')
  ];

  for (const locator of scheduleCandidates) {
    try {
      await locator.first().waitFor({ state: "visible", timeout: 3000 });
      await safeClick(page, locator, "Schedule tab");
      try {
        await page.waitForLoadState("networkidle", { timeout: 15000 });
      } catch {
        // Not fatal.
      }
      await page.waitForTimeout(2000);
      await dismissDontMissOutPopup(page);
      console.log(`Schedule URL/page: ${page.url()}`);
      return true;
    } catch {
      // Try next locator.
    }
  }

  console.log("Could not find/click Schedule tab.");
  return false;
}

async function clickTabByName(page, tabName) {
  const tabRegex = new RegExp(`^${escapeRegex(tabName)}$`, "i");

  const candidates = [
    page.getByRole("link", { name: tabRegex }),
    page.getByRole("button", { name: tabRegex }),
    page.getByText(tabRegex),
    page.locator(`a:has-text("${tabName}")`),
    page.locator(`button:has-text("${tabName}")`)
  ];

  for (const locator of candidates) {
    try {
      await locator.first().waitFor({ state: "visible", timeout: 5000 });
      await safeClick(page, locator, `${tabName} tab`);
      try {
        await page.waitForLoadState("networkidle", { timeout: 15000 });
      } catch {
        // Not fatal.
      }
      await page.waitForTimeout(2000);
      await dismissDontMissOutPopup(page);
      return true;
    } catch {
      // Try next candidate.
    }
  }

  console.log(`Could not click ${tabName} tab.`);
  return false;
}

async function clickBackToSchedule(page) {
  console.log("Clicking Back to Schedule...");
  await dismissDontMissOutPopup(page);

  const candidates = [
    page.getByRole("link", { name: /back to schedule/i }),
    page.getByRole("button", { name: /back to schedule/i }),
    page.getByText(/back to schedule/i),
    page.locator('a:has-text("Back to Schedule")'),
    page.locator('button:has-text("Back to Schedule")')
  ];

  for (const locator of candidates) {
    try {
      await locator.first().waitFor({ state: "visible", timeout: 5000 });
      await locator.first().click();
      try {
        await page.waitForLoadState("networkidle", { timeout: 15000 });
      } catch {
        // Not fatal.
      }
      await page.waitForTimeout(3000);
      await dismissDontMissOutPopup(page);
      console.log(`Returned to schedule: ${page.url()}`);
      return true;
    } catch {
      // Try next locator.
    }
  }

  console.log("Could not find Back to Schedule.");
  return false;
}

async function selectChronologicalPlaysOrder(page) {
  console.log("Checking play order...");
  await dismissDontMissOutPopup(page);

  const reverseChronologicalText = page.getByText(/reverse[-\s]?chronological/i).first();

  try {
    await reverseChronologicalText.waitFor({ state: "visible", timeout: 4000 });
    console.log('"Reverse Chronological" is visible.');
    console.log('Clicking it to switch plays into sequential order...');
    await reverseChronologicalText.click();
    await page.waitForTimeout(2000);
    await dismissDontMissOutPopup(page);
    console.log("Play order switched to Chronological.");
    return true;
  } catch {
    console.log('"Reverse Chronological" is not visible. Assuming plays are already chronological.');
    return true;
  }
}

// ─── Schedule / Game Loop ─────────────────────────────────────────────────────

async function getVisibleCompletedGameCount(page) {
  const completedGameRegex = /\b[WL]\s*\d+\s*[-–—]\s*\d+\b/i;
  const scoreLocator = page.getByText(completedGameRegex);
  const count = await scoreLocator.count();
  let visibleCount = 0;

  for (let i = 0; i < count; i++) {
    const item = scoreLocator.nth(i);
    try {
      const box = await item.boundingBox();
      if (box && box.width > 0 && box.height > 0) visibleCount++;
    } catch {
      // Ignore non-visible or stale matches.
    }
  }

  return visibleCount;
}

// ── Schedule-reference origin authority ────────────────────────────────
//
// extractGameIdFromUrl takes the path segment after '/schedule/' and throws the
// HOST away. That is only safe once the host has been proven authoritative
// first, because otherwise any page-embedded anchor whose path merely LOOKS
// like a schedule link donates a canonical opponent game:
//
//   https://other.example/schedule/foreign-1  ->  sourceGameRef 'foreign-1'
//
// which published a game GameChanger never served. Scheme alone does not
// establish authority -- 'https:' says the transport, not the publisher -- and
// neither does the presence of '/schedule/' in the path.
//
// This application talks to exactly one GameChanger schedule origin. Every team
// URL it will accept is already pinned to it (see GC_TEAM_URL_RE in
// src/high-school-import-routes.js: /^https:\/\/web\.gc\.com\/teams\/.../), and
// normalizeTeamUrl below prefixes bare '/teams/...' paths with the same origin.
// The only other gc.com origin anywhere in this codebase is the OWN-TEAM login
// page (src/login-gamechanger.js), which serves no schedules. So exactly one
// origin is admitted and no sibling domain is speculatively added.
const AUTHORITATIVE_SCHEDULE_ORIGIN = 'https://web.gc.com';

// Compared as a WHOLE normalized origin, never by substring or suffix. The URL
// parser lower-cases the host, drops a default port, and resolves user-info, so
// exact origin equality already rejects every near-miss this must refuse:
//
//   http://web.gc.com/...              origin 'http://web.gc.com'        scheme differs
//   https://web.gc.com:444/...         origin 'https://web.gc.com:444'   port differs
//   https://web.gc.com.evil.example/   origin 'https://web.gc.com.evil.example'
//   https://evil-web.gc.com/...        origin 'https://evil-web.gc.com'
//   https://api.web.gc.com/...         origin 'https://api.web.gc.com'   subdomain
//   https://web.gc.com./...            origin 'https://web.gc.com.'      trailing dot
//   https://web.gc.com@evil.example/   origin 'https://evil.example'     user-info trick
//   https://gc.com/...                 origin 'https://gc.com'           different host
//
// A substring or endsWith() check would admit several of those, which is
// exactly why authority is decided on the parsed origin and nothing else.
function isAuthoritativeScheduleOrigin(resolvedUrl) {
  if (!resolvedUrl || typeof resolvedUrl.origin !== 'string') return false;
  return resolvedUrl.origin === AUTHORITATIVE_SCHEDULE_ORIGIN;
}

function extractGameIdFromUrl(url) {
  const match = String(url || "").match(/\/schedule\/([^/?#]+)/i);
  return match ? match[1] : "";
}

// True only for a date that actually exists on the Gregorian calendar, so
// month length and leap years both decide the answer. "Feb 30, 2026" and
// "Apr 31, 2026" parse cleanly as text but name no real day; letting them
// through meant PostgreSQL's date cast was the first thing to notice, which
// surfaced as an untyped persistence failure after the collection had already
// been captured.
function isRealCalendarDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [31,
    (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function normalizeScheduleDateText(value, fallbackYear = TARGET_SEASON_YEAR) {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  if (!raw) return null;

  const monthMap = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12,
  };

  const patterns = [
    /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\.?,?\s*(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t)?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:,?\s+(20\d{2}|19\d{2}))?\b/i,
    /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/,
  ];

  const monthNameMatch = raw.match(patterns[0]);
  if (monthNameMatch) {
    const month = monthMap[String(monthNameMatch[1]).toLowerCase().replace(/\.$/, "")];
    const day = Number(monthNameMatch[2]);
    const year = Number(monthNameMatch[3] || fallbackYear);
    // A real calendar day, not merely a plausible-looking one. An impossible
    // date returns null here and is reported as 'invalid' by the resolver,
    // rather than travelling on to be rejected by PostgreSQL's date cast.
    if (month && isRealCalendarDate(year, month, day)) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    return null;
  }

  const slashMatch = raw.match(patterns[1]);
  if (slashMatch) {
    const month = Number(slashMatch[1]);
    const day = Number(slashMatch[2]);
    let year = slashMatch[3] ? Number(slashMatch[3]) : Number(fallbackYear);
    if (year < 100) year += 2000;
    if (isRealCalendarDate(year, month, day)) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    return null;
  }

  return null;
}

function parseScoreText(value) {
  const match = String(value || "").match(/\b([WL])\s*(\d+)\s*[-–—]\s*(\d+)\b/i);
  if (!match) return { result: null, scoreUs: null, scoreThem: null };
  return {
    result: match[1].toUpperCase(),
    scoreUs: Number(match[2]),
    scoreThem: Number(match[3]),
  };
}

function loadProcessedGames(teamDir) {
  const manifestPath = path.join(teamDir, "processed-games.json");
  if (!fs.existsSync(manifestPath)) return { manifestPath, processedGames: [] };

  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!Array.isArray(parsed.processedGames)) parsed.processedGames = [];
    return { manifestPath, processedGames: parsed.processedGames };
  } catch {
    return { manifestPath, processedGames: [] };
  }
}

function saveProcessedGames(manifestPath, processedGames) {
  fs.writeFileSync(manifestPath, JSON.stringify({ processedGames }, null, 2), "utf8");
}

function isGameAlreadyProcessed(processedGames, gameId) {
  if (!gameId) return false;
  return processedGames.some((game) => game.gameId === gameId);
}


async function getVisibleCompletedGameEntries(page) {
  await dismissDontMissOutPopup(page);
  const completedGameRegex = /\b[WL]\s*\d+\s*[-–—]\s*\d+\b/i;
  const scoreLocator = page.getByText(completedGameRegex);
  const count = await scoreLocator.count();
  const entries = [];

  for (let i = 0; i < count; i++) {
    const item = scoreLocator.nth(i);
    try {
      const box = await item.boundingBox();
      if (!box || box.width <= 0 || box.height <= 0) continue;

      const entry = await item.evaluate((element) => {
        function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
        function looksLikeDate(value) {
          return /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\.?[,]?\s*(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t)?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:,?\s+(?:20\d{2}|19\d{2}))?\b/i.test(value) ||
            /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(value);
        }

        const scoreText = clean(element.innerText || element.textContent || '');
        let node = element;
        let href = '';
        let cardText = scoreText;
        // rowContainer is the smallest ancestor that is actually clickable/linked
        // to this specific game. Date search MUST be scoped to this element (plus
        // its immediate previous sibling, to catch a date-group header that
        // precedes a row rather than wrapping it) — never to the whole document.
        // Searching the whole page previously caused every game on a schedule to
        // resolve to the same date whenever a single date-like element (e.g. a
        // group header several games away) happened to score as "closest."
        let rowContainer = element;

        // CARDTEXT_MAX_LEN caps how much text we're willing to fold into a single
        // row's "cardText". Multi-game schedule lists routinely nest a single
        // game's score inside large shared containers (virtualized list rows,
        // date-grouped sections); without a tight cap, cardText silently absorbs
        // neighboring games/date headers and date-parsing then locks onto
        // whichever date happens to appear first in that merged blob for every
        // row, collapsing the whole team's schedule onto one date.
        const CARDTEXT_MAX_LEN = 260;

        for (let depth = 0; depth < 12 && node; depth++) {
          const text = clean(node.innerText || node.textContent || '');
          if (text && text.length >= cardText.length && text.length <= CARDTEXT_MAX_LEN) {
            cardText = text;
            rowContainer = node;
          }

          if (node.href) { href = node.href; rowContainer = node; break; }
          if (node.getAttribute) {
            href = node.getAttribute('href') || node.getAttribute('data-href') || '';
            if (href) { rowContainer = node; break; }
          }
          const anchor = node.querySelector && node.querySelector('a[href*="/schedule/"]');
          if (anchor && anchor.href) { href = anchor.href; rowContainer = node; break; }
          node = node.parentElement;
        }

        // Scope the date search to this row's own subtree, plus its immediate
        // previous sibling (common pattern: "Sat, Jul 2" header sits as a sibling
        // just above a block of that day's games) — not the entire document.
        const searchRoots = [rowContainer];
        if (rowContainer.previousElementSibling) searchRoots.push(rowContainer.previousElementSibling);
        const parentPrev = rowContainer.parentElement && rowContainer.parentElement.previousElementSibling;
        if (parentPrev) searchRoots.push(parentPrev);

        const scoreRect = element.getBoundingClientRect();
        const dateCandidates = [];
        const seenNodes = new Set();
        for (const root of searchRoots) {
          const nodes = [root, ...Array.from(root.querySelectorAll('*'))];
          for (const candidate of nodes) {
            if (seenNodes.has(candidate)) continue;
            seenNodes.add(candidate);
            const text = clean(candidate.innerText || candidate.textContent || '');
            if (!text || text.length > 300 || !looksLikeDate(text)) continue;
            const rect = candidate.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            const distance = Math.abs(rect.top - scoreRect.top);
            const abovePenalty = rect.top <= scoreRect.top + 20 ? 0 : 10000;
            dateCandidates.push({ text, distance: distance + abovePenalty, top: rect.top });
          }
        }

        dateCandidates.sort((a, b) => a.distance - b.distance || b.top - a.top);
        const dateText = dateCandidates[0]?.text || '';

        return { scoreText, cardText, dateText, href };
      });

      const href = entry.href ? new URL(entry.href, page.url()).href : '';
      const scoreParts = parseScoreText(entry.scoreText || entry.cardText || '');
      const gameDate = normalizeScheduleDateText(`${entry.cardText || ''} ${entry.dateText || ''}`);
      entries.push({
        visibleIndex: entries.length,
        scoreText: entry.scoreText || '',
        cardText: entry.cardText || '',
        dateText: entry.dateText || '',
        gameDate,
        result: scoreParts.result,
        scoreUs: scoreParts.scoreUs,
        scoreThem: scoreParts.scoreThem,
        href,
        gameId: href ? extractGameIdFromUrl(href) : '',
      });
    } catch {
      // Ignore stale rows.
    }
  }

  return entries;
}

// ── Schedule extraction modes (HS Slice 2D) ────────────────────────────
//
// getVisibleCompletedGameEntries above anchors on a score badge, so it can only
// ever see games that have already been played. That is exactly right for
// Travel and for High School own-team import, which reconstruct completed
// games. It is NOT sufficient for High School opponent monitoring, which has to
// know about a future scheduled game, a postponement, a cancellation and a
// doubleheader entry BEFORE either half is final.
//
// Rather than add a second scraper, this is the one schedule-row extraction
// boundary, with the mode stated explicitly at the call site:
//
//   COMPLETED_ONLY       delegates to getVisibleCompletedGameEntries unchanged
//   ALL_SCHEDULE_ENTRIES anchors on schedule rows instead of score badges
//
// The mode is never inferred from an environment variable or a loosely related
// flag: an existing caller that wants completed games must keep asking for
// completed games.
const SCHEDULE_EXTRACTION_MODES = Object.freeze({
  COMPLETED_ONLY: 'completed_only',
  ALL_SCHEDULE_ENTRIES: 'all_schedule_entries',
});

const SCHEDULE_ENTRY_STATUSES = Object.freeze([
  'scheduled', 'in_progress', 'final', 'postponed', 'cancelled', 'suspended', 'unknown',
]);

// Identifies an element that affirmatively delimits ONE schedule row, so
// grouping is done by row rather than by href.
//
// Only EXPLICIT per-game markers qualify. Generic containers such as `li` and
// `tr` are deliberately NOT listed: a schedule commonly renders a date-group
// `li`, or a table `tr` with one game per cell, and accepting the nearest such
// ancestor silently collapsed every game under it into one entry -- dropping
// real games with no diagnostic at all. Grouping is now an affirmative claim
// about markup, never a proximity accident.
//
// Even an explicit marker is validated before it is trusted: a node containing
// more than one distinct schedule reference cannot be describing a single game,
// so it is rejected as a row root. An anchor with no trustworthy row root
// becomes its own observation, which over-reports rather than merging. There is
// no href-based fallback anywhere in this module.
const EXPLICIT_ROW_ROOT_SELECTOR = '[data-schedule-row], [data-game-id], .schedule-row';

// ── Date scoping is a SEPARATE concept from row grouping ────────────────
//
// A game-row boundary answers "which anchors are one game". A date scope
// answers "which date header governs this game". Conflating them is what
// produced the original defect in two different ways: first by accepting a
// date-group container as a game row (merging games), then -- after that was
// corrected -- by letting a row hunt for a date through its parent's previous
// sibling, which reaches into the PREVIOUS date group's entire subtree and
// hands its date to a game that belongs to the next group.
//
// These selectors mark date evidence only. They never make an element a row
// root, and no generic container is ever reinstated as one.
//
// ── The affirmative date-header contract ───────────────────────────────
//
// DATE_HEADER_SELECTOR is the ONLY way an element can become a governing date
// header. It used to be passed into the page and then ignored -- both branches
// of the old isDateEvidence() returned looksLikeDate(text) -- so any short
// element containing a parseable date governed every row in its parent's
// subtree. Two shapes published a wrong date in a verified generation:
//
//   * a page-level caption ("Season opener Mar 3, 2026") sitting beside a
//     schedule section with no header of its own, which handed Mar 3 to a game
//     the source never dated;
//   * an unrelated note ("Roster locked 4/20/2026") between two games in one
//     date group, which handed Apr 20 to every game after it.
//
// Neither element claims to be a schedule date boundary. Containing a date is
// not the same as being one, so containing a date is no longer sufficient.
//
// Each accepted form is trustworthy because the SOURCE affirmatively marked it,
// not because this module guessed from its content:
//
//   [data-schedule-date]  an explicit data attribute naming the schedule date
//   [data-date-header]    an explicit data attribute naming a date header
//   .date-header          a class whose only meaning is "this is a date header"
//   .schedule-date        a class whose only meaning is "this is a schedule date"
//
// A caption, note, label, tournament title, roster message, "last updated"
// stamp or any other unmarked element carries none of these, so it can no
// longer govern anything. When nothing marked governs a row the answer is
// not_expressed -- the search is never widened to look for something merely
// date-like, because widening it is exactly what published the wrong dates.
const DATE_HEADER_SELECTOR = '[data-schedule-date], [data-date-header], .date-header, .schedule-date';
const GAME_DATE_SELECTOR = '[data-game-date], .game-date';

// ── The positive schedule-header grammar ───────────────────────────────
//
// Structural marking says the SOURCE believes this element is a date header. It
// does not say the text is a schedule date. The previous attempt asked only
// "does this text avoid a known bad word", which failed in both directions: it
// missed synonyms ("Last modified", "Published", "Roster freeze") and published
// their dates, and it matched ordinary game-day language ("gates open at 5") and
// threw away a legitimate one.
//
// A blacklist can only ever enumerate the prose someone thought of. This asks
// the affirmative question instead:
//
//   which exact part of this element asserts the game date, and does what
//   remains fit a bounded schedule-header grammar?
//
// A header is accepted only when the date leads the text -- optionally after a
// weekday -- and everything left over is either punctuation or an annotation
// that describes THIS GAME. Anything else is unsupported, and unsupported fails
// closed rather than guessing.
//
// The date must LEAD. That single rule is what separates "Saturday, April 11,
// 2026 - Doubleheader" from "Rainout announced Mar 14, 2026": administrative
// text says what happened to the schedule before it names a date, whereas a
// schedule header names the day first and then annotates it.
const HEADER_WEEKDAY = '(?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?\\.?,?\\s*';
const HEADER_DATE_EXPRESSION = '(?:(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?'
  + '|aug(?:ust)?|sep(?:t)?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?\\s+\\d{1,2}(?:,?\\s+(?:20\\d{2}|19\\d{2}))?'
  + '|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?)';
const HEADER_LEADING_DATE = new RegExp(`^(?:${HEADER_WEEKDAY})?(${HEADER_DATE_EXPRESSION})`, 'i');
const ANY_HEADER_DATE = new RegExp(HEADER_DATE_EXPRESSION, 'gi');

// Separators a source may put between the date and its annotation. Purely
// typographic: none of these carries meaning, so consuming them cannot change
// what the header asserts.
const HEADER_SEPARATOR = '[\\s\\-\\u2013\\u2014,;:|/()\\[\\].\\u00b7\\u2022]+';

// ── Supported annotations ──────────────────────────────────────────────
//
// Every entry describes THE GAME played on the header's date, and every one has
// a counterpart this module already parses elsewhere -- which is the test for
// admission. Nothing here is included because it "looks harmless"; each is
// included because the codebase already treats it as a property of a scheduled
// game:
//
//   Doubleheader / Game N   two games that day, and which one -- parseGameNumber
//   Home / Away / vs / at   the side designation           -- parseHomeAway
//   Varsity / JV / Freshman the team level                 -- hs_opponent_teams.level
//   Senior Night / Homecoming  a game-day designation for THAT game
//   gates open / first pitch / a bare clock time  the day's timing
//                                                  -- parseScheduledTimeText
//
// An administrative phrase ("rainout announced", "roster freeze", "published")
// describes an action taken ON the schedule, not a property of the game, so it
// is absent -- and absence is refusal. Extending this list is a deliberate act
// that must name which game property the new annotation expresses.
const HEADER_TIME = '\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?';
const SUPPORTED_HEADER_ANNOTATIONS = [
  `doubleheader`,
  `dh`,
  `(?:game|gm)\\s*\\d{1,2}`,
  `home`,
  `away`,
  `neutral`,
  `vs\\.?`,
  `at`,
  `varsity`,
  `jv`,
  `junior\\s+varsity`,
  `fresh(?:man|men)?`,
  `frosh`,
  `senior\\s+(?:night|day)`,
  `homecoming`,
  `gates?\\s+open(?:s)?(?:\\s+at)?\\s*${HEADER_TIME}`,
  `first\\s+pitch(?:\\s+at)?\\s*${HEADER_TIME}`,
  HEADER_TIME,
];
const SUPPORTED_HEADER_SUFFIX = new RegExp(
  `^(?:${HEADER_SEPARATOR})?(?:(?:${SUPPORTED_HEADER_ANNOTATIONS.join('|')})(?:${HEADER_SEPARATOR})?)*$`, 'i');

// Classifies the visible text of a source-marked date header.
//
//   date         the text leads with exactly one real calendar date and every
//                remaining token is a supported annotation
//   ambiguous    the text names more than one date
//   invalid      the leading date is not a real calendar day
//   unsupported  the element is marked, and does carry date-like text, but the
//                text is not a schedule header this parser can read -- either
//                the date does not lead, or material prose follows it
//   none         no date-like text at all; not a header candidate
//
// Pure and exported so the grammar can be tested directly, without a browser
// and without any markup.
function parseScheduleHeaderText(value) {
  const text = normalizeScheduleEntryText(value);
  if (!text) return { kind: 'none', date: null, dates: [], suffix: '' };

  const dates = (text.match(ANY_HEADER_DATE) || []).map((match) => match.trim());
  if (dates.length === 0) return { kind: 'none', date: null, dates: [], suffix: '' };

  // More than one distinct calendar date in one header is evidence the parser
  // must not choose between. Compared as RESOLVED dates so "Apr 11" repeated in
  // two formats is one date, not two.
  const resolved = Array.from(new Set(dates.map((d) => normalizeScheduleDateText(d)).filter(Boolean)));
  if (resolved.length > 1) return { kind: 'ambiguous', date: null, dates: resolved, suffix: '' };

  const leading = text.match(HEADER_LEADING_DATE);
  if (!leading) {
    // A date is present but something else came first. That is the shape of
    // every administrative header: "Rainout announced Mar 14, 2026".
    return { kind: 'unsupported', date: null, dates: resolved, suffix: text, reason: 'date_does_not_lead_the_header' };
  }

  const date = normalizeScheduleDateText(leading[1]);
  if (!date) {
    return { kind: 'invalid', date: null, dates: [], suffix: '', reason: 'leading_date_is_not_a_real_calendar_date' };
  }

  const suffix = text.slice(leading[0].length);
  if (!SUPPORTED_HEADER_SUFFIX.test(suffix)) {
    return { kind: 'unsupported', date: null, dates: resolved, suffix, reason: 'unsupported_text_follows_the_date' };
  }
  return { kind: 'date', date, dates: resolved, suffix };
}

// A structured value the source published for machines rather than for readers:
// data-schedule-date="2026-04-11", data-date-header="2026-04-11", or a
// <time datetime="2026-04-11">. Previously these were treated as bare Boolean
// markers and their VALUES were thrown away, so a header could carry an explicit
// machine-readable date and still be read from its prose.
//
// Returns the resolved date, or null when the attribute holds no date (an
// ordinary Boolean marker), or the sentinel 'invalid' when it holds something
// date-shaped that is not a real day.
function parseStructuredHeaderDate(value) {
  const raw = normalizeScheduleEntryText(value);
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (iso) {
    const [, y, m, d] = iso;
    return isRealCalendarDate(Number(y), Number(m), Number(d))
      ? `${y}-${m}-${d}`
      : 'invalid';
  }
  if (!ANY_HEADER_DATE.test(raw)) { ANY_HEADER_DATE.lastIndex = 0; return null; }
  ANY_HEADER_DATE.lastIndex = 0;
  return normalizeScheduleDateText(raw) || 'invalid';
}

// How a schedule row's date was established. Carried through the collector as
// provenance so an unsafe date can fail closed with a reason instead of being
// silently published or silently dropped.
//
//   resolved_game_row   the row itself expressed a date
//   resolved_date_group an enclosing date group expressed exactly one date
//   not_expressed       neither did; the source simply did not say
//   ambiguous           the governing date evidence names more than one date
//   conflicting         the row and its date group disagree
//   invalid             the source named a date that does not exist on the
//                       Gregorian calendar (Feb 30, Apr 31, month 13, day 0).
//                       Distinct from not_expressed on purpose: the source DID
//                       say something, and saying something impossible is
//                       evidence of a parsing or upstream fault that a reviewer
//                       must see, not an absence to be quietly tolerated.
//   unsupported_marked_header
//                       the source MARKED an element as a date header and put
//                       date-like text in it, but the text is not a schedule
//                       header this parser can read -- the date does not lead,
//                       or material prose follows it. Deliberately NOT folded
//                       into not_expressed: "the source said nothing" and "the
//                       source said something I refuse to interpret" call for
//                       different handling, and only the second one may not use
//                       the completed-game null-date exception. Collapsing them
//                       is how a rejected legitimate header turned into a
//                       verified completed game carrying game_date = null.
const DATE_RESOLUTION_STATUSES = Object.freeze({
  RESOLVED_GAME_ROW: 'resolved_game_row',
  RESOLVED_DATE_GROUP: 'resolved_date_group',
  NOT_EXPRESSED: 'not_expressed',
  AMBIGUOUS: 'ambiguous',
  CONFLICTING: 'conflicting',
  INVALID: 'invalid',
  UNSUPPORTED_MARKED_HEADER: 'unsupported_marked_header',
});

const DATE_SOURCE_KINDS = Object.freeze({
  GAME_ROW: 'game_row',
  DATE_GROUP: 'date_group',
  NONE: 'none',
});

// Pure, browser-free, and exported so the classification rules can be tested
// directly rather than only through a DOM fixture.
//
// Order matters. A row that says "Postponed" must never be read as final just
// because some other part of the card carries a stale score, and a row with no
// recognisable evidence stays 'unknown' rather than being optimistically called
// 'scheduled'. Nothing here invents a status the source did not express.
function classifyScheduleEntryStatus({ rawStatusText = '', scoreText = '' } = {}) {
  const text = String(rawStatusText || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const score = String(scoreText || '').replace(/\s+/g, ' ').trim();

  if (/\b(?:postponed|ppd)\b/.test(text)) return 'postponed';
  if (/\bcancell?ed\b/.test(text)) return 'cancelled';
  if (/\bsuspended\b/.test(text)) return 'suspended';
  if (/\b(?:in progress|live now|top \d|bot(?:tom)? \d|mid \d|end \d)\b/.test(text)) return 'in_progress';
  if (/\b[WLT]\s*\d+\s*[-–—]\s*\d+\b/i.test(score)) return 'final';
  if (/\bfinal\b/.test(text)) return 'final';
  // A clock time is positive evidence the source is advertising an upcoming
  // game; without it there is nothing to justify any particular status.
  if (/\b\d{1,2}:\d{2}\s*(?:am|pm)\b/.test(text)) return 'scheduled';
  if (/\b(?:tbd|tba)\b/.test(text)) return 'unknown';
  return 'unknown';
}

// GameChanger schedule rows do not carry a timezone. Rather than guess the
// viewer's zone (which would silently shift a 7:00 PM first pitch), the
// uncertainty is recorded explicitly and carried downstream.
function parseScheduledTimeText(value) {
  const match = String(value || '').match(/\b(\d{1,2}:\d{2}\s*(?:AM|PM))\b/i);
  if (!match) return { scheduledTimeText: null, timezoneKnown: false, timezone: null };
  const zone = String(value || '').match(/\b(EST|EDT|CST|CDT|MST|MDT|PST|PDT|AKST|AKDT|HST|UTC|GMT)\b/i);
  return {
    scheduledTimeText: match[1].replace(/\s+/g, ' ').toUpperCase(),
    timezoneKnown: !!zone,
    timezone: zone ? zone[1].toUpperCase() : null,
  };
}

// "vs" means the subject team is hosting; "@" means it is travelling. Anything
// else stays null rather than defaulting to home.
function parseHomeAway(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (/(^|\s)@\s*\S/.test(text) || /\bat\s+\S/i.test(text)) return 'away';
  if (/\bvs\.?\s+\S/i.test(text)) return 'home';
  return null;
}

function parseCounterpartyName(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const match = text.match(/(?:\bvs\.?|@|\bat)\s+([^,|•]+?)(?=\s{2,}|\s*[,|•]|\s+\d{1,2}:\d{2}\s*(?:AM|PM)\b|$)/i);
  if (!match) return null;
  const name = match[1].replace(/\s+/g, ' ').trim();
  return name || null;
}

// A doubleheader marker is the only deterministic discriminator available when
// two same-day rows share an opponent and no distinct upstream id.
function parseGameNumber(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const labelled = text.match(/\bgame\s*#?\s*(\d{1,2})\b/i);
  if (labelled) return Number(labelled[1]);
  const dh = text.match(/\bdh\s*[-#]?\s*(\d{1,2})\b/i);
  if (dh) return Number(dh[1]);
  return null;
}

function normalizeScheduleEntryText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// Resolves ONE row's date from the two independent pieces of evidence the DOM
// pass collected: whatever the row itself said, and whatever its governing date
// group said. Pure and exported so the rules can be tested without a browser.
//
// The rules, in order:
//   * the row's own date wins over its group's -- a per-game date is the more
//     specific claim, and confirming it against a matching group date is not a
//     conflict;
//   * a row and group that name DIFFERENT dates are a conflict, never silently
//     resolved in either direction;
//   * evidence naming more than one date is ambiguous, never resolved to
//     whichever matched first;
//   * no evidence at all is 'not_expressed' -- the source did not say, and
//     nothing is invented to fill the gap.
//
// Nothing here consults DOM position, row order, or neighbouring rows, so
// reversing rows within a group, or reversing whole groups, cannot change what
// any game resolves to.
function resolveScheduleEntryDate({
  rowDateTexts = [], groupDateTexts = [], groupHeaderText = '', groupHeaders = null,
} = {}) {
  const distinct = (values) => Array.from(new Set(values.filter(Boolean)));
  const rowRaw = distinct(rowDateTexts.map(normalizeScheduleEntryText));
  const rowDates = distinct(rowRaw.map((text) => normalizeScheduleDateText(text)));

  const base = {
    gameDate: null,
    dateResolutionStatus: DATE_RESOLUTION_STATUSES.NOT_EXPRESSED,
    dateSourceKind: DATE_SOURCE_KINDS.NONE,
    rawDateText: '',
    dateConflict: null,
  };

  // ── Governing header evidence ────────────────────────────────────────
  //
  // `groupHeaders` is the evidence-carrying form the DOM pass now emits: the
  // raw text of each competing marked header plus any structured value it
  // published. `groupDateTexts` / `groupHeaderText` remain supported so the
  // rules can still be exercised directly with pre-extracted date text.
  let groupDates;
  let groupHeaderLabel;
  let groupUnsupported = null;
  let groupStructuredInvalid = false;

  if (Array.isArray(groupHeaders)) {
    groupHeaderLabel = groupHeaders.map((h) => normalizeScheduleEntryText(h && h.text)).filter(Boolean).join(' | ');
    const accepted = [];
    for (const header of groupHeaders) {
      // ── Structured evidence may CONFIRM or SUPPLY. It may never OVERRIDE. ──
      //
      // A structured value (`data-schedule-date`, `data-date-header`, a marked
      // `<time datetime>`, or a nested `time[datetime]` descendant) used to
      // outrank the element's own visible text outright. That inverted the
      // safety property this module exists to provide: a header reading
      // "Rainout announced Mar 14, 2026" -- which the positive grammar
      // explicitly REFUSES -- published Mar 14 anyway as soon as the same date
      // also appeared in a machine-readable attribute, and the two markups
      // differ only by semantically correct HTML.
      //
      // The evidentiary strengths, stated explicitly:
      //
      //   data-schedule-date   names the schedule date. Authoritative as a
      //   data-date-header     SUPPLY when the element expresses no date of its
      //   <time datetime> on   own, and as a CONFIRMATION of a header the
      //     the marked header  grammar already accepts.
      //
      //   nested time[datetime]  proves only that ITS OWN contents are a date.
      //                          It says nothing about whether that date is the
      //                          schedule date for the games that follow, so it
      //                          is never stronger than the four above.
      //
      // None of them is strong enough to license visible prose the grammar
      // rejected, because none of them can observe WHY the prose was rejected.
      // So the visible verdict governs whenever the element carries date-like
      // text at all, and the structured value is consulted only to confirm it,
      // to contradict it, or to supply a date the visible text never expressed.
      const structuredRaw = (header && header.structured) || [];
      const structured = distinct(structuredRaw.map(parseStructuredHeaderDate));
      if (structured.includes('invalid')) { groupStructuredInvalid = true; continue; }
      const visible = parseScheduleHeaderText(header && header.text);
      if (structured.length > 1) {
        return {
          ...base,
          dateResolutionStatus: DATE_RESOLUTION_STATUSES.CONFLICTING,
          dateSourceKind: DATE_SOURCE_KINDS.DATE_GROUP,
          rawDateText: groupHeaderLabel,
          dateConflict: { reason: 'date_group_structured_values_disagree', candidates: structured.slice().sort() },
        };
      }

      // An unsafe visible verdict survives any structured value. Checked BEFORE
      // the structured branch, which is the whole correction: agreement is not
      // absolution, and an agreeing attribute beside refused prose is still
      // refused prose.
      if (visible.kind === 'invalid') { groupStructuredInvalid = true; continue; }
      if (visible.kind === 'unsupported') { groupUnsupported = groupUnsupported || visible; continue; }
      if (visible.kind === 'ambiguous') {
        accepted.push(...visible.dates);
        if (structured.length === 1) accepted.push(structured[0]);
        continue;
      }

      if (structured.length === 1) {
        // The visible text is either a header the grammar accepted, or carries
        // no date at all. Only in those two states may the structured value
        // speak: to contradict an accepted date (a conflict neither side wins),
        // or to supply one the source never rendered for a reader.
        if (visible.kind === 'date' && visible.date !== structured[0]) {
          return {
            ...base,
            dateResolutionStatus: DATE_RESOLUTION_STATUSES.CONFLICTING,
            dateSourceKind: DATE_SOURCE_KINDS.DATE_GROUP,
            rawDateText: groupHeaderLabel,
            dateConflict: {
              reason: 'date_group_structured_value_contradicts_visible_date',
              structuredDate: structured[0],
              visibleDate: visible.date,
            },
          };
        }
        accepted.push(structured[0]);
        continue;
      }
      if (visible.kind === 'date') accepted.push(visible.date);
    }
    groupDates = distinct(accepted);
  } else {
    const groupRaw = distinct(groupDateTexts.map(normalizeScheduleEntryText));
    groupHeaderLabel = normalizeScheduleEntryText(groupHeaderText);
    groupDates = distinct(groupRaw.map((text) => normalizeScheduleDateText(text)));
    if (groupRaw.length > 0 && groupDates.length === 0) groupStructuredInvalid = true;
  }
  const groupRaw = groupHeaderLabel ? [groupHeaderLabel] : [];
  groupHeaderText = groupHeaderLabel;

  // ── Unsafe evidence PARTICIPATES; it is not a fallback ─────────────────
  //
  // Both refusals below used to fire only when nothing else resolved
  // (`groupDates.length === 0 && rowDates.length === 0`), which made them a
  // last resort rather than a vote. One readable header standing beside one
  // header this parser could not read then published the readable date with
  // full confidence -- even though the very next rule down treats two READABLE
  // headers that disagree as ambiguous. "I cannot read this marked header" is
  // strictly less certain than "these two headers disagree", so it cannot
  // produce a more confident answer.
  //
  // The run these compete within is bounded by the DOM pass and arrives here
  // already delimited (see `competing` in getVisibleScheduleEntries): it starts
  // after the last schedule anchor preceding this row, ends at this row, keeps
  // only the innermost scope so a month header wrapping a day header is context
  // rather than a rival, and never includes a header from another schedule
  // component. So unsafe evidence from an earlier completed group, from after
  // this game, or from a different component cannot reach this decision at all.
  //
  // An impossible date is reported first: it is a fault in the evidence itself.
  if (groupStructuredInvalid) {
    return {
      ...base,
      dateResolutionStatus: DATE_RESOLUTION_STATUSES.INVALID,
      dateSourceKind: DATE_SOURCE_KINDS.DATE_GROUP,
      rawDateText: groupHeaderLabel,
      dateConflict: { reason: 'date_group_date_is_not_a_real_calendar_date', candidates: groupRaw.slice().sort() },
    };
  }

  // The source MARKED this element as a date header and put date-like text in
  // it, but the text is not a schedule header this parser can read. Refusing it
  // as a NAMED unsafe status -- rather than as ordinary silence -- is what stops
  // it reaching the completed-game null-date exception.
  //
  // This now also outranks a per-row date. That is deliberate and matches the
  // rule already applied to a CONFLICTING group header: the codebase's settled
  // position is that governing evidence is not irrelevant merely because the
  // row also spoke, so a row date cannot silently dismiss a marked header the
  // parser refused to read.
  if (groupUnsupported) {
    return {
      ...base,
      dateResolutionStatus: DATE_RESOLUTION_STATUSES.UNSUPPORTED_MARKED_HEADER,
      dateSourceKind: DATE_SOURCE_KINDS.DATE_GROUP,
      rawDateText: groupHeaderLabel,
      dateConflict: {
        reason: groupUnsupported.reason || 'unsupported_marked_date_header',
        headerText: groupHeaderLabel,
        unsupportedSuffix: normalizeScheduleEntryText(groupUnsupported.suffix),
      },
    };
  }

  // The source named something date-shaped that is not a real calendar day.
  // Reported BEFORE every other rule: an impossible date is a fault in the
  // evidence itself, and no later rule can make it publishable. Checked
  // separately for the row and the group so the diagnostic names which one.
  const impossible = (rawTexts, dates) => rawTexts.length > 0 && dates.length === 0;
  if (impossible(rowRaw, rowDates)) {
    return {
      ...base,
      dateResolutionStatus: DATE_RESOLUTION_STATUSES.INVALID,
      dateSourceKind: DATE_SOURCE_KINDS.GAME_ROW,
      rawDateText: rowRaw.join(' | '),
      dateConflict: { reason: 'game_row_date_is_not_a_real_calendar_date', candidates: rowRaw.slice().sort() },
    };
  }

  if (rowDates.length > 1) {
    return {
      ...base,
      dateResolutionStatus: DATE_RESOLUTION_STATUSES.AMBIGUOUS,
      dateSourceKind: DATE_SOURCE_KINDS.GAME_ROW,
      rawDateText: rowRaw.join(' | '),
      dateConflict: { reason: 'multiple_game_row_dates', candidates: rowDates.slice().sort() },
    };
  }
  if (groupDates.length > 1) {
    return {
      ...base,
      dateResolutionStatus: DATE_RESOLUTION_STATUSES.AMBIGUOUS,
      dateSourceKind: DATE_SOURCE_KINDS.DATE_GROUP,
      rawDateText: normalizeScheduleEntryText(groupHeaderText),
      dateConflict: { reason: 'multiple_date_group_dates', candidates: groupDates.slice().sort() },
    };
  }

  const rowDate = rowDates[0] || null;
  const groupDate = groupDates[0] || null;

  if (rowDate && groupDate && rowDate !== groupDate) {
    return {
      ...base,
      dateResolutionStatus: DATE_RESOLUTION_STATUSES.CONFLICTING,
      dateSourceKind: DATE_SOURCE_KINDS.GAME_ROW,
      rawDateText: `${rowRaw.join(' ')} | ${normalizeScheduleEntryText(groupHeaderText)}`,
      dateConflict: {
        reason: 'game_row_contradicts_date_group',
        gameRowDate: rowDate,
        dateGroupDate: groupDate,
      },
    };
  }
  if (rowDate) {
    return {
      ...base,
      gameDate: rowDate,
      dateResolutionStatus: DATE_RESOLUTION_STATUSES.RESOLVED_GAME_ROW,
      dateSourceKind: DATE_SOURCE_KINDS.GAME_ROW,
      rawDateText: rowRaw.join(' '),
    };
  }
  if (groupDate) {
    return {
      ...base,
      gameDate: groupDate,
      dateResolutionStatus: DATE_RESOLUTION_STATUSES.RESOLVED_DATE_GROUP,
      dateSourceKind: DATE_SOURCE_KINDS.DATE_GROUP,
      rawDateText: normalizeScheduleEntryText(groupHeaderText),
    };
  }
  return base;
}

// The single schedule-row extraction boundary. `mode` is required and explicit.
async function getVisibleScheduleEntries(page, { mode } = {}) {
  if (mode !== SCHEDULE_EXTRACTION_MODES.COMPLETED_ONLY
    && mode !== SCHEDULE_EXTRACTION_MODES.ALL_SCHEDULE_ENTRIES) {
    throw new Error(`getVisibleScheduleEntries requires an explicit mode (${Object.values(SCHEDULE_EXTRACTION_MODES).join(' | ')})`);
  }

  if (mode === SCHEDULE_EXTRACTION_MODES.COMPLETED_ONLY) {
    // Deliberately the SAME function Travel and own-team import already use --
    // not a reimplementation -- so their behaviour cannot drift.
    const completed = await getVisibleCompletedGameEntries(page);
    return completed.map((entry) => ({
      ...entry,
      status: 'final',
      rawStatusText: entry.scoreText || '',
      counterpartyName: parseCounterpartyName(entry.cardText),
      homeAway: parseHomeAway(entry.cardText),
      venue: null,
      gameNumber: parseGameNumber(entry.cardText),
      rowAnchorCount: 1,
      identityCollision: false,
      collidingRowIndexes: [],
      // Purely additive provenance so both modes report the same shape. The
      // completed-only path's own date logic is untouched -- own-team and
      // Travel keep exactly the dates they already produced.
      rawDateText: normalizeScheduleEntryText(entry.dateText),
      dateResolutionStatus: entry.gameDate
        ? DATE_RESOLUTION_STATUSES.RESOLVED_GAME_ROW
        : DATE_RESOLUTION_STATUSES.NOT_EXPRESSED,
      dateSourceKind: entry.gameDate ? DATE_SOURCE_KINDS.GAME_ROW : DATE_SOURCE_KINDS.NONE,
      dateConflict: null,
      // The completed-only path resolves its own href eagerly and skips a row it
      // cannot parse, so a malformed reference never reaches here.
      sourceReferenceMalformed: false,
      rawSourceReference: '',
      ...parseScheduledTimeText(entry.cardText),
    }));
  }

  await dismissDontMissOutPopup(page);

  // ── The extraction unit is the schedule ROW, never the href ───────────
  //
  // Anchors are grouped by their row root, so a row component that renders two
  // anchors to the same game (a thumbnail link plus a title link, or a mobile
  // and a desktop variant) yields ONE observation, while two distinct row roots
  // yield TWO observations even when every extracted value matches.
  //
  // Nothing is ever merged across row roots. Two real games that the source
  // happens to publish under one identifier must reach the identity layer as two
  // colliding observations: keeping whichever row parsed first would discard a
  // real game, and with it a real result.
  const rawRows = await page.evaluate(({ rowRootSelector, dateHeaderSelector, gameDateSelector }) => {
    function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }

    // Every date-like substring, not just the first. A header that names two
    // dates ("Apr 11 - Apr 13") must be reported as ambiguous rather than
    // silently resolving to whichever one happens to match first.
    const DATE_PATTERN = '(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\\.?,?\\s*)?'
      + '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?'
      + '|Aug(?:ust)?|Sep(?:t)?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)'
      + '\\.?\\s+\\d{1,2}(?:,?\\s+(?:20\\d{2}|19\\d{2}))?'
      + '|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?';
    function allDateTexts(value) {
      const matched = String(value || '').match(new RegExp(DATE_PATTERN, 'gi'));
      return matched ? matched.map(clean).filter(Boolean) : [];
    }
    function looksLikeDate(value) { return allDateTexts(value).length > 0; }

    const CARDTEXT_MAX_LEN = 260;
    // A date header is a short label. Capping its length is what keeps a whole
    // schedule section from being mistaken for one, and bounds the scan.
    const DATE_HEADER_MAX_LEN = 120;
    // A per-game date lives in its own small element, never in the row's whole
    // card text (which also carries the opponent, score and time).
    const ROW_DATE_MAX_LEN = 60;

    const SCHEDULE_ANCHOR_SELECTOR = 'a[href*="/schedule/"]';

    // -- Normalized schedule reference -----------------------------------
    //
    // Two anchors point at the same game when they resolve to the same schedule
    // PATH. Origin is deliberately ignored so a relative `/teams/x/schedule/g1`
    // and an absolute `https://web.gc.com/teams/x/schedule/g1` are recognised as
    // one reference instead of colliding as two. Query and fragment are dropped
    // because neither is identity-bearing here. Path segments are compared
    // verbatim -- never decoded or case-folded -- so two genuinely different
    // games can never be normalized into each other.
    //
    // An href the URL parser rejects yields a reference distinct from every real
    // one and from every differently-malformed one, so a broken anchor can never
    // be merged with a real game.
    function scheduleRef(anchor) {
      const raw = anchor.getAttribute('href') || '';
      if (!raw) return '';
      let parsed;
      try {
        parsed = new URL(raw, document.baseURI);
      } catch (err) {
        return ' unparseable:' + raw;
      }
      // A schedule reference is an HTTP(S) location. 'javascript:', 'data:',
      // 'file:' and 'ftp:' are not, and none of them may become a source identity
      // just because its text happens to contain '/schedule/'. The value is only
      // ever PARSED here -- never navigated, never executed -- and a rejected
      // scheme yields a sentinel distinct from every real reference and from every
      // differently-rejected one, so nothing merges. The URL parser has already
      // lower-cased and trimmed the scheme, so 'JaVaScRiPt:' and a
      // leading-whitespace variant are caught here too.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return ' unsupported-scheme:' + raw;
      }
      let path = parsed.pathname || '';
      if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
      return path || (' unparseable:' + raw);
    }

    // Counts the DISTINCT games a candidate row root claims to contain. A node
    // describing one game contains exactly one.
    function distinctScheduleRefs(node) {
      const refs = new Set();
      for (const link of node.querySelectorAll(SCHEDULE_ANCHOR_SELECTOR)) {
        const ref = scheduleRef(link);
        if (ref) refs.add(ref);
      }
      return refs.size;
    }

    // The nearest ancestor that AFFIRMATIVELY marks one schedule row, and that
    // survives validation: a marker containing more than one distinct schedule
    // reference is not describing a single game, so it is rejected rather than
    // trusted. When no trustworthy row root exists the anchor becomes its own
    // row -- which can over-report (two anchors for one game become two
    // observations, and the collision path then surfaces the ambiguity) but can
    // never merge or discard a distinct game. There is deliberately no
    // href-based fallback, and no generic `li`/`tr` container is accepted merely
    // for being the nearest ancestor.
    function rowRootFor(anchor) {
      let node = anchor;
      for (let depth = 0; depth < 12 && node; depth += 1) {
        if (node.matches && node.matches(rowRootSelector)) {
          return distinctScheduleRefs(node) <= 1 ? node : anchor;
        }
        node = node.parentElement;
      }
      return anchor;
    }

    // -- One document-order pass ------------------------------------------
    //
    // Position is read once, here, and used only to decide which date header
    // governs which row. It never becomes canonical identity: `visibleIndex`
    // stays provenance and every published hash excludes it.
    const docIndex = new Map();
    {
      const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
      let i = 1;
      docIndex.set(document.documentElement, i);
      while (walker.nextNode()) {
        i += 1;
        docIndex.set(walker.currentNode, i);
      }
    }
    const positionOf = (node) => (docIndex.has(node) ? docIndex.get(node) : -1);

    // A GOVERNING date header must be affirmatively marked as one by the source.
    // Containing a parseable date is necessary but no longer sufficient: an
    // unmarked caption, note, label, tournament title or "last updated" stamp
    // used to qualify here and hand its date to every row in its parent's
    // subtree, which is how a wrong date reached a verified generation.
    //
    // It must also contain NO schedule anchor -- a container that holds games is
    // a group, not a header -- be short enough to be a label rather than a
    // section, and not carry an administrative qualifier that marks it as a
    // date ABOUT the schedule rather than a date the games are played on.
    // The page decides only WHICH elements are candidate headers and what
    // evidence they carry. Whether that evidence is a readable schedule header
    // is decided by the positive grammar in Node (parseScheduleHeaderText), so
    // the rule is pure, unit-testable without a browser, and identical for every
    // producer.
    function structuredHeaderValues(element) {
      const values = [];
      for (const attr of ['data-schedule-date', 'data-date-header', 'datetime']) {
        const raw = element.getAttribute && element.getAttribute(attr);
        if (raw) values.push(clean(raw));
      }
      const time = element.querySelector && element.querySelector('time[datetime]');
      if (time) {
        const raw = time.getAttribute('datetime');
        if (raw) values.push(clean(raw));
      }
      return values;
    }
    function isMarkedDateHeader(element, maxLen) {
      if (!element || element.nodeType !== 1) return false;
      if (!element.matches || !element.matches(dateHeaderSelector)) return false;
      if (element.querySelector(SCHEDULE_ANCHOR_SELECTOR)) return false;
      const text = clean(element.textContent || '');
      if (text.length > maxLen) return false;
      // A candidate carries either date-like visible text or a structured value.
      // A marker with neither is an ordinary Boolean flag and governs nothing.
      if (looksLikeDate(text)) return true;
      return structuredHeaderValues(element).length > 0;
    }
    // Only the innermost marked header counts, so a marked wrapper never
    // shadows the marked label it wraps.
    function isInnermostMarkedDateHeader(element, maxLen) {
      if (!isMarkedDateHeader(element, maxLen)) return false;
      for (const child of element.querySelectorAll('*')) {
        if (isMarkedDateHeader(child, maxLen)) return false;
      }
      return true;
    }

    // A row's OWN date is judged differently, and may be structural rather than
    // marked. The row root is itself affirmative evidence: it matched
    // EXPLICIT_ROW_ROOT_SELECTOR and was accepted only after
    // distinctScheduleRefs(root) <= 1 proved it describes exactly one game, so a
    // short date element INSIDE it belongs to that game and to no other. The
    // scan never leaves the row, which is why neither confirmed defect involved
    // it -- both offending elements sat outside every row.
    function isRowDateEvidence(element, maxLen) {
      if (!element || element.nodeType !== 1) return false;
      if (element.querySelector(SCHEDULE_ANCHOR_SELECTOR)) return false;
      const text = clean(element.textContent || '');
      if (!text || text.length > maxLen) return false;
      return looksLikeDate(text);
    }
    function isInnermostRowDateEvidence(element, maxLen) {
      if (!isRowDateEvidence(element, maxLen)) return false;
      for (const child of element.querySelectorAll('*')) {
        if (isRowDateEvidence(child, maxLen)) return false;
      }
      return true;
    }

    // A header governs exactly its own parent's subtree. That single rule is
    // what stops a date crossing from one sibling date group into the next: the
    // Apr 11 header inside date-group #1 has scope #1, which does not contain
    // any game in date-group #2. When headers and rows are flat siblings the
    // scope is the shared section and the LATEST preceding header wins, which is
    // exactly "the next header ends the previous date's scope". There is no
    // global last-date-seen variable, so nothing can leak between sections.
    // ── Affirmative scope ────────────────────────────────────────────
    //
    // A header's parent subtree bounds it, but that alone let a PAGE-LEVEL
    // header govern a schedule section merely because a shared wrapper
    // contained both. A header must now also sit inside the same schedule
    // component as the row it claims, so an element outside the component that
    // renders the games cannot reach in.
    //
    // The fallback -- no component ancestor at all -- exists only for a bare
    // single-date page that never declares a component. It cannot cross into a
    // component, because a row inside one requires its header to be inside the
    // same one.
    const SCHEDULE_COMPONENT_SELECTOR = '.schedule, [data-schedule], .schedule-component, [data-schedule-component]';
    function nearestScheduleComponent(node) {
      return node && node.closest ? node.closest(SCHEDULE_COMPONENT_SELECTOR) : null;
    }

    // ── The no-component fallback needs an AFFIRMATIVE local relationship ──
    //
    // When a row sits inside a schedule component the rule above is enough: a
    // header must share that component. A page that declares no component at
    // all had only "the header's parent subtree contains the row", which a
    // distant common ancestor satisfies -- so a page-level header separated
    // from the games by unrelated content and a nested sibling list still
    // governed them:
    //
    //   <div id="page">
    //     <div class="date-header">Apr 11, 2026</div>   <-- page level
    //     <div class="notes">...</div>                  <-- unrelated
    //     <div id="other"><a href=".../schedule/1">      <-- different list
    //
    // Sharing `#page` is not evidence that the header describes that list. Two
    // narrow shapes are, and nothing else qualifies:
    //
    //   1. the header and the row root are DIRECT SIBLINGS -- one parent holds
    //      the label and the games it labels, with nothing interposed;
    //   2. an explicit date-group wrapper contains BOTH -- the source drew the
    //      boundary itself, so the header cannot escape it.
    //
    // Anything else fails toward unresolved rather than guessing across an
    // uncertain boundary.
    const DATE_GROUP_SELECTOR = '.date-group, [data-date-group]';
    function nearestDateGroup(node) {
      return node && node.closest ? node.closest(DATE_GROUP_SELECTOR) : null;
    }
    function hasAffirmativeLocalRelationship(headerElement, root) {
      if (!headerElement || !root) return false;
      if (headerElement.parentElement && headerElement.parentElement === root.parentElement) return true;
      const group = nearestDateGroup(headerElement);
      return !!(group && group !== headerElement && group.contains(root));
    }

    const headers = [];
    for (const element of document.querySelectorAll('*')) {
      if (!isInnermostMarkedDateHeader(element, DATE_HEADER_MAX_LEN)) continue;
      headers.push({
        element,
        scope: element.parentElement || document.body,
        component: nearestScheduleComponent(element),
        position: positionOf(element),
        text: clean(element.textContent || ''),
        structured: structuredHeaderValues(element),
      });
    }

    const anchors = Array.from(document.querySelectorAll(SCHEDULE_ANCHOR_SELECTOR));

    // Document position of the last schedule anchor strictly before `position`,
    // or -1. Used only to bound a contiguous run of competing headers: a header
    // that sits before an intervening game is that game's history, not a rival
    // claim on a later row.
    const anchorPositions = anchors.map((anchor) => positionOf(anchor)).filter((p) => p >= 0).sort((a, b) => a - b);
    function previousAnchorPosition(position) {
      let last = -1;
      for (const p of anchorPositions) {
        if (p >= position) break;
        last = p;
      }
      return last;
    }

    const roots = [];
    const rootIndex = new Map();
    for (const anchor of anchors) {
      const anchorRect = anchor.getBoundingClientRect();
      if (anchorRect.width <= 0 || anchorRect.height <= 0) continue;
      const root = rowRootFor(anchor);
      if (rootIndex.has(root)) {
        roots[rootIndex.get(root)].anchors.push(anchor);
        continue;
      }
      rootIndex.set(root, roots.length);
      roots.push({ root, anchors: [anchor] });
    }

    return roots.map(({ root, anchors: rowAnchors }, index) => {
      // Read the WHOLE row, not just its first anchor. A thumbnail-first row
      // previously lost its score because only the first anchor was parsed.
      const cardText = clean(root.innerText || root.textContent || '');
      const hrefs = Array.from(new Set(rowAnchors.map((a) => a.getAttribute('href') || '').filter(Boolean)));

      // -- The row's OWN date, if it has one -----------------------------
      // Searched strictly inside the row root. An explicit marker wins; failing
      // that, a small innermost date element counts. The row's full card text
      // never does -- that is how neighbouring content used to leak in.
      const rowDateTexts = [];
      for (const node of root.querySelectorAll(gameDateSelector)) {
        const text = clean(node.getAttribute('data-game-date') || node.textContent || '');
        if (text) rowDateTexts.push(...allDateTexts(text));
      }
      if (!rowDateTexts.length) {
        const candidates = [root, ...Array.from(root.querySelectorAll('*'))];
        for (const node of candidates) {
          if (!isInnermostRowDateEvidence(node, ROW_DATE_MAX_LEN)) continue;
          rowDateTexts.push(...allDateTexts(node.textContent || ''));
        }
      }

      // -- The governing date group, if any ------------------------------
      //
      // Every marked header that precedes this row, is not inside it, and whose
      // scope contains it, is a candidate. The LATEST such header wins: for
      // sibling date groups a header's scope is its own group, so it cannot
      // reach the next group at all; for flat headers and rows in one section
      // the next header simply ends the previous one's scope; and where scopes
      // nest, the innermost header is also the latest, so the most specific
      // claim wins. There is no global last-date-seen variable, so nothing
      // leaks between independent schedule sections.
      const rootPosition = positionOf(root);
      const rootComponent = nearestScheduleComponent(root);
      const candidates = [];
      for (const header of headers) {
        if (header.position < 0 || rootPosition < 0) continue;
        if (header.position >= rootPosition) continue;
        if (root.contains(header.element)) continue;
        if (!header.scope.contains(root)) continue;
        // Affirmative component relationship: when this row lives inside a
        // schedule component, only a header inside that SAME component may
        // govern it. A page-level header beside the component cannot reach in.
        if (rootComponent && header.component !== rootComponent) continue;
        // No component anywhere: the shared-ancestor test alone is too weak, so
        // require one of the two affirmative local shapes documented above.
        if (!rootComponent && !hasAffirmativeLocalRelationship(header.element, root)) continue;
        candidates.push(header);
      }
      candidates.sort((a, b) => a.position - b.position);
      const governing = candidates.length ? candidates[candidates.length - 1] : null;

      // -- Competing headers -------------------------------------------
      //
      // Two marked headers standing back to back immediately before this row,
      // with no game between them to end the first one's run, both credibly
      // claim it. Preferring the later one would be a guess, so every header in
      // that run is reported and the pure resolver turns more than one distinct
      // date into 'ambiguous'. A run whose headers name the SAME date stays a
      // single resolved date -- that is confirmation, not competition.
      //
      // `previousAnchorPosition` bounds the run: once a game has intervened, an
      // earlier header is governing history rather than a rival claim, which is
      // what keeps every later row in a date group resolving to that group's one
      // header.
      //
      // Nesting is NOT competition. A header inside a date group and a header on
      // the month that contains it both reach this row, but the inner one is the
      // more specific claim about this game and the outer one is context, so
      // only the innermost scope's headers compete. Without this a schedule that
      // labels both its month and its days would resolve every row to
      // 'ambiguous' and publish nothing -- safe, but wrong about a shape that is
      // perfectly well formed.
      const contiguous = candidates.filter((header) => header.position > previousAnchorPosition(rootPosition));
      const innermost = contiguous.filter((header) => !contiguous.some((other) => other !== header
        && other.scope !== header.scope && header.scope.contains(other.scope)));
      const competing = innermost.length > 1 ? innermost
        : (innermost.length === 1 ? innermost : (governing ? [governing] : []));

      const within = (selector, attr) => Array.from(root.querySelectorAll(selector))
        .map((node) => clean((attr && node.getAttribute(attr)) || node.innerText || node.textContent))
        .find(Boolean) || '';

      // Prefer a dedicated score element. Falling back to "the first descendant
      // whose text matches" would capture the whole row once the row root is a
      // container rather than the anchor itself, so the fallback takes the
      // SHORTEST matching text -- the badge, not the row that contains it.
      const scoreCandidates = Array.from(root.querySelectorAll('*'))
        .map((node) => clean(node.innerText || node.textContent || ''))
        .filter((text) => /\b[WLT]\s*\d+\s*[-–—]\s*\d+\b/i.test(text) && text.length <= 40)
        .sort((a, b) => a.length - b.length);
      const scoreNode = within('[data-score], .score', 'data-score') || scoreCandidates[0] || '';

      return {
        index,
        anchorCount: rowAnchors.length,
        hrefs,
        cardText: cardText.length <= CARDTEXT_MAX_LEN ? cardText : cardText.slice(0, CARDTEXT_MAX_LEN),
        rowDateTexts,
        // Every credible claim on this row, not merely the winning one, so two
        // back-to-back headers naming different dates resolve to 'ambiguous'
        // instead of silently preferring whichever came last. The RAW text and
        // any structured value travel out together: the positive grammar that
        // decides whether this is a readable schedule header lives in Node.
        groupHeaders: competing.map((header) => ({ text: header.text, structured: header.structured })),
        groupHeaderText: competing.map((header) => header.text).join(' | '),
        scoreText: scoreNode || '',
        statusText: within('[data-status], .status, .game-status', 'data-status'),
        venueText: within('[data-venue], .venue, .location', 'data-venue'),
        gameNumberAttr: (root.getAttribute && root.getAttribute('data-game-number')) || '',
        gameNumberText: within('[data-game-number], .game-number', 'data-game-number'),
      };
    });
  }, {
    rowRootSelector: EXPLICIT_ROW_ROOT_SELECTOR,
    dateHeaderSelector: DATE_HEADER_SELECTOR,
    gameDateSelector: GAME_DATE_SELECTOR,
  });

  const entries = rawRows.map((rawRow) => {
    // The in-page reference normalizer already refuses to invent an identity for
    // an href the URL parser rejects. This absolute form must fail the same way
    // instead of throwing: an unguarded `new URL` here meant ONE malformed
    // anchor anywhere on the page aborted the entire extraction with an untyped
    // TypeError, discarding every valid row with it. A malformed reference now
    // yields no href and no game id -- so no fabricated identity, and no two
    // malformed rows collapsed together -- and is flagged so the collection
    // fails closed with a named reason rather than silently dropping a game.
    const rawHref = rawRow.hrefs.length ? rawRow.hrefs[0] : '';
    let href = '';
    let sourceReferenceMalformed = false;
    let sourceReferenceUntrustedOrigin = false;
    let untrustedSourceOrigin = '';
    if (rawHref) {
      try {
        const resolved = new URL(rawHref, page.url());
        // Same HTTP(S)-only rule as the in-page normalizer. A non-HTTP scheme is
        // not a malformed URL -- it parses perfectly well -- but it is not a
        // schedule location, so it must not produce a game id.
        if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
          href = '';
          sourceReferenceMalformed = true;
        } else if (!isAuthoritativeScheduleOrigin(resolved)) {
          // HTTP(S) but not OUR GameChanger origin. Authority is settled here,
          // BEFORE extractGameIdFromUrl strips the host, so a foreign anchor can
          // never donate a path-derived identity.
          href = '';
          sourceReferenceUntrustedOrigin = true;
          untrustedSourceOrigin = resolved.origin;
        } else {
          href = resolved.href;
        }
      } catch {
        href = '';
        sourceReferenceMalformed = true;
      }
    }

    // Authority is judged on EVERY anchor this row claims, not merely the first.
    // A row root is accepted when it describes one game, so a foreign anchor can
    // legitimately sit beside the trusted one inside a single row -- and reading
    // only hrefs[0] meant that when the trusted anchor came first the foreign one
    // was silently absorbed and never surfaced anywhere. Skipping it is exactly
    // the outcome this gate exists to prevent, so any untrusted anchor in the row
    // makes the whole row untrusted.
    for (const candidate of rawRow.hrefs) {
      if (sourceReferenceUntrustedOrigin) break;
      try {
        const resolved = new URL(candidate, page.url());
        if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
        if (isAuthoritativeScheduleOrigin(resolved)) continue;
        href = '';
        sourceReferenceUntrustedOrigin = true;
        untrustedSourceOrigin = resolved.origin;
      } catch {
        // Already accounted for by the malformed-reference gate above.
      }
    }
    const scoreParts = parseScoreText(rawRow.scoreText || rawRow.cardText || '');
    const rawStatusText = normalizeScheduleEntryText(`${rawRow.statusText} ${rawRow.cardText}`);
    const status = classifyScheduleEntryStatus({ rawStatusText, scoreText: rawRow.scoreText });
    const timing = parseScheduledTimeText(rawRow.cardText);
    // The row's card text is deliberately NOT a date source. Folding it in is
    // what let a merged or neighbouring row's text supply a date; the date now
    // comes only from the row's own date evidence or its governing date group.
    const date = resolveScheduleEntryDate(rawRow);

    return {
      // Provenance only. Row order never enters canonical identity, and every
      // hash the publication path computes excludes it.
      visibleIndex: rawRow.index,
      rowAnchorCount: rawRow.anchorCount,
      status,
      rawStatusText,
      scoreText: normalizeScheduleEntryText(rawRow.scoreText),
      cardText: normalizeScheduleEntryText(rawRow.cardText),
      dateText: date.rawDateText,
      rawDateText: date.rawDateText,
      gameDate: date.gameDate,
      dateResolutionStatus: date.dateResolutionStatus,
      dateSourceKind: date.dateSourceKind,
      dateConflict: date.dateConflict,
      result: scoreParts.result,
      scoreUs: scoreParts.scoreUs,
      scoreThem: scoreParts.scoreThem,
      counterpartyName: parseCounterpartyName(rawRow.cardText),
      homeAway: parseHomeAway(rawRow.cardText),
      venue: normalizeScheduleEntryText(rawRow.venueText) || null,
      gameNumber: rawRow.gameNumberAttr
        ? Number(rawRow.gameNumberAttr)
        : (parseGameNumber(rawRow.gameNumberText) ?? parseGameNumber(rawRow.cardText)),
      scheduledTimeText: timing.scheduledTimeText,
      timezone: timing.timezone,
      timezoneKnown: timing.timezoneKnown,
      href,
      gameId: href ? extractGameIdFromUrl(href) : '',
      // Provenance for a reference the URL parser rejected. The row is kept so
      // it can never be silently lost, and the collector refuses to publish the
      // collection while any row carries one.
      sourceReferenceMalformed,
      rawSourceReference: sourceReferenceMalformed ? rawHref : '',
      // Provenance for a reference whose ORIGIN is not authoritative. Only the
      // normalized origin travels: a path, query or fragment on a foreign URL is
      // attacker-chosen content, and echoing it into a diagnostic or a log line
      // would carry whatever it happens to contain. The origin is the whole
      // reason the row was refused and is all a reviewer needs.
      sourceReferenceUntrustedOrigin,
      untrustedSourceOrigin: sourceReferenceUntrustedOrigin ? untrustedSourceOrigin : '',
      identityCollision: false,
      collidingRowIndexes: [],
    };
  });

  // Two DISTINCT rows claiming one stable upstream identifier are surfaced as a
  // collision rather than resolved here. Deciding which row is the real game --
  // or whether there are two -- is reconciliation's job, and it needs both rows
  // plus the provenance explaining which ones collided. Sorting the indexes
  // keeps the marking identical when the source renders the rows in the
  // opposite DOM order.
  const rowsByGameId = new Map();
  for (const entry of entries) {
    if (!entry.gameId) continue;
    if (!rowsByGameId.has(entry.gameId)) rowsByGameId.set(entry.gameId, []);
    rowsByGameId.get(entry.gameId).push(entry);
  }
  for (const colliding of rowsByGameId.values()) {
    if (colliding.length < 2) continue;
    const indexes = colliding.map((entry) => entry.visibleIndex).sort((a, b) => a - b);
    for (const entry of colliding) {
      entry.identityCollision = true;
      entry.collidingRowIndexes = indexes;
    }
  }

  return entries;
}

function buildResumeOrderedScheduleIndexes(completedGameCount) {
  const newestFirst = process.env.GC_SCHEDULE_NEWEST_FIRST !== 'false';
  const indexes = [];
  if (newestFirst) {
    for (let i = completedGameCount - 1; i >= 0; i--) indexes.push(i);
  } else {
    for (let i = 0; i < completedGameCount; i++) indexes.push(i);
  }
  return indexes;
}

async function clickCompletedGameFromScheduleByIndex(page, targetIndex) {
  console.log("");
  console.log(`Looking for completed game #${targetIndex + 1} with W/L and score...`);
  await dismissDontMissOutPopup(page);

  const completedGameRegex = /\b[WL]\s*\d+\s*[-–—]\s*\d+\b/i;
  const scoreLocator = page.getByText(completedGameRegex);
  const count = await scoreLocator.count();
  let visibleIndex = 0;

  for (let i = 0; i < count; i++) {
    const item = scoreLocator.nth(i);
    try {
      const box = await item.boundingBox();
      if (!box || box.width <= 0 || box.height <= 0) continue;

      const scoreText = await item.innerText().catch(() => "");
      if (visibleIndex !== targetIndex) { visibleIndex++; continue; }

      const scheduleMetaRaw = await item.evaluate((element) => {
        function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
        function looksLikeDate(value) {
          return /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\.?[,]?\s*(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t)?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:,?\s+(?:20\d{2}|19\d{2}))?\b/i.test(value) ||
            /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(value);
        }

        const scoreText = clean(element.innerText || element.textContent || '');
        let node = element;
        let href = '';
        let cardText = scoreText;
        let clickableFound = false;
        // rowContainer is the smallest ancestor that is actually clickable/linked
        // to this specific game. Date search MUST be scoped to this element (plus
        // its immediate previous sibling, to catch a date-group header that
        // precedes a row rather than wrapping it) — never to the whole document.
        // Searching the whole page previously caused every game on a schedule to
        // resolve to the same date whenever a single date-like element (e.g. a
        // group header several games away) happened to score as "closest."
        let rowContainer = element;

        // CARDTEXT_MAX_LEN caps how much text we're willing to fold into a single
        // row's "cardText". Multi-game schedule lists routinely nest a single
        // game's score inside large shared containers (virtualized list rows,
        // date-grouped sections); without a tight cap, cardText silently absorbs
        // neighboring games/date headers and date-parsing then locks onto
        // whichever date happens to appear first in that merged blob for every
        // row, collapsing the whole team's schedule onto one date.
        const CARDTEXT_MAX_LEN = 260;

        for (let depth = 0; depth < 12 && node; depth++) {
          const text = clean(node.innerText || node.textContent || '');
          if (text && text.length >= cardText.length && text.length <= CARDTEXT_MAX_LEN) {
            cardText = text;
            rowContainer = node;
          }

          if (node.href) { href = node.href; clickableFound = true; rowContainer = node; break; }
          if (node.getAttribute) {
            href = node.getAttribute('href') || node.getAttribute('data-href') || '';
            if (href) { clickableFound = true; rowContainer = node; break; }
          }
          const anchor = node.querySelector && node.querySelector('a[href*="/schedule/"]');
          if (anchor && anchor.href) { href = anchor.href; clickableFound = true; rowContainer = node; break; }
          node = node.parentElement;
        }

        // Scope the date search to this row's own subtree, plus its immediate
        // previous sibling (common pattern: "Sat, Jul 2" header sits as a sibling
        // just above a block of that day's games) — not the entire document.
        const searchRoots = [rowContainer];
        if (rowContainer.previousElementSibling) searchRoots.push(rowContainer.previousElementSibling);
        const parentPrev = rowContainer.parentElement && rowContainer.parentElement.previousElementSibling;
        if (parentPrev) searchRoots.push(parentPrev);

        const scoreRect = element.getBoundingClientRect();
        const dateCandidates = [];
        const seenNodes = new Set();
        for (const root of searchRoots) {
          const nodes = [root, ...Array.from(root.querySelectorAll('*'))];
          for (const candidate of nodes) {
            if (seenNodes.has(candidate)) continue;
            seenNodes.add(candidate);
            const text = clean(candidate.innerText || candidate.textContent || '');
            if (!text || text.length > 300 || !looksLikeDate(text)) continue;
            const rect = candidate.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            const distance = Math.abs(rect.top - scoreRect.top);
            const abovePenalty = rect.top <= scoreRect.top + 20 ? 0 : 10000;
            dateCandidates.push({ text, distance: distance + abovePenalty, top: rect.top });
          }
        }
        dateCandidates.sort((a, b) => a.distance - b.distance || b.top - a.top);

        return {
          scoreText,
          cardText,
          dateText: dateCandidates[0]?.text || '',
          href,
          clickableFound,
        };
      });

      const scheduleMeta = {
        visibleIndex: targetIndex,
        scoreText: scheduleMetaRaw.scoreText || scoreText || '',
        cardText: scheduleMetaRaw.cardText || '',
        dateText: scheduleMetaRaw.dateText || '',
        gameDate: normalizeScheduleDateText(`${scheduleMetaRaw.cardText || ''} ${scheduleMetaRaw.dateText || ''}`),
        ...parseScoreText(`${scheduleMetaRaw.scoreText || ''} ${scheduleMetaRaw.cardText || ''}`),
      };

      if (scheduleMetaRaw.href) {
        try {
          scheduleMeta.href = new URL(scheduleMetaRaw.href, page.url()).href;
          scheduleMeta.gameId = extractGameIdFromUrl(scheduleMeta.href);
        } catch {
          scheduleMeta.href = scheduleMetaRaw.href;
          scheduleMeta.gameId = extractGameIdFromUrl(scheduleMetaRaw.href);
        }
      }

      console.log(`Found completed game #${targetIndex + 1}: ${scheduleMeta.scoreText || scoreText}`);
      if (scheduleMeta.gameDate) {
        console.log(`[psg] Schedule date captured for game #${targetIndex + 1}: ${scheduleMeta.gameDate}`);
      } else {
        console.warn(`[psg] Could not capture schedule date for game #${targetIndex + 1}. Card text: ${scheduleMeta.cardText || '(none)'}`);
      }

      try {
        await item.click();
      } catch {
        console.log("Direct click on score failed. Trying clickable parent...");
        await item.evaluate((element) => {
          let node = element;
          for (let depth = 0; depth < 10 && node; depth++) {
            const tagName = String(node.tagName || "").toLowerCase();
            const role = node.getAttribute && node.getAttribute("role");
            if (tagName === "a" || tagName === "button" || role === "button" || role === "link" || typeof node.onclick === "function") {
              node.click();
              return;
            }
            node = node.parentElement;
          }
          element.click();
        });
      }

      try {
        await page.waitForLoadState("networkidle", { timeout: 15000 });
      } catch {
        // Not fatal.
      }

      await page.waitForTimeout(3000);
      await dismissDontMissOutPopup(page);
      scheduleMeta.openedUrl = page.url();
      scheduleMeta.openedGameId = extractGameIdFromUrl(page.url());
      page.__jobuCurrentGameScheduleMeta = scheduleMeta;
      console.log(`Opened completed game page: ${page.url()}`);
      return scheduleMeta;
    } catch {
      // Try next item.
    }
  }

  console.log(`No completed game found at index ${targetIndex}.`);
  return null;
}

// ─── Page / DOM Helpers (kept for screenshot fallback) ────────────────────────

async function getGameFileBase(page) {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const dateMatch = bodyText.match(
    /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Z][a-z]+\s+\d{1,2},\s+\d{1,2}:\d{2}\s+[AP]M\s*[-–—]\s*\d{1,2}:\d{2}\s+[AP]M\s+[A-Z]{2}\b/i
  );
  const dateTimeRaw = dateMatch ? dateMatch[0] : "unknown-date-time";
  const lines = bodyText.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const teamCandidates = [];

  for (const line of lines) {
    if (!/\b\d{1,2}U\b/i.test(line)) continue;
    if (/back to|box score|plays|videos|info|recap|schedule|lineup|team\b/i.test(line)) continue;
    if (/^\d+$/.test(line)) continue;
    const cleaned = line
      .replace(/\bFINAL\b/gi, "")
      .replace(/\bW\s*\d+\s*[-–—]\s*\d+\b/gi, "")
      .replace(/\bL\s*\d+\s*[-–—]\s*\d+\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned && !teamCandidates.includes(cleaned)) teamCandidates.push(cleaned);
  }

  const teamOne = teamCandidates[0] || "Team-One";
  const teamTwo = teamCandidates[1] || "Team-Two";
  return sanitizeFileNameCompact(`${teamOne}-vs-${teamTwo}-${dateTimeRaw}`);
}

async function hideStickyElements(page) {
  await page.evaluate(() => {
    if (document.getElementById("playwright-hide-sticky-elements")) return;
    const style = document.createElement("style");
    style.id = "playwright-hide-sticky-elements";
    style.textContent = `[style*="position: sticky"],[style*="position: fixed"],.sticky,.fixed{position:static!important;}`;
    document.head.appendChild(style);
  });
}

async function restoreStickyElements(page) {
  await page.evaluate(() => {
    const style = document.getElementById("playwright-hide-sticky-elements");
    if (style) style.remove();
  });
}

async function hideFooterElements(page) {
  await page.evaluate(() => {
    if (document.getElementById("playwright-hide-footer-elements")) return;
    const style = document.createElement("style");
    style.id = "playwright-hide-footer-elements";
    style.textContent = `footer,[class*="footer" i],[data-testid*="footer" i]{display:none!important;visibility:hidden!important;height:0!important;min-height:0!important;max-height:0!important;overflow:hidden!important;}`;
    document.head.appendChild(style);
    const phrases = ["Get the App","GameChanger is a proud member","DICK'S Sporting Goods Family","© GameChanger Media","Status","Privacy","Terms","CA Disclosures","Your Privacy Choices"];
    for (const element of document.querySelectorAll("body *")) {
      const text = String(element.innerText || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (!phrases.some((phrase) => text.includes(phrase))) continue;
      const rect = element.getBoundingClientRect();
      if (rect.top > window.innerHeight * 0.4 || text.includes("GameChanger is a proud member")) {
        element.setAttribute("data-playwright-footer-hidden", "true");
        element.style.display = "none";
        element.style.visibility = "hidden";
        element.style.height = "0";
        element.style.overflow = "hidden";
      }
    }
  });
}

async function restoreFooterElements(page) {
  await page.evaluate(() => {
    const style = document.getElementById("playwright-hide-footer-elements");
    if (style) style.remove();
    for (const element of document.querySelectorAll('[data-playwright-footer-hidden="true"]')) {
      element.removeAttribute("data-playwright-footer-hidden");
      element.style.display = "";
      element.style.visibility = "";
      element.style.height = "";
      element.style.overflow = "";
    }
  });
}

async function getBestScrollableElementHandle(page) {
  return await page.evaluateHandle(() => {
    function isScrollable(element) {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const overflowY = style.overflowY;
      return (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
        element.scrollHeight > element.clientHeight + 50;
    }
    const scrollableElements = Array.from(document.querySelectorAll("*"))
      .filter(isScrollable)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { element, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollableAmount: element.scrollHeight - element.clientHeight, rectWidth: rect.width, rectHeight: rect.height, textLength: (element.innerText || "").length };
      })
      .filter((item) => item.rectWidth > 500 && item.rectHeight > 300)
      .sort((a, b) => b.scrollableAmount !== a.scrollableAmount ? b.scrollableAmount - a.scrollableAmount : b.textLength - a.textLength);
    return scrollableElements.length > 0 ? scrollableElements[0].element : document.scrollingElement || document.documentElement || document.body;
  });
}

async function estimateRepeatedHeaderCropTop(page) {
  const cropTop = await page.evaluate(() => {
    function cleanText(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
    const tabBarCandidates = Array.from(document.querySelectorAll("*"))
      .map((element) => {
        const text = cleanText(element.innerText);
        const rect = element.getBoundingClientRect();
        return { text, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      })
      .filter((item) => {
        if (item.width < 500 || item.height < 20 || item.height > 120 || item.top < 0 || item.top > 600) return false;
        const text = item.text.toUpperCase();
        return text.includes("RECAP") && text.includes("BOX SCORE") && text.includes("PLAYS") && text.includes("VIDEOS") && text.includes("INFO");
      })
      .sort((a, b) => b.bottom - a.bottom);
    return tabBarCandidates.length > 0 ? Math.ceil(tabBarCandidates[0].bottom + 8) : 410;
  });
  console.log(`Estimated repeated header crop top: ${cropTop}px`);
  return cropTop;
}

async function resetAllScrollPositions(page) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const scrollingElement = document.scrollingElement || document.documentElement || document.body;
    if (scrollingElement) scrollingElement.scrollTop = 0;
    for (const element of document.querySelectorAll("*")) {
      try { if (element.scrollTop && element.scrollTop > 0) element.scrollTop = 0; } catch {}
    }
  });
}

async function expandScrollableElementsForScreenshot(page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll("*")) {
      const rect = element.getBoundingClientRect();
      if (element.scrollHeight <= element.clientHeight + 20 || rect.width < 500 || rect.height < 100) continue;
      element.setAttribute("data-playwright-expanded-scroll", "true");
      element.setAttribute("data-playwright-original-style", element.getAttribute("style") || "");
      element.style.overflow = "visible";
      element.style.overflowY = "visible";
      element.style.maxHeight = "none";
      element.style.height = `${element.scrollHeight}px`;
    }
    for (const element of [document.documentElement, document.body]) {
      if (!element) continue;
      element.setAttribute("data-playwright-expanded-root", "true");
      element.setAttribute("data-playwright-original-style", element.getAttribute("style") || "");
      element.style.overflow = "visible";
      element.style.overflowY = "visible";
      element.style.maxHeight = "none";
      element.style.height = "auto";
    }
  });
}

async function restoreExpandedScrollableElements(page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('[data-playwright-expanded-scroll="true"],[data-playwright-expanded-root="true"]')) {
      const originalStyle = element.getAttribute("data-playwright-original-style") || "";
      if (originalStyle) element.setAttribute("style", originalStyle); else element.removeAttribute("style");
      element.removeAttribute("data-playwright-expanded-scroll");
      element.removeAttribute("data-playwright-expanded-root");
      element.removeAttribute("data-playwright-original-style");
    }
  });
}

async function captureExpandedFullPageScreenshot(page, screenshotPath, description) {
  await dismissDontMissOutPopup(page);
  await page.waitForTimeout(750);
  const finalScreenshotPath = uniqueFilePath(screenshotPath);
  console.log("");
  console.log("BOX SCORE CAPTURE MODE: expanded fullPage screenshot");
  console.log(`Capturing: ${description}`);
  console.log(`Destination: ${finalScreenshotPath}`);
  ensureDirectory(path.dirname(finalScreenshotPath));
  await resetAllScrollPositions(page);
  await page.waitForTimeout(750);
  await hideFooterElements(page);
  try {
    await expandScrollableElementsForScreenshot(page);
    await page.waitForTimeout(750);
    await resetAllScrollPositions(page);
    await page.waitForTimeout(500);
    await page.screenshot({ path: finalScreenshotPath, fullPage: true });
    console.log(`Expanded full-page screenshot saved: ${finalScreenshotPath}`);
    return finalScreenshotPath;
  } finally {
    await restoreExpandedScrollableElements(page).catch(() => {});
    await restoreFooterElements(page);
    await resetAllScrollPositions(page);
  }
}

// ─── Structured Data Extraction (Phase 1 — replaces OCR) ─────────────────────

async function extractTableData(page, tableLocator) {
  return await tableLocator.evaluate((table) => {
    const rows = Array.from(table.querySelectorAll("tr"));
    const headers = [];
    const data = [];

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("th, td"));
      const values = cells.map((cell) => String(cell.innerText || "").replace(/\s+/g, " ").trim());
      if (row.querySelector("th")) {
        headers.push(...values);
      } else if (values.some((v) => v)) {
        const obj = {};
        values.forEach((val, i) => { obj[headers[i] || `col${i}`] = val; });
        data.push(obj);
      }
    }

    return { headers, data };
  });
}

function parseGameDateFromHeaderDateTime(value) {
  return normalizeScheduleDateText(value);
}

async function extractGameHeader(page) {
  return await page.evaluate(() => {
    const bodyText = document.body.innerText;

    const dateMatch = bodyText.match(
      /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Z][a-z]+\s+\d{1,2},\s+\d{1,2}:\d{2}\s+[AP]M\s*[-–—]\s*\d{1,2}:\d{2}\s+[AP]M\s+[A-Z]{2}\b/i
    );

    const scoreMatch = bodyText.match(/\b([WL])\s*(\d+)\s*[-–—]\s*(\d+)\b/i);

    const teamCandidates = [];
    for (const el of document.querySelectorAll('h1, h2, h3, [class*="team"], [class*="Team"]')) {
      const text = String(el.innerText || "").replace(/\s+/g, " ").trim();
      if (text && text.length < 200) teamCandidates.push(text);
    }

    const dateTime = dateMatch ? dateMatch[0] : null;

    return {
      dateTime,
      gameDatetimeRaw: dateTime,
      result:         scoreMatch ? scoreMatch[1] : null,
      scoreUs:        scoreMatch ? scoreMatch[2] : null,
      scoreThem:      scoreMatch ? scoreMatch[3] : null,
      teamCandidates,
      pageUrl:        window.location.href
    };
  });
}


async function extractGameDateFromCurrentPage(page, label = 'current page') {
  try {
    const candidates = await page.evaluate(() => {
      function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
      function looksLikeDate(value) {
        return /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\.?[,]?\s*(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t)?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:,?\s+(?:20\d{2}|19\d{2}))?\b/i.test(value) ||
          /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(value);
      }
      function scoreText(value) {
        const text = clean(value);
        let score = 0;
        if (!looksLikeDate(text)) return -999;
        if (/\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/i.test(text)) score += 40;
        if (/\b(?:FINAL|Box Score|Recap|Plays|Videos|Info)\b/i.test(text)) score += 10;
        if (/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)/i.test(text)) score += 30;
        if (/\b20\d{2}\b/.test(text)) score += 10;
        if (text.length <= 120) score += 20;
        if (text.length > 260) score -= 35;
        return score;
      }

      const rows = [];
      for (const el of document.querySelectorAll('body *')) {
        const text = clean(el.innerText || el.textContent || '');
        if (!text || text.length > 500 || !looksLikeDate(text)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (rect.top < -20 || rect.top > 900) continue;
        const score = scoreText(text) - Math.max(0, rect.top / 100);
        rows.push({ text, top: rect.top, score });
      }
      rows.sort((a, b) => b.score - a.score || a.top - b.top || a.text.length - b.text.length);
      return rows.slice(0, 10);
    });

    for (const candidate of candidates || []) {
      const normalized = normalizeScheduleDateText(candidate.text);
      if (normalized) {
        console.log(`[psg] Date candidate from ${label}: ${normalized} | ${candidate.text}`);
        return { gameDate: normalized, dateText: candidate.text };
      }
    }

    console.warn(`[psg] No usable date found on ${label}.`);
    return { gameDate: null, dateText: '' };
  } catch (error) {
    console.warn(`[psg] Could not extract date from ${label}: ${error.message}`);
    return { gameDate: null, dateText: '' };
  }
}

async function extractBoxScore(page) {
  console.log("Extracting box score (AG Grid)...");

  // Navigate directly to /box-score URL
  const currentUrl = page.url();
  const boxScoreUrl = currentUrl
    .replace(/\/recap\/?$/, "/box-score")
    .replace(/\/plays\/?$/, "/box-score")
    .replace(/\/videos\/?$/, "/box-score")
    .replace(/\/info\/?$/, "/box-score")
    .replace(/\/lineup\/?$/, "/box-score");

  if (boxScoreUrl !== currentUrl) {
    console.log(`Navigating to box-score URL: ${boxScoreUrl}`);
    await page.goto(boxScoreUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2500);
    await dismissDontMissOutPopup(page);
  } else {
    await clickTabByName(page, "Box Score");
    await page.waitForTimeout(2000);
  }

  // GC uses AG Grid — extract via role="gridcell" col-id attributes
  // Each team's grids are inside BoxScore__awayLineup / BoxScore__homeLineup containers
  // which lets us tag every row with the correct team side.
  const agGridData = await page.evaluate(() => {

    function extractAgGrid(gridEl, teamName, teamSide) {
      const dataRows = Array.from(
        gridEl.querySelectorAll(".ag-center-cols-container [role=\"row\"]")
      );

      return dataRows.map(row => {
        const obj = {};
        const nameEl   = row.querySelector(".BoxScoreComponents__playerName");
        const infoEl   = row.querySelector(".BoxScoreComponents__playerInfo");
        obj.Player     = nameEl ? nameEl.innerText.trim() : "";
        obj.PlayerInfo = infoEl ? infoEl.innerText.trim() : "";
        obj.TeamName   = teamName;   // "Coastal Prospects 14U" or "Birmingham Stars 14U"
        obj.TeamSide   = teamSide;   // "away" or "home"

        // Extract position e.g. "#5 (SS, P)" → "SS, P"
        const posMatch = obj.PlayerInfo.match(/\(([^)]+)\)/);
        obj.Pos = posMatch ? posMatch[1] : "";

        // Extract jersey number
        const numMatch = obj.PlayerInfo.match(/#(\d+)/);
        obj.Jersey = numMatch ? numMatch[1] : "";

        // Stat cells by col-id attribute
        const cells = Array.from(row.querySelectorAll("[role=\"gridcell\"]"));
        for (const cell of cells) {
          const colId = cell.getAttribute("col-id");
          if (colId && colId !== "player") {
            obj[colId] = cell.innerText.trim();
          }
        }
        return obj;
      }).filter(row => row.Player && row.Player !== "TEAM");
    }

    function extractExtraStats(containerEl) {
      const stats = {};
      if (!containerEl) return stats;
      for (const el of containerEl.querySelectorAll(".BoxScoreComponents__boxScoreExtraStats > div")) {
        const labelEl  = el.querySelector(".Text__semibold");
        const valueEls = el.querySelectorAll(".BoxScoreComponents__extraPlayerStat");
        if (labelEl) {
          const key = labelEl.innerText.replace(/:\s*$/, "").trim();
          stats[key] = Array.from(valueEls).map(v => v.innerText.trim());
        }
      }
      return stats;
    }

    function normalizeStatKey(value) {
      return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    function toInt(value) {
      const match = String(value || '').replace(/,/g, '').match(/-?\d+/);
      return match ? Number(match[0]) : null;
    }

    function playerNameMatches(entryText, playerName) {
      const entry = String(entryText || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const player = String(playerName || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!entry || !player) return false;
      if (entry.includes(player)) return true;
      const parts = player.split(' ').filter(Boolean);
      if (parts.length >= 2) return entry.includes(parts[0]) && entry.includes(parts[parts.length - 1]);
      return false;
    }

    function applyPitchingAliases(row) {
      const keyMap = {};
      for (const [key, value] of Object.entries(row || {})) keyMap[normalizeStatKey(key)] = value;

      const pitchCountKeys = ['pc', 'p', 'pitches', 'pitchcount', 'pit', 'np'];
      for (const key of pitchCountKeys) {
        const value = keyMap[normalizeStatKey(key)];
        const parsed = toInt(value);
        if (parsed !== null) {
          row.PC = parsed;
          row.pc = parsed;
          row.P = parsed;
          row.Pitches = parsed;
          break;
        }
      }

      const strikeKeys = ['s', 'strikes', 'strike'];
      for (const key of strikeKeys) {
        const value = keyMap[normalizeStatKey(key)];
        const parsed = toInt(value);
        if (parsed !== null) {
          row.Strikes = parsed;
          row.strikes = parsed;
          row.S = parsed;
          break;
        }
      }

      for (const [key, value] of Object.entries(row || {})) {
        const text = String(value || '').trim();
        const ps = text.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
        if (ps && /p|pitch|strike|ps/i.test(key)) {
          row['P-S'] = text;
          row.PitchesStrikes = text;
          row.PC = Number(ps[1]);
          row.pc = Number(ps[1]);
          row.P = Number(ps[1]);
          row.Pitches = Number(ps[1]);
          row.Strikes = Number(ps[2]);
          row.strikes = Number(ps[2]);
          row.S = Number(ps[2]);
          break;
        }
      }

      return row;
    }

    function mergePitchingExtraIntoRows(rows, extraStats) {
      const pitchingRows = Array.isArray(rows) ? rows : [];
      const extras = extraStats || {};

      for (const row of pitchingRows) applyPitchingAliases(row);

      for (const [label, values] of Object.entries(extras)) {
        const normalizedLabel = normalizeStatKey(label);
        const list = Array.isArray(values) ? values : [];
        const isPitchStrike = /pitch.*strike|pitchesstrikes|ps/.test(normalizedLabel);
        const isPitchOnly = /^(p|pc|pitches|pitchcount|pit)$/.test(normalizedLabel);
        const isStrikeOnly = /^(s|strikes)$/.test(normalizedLabel);

        for (let index = 0; index < pitchingRows.length; index++) {
          const row = pitchingRows[index];
          let entry = list.find(v => playerNameMatches(v, row.Player));
          if (!entry && list.length === pitchingRows.length) entry = list[index];
          if (!entry) continue;

          row[`Extra_${label}`] = entry;

          if (isPitchStrike) {
            const ps = String(entry).match(/(\d+)\s*[-–—]\s*(\d+)/);
            if (ps) {
              row['P-S'] = `${ps[1]}-${ps[2]}`;
              row.PitchesStrikes = `${ps[1]}-${ps[2]}`;
              row.PC = Number(ps[1]);
              row.pc = Number(ps[1]);
              row.P = Number(ps[1]);
              row.Pitches = Number(ps[1]);
              row.Strikes = Number(ps[2]);
              row.strikes = Number(ps[2]);
              row.S = Number(ps[2]);
            }
          } else if (isPitchOnly) {
            const pc = toInt(entry);
            if (pc !== null) {
              row.PC = pc;
              row.pc = pc;
              row.P = pc;
              row.Pitches = pc;
            }
          } else if (isStrikeOnly) {
            const strikes = toInt(entry);
            if (strikes !== null) {
              row.Strikes = strikes;
              row.strikes = strikes;
              row.S = strikes;
            }
          }
        }
      }

      return pitchingRows;
    }

    // GC DOM layout (confirmed from live inspection):
    //   .BoxScore__awayTeamName   → away team label
    //   .BoxScore__awayLineup     → contains away batting AG Grid
    //   .BoxScore__awayLineupExtra → 2B, 3B, HBP, SB extra stats for away batters
    //   .BoxScore__awayPitching   → contains away pitching AG Grid
    //   .BoxScore__awayPitchingExtra → WP, HBP, Pitches-Strikes etc for away pitchers
    //   .BoxScore__homeTeamName   → home team label
    //   .BoxScore__homeLineup     → contains home batting AG Grid
    //   .BoxScore__homeLineupExtra
    //   .BoxScore__homePitching   → contains home pitching AG Grid
    //   .BoxScore__homePitchingExtra

    const result = {
      away: { teamName: "", batting: [], pitching: [], battingExtra: {}, pitchingExtra: {} },
      home: { teamName: "", batting: [], pitching: [], battingExtra: {}, pitchingExtra: {} },
    };

    // Away team
    const awayNameEl = document.querySelector(".BoxScore__awayTeamName");
    result.away.teamName = awayNameEl ? awayNameEl.innerText.trim() : "";

    const awayLineup = document.querySelector(".BoxScore__awayLineup");
    if (awayLineup) {
      const grid = awayLineup.querySelector(".ag-root-wrapper");
      if (grid) result.away.batting = extractAgGrid(grid, result.away.teamName, "away");
    }

    const awayLineupExtra = document.querySelector(".BoxScore__awayLineupExtra");
    result.away.battingExtra = extractExtraStats(awayLineupExtra);

    const awayPitching = document.querySelector(".BoxScore__awayPitching");
    if (awayPitching) {
      const grid = awayPitching.querySelector(".ag-root-wrapper");
      if (grid) result.away.pitching = extractAgGrid(grid, result.away.teamName, "away");
    }

    const awayPitchingExtra = document.querySelector(".BoxScore__awayPitchingExtra");
    result.away.pitchingExtra = extractExtraStats(awayPitchingExtra);

    // Home team
    const homeNameEl = document.querySelector(".BoxScore__homeTeamName");
    result.home.teamName = homeNameEl ? homeNameEl.innerText.trim() : "";

    const homeLineup = document.querySelector(".BoxScore__homeLineup");
    if (homeLineup) {
      const grid = homeLineup.querySelector(".ag-root-wrapper");
      if (grid) result.home.batting = extractAgGrid(grid, result.home.teamName, "home");
    }

    const homeLineupExtra = document.querySelector(".BoxScore__homeLineupExtra");
    result.home.battingExtra = extractExtraStats(homeLineupExtra);

    const homePitching = document.querySelector(".BoxScore__homePitching");
    if (homePitching) {
      const grid = homePitching.querySelector(".ag-root-wrapper");
      if (grid) result.home.pitching = extractAgGrid(grid, result.home.teamName, "home");
    }

    const homePitchingExtra = document.querySelector(".BoxScore__homePitchingExtra");
    result.home.pitchingExtra = extractExtraStats(homePitchingExtra);

    result.away.pitching = mergePitchingExtraIntoRows(result.away.pitching, result.away.pitchingExtra);
    result.home.pitching = mergePitchingExtraIntoRows(result.home.pitching, result.home.pitchingExtra);

    return result;
  });

  // Flatten into batting/pitching arrays — each row tagged with TeamName + TeamSide
  const awayBatting  = agGridData.away.batting  || [];
  const homeBatting  = agGridData.home.batting  || [];
  const awayPitching = agGridData.away.pitching || [];
  const homePitching = agGridData.home.pitching || [];

  const result = {
    awayTeam:   agGridData.away.teamName || "",
    homeTeam:   agGridData.home.teamName || "",
    batting:    [...awayBatting, ...homeBatting],
    pitching:   [...awayPitching, ...homePitching],
    // Separate by side for downstream use
    awayBatting,
    homeBatting,
    awayPitching,
    homePitching,
    awayBattingExtra:  agGridData.away.battingExtra  || {},
    awayPitchingExtra: agGridData.away.pitchingExtra || {},
    homeBattingExtra:  agGridData.home.battingExtra  || {},
    homePitchingExtra: agGridData.home.pitchingExtra || {},
    raw:    {},
    source: (awayBatting.length + homeBatting.length) > 0 ? "ag_grid" : "plays"
  };

  console.log(`  AG Grid: away=${awayBatting.length} batters/${awayPitching.length} pitchers | home=${homeBatting.length} batters/${homePitching.length} pitchers`);
  console.log(`  Away: ${result.awayTeam} | Home: ${result.homeTeam}`);

  if (!result.batting.length && !result.pitching.length) {
    console.log("  AG Grid empty — stats will be reconstructed from play-by-play.");
    result.source = "plays";
  }

  return result;
}

async function extractListBasedStats(page) {
  return await page.evaluate(() => {
    const rows = [];
    for (const el of document.querySelectorAll('[class*="row"],[class*="player"],[class*="stat"],li')) {
      const text = String(el.innerText || "").replace(/\s+/g, " ").trim();
      if (text && /\d/.test(text) && text.length < 300) rows.push(text);
    }
    return rows;
  });
}

async function autoScrollToLoadAll(page, maxScrolls = 30) {
  const scrollHandle = await getBestScrollableElementHandle(page);
  for (let i = 0; i < maxScrolls; i++) {
    const prevHeight = await scrollHandle.evaluate((el) => el.scrollHeight);
    await scrollHandle.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(800);
    const newHeight = await scrollHandle.evaluate((el) => el.scrollHeight);
    if (newHeight === prevHeight) break;
  }
  await scrollHandle.evaluate((el) => { el.scrollTop = 0; });
}

// Runs a single extraction pass against whatever play elements are
// CURRENTLY attached to the DOM. Used repeatedly, once per scroll step, by
// extractAllPlaysByIncrementalScroll() below.
//
// This targets GameChanger's REAL markup, confirmed directly from a saved
// copy of a rendered Plays page (not guessed from generic class-name
// patterns like the previous version of this function):
//
//   .BatsPlays__inning              — a half-inning header ("Top 1", "Bot 3", ...)
//   .BatsPlays__play                — one full plate appearance (exact class
//                                      token — NOT matched by [class*="play"],
//                                      which also falsely matches
//                                      .BatsPlays__playName and
//                                      .BatsPlays__playBorderBottom as if
//                                      they were separate "plays")
//   .BatsPlays__playName            — the short result badge inside a play
//                                      ("Single", "Double Play", "Hit By Pitch", ...)
//   [data-testid="at-plate-detail"] — one narrative sentence fragment inside
//                                      a play. There can be SEVERAL per play:
//                                      the batter's own outcome, PLUS a
//                                      separate fragment for each other
//                                      baserunner who advanced or was put
//                                      out on that same play (e.g. a double
//                                      play's narrative is followed by
//                                      "C Fossyl out advancing to home,"
//                                      "A Pecoroni advances to 3rd," etc.).
//                                      The old keyword-regex approach only
//                                      matched fragments containing words
//                                      like "single"/"double"/"error" and
//                                      silently dropped every baserunner-
//                                      advance fragment, since phrases like
//                                      "advances to 3rd" don't contain any
//                                      of those keywords.
async function extractVisiblePlaysOnce(page) {
  return await page.evaluate(() => {
    // querySelectorAll with a combined selector returns nodes in document
    // order, so walking this single list lets us track "current inning"
    // just by updating it whenever we pass an inning-header node — no
    // separate DOM-proximity search needed per play.
    const nodes = Array.from(document.querySelectorAll('.BatsPlays__inning, .BatsPlays__play'));

    const results = [];
    let currentInning = null;

    for (const node of nodes) {
      if (node.classList.contains('BatsPlays__inning')) {
        const inningText = String(node.innerText || "").replace(/\s+/g, " ").trim();
        if (inningText) currentInning = inningText;
        continue;
      }

      // node is a .BatsPlays__play
      const badgeEl = node.querySelector('.BatsPlays__playName');
      const badge = badgeEl ? String(badgeEl.innerText || "").replace(/\s+/g, " ").trim() : "";

      // A real, completed plate appearance always has a result badge
      // ("Single", "Walk", "Strikeout", etc). A .BatsPlays__play block
      // with NO badge is an in-progress/incomplete at-bat — e.g. the game
      // ended (or the scraped page loaded) while a batter was still up,
      // rendered as a placeholder like "B Roper at bat" with no outcome
      // yet. That's not a real play and shouldn't become a play_events
      // row — skip it entirely.
      if (!badge) continue;

      const detailEls = Array.from(node.querySelectorAll('[data-testid="at-plate-detail"]'));
      const details = detailEls
        .map((el) => String(el.innerText || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);

      // Combine badge + all narrative fragments into one string per play,
      // consistent with the documented normalizer.js expectation that
      // GameChanger descriptions "start with an event-type label" followed
      // by the narrative — extractPlayerFromPlay() already knows to skip
      // a leading label like this.
      const text = [badge, ...details].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      if (!text) continue;

      results.push({ inning: currentInning, text });
    }

    return results;
  });
}

// Scrolls the Plays list incrementally, running extractVisiblePlaysOnce()
// at EVERY step and accumulating results.
//
// Confirmed against a real saved copy of this exact game's Plays page:
// GameChanger renders 52 real .BatsPlays__play elements for a full game,
// but our automated scroll loop was only ever finding ~19 — and
// critically, scrollHeight never grew even once across 5 full scroll
// steps that got most of the way down the page. That rules out
// virtualization (elements being unmounted after scrolling past them);
// instead, it means GameChanger's lazy-load trigger for the REST of the
// plays was never firing at all during automation.
//
// Most likely cause: directly assigning `element.scrollTop = X` in large
// 1000px jumps can leap straight past a lazy-load trigger zone (e.g. an
// IntersectionObserver watching a small "sentinel" element near the
// bottom of what's currently rendered) without that zone ever being
// visible in an actual rendered frame — so the observer never fires,
// even though scrollTop visibly changed. A real user's mouse-wheel
// scrolling moves through that zone continuously and reliably triggers
// it. This version uses Playwright's page.mouse.wheel() with smaller
// increments instead, to scroll the way a real user would.
async function extractAllPlaysByIncrementalScroll(page, maxScrolls = 60) {
  const scrollHandle = await getBestScrollableElementHandle(page);

  const scrollInfo = await scrollHandle.evaluate((el) => ({
    tag: el.tagName,
    id: el.id || null,
    className: typeof el.className === "string" ? el.className : null,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  console.log(`[psg][diag] Scroll container: <${scrollInfo.tag} id="${scrollInfo.id}" class="${scrollInfo.className}"> scrollHeight=${scrollInfo.scrollHeight} clientHeight=${scrollInfo.clientHeight}`);

  // Position the mouse over the scroll container before dispatching wheel
  // events — page.mouse.wheel() scrolls whatever element is under the
  // cursor, same as a real user scrolling with their mouse over that
  // part of the page.
  const box = await scrollHandle.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  } else {
    console.warn('[psg][diag] Could not get bounding box for scroll container — wheel events may not land on the right element.');
  }

  const seenKey = new Set();
  const accumulated = [];

  const captureCurrentlyVisible = async () => {
    const visible = await extractVisiblePlaysOnce(page);
    let newCount = 0;
    for (const play of visible) {
      const key = `${play.inning || ""}|${play.text}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      accumulated.push(play);
      newCount++;
    }
    return newCount;
  };

  const initialNewCount = await captureCurrentlyVisible();
  console.log(`[psg][diag] Step 0 (pre-scroll): +${initialNewCount} new plays, total=${accumulated.length}`);

  let stableStepsInARow = 0;

  for (let i = 0; i < maxScrolls; i++) {
    const prevHeight = await scrollHandle.evaluate((el) => el.scrollHeight);

    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(600);

    const newCount = await captureCurrentlyVisible();

    const newHeight = await scrollHandle.evaluate((el) => el.scrollHeight);
    const reachedBottom = await scrollHandle.evaluate(
      (el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2
    );

    console.log(`[psg][diag] Step ${i + 1}: scrollHeight ${prevHeight}→${newHeight}, +${newCount} new plays, total=${accumulated.length}, reachedBottom=${reachedBottom}`);

    if (newCount === 0 && newHeight === prevHeight) {
      stableStepsInARow++;
    } else {
      stableStepsInARow = 0;
    }

    // Require more consecutive stable steps than before, since smaller
    // scroll increments mean more steps overall are expected before
    // genuinely running out of content.
    if (reachedBottom && stableStepsInARow >= 3) break;
    if (stableStepsInARow >= 10) break; // safety net if "reachedBottom" never resolves true
  }

  return accumulated;
}

async function extractPlays(page) {
  console.log("Extracting play-by-play from DOM...");

  if (GC_SKIP_PLAYS) {
    console.warn('[psg] GC_SKIP_PLAYS=true — skipping play-by-play extraction for this repair run.');
    return [];
  }

  // Direct URL navigation is more reliable than clicking the tab from the box-score page.
  try {
    const currentUrl = page.url();
    const playsUrl = currentUrl
      .replace(/\/box-score\/?$/, "/plays")
      .replace(/\/recap\/?$/, "/plays")
      .replace(/\/videos\/?$/, "/plays")
      .replace(/\/info\/?$/, "/plays")
      .replace(/\/lineup\/?$/, "/plays");

    if (playsUrl !== currentUrl) {
      console.log(`[psg] Navigating directly to plays URL: ${playsUrl}`);
      await page.goto(playsUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      try { await page.waitForLoadState("networkidle", { timeout: 10000 }); } catch {}
      await page.waitForTimeout(1500);
      await dismissDontMissOutPopup(page);
    } else {
      await clickTabByName(page, "Plays");
    }
  } catch (error) {
    console.warn(`[psg] Could not open Plays page. Continuing without play-by-play: ${error.message}`);
    return [];
  }

  try {
    await withTimeout(selectChronologicalPlaysOrder(page), 12000, 'selectChronologicalPlaysOrder');
  } catch (error) {
    console.warn(`[psg] Could not switch Plays order. Continuing with visible order: ${error.message}`);
  }

  try {
    await page.waitForTimeout(1000);
    const plays = await withTimeout(
      extractAllPlaysByIncrementalScroll(page, 40),
      60000,
      'extractAllPlaysByIncrementalScroll'
    );
    console.log(`  Extracted ${plays.length} play-by-play events`);
    return plays;
  } catch (error) {
    console.warn(`[psg] Play extraction failed. Continuing without play-by-play: ${error.message}`);
    return [];
  }
}

// ─── Main Game Extraction (replaces captureBoxScoreAndPlays) ─────────────────

async function extractGameData(page, team, scheduleMeta = null) {
  const teamDir = getTeamOutputDir(team);
  const gameUrl = page.url();
  const gameId  = extractGameIdFromUrl(gameUrl);

  console.log("");
  console.log("Starting structured data extraction (HTML, no OCR)...");

  const scheduleGameMeta = scheduleMeta || page.__jobuCurrentGameScheduleMeta || {};
  const header   = await extractGameHeader(page);
  const recapPageDate = await extractGameDateFromCurrentPage(page, 'recap page');
  const boxScore = await extractBoxScore(page);
  const boxScorePageDate = await extractGameDateFromCurrentPage(page, 'box score page');

  const parsedHeaderGameDate = parseGameDateFromHeaderDateTime(header.dateTime || header.gameDatetimeRaw);

  // Preference order: box score page and recap page dates are captured after
  // navigating to THIS specific game's own URL, so they are far less likely to
  // collide with another game's date than the schedule-card date, which is
  // resolved via a DOM-proximity heuristic on the shared schedule LIST page
  // (see getVisibleCompletedGameEntries / clickCompletedGameFromScheduleByIndex).
  // The schedule card date is still useful as a fallback and as a cross-check.
  const resolvedGameDate =
    boxScorePageDate.gameDate ||
    recapPageDate.gameDate ||
    scheduleGameMeta.gameDate ||
    parsedHeaderGameDate ||
    null;

  let resolvedGameDateSource = 'unresolved';
  if (resolvedGameDate) {
    if (boxScorePageDate.gameDate) resolvedGameDateSource = 'box score page';
    else if (recapPageDate.gameDate) resolvedGameDateSource = 'recap page';
    else if (scheduleGameMeta.gameDate) resolvedGameDateSource = 'schedule card';
    else resolvedGameDateSource = 'game header';
    console.log(`[psg] Resolved game date: ${resolvedGameDate} (${resolvedGameDateSource})`);
  } else {
    console.warn(`[psg] Could not resolve game date for ${gameId || gameUrl}`);
  }

  // Cross-check: if the schedule card disagrees with the per-game page date,
  // that is a strong signal the schedule-list proximity search latched onto
  // the wrong element for this row. Log it loudly so it shows up in Railway
  // logs even though we don't block on it.
  const perGamePageDate = boxScorePageDate.gameDate || recapPageDate.gameDate || null;
  if (perGamePageDate && scheduleGameMeta.gameDate && perGamePageDate !== scheduleGameMeta.gameDate) {
    console.warn(`[psg] DATE MISMATCH for ${gameId || gameUrl}: schedule card said ${scheduleGameMeta.gameDate}, ` +
      `per-game page said ${perGamePageDate}. Using ${perGamePageDate}. If this repeats across many games in one run, ` +
      `the schedule-card date extraction is likely broken for this team's page layout.`);
  }

  let plays = [];
  try {
    plays = await withTimeout(
      extractPlays(page),
      GC_PLAYS_EXTRACTION_TIMEOUT_MS,
      'extractPlays'
    );
  } catch (error) {
    console.warn(`[psg] Play extraction timed out/failed. Continuing with box score only: ${error.message}`);
    plays = [];
  }

  // Play reconstruction fallback if AG Grid was empty
  if (boxScore.source === "plays" || (!boxScore.batting.length && !boxScore.pitching.length)) {
    console.log("Reconstructing batting/pitching stats from play-by-play...");
    const reconstructed = reconstructStatsFromPlays(plays);
    boxScore.batting  = reconstructed.batting;
    boxScore.pitching = reconstructed.pitching;
    boxScore.source   = "plays_reconstructed";
    console.log(`  Reconstructed: ${boxScore.batting.length} batters, ${boxScore.pitching.length} pitchers`);
  }

  // ── Identify which side is OUR team vs the OPPONENT ───────────────────────
  let ourSide = null;
  const ourNameClean  = String(team.teamName  || "").toLowerCase().replace(/\s+/g, " ").trim();
  const awayNameClean = String(boxScore.awayTeam || "").toLowerCase().replace(/\s+/g, " ").trim();
  const homeNameClean = String(boxScore.homeTeam || "").toLowerCase().replace(/\s+/g, " ").trim();

  if (awayNameClean && (awayNameClean.includes(ourNameClean) || ourNameClean.includes(awayNameClean))) {
    ourSide = "away";
  } else if (homeNameClean && (homeNameClean.includes(ourNameClean) || ourNameClean.includes(homeNameClean))) {
    ourSide = "home";
  } else {
    // Word-overlap scoring fallback
    const ourWords  = ourNameClean.split(" ").filter(w => w.length > 2);
    const awayScore = ourWords.filter(w => awayNameClean.includes(w)).length;
    const homeScore = ourWords.filter(w => homeNameClean.includes(w)).length;
    ourSide = homeScore >= awayScore ? "home" : "away";
  }

  const opponentName = ourSide === "away"
    ? (boxScore.homeTeam || "")
    : (boxScore.awayTeam || "");

  console.log(`  Our side: ${ourSide} (${team.teamName}) | Opponent: ${opponentName}`);

  // Tag every player row with isOurTeam boolean
  const tagRows = (rows, side) =>
    (rows || []).map(r => ({ ...r, isOurTeam: side === ourSide }));

  boxScore.batting = [
    ...tagRows(boxScore.awayBatting  || [], "away"),
    ...tagRows(boxScore.homeBatting  || [], "home"),
  ];
  boxScore.pitching = [
    ...tagRows(boxScore.awayPitching || [], "away"),
    ...tagRows(boxScore.homePitching || [], "home"),
  ];

  const gameData = {
    meta: {
      gameId,
      gameUrl,
      teamName:    team.teamName,
      ourSide,
      opponentName,
      awayTeam:    boxScore.awayTeam || "",
      homeTeam:    boxScore.homeTeam || "",
      gameDate:    resolvedGameDate,
      game_date:   resolvedGameDate,
      scheduleDateText: scheduleGameMeta.dateText || "",
      scheduleCardText: scheduleGameMeta.cardText || "",
      scheduleScoreText: scheduleGameMeta.scoreText || "",
      boxScoreDateText: boxScorePageDate.dateText || "",
      recapDateText: recapPageDate.dateText || "",
      gameDateSource: resolvedGameDateSource,
      gameDatetimeRaw: header.gameDatetimeRaw || header.dateTime || boxScorePageDate.dateText || recapPageDate.dateText || scheduleGameMeta.dateText || "",
      capturedAt:  new Date().toISOString(),
      ...header,
      gameDate:    resolvedGameDate,
      game_date:   resolvedGameDate
    },
    boxScore,
    plays
  };

  // Save structured JSON
  const fileBase = sanitizeFileNameCompact(`game-${gameId || header.dateTime || Date.now()}`);
  const jsonPath = path.join(teamDir, `${fileBase}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(gameData, null, 2), "utf8");
  console.log(`Saved structured game data: ${jsonPath}`);

  // Optional screenshot fallback (set GC_SCREENSHOT_FALLBACK=true in .env)
  let boxScoreFile = null;
  if (SCREENSHOT_FALLBACK || (!boxScore.batting.length && !boxScore.pitching.length)) {
    console.log("Screenshot fallback triggered for box score");
    await clickTabByName(page, "Box Score");
    await page.waitForTimeout(2000);
    const boxScorePath = path.join(teamDir, `${fileBase}-box-score.png`);
    boxScoreFile = await captureExpandedFullPageScreenshot(page, boxScorePath, "Box Score fallback");
  }

  return {
    success: true,
    jsonFile: jsonPath,
    boxScoreFile,
    gameData
  };
}

// ─── Game Loop ────────────────────────────────────────────────────────────────

function normalizeGcGameIdentity(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const extracted = extractGameIdFromUrl(raw);
  return extracted || raw;
}

function dbGameMatchesPageGame(dbGames, gameId, gameUrl) {
  const normalizedGameId = normalizeGcGameIdentity(gameId);
  const normalizedUrlGameId = normalizeGcGameIdentity(gameUrl);
  const normalizedUrl = String(gameUrl || '').trim();

  return (dbGames || []).some((game) => {
    const dbGameId = normalizeGcGameIdentity(game.gcGameId || game.gc_game_id || '');
    const dbUrl = String(game.gcGameUrl || game.gc_game_url || '').trim();
    const dbUrlGameId = normalizeGcGameIdentity(dbUrl);

    const matched = (
      (normalizedGameId && dbGameId && normalizedGameId === dbGameId) ||
      (normalizedGameId && dbUrlGameId && normalizedGameId === dbUrlGameId) ||
      (normalizedUrlGameId && dbGameId && normalizedUrlGameId === dbGameId) ||
      (normalizedUrl && dbUrl && normalizedUrl === dbUrl)
    );

    if (!matched) return false;

    if (process.env.GC_REPROCESS_ALL_COMPLETED_GAMES === 'true') {
      console.log(`[psg] Repair mode active. Reprocessing existing DB game: ${dbGameId || dbUrlGameId || dbUrl}`);
      return false;
    }

    const dbGameDate = game.gameDate || game.game_date || null;
    if (!dbGameDate && process.env.GC_REPAIR_MISSING_GAME_DATES !== 'false') {
      console.log(`[psg] Existing DB game is missing game_date. Reprocessing to repair: ${dbGameId || dbUrlGameId || dbUrl}`);
      return false;
    }

    return true;
  });
}


function findMatchingDbGame(dbGames, gameId, gameUrl) {
  const normalizedGameId = normalizeGcGameIdentity(gameId);
  const normalizedUrlGameId = normalizeGcGameIdentity(gameUrl);
  const normalizedUrl = String(gameUrl || '').trim();

  return (dbGames || []).find((game) => {
    const dbGameId = normalizeGcGameIdentity(game.gcGameId || game.gc_game_id || '');
    const dbUrl = String(game.gcGameUrl || game.gc_game_url || '').trim();
    const dbUrlGameId = normalizeGcGameIdentity(dbUrl);

    return (
      (normalizedGameId && dbGameId && normalizedGameId === dbGameId) ||
      (normalizedGameId && dbUrlGameId && normalizedGameId === dbUrlGameId) ||
      (normalizedUrlGameId && dbGameId && normalizedUrlGameId === dbGameId) ||
      (normalizedUrl && dbUrl && normalizedUrl === dbUrl)
    );
  }) || null;
}

function shouldForceReprocessDbGame(dbGame) {
  if (process.env.GC_REPROCESS_ALL_COMPLETED_GAMES === 'true') return true;
  if (dbGame && !dbGame.gameDate && !dbGame.game_date && process.env.GC_REPAIR_MISSING_GAME_DATES !== 'false') return true;
  return false;
}

async function loadKnownCompleteDbGames(teamId) {
  if (!pipeline.getKnownCompleteGamesForTeam) {
    console.log('[psg] DB completed-game lookup is not available. Falling back to schedule scan.');
    return [];
  }

  const games = await withTimeout(
    pipeline.getKnownCompleteGamesForTeam(teamId),
    30000,
    'pipeline.getKnownCompleteGamesForTeam'
  );

  return Array.isArray(games) ? games : [];
}

async function chooseIncrementalStartIndex(page, teamId, completedGameCount, knownDbGames) {
  const dbCompleteCount = knownDbGames.length;

  console.log(`[psg] Complete games in DB for this team: ${dbCompleteCount}`);
  console.log(`[psg] Completed games visible on PSG: ${completedGameCount}`);

  // Reliability-first default:
  // Counts alone are not safe because the DB can contain a non-contiguous set of games
  // after earlier failed/interrupted scraper runs. Example: DB has 14 complete games,
  // but GameChanger game #14 is not one of them. In that situation, starting at #15
  // would skip missing earlier games. So by default we reconcile from game #1 and skip
  // every game already complete in the DB by GameChanger game id.
  if (process.env.GC_INCREMENTAL_FAST_START !== 'true') {
    if (dbCompleteCount === 0) {
      console.log('[psg] No completed games found in DB. Starting at PSG completed game #1.');
    } else {
      console.log('[psg] Safe reconciliation mode: scanning from PSG game #1 and skipping games already complete in DB.');
      console.log('[psg] To re-enable count-based fast start, set GC_INCREMENTAL_FAST_START=true.');
    }
    return 0;
  }

  console.log('[psg] GC_INCREMENTAL_FAST_START=true. Attempting count-based boundary check.');

  if (dbCompleteCount === 0) {
    console.log('[psg] No completed games found in DB. Starting at PSG completed game #1.');
    return 0;
  }

  if (completedGameCount <= dbCompleteCount) {
    console.log('[psg] DB has at least as many complete games as PSG shows, but fast-start mode still verifies the boundary.');
  }

  const verifyIndex = Math.min(dbCompleteCount - 1, completedGameCount - 1);
  console.log(`[psg] Incremental analysis check: verifying PSG game #${verifyIndex + 1} is already in DB...`);

  const opened = await clickCompletedGameFromScheduleByIndex(page, verifyIndex);
  if (!opened) {
    console.log('[psg] Could not open the DB boundary game. Falling back to a full schedule scan.');
    return 0;
  }

  const verifyUrl = page.url();
  const verifyGameId = extractGameIdFromUrl(verifyUrl);
  const matchesDb = dbGameMatchesPageGame(knownDbGames, verifyGameId, verifyUrl);

  console.log(`[psg] Boundary PSG game id: ${verifyGameId || '(none)'}`);
  console.log(`[psg] Boundary game is in DB: ${matchesDb ? 'YES' : 'NO'}`);

  const returned = await clickBackToSchedule(page);
  if (!returned) {
    console.log('[psg] Could not return to schedule after DB boundary check. Falling back to current page handling.');
    return 0;
  }

  if (matchesDb && completedGameCount > dbCompleteCount) {
    const startIndex = dbCompleteCount;
    console.log(`[psg] Incremental analysis confirmed. Starting with new PSG game #${startIndex + 1}.`);
    return startIndex;
  }

  if (matchesDb && completedGameCount <= dbCompleteCount) {
    console.log('[psg] Boundary matched, but counts suggest there may be no new games. Running a full duplicate-check scan to verify no gaps.');
    return 0;
  }

  console.log('[psg] DB boundary did not match the PSG schedule. The DB set is non-contiguous. Falling back to a full scan with DB duplicate checks.');
  return 0;
}

function wirePageDiagnostics(page) {
  if (!page || page.__jobuDiagnosticsAttached) return;
  page.__jobuDiagnosticsAttached = true;
  const verboseBrowserLogs = process.env.GC_VERBOSE_BROWSER_LOGS === 'true';
  page.on('crash', () => console.error('[browser] Page crashed.'));
  page.on('pageerror', (error) => console.error(`[browser] Page error: ${error.message}`));
  page.on('console', (msg) => {
    if (!verboseBrowserLogs) return;
    const type = msg.type();
    if (type === 'error' || type === 'warning') {
      console.log(`[browser console:${type}] ${msg.text().slice(0, 500)}`);
    }
  });
  page.on('requestfailed', (request) => {
    if (!verboseBrowserLogs) return;
    const failure = request.failure();
    const url = request.url();
    if (/web\.gc\.com|gc\.com|gamechanger/i.test(url)) {
      console.log(`[browser request failed] ${request.method()} ${url.slice(0, 300)} :: ${failure?.errorText || 'unknown'}`);
    }
  });
}

function getErrorMessage(error) {
  if (!error) return 'Unknown error';
  return error.stack || error.message || String(error);
}

async function writeFailedGameCaptureReport(page, team, gameIndex, phase, error, extra = {}) {
  try {
    const failedCapturesDir = failedGameCapturesDir();
    const teamName = sanitizeFileNameCompact(team.teamName || team.rawTeamName || 'unknown-team');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `${teamName}-game-${gameIndex + 1}-${phase}-${stamp}`;
    const txtPath = path.join(failedCapturesDir, `${base}.txt`);
    const pngPath = path.join(failedCapturesDir, `${base}.png`);

    const lines = [];
    lines.push('GameChanger Game Capture Failure');
    lines.push('================================');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Team: ${team.teamName || team.rawTeamName || ''}`);
    lines.push(`Game index: ${gameIndex + 1}`);
    lines.push(`Phase: ${phase}`);
    lines.push(`Current URL: ${page?.url ? page.url() : ''}`);
    for (const [key, value] of Object.entries(extra || {})) {
      lines.push(`${key}: ${value}`);
    }
    lines.push('');
    lines.push('Error');
    lines.push('-----');
    lines.push(getErrorMessage(error));
    fs.writeFileSync(txtPath, lines.join('\n'), 'utf8');
    console.log(`[psg] Wrote failed game report: ${txtPath}`);

    try {
      if (page && !page.isClosed()) {
        await page.screenshot({ path: pngPath, fullPage: true, timeout: 15000 });
        console.log(`[psg] Wrote failed game screenshot: ${pngPath}`);
      }
    } catch (screenshotError) {
      console.log(`[psg] Could not capture failure screenshot: ${screenshotError.message}`);
    }
  } catch (reportError) {
    console.log(`[psg] Could not write failed game report: ${reportError.message}`);
  }
}

async function returnToScheduleSafely(page, scheduleUrl, label = 'return to schedule') {
  if (!page || page.isClosed()) return false;

  try {
    if (/\/schedule\/?(?:[?#].*)?$/i.test(page.url())) return true;
  } catch {
    // Continue to return attempts.
  }

  try {
    const returned = await clickBackToSchedule(page);
    if (returned) return true;
  } catch (error) {
    console.log(`[psg] Back-to-schedule click failed during ${label}: ${error.message}`);
  }

  if (scheduleUrl) {
    try {
      console.log(`[psg] Reloading schedule URL after ${label}: ${scheduleUrl}`);
      await page.goto(scheduleUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
      await page.waitForTimeout(1500);
      await dismissDontMissOutPopup(page);
      return true;
    } catch (error) {
      console.log(`[psg] Schedule reload failed during ${label}: ${error.message}`);
    }
  }

  return false;
}

async function processOneCompletedGame(page, team, teamId, gameIndex, manifest, knownDbGames, scheduleUrl, scheduleEntry = null) {
  let phase = 'open-game';
  let gameUrl = '';
  let gameId = '';
  let gameScheduleMeta = null;

  const entryHref = scheduleEntry?.href || '';
  const entryGameId = scheduleEntry?.gameId || extractGameIdFromUrl(entryHref);

  // Fast skip before opening the page. This prevents skip-only games from getting
  // stuck on recap pages and avoids relying on the fragile "Back to Schedule" link.
  const preOpenDbMatch = findMatchingDbGame(knownDbGames, entryGameId, entryHref);
  if (preOpenDbMatch && !shouldForceReprocessDbGame(preOpenDbMatch)) {
    console.log(`[psg] Skipping game already complete in DB without opening page: ${entryGameId || entryHref}`);
    return { status: 'skipped_db', gameId: entryGameId, gameUrl: entryHref };
  }

  if (entryHref) {
    gameScheduleMeta = {
      ...scheduleEntry,
      openedUrl: entryHref,
      openedGameId: entryGameId,
    };

    console.log('');
    console.log(`Opening completed game #${gameIndex + 1} directly from captured schedule URL...`);
    console.log(`[psg] Schedule card: ${scheduleEntry?.scoreText || ''} | ${scheduleEntry?.gameDate || 'NO DATE'} | ${entryGameId || entryHref}`);

    await withTimeout(
      page.goto(entryHref, { waitUntil: 'domcontentloaded', timeout: 60000 }),
      70000,
      `navigate directly to completed game #${gameIndex + 1}`
    );
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
    await page.waitForTimeout(2000);
    await dismissDontMissOutPopup(page);

    gameUrl = page.url();
    gameId = extractGameIdFromUrl(gameUrl) || entryGameId;
  } else {
    const openedMeta = await withTimeout(
      clickCompletedGameFromScheduleByIndex(page, gameIndex),
      90000,
      `open completed game #${gameIndex + 1}`
    );

    if (!openedMeta) {
      throw new Error(`Could not open completed game #${gameIndex + 1}.`);
    }

    gameUrl = page.url();
    gameId  = extractGameIdFromUrl(gameUrl);
    gameScheduleMeta = { ...openedMeta, openedUrl: gameUrl, openedGameId: gameId };
  }

  console.log(`[psg] Opened PSG game #${gameIndex + 1}: ${gameId || gameUrl}`);

  phase = 'db-duplicate-check';
  const dbMatch = findMatchingDbGame(knownDbGames, gameId, gameUrl);
  if (dbMatch && !shouldForceReprocessDbGame(dbMatch)) {
    console.log(`[psg] Skipping game already complete in DB: ${gameId || gameUrl}`);
    return { status: 'skipped_db', gameId, gameUrl };
  }

  if (dbMatch && shouldForceReprocessDbGame(dbMatch)) {
    console.log(`[psg] Reprocessing existing DB game because it is incomplete or repair mode is enabled: ${gameId || gameUrl}`);
  }

  phase = 'manifest-duplicate-check';
  if (process.env.GC_TRUST_PROCESSED_MANIFEST === 'true' && isGameAlreadyProcessed(manifest.processedGames, gameId)) {
    console.log(`Skipping already processed game from manifest: ${gameId || gameUrl}`);
    return { status: 'skipped_manifest', gameId, gameUrl };
  }

  if (isGameAlreadyProcessed(manifest.processedGames, gameId)) {
    console.log(`[psg] Manifest contains this game, but DB does not show it as complete. Re-analyzing: ${gameId || gameUrl}`);
  }

  phase = 'extract-game-data';
  const captureResult = await withTimeout(
    extractGameData(page, team, gameScheduleMeta),
    GC_GAME_EXTRACTION_TIMEOUT_MS,
    `extractGameData game #${gameIndex + 1}`
  );

  if (!captureResult || !captureResult.success) {
    throw new Error(`Capture failed for completed game #${gameIndex + 1}.`);
  }

  // Dashboard teams in the Single Opponent Scout workflow are opponent/scouted-team pages.
  // Store the scraped team's own players as is_our_team=false so report queries
  // analyze the selected team, not the collection of opponents they played.
  // Set GC_INGEST_AS_SCOUTED_OPPONENT=false only for true self-scout/our-team scrapes.
  const ingestAsScoutedOpponent = process.env.GC_INGEST_AS_SCOUTED_OPPONENT !== 'false';
  captureResult.isOpponentTeam = ingestAsScoutedOpponent;
  if (captureResult.gameData && captureResult.gameData.meta) {
    captureResult.gameData.meta.isOpponentTeam = ingestAsScoutedOpponent;
  }
  console.log(`[psg] Ingest side mode: ${ingestAsScoutedOpponent ? 'scouted opponent/team stored as is_our_team=0' : 'self-scout/our team stored as is_our_team=1'}`);

  phase = 'db-write';
  console.log('[psg] Writing extracted game to DB...');
  const dbWriteResult = await withTimeout(
    pipeline.processExtractResult(captureResult, teamId),
    GC_GAME_DB_WRITE_TIMEOUT_MS,
    `pipeline.processExtractResult game #${gameIndex + 1}`
  );

  if (!dbWriteResult || dbWriteResult.success === false) {
    const error = dbWriteResult?.error || 'unknown error';
    console.warn(`[psg] DB write did not complete cleanly: ${error}`);
    console.warn('[psg] Not marking this game as processed because the DB write failed.');
    throw new Error(`DB write failed for completed game #${gameIndex + 1}: ${error}`);
  }

  console.log('[psg] DB write complete.');

  phase = 'manifest-update';
  if (!isGameAlreadyProcessed(manifest.processedGames, gameId)) {
    manifest.processedGames.push({
      gameId,
      gameUrl,
      capturedAt:    new Date().toISOString(),
      jsonFile:      captureResult.jsonFile      || '',
      boxScoreFile:  captureResult.boxScoreFile  || '',
      gameDate:      captureResult.gameData?.meta?.gameDate || gameScheduleMeta?.gameDate || ''
    });

    saveProcessedGames(manifest.manifestPath, manifest.processedGames);
    console.log(`Updated processed-games manifest: ${manifest.manifestPath}`);
  }

  knownDbGames.push({
    gcGameId: gameId || extractGameIdFromUrl(gameUrl) || '',
    gcGameUrl: gameUrl || '',
    gameDate: captureResult.gameData?.meta?.gameDate || gameScheduleMeta?.gameDate || null,
  });

  return {
    status: 'processed',
    gameId,
    gameUrl,
    gameDate: captureResult.gameData?.meta?.gameDate || gameScheduleMeta?.gameDate || null,
    opponentName: captureResult.gameData?.meta?.opponentName || null,
  };
}

async function captureAllCompletedGamesFromSchedule(page, team, teamId, resolvedTeamUrl) {
  console.log('');
  console.log('Starting completed-game capture loop...');
  console.log(`[psg] Per-game retry limit: ${GC_GAME_MAX_ATTEMPTS}`);
  console.log(`[psg] Extraction timeout: ${GC_GAME_EXTRACTION_TIMEOUT_MS}ms`);
  console.log(`[psg] DB write timeout: ${GC_GAME_DB_WRITE_TIMEOUT_MS}ms`);
  console.log(`[psg] Plays extraction timeout: ${GC_PLAYS_EXTRACTION_TIMEOUT_MS}ms${GC_SKIP_PLAYS ? ' (GC_SKIP_PLAYS=true)' : ''}`);

  const teamDir = getTeamOutputDir(team);
  const manifest = loadProcessedGames(teamDir);
  let knownDbGames = await loadKnownCompleteDbGames(teamId);
  let scheduleUrl = page.url();
  const failures = [];
  const processed = [];
  const skipped = [];

  let completedGameCount = 0;
  try {
    completedGameCount = await withTimeout(
      getVisibleCompletedGameCount(page),
      45000,
      'getVisibleCompletedGameCount'
    );
  } catch (error) {
    console.error(`[psg] Could not count completed games on schedule: ${error.message}`);
    await writeFailedGameCaptureReport(page, team, 0, 'count-completed-games', error, { scheduleUrl });
    const recovered = await returnToScheduleSafely(page, scheduleUrl, 'count completed games recovery');
    if (!recovered) throw error;
    completedGameCount = await getVisibleCompletedGameCount(page);
  }

  console.log(`Visible completed games on schedule: ${completedGameCount}`);
  console.log(`[psg] Complete games in DB for this team: ${knownDbGames.length}`);

  let scheduleEntries = [];
  try {
    scheduleEntries = await withTimeout(
      getVisibleCompletedGameEntries(page),
      45000,
      'getVisibleCompletedGameEntries'
    );
  } catch (error) {
    console.warn(`[psg] Could not capture schedule entries up front: ${error.message}`);
    scheduleEntries = [];
  }

  const directEntries = scheduleEntries.filter((entry) => entry.href || entry.gameId);
  if (directEntries.length) {
    completedGameCount = directEntries.length;
    console.log(`[psg] Captured ${directEntries.length} completed schedule entries with direct game URLs.`);
  } else {
    console.warn('[psg] Could not capture direct game URLs from the schedule. Falling back to click-by-index mode.');
  }

  if (completedGameCount === 0) {
    console.log('No completed games found. Moving on.');
    return true;
  }

  console.log('[psg] Resume mode: starting at the end of the PSG schedule and walking forward.');
  console.log('[psg] Each game is skipped only when that exact PSG game id is already complete in the DB.');
  console.log('[psg] Direct URL mode avoids fragile Back-to-Schedule navigation after skipped games.');

  const scheduleIndexes = buildResumeOrderedScheduleIndexes(completedGameCount);

  for (const gameIndex of scheduleIndexes) {
    const scheduleEntry = directEntries.length ? directEntries[gameIndex] : null;
    if (!scheduleEntry) {
      await returnToScheduleSafely(page, scheduleUrl, `before game #${gameIndex + 1}`);
      scheduleUrl = page.url().includes('/schedule') ? page.url() : scheduleUrl;
    }

    let attempt = 1;
    let finishedThisIndex = false;
    let lastStatus = null;

    while (attempt <= GC_GAME_MAX_ATTEMPTS && !finishedThisIndex) {
      console.log('');
      console.log(`[psg] Processing completed game #${gameIndex + 1} of ${completedGameCount} (attempt ${attempt}/${GC_GAME_MAX_ATTEMPTS})...`);
      try {
        const result = await processOneCompletedGame(page, team, teamId, gameIndex, manifest, knownDbGames, scheduleUrl, scheduleEntry);
        lastStatus = result.status;

        if (result.status === 'processed') processed.push(result);
        else if (result.status && result.status.startsWith('skipped')) skipped.push(result);
        else failures.push({ gameNumber: gameIndex + 1, ...result });

        finishedThisIndex = true;
      } catch (error) {
        lastStatus = error.message;
        console.error(`[psg] Error processing completed game #${gameIndex + 1} attempt ${attempt}: ${error.message}`);
        console.error(getErrorMessage(error));
        await writeFailedGameCaptureReport(page, team, gameIndex, `attempt-${attempt}`, error, { scheduleUrl });

        if (attempt >= GC_GAME_MAX_ATTEMPTS) {
          failures.push({ gameNumber: gameIndex + 1, error: error.message });
          console.warn(`[psg] Giving up on completed game #${gameIndex + 1} after ${GC_GAME_MAX_ATTEMPTS} attempt(s). Continuing to the next game.`);
          finishedThisIndex = true;
        }
      } finally {
        if (!scheduleEntry) {
          const returned = await returnToScheduleSafely(page, scheduleUrl, `game #${gameIndex + 1} attempt ${attempt}`);
          if (!returned) {
            const err = new Error(`Could not return to schedule after game #${gameIndex + 1} attempt ${attempt}. Last status: ${lastStatus || 'unknown'}`);
            console.error(`[psg] ${err.message}`);
            await writeFailedGameCaptureReport(page, team, gameIndex, `return-to-schedule-attempt-${attempt}`, err, { scheduleUrl });
            if (attempt >= GC_GAME_MAX_ATTEMPTS) {
              failures.push({ gameNumber: gameIndex + 1, error: err.message });
              finishedThisIndex = true;
            }
          }
        }
      }

      attempt++;
    }
  }

  console.log('No more completed games to process for this team.');
  if (failures.length) {
    console.warn(`[psg] Completed schedule scan with ${failures.length} failed game(s). Failed games were not marked processed and will be retried on the next run.`);
    for (const f of failures) console.warn(`[psg] Failed game #${f.gameNumber}: ${f.status || f.error}`);
  }
  console.log(`[psg] Summary: processed=${processed.length}, skipped=${skipped.length}, failed=${failures.length}`);

  // ── Date-collapse integrity check ─────────────────────────────────────────
  // If this run processed several games and they all landed on the same
  // game_date (or a handful of dates far fewer than the number of distinct
  // opponents), the date-resolution heuristics almost certainly failed for
  // this team's page layout — same failure mode that previously silently
  // corrupted PitchSmart data for entire teams. This never blocks the run
  // (we still want the box score data), but it must be loud and unmissable.
  const datedGames = processed.filter(p => p.gameDate);
  if (datedGames.length >= 4) {
    const distinctDates = new Set(datedGames.map(p => p.gameDate));
    const distinctOpponents = new Set(datedGames.map(p => p.opponentName).filter(Boolean));
    if (distinctDates.size === 1 && distinctOpponents.size > 2) {
      console.warn('');
      console.warn('##################################################################');
      console.warn('[psg] DATE INTEGRITY WARNING: all ' + datedGames.length + ' games processed in this ' +
        'run for "' + (team.teamName || 'this team') + '" resolved to the same game_date (' +
        [...distinctDates][0] + ') against ' + distinctOpponents.size + ' different opponents.');
      console.warn('[psg] This is almost certainly wrong (a team cannot realistically play that many ' +
        'different opponents in one day) and will corrupt PitchSmart pitcher-availability data.');
      console.warn('[psg] Do NOT trust this team\'s dates until re-analyzed. See date-resolution logic in ' +
        'extractGameData / getVisibleCompletedGameEntries / clickCompletedGameFromScheduleByIndex.');
      console.warn('##################################################################');
      console.warn('');
    }
  }

  // ── Handedness capture ────────────────────────────────────────────────────
  // Runs after games are done so a handedness failure never costs us the
  // game data we already captured. See captureHandednessForTeam above.
  await captureHandednessForTeam(page, team, teamId, resolvedTeamUrl);

  return true;
}

// ─── Team Processing ──────────────────────────────────────────────────────────

async function clickBestTeamResult(page, team, teamId, searchTerm, debugInfo, teamUrlCache) {
  const best = await chooseBestTeamResult(page, team, searchTerm, debugInfo);
  if (!best) return false;

  console.log("");
  console.log("Clicking best team result...");
  await best.locator.click();

  try {
    await page.waitForLoadState("networkidle", { timeout: 15000 });
  } catch {
    // Not fatal.
  }

  await page.waitForTimeout(3000);
  await dismissDontMissOutPopup(page);

  const currentUrl = page.url();
  console.log(`Opened URL: ${currentUrl}`);
  rememberTeamUrl(team, currentUrl, teamUrlCache);

  const scheduleClicked = await openSchedulePage(page, 'selected team result');
  if (!scheduleClicked) return false;

  return await captureAllCompletedGamesFromSchedule(page, team, teamId, currentUrl);
}

async function processTeamFromKnownUrl(page, team, teamId, knownTeamUrl, teamUrlCache) {
  const url = normalizeTeamUrl(knownTeamUrl);
  if (!url) return false;

  console.log("");
  console.log("Known PSG Team URL found. Skipping search.");
  console.log(`Team: ${team.teamName}`);
  console.log(`URL: ${url}`);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  try {
    await page.waitForLoadState("networkidle", { timeout: 15000 });
  } catch {
    // GameChanger may keep background requests open.
  }

  await page.waitForTimeout(3000);
  await dismissDontMissOutPopup(page);
  const resolvedTeamUrl = page.url();
  rememberTeamUrl(team, resolvedTeamUrl, teamUrlCache);

  const scheduleClicked = await openSchedulePage(page, 'known team URL');
  if (!scheduleClicked) {
    console.log("Could not open Schedule page from known URL. Falling back to search.");
    return false;
  }

  return await captureAllCompletedGamesFromSchedule(page, team, teamId, resolvedTeamUrl);
}

async function processTeam(page, team, teamNumber, totalTeams, teamUrlCache) {
  console.log("");
  console.log("################################################################################");
  console.log(`Processing team ${teamNumber} of ${totalTeams}: ${team.teamName}`);
  console.log("################################################################################");

  // ── NEW: register/fetch team in DB ──
  console.log("[psg] Ensuring team exists in DB...");
  const teamId = await withTimeout(
    pipeline.ensureTeam(team),
    30000,
    "pipeline.ensureTeam"
  );
  console.log(`[psg] DB team id: ${teamId}`);

  const knownTeamUrl = getKnownTeamUrl(team, teamUrlCache);

  if (knownTeamUrl) {
    const processedFromUrl = await processTeamFromKnownUrl(page, team, teamId, knownTeamUrl, teamUrlCache);
    if (processedFromUrl) {
      console.log(`Finished team from known URL: ${team.teamName}`);
      return true;
    }
    console.log("Known URL did not work. Proceeding with normal search.");
  }

  const searchTerms = buildSearchTerms(team);
  const debugInfo = { searchAttempts: [] };

  console.log("");
  console.log("Search terms to try:");
  console.log("====================");
  for (const term of searchTerms) console.log(term);

  for (const searchTerm of searchTerms) {
    const searched = await submitTeamSearch(page, team, searchTerm);
    if (!searched) continue;

    if (await pageHasNoResults(page)) {
      console.log(`No results for: ${searchTerm}`);
      appendSearchAttemptDebug(debugInfo, searchTerm, [], []);
      continue;
    }

    const clicked = await clickBestTeamResult(page, team, teamId, searchTerm, debugInfo, teamUrlCache);
    if (clicked) {
      console.log(`Finished team: ${team.teamName}`);
      return true;
    }

    console.log(`Search term produced results but no confident match: ${searchTerm}`);
  }

  console.log("");
  console.log(`No confident PSG team match found for: ${team.teamName}`);
  console.log("Writing failure report and moving on to the next team.");
  await writeFailedMatchReport(team, searchTerms, debugInfo);
  return false;
}

// jobOrgId: the single, already-verified organization this whole batch
// run is trusted to act as (see requireJobOrgContext() in main()). Every
// team read from the spreadsheet is stamped with this same value -- the
// spreadsheet itself carries no per-row organization field, and this PR
// deliberately does not add one (see security/travel-tenant-isolation-write-path).
async function processTeamsFromSpreadsheet(page, jobOrgId) {
  console.log("");
  console.log("Reading teams from Google Sheet...");

  const teams = await getTeamsFromGoogleSheet();
  if (!teams.length) throw new Error("No teams found from Google Sheet.");

  console.log(`Loaded ${teams.length} team(s) from Google Sheet.`);

  const teamUrlCache = loadTeamUrlCache();
  console.log(`Loaded ${teamUrlCache.size} cached team URL entries from Team URLs.txt.`);

  const teamsToProcess = selectTeamsToProcess(teams)
    .map((team) => ({ ...team, orgId: jobOrgId }));
  console.log(`Teams selected for this run: ${teamsToProcess.length}`);

  for (let i = 0; i < teamsToProcess.length; i++) {
    const team = teamsToProcess[i];
    try {
      await processTeam(page, team, i + 1, teamsToProcess.length, teamUrlCache);
    } catch (error) {
      console.error("");
      console.error(`Error while processing team: ${team.teamName}`);
      console.error(error.message);
      console.error("Writing failure report and continuing to next team.");

      const searchTerms = buildSearchTerms(team);
      await writeFailedMatchReport(team, searchTerms, {
        searchAttempts: [{
          searchTerm: "Unhandled processing error",
          candidateCount: 0,
          candidates: [{
            score: -999,
            reasons: [error.message],
            hasTeamHref: false,
            textLength: 0,
            linkText: "",
            href: page.url(),
            cardText: ""
          }]
        }]
      });
    }
  }

  saveTeamUrlCache(teamUrlCache);
  console.log("");
  console.log("All selected teams have been processed and are ready for scouting.");
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

async function main() {
  // Security Slice T2: resolved once, before any GameChanger acquisition
  // or database access begins. Fails closed (throws) if the server (or a
  // trusted operator, for a bare CLI run) did not set JOBU_JOB_ORG_ID --
  // this process never infers an organization from GameChanger data, a
  // spreadsheet row, or "the only organization in the system."
  const jobOrgId = requireJobOrgContext();
  // Security Slice T3H: set immediately after org context is resolved and
  // before any output/ path is touched -- every output-path helper in this
  // file reads this rather than re-deriving org context itself.
  CURRENT_JOB_ORG_ID = jobOrgId;

  if (!fs.existsSync(STORAGE_STATE)) {
    throw new Error(`Missing auth file: ${STORAGE_STATE}. Run npm run login first.`);
  }

  resolveOrgOutputRoot(jobOrgId);
  failedMatchesDir();
  failedGameCapturesDir();

  // ── NEW: initialize pipeline / database ──
  pipeline.init(DB_PATH);
  console.log(`Voodoo Scout DB: ${DB_PATH}`);
  console.log(`Accepted PSG seasons: ${getAcceptedSeasonLabel()}`);
  console.log(`Screenshot fallback: ${SCREENSHOT_FALLBACK ? "ON" : "OFF (structured extraction only)"}`);

console.log('[browser] Launching Chromium...');
const browser = await chromium.launch({
  headless: process.env.NODE_ENV === 'production' ? true : false,
  slowMo:   process.env.NODE_ENV === 'production' ? 0 : 75,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
});
console.log('[browser] Chromium launched successfully.');

  const context = await browser.newContext({
    storageState: STORAGE_STATE,
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true
  });

  const page = await context.newPage();
  wirePageDiagnostics(page);

try {
    // If server passed a specific team via env vars, skip the Google Sheet entirely
    if (process.env.GC_TEST_TEAM_CONTAINS) {
      const team = {
        teamName:       process.env.GC_TEST_TEAM_CONTAINS,
        rawTeamName:    process.env.GC_TEST_TEAM_CONTAINS,
        gcSearchName:   process.env.GC_TEST_TEAM_CONTAINS,
        gcTeamUrl:      process.env.GC_TEAM_URL || "",
        pgTeamUrl:      "",
        age:            String(process.env.GC_TEAM_AGE || "").replace(/\D/g, ""),
        classification: process.env.GC_TEAM_AGE || "",
        from:           process.env.GC_TEAM_CITY || "",
        city:           process.env.GC_TEAM_CITY || "",
        state:          process.env.GC_TEAM_STATE || "",
        status:         "active",
        orgId:          jobOrgId,
      };
      const teamUrlCache = loadTeamUrlCache();
      await processTeam(page, team, 1, 1, teamUrlCache);
    } else {
      await processTeamsFromSpreadsheet(page, jobOrgId);
    }
  } finally {
    await browser.close();
  }
}

// Only auto-run main() when this file is executed directly
// (e.g. `node src/search-gamechanger-teams.js`). Without this guard,
// requiring this file as a module — as test-extract-plays.js does to
// get extractPlays() — triggered a full production scrape (reading the
// Google Sheet, launching its own browser, writing live games to
// Supabase) as an unwanted side effect of the require() call.
if (require.main === module) {
  main().catch((error) => {
    console.error("");
    console.error("PSG team search failed:");
    console.error(error.message);
    console.error(error.stack);
    console.error("");
    process.exit(1);
  });
}

// ─── Entry Point: scrape a single team by DB record (no Google Sheet) ─────────
async function scrapeTeamById(teamRecord) {
  // Security Slice T2: same fail-closed contract as main() above -- resolved
  // once, before any acquisition begins, never inferred from teamRecord.
  const jobOrgId = requireJobOrgContext();
  // Security Slice T3H: same as main() above -- set before any output/ path
  // is touched.
  CURRENT_JOB_ORG_ID = jobOrgId;

  // teamRecord should have: { id, team_name, gc_team_url, age_group }
  if (!fs.existsSync(STORAGE_STATE)) {
    throw new Error(`Missing auth file: ${STORAGE_STATE}. Run npm run login first.`);
  }

  resolveOrgOutputRoot(jobOrgId);
  failedMatchesDir();
  failedGameCapturesDir();

  pipeline.init(DB_PATH);

console.log('[browser] Launching Chromium...');
const browser = await chromium.launch({
  headless: true,
  slowMo: 0,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process']
});
console.log('[browser] Chromium launched successfully.');

  const context = await browser.newContext({
    storageState: STORAGE_STATE,
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true
  });

  const page = await context.newPage();
  wirePageDiagnostics(page);

  // Build a team object that matches what processTeam() expects
  const team = {
    teamName:     teamRecord.team_name,
    rawTeamName:  teamRecord.team_name,
    gcSearchName: teamRecord.team_name,
    gcTeamUrl:    teamRecord.gc_team_url || "",
    pgTeamUrl:    teamRecord.pg_team_url || "",
    age:          String(teamRecord.age_group || "").replace(/\D/g, ""),
    classification: teamRecord.age_group || "",
    from:         teamRecord.city || "",
    city:         teamRecord.city || "",
    state:        teamRecord.state || "",
    status:       "active",
    orgId:        jobOrgId,
  };

  const teamUrlCache = loadTeamUrlCache();

  try {
    console.log(`Accepted PSG seasons: ${getAcceptedSeasonLabel()}`);
    console.log(`Screenshot fallback: ${SCREENSHOT_FALLBACK ? "ON" : "OFF (structured extraction only)"}`);
    await processTeam(page, team, 1, 1, teamUrlCache);
  } finally {
    await browser.close();
  }
}

// ── Exports for scrape-game-urls.js and src/high-school-gc-import.js ────────
// The High School GameChanger ingestion adapter (src/high-school-gc-import.js)
// reuses the pure DOM-extraction and schedule-discovery functions below
// unmodified -- GameChanger's page structure (box-score AG-Grid, plays feed,
// completed-game score-badge convention) is the same regardless of team
// type, per the compatibility analysis in that module's own header comment.
// Nothing about these three additional exports changes any existing
// behavior for scrape-game-urls.js or this file's own CLI entry point --
// this is strictly additive to the export object.
if (require.main !== module) {
  module.exports = {
    extractGameData,
    extractGameHeader,
    extractBoxScore,
    extractPlays,
    extractGameIdFromUrl,
    AUTHORITATIVE_SCHEDULE_ORIGIN,
    isAuthoritativeScheduleOrigin,
    getTeamOutputDir,
    scrapeTeamById,   // ← add this
    normalizeTeamUrl,
    getVisibleCompletedGameCount,
    getVisibleCompletedGameEntries,
    getVisibleScheduleEntries,
    SCHEDULE_EXTRACTION_MODES,
    SCHEDULE_ENTRY_STATUSES,
    EXPLICIT_ROW_ROOT_SELECTOR,
    DATE_HEADER_SELECTOR,
    GAME_DATE_SELECTOR,
    parseScheduleHeaderText,
    parseStructuredHeaderDate,
    DATE_RESOLUTION_STATUSES,
    DATE_SOURCE_KINDS,
    resolveScheduleEntryDate,
    isRealCalendarDate,
    normalizeScheduleDateText,
    classifyScheduleEntryStatus,
    parseScheduledTimeText,
    parseHomeAway,
    parseCounterpartyName,
    parseGameNumber,
    setCurrentJobOrgId,
  };
}