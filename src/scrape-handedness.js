'use strict';

/**
 * scrape-handedness.js
 *
 * Captures batting-hand / throwing-hand for every player on a scouted
 * opponent's GameChanger roster, by navigating from OUR team's GC page ->
 * Opponents -> the opponent team -> Roster, and reading the "Edit Player"
 * modal for each player (we never click Save — this is read-only).
 *
 * Re-scrape behavior: players already captured (matched by jersey_number,
 * falling back to normalized full name) are SKIPPED. Only new roster
 * entries get their modal opened. Pass forceRefresh: true to re-capture
 * everyone.
 *
 * NOTE ON SELECTORS: GameChanger's roster list and the "Edit Player" modal
 * (First Name / Last Name / Jersey Number / Batting Hand / Throwing Hand)
 * have not yet been inspected against real page HTML the way the rest of
 * this codebase's selectors were hardened. The heading-proximity + segmented-
 * control heuristics below are written defensively (multiple fallback
 * strategies per field) but WILL likely need one round of adjustment against
 * a real captured page. Troy's established pattern for this: run once with
 * GC_HANDEDNESS_DEBUG_HTML=true (dumps roster page + one modal's outerHTML
 * to output/_handedness-debug/), upload those files, and selectors get
 * tightened from real DOM instead of guessing further.
 */

const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const DEBUG_DIR = path.join(OUTPUT_DIR, '_handedness-debug');
function isDebugHtmlEnabled() {
  return process.env.GC_HANDEDNESS_DEBUG_HTML === 'true';
}

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

// ─── Small local copies of shared helpers ──────────────────────────────────
// (Duplicated rather than imported from search-gamechanger-teams.js so this
// module can be required standalone without triggering that file's module-
// level side effects.)

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function simplifyTeamText(value) {
  return normalizeText(value)
    .replace(/\bsoutheast\b/g, 'se')
    .replace(/\bsouth east\b/g, 'se')
    .replace(/\bnational\b/g, '')
    .replace(/\bteam\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function teamTokens(value) {
  return simplifyTeamText(value)
    .split(/\s+/)
    .map(t => t.replace(/[^a-z0-9]/g, ''))
    .filter(t => t.length >= 2 && !['the', 'and', 'baseball', 'club'].includes(t));
}

function scoreOpponentText(rawText, rawHref, targetName) {
  const text = simplifyTeamText(rawText);
  const target = simplifyTeamText(targetName);
  const href = normalizeText(rawHref);
  if (!text) return -1;

  if (text === target) return 120;
  if (text.includes(target)) return 100;
  if (target.includes(text) && text.length >= 8) return 75;

  const targetTokens = teamTokens(targetName);
  const textTokens = new Set(teamTokens(rawText));
  if (!targetTokens.length) return -1;

  let matched = 0;
  for (const token of targetTokens) {
    if (textTokens.has(token) || text.includes(token)) matched++;
  }

  let score = Math.round((matched / targetTokens.length) * 70);

  // Common GC abbreviation: Southeast may appear as SE.
  if (/\bsoutheast\b/i.test(targetName) && /\bse\b/.test(text)) score += 12;
  if (/\busa\b/.test(target) && /\busa\b/.test(text)) score += 8;
  if (/\bprime\b/.test(target) && /\bprime\b/.test(text)) score += 8;
  if (/\bscout\b/.test(target) && /\bscout\b/.test(text)) score += 8;

  const targetAge = String(targetName || '').match(/\b\d{1,2}\s*u\b/i)?.[0]?.replace(/\s+/g, '').toLowerCase();
  if (targetAge && text.replace(/\s+/g, '').includes(targetAge)) score += 10;

  if (href.includes('/teams/')) score += 8;

  // Penalize huge page/nav containers. They often contain the target words
  // somewhere, but are not a real row/link to click.
  if (String(rawText || '').length > 500) score -= 25;
  if (String(rawText || '').length > 1200) score -= 40;

  return score;
}

async function dismissDontMissOutPopup(page) {
  const candidates = [
    page.getByRole('button', { name: /maybe later/i }),
    page.getByText(/maybe later/i)
  ];
  for (const locator of candidates) {
    try {
      await locator.first().waitFor({ state: 'visible', timeout: 2000 });
      await locator.first().click();
      await page.waitForTimeout(500);
      return true;
    } catch {
      // Popup did not appear.
    }
  }
  return false;
}

async function safeClick(page, locator, description = 'element') {
  await dismissDontMissOutPopup(page);
  await locator.first().waitFor({ state: 'visible', timeout: 10000 });
  await locator.first().click();
  await page.waitForTimeout(600);
  await dismissDontMissOutPopup(page);
  console.log(`[handedness] Clicked ${description}`);
}

// ─── Name matching ──────────────────────────────────────────────────────────

/**
 * Builds a fuzzy join key so roster names ("Noah Harbin") match the
 * abbreviated names GameChanger uses in play-by-play / box scores
 * ("N Harbin"). Two players sharing a last name + first initial on one
 * roster will collide on this key — acceptable for now; jersey_number is
 * the real identity used for roster diffing.
 */
function buildMatchKey(fullName) {
  const cleaned = normalizeText(fullName).replace(/[^a-z\s'-]/g, '');
  const parts = cleaned.split(' ').filter(Boolean);
  if (!parts.length) return '';
  const last = parts[parts.length - 1];
  const firstInitial = parts[0].charAt(0);
  return `${last}|${firstInitial}`;
}

function splitFullName(fullName) {
  const cleaned = String(fullName || '').replace(/\s+/g, ' ').trim();
  const parts = cleaned.split(' ');
  if (parts.length === 1) return { firstName: parts[0] || '', lastName: '' };
  const lastName = parts[parts.length - 1];
  const firstName = parts.slice(0, -1).join(' ');
  return { firstName, lastName };
}

// ─── Navigation: our team -> Opponents -> opponent team -> Roster ─────────

async function openTeamPage(page, gcTeamUrl) {
  console.log(`[handedness] Opening team page: ${gcTeamUrl}`);
  await page.goto(gcTeamUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  } catch {
    // GC keeps background requests open; fine to proceed.
  }
  await page.waitForTimeout(2000);
  await dismissDontMissOutPopup(page);
}

async function openOpponentsTab(page) {
  console.log('[handedness] Looking for Opponents tab...');
  const candidates = [
    page.getByRole('link', { name: /^opponents$/i }),
    page.getByRole('button', { name: /^opponents$/i }),
    page.getByText(/^opponents$/i),
    page.locator('a:has-text("Opponents")'),
    page.locator('button:has-text("Opponents")')
  ];
  for (const locator of candidates) {
    try {
      await safeClick(page, locator, 'Opponents tab');
      return true;
    } catch {
      // try next candidate
    }
  }
  console.log('[handedness] No dedicated Opponents tab found.');
  return false;
}

async function openScheduleTab(page) {
  console.log('[handedness] Looking for Schedule tab...');
  const candidates = [
    page.getByRole('link', { name: /^schedule$/i }),
    page.getByRole('button', { name: /^schedule$/i }),
    page.getByText(/^schedule$/i),
    page.locator('a:has-text("Schedule")'),
    page.locator('button:has-text("Schedule")')
  ];
  for (const locator of candidates) {
    try {
      await safeClick(page, locator, 'Schedule tab');
      return true;
    } catch {
      // try next candidate
    }
  }
  console.log('[handedness] Could not find/click Schedule tab.');
  return false;
}

async function scanForOpponentLink(page, opponentTeamName) {
  const candidates = await page.evaluate((targetName) => {
    function norm(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }
    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 5 && rect.height > 5 && style.visibility !== 'hidden' && style.display !== 'none';
    }
    function nearestHref(el) {
      const closestAnchor = el.closest && el.closest('a[href]');
      if (closestAnchor) return closestAnchor.href || '';
      const innerAnchor = el.querySelector && el.querySelector('a[href]');
      return innerAnchor ? innerAnchor.href || '' : '';
    }

    const selectors = [
      'a[href]',
      'button',
      '[role="link"]',
      '[role="button"]',
      '[tabindex]:not([tabindex="-1"])',
      'li',
      'tr',
      'div'
    ];

    const seen = new Set();
    const raw = [];
    const nodes = Array.from(document.querySelectorAll(selectors.join(',')));

    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const text = norm(el.innerText || el.textContent || '');
      if (!text || text.length < 3 || text.length > 1500) continue;

      // Keep likely team rows/links. This prevents every layout div from
      // becoming noise while still allowing non-anchor clickable rows.
      const lower = text.toLowerCase();
      const targetWords = String(targetName || '')
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length >= 3 || /\d{1,2}u/.test(w));
      const wordHits = targetWords.filter(w => lower.includes(w.replace(/[^a-z0-9]/g, '')) || lower.includes(w)).length;
      const teamish = /\b\d{1,2}\s*u\b/i.test(text) || /\b(players?|staff|spring|summer|fall|winter|prime|scout|national|elite)\b/i.test(text);
      if (!teamish && wordHits === 0) continue;

      const href = nearestHref(el);
      const key = `${href}|${text}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || '';
      const rect = el.getBoundingClientRect();
      raw.push({
        text,
        href,
        tag,
        role,
        y: Math.round(rect.top),
        height: Math.round(rect.height),
        className: String(el.className || '').slice(0, 180),
      });
    }

    const scrollState = {
      windowY: Math.round(window.scrollY || document.documentElement.scrollTop || 0),
      documentHeight: Math.round(document.documentElement.scrollHeight || 0),
      viewportHeight: Math.round(window.innerHeight || 0),
      scrollables: Array.from(document.querySelectorAll('body *'))
        .filter((el) => {
          const style = window.getComputedStyle(el);
          return /(auto|scroll)/.test(`${style.overflowY} ${style.overflow}`) && el.scrollHeight > el.clientHeight + 20;
        })
        .slice(0, 12)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          className: String(el.className || '').slice(0, 120),
          scrollTop: Math.round(el.scrollTop),
          scrollHeight: Math.round(el.scrollHeight),
          clientHeight: Math.round(el.clientHeight),
          text: norm(el.innerText || el.textContent || '').slice(0, 120),
        })),
    };

    return { raw, scrollState };
  }, opponentTeamName);

  let best = null;
  let bestScore = -1;
  const scored = [];

  for (const candidate of candidates.raw) {
    const score = scoreOpponentText(candidate.text, candidate.href, opponentTeamName);
    const item = { ...candidate, score };
    scored.push(item);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  scored.sort((a, b) => b.score - a.score || String(a.text).length - String(b.text).length);

  return {
    best,
    bestScore,
    candidateCount: candidates.raw.length,
    scrollState: candidates.scrollState,
    topCandidates: scored.slice(0, 12),
  };
}

async function forceScrollOpponentList(page, step = 900) {
  // Do both: real wheel events for GC intersection observers, plus direct
  // scrollTop movement on every scrollable container in case the mouse is not
  // sitting over the actual virtualized list.
  await page.mouse.move(720, 620);
  await page.mouse.wheel(0, step);

  return await page.evaluate((delta) => {
    const moved = [];
    const beforeWindow = window.scrollY || document.documentElement.scrollTop || 0;
    window.scrollBy(0, delta);
    const afterWindow = window.scrollY || document.documentElement.scrollTop || 0;
    if (afterWindow !== beforeWindow) moved.push({ target: 'window', before: beforeWindow, after: afterWindow });

    const scrollables = Array.from(document.querySelectorAll('body *'))
      .filter((el) => {
        const style = window.getComputedStyle(el);
        return /(auto|scroll)/.test(`${style.overflowY} ${style.overflow}`) && el.scrollHeight > el.clientHeight + 20;
      });

    for (const el of scrollables) {
      const before = el.scrollTop;
      el.scrollTop = Math.min(el.scrollTop + delta, el.scrollHeight);
      if (el.scrollTop !== before) {
        moved.push({
          target: `${el.tagName.toLowerCase()}.${String(el.className || '').slice(0, 60)}`,
          before,
          after: el.scrollTop,
        });
      }
    }

    return moved;
  }, step);
}

async function clickBestOpponentCandidate(page, candidate) {
  if (candidate.href && candidate.href.includes('/teams/')) {
    console.log(`[handedness] Navigating directly to matched opponent link: ${candidate.href}`);
    await page.goto(candidate.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } else if (candidate.href) {
    console.log(`[handedness] Candidate has href but not /teams/: ${candidate.href}. Navigating anyway.`);
    await page.goto(candidate.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } else {
    console.log(`[handedness] Clicking matched opponent row text: ${candidate.text}`);
    const exactText = candidate.text.length < 120 ? candidate.text : candidate.text.slice(0, 80);
    const clickCandidates = [
      page.getByRole('link', { name: new RegExp(escapeRegex(exactText), 'i') }),
      page.getByRole('button', { name: new RegExp(escapeRegex(exactText), 'i') }),
      page.getByText(new RegExp(escapeRegex(exactText), 'i')),
    ];
    let clicked = false;
    for (const locator of clickCandidates) {
      try {
        await safeClick(page, locator, 'matched opponent row');
        clicked = true;
        break;
      } catch {}
    }
    if (!clicked) throw new Error(`Could not click matched opponent candidate: ${candidate.text}`);
  }

  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  } catch {}
  await page.waitForTimeout(1500);
  await dismissDontMissOutPopup(page);
  return true;
}

/**
 * Finds and clicks a link to the given opponent team, either from a
 * dedicated Opponents list page or from opponent-name links embedded in
 * the Schedule tab (each schedule row typically links to the opposing
 * team's page).
 *
 * GameChanger virtualizes some long lists. Do not stop just because the
 * number of anchors is unchanged: virtualized lists often keep a constant
 * DOM size while swapping row contents as you scroll.
 */
async function clickOpponentTeamLink(page, opponentTeamName, options = {}) {
  const contextLabel = options.contextLabel || 'current page';
  console.log(`[handedness] Looking for opponent link matching: ${opponentTeamName} (${contextLabel})`);

  let best = null;
  let bestScore = -1;
  let lastScan = null;
  let noScrollMovementStreak = 0;
  const MAX_SCROLLS = 45;
  const MATCH_THRESHOLD = 40;

  for (let i = 0; i <= MAX_SCROLLS; i++) {
    const scan = await scanForOpponentLink(page, opponentTeamName);
    lastScan = scan;

    if (scan.bestScore > bestScore) {
      best = scan.best;
      bestScore = scan.bestScore;
      if (best) {
        console.log(
          `[handedness] Best candidate after ${i} scroll(s): score ${bestScore} — ` +
          `${String(best.text || '').slice(0, 140)}${best.href ? ` (${best.href})` : ''}`
        );
      }
    }

    if (best && bestScore >= MATCH_THRESHOLD) {
      console.log(`[handedness] Match found after ${i} scroll(s), ${scan.candidateCount} candidate rows/links visible.`);
      return await clickBestOpponentCandidate(page, best);
    }

    if (i === MAX_SCROLLS) break;

    const moved = await forceScrollOpponentList(page, 900);
    if (!moved.length) noScrollMovementStreak++;
    else noScrollMovementStreak = 0;

    if (i > 0 && i % 5 === 0) {
      const top = (scan.topCandidates || [])
        .slice(0, 3)
        .map(c => `${c.score}:${String(c.text || '').slice(0, 55)}`)
        .join(' | ');
      console.log(`[handedness] Scroll ${i}/${MAX_SCROLLS}; candidates=${scan.candidateCount}; top=${top || 'none'}`);
    }

    // Give virtualized lists time to swap rendered rows.
    await page.waitForTimeout(650);

    // If neither window nor any scrollable container moved several times in a
    // row, we are probably genuinely at the end. Wait for three misses so one
    // bad cursor position does not kill the scrape after a single wheel event.
    if (noScrollMovementStreak >= 3) {
      console.log(`[handedness] No scroll movement detected ${noScrollMovementStreak} times — likely at bottom/end of list.`);
      break;
    }
  }

  console.log(`[handedness] No confident opponent link match found (best score: ${bestScore}).`);
  if (lastScan?.topCandidates?.length) {
    console.log('[handedness] Top visible candidates at failure:');
    for (const c of lastScan.topCandidates.slice(0, 8)) {
      console.log(`  score ${c.score}: ${String(c.text || '').slice(0, 180)}${c.href ? ` | ${c.href}` : ''}`);
    }
  }
  await maybeDumpDebugHtml(page, `${contextLabel.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}-NOMATCH.html`, { force: true });
  await maybeDumpDebugJson(page, `${contextLabel.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}-NOMATCH-candidates.json`, lastScan || {}, { force: true });
  return false;
}

async function openRosterTab(page) {
  console.log('[handedness] Looking for Roster/Team tab...');
  const candidates = [
    page.getByRole('link', { name: /^roster$/i }),
    page.getByRole('button', { name: /^roster$/i }),
    page.getByText(/^roster$/i),
    page.locator('a:has-text("Roster")'),
    page.getByRole('link', { name: /^team$/i }),
    page.locator('a:has-text("Team")')
  ];
  for (const locator of candidates) {
    try {
      await safeClick(page, locator, 'Roster tab');
      return true;
    } catch {
      // try next
    }
  }
  console.log('[handedness] Could not find/click a Roster tab.');
  return false;
}

async function maybeDumpDebugHtml(page, filename, { force = false } = {}) {
  if (!isDebugHtmlEnabled() && !force) return;
  try {
    ensureDirectory(DEBUG_DIR);
    const html = await page.content();
    fs.writeFileSync(path.join(DEBUG_DIR, filename), html, 'utf8');
    console.log(`[handedness] Wrote debug HTML: ${filename}`);
  } catch (error) {
    console.warn(`[handedness] Failed to write debug HTML ${filename}: ${error.message}`);
  }
}

async function maybeDumpDebugJson(page, filename, data, { force = false } = {}) {
  if (!isDebugHtmlEnabled() && !force) return;
  try {
    ensureDirectory(DEBUG_DIR);
    fs.writeFileSync(path.join(DEBUG_DIR, filename), JSON.stringify(data, null, 2), 'utf8');
    console.log(`[handedness] Wrote debug JSON: ${filename}`);
  } catch (error) {
    console.warn(`[handedness] Failed to write debug JSON ${filename}: ${error.message}`);
  }
}

// ─── Roster row extraction ──────────────────────────────────────────────────

/**
 * Returns [{ name, jerseyNumber, rowIndex }] for every player visible on
 * the roster page. rowIndex is used to re-click the row after the page
 * re-renders (name/jersey text is NOT assumed to be a stable selector
 * across renders, only useful for logging/matching).
 */
async function getRosterEntries(page) {
  await maybeDumpDebugHtml(page, 'roster-page.html');

  const entries = await page.evaluate(() => {
    function norm(t) { return (t || '').replace(/\s+/g, ' ').trim(); }

    function parseRosterRowText(rawText) {
      const text = norm(rawText);
      if (!text || text.length > 120) return null;

      // Real GC opponent roster rows look like:
      //   "Kason Walker, #1"
      //   "Lafountain, #9"
      // The previous heuristic stripped the number and left the trailing comma,
      // so every real player row was rejected and navbar/footer buttons won.
      const withJersey = text.match(/^(.+?),\s*#\s*([A-Za-z0-9-]{1,6})$/);
      if (!withJersey) return null;

      const name = norm(withJersey[1]).replace(/,$/, '').trim();
      const jerseyNumber = norm(withJersey[2]);
      if (!name || !jerseyNumber) return null;

      const lower = name.toLowerCase();
      const banned = [
        'sign out', 'get the app', 'try our family plan', 'opponent roster',
        'add player', 'back to opponents', 'home', 'support', 'account'
      ];
      if (banned.some((word) => lower.includes(word))) return null;

      // Allow single-name roster entries (GC sometimes has last-name-only
      // players), but require name-shaped text.
      if (!/^[A-Za-z][A-Za-z.'-]*(\s+[A-Za-z][A-Za-z.'-]*)*$/.test(name)) return null;

      return { name, jerseyNumber, rowText: text };
    }

    const rows = [];
    const seen = new Set();

    // Confirmed from saved GC roster HTML: every player is a clickable
    // ListRow container with a ListRow__mainContent child containing
    // "Player Name, #Number".
    const preferred = Array.from(document.querySelectorAll(
      '.ListRow__container[role="button"], .ListRow__listRow[role="button"], [role="button"] .ListRow__mainContent'
    ));

    for (const el of preferred) {
      const row = el.matches && el.matches('.ListRow__mainContent')
        ? el.closest('[role="button"]') || el.parentElement
        : el;
      const main = row?.querySelector?.('.ListRow__mainContent') || el;
      const parsed = parseRosterRowText(main.textContent);
      if (!parsed) continue;
      const key = `${parsed.name.toLowerCase()}|${parsed.jerseyNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(parsed);
    }

    if (rows.length) {
      return rows.map((r, i) => ({ ...r, rowIndex: i }));
    }

    // Fallback for future GC markup changes: scan visible text nodes, but
    // still require the exact "Name, #Number" shape so nav/footer copy cannot
    // masquerade as players.
    const fallbackNodes = Array.from(document.querySelectorAll('li, tr, [role="row"], [role="button"], div, span'));
    for (const el of fallbackNodes) {
      const parsed = parseRosterRowText(el.textContent);
      if (!parsed) continue;
      const key = `${parsed.name.toLowerCase()}|${parsed.jerseyNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(parsed);
    }

    return rows.map((r, i) => ({ ...r, rowIndex: i }));
  });

  console.log(`[handedness] Found ${entries.length} roster entries on the page.`);
  if (entries.length) {
    console.log(`[handedness] Roster sample: ${entries.slice(0, 5).map(e => `${e.name} #${e.jerseyNumber || '?'}`).join(', ')}`);
  }
  return entries;
}

async function openPlayerModalByRosterEntry(page, entry) {
  const rowText = entry.rowText || `${entry.name}, #${entry.jerseyNumber || ''}`;
  const exactRowText = new RegExp(`^${escapeRegex(rowText)}$`, 'i');

  // Primary: click the confirmed GC row structure from the saved HTML.
  const mainContent = page.locator('.ListRow__mainContent').filter({ hasText: exactRowText });
  const rowFromMainContent = mainContent.locator('xpath=ancestor::*[contains(@class,"ListRow__container") or contains(@class,"ListRow__listRow")][1]');

  try {
    await safeClick(page, rowFromMainContent, `roster row for ${entry.name}`);
    return true;
  } catch {
    // Fall through to JS click fallback.
  }

  // Secondary: React click handler is on a span[role="button"]. Find it by
  // parsed name/jersey and dispatch a normal DOM click.
  const clicked = await page.evaluate(({ name, jerseyNumber }) => {
    function norm(t) { return (t || '').replace(/\s+/g, ' ').trim(); }
    function parseRosterRowText(rawText) {
      const text = norm(rawText);
      const m = text.match(/^(.+?),\s*#\s*([A-Za-z0-9-]{1,6})$/);
      if (!m) return null;
      return { name: norm(m[1]).replace(/,$/, '').trim(), jerseyNumber: norm(m[2]) };
    }

    const rows = Array.from(document.querySelectorAll('.ListRow__container[role="button"], .ListRow__listRow[role="button"], [role="button"]'));
    for (const row of rows) {
      const main = row.querySelector('.ListRow__mainContent') || row;
      const parsed = parseRosterRowText(main.textContent);
      if (!parsed) continue;
      if (parsed.name.toLowerCase() === String(name || '').toLowerCase() &&
          String(parsed.jerseyNumber || '') === String(jerseyNumber || '')) {
        row.scrollIntoView({ block: 'center' });
        row.click();
        return true;
      }
    }
    return false;
  }, entry);

  if (clicked) {
    await page.waitForTimeout(600);
    await dismissDontMissOutPopup(page);
    console.log(`[handedness] Clicked roster row for ${entry.name}`);
    return true;
  }

  // Last fallback: old text strategy, now using rowText instead of bare name.
  const rowCandidates = [
    page.getByText(exactRowText),
    page.locator(`text="${rowText}"`)
  ];
  for (const locator of rowCandidates) {
    try {
      await safeClick(page, locator, `roster row for ${entry.name}`);
      return true;
    } catch {
      // try next
    }
  }

  console.warn(`[handedness] Could not open roster row for: ${entry.name} (#${entry.jerseyNumber || '?'})`);
  return false;
}

async function openPlayerModalByRowText(page, playerName) {
  // Kept for tests/backward compatibility. The real capture loop now calls
  // openPlayerModalByRosterEntry() so it can target the exact Name/# row.
  return openPlayerModalByRosterEntry(page, { name: playerName, jerseyNumber: null, rowText: playerName });
}

// ─── Edit Player modal extraction ──────────────────────────────────────────

async function waitForPlayerModal(page) {
  const candidates = [
    page.getByRole('dialog'),
    page.getByText(/^edit player$/i)
  ];
  for (const locator of candidates) {
    try {
      await locator.first().waitFor({ state: 'visible', timeout: 8000 });
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

async function extractHandednessFromModal(page) {
  await maybeDumpDebugHtml(page, `modal-${Date.now()}.html`);

  const data = await page.evaluate(() => {
    function norm(t) { return (t || '').replace(/\s+/g, ' ').trim(); }

    function findLeafByExactText(regex) {
      const nodes = Array.from(document.querySelectorAll('body *'));
      return nodes.find((el) => el.children.length === 0 && regex.test(norm(el.textContent)));
    }

    function getLabeledInputValue(labelRegex) {
      const labelEl = findLeafByExactText(labelRegex);
      if (!labelEl) return null;
      let container = labelEl.parentElement;
      for (let depth = 0; depth < 4 && container; depth++) {
        const input = container.querySelector('input');
        if (input) return input.value || '';
        container = container.parentElement;
      }
      return null;
    }

    function getSegmentedSelection(labelRegex, allowedOptions) {
      const allowed = allowedOptions.map((x) => x.toLowerCase());
      const labelEl = findLeafByExactText(labelRegex);
      if (!labelEl) return { value: null, method: 'label-not-found', options: [] };

      function isVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      }

      function parseRgb(cssColor) {
        const m = String(cssColor || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?/i);
        if (!m) return null;
        return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] == null ? 1 : Number(m[4]) };
      }

      function isSelectedBlue(cssColor) {
        const rgb = parseRgb(cssColor);
        if (!rgb || rgb.a === 0) return false;
        // GC selected pills are saturated brand blue. Keep this narrow enough
        // to reject the pale unselected segmented-control background.
        return (
          rgb.b >= 140 &&
          rgb.g >= 70 &&
          rgb.r <= 90 &&
          (rgb.b - rgb.r) >= 70 &&
          (rgb.g - rgb.r) >= 25
        );
      }

      function isLightText(cssColor) {
        const rgb = parseRgb(cssColor);
        if (!rgb || rgb.a === 0) return false;
        return rgb.r >= 175 && rgb.g >= 175 && rgb.b >= 175;
      }

      function optionRootFor(el, fieldContainer) {
        const root = el.closest('button, [role="button"], [role="radio"], label, [class*="Segment"], [class*="Pill"], [class*="Button"]');
        if (root && fieldContainer.contains(root)) return root;
        return el;
      }

      function inspectOption(optionEl, fieldContainer) {
        const nodes = [];
        const add = (el) => {
          if (el && fieldContainer.contains(el) && !nodes.includes(el)) nodes.push(el);
        };

        add(optionEl);
        let current = optionEl.parentElement;
        for (let depth = 0; depth < 5 && current && fieldContainer.contains(current); depth++) {
          add(current);
          current = current.parentElement;
        }
        // In some GC builds the blue background is on a child/span, not the
        // clickable root. Include descendants too, but only inside the option.
        for (const child of Array.from(optionEl.querySelectorAll('*')).slice(0, 20)) add(child);

        // Keep the live element alongside each sample so bluePillVisual below
        // can check actual containment, not just "found somewhere in the
        // scan". `el` is stripped before this object leaves inspectOption —
        // Playwright can't serialize a DOM handle back across page.evaluate().
        const samples = nodes.map((el) => {
          const style = getComputedStyle(el);
          return {
            el,
            tag: el.tagName,
            text: norm(el.textContent),
            className: String(el.className || ''),
            role: el.getAttribute('role'),
            ariaPressed: el.getAttribute('aria-pressed'),
            ariaSelected: el.getAttribute('aria-selected'),
            ariaChecked: el.getAttribute('aria-checked'),
            dataState: el.getAttribute('data-state'),
            dataSelected: el.getAttribute('data-selected'),
            checked: el.getAttribute('checked'),
            backgroundColor: style.backgroundColor,
            color: style.color,
            selectedBlueBg: isSelectedBlue(style.backgroundColor),
            lightText: isLightText(style.color)
          };
        });

        const explicit = samples.some((s) =>
          s.ariaPressed === 'true' ||
          s.ariaSelected === 'true' ||
          s.ariaChecked === 'true' ||
          s.dataState === 'checked' ||
          s.dataState === 'active' ||
          s.dataSelected === 'true' ||
          s.checked != null
        );

        const classSelected = samples.some((s) =>
          /(^|[\s_-])(active|selected|checked|pressed)([\s_-]|$)/i.test(s.className) ||
          /(__|--)(active|selected|checked|pressed)\b/i.test(s.className)
        );

        // A real selected pill is a blue-background element with light text
        // that belongs to THAT SAME pill — either the background element's
        // own computed text color is light (covers the common case where
        // color is set once and inherited down), or the light text sits on
        // a descendant inside that specific blue element (covers GC builds
        // where a child span carries an explicit override color). We do NOT
        // count a blue node and a light-text node as a match just because
        // both showed up somewhere in the option's ancestor/descendant scan
        // — that pairs unrelated elements (e.g. a blue page-level wrapper
        // several levels up plus an unrelated light-colored icon inside the
        // option) and produces false positives.
        const blueSamples = samples.filter((s) => s.selectedBlueBg);
        const bluePillVisual = blueSamples.some((blueSample) => {
          if (blueSample.lightText) return true;
          return samples.some((lightSample) =>
            lightSample.lightText &&
            lightSample.el !== blueSample.el &&
            blueSample.el.contains(lightSample.el)
          );
        });

        for (const s of samples) delete s.el;

        return {
          explicit,
          classSelected,
          bluePillVisual,
          samples
        };
      }

      function collectOptions(fieldContainer) {
        const exactTextNodes = Array.from(fieldContainer.querySelectorAll('*'))
          .filter((el) => {
            const t = norm(el.textContent).toLowerCase();
            return allowed.includes(t) && isVisible(el);
          });

        const byValue = new Map();
        for (const el of exactTextNodes) {
          const value = norm(el.textContent).toLowerCase();
          const root = optionRootFor(el, fieldContainer);
          const inspected = inspectOption(root, fieldContainer);
          const existing = byValue.get(value);
          const score = (inspected.explicit ? 100 : 0) + (inspected.classSelected ? 50 : 0) + (inspected.bluePillVisual ? 25 : 0);
          if (!existing || score > existing.score) {
            byValue.set(value, {
              value,
              text: norm(el.textContent),
              tag: root.tagName,
              className: String(root.className || ''),
              score,
              ...inspected
            });
          }
        }

        return allowed.map((value) => byValue.get(value)).filter(Boolean);
      }

      let container = labelEl.parentElement;
      for (let depth = 0; depth < 7 && container; depth++) {
        const options = collectOptions(container);

        // Use the smallest nearby container that contains the exact option set.
        // If we climb too far, Batting and Throwing controls merge and we see
        // duplicate Left/Right controls. Avoid guessing in that situation.
        if (options.length === allowed.length) {
          const explicitMatches = options.filter((o) => o.explicit);
          if (explicitMatches.length === 1) {
            return { value: explicitMatches[0].text, method: 'explicit-state', options };
          }

          const classMatches = options.filter((o) => o.classSelected);
          if (classMatches.length === 1) {
            return { value: classMatches[0].text, method: 'single-selected-class', options };
          }

          const visualMatches = options.filter((o) => o.bluePillVisual);
          if (visualMatches.length === 1) {
            return { value: visualMatches[0].text, method: 'blue-pill-visual-ancestor', options };
          }

          return {
            value: null,
            method: visualMatches.length > 1 ? 'ambiguous-blue-pill-visual' : 'no-selected-pill-found',
            options
          };
        }

        // If this container already has too many option values, we climbed into
        // both hand controls. Stop instead of accidentally mixing fields.
        if (options.length > allowed.length) {
          return { value: null, method: 'control-too-broad', options };
        }

        container = container.parentElement;
      }
      return { value: null, method: 'control-not-found', options: [] };
    }

    const battingHand = getSegmentedSelection(/^batting hand$/i, ['Left', 'Right', 'Both']);
    const throwingHand = getSegmentedSelection(/^throwing hand$/i, ['Left', 'Right']);

    return {
      firstName: getLabeledInputValue(/^first name$/i),
      lastName: getLabeledInputValue(/^last name$/i),
      jerseyNumber: getLabeledInputValue(/^jersey number$/i),
      battingHandRaw: battingHand.value,
      throwingHandRaw: throwingHand.value,
      battingHandMethod: battingHand.method,
      throwingHandMethod: throwingHand.method,
      battingHandOptions: battingHand.options,
      throwingHandOptions: throwingHand.options
    };
  });

  await maybeDumpDebugJson(page, `modal-extraction-${Date.now()}.json`, data);

  const handMap = { left: 'L', right: 'R', both: 'S' };
  const throwMap = { left: 'L', right: 'R' };

  const bats = handMap[String(data.battingHandRaw || '').toLowerCase()] || 'Unknown';
  const throws = throwMap[String(data.throwingHandRaw || '').toLowerCase()] || 'Unknown';

  if (process.env.GC_HANDEDNESS_DEBUG_HTML === 'true') {
    console.log(
      `[handedness] Modal hand extraction: bats=${bats} (${data.battingHandMethod}), ` +
      `throws=${throws} (${data.throwingHandMethod})`
    );
  }

  return {
    firstName: data.firstName || '',
    lastName: data.lastName || '',
    jerseyNumber: data.jerseyNumber || null,
    bats,
    throws,
    battingHandMethod: data.battingHandMethod,
    throwingHandMethod: data.throwingHandMethod
  };
}

async function closePlayerModal(page) {
  const candidates = [
    page.getByRole('dialog').getByRole('button', { name: /close/i }),
    page.locator('[aria-label="Close" i]'),
    page.locator('[aria-label="close" i]').first(),
    // Screenshot shows a plain "X" icon top-left with no visible label text —
    // fall back to the first small icon-only button inside the dialog.
    page.getByRole('dialog').locator('button').first()
  ];
  for (const locator of candidates) {
    try {
      await locator.first().waitFor({ state: 'visible', timeout: 3000 });
      await locator.first().click();
      await page.waitForTimeout(500);
      console.log('[handedness] Closed player modal.');
      return true;
    } catch {
      // try next
    }
  }
  // Last resort: Escape key.
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    return true;
  } catch {
    console.warn('[handedness] Could not confirm the modal closed.');
    return false;
  }
}

// ─── Main entry point ───────────────────────────────────────────────────────

// ─── Shared roster-capture loop ────────────────────────────────────────────
// Used by both entry points below once the page is already sitting on the
// target team's own Roster tab. Handles dedup against already-captured
// players and the per-player modal open/extract/upsert/close cycle.
async function captureRosterHandedness(page, { teamName, teamId, db, forceRefresh = false }) {
  const result = { captured: 0, skipped: 0, failed: 0 };

  const existing = forceRefresh ? [] : await db.getExistingHandednessForTeam(teamId);
  const existingByJersey = new Map(existing.map((r) => [String(r.jersey_number || ''), r]));
  const existingByMatchKey = new Map(existing.map((r) => [r.match_key, r]));

  const rosterEntries = await getRosterEntries(page);
  if (!rosterEntries.length) {
    console.warn('[handedness] No roster entries found. Selectors likely need adjustment — see GC_HANDEDNESS_DEBUG_HTML.');
    return result;
  }

  // Recovery anchor: if a player's row/modal handling leaves the page in a
  // broken state (stuck overlay, wrong scroll position, etc.), reload back
  // to this exact roster URL before attempting the next player rather than
  // letting one bad interaction cascade into failing every player after it.
  const rosterUrl = page.url();

  for (const entry of rosterEntries) {
    const matchKey = buildMatchKey(entry.name);
    const jerseyKey = String(entry.jerseyNumber || '');

    const alreadyCaptured =
      (jerseyKey && existingByJersey.has(jerseyKey)) ||
      (!jerseyKey && existingByMatchKey.has(matchKey));

    if (alreadyCaptured && !forceRefresh) {
      console.log(`[handedness] Skipping already-captured player: ${entry.name} (#${entry.jerseyNumber || '?'})`);
      result.skipped++;
      continue;
    }

    console.log(`[handedness] Capturing new player: ${entry.name} (#${entry.jerseyNumber || '?'})`);

    let failed = false;
    try {
      const opened = await openPlayerModalByRosterEntry(page, entry);
      if (!opened) {
        // If a prior player's failure left a stray overlay/backdrop behind,
        // it would show up in the page HTML right now — dump it rather than
        // assuming this is identical to the plain roster-page.html capture.
        const safeName = String(entry.name || 'unknown').replace(/[^a-z0-9]/gi, '-').toLowerCase();
        await maybeDumpDebugHtml(page, `NOCLICK-${safeName}-${entry.jerseyNumber || 'nojersey'}.html`, { force: true });
        throw new Error('could not open roster row');
      }

      const modalReady = await waitForPlayerModal(page);
      if (!modalReady) {
        // THIS is the failure we've had zero visibility into so far: a
        // click landed (opened === true) but nothing matching our "Edit
        // Player" dialog checks showed up. Dump whatever actually is on
        // screen — either a differently-labeled dialog (selector needs
        // widening) or a genuinely different UI for opponent rosters
        // (e.g. a read-only player card instead of an editable modal).
        const safeName = String(entry.name || 'unknown').replace(/[^a-z0-9]/gi, '-').toLowerCase();
        await maybeDumpDebugHtml(page, `NOMODAL-${safeName}-${entry.jerseyNumber || 'nojersey'}.html`, { force: true });
        throw new Error('Edit Player modal did not appear');
      }

      const captured = await extractHandednessFromModal(page);
      const { firstName, lastName } = splitFullName(entry.name);
      const fullName = entry.name;

      await db.upsertPlayerHandedness(teamId, {
        jerseyNumber: captured.jerseyNumber || entry.jerseyNumber || null,
        firstName: captured.firstName || firstName,
        lastName: captured.lastName || lastName,
        fullName,
        matchKey: buildMatchKey(fullName),
        bats: captured.bats,
        throws: captured.throws
      });

      result.captured++;
    } catch (error) {
      console.error(`[handedness] Failed to capture ${entry.name}: ${error.message}`);
      result.failed++;
      failed = true;
    } finally {
      await closePlayerModal(page);
    }

    if (failed) {
      try {
        console.log(`[handedness] Reloading roster page to recover before the next player (${rosterUrl})...`);
        await page.goto(rosterUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1500);
        await dismissDontMissOutPopup(page);
      } catch (recoverError) {
        console.warn(`[handedness] Recovery reload failed: ${recoverError.message}. Continuing anyway — subsequent players may keep failing until the page is reset.`);
      }
    }
  }

  console.log(
    `[handedness] Done with "${teamName}": captured ${result.captured}, ` +
    `skipped ${result.skipped}, failed ${result.failed}.`
  );
  return result;
}

// ─── Main entry point (direct URL — preferred) ─────────────────────────────

/**
 * Capture handedness for a team we already know the GC URL for — no
 * navigating from "our team" through an Opponents/Schedule list and
 * fuzzy-matching this team's name against every other team's name first.
 *
 * This is the preferred entry point. The caller (search-gamechanger-teams.js)
 * is invoked once per team it's already scraping games for, and by the time
 * it calls this it has ALREADY resolved and visited that exact team's GC
 * page — the fuzzy Opponents-list search in captureTeamHandedness() below
 * was solving a problem that doesn't need solving here: we're not looking
 * for this team among a pile of others, we're already standing on it.
 *
 * @param {object} opts
 * @param {import('@playwright/test').Page} opts.page
 * @param {string} opts.teamGcUrl        This team's own resolved GameChanger URL.
 * @param {number|string} opts.teamId    This team's row id in our DB.
 * @param {object} opts.db               db.js/db-supabase.js module (already init()'d).
 * @param {boolean} [opts.forceRefresh]  Re-capture every player, ignoring existing rows.
 * @param {string} [opts.teamName]       Display name only, for logging.
 * @returns {Promise<{captured: number, skipped: number, failed: number}>}
 */
async function captureTeamHandednessByUrl({ page, teamGcUrl, teamId, db, forceRefresh = false, teamName = '' }) {
  if (!teamGcUrl) throw new Error('captureTeamHandednessByUrl: teamGcUrl is required.');
  if (!teamId) throw new Error('captureTeamHandednessByUrl: teamId is required.');
  if (!db) throw new Error('captureTeamHandednessByUrl: db module is required.');

  const label = teamName || teamGcUrl;
  const result = { captured: 0, skipped: 0, failed: 0 };

  await openTeamPage(page, teamGcUrl);

  const openedRoster = await openRosterTab(page);
  if (!openedRoster) {
    console.error(`[handedness] Could not open Roster tab for "${label}".`);
    return result;
  }

  return captureRosterHandedness(page, { teamName: label, teamId, db, forceRefresh });
}

// ─── Legacy entry point (Our Team -> Opponents -> fuzzy match) ────────────
// Kept for reference / possible future use (e.g. capturing handedness for a
// team we have a name for but no direct URL yet), but NOT used by the main
// scrape flow anymore — see captureTeamHandednessByUrl's doc comment above
// for why. This path relies on scanForOpponentLink/clickOpponentTeamLink
// correctly picking one team's row out of a page that can render ~40 of
// them at once, which has been a recurring source of mis-clicks.
/**
 * @param {object} opts
 * @param {import('@playwright/test').Page} opts.page
 * @param {string} opts.myTeamGcUrl        Our team's GameChanger team URL.
 * @param {string} opts.opponentTeamName   The opponent team's name as stored in our DB.
 * @param {number|string} opts.teamId      The opponent team's row id in our DB.
 * @param {object} opts.db                 db.js/db-supabase.js module (already init()'d).
 * @param {boolean} [opts.forceRefresh]    Re-capture every player, ignoring existing rows.
 * @returns {Promise<{captured: number, skipped: number, failed: number}>}
 */
async function captureTeamHandedness({ page, myTeamGcUrl, opponentTeamName, teamId, db, forceRefresh = false }) {
  if (!myTeamGcUrl) throw new Error('captureTeamHandedness: myTeamGcUrl is required.');
  if (!opponentTeamName) throw new Error('captureTeamHandedness: opponentTeamName is required.');
  if (!teamId) throw new Error('captureTeamHandedness: teamId is required.');
  if (!db) throw new Error('captureTeamHandedness: db module is required.');

  const result = { captured: 0, skipped: 0, failed: 0 };

  await openTeamPage(page, myTeamGcUrl);

  const openedOpponentsTab = await openOpponentsTab(page);

  let foundOpponent = false;
  if (openedOpponentsTab) {
    foundOpponent = await clickOpponentTeamLink(page, opponentTeamName, { contextLabel: 'opponents-list-page' });
  }

  if (!foundOpponent) {
    console.log('[handedness] Opponents tab did not produce a match. Falling back to Schedule tab.');
    await openTeamPage(page, myTeamGcUrl);
    const openedSchedule = await openScheduleTab(page);
    if (openedSchedule) {
      foundOpponent = await clickOpponentTeamLink(page, opponentTeamName, { contextLabel: 'schedule-page' });
    }
  }

  if (!foundOpponent) {
    console.error(`[handedness] Could not find/click opponent "${opponentTeamName}" from our team's page or schedule.`);
    return result;
  }

  const openedRoster = await openRosterTab(page);
  if (!openedRoster) {
    console.error(`[handedness] Could not open Roster tab for "${opponentTeamName}".`);
    return result;
  }

  return captureRosterHandedness(page, { teamName: opponentTeamName, teamId, db, forceRefresh });
}

module.exports = {
  captureTeamHandednessByUrl,
  captureTeamHandedness,
  buildMatchKey,
  // exported for testing
  _internals: { normalizeText, splitFullName, getRosterEntries, extractHandednessFromModal }
};