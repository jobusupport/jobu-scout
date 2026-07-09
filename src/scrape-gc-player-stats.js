'use strict';

/**
 * scrape-gc-player-stats.js
 *
 * Captures GameChanger's OWN player-level Stats tables and batting Spray
 * Chart for an opponent player — separate from our own play-by-play-derived
 * player_advanced_stats. Intent (per Troy): track our own accuracy and fill
 * holes, not replace our own numbers. Written into player_gc_stats /
 * player_gc_spray_charts, never merged into player_advanced_stats.
 *
 * Called once per player from scrape-handedness.js's captureRosterHandedness
 * loop, right after handedness is captured — the page is already on that
 * player's FanPlayerProfile pane at that point.
 *
 * CONFIRMED REAL STRUCTURE (from Troy's browser "Save Page As" dumps,
 * 2026-07-09):
 *   - Stats tab renders an AG Grid (data-testid="data-table"), one row per
 *     GAME, not a season total. AG Grid splits each row across a pinned-left
 *     container (just the "event"/date column) and a separate scrollable
 *     center container (every other column) — both share the same row-id,
 *     which is how we zip them back into one object per row.
 *   - Spray Chart tab renders a real SVG (.SprayChart__container svg), not
 *     a canvas — actual plotted <circle cx cy> points, not a screenshot.
 *     Data points are r="4" exactly; two decorative legend-swatch circles
 *     share coordinates but have r="4.83840749", so the exact r="4" match
 *     cleanly excludes them. fill="#00D682" = Hit, fill="#B90018" = Out.
 *
 * NOT YET VALIDATED LIVE: whether AG Grid column-virtualizes on a real
 * viewport during Playwright scraping (Troy's static dump showed all 26
 * columns present, but that was a manually saved page, not necessarily
 * proof the live grid never virtualizes columns off-screen). If captured
 * rows come back missing columns, that's the first thing to check — run
 * with GC_HANDEDNESS_DEBUG_HTML=true and inspect the dumped stats-*.html.
 */

const DEBUG_ON = () => process.env.GC_HANDEDNESS_DEBUG_HTML === 'true';

// GC's Fielding sub-tabs aren't confirmed to always be exactly
// Standard/Advanced or Standard/Catching — Troy said "catching when it's
// available", implying it's conditional per player. Rather than hardcode
// assumptions, we enumerate whatever sub-tabs actually render and only
// keep the ones that map to an allowed category (matching the DB check
// constraint on player_gc_stats.category). Anything unrecognized is
// logged and skipped rather than crashing the whole capture.
const CATEGORY_MAP = {
  'batting|standard':  'batting_standard',
  'batting|advanced':  'batting_advanced',
  'pitching|standard': 'pitching_standard',
  'pitching|advanced': 'pitching_advanced',
  'fielding|standard': 'fielding_standard',
  'fielding|catching': 'fielding_catching',
  'fielding|advanced': 'fielding_catching', // in case GC actually labels it differently per player
};

function safeName(name) {
  return String(name || 'unknown').replace(/[^a-z0-9]/gi, '-').toLowerCase();
}

async function maybeDumpDebugHtml(page, filename) {
  if (!DEBUG_ON()) return;
  try {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', 'output', '_handedness-debug');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), await page.content(), 'utf8');
    console.log(`[gc-stats] Wrote debug HTML: ${filename}`);
  } catch (error) {
    console.warn(`[gc-stats] Failed to write debug HTML ${filename}: ${error.message}`);
  }
}

// ─── Tab helpers ────────────────────────────────────────────────────────────

async function clickTabByName(page, name, { timeout = 8000 } = {}) {
  const tab = page.getByRole('tab', { name: new RegExp(`^${name}$`, 'i') });
  try {
    await tab.first().waitFor({ state: 'visible', timeout });
    await tab.first().click();
    await page.waitForTimeout(700);
    return true;
  } catch {
    return false;
  }
}

// Returns the visible tab labels inside a specific chooser container, so we
// don't have to hardcode which sub-tabs exist for a given top-level category.
async function enumerateTabLabels(page, containerSelector) {
  try {
    const container = page.locator(containerSelector).first();
    const tabs = container.getByRole('tab');
    const count = await tabs.count();
    const labels = [];
    for (let i = 0; i < count; i++) {
      const text = (await tabs.nth(i).textContent() || '').trim();
      if (text) labels.push(text);
    }
    return labels;
  } catch {
    return [];
  }
}

// ─── AG Grid extraction (generic — works for any Stats sub-tab) ───────────

async function extractCurrentStatsTable(page) {
  const hasTable = await page.locator('[data-testid="data-table"]').count();
  if (!hasTable) return null;

  // Let AG Grid settle after the tab click before reading cells.
  await page.waitForTimeout(500);

  return page.evaluate(() => {
    function norm(t) { return (t || '').replace(/\s+/g, ' ').trim(); }

    const container = document.querySelector('[data-testid="data-table"]');
    if (!container) return null;

    const columns = [];
    const seenCols = new Set();
    for (const cell of Array.from(container.querySelectorAll('.ag-header-cell[col-id]'))) {
      const colId = cell.getAttribute('col-id');
      if (!colId || seenCols.has(colId)) continue;
      seenCols.add(colId);
      const labelEl = cell.querySelector('.ag-header-cell-text') || cell;
      columns.push({ id: colId, label: norm(labelEl.textContent) || colId });
    }

    // querySelectorAll on the whole container reaches both AG Grid's
    // pinned-left and center sub-containers, so zipping by row-id merges
    // both halves of each row without needing to know about the split.
    const rowMap = new Map();
    for (const rowEl of Array.from(container.querySelectorAll('.ag-row[row-id]'))) {
      const rowId = rowEl.getAttribute('row-id');
      if (!rowMap.has(rowId)) rowMap.set(rowId, {});
      const rowObj = rowMap.get(rowId);
      for (const cell of Array.from(rowEl.querySelectorAll('.ag-cell[col-id]'))) {
        const colId = cell.getAttribute('col-id');
        if (colId) rowObj[colId] = norm(cell.textContent);
      }
    }

    const rows = Array.from(rowMap.entries())
      .sort((a, b) => {
        const na = Number(a[0]);
        const nb = Number(b[0]);
        if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
        return 0;
      })
      .map(([, obj]) => obj);

    return { columns, rows };
  });
}

// ─── Spray chart extraction ────────────────────────────────────────────────

async function extractBattingSprayChart(page) {
  const hasChart = await page.locator('.SprayChart__container svg').count();
  if (!hasChart) return null;

  return page.evaluate(() => {
    const svg = document.querySelector('.SprayChart__container svg');
    if (!svg) return null;

    const viewBox = svg.getAttribute('viewBox') || '';

    // r="4" exactly is the real data points; legend swatch icons share
    // coordinates but use r="4.83840749" — the exact string match on r
    // reliably excludes them without any other filtering.
    const circles = Array.from(svg.querySelectorAll('circle[cx][cy][r="4"]'));
    const points = circles.map((c) => {
      const fill = (c.getAttribute('fill') || '').toUpperCase();
      let outcome = 'unknown';
      if (fill === '#00D682') outcome = 'hit';
      else if (fill === '#B90018') outcome = 'out';
      return {
        x: Number(c.getAttribute('cx')),
        y: Number(c.getAttribute('cy')),
        outcome,
      };
    });

    return { viewBox, points };
  });
}

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * @param {import('@playwright/test').Page} page  Already on the player's
 *   FanPlayerProfile pane (same page state captureRosterHandedness leaves
 *   it in right after extractHandednessFromProfile()).
 * @param {object} opts
 * @param {number|string} opts.teamId
 * @param {string} opts.jerseyNumber
 * @param {string} opts.fullName
 * @param {string} opts.matchKey
 * @param {object} opts.db   db.js/db-supabase.js module (already init()'d).
 * @returns {Promise<{statsCaptured: number, statsFailed: number, sprayCaptured: boolean, statsTabFound: boolean, sprayTabFound: boolean}>}
 */
async function captureGcStatsAndSprayForPlayer(page, { teamId, jerseyNumber, fullName, matchKey, db }) {
  const result = {
    statsCaptured: 0,
    statsFailed: 0,
    sprayCaptured: false,
    // Not every team makes this available on GameChanger — that's a normal,
    // expected outcome, not a failure. These two flags tell the caller
    // whether the Stats/Spray Charts tabs existed AT ALL for this player, so
    // it can stop bothering to check for the rest of that team's roster
    // instead of re-attempting (and timing out) on every single player.
    statsTabFound: false,
    sprayTabFound: false,
  };
  const label = `${fullName} (#${jerseyNumber || '?'})`;

  // ── Stats tab: enumerate top categories (Batting/Pitching/Fielding), then
  // enumerate whatever sub-tabs each one actually has, rather than assuming.
  const openedStats = await clickTabByName(page, 'Stats');
  if (!openedStats) {
    console.log(`[gc-stats] Stats tab not available for ${label} (team likely doesn't share this on GameChanger).`);
  } else {
    result.statsTabFound = true;
    const topCategories = await enumerateTabLabels(page, '[data-testid="stats-view-chooser"]');
    if (!topCategories.length) {
      console.warn(`[gc-stats] Stats tab opened for ${label} but no Batting/Pitching/Fielding sub-tabs were found — that's unexpected, worth a debug dump.`);
    }

    for (const topCategory of topCategories) {
      const clickedTop = await clickTabByName(page, topCategory);
      if (!clickedTop) continue;

      const subTabs = await enumerateTabLabels(page, '.StatsTable__tabviewSelector');
      const iterableSubs = subTabs.length ? subTabs : [null]; // some views may have no sub-split at all

      for (const subTab of iterableSubs) {
        if (subTab) {
          const clickedSub = await clickTabByName(page, subTab);
          if (!clickedSub) continue;
        }

        const categoryKey = `${topCategory.toLowerCase()}|${(subTab || 'standard').toLowerCase()}`;
        const category = CATEGORY_MAP[categoryKey];
        if (!category) {
          console.warn(`[gc-stats] Unrecognized stats category "${categoryKey}" for ${label} — skipping (not in the allowed category list).`);
          continue;
        }

        try {
          const table = await extractCurrentStatsTable(page);
          if (!table || !table.rows.length) {
            console.log(`[gc-stats] No table data for ${label} / ${category}.`);
            continue;
          }
          await db.upsertPlayerGcStats(teamId, {
            jerseyNumber,
            fullName,
            matchKey,
            category,
            columns: table.columns,
            rows: table.rows,
          });
          result.statsCaptured++;
          if (DEBUG_ON()) {
            console.log(`[gc-stats] Captured ${label} / ${category}: ${table.rows.length} row(s).`);
          }
        } catch (error) {
          console.error(`[gc-stats] Failed to capture ${label} / ${category}: ${error.message}`);
          await maybeDumpDebugHtml(page, `STATSFAIL-${safeName(fullName)}-${jerseyNumber || 'nojersey'}-${category}.html`);
          result.statsFailed++;
        }
      }
    }
  }

  // ── Spray Charts tab: batting only, per Troy's ask.
  const openedSpray = await clickTabByName(page, 'Spray Charts');
  if (!openedSpray) {
    console.log(`[gc-stats] Spray Charts tab not available for ${label} (team likely doesn't share this on GameChanger).`);
  } else {
    result.sprayTabFound = true;
    // Batting is the default sub-view in every dump we've seen, but click it
    // explicitly in case Pitching was left selected from a prior player.
    await clickTabByName(page, 'Batting');

    try {
      const chart = await extractBattingSprayChart(page);
      if (!chart || !chart.points.length) {
        console.log(`[gc-stats] No spray chart data for ${label} (team may not have this enabled).`);
      } else {
        await db.upsertPlayerGcSprayChart(teamId, {
          jerseyNumber,
          fullName,
          matchKey,
          category: 'batting',
          viewBox: chart.viewBox,
          points: chart.points,
        });
        result.sprayCaptured = true;
        if (DEBUG_ON()) {
          console.log(`[gc-stats] Captured spray chart for ${label}: ${chart.points.length} point(s).`);
        }
      }
    } catch (error) {
      console.error(`[gc-stats] Failed to capture spray chart for ${label}: ${error.message}`);
      await maybeDumpDebugHtml(page, `SPRAYFAIL-${safeName(fullName)}-${jerseyNumber || 'nojersey'}.html`);
    }
  }

  return result;
}

module.exports = {
  captureGcStatsAndSprayForPlayer,
  // exported for testing
  _internals: { extractCurrentStatsTable, extractBattingSprayChart, CATEGORY_MAP },
};