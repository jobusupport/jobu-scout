require("dotenv").config();

const { chromium } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { getTeamsFromGoogleSheet } = require("./read-teams-from-sheet");

const STORAGE_STATE = path.join(__dirname, "..", "storage", "gamechanger-auth.json");
const TEST_TEAM_CONTAINS = process.env.GC_TEST_TEAM_CONTAINS || "";
const OUTPUT_DIR = path.join(__dirname, "..", "output");
const FAILED_MATCHES_DIR = path.join(OUTPUT_DIR, "_failed-team-matches");
const TEAM_URLS_FILE = path.join(OUTPUT_DIR, "Team URLs.txt");

const TARGET_SEASON_YEAR = process.env.GC_TARGET_YEAR || "2026";
const TARGET_SEASON_WORDS = (process.env.GC_ACCEPTED_SEASONS || "spring,summer")
  .split(",")
  .map((season) => season.trim().toLowerCase())
  .filter(Boolean);

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}
function normalizeTeamUrl(url) {
  const value = String(url || "").trim();

  if (!value) return "";

  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }

  if (value.startsWith("/teams/")) {
    return `https://web.gc.com${value}`;
  }

  if (value.startsWith("teams/")) {
    return `https://web.gc.com/${value}`;
  }

  return value;
}

function getTeamCacheKeys(team) {
  const keys = new Set();

  const values = [
    team.teamName,
    team.rawTeamName,
    team.gcSearchName
  ];

  for (const value of values) {
    const normalized = normalizeText(value);

    if (normalized) {
      keys.add(normalized);
    }
  }

  return Array.from(keys);
}

function loadTeamUrlCache() {
  const cache = new Map();

  if (!fs.existsSync(TEAM_URLS_FILE)) {
    return cache;
  }

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

      if (teamName && teamUrl) {
        cache.set(normalizeText(teamName), teamUrl);
      }

      continue;
    }

    const equalsParts = trimmed.split("=");

    if (equalsParts.length >= 2) {
      const teamName = equalsParts[0].trim();
      const teamUrl = normalizeTeamUrl(equalsParts.slice(1).join("=").trim());

      if (teamName && teamUrl) {
        cache.set(normalizeText(teamName), teamUrl);
      }
    }
  }

  return cache;
}

function saveTeamUrlCache(cache) {
  ensureDirectory(OUTPUT_DIR);

  const rows = Array.from(cache.entries())
    .filter(([teamName, teamUrl]) => teamName && teamUrl)
    .sort((a, b) => a[0].localeCompare(b[0]));

  const lines = [];

  lines.push("Team Name\tGameChanger Team URL");

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

  if (displayName) {
    teamUrlCache.set(normalizeText(displayName), normalizedUrl);
  }

  const keys = getTeamCacheKeys(team);

  for (const key of keys) {
    teamUrlCache.set(key, normalizedUrl);
  }

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
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function uniqueFilePath(filePath) {
  if (!fs.existsSync(filePath)) {
    return filePath;
  }

  const parsed = path.parse(filePath);

  for (let i = 2; i < 1000; i++) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${i}${parsed.ext}`);

    if (!fs.existsSync(candidate)) {
      return candidate;
    }
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

  const baseName = sanitizeFileNameCompact(
    team.teamName || team.rawTeamName || "unknown-team"
  );

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
    const cleaned = String(value || "")
      .replace(/\s+/g, " ")
      .trim();

    if (cleaned.length >= 3) {
      terms.add(cleaned);
    }
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

  addTerm(
    raw
      .replace(/\s+-\s+.*$/i, "")
      .replace(/\bNational\b/gi, "")
  );

  addTerm(
    raw
      .replace(/\s+-\s+.*$/i, "")
      .replace(/\bNational\b/gi, "")
      .replace(/\b\d{1,2}\s*U\b/gi, "")
  );

  addTerm(
    beforeDash
      .replace(/\b\d{1,2}\s*U\b/gi, "")
      .replace(/\b(AL|GA|TN|MS|FL|TX|LA|NC|SC|KY)\b/gi, "")
  );

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
  if (teamSuffixMatch) {
    addTerm(teamSuffixMatch[0]);
  }

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

  const partialWords = target
    .split(" ")
    .filter((word) => word.length >= 3);

  const scored = teams
    .map((team) => {
      const combined = normalizeText(
        `${team.rawTeamName} ${team.teamName} ${team.gcSearchName || ""} ${team.classification} ${team.from} ${team.city}`
      );

      let score = 0;

      for (const word of partialWords) {
        if (combined.includes(word)) {
          score += 1;
        }
      }

      return {
        team,
        score
      };
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

  await page.goto(searchUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

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

      if (looksLikeResult && reasonableSize) {
        bestText = text;
      }

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

      if (!box || box.width < 100 || box.height < 10) {
        return;
      }

      const href = hrefOverride || (await locator.getAttribute("href").catch(() => "")) || "";
      const cardText = await getResultTextFromElement(locator);

      const fullText = normalizeText(`${cardText} ${href}`);

      if (!fullText) return;

      if (
        fullText.includes("home") &&
        fullText.includes("support") &&
        fullText.includes("get the app")
      ) {
        return;
      }

      const hasAnyAllowedSeasonWord = TARGET_SEASON_WORDS.some((season) =>
        fullText.includes(season)
      );

      if (
        !hasAnyAllowedSeasonWord &&
        !fullText.includes(TARGET_SEASON_YEAR) &&
        !/\b\d{1,2}u\b/i.test(fullText) &&
        !fullText.includes("staff") &&
        !fullText.includes("players")
      ) {
        return;
      }

      const hasTeamHref = Boolean(href && href.toLowerCase().includes("/teams/"));
      const key = `${href}|${cardText}`;

      if (seen.has(key)) {
        return;
      }

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
    const candidate = fallbackCandidates.nth(i);
    await addCandidate(candidate);
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

  const hasAllowedSeason = TARGET_SEASON_WORDS.some((season) =>
    text.includes(season)
  );

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

  return {
    score,
    reasons,
    rawText: fullTextRaw
  };
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

  for (const term of searchTerms) {
    lines.push(`- ${term}`);
  }

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
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      if (Number(b.hasTeamHref) !== Number(a.hasTeamHref)) {
        return Number(b.hasTeamHref) - Number(a.hasTeamHref);
      }

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

async function getVisibleCompletedGameCount(page) {
  const completedGameRegex = /\b[WL]\s*\d+\s*[-–—]\s*\d+\b/i;
  const scoreLocator = page.getByText(completedGameRegex);

  const count = await scoreLocator.count();
  let visibleCount = 0;

  for (let i = 0; i < count; i++) {
    const item = scoreLocator.nth(i);

    try {
      const box = await item.boundingBox();

      if (box && box.width > 0 && box.height > 0) {
        visibleCount++;
      }
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

  if (!fs.existsSync(manifestPath)) {
    return {
      manifestPath,
      processedGames: []
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    if (!Array.isArray(parsed.processedGames)) {
      parsed.processedGames = [];
    }

    return {
      manifestPath,
      processedGames: parsed.processedGames
    };
  } catch {
    return {
      manifestPath,
      processedGames: []
    };
  }
}

function saveProcessedGames(manifestPath, processedGames) {
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ processedGames }, null, 2),
    "utf8"
  );
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

      if (!box || box.width <= 0 || box.height <= 0) {
        continue;
      }

      const scoreText = await item.innerText().catch(() => "");

      if (visibleIndex !== targetIndex) {
        visibleIndex++;
        continue;
      }

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

            if (
              tagName === "a" ||
              tagName === "button" ||
              role === "button" ||
              role === "link" ||
              typeof node.onclick === "function"
            ) {
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

async function captureAllCompletedGamesFromSchedule(page, team) {
  console.log("");
  console.log("Starting completed-game capture loop...");

  const teamDir = getTeamOutputDir(team);
  const manifest = loadProcessedGames(teamDir);

  let gameIndex = 0;

  while (true) {
    await dismissDontMissOutPopup(page);

    const completedGameCount = await getVisibleCompletedGameCount(page);

    console.log(`Visible completed games on schedule: ${completedGameCount}`);

    if (completedGameCount === 0) {
      console.log("No completed games found. Moving on.");
      return true;
    }

    if (gameIndex >= completedGameCount) {
      console.log("No more completed games to process for this team.");
      return true;
    }

    const gameOpened = await clickCompletedGameFromScheduleByIndex(page, gameIndex);

    if (!gameOpened) {
      console.log(`Could not open completed game #${gameIndex + 1}. Moving on.`);
      return true;
    }

    const gameUrl = page.url();
    const gameId = extractGameIdFromUrl(gameUrl);

    if (isGameAlreadyProcessed(manifest.processedGames, gameId)) {
      console.log(`Skipping already processed game: ${gameId || gameUrl}`);

      const returned = await clickBackToSchedule(page);

      if (!returned) {
        console.log("Could not return to schedule after skipping duplicate game.");
        return false;
      }

      gameIndex++;
      continue;
    }

    const captureResult = await captureBoxScoreAndPlays(page, team);

    if (captureResult && captureResult.success) {
      manifest.processedGames.push({
        gameId,
        gameUrl,
        capturedAt: new Date().toISOString(),
        boxScoreFile: captureResult.boxScoreFile || "",
        playsFile: captureResult.playsFile || ""
      });

      saveProcessedGames(manifest.manifestPath, manifest.processedGames);
      console.log(`Updated processed-games manifest: ${manifest.manifestPath}`);
    } else {
      console.log(`Capture failed for completed game #${gameIndex + 1}. Returning to schedule if possible.`);
    }

    const returned = await clickBackToSchedule(page);

    if (!returned) {
      console.log("Could not return to schedule. Stopping completed-game loop.");
      return false;
    }

    gameIndex++;
  }
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

async function selectChronologicalPlaysOrder(page) {
  console.log("Checking play order...");

  await dismissDontMissOutPopup(page);

  const reverseChronologicalText = page
    .getByText(/reverse[-\s]?chronological/i)
    .first();

  try {
    await reverseChronologicalText.waitFor({
      state: "visible",
      timeout: 4000
    });

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

async function getGameFileBase(page) {
  const bodyText = await page.locator("body").innerText().catch(() => "");

  const dateMatch = bodyText.match(
    /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Z][a-z]+\s+\d{1,2},\s+\d{1,2}:\d{2}\s+[AP]M\s*[-–—]\s*\d{1,2}:\d{2}\s+[AP]M\s+[A-Z]{2}\b/i
  );

  const dateTimeRaw = dateMatch ? dateMatch[0] : "unknown-date-time";

  const lines = bodyText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const teamCandidates = [];

  for (const line of lines) {
    if (!/\b\d{1,2}U\b/i.test(line)) {
      continue;
    }

    if (/back to|box score|plays|videos|info|recap|schedule|lineup|team\b/i.test(line)) {
      continue;
    }

    if (/^\d+$/.test(line)) {
      continue;
    }

    const cleaned = line
      .replace(/\bFINAL\b/gi, "")
      .replace(/\bW\s*\d+\s*[-–—]\s*\d+\b/gi, "")
      .replace(/\bL\s*\d+\s*[-–—]\s*\d+\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    if (cleaned && !teamCandidates.includes(cleaned)) {
      teamCandidates.push(cleaned);
    }
  }

  const teamOne = teamCandidates[0] || "Team-One";
  const teamTwo = teamCandidates[1] || "Team-Two";

  const base = `${teamOne}-vs-${teamTwo}-${dateTimeRaw}`;

  return sanitizeFileNameCompact(base);
}

async function hideStickyElements(page) {
  await page.evaluate(() => {
    const existingStyle = document.getElementById("playwright-hide-sticky-elements");
    if (existingStyle) {
      return;
    }

    const style = document.createElement("style");
    style.id = "playwright-hide-sticky-elements";
    style.textContent = `
      [style*="position: sticky"],
      [style*="position: fixed"],
      .sticky,
      .fixed {
        position: static !important;
      }
    `;
    document.head.appendChild(style);
  });
}

async function restoreStickyElements(page) {
  await page.evaluate(() => {
    const style = document.getElementById("playwright-hide-sticky-elements");
    if (style) {
      style.remove();
    }
  });
}

async function hideFooterElements(page) {
  await page.evaluate(() => {
    const existingStyle = document.getElementById("playwright-hide-footer-elements");
    if (existingStyle) {
      return;
    }

    const style = document.createElement("style");
    style.id = "playwright-hide-footer-elements";
    style.textContent = `
      footer,
      [class*="footer" i],
      [data-testid*="footer" i] {
        display: none !important;
        visibility: hidden !important;
        height: 0 !important;
        min-height: 0 !important;
        max-height: 0 !important;
        overflow: hidden !important;
      }
    `;
    document.head.appendChild(style);

    const phrases = [
      "Get the App",
      "GameChanger is a proud member",
      "DICK'S Sporting Goods Family",
      "© GameChanger Media",
      "Status",
      "Privacy",
      "Terms",
      "CA Disclosures",
      "Your Privacy Choices"
    ];

    const allElements = Array.from(document.querySelectorAll("body *"));

    for (const element of allElements) {
      const text = String(element.innerText || "").replace(/\s+/g, " ").trim();

      if (!text) continue;

      const matchesFooterPhrase = phrases.some((phrase) => text.includes(phrase));

      if (!matchesFooterPhrase) continue;

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
    if (style) {
      style.remove();
    }

    const hiddenElements = Array.from(
      document.querySelectorAll('[data-playwright-footer-hidden="true"]')
    );

    for (const element of hiddenElements) {
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

      const canScroll =
        overflowY === "auto" ||
        overflowY === "scroll" ||
        overflowY === "overlay";

      return canScroll && element.scrollHeight > element.clientHeight + 50;
    }

    const allElements = Array.from(document.querySelectorAll("*"));

    const scrollableElements = allElements
      .filter(isScrollable)
      .map((element) => {
        const rect = element.getBoundingClientRect();

        return {
          element,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          scrollableAmount: element.scrollHeight - element.clientHeight,
          rectTop: rect.top,
          rectLeft: rect.left,
          rectWidth: rect.width,
          rectHeight: rect.height,
          textLength: (element.innerText || "").length
        };
      })
      .filter((item) => item.rectWidth > 500 && item.rectHeight > 300)
      .sort((a, b) => {
        if (b.scrollableAmount !== a.scrollableAmount) {
          return b.scrollableAmount - a.scrollableAmount;
        }

        return b.textLength - a.textLength;
      });

    if (scrollableElements.length > 0) {
      return scrollableElements[0].element;
    }

    return document.scrollingElement || document.documentElement || document.body;
  });
}

async function estimateRepeatedHeaderCropTop(page) {
  const cropTop = await page.evaluate(() => {
    function cleanText(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    const elements = Array.from(document.querySelectorAll("*"));

    const tabBarCandidates = elements
      .map((element) => {
        const text = cleanText(element.innerText);
        const rect = element.getBoundingClientRect();

        return {
          text,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height
        };
      })
      .filter((item) => {
        if (item.width < 500) return false;
        if (item.height < 20 || item.height > 120) return false;
        if (item.top < 0 || item.top > 600) return false;

        const text = item.text.toUpperCase();

        return (
          text.includes("RECAP") &&
          text.includes("BOX SCORE") &&
          text.includes("PLAYS") &&
          text.includes("VIDEOS") &&
          text.includes("INFO")
        );
      })
      .sort((a, b) => b.bottom - a.bottom);

    if (tabBarCandidates.length > 0) {
      return Math.ceil(tabBarCandidates[0].bottom + 8);
    }

    return 410;
  });

  console.log(`Estimated repeated header crop top: ${cropTop}px`);
  return cropTop;
}

async function captureScrollStitchedScreenshot(page, screenshotPath, description) {
  await dismissDontMissOutPopup(page);
  await page.waitForTimeout(1000);

  const finalScreenshotPath = uniqueFilePath(screenshotPath);

  console.log("");
  console.log(`Capturing scroll-stitched screenshot: ${description}`);
  console.log(`Destination: ${finalScreenshotPath}`);

  const tempDir = path.join(__dirname, "..", "temp-screenshots");
  ensureDirectory(tempDir);
  ensureDirectory(path.dirname(finalScreenshotPath));

  await hideStickyElements(page);
  await hideFooterElements(page);

  try {
    const scrollHandle = await getBestScrollableElementHandle(page);

    const scrollInfo = await scrollHandle.evaluate((element) => {
      element.scrollTop = 0;

      const rect = element.getBoundingClientRect();

      return {
        tagName: element.tagName,
        className: element.className,
        id: element.id,
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        clientWidth: element.clientWidth,
        rectTop: rect.top,
        rectLeft: rect.left,
        rectWidth: rect.width,
        rectHeight: rect.height
      };
    });

    await page.waitForTimeout(1000);

    console.log("Detected scroll container:");
    console.log(scrollInfo);

    const viewport = page.viewportSize();

    if (!viewport) {
      throw new Error("Could not determine viewport size.");
    }

    const repeatedHeaderCropTop = await estimateRepeatedHeaderCropTop(page);

    const totalHeight = Math.ceil(scrollInfo.scrollHeight);
    const viewportHeight = viewport.height;
    const viewportWidth = viewport.width;

    const subsequentUsefulHeight = viewportHeight - repeatedHeaderCropTop;

    if (subsequentUsefulHeight < 200) {
      throw new Error(
        `Calculated useful capture height is too small: ${subsequentUsefulHeight}. Header crop may be wrong.`
      );
    }

    console.log(`Scrollable content height: ${totalHeight}`);
    console.log(`Viewport size: ${viewportWidth} x ${viewportHeight}`);
    console.log(`Subsequent crop top: ${repeatedHeaderCropTop}`);
    console.log(`Subsequent useful height: ${subsequentUsefulHeight}`);

    const screenshots = [];
    let scrollTop = 0;
    let index = 0;
    let lastScrollTop = -1;

    while (scrollTop < totalHeight) {
      await scrollHandle.evaluate((element, y) => {
        element.scrollTop = y;
      }, scrollTop);

      await page.waitForTimeout(1000);

      const actualScrollTop = await scrollHandle.evaluate((element) => {
        return Math.ceil(element.scrollTop);
      });

      if (actualScrollTop === lastScrollTop && index > 0) {
        console.log("Inner scroll position did not advance. Stopping capture loop.");
        break;
      }

      lastScrollTop = actualScrollTop;

      const tempPath = path.join(
        tempDir,
        `capture-${Date.now()}-${String(index).padStart(3, "0")}.png`
      );

      await page.screenshot({
        path: tempPath,
        fullPage: false
      });

      const metadata = await sharp(tempPath).metadata();
      const imageWidth = metadata.width || viewportWidth;
      const imageHeight = metadata.height || viewportHeight;

      let cropTop = 0;
      let usefulHeight = imageHeight;

      if (index > 0) {
        cropTop = repeatedHeaderCropTop;

        const remainingContentHeight = totalHeight - actualScrollTop;
        usefulHeight = Math.min(imageHeight - cropTop, remainingContentHeight);
      }

      if (usefulHeight <= 0) {
        console.log("Useful height is zero or negative. Stopping capture loop.");
        break;
      }

      screenshots.push({
        path: tempPath,
        scrollTop: actualScrollTop,
        cropTop,
        usefulHeight,
        imageWidth,
        imageHeight
      });

      console.log(
        `Captured segment ${index + 1}: innerScrollTop=${actualScrollTop}, cropTop=${cropTop}, usefulHeight=${usefulHeight}`
      );

      if (actualScrollTop + subsequentUsefulHeight >= totalHeight) {
        break;
      }

      scrollTop = actualScrollTop + subsequentUsefulHeight;
      index++;

      if (index > 100) {
        throw new Error("Too many screenshot segments. Stopping to avoid infinite loop.");
      }
    }

    if (!screenshots.length) {
      throw new Error("No screenshots were captured.");
    }

    const firstImageMetadata = await sharp(screenshots[0].path).metadata();
    const finalWidth = firstImageMetadata.width || viewportWidth;

    const finalHeight = screenshots.reduce((sum, segment) => {
      return sum + Math.max(1, Math.floor(segment.usefulHeight));
    }, 0);

    const compositeParts = [];
    let currentTop = 0;

    for (const segment of screenshots) {
      let inputPath = segment.path;
      const partHeight = Math.max(1, Math.floor(segment.usefulHeight));

      if (segment.cropTop > 0 || partHeight < segment.imageHeight) {
        const croppedPath = segment.path.replace(".png", "-cropped.png");

        await sharp(segment.path)
          .extract({
            left: 0,
            top: Math.max(0, Math.floor(segment.cropTop)),
            width: segment.imageWidth,
            height: partHeight
          })
          .toFile(croppedPath);

        inputPath = croppedPath;
      }

      compositeParts.push({
        input: inputPath,
        top: currentTop,
        left: 0
      });

      currentTop += partHeight;
    }

    await sharp({
      create: {
        width: finalWidth,
        height: finalHeight,
        channels: 4,
        background: {
          r: 255,
          g: 255,
          b: 255,
          alpha: 1
        }
      }
    })
      .composite(compositeParts)
      .png()
      .toFile(finalScreenshotPath);

    console.log("Scroll-stitched screenshot saved.");

    for (const segment of screenshots) {
      try {
        fs.unlinkSync(segment.path);
      } catch {
        // Ignore cleanup errors.
      }

      const croppedPath = segment.path.replace(".png", "-cropped.png");

      try {
        if (fs.existsSync(croppedPath)) {
          fs.unlinkSync(croppedPath);
        }
      } catch {
        // Ignore cleanup errors.
      }
    }

    await scrollHandle.evaluate((element) => {
      element.scrollTop = 0;
    });

    await page.waitForTimeout(1000);

    return finalScreenshotPath;
  } finally {
    await restoreFooterElements(page);
    await restoreStickyElements(page);
  }
}

async function resetAllScrollPositions(page) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);

    const scrollingElement = document.scrollingElement || document.documentElement || document.body;
    if (scrollingElement) {
      scrollingElement.scrollTop = 0;
    }

    const elements = Array.from(document.querySelectorAll("*"));

    for (const element of elements) {
      try {
        if (element.scrollTop && element.scrollTop > 0) {
          element.scrollTop = 0;
        }
      } catch {
        // Ignore scroll reset errors.
      }
    }
  });
}

async function expandScrollableElementsForScreenshot(page) {
  await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll("*"));

    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      const hasVerticalOverflow = element.scrollHeight > element.clientHeight + 20;
      const isWideEnough = rect.width >= 500;
      const isTallEnough = rect.height >= 100;

      if (!hasVerticalOverflow || !isWideEnough || !isTallEnough) {
        continue;
      }

      element.setAttribute("data-playwright-expanded-scroll", "true");
      element.setAttribute("data-playwright-original-style", element.getAttribute("style") || "");

      element.style.overflow = "visible";
      element.style.overflowY = "visible";
      element.style.maxHeight = "none";
      element.style.height = `${element.scrollHeight}px`;
    }

    const html = document.documentElement;
    const body = document.body;

    for (const element of [html, body]) {
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
    const expandedElements = Array.from(
      document.querySelectorAll('[data-playwright-expanded-scroll="true"], [data-playwright-expanded-root="true"]')
    );

    for (const element of expandedElements) {
      const originalStyle = element.getAttribute("data-playwright-original-style") || "";

      if (originalStyle) {
        element.setAttribute("style", originalStyle);
      } else {
        element.removeAttribute("style");
      }

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
  console.log("BOX SCORE CAPTURE MODE: expanded fullPage screenshot, NOT scroll-stitched");
  console.log(`Capturing expanded full-page screenshot: ${description}`);
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

    await page.screenshot({
      path: finalScreenshotPath,
      fullPage: true
    });

    console.log(`Expanded full-page screenshot saved: ${finalScreenshotPath}`);
    return finalScreenshotPath;
  } finally {
    await restoreExpandedScrollableElements(page).catch(() => {});
    await restoreFooterElements(page);
    await resetAllScrollPositions(page);
  }
}

async function capturePageInChunks(page, outputDir, baseFileName, options = {}) {
  const overlap = options.overlap || 200;
  const waitAfterScrollMs = options.waitAfterScrollMs || 500;
  const maxChunks = options.maxChunks || 100;

  ensureDirectory(outputDir);

  await dismissDontMissOutPopup(page);
  await page.waitForTimeout(750);

  const viewport = page.viewportSize() || {
    width: 1440,
    height: 1000
  };

  const clipTop =
    typeof options.clipTop === "number"
      ? options.clipTop
      : await estimateRepeatedHeaderCropTop(page);

  const clipHeight = Math.max(250, viewport.height - clipTop);
  const step = Math.max(100, clipHeight - overlap);

  await hideFooterElements(page);

  try {
    const scrollHandle = await getBestScrollableElementHandle(page);

    const scrollInfo = await scrollHandle.evaluate((element) => {
      element.scrollTop = 0;

      const rect = element.getBoundingClientRect();

      return {
        tagName: element.tagName,
        className: element.className,
        id: element.id,
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        scrollableAmount: element.scrollHeight - element.clientHeight,
        rectTop: rect.top,
        rectLeft: rect.left,
        rectWidth: rect.width,
        rectHeight: rect.height
      };
    });

    console.log("");
    console.log("PLAYS CAPTURE MODE: chunked screenshots, NOT stitched");
    console.log(`Capturing chunked screenshots for ${baseFileName}`);
    console.log("Detected scroll container:");
    console.log(scrollInfo);
    console.log(`Viewport: ${viewport.width} x ${viewport.height}`);
    console.log(`Clip top: ${clipTop}`);
    console.log(`Clip height: ${clipHeight}`);
    console.log(`Overlap: ${overlap}`);
    console.log(`Scroll step: ${step}`);

    let chunkNumber = 1;
    let requestedScrollTop = 0;
    let lastActualScrollTop = -1;
    const savedFiles = [];
    const maxScrollTop = Math.max(0, scrollInfo.scrollHeight - scrollInfo.clientHeight);

    while (chunkNumber <= maxChunks) {
      await scrollHandle.evaluate((element, y) => {
        element.scrollTop = y;
      }, requestedScrollTop);

      await page.waitForTimeout(waitAfterScrollMs);

      const actualScrollTop = await scrollHandle.evaluate((element) => {
        return Math.ceil(element.scrollTop || 0);
      });

      if (actualScrollTop === lastActualScrollTop && chunkNumber > 1) {
        console.log("Scroll position did not advance. Stopping chunk capture.");
        break;
      }

      lastActualScrollTop = actualScrollTop;

      const chunkPath = path.join(
        outputDir,
        `${baseFileName}-chunk-${String(chunkNumber).padStart(3, "0")}.png`
      );

      await page.screenshot({
        path: chunkPath,
        fullPage: false,
        clip: {
          x: 0,
          y: clipTop,
          width: viewport.width,
          height: clipHeight
        }
      });

      console.log(`Saved play-by-play chunk ${chunkNumber}: ${chunkPath}`);
      savedFiles.push(chunkPath);

      if (actualScrollTop >= maxScrollTop) {
        break;
      }

      requestedScrollTop = actualScrollTop + step;
      chunkNumber++;
    }

    await scrollHandle.evaluate((element) => {
      element.scrollTop = 0;
    });

    await page.waitForTimeout(500);

    return savedFiles;
  } finally {
    await restoreFooterElements(page);
  }
}


async function captureBoxScoreAndPlays(page, team) {
  const teamDir = getTeamOutputDir(team);

  console.log("");
  console.log("Starting game detail capture...");

  const boxScoreClicked = await clickTabByName(page, "Box Score");
  if (!boxScoreClicked) {
    return {
      success: false
    };
  }

  await page.waitForTimeout(2000);

  const gameFileBase = await getGameFileBase(page);

  const boxScorePath = path.join(teamDir, `game-box-score-${gameFileBase}.png`);

  /*
    Box scores live inside a GameChanger scroll container. Plain fullPage screenshots
    can cut off the pitching section, while the old stitched routine duplicated content.
    This expands the scroll container first, then takes one full-page screenshot.
  */
  const boxScoreFile = await captureExpandedFullPageScreenshot(
    page,
    boxScorePath,
    "Box Score full page"
  );

  const playsClicked = await clickTabByName(page, "Plays");
  if (!playsClicked) {
    return {
      success: false,
      boxScoreFile
    };
  }

  const chronologicalSelected = await selectChronologicalPlaysOrder(page);
  if (!chronologicalSelected) {
    return {
      success: false,
      boxScoreFile
    };
  }

  await page.waitForTimeout(2000);

  const playsGameFileBase = await getGameFileBase(page);
  const playsDir = path.join(
    teamDir,
    "game-plays-chunks",
    sanitizeFileNameCompact(playsGameFileBase)
  );

  const playChunkFiles = await capturePageInChunks(
    page,
    playsDir,
    `game-plays-chronological-${playsGameFileBase}`,
    {
      overlap: 200,
      waitAfterScrollMs: 500,
      maxChunks: 100
    }
  );

  console.log(`Saved chunked play-by-play screenshots to: ${playsDir}`);
  console.log(`Play chunks captured: ${playChunkFiles.length}`);
  console.log("");
  console.log("Game detail screenshots complete.");
  console.log(`Saved to: ${teamDir}`);

  return {
    success: true,
    boxScoreFile,
    playsFile: playsDir
  };
}

async function clickBestTeamResult(page, team, searchTerm, debugInfo, teamUrlCache) {
  const best = await chooseBestTeamResult(page, team, searchTerm, debugInfo);

  if (!best) {
    return false;
  }

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

  const scheduleClicked = await clickScheduleTab(page);
  if (!scheduleClicked) {
    return false;
  }

  const completedGamesCaptured = await captureAllCompletedGamesFromSchedule(page, team);

  if (!completedGamesCaptured) {
    return false;
  }

  return true;
}

async function processTeamFromKnownUrl(page, team, knownTeamUrl, teamUrlCache) {
  const url = normalizeTeamUrl(knownTeamUrl);

  if (!url) {
    return false;
  }

  console.log("");
  console.log("Known GameChanger Team URL found. Skipping search.");
  console.log(`Team: ${team.teamName}`);
  console.log(`URL: ${url}`);

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  try {
    await page.waitForLoadState("networkidle", { timeout: 15000 });
  } catch {
    // GameChanger may keep background requests open.
  }

  await page.waitForTimeout(3000);
  await dismissDontMissOutPopup(page);

  rememberTeamUrl(team, page.url(), teamUrlCache);

  const scheduleClicked = await clickScheduleTab(page);

  if (!scheduleClicked) {
    console.log("Could not click Schedule tab from known URL. Falling back to search.");
    return false;
  }

  const completedGamesCaptured = await captureAllCompletedGamesFromSchedule(page, team);

  if (!completedGamesCaptured) {
    return false;
  }

  return true;
}

async function processTeam(page, team, teamNumber, totalTeams, teamUrlCache) {
  console.log("");
  console.log("################################################################################");
  console.log(`Processing team ${teamNumber} of ${totalTeams}: ${team.teamName}`);
  console.log("################################################################################");

  const knownTeamUrl = getKnownTeamUrl(team, teamUrlCache);

  if (knownTeamUrl) {
    const processedFromUrl = await processTeamFromKnownUrl(
      page,
      team,
      knownTeamUrl,
      teamUrlCache
    );

    if (processedFromUrl) {
      console.log(`Finished team from known URL: ${team.teamName}`);
      return true;
    }

    console.log("Known URL did not work. Proceeding with normal search.");
  }

  const searchTerms = buildSearchTerms(team);

  const debugInfo = {
    searchAttempts: []
  };

  console.log("");
  console.log("Search terms to try:");
  console.log("====================");

  for (const term of searchTerms) {
    console.log(term);
  }

  for (const searchTerm of searchTerms) {
    const searched = await submitTeamSearch(page, team, searchTerm);

    if (!searched) {
      continue;
    }

    if (await pageHasNoResults(page)) {
      console.log(`No results for: ${searchTerm}`);
      appendSearchAttemptDebug(debugInfo, searchTerm, [], []);
      continue;
    }

    const clicked = await clickBestTeamResult(
      page,
      team,
      searchTerm,
      debugInfo,
      teamUrlCache
    );

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

  if (!teams.length) {
    throw new Error("No teams found from Google Sheet.");
  }

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
        searchAttempts: [
          {
            searchTerm: "Unhandled processing error",
            candidateCount: 0,
            candidates: [
              {
                score: -999,
                reasons: [error.message],
                hasTeamHref: false,
                textLength: 0,
                linkText: "",
                href: page.url(),
                cardText: ""
              }
            ]
          }
        ]
      });
    }
  }

  saveTeamUrlCache(teamUrlCache);

  console.log("");
  console.log("All selected teams have been processed and are ready for scouting.");
}

async function main() {
  if (!fs.existsSync(STORAGE_STATE)) {
    throw new Error(`Missing auth file: ${STORAGE_STATE}. Run npm run login first.`);
  }

  ensureDirectory(OUTPUT_DIR);
  ensureDirectory(FAILED_MATCHES_DIR);

  console.log(`Accepted GameChanger seasons: ${getAcceptedSeasonLabel()}`);

  const browser = await chromium.launch({
    headless: false,
    slowMo: 75
  });

  const context = await browser.newContext({
    storageState: STORAGE_STATE,
    viewport: {
      width: 1440,
      height: 1000
    },
    acceptDownloads: true
  });

  const page = await context.newPage();

  try {
    await processTeamsFromSpreadsheet(page);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("");
  console.error("GameChanger team search failed:");
  console.error(error.message);
  console.error("");
  process.exit(1);
});