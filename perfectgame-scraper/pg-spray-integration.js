/**
 * pg-spray-integration.js
 * Voodoo Scout — Integration Guide
 *
 * Shows exactly where and how to call the spray modules from
 * perfectgame-scraper.js. Copy the relevant blocks into the
 * appropriate places in your existing scraper.
 *
 * ─────────────────────────────────────────────────────────────────
 * STEP 1: Add requires at the top of perfectgame-scraper.js
 * ─────────────────────────────────────────────────────────────────
 */

// ADD at top of perfectgame-scraper.js alongside existing requires:
const { scrapeTeamSprayData } = require("./pg-spray-scraper");
const { buildTeamSprayData }  = require("./gc-spray-engine");

// For SQLite access (gc-spray-engine needs the GC database):
const sqlite3 = require("sqlite3").verbose();
const GC_DB_PATH = process.env.GC_DB_PATH ||
  require("path").join(__dirname, "../gamechanger-scraper/database/gamechanger.db");

/**
 * ─────────────────────────────────────────────────────────────────
 * STEP 2: Add to .env
 * ─────────────────────────────────────────────────────────────────
 *
 * # Path to the GC SQLite database
 * GC_DB_PATH=C:\playwright-projects\gamechanger-scraper\database\gamechanger.db
 *
 * # Spray chart timing (increase if PG is slow)
 * PG_SPRAY_PAGE_LOAD_MS=2000
 * PG_SPRAY_MODAL_OPEN_MS=2500
 * PG_SPRAY_FILTER_CHANGE_MS=1500
 * PG_SPRAY_BETWEEN_PLAYERS_MS=1000
 *
 * # Set to false to skip spray chart capture (useful for quick runs)
 * PG_CAPTURE_SPRAY_CHARTS=true
 */

/**
 * ─────────────────────────────────────────────────────────────────
 * STEP 3: Add this function to perfectgame-scraper.js
 * Call it once per team after captureTeamStatsTables() returns.
 * ─────────────────────────────────────────────────────────────────
 */
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

/**
 * ─────────────────────────────────────────────────────────────────
 * STEP 4: Find this block in perfectgame-scraper.js (around line 3882)
 * and add the spray call right after captureTeamStatsTables():
 * ─────────────────────────────────────────────────────────────────
 *
 * EXISTING CODE (already in perfectgame-scraper.js):
 *   console.log("Always updating latest team stats tables...");
 *   let statsTables = await captureTeamStatsTables(page, teamDir, finalTeamName);
 *
 * ADD RIGHT AFTER that line:
 *   const sprayResult = await captureAndBuildSprayData(page, context, finalTeamName, teamDir);
 *
 * Then include sprayResult in the return object:
 *   return {
 *     success: true,
 *     team_name: finalTeamName,
 *     ...
 *     stats_tables: statsTables,
 *     spray_charts: sprayResult,   // ← ADD THIS
 *   };
 *
 * ─────────────────────────────────────────────────────────────────
 * STEP 5: File layout after running
 * ─────────────────────────────────────────────────────────────────
 *
 * output/
 *   {Team Name}/
 *     pg-spray-data.json          ← PG modal zone counts (all pitch filters)
 *     gc-spray-data.json          ← GC authoritative zone data + player bios
 *     pg-gc-discrepancy-report.txt← Email-ready discrepancy report
 *     spray-charts/
 *       Dylan-Harcrow-spray-chart.svg
 *       Kendan-Thomas-spray-chart.svg
 *       ...
 *     stats-tables/               ← existing screenshots
 *     games/                      ← existing game captures
 */

/**
 * ─────────────────────────────────────────────────────────────────
 * STEP 6: Converting SVG to PNG (optional, for Word report embedding)
 * ─────────────────────────────────────────────────────────────────
 *
 * The heat maps are generated as SVG (vector, scales perfectly).
 * For embedding in Word/PDF reports in Phase 5, convert with sharp:
 *
 *   const sharp = require("sharp"); // already in package.json
 *   const svgBuffer = fs.readFileSync(svgFile);
 *   await sharp(svgBuffer)
 *     .png({ density: 150 })
 *     .toFile(svgFile.replace(".svg", ".png"));
 *
 * Or use Playwright itself to render the SVG to PNG (most accurate):
 *
 *   const svgPage = await context.newPage();
 *   await svgPage.setContent(`<html><body style="margin:0">${svg}</body></html>`);
 *   await svgPage.screenshot({ path: pngPath, clip: { x:0, y:0, width:680, height:500 } });
 *   await svgPage.close();
 *
 * ─────────────────────────────────────────────────────────────────
 * DATA FLOW SUMMARY
 * ─────────────────────────────────────────────────────────────────
 *
 *  PG team page (authenticated)
 *      │
 *      ├─► Full Roster scrape → player bio (B/T, age, height, weight)
 *      │
 *      └─► Batting Stats table → for each player:
 *              │
 *              └─► Player profile tab (new tab)
 *                      │
 *                      ├─► Bio scrape (age, B/T, positions)
 *                      │
 *                      └─► Spray Chart modal
 *                              ├─► Switch to # mode
 *                              ├─► Read All zones (10 counts)
 *                              ├─► Read Fastball zones
 *                              ├─► Read CB/SL zones
 *                              ├─► Read Changeup zones
 *                              └─► Close modal, close tab
 *
 *      → pg-spray-data.json
 *
 *  GC SQLite (play_by_play table)
 *      │
 *      └─► For each at-bat involving opponent batter:
 *              │
 *              ├─► Parse play text → hit type, first fielder
 *              ├─► Map fielder → zone (10-zone fan, handedness-adjusted)
 *              └─► Accumulate zone hit counts per player
 *
 *      → gc-spray-data.json
 *      → spray-charts/{player}-spray-chart.svg  (heat map PNG)
 *      → pg-gc-discrepancy-report.txt           (email to stats@perfectgame.com)
 *
 *  Phase 4 (Claude AI analysis) reads:
 *      gc-spray-data.json  ← authoritative zones
 *      pg-spray-data.json  ← pitch-type breakdowns (velocity from PG is reliable)
 *      heat map SVGs       ← embedded in Word report
 */

module.exports = { captureAndBuildSprayData };
