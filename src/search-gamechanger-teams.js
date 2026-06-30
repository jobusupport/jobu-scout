require("dotenv").config();

const { chromium } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { getTeamsFromGoogleSheet } = require("./read-teams-from-sheet");
const pipeline = require("./pipeline");

// ─── Constants ────────────────────────────────────────────────────────────────

const STORAGE_STATE = path.join(__dirname, "..", "storage", "gamechanger-auth.json");
const TEST_TEAM_CONTAINS = process.env.GC_TEST_TEAM_CONTAINS || "";
const OUTPUT_DIR = path.join(__dirname, "..", "output");
const FAILED_MATCHES_DIR = path.join(OUTPUT_DIR, "_failed-team-matches");
const FAILED_GAME_CAPTURES_DIR = path.join(OUTPUT_DIR, "_failed-game-captures");
const GC_GAME_MAX_ATTEMPTS = Math.max(1, Number(process.env.GC_GAME_MAX_ATTEMPTS || 3));
const GC_GAME_EXTRACTION_TIMEOUT_MS = Math.max(30000, Number(process.env.GC_GAME_EXTRACTION_TIMEOUT_MS || 180000));
const GC_GAME_DB_WRITE_TIMEOUT_MS = Math.max(30000, Number(process.env.GC_GAME_DB_WRITE_TIMEOUT_MS || 90000));
const TEAM_URLS_FILE = path.join(OUTPUT_DIR, "Team URLs.txt");
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
  if (!fs.existsSync(TEAM_URLS_FILE)) return cache;

  const text = fs.readFileSync(TEAM_URLS_FILE, "utf8");
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
  ensureDirectory(OUTPUT_DIR);
  const rows = Array.from(cache.entries())
    .filter(([teamName, teamUrl]) => teamName && teamUrl)
    .sort((a, b) => a[0].localeCompare(b[0]));

  const lines = ["Team Name\tGameChanger Team URL"];
  for (const [teamName, teamUrl] of rows) {
    lines.push(`${teamName}\t${teamUrl}`);
  }

  fs.writeFileSync(TEAM_URLS_FILE, lines.join("\n"), "utf8");
  console.log(`Updated Team URLs file: ${TEAM_URLS_FILE}`);
}

function getKnownTeamUrl(team, teamUrlCache) {
  const sheetUrl = normalizeTeamUrl(team.gcTeamUrl);
  if (sheetUrl) {
    console.log(`Found GC Team URL in spreadsheet: ${sheetUrl}`);
    return sheetUrl;
  }
  const keys = getTeamCacheKeys(team);
  for (const key of keys) {
    const cachedUrl = normalizeTeamUrl(teamUrlCache.get(key));
    if (cachedUrl) {
      console.log(`Found GC Team URL in Team URLs.txt cache: ${cachedUrl}`);
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
  const dir = path.join(OUTPUT_DIR, folderName);
  ensureDirectory(dir);
  return dir;
}

function getFailedMatchReportPath(team) {
  ensureDirectory(FAILED_MATCHES_DIR);
  const baseName = sanitizeFileNameCompact(team.teamName || team.rawTeamName || "unknown-team");
  return path.join(FAILED_MATCHES_DIR, `${baseName}.txt`);
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
  console.log(`Searching GameChanger for: ${searchTerm}`);
  console.log(`Raw spreadsheet name: ${team.rawTeamName}`);
  console.log(`Clean team name: ${team.teamName}`);
  console.log(`GC search name: ${team.gcSearchName || "Not provided"}`);
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
    console.log(`[gc] Opening schedule URL directly: ${directScheduleUrl}`);
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

  console.log('[gc] No direct schedule href found. Falling back to clicking the Schedule tab.');
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
    console.log('Clicking it to switch plays into Chronological order...');
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

function extractGameIdFromUrl(url) {
  const match = String(url || "").match(/\/schedule\/([^/?#]+)/i);
  return match ? match[1] : "";
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

      console.log(`Found completed game #${targetIndex + 1}: ${scoreText}`);

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
      console.log(`Opened completed game page: ${page.url()}`);
      return true;
    } catch {
      // Try next item.
    }
  }

  console.log(`No completed game found at index ${targetIndex}.`);
  return false;
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

    return {
      dateTime:       dateMatch ? dateMatch[0] : null,
      result:         scoreMatch ? scoreMatch[1] : null,
      scoreUs:        scoreMatch ? scoreMatch[2] : null,
      scoreThem:      scoreMatch ? scoreMatch[3] : null,
      teamCandidates,
      pageUrl:        window.location.href
    };
  });
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

async function extractPlays(page) {
  console.log("Extracting play-by-play from DOM...");

  await clickTabByName(page, "Plays");
  await page.waitForTimeout(1500);
  await selectChronologicalPlaysOrder(page);
  await page.waitForTimeout(1500);
  await autoScrollToLoadAll(page);

  const plays = await page.evaluate(() => {
    const results = [];
    const seen = new Set();
    const playSelectors = ['[class*="play"]','[class*="Play"]','[class*="event"]','[data-testid*="play"]',"li"];

    for (const selector of playSelectors) {
      for (const el of document.querySelectorAll(selector)) {
        const text = String(el.innerText || "").replace(/\s+/g, " ").trim();
        const looksLikePlay = /\b(single|double|triple|home run|strikeout|walk|fly out|ground out|pop out|line out|hit by pitch|stolen base|wild pitch|passed ball|balk|error|fielder.s choice|sacrifice|inning)\b/i.test(text);
        if (!looksLikePlay || text.length < 5 || text.length > 500 || seen.has(text)) continue;
        seen.add(text);

        let inning = null;
        let node = el.parentElement;
        for (let depth = 0; depth < 8 && node; depth++) {
          const parentText = String(node.innerText || "");
          const inningMatch = parentText.match(/\b(Top|Bottom|Mid|End)\s+(\d+)\b/i);
          if (inningMatch) { inning = `${inningMatch[1]} ${inningMatch[2]}`; break; }
          node = node.parentElement;
        }

        results.push({ inning, text });
      }
      if (results.length > 20) break;
    }

    return results;
  });

  console.log(`  Extracted ${plays.length} play-by-play events`);
  return plays;
}

// ─── Main Game Extraction (replaces captureBoxScoreAndPlays) ─────────────────

async function extractGameData(page, team) {
  const teamDir = getTeamOutputDir(team);
  const gameUrl = page.url();
  const gameId  = extractGameIdFromUrl(gameUrl);

  console.log("");
  console.log("Starting structured data extraction (HTML, no OCR)...");

  const header   = await extractGameHeader(page);
  const boxScore = await extractBoxScore(page);
  const plays    = await extractPlays(page);

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
      capturedAt:  new Date().toISOString(),
      ...header
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

    return (
      (normalizedGameId && dbGameId && normalizedGameId === dbGameId) ||
      (normalizedGameId && dbUrlGameId && normalizedGameId === dbUrlGameId) ||
      (normalizedUrlGameId && dbGameId && normalizedUrlGameId === dbGameId) ||
      (normalizedUrl && dbUrl && normalizedUrl === dbUrl)
    );
  });
}

async function loadKnownCompleteDbGames(teamId) {
  if (!pipeline.getKnownCompleteGamesForTeam) {
    console.log('[gc] DB completed-game lookup is not available. Falling back to schedule scan.');
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

  console.log(`[gc] Complete games in DB for this team: ${dbCompleteCount}`);
  console.log(`[gc] Completed games visible on GameChanger: ${completedGameCount}`);

  if (dbCompleteCount === 0) {
    console.log('[gc] No completed games found in DB. Starting at GameChanger completed game #1.');
    return 0;
  }

  if (completedGameCount <= dbCompleteCount) {
    console.log('[gc] DB already has at least as many complete games as GameChanger shows. No new games to scrape.');
    return completedGameCount;
  }

  const verifyIndex = Math.min(dbCompleteCount - 1, completedGameCount - 1);
  console.log(`[gc] Incremental scrape check: verifying GameChanger game #${verifyIndex + 1} is already in DB...`);

  const opened = await clickCompletedGameFromScheduleByIndex(page, verifyIndex);
  if (!opened) {
    console.log('[gc] Could not open the DB boundary game. Falling back to a full schedule scan.');
    return 0;
  }

  const verifyUrl = page.url();
  const verifyGameId = extractGameIdFromUrl(verifyUrl);
  const matchesDb = dbGameMatchesPageGame(knownDbGames, verifyGameId, verifyUrl);

  console.log(`[gc] Boundary GameChanger game id: ${verifyGameId || '(none)'}`);
  console.log(`[gc] Boundary game is in DB: ${matchesDb ? 'YES' : 'NO'}`);

  const returned = await clickBackToSchedule(page);
  if (!returned) {
    console.log('[gc] Could not return to schedule after DB boundary check. Falling back to current page handling.');
    return 0;
  }

  if (matchesDb) {
    const startIndex = dbCompleteCount;
    console.log(`[gc] Incremental scrape confirmed. Starting with new GameChanger game #${startIndex + 1}.`);
    return startIndex;
  }

  console.log('[gc] DB boundary did not match the GameChanger schedule. Falling back to a full scan with DB duplicate checks.');
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
    ensureDirectory(FAILED_GAME_CAPTURES_DIR);
    const teamName = sanitizeFileNameCompact(team.teamName || team.rawTeamName || 'unknown-team');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `${teamName}-game-${gameIndex + 1}-${phase}-${stamp}`;
    const txtPath = path.join(FAILED_GAME_CAPTURES_DIR, `${base}.txt`);
    const pngPath = path.join(FAILED_GAME_CAPTURES_DIR, `${base}.png`);

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
    console.log(`[gc] Wrote failed game report: ${txtPath}`);

    try {
      if (page && !page.isClosed()) {
        await page.screenshot({ path: pngPath, fullPage: true, timeout: 15000 });
        console.log(`[gc] Wrote failed game screenshot: ${pngPath}`);
      }
    } catch (screenshotError) {
      console.log(`[gc] Could not capture failure screenshot: ${screenshotError.message}`);
    }
  } catch (reportError) {
    console.log(`[gc] Could not write failed game report: ${reportError.message}`);
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
    console.log(`[gc] Back-to-schedule click failed during ${label}: ${error.message}`);
  }

  if (scheduleUrl) {
    try {
      console.log(`[gc] Reloading schedule URL after ${label}: ${scheduleUrl}`);
      await page.goto(scheduleUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
      await page.waitForTimeout(1500);
      await dismissDontMissOutPopup(page);
      return true;
    } catch (error) {
      console.log(`[gc] Schedule reload failed during ${label}: ${error.message}`);
    }
  }

  return false;
}

async function processOneCompletedGame(page, team, teamId, gameIndex, manifest, knownDbGames, scheduleUrl) {
  let phase = 'open-game';
  const gameOpened = await withTimeout(
    clickCompletedGameFromScheduleByIndex(page, gameIndex),
    90000,
    `open completed game #${gameIndex + 1}`
  );

  if (!gameOpened) {
    console.log(`[gc] Could not open completed game #${gameIndex + 1}. Skipping this game and continuing.`);
    return { status: 'open_failed' };
  }

  const gameUrl = page.url();
  const gameId  = extractGameIdFromUrl(gameUrl);
  console.log(`[gc] Opened GameChanger game #${gameIndex + 1}: ${gameId || gameUrl}`);

  phase = 'db-duplicate-check';
  if (dbGameMatchesPageGame(knownDbGames, gameId, gameUrl)) {
    console.log(`[gc] Skipping game already complete in DB: ${gameId || gameUrl}`);
    return { status: 'skipped_db', gameId, gameUrl };
  }

  phase = 'manifest-duplicate-check';
  if (isGameAlreadyProcessed(manifest.processedGames, gameId)) {
    console.log(`Skipping already processed game: ${gameId || gameUrl}`);
    return { status: 'skipped_manifest', gameId, gameUrl };
  }

  phase = 'extract-game-data';
  const captureResult = await withTimeout(
    extractGameData(page, team),
    GC_GAME_EXTRACTION_TIMEOUT_MS,
    `extractGameData game #${gameIndex + 1}`
  );

  if (!captureResult || !captureResult.success) {
    console.log(`[gc] Capture failed for completed game #${gameIndex + 1}.`);
    return { status: 'capture_failed', gameId, gameUrl };
  }

  phase = 'db-write';
  console.log('[gc] Writing extracted game to DB...');
  const dbWriteResult = await withTimeout(
    pipeline.processExtractResult(captureResult, teamId),
    GC_GAME_DB_WRITE_TIMEOUT_MS,
    `pipeline.processExtractResult game #${gameIndex + 1}`
  );

  if (!dbWriteResult || dbWriteResult.success === false) {
    const error = dbWriteResult?.error || 'unknown error';
    console.warn(`[gc] DB write did not complete cleanly: ${error}`);
    console.warn('[gc] Not marking this game as processed because the DB write failed.');
    return { status: 'db_failed', gameId, gameUrl, error };
  }

  console.log('[gc] DB write complete.');

  phase = 'manifest-update';
  manifest.processedGames.push({
    gameId,
    gameUrl,
    capturedAt:    new Date().toISOString(),
    jsonFile:      captureResult.jsonFile      || '',
    boxScoreFile:  captureResult.boxScoreFile  || ''
  });

  saveProcessedGames(manifest.manifestPath, manifest.processedGames);
  console.log(`Updated processed-games manifest: ${manifest.manifestPath}`);

  knownDbGames.push({
    gcGameId: gameId || extractGameIdFromUrl(gameUrl) || '',
    gcGameUrl: gameUrl || '',
  });

  return { status: 'processed', gameId, gameUrl };
}

async function captureAllCompletedGamesFromSchedule(page, team, teamId) {
  console.log('');
  console.log('Starting completed-game capture loop...');
  console.log(`[gc] Per-game retry limit: ${GC_GAME_MAX_ATTEMPTS}`);
  console.log(`[gc] Extraction timeout: ${GC_GAME_EXTRACTION_TIMEOUT_MS}ms`);
  console.log(`[gc] DB write timeout: ${GC_GAME_DB_WRITE_TIMEOUT_MS}ms`);

  const teamDir = getTeamOutputDir(team);
  const manifest = loadProcessedGames(teamDir);
  let knownDbGames = await loadKnownCompleteDbGames(teamId);
  let gameIndex = null;
  let scheduleUrl = page.url();
  const failures = [];
  const processed = [];
  const skipped = [];

  while (true) {
    try {
      await dismissDontMissOutPopup(page);
    } catch (error) {
      console.log(`[gc] Popup dismissal failed but continuing: ${error.message}`);
    }

    let completedGameCount = 0;
    try {
      completedGameCount = await withTimeout(
        getVisibleCompletedGameCount(page),
        45000,
        'getVisibleCompletedGameCount'
      );
    } catch (error) {
      console.error(`[gc] Could not count completed games on schedule: ${error.message}`);
      await writeFailedGameCaptureReport(page, team, gameIndex || 0, 'count-completed-games', error, { scheduleUrl });
      const recovered = await returnToScheduleSafely(page, scheduleUrl, 'count completed games recovery');
      if (!recovered) throw error;
      completedGameCount = await getVisibleCompletedGameCount(page);
    }

    console.log(`Visible completed games on schedule: ${completedGameCount}`);

    if (completedGameCount === 0) {
      console.log('No completed games found. Moving on.');
      return true;
    }

    if (gameIndex === null) {
      gameIndex = await chooseIncrementalStartIndex(page, teamId, completedGameCount, knownDbGames);
      await returnToScheduleSafely(page, scheduleUrl, 'after incremental boundary check');
      scheduleUrl = page.url().includes('/schedule') ? page.url() : scheduleUrl;
    }

    if (gameIndex >= completedGameCount) {
      console.log('No more completed games to process for this team.');
      if (failures.length) {
        console.warn(`[gc] Completed schedule scan with ${failures.length} failed game(s). Failed games were not marked processed and will be retried on the next run.`);
        for (const f of failures) console.warn(`[gc] Failed game #${f.gameNumber}: ${f.status || f.error}`);
      }
      console.log(`[gc] Summary: processed=${processed.length}, skipped=${skipped.length}, failed=${failures.length}`);
      return true;
    }

    let attempt = 1;
    let finishedThisIndex = false;
    let lastStatus = null;

    while (attempt <= GC_GAME_MAX_ATTEMPTS && !finishedThisIndex) {
      console.log('');
      console.log(`[gc] Processing completed game #${gameIndex + 1} of ${completedGameCount} (attempt ${attempt}/${GC_GAME_MAX_ATTEMPTS})...`);
      try {
        const result = await processOneCompletedGame(page, team, teamId, gameIndex, manifest, knownDbGames, scheduleUrl);
        lastStatus = result.status;

        if (result.status === 'processed') processed.push(result);
        else if (result.status && result.status.startsWith('skipped')) skipped.push(result);
        else failures.push({ gameNumber: gameIndex + 1, ...result });

        finishedThisIndex = true;
      } catch (error) {
        lastStatus = error.message;
        console.error(`[gc] Error processing completed game #${gameIndex + 1} attempt ${attempt}: ${error.message}`);
        console.error(getErrorMessage(error));
        await writeFailedGameCaptureReport(page, team, gameIndex, `attempt-${attempt}`, error, { scheduleUrl });

        if (attempt >= GC_GAME_MAX_ATTEMPTS) {
          failures.push({ gameNumber: gameIndex + 1, error: error.message });
          console.warn(`[gc] Giving up on completed game #${gameIndex + 1} after ${GC_GAME_MAX_ATTEMPTS} attempt(s). Continuing to the next game.`);
          finishedThisIndex = true;
        }
      } finally {
        const returned = await returnToScheduleSafely(page, scheduleUrl, `game #${gameIndex + 1} attempt ${attempt}`);
        if (!returned) {
          const err = new Error(`Could not return to schedule after game #${gameIndex + 1} attempt ${attempt}. Last status: ${lastStatus || 'unknown'}`);
          console.error(`[gc] ${err.message}`);
          await writeFailedGameCaptureReport(page, team, gameIndex, `return-to-schedule-attempt-${attempt}`, err, { scheduleUrl });
          if (attempt >= GC_GAME_MAX_ATTEMPTS) {
            failures.push({ gameNumber: gameIndex + 1, error: err.message });
            finishedThisIndex = true;
          }
        }
      }

      attempt++;
    }

    gameIndex++;
  }
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

  return await captureAllCompletedGamesFromSchedule(page, team, teamId);
}

async function processTeamFromKnownUrl(page, team, teamId, knownTeamUrl, teamUrlCache) {
  const url = normalizeTeamUrl(knownTeamUrl);
  if (!url) return false;

  console.log("");
  console.log("Known GameChanger Team URL found. Skipping search.");
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
  rememberTeamUrl(team, page.url(), teamUrlCache);

  const scheduleClicked = await openSchedulePage(page, 'known team URL');
  if (!scheduleClicked) {
    console.log("Could not open Schedule page from known URL. Falling back to search.");
    return false;
  }

  return await captureAllCompletedGamesFromSchedule(page, team, teamId);
}

async function processTeam(page, team, teamNumber, totalTeams, teamUrlCache) {
  console.log("");
  console.log("################################################################################");
  console.log(`Processing team ${teamNumber} of ${totalTeams}: ${team.teamName}`);
  console.log("################################################################################");

  // ── NEW: register/fetch team in DB ──
  console.log("[gc] Ensuring team exists in DB...");
  const teamId = await withTimeout(
    pipeline.ensureTeam(team),
    30000,
    "pipeline.ensureTeam"
  );
  console.log(`[gc] DB team id: ${teamId}`);

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
  console.log(`No confident GameChanger team match found for: ${team.teamName}`);
  console.log("Writing failure report and moving on to the next team.");
  await writeFailedMatchReport(team, searchTerms, debugInfo);
  return false;
}

async function processTeamsFromSpreadsheet(page) {
  console.log("");
  console.log("Reading teams from Google Sheet...");

  const teams = await getTeamsFromGoogleSheet();
  if (!teams.length) throw new Error("No teams found from Google Sheet.");

  console.log(`Loaded ${teams.length} team(s) from Google Sheet.`);

  const teamUrlCache = loadTeamUrlCache();
  console.log(`Loaded ${teamUrlCache.size} cached team URL entries from Team URLs.txt.`);

  const teamsToProcess = selectTeamsToProcess(teams);
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
  if (!fs.existsSync(STORAGE_STATE)) {
    throw new Error(`Missing auth file: ${STORAGE_STATE}. Run npm run login first.`);
  }

  ensureDirectory(OUTPUT_DIR);
  ensureDirectory(FAILED_MATCHES_DIR);
  ensureDirectory(FAILED_GAME_CAPTURES_DIR);

  // ── NEW: initialize pipeline / database ──
  pipeline.init(DB_PATH);
  console.log(`Voodoo Scout DB: ${DB_PATH}`);
  console.log(`Accepted GameChanger seasons: ${getAcceptedSeasonLabel()}`);
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
        status:         "active"
      };
      const teamUrlCache = loadTeamUrlCache();
      await processTeam(page, team, 1, 1, teamUrlCache);
    } else {
      await processTeamsFromSpreadsheet(page);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("");
  console.error("GameChanger team search failed:");
  console.error(error.message);
  console.error(error.stack);
  console.error("");
  process.exit(1);
});

// ─── Entry Point: scrape a single team by DB record (no Google Sheet) ─────────
async function scrapeTeamById(teamRecord) {
  // teamRecord should have: { id, team_name, gc_team_url, age_group }
  if (!fs.existsSync(STORAGE_STATE)) {
    throw new Error(`Missing auth file: ${STORAGE_STATE}. Run npm run login first.`);
  }

  ensureDirectory(OUTPUT_DIR);
  ensureDirectory(FAILED_MATCHES_DIR);
  ensureDirectory(FAILED_GAME_CAPTURES_DIR);

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
    status:       "active"
  };

  const teamUrlCache = loadTeamUrlCache();

  try {
    console.log(`Accepted GameChanger seasons: ${getAcceptedSeasonLabel()}`);
    console.log(`Screenshot fallback: ${SCREENSHOT_FALLBACK ? "ON" : "OFF (structured extraction only)"}`);
    await processTeam(page, team, 1, 1, teamUrlCache);
  } finally {
    await browser.close();
  }
}

// ── Exports for scrape-game-urls.js ──────────────────────────────────────────
if (require.main !== module) {
  module.exports = {
    extractGameData,
    extractGameHeader,
    extractBoxScore,
    extractPlays,
    extractGameIdFromUrl,
    getTeamOutputDir,
    scrapeTeamById,   // ← add this
  };
}