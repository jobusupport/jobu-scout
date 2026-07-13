/**
 * pg-spray-scraper.js
 * Voodoo Scout — Perfect Game Spray Chart Scraper
 *
 * The PG spray chart is rendered inline on the player profile page inside a
 * div.modalTargetActive — it is NOT a popup that needs to be opened.
 * All hit data is stored in hidden input fields (hfX, hfY, hfHitType, hfPlayType).
 * Zone labels are in spans with specific IDs (OF_Left, IF_Left_Most, etc.).
 * Filter buttons are Telerik RadButtons (<button> elements, not <input type="radio">).
 */

"use strict";

require("dotenv").config();

const fs   = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------
function envMs(name, def) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

const SPRAY_PAGE_LOAD_MS       = envMs("PG_SPRAY_PAGE_LOAD_MS",       2000);
const SPRAY_FILTER_CHANGE_MS   = envMs("PG_SPRAY_FILTER_CHANGE_MS",   2500);
const SPRAY_BETWEEN_PLAYERS_MS = envMs("PG_SPRAY_BETWEEN_PLAYERS_MS", 1000);

// ---------------------------------------------------------------------------
// Zone ID mapping — PG element ID suffix → our zone key
// ---------------------------------------------------------------------------
const PG_ZONE_ID_MAP = {
  // Outfield
  "OF_Left":     "OF_LF_D",    // LF deep/left
  "OF_LCF":      "OF_LF_G",    // LF gap / left-center
  "OF_Middle":   "OF_CF",      // CF
  "OF_RCF":      "OF_RF_G",    // RF gap / right-center
  "OF_Right":    "OF_RF_D",    // RF deep/right
  // Infield
  "IF_Left_Most": "IF_3B",     // 3B
  "IF_Left":      "IF_SS",     // SS
  "IF_Middle":    "IF_P",      // P/middle
  "IF_Right":     "IF_2B",     // 2B
  "IF_Right_Most":"IF_1B",     // 1B
};

// Pitch type filters — label text on the RadButton
const PITCH_FILTERS = [
  { key: "all",      label: "All"      },
  { key: "fastball", label: "Fastball" },
  { key: "cbsl",     label: "CB/SL"    },
  { key: "changeup", label: "Changeup" },
];

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function normalizeKey(v) {
  return String(v || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function cleanFileName(v) {
  return String(v || "unknown")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/[^\w\s.-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

function ensureDirectory(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function timestamp() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------
async function dismissOverlays(page) {
  await page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll('button,input[type="button"],input[type="submit"],a,div,span')
    );
    for (const el of candidates) {
      const text = String(el.innerText || el.textContent || el.value || "")
        .replace(/\s+/g, " ").trim().toUpperCase();
      if (["GOT IT", "GOT IT!", "ACCEPT", "I ACCEPT", "OK"].includes(text)) {
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0) {
          el.click();
          return;
        }
      }
    }
  }).catch(() => {});
  await page.waitForTimeout(400);
}

async function hideFloatingJunk(page) {
  await page.addStyleTag({
    content: `
      iframe[src*="youtube"],iframe[src*="vimeo"],iframe[src*="doubleclick"],
      iframe[src*="googlesyndication"],iframe[src*="adservice"],iframe[src*="imasdk"],
      .jwplayer,[id*="floatingVideo" i],[class*="floatingVideo" i],
      [id*="stickyVideo" i],[class*="stickyVideo" i] {
        display:none!important;visibility:hidden!important;
        opacity:0!important;pointer-events:none!important;
      }
    `
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Click a Telerik RadButton by its visible text label
// These are <button> elements with a <span class="rbText"> inside them
// ---------------------------------------------------------------------------
async function clickRadButton(page, labelText) {
  const clicked = await page.evaluate((label) => {
    function isVisible(el) {
      const s = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" &&
             Number(s.opacity || 1) > 0 && r.width > 0 && r.height > 0;
    }

    // Find all RadButton buttons whose rbText span matches the label
    const buttons = Array.from(document.querySelectorAll("button.RadRadioButton, button.RadButton"));
    for (const btn of buttons) {
      const textSpan = btn.querySelector(".rbText");
      if (!textSpan) continue;
      const text = String(textSpan.innerText || textSpan.textContent || "").trim();
      if (text === label && isVisible(btn)) {
        btn.click();
        return true;
      }
    }

    // Fallback: any visible button whose text matches
    for (const btn of Array.from(document.querySelectorAll("button"))) {
      if (!isVisible(btn)) continue;
      const text = String(btn.innerText || btn.textContent || "").replace(/\s+/g, " ").trim();
      if (text === label) {
        btn.click();
        return true;
      }
    }

    return false;
  }, labelText).catch(() => false);

  return clicked;
}

// ---------------------------------------------------------------------------
// Wait for the spray chart to reload after a filter change
// PG does an ASP.NET postback (__doPostBack) which reloads the modal content
// We detect this by watching for the zone label IDs to be re-rendered
// ---------------------------------------------------------------------------
async function waitForSprayReload(page, timeoutMs) {
  const start = Date.now();
  // Wait for the modalTargetActive div to be present with zone labels
  while (Date.now() - start < timeoutMs) {
    const ready = await page.evaluate(() => {
      const modal = document.querySelector(".modalTargetActive");
      if (!modal) return false;
      // Check that at least one zone label span is present
      return !!modal.querySelector('[id*="OF_Left"],[id*="IF_Left_Most"],[id*="IF_Middle"]');
    }).catch(() => false);
    if (ready) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Read zone label values from the spray chart modal
// Returns { OF_LF_D, OF_LF_G, OF_CF, OF_RF_G, OF_RF_D,
//           IF_3B, IF_SS, IF_P, IF_2B, IF_1B }
// ---------------------------------------------------------------------------
async function readZoneLabels(page) {
  return await page.evaluate((zoneMap) => {
    const result = {};

    for (const [pgId, ourKey] of Object.entries(zoneMap)) {
      // IDs contain the zone name as a suffix, e.g.:
      // "ContentTopLevel_ContentPlaceHolder1_advstatsv2_OF_Left"
      const el = document.querySelector(`[id$="_${pgId}"]`);
      if (!el) { result[ourKey] = null; continue; }

      const raw = String(el.innerText || el.textContent || "").replace(/\s+/g, "").trim();
      // Strip % sign if present, parse as number
      result[ourKey] = parseInt(raw.replace("%", ""), 10) || 0;
    }

    return result;
  }, PG_ZONE_ID_MAP).catch(() => ({}));
}

// ---------------------------------------------------------------------------
// Read all hit events from the hidden input fields
// Each hit has: hfX, hfY, hfHitType, hfPlayType
// The span title attribute has the full description including zone
// Returns array of hit event objects
// ---------------------------------------------------------------------------
async function readHitEvents(page) {
  return await page.evaluate(() => {
    const hits = [];
    let i = 0;

    while (true) {
      const padded = String(i).padStart(2, "0");
      const xEl       = document.querySelector(`[id$="rptHits_hfX_${i}"]`);
      const yEl       = document.querySelector(`[id$="rptHits_hfY_${i}"]`);
      const hitTypeEl = document.querySelector(`[id$="rptHits_hfHitType_${i}"]`);
      const playTypeEl= document.querySelector(`[id$="rptHits_hfPlayType_${i}"]`);
      const markerEl  = document.querySelector(`[id$="rptHits_lblxy_${i}"]`);

      if (!xEl && !yEl) break;

      // Parse the title attribute for zone and full description
      // Format: "IF-Left-Most | F6 | Out (Ground to 3B) | Raw x=-108 | Raw y=104 | Fixed x=110 | Fixed y=130.2"
      let zone = "", title = "";
      if (markerEl) {
        title = markerEl.getAttribute("title") || "";
        const parts = title.split("|").map(s => s.trim());
        zone = parts[0] || "";
      }

      hits.push({
        index:    i,
        rawX:     parseInt(xEl?.value || "0", 10),
        rawY:     parseInt(yEl?.value || "0", 10),
        hitType:  hitTypeEl?.value || "",
        playType: playTypeEl?.value || "",
        zone,
        title,
      });

      i++;
      if (i > 500) break; // safety limit
    }

    return hits;
  }).catch(() => []);
}

// ---------------------------------------------------------------------------
// Check if the spray chart modal is present on the page
// ---------------------------------------------------------------------------
async function isSprayChartPresent(page) {
  return await page.evaluate(() => {
    const modal = document.querySelector(".modalTargetActive");
    if (!modal) return false;
    const r = modal.getBoundingClientRect();
    const s = window.getComputedStyle(modal);
    return r.width > 50 && s.display !== "none" && s.visibility !== "hidden";
  }).catch(() => false);
}

/**
 * Click the Spray Chart button and wait for the ASP.NET partial postback
 * to complete and the modalTargetActive div to appear with zone data.
 * The button uses __doPostBack so we click the <a> by its known ID suffix.
 */
async function clickSprayChartButton(page) {
  // Click the spray chart card link — exact ID from page source
  const clicked = await page.evaluate(() => {
    // Primary: find by ID suffix
    const btn = document.querySelector('[id$="btnSprayChart"]');
    if (btn) { btn.click(); return true; }

    // Fallback: find by class + text content
    const cards = Array.from(document.querySelectorAll('.spray-chart-card'));
    for (const card of cards) {
      if (card.href && card.href.includes('__doPostBack')) {
        card.click(); return true;
      }
    }

    // Last resort: any element containing the spray-chart-sub span
    const sub = document.querySelector('.spray-chart-sub');
    if (sub) {
      const parent = sub.closest('a') || sub.closest('[onclick]') || sub.parentElement;
      if (parent) { parent.click(); return true; }
    }

    return false;
  }).catch(() => false);

  if (!clicked) return false;

  // Wait for the partial postback to complete and modalTargetActive to appear
  const startMs = Date.now();
  const timeoutMs = 15000;
  while (Date.now() - startMs < timeoutMs) {
    await page.waitForTimeout(400);
    const ready = await page.evaluate(() => {
      const modal = document.querySelector(
        '#ContentTopLevel_ContentPlaceHolder1_advstatsv2_sprayChartDiv'
      );
      if (!modal) return false;
      // It becomes active when class changes from "modaloverlay" to "modalTargetActive"
      return modal.classList.contains("modalTargetActive");
    }).catch(() => false);
    if (ready) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Scrape player bio from the profile page header
// ---------------------------------------------------------------------------
async function scrapePlayerBio(profilePage) {
  return await profilePage.evaluate(() => {
    function clean(v) {
      return String(v || "").replace(/\s+/g, " ").trim();
    }

    const bodyText = document.body ? clean(document.body.innerText) : "";

    // Bats/Throws — "R/R  BATS/THROWS"
    let bats = "", throws_ = "";
    const btMatch = bodyText.match(/([LRS])\/([LRS])\s+BATS\/THROWS/i) ||
                    bodyText.match(/BATS\/THROWS\s*\n?\s*([LRS])\/([LRS])/i);
    if (btMatch) { bats = btMatch[1]; throws_ = btMatch[2]; }

    // Age
    let ageYears = null;
    const ageMatch = bodyText.match(/(\d+)\s+and\s+\d+\s+mos\s+AGE/i) ||
                     bodyText.match(/AGE\s+(\d+)\s+and/i);
    if (ageMatch) ageYears = parseInt(ageMatch[1], 10);

    // Height/Weight
    let height = "", weight = "";
    const hwMatch = bodyText.match(/(\d+-\d+)\s+(\d+)\s+HEIGHT\/WEIGHT/i) ||
                    bodyText.match(/HEIGHT\/WEIGHT\s+(\d+-\d+)\s+(\d+)/i);
    if (hwMatch) { height = hwMatch[1]; weight = hwMatch[2]; }

    // Grad year
    let grad = "";
    const gradMatch = bodyText.match(/(\d{4})\s+GRAD/i);
    if (gradMatch) grad = gradMatch[1];

    // Positions
    let positions = "";
    const posMatch = bodyText.match(/\d{4}\s+GRAD\s+\|\s+([\w,\/ ]+?)\s+\|/i);
    if (posMatch) positions = posMatch[1].trim();

    return { bats, throws: throws_, ageYears, height, weight, grad, positions };
  }).catch(() => ({}));
}

// ---------------------------------------------------------------------------
// Core: scrape spray data for one player on their profile page
// ---------------------------------------------------------------------------
async function scrapePlayerSprayData(profilePage, playerName, teamName) {
  const result = {
    player:      playerName,
    team:        teamName,
    bio:         {},
    sprayData:   {},
    hitEvents:   {},
    capturedAt:  timestamp(),
    errors:      [],
  };

  // 1. Bio
  result.bio = await scrapePlayerBio(profilePage);

  // 2. Scroll to the stats section so the spray chart button is in the DOM
  await profilePage.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.4)).catch(() => {});
  await profilePage.waitForTimeout(1200);
  await dismissOverlays(profilePage);

  // 3. Click the Spray Chart button — triggers __doPostBack which populates the modal
  console.log(`[SprayScraper]   Clicking spray chart button for ${playerName}...`);
  const modalOpened = await clickSprayChartButton(profilePage);
  if (!modalOpened) {
    result.errors.push("Could not open spray chart modal — button click or postback failed");
    return result;
  }
  console.log(`[SprayScraper]   Spray chart modal opened for ${playerName}`);
  await dismissOverlays(profilePage);

  // 4. The modal opens on Career view by default. Switch to Season Year 2026
  //    by clicking the Season Year radio button (standard <input type=radio>, not Telerik)
  await profilePage.evaluate(() => {
    // Season Year radio is value="season" in rblBattingYearType — but the spray chart
    // has its own year dropdown: rblSprayYear select
    const sel = document.querySelector('[id$="rblSprayYear"]');
    if (sel) {
      const opt = Array.from(sel.options).find(o => o.value === "2026");
      if (opt && sel.value !== "2026") {
        sel.value = "2026";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  }).catch(() => {});
  await profilePage.waitForTimeout(SPRAY_FILTER_CHANGE_MS);

  // 5. Cycle through pitch type filters
  for (const filter of PITCH_FILTERS) {
    // Click the pitch type RadButton (skip for "all" — it should already be selected,
    // but click it anyway to be safe)
    const clicked = await clickRadButton(profilePage, filter.label);
    if (!clicked && filter.key !== "all") {
      result.errors.push(`Could not click pitch filter: ${filter.label}`);
    }

    if (clicked || filter.key === "all") {
      await profilePage.waitForTimeout(SPRAY_FILTER_CHANGE_MS);
      await waitForSprayReload(profilePage, 5000);
    }

    // Read zone labels (% mode — we read whatever is currently shown)
    const zones = await readZoneLabels(profilePage);

    // Read hit events (only reliable for "all" filter since hidden inputs
    // reflect the current filter state)
    const hits = await readHitEvents(profilePage);

    result.sprayData[filter.key] = zones;
    result.hitEvents[filter.key] = hits;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Full Roster scraper
// ---------------------------------------------------------------------------
async function scrapeFullRoster(page) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForTimeout(1000);

  return await page.evaluate(() => {
    function clean(v) {
      return String(v || "").replace(/\s+/g, " ").trim();
    }

    let rosterTable = null;

    // Find heading "FULL ROSTER" then the adjacent table
    const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,div,span,b,strong"));
    for (const h of headings) {
      if (clean(h.innerText || h.textContent || "").toUpperCase() === "FULL ROSTER") {
        let node = h.nextElementSibling;
        let safety = 0;
        while (node && node.tagName !== "TABLE" && safety++ < 10) {
          node = node.nextElementSibling || node.parentElement?.nextElementSibling;
          if (!node) break;
        }
        if (node && node.tagName === "TABLE") { rosterTable = node; break; }
        const parent = h.parentElement;
        if (parent) {
          const t = parent.querySelector("table");
          if (t) { rosterTable = t; break; }
        }
      }
    }

    // Fallback: table with B/T column
    if (!rosterTable) {
      for (const t of Array.from(document.querySelectorAll("table"))) {
        const text = clean(t.innerText || "").toUpperCase();
        if (text.includes("B/T") && text.includes("GRAD") && text.includes("HT")) {
          rosterTable = t;
          break;
        }
      }
    }

    if (!rosterTable) return [];

    const headerRow = rosterTable.querySelector("thead tr") || rosterTable.querySelector("tr");
    if (!headerRow) return [];

    const headers = Array.from(headerRow.querySelectorAll("th,td"))
      .map(th => clean(th.innerText || th.textContent || "").toUpperCase());

    const idx = (name) => headers.findIndex(h => h === name || h.startsWith(name));

    const colNo   = idx("NO");
    const colName = idx("NAME");
    const colPos  = idx("POS");
    const colBT   = idx("B/T");
    const colGrad = idx("GRAD");
    const colHt   = idx("HT");
    const colWt   = idx("WT");
    const colHS   = idx("HS");
    const colHome = idx("HOMETOWN");
    const colRank = idx("RANK");
    const colComm = idx("COMMITMENT");

    const rows = Array.from(rosterTable.querySelectorAll("tbody tr"));
    const results = [];

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td"));
      if (cells.length < 4) continue;

      const get = (i) => i >= 0 && i < cells.length
        ? clean(cells[i].innerText || cells[i].textContent || "") : "";

      const bt = get(colBT);
      const [bats, throws_] = bt.includes("/") ? bt.split("/").map(s => s.trim()) : [bt, ""];

      let profileUrl = "";
      if (colName >= 0 && colName < cells.length) {
        const link = cells[colName].querySelector("a");
        if (link) profileUrl = link.href || "";
      }

      const name = get(colName);
      if (!name || name.toUpperCase() === "NAME") continue;

      results.push({
        name, number: get(colNo), positions: get(colPos),
        bats: bats || "", throws: throws_ || "",
        grad: get(colGrad), height: get(colHt), weight: get(colWt),
        highSchool: get(colHS), hometown: get(colHome),
        rank: get(colRank), commitment: get(colComm), profileUrl,
      });
    }

    return results;
  }).catch(() => []);
}

// ---------------------------------------------------------------------------
// Get batting stats player list from team page
// ---------------------------------------------------------------------------
async function getBattingStatsPlayers(teamPage) {
  // Click Batting Stats tab
  await teamPage.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll("button,[role='tab'],a,div,span"));
    for (const t of tabs) {
      const text = String(t.innerText || t.textContent || "").replace(/\s+/g, " ").trim().toUpperCase();
      if (text === "BATTING STATS") { t.click(); return; }
    }
  }).catch(() => {});
  await teamPage.waitForTimeout(1500);

  return await teamPage.evaluate(() => {
    function clean(v) {
      return String(v || "").replace(/\s+/g, " ").trim();
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
      if (
        (text.includes("OPS") || text.includes("AVG")) &&
        text.includes("PLAYER") &&
        !text.includes("TEAM SCHEDULE")
      ) { statsTable = t; break; }
    }

    if (!statsTable) return [];

    const results = [];
    for (const row of Array.from(statsTable.querySelectorAll("tbody tr"))) {
      const cells = Array.from(row.querySelectorAll("td"));
      if (cells.length < 2) continue;

      let name = "", profileUrl = "";
      for (const cell of cells) {
        const link = cell.querySelector("a");
        if (link) {
          const text = clean(link.innerText || link.textContent || "");
          const href = link.href || "";
          if (
            text &&
            text.toUpperCase() !== "PLAYER" &&
            (href.includes("PlayerProfile") || href.includes("/Players/"))
          ) { name = text; profileUrl = href; break; }
        }
      }

      if (!name || name.toUpperCase() === "TEAM TOTALS") continue;
      results.push({ name, profileUrl });
    }

    return results;
  }).catch(() => []);
}

// ---------------------------------------------------------------------------
// Main export: scrape spray data for an entire team
// ---------------------------------------------------------------------------
async function scrapeTeamSprayData(teamPage, browserContext, teamName, teamDir) {
  console.log(`\n[SprayScraper] Starting spray chart capture for: ${teamName}`);
  ensureDirectory(teamDir);

  const outputFile = path.join(teamDir, "pg-spray-data.json");
  const result = {
    team:       teamName,
    capturedAt: timestamp(),
    roster:     [],
    players:    [],
    errors:     [],
  };

  // 1. Full Roster
  console.log(`[SprayScraper] Scraping Full Roster...`);
  result.roster = await scrapeFullRoster(teamPage);
  console.log(`[SprayScraper] Found ${result.roster.length} roster entries`);

  const rosterByName = {};
  for (const r of result.roster) {
    rosterByName[normalizeKey(r.name)] = r;
  }

  // 2. Batting stats player list
  console.log(`[SprayScraper] Reading batting stats player list...`);
  const statsPlayers = await getBattingStatsPlayers(teamPage);
  console.log(`[SprayScraper] Found ${statsPlayers.length} players in batting stats`);

  if (!statsPlayers.length) {
    result.errors.push("No players found in batting stats table");
    fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), "utf8");
    return result;
  }

  // 3. Per-player: open profile tab, scrape spray chart, close tab
  for (let i = 0; i < statsPlayers.length; i++) {
    const { name, profileUrl } = statsPlayers[i];
    console.log(`[SprayScraper] Player ${i + 1}/${statsPlayers.length}: ${name}`);

    if (!profileUrl) {
      console.log(`[SprayScraper] No profile URL for ${name} — skipping`);
      result.players.push({ player: name, error: "No profile URL" });
      continue;
    }

    let profilePage = null;

    try {
      profilePage = await browserContext.newPage();
      await profilePage.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      await profilePage.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
      await profilePage.waitForTimeout(SPRAY_PAGE_LOAD_MS);
      await dismissOverlays(profilePage);
      await hideFloatingJunk(profilePage);

      const playerData = await scrapePlayerSprayData(profilePage, name, teamName);

      // Merge roster bio
      const rosterEntry = rosterByName[normalizeKey(name)] || {};
      playerData.rosterBio = rosterEntry;
      playerData.effectiveBats = playerData.bio?.bats || rosterEntry.bats || "R";
      playerData.isSwitchHitter = (playerData.effectiveBats || "").toUpperCase() === "S";

      result.players.push(playerData);

      if (playerData.errors?.length) {
        console.log(`[SprayScraper] ${name}: ${playerData.errors.length} warning(s): ${playerData.errors.join("; ")}`);
      } else {
        const hitCount = (playerData.hitEvents?.all || []).length;
        console.log(`[SprayScraper] ${name}: captured successfully (${hitCount} hit events)`);
      }

    } catch (err) {
      console.error(`[SprayScraper] Error capturing ${name}: ${err.message}`);
      result.players.push({ player: name, profileUrl, error: err.message, capturedAt: timestamp() });
      result.errors.push(`${name}: ${err.message}`);
    } finally {
      if (profilePage) await profilePage.close().catch(() => {});
      await teamPage.bringToFront().catch(() => {});
      await teamPage.waitForTimeout(SPRAY_BETWEEN_PLAYERS_MS);
    }
  }

  fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), "utf8");
  console.log(`[SprayScraper] Wrote spray data → ${outputFile}`);

  return result;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  scrapeTeamSprayData,
  scrapeFullRoster,
  scrapePlayerSprayData,
  getBattingStatsPlayers,
  PG_ZONE_ID_MAP,
  PITCH_FILTERS,
};