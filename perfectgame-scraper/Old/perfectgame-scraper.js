const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PG_TEAM_URL =
  process.argv[2] ||
  process.env.PG_TEAM_URL ||
  'https://www.perfectgame.org/PGBA/Team/default.aspx?orgid=23049&orgteamid=271732&team=1002244&Year=2026';

const PG_TEAM_NAME_OVERRIDE =
  process.argv[3] ||
  process.env.PG_TEAM_NAME ||
  '';

const AUTH_FILE = path.join(__dirname, 'perfectgame-auth.json');
const OUTPUT_ROOT = path.join(__dirname, 'output');

const SPRAY_CLICK_DELAY_MS = 5000;
const SPRAY_RENDER_DELAY_MS = 5000;
const SPRAY_CLOSE_DELAY_MS = 2500;

const STATS_VIEW_DELAY_MS = 3000;

const POPUP_WAIT_ATTEMPTS = 10;
const POPUP_WAIT_BETWEEN_ATTEMPTS_MS = 2000;

function ensureDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function cleanFileName(value) {
  return String(value || '')
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    .substring(0, 100);
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function getQueryParam(url, key) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get(key);
  } catch {
    return null;
  }
}

function getTeamFolderName(url, teamName = '') {
  const teamId = getQueryParam(url, 'team') || 'unknown-team';
  const orgTeamId = getQueryParam(url, 'orgteamid') || 'unknown-orgteam';
  const orgId = getQueryParam(url, 'orgid') || 'unknown-org';
  const year = getQueryParam(url, 'Year') || getQueryParam(url, 'year') || 'unknown-year';

  const safeTeamName = cleanFileName(teamName);

  if (safeTeamName) {
    return `${year}-${safeTeamName}-${teamId}-${orgTeamId}-${orgId}`;
  }

  return `${year}-team-${teamId}-orgteam-${orgTeamId}-org-${orgId}`;
}

function deletePngFilesContainingBeforeClick(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

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

      if (lowerName.endsWith('.png') && lowerName.includes('-before-click')) {
        fs.unlinkSync(fullPath);
        deleted.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return deleted;
}

async function dismissCookieAndPolicyOverlay(page) {
  await page.evaluate(() => {
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();

      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    const elements = Array.from(
      document.querySelectorAll('button,input[type="button"],input[type="submit"],a,div,span')
    );

    const gotIt = elements.find(el => {
      const text = ((el.innerText || el.textContent || el.value || '') + '')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();

      return isVisible(el) && (text === 'GOT IT!' || text === 'GOT IT');
    });

    if (gotIt) {
      gotIt.click();
    }
  }).catch(() => {});

  await page.waitForTimeout(800);

  await page.evaluate(() => {
    function hideElement(el) {
      el.style.display = 'none';
      el.style.visibility = 'hidden';
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
      el.style.height = '0';
      el.style.minHeight = '0';
      el.style.maxHeight = '0';
      el.style.overflow = 'hidden';
    }

    const all = Array.from(document.querySelectorAll('body *'));

    for (const el of all) {
      const text = ((el.innerText || el.textContent || '') + '')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();

      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      const isPolicyOverlay =
        text.includes('COOKIE POLICY') ||
        text.includes('MEDIA USAGE UPDATE') ||
        text.includes('THIS WEBSITE USES COOKIES') ||
        text.includes('ANY RECORDING, PHOTOGRAPHY, OR FOOTAGE FROM PG EVENTS');

      const isLargeBottomOverlay =
        rect.width > window.innerWidth * 0.5 &&
        rect.height > 80 &&
        rect.top > window.innerHeight * 0.35 &&
        (
          style.position === 'fixed' ||
          style.position === 'sticky' ||
          text.includes('COOKIE') ||
          text.includes('MEDIA USAGE')
        );

      if (isPolicyOverlay || isLargeBottomOverlay) {
        hideElement(el);
      }
    }

    document.body.style.paddingBottom = '0px';
    document.documentElement.style.paddingBottom = '0px';
  }).catch(() => {});
}

async function closeCookieBanner(page) {
  await dismissCookieAndPolicyOverlay(page);
}

async function safeHideFloatingJunk(page) {
  await page.addStyleTag({
    content: `
      video,
      iframe[src*="youtube"],
      iframe[src*="vimeo"],
      iframe[src*="doubleclick"],
      iframe[src*="googlesyndication"],
      iframe[src*="adservice"],
      iframe[src*="imasdk"],
      .jwplayer,
      [id*="jwplayer"],
      [class*="jwplayer"],
      [id*="floatingVideo"],
      [class*="floatingVideo"],
      [id*="FloatingVideo"],
      [class*="FloatingVideo"],
      [id*="stickyVideo"],
      [class*="stickyVideo"],
      [id*="StickyVideo"],
      [class*="StickyVideo"],
      [id*="videoPlayer"],
      [class*="videoPlayer"],
      [id*="VideoPlayer"],
      [class*="VideoPlayer"] {
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
      'DIAMONDKAST',
      'PLAYER',
      'AVG',
      'OBP',
      'SLG',
      'STATS',
      'BATTING',
      'PITCHING',
      'SPRAY',
      'CLOSE'
    ];

    const elements = Array.from(document.querySelectorAll('body *'));

    for (const el of elements) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const text = (el.innerText || '').toUpperCase();

      const isProtected = protectedWords.some(word => text.includes(word));
      const isFloating = style.position === 'fixed' || style.position === 'sticky';
      const isLarge = rect.width > 200 && rect.height > 100;
      const isBottomRight =
        rect.right > window.innerWidth * 0.45 &&
        rect.bottom > window.innerHeight * 0.45;

      const isCookieOrMedia =
        text.includes('COOKIE POLICY') ||
        text.includes('MEDIA USAGE UPDATE') ||
        text.includes('THIS WEBSITE USES COOKIES');

      if ((isFloating && isLarge && isBottomRight && !isProtected) || isCookieOrMedia) {
        el.style.display = 'none';
        el.style.visibility = 'hidden';
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
      }
    }
  }).catch(() => {});
}

async function getTeamNameFromPage(page) {
  const result = await page.evaluate(() => {
    function cleanText(value) {
      return String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function isBadTeamName(text) {
      const upper = text.toUpperCase();

      const badPhrases = [
        'SPEND MORE',
        'SAVE MORE',
        'REGISTER TODAY',
        'INDIVIDUAL PLAYER SPOTS',
        'NATIONAL CHAMPIONSHIP',
        'WORLD\'S LARGEST',
        'PERFECT GAME',
        'COOKIE POLICY',
        'MEDIA USAGE',
        'TEAM LEADERS',
        'TEAM SCHEDULE',
        'FULL ROSTER',
        'AWARDS',
        'STATS',
        'SIGN IN',
        'CREATE ACCOUNT',
        'EVENTS',
        'SHOWCASES',
        'SOFTBALL',
        'RANKINGS',
        'RECRUITING',
        'PG SHOP',
        'PG TEAM SALES',
        'DIAMONDKAST',
        'BATTING',
        'PITCHING',
        'STANDARD',
        'ADVANCED',
        'HOMETOWN',
        'ORGANIZATION',
        'CLASSIFICATION',
        'PG RECORD',
        'PERSONNEL',
        'TEAM POINTS',
        'LEADERBOARD',
        'SCHEDULE',
        'INVITATIONAL',
        'CHAMPIONSHIP',
        'TOURNAMENT',
        'HOOVER, AL',
        'MAY ',
        'JUN ',
        'JUL ',
        'AUG '
      ];

      return badPhrases.some(p => upper.includes(p));
    }

    const bodyText = cleanText(document.body.innerText || '');
    const lines = bodyText
      .split(/\n+/)
      .map(cleanText)
      .filter(Boolean);

    const lineCandidates = [];

    for (let i = 0; i < lines.length; i++) {
      const upper = lines[i].toUpperCase();

      if (upper.startsWith('HOMETOWN') && i > 0) {
        for (let back = 1; back <= 8; back++) {
          const possible = lines[i - back];

          if (!possible) continue;
          if (possible.length < 3 || possible.length > 80) continue;
          if (isBadTeamName(possible)) continue;

          lineCandidates.push({
            text: possible,
            source: `line-before-hometown-${back}`,
            score: 500 - back
          });

          break;
        }
      }
    }

    return {
      best: lineCandidates.length ? lineCandidates[0].text : '',
      candidates: lineCandidates.slice(0, 30),
      raw_lines_near_hometown: lines
        .map((line, index) => ({ index, line }))
        .filter(item => item.line.toUpperCase().includes('HOMETOWN'))
        .map(item => ({
          index: item.index,
          previous_8_lines: lines.slice(Math.max(0, item.index - 8), item.index),
          hometown_line: item.line,
          next_8_lines: lines.slice(item.index + 1, item.index + 9)
        }))
    };
  }).catch(() => ({ best: '', candidates: [], raw_lines_near_hometown: [] }));

  return result;
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
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    function normalized(value) {
      return String(value || '').replace(/\s+/g, ' ').trim().toUpperCase();
    }

    const target = normalized(text);
    const elements = Array.from(document.querySelectorAll('label,span,div,td,a'));

    const matches = elements.filter(el => isVisible(el) && normalized(el.innerText || el.textContent) === target);

    const selected = matches[occurrence];

    if (!selected) {
      return false;
    }

    const labelFor = selected.getAttribute('for');

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
  if (!categoryClicked) {
    console.log(`Warning: could not click category option "${category}".`);
  }

  await page.waitForTimeout(1000);

  const viewClicked = await clickVisibleTextOption(page, view);
  if (!viewClicked) {
    console.log(`Warning: could not click view option "${view}".`);
  }

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

  const grid = await getStatsGrid(page);

  if (!grid) {
    console.log(`No visible stats grid found for ${label}.`);
    return {
      label,
      captured: false,
      reason: 'No visible stats grid found'
    };
  }

  await grid.locator.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(1000);
  await dismissCookieAndPolicyOverlay(page);

  await grid.locator.screenshot({
    path: outputPath
  });

  console.log(`Saved ${label} screenshot: ${outputPath}`);

  return {
    label,
    captured: true,
    file: outputPath,
    selector: grid.selector
  };
}

async function captureAllStatsTables(page, statsTablesDir) {
  ensureDirectory(statsTablesDir);

  const captures = [];

  const views = [
    {
      category: 'Batting',
      view: 'Standard',
      filename: '01-batting-standard.png',
      label: 'batting-standard'
    },
    {
      category: 'Batting',
      view: 'Advanced',
      filename: '02-batting-advanced.png',
      label: 'batting-advanced'
    },
    {
      category: 'Batting',
      view: 'Batted Ball',
      filename: '03-batting-batted-ball.png',
      label: 'batting-batted-ball'
    },
    {
      category: 'Pitching',
      view: 'Standard',
      filename: '04-pitching-standard.png',
      label: 'pitching-standard'
    },
    {
      category: 'Pitching',
      view: 'Advanced',
      filename: '05-pitching-advanced.png',
      label: 'pitching-advanced'
    },
    {
      category: 'Pitching',
      view: 'Batted Ball',
      filename: '06-pitching-batted-ball.png',
      label: 'pitching-batted-ball'
    }
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

  await selectStatsView(page, 'Batting', 'Standard');

  return captures;
}

async function extractRowsFromGrid(page, gridSelector) {
  return await page.$$eval(`${gridSelector} tbody tr`, trs => {
    return trs
      .map(tr => {
        const cells = [...tr.querySelectorAll('td')].map(td => td.innerText.trim());

        if (cells.length < 8) {
          return null;
        }

        return {
          player: cells[2] || '',
          state: cells[3] || '',
          ops: cells[4] || '',
          avg: cells[5] || '',
          obp: cells[6] || '',
          slg: cells[7] || '',
          games: cells[8] || '',
          at_bats: cells[9] || '',
          runs: cells[10] || '',
          hits: cells[11] || '',
          doubles: cells[12] || '',
          triples: cells[13] || '',
          home_runs: cells[14] || '',
          rbi: cells[15] || '',
          walks: cells[16] || '',
          strikeouts: cells[17] || '',
          stolen_bases: cells[18] || '',
          caught_stealing: cells[19] || '',
          wg: cells[20] || ''
        };
      })
      .filter(Boolean)
      .filter(row => row.player && row.player.toUpperCase() !== 'PLAYER');
  });
}

async function getVisiblePopupCandidates(page) {
  return await page.evaluate(() => {
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();

      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
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
      '.RadWindow',
      '.rwWindowContent',
      '[role="dialog"]',
      '.modal',
      '[id*="Spray"]',
      '[class*="Spray"]',
      '[id*="spray"]',
      '[class*="spray"]',
      '[id*="Chart"]',
      '[class*="Chart"]',
      '[id*="chart"]',
      '[class*="chart"]'
    ].join(',');

    const elements = Array.from(document.querySelectorAll(selector));

    return elements
      .filter(isVisible)
      .map((el, index) => {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();

        return {
          index,
          tag: el.tagName,
          id: el.id || '',
          className: typeof el.className === 'string' ? el.className : '',
          text,
          box: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
          },
          area: rect.width * rect.height
        };
      })
      .sort((a, b) => b.area - a.area);
  }).catch(() => []);
}

async function findPopupForPlayer(page, playerName, label = 'popup') {
  const normalizedPlayerName = normalizeText(playerName);

  for (let attempt = 1; attempt <= POPUP_WAIT_ATTEMPTS; attempt++) {
    const candidates = await getVisiblePopupCandidates(page);

    if (candidates.length > 0) {
      const withPlayerName = candidates.find(candidate =>
        normalizeText(candidate.text).includes(normalizedPlayerName)
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

function makeSafeClip(box, viewportWidth = 1600, viewportHeight = 1200) {
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

async function clickVisibleCloseButton(page, playerName = '') {
  const clicked = await page.evaluate(() => {
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();

      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
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
      if (el.tagName === 'INPUT') {
        return (el.value || '').trim();
      }

      return (el.innerText || el.textContent || '').trim();
    }

    const candidates = Array.from(
      document.querySelectorAll('button,input[type="button"],input[type="submit"],a,span,div')
    )
      .filter(isVisible)
      .map(el => {
        const rect = el.getBoundingClientRect();
        return {
          el,
          text: textOf(el).replace(/\s+/g, ' ').trim().toUpperCase(),
          area: rect.width * rect.height,
          y: rect.y
        };
      })
      .filter(item => item.text === 'CLOSE' || item.text === 'X' || item.text === '×')
      .sort((a, b) => {
        if (a.text === 'CLOSE' && b.text !== 'CLOSE') return -1;
        if (a.text !== 'CLOSE' && b.text === 'CLOSE') return 1;
        return a.area - b.area;
      });

    if (!candidates.length) {
      return false;
    }

    candidates[0].el.click();
    return true;
  }).catch(() => false);

  if (clicked) {
    console.log(`Clicked CLOSE button${playerName ? ` for ${playerName}` : ''}.`);
    await page.waitForTimeout(SPRAY_CLOSE_DELAY_MS);
    return true;
  }

  console.log(`Could not find visible CLOSE button${playerName ? ` for ${playerName}` : ''}. Trying Escape.`);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(SPRAY_CLOSE_DELAY_MS);

  return false;
}

async function waitForPopupToDisappear(page, playerName = '') {
  for (let attempt = 1; attempt <= 10; attempt++) {
    const candidates = await getVisiblePopupCandidates(page);

    if (!candidates.length) {
      return true;
    }

    if (playerName) {
      const stillHasPlayerPopup = candidates.some(candidate =>
        normalizeText(candidate.text).includes(normalizeText(playerName))
      );

      if (!stillHasPlayerPopup) {
        return true;
      }
    }

    await page.waitForTimeout(1000);
  }

  return false;
}

async function forceCloseAnyOpenPopup(page) {
  const candidates = await getVisiblePopupCandidates(page);

  if (!candidates.length) {
    return;
  }

  await clickVisibleCloseButton(page);
  await waitForPopupToDisappear(page);
}

async function screenshotPopupWindow(page, popup, filePath) {
  const clip = makeSafeClip(popup.box, 1600, 1200);

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
    const cells = row.locator('td');

    const cellCount = await cells.count().catch(() => 0);

    if (cellCount < 3) {
      continue;
    }

    const playerName = await cells.nth(2).innerText().catch(() => '');
    const cleanPlayer = cleanFileName(playerName);

    if (!playerName || playerName.toUpperCase() === 'PLAYER') {
      continue;
    }

    console.log(`Trying spray chart for row ${i + 1}: ${playerName}...`);

    const sprayCell = cells.nth(1);

    const candidates = [
      sprayCell.locator('a').first(),
      sprayCell.locator('img').first(),
      sprayCell.locator('input').first(),
      sprayCell.locator('button').first(),
      sprayCell.locator('[onclick]').first(),
      sprayCell.locator('*').first()
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
      results.push({
        player: playerName,
        captured: false,
        reason: 'No visible spray icon/button found'
      });
      continue;
    }

    await sprayButton.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(1000);

    const beforeClickPath = path.join(
      sprayDir,
      `${String(i + 1).padStart(2, '0')}-${cleanPlayer}-spray-before-click.png`
    );

    await page.screenshot({
      path: beforeClickPath,
      fullPage: false
    }).catch(() => {});

    let newPage = null;

    const newPagePromise = page.context().waitForEvent('page', { timeout: 7000 })
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

    const fileName = `${String(i + 1).padStart(2, '0')}-${cleanPlayer}-spray-chart.png`;
    const filePath = path.join(sprayDir, fileName);

    if (newPage) {
      console.log(`Spray chart opened new page/window for ${playerName}.`);

      await newPage.waitForLoadState('domcontentloaded').catch(() => {});
      await newPage.waitForTimeout(SPRAY_RENDER_DELAY_MS);

      await safeHideFloatingJunk(newPage);
      await dismissCookieAndPolicyOverlay(newPage);

      await newPage.screenshot({
        path: filePath,
        fullPage: false
      });

      await newPage.close().catch(() => {});
      await page.waitForTimeout(SPRAY_CLOSE_DELAY_MS);

      results.push({
        player: playerName,
        captured: true,
        method: 'new_page',
        file: filePath
      });

      console.log(`Saved spray chart for ${playerName}: ${filePath}`);
      continue;
    }

    console.log(`Looking for spray chart popup for ${playerName}...`);

    const popup = await findPopupForPlayer(page, playerName, 'spray chart popup');

    if (popup && popup.box) {
      await page.waitForTimeout(SPRAY_RENDER_DELAY_MS);

      await dismissCookieAndPolicyOverlay(page);

      const refreshedPopup = await findPopupForPlayer(page, playerName, 'spray chart popup');
      const finalPopup = refreshedPopup && refreshedPopup.box ? refreshedPopup : popup;

      await screenshotPopupWindow(page, finalPopup, filePath);

      results.push({
        player: playerName,
        captured: true,
        method: 'modal_popup_player_matched_clipped_screenshot',
        popup_text_sample: finalPopup.text.substring(0, 200),
        file: filePath
      });

      console.log(`Saved spray chart window for ${playerName}: ${filePath}`);

      await clickVisibleCloseButton(page, playerName);

      const disappeared = await waitForPopupToDisappear(page, playerName);

      if (!disappeared) {
        console.log(`Warning: spray chart popup may still be open after trying to close ${playerName}.`);
        await page.screenshot({
          path: path.join(
            sprayDir,
            `${String(i + 1).padStart(2, '0')}-${cleanPlayer}-spray-after-close-warning.png`
          ),
          fullPage: false
        }).catch(() => {});
      }
    } else {
      const debugPath = path.join(
        sprayDir,
        `${String(i + 1).padStart(2, '0')}-${cleanPlayer}-spray-debug.png`
      );

      await dismissCookieAndPolicyOverlay(page);

      await page.screenshot({
        path: debugPath,
        fullPage: false
      });

      await clickVisibleCloseButton(page, playerName);
      await waitForPopupToDisappear(page, playerName);

      results.push({
        player: playerName,
        captured: false,
        reason: 'Clicked spray icon but could not identify popup after waiting',
        debug_file: debugPath
      });

      console.log(`Saved spray debug screenshot for ${playerName}: ${debugPath}`);
    }

    await page.waitForTimeout(SPRAY_CLOSE_DELAY_MS);
  }

  return results;
}

(async () => {
  ensureDirectory(OUTPUT_ROOT);

  if (!fs.existsSync(AUTH_FILE)) {
    console.error(JSON.stringify({
      success: false,
      error: `Missing auth file: ${AUTH_FILE}. Run save-perfectgame-session.js first.`
    }, null, 2));
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: false,
    slowMo: 100
  });

  const context = await browser.newContext({
    storageState: AUTH_FILE,
    viewport: {
      width: 1600,
      height: 1200
    }
  });

  const page = await context.newPage();

  try {
    await page.route('**/*', route => {
      const request = route.request();
      const url = request.url().toLowerCase();
      const resourceType = request.resourceType();

      if (
        resourceType === 'media' ||
        url.includes('youtube') ||
        url.includes('vimeo') ||
        url.includes('jwplayer') ||
        url.includes('googlesyndication') ||
        url.includes('doubleclick') ||
        url.includes('adservice') ||
        url.includes('imasdk') ||
        url.includes('prebid') ||
        url.includes('taboola') ||
        url.includes('outbrain')
      ) {
        return route.abort();
      }

      return route.continue();
    });

    console.log('Opening Perfect Game team page...');
    console.log(PG_TEAM_URL);

    await page.goto(PG_TEAM_URL, {
      waitUntil: 'networkidle',
      timeout: 60000
    });

    await closeCookieBanner(page);
    await safeHideFloatingJunk(page);
    await dismissCookieAndPolicyOverlay(page);

    const teamNameResult = await getTeamNameFromPage(page);
    const detectedTeamName = teamNameResult.best || '';
    const teamName = PG_TEAM_NAME_OVERRIDE || detectedTeamName || '';

    const teamFolderName = getTeamFolderName(PG_TEAM_URL, teamName);
    const teamDir = path.join(OUTPUT_ROOT, teamFolderName);
    const statsTablesDir = path.join(teamDir, 'stats-tables');
    const sprayDir = path.join(teamDir, 'spray-charts');
    const debugDir = path.join(teamDir, 'debug');

    ensureDirectory(teamDir);
    ensureDirectory(statsTablesDir);
    ensureDirectory(sprayDir);
    ensureDirectory(debugDir);

    fs.writeFileSync(
      path.join(debugDir, 'team-name-candidates.json'),
      JSON.stringify({
        override_team_name: PG_TEAM_NAME_OVERRIDE,
        detected_team_name: detectedTeamName,
        final_team_name_used: teamName,
        detection_details: teamNameResult
      }, null, 2),
      'utf8'
    );

    console.log(`Team name override: ${PG_TEAM_NAME_OVERRIDE || 'None'}`);
    console.log(`Detected team name: ${detectedTeamName || 'Not found'}`);
    console.log(`Final team name used: ${teamName || 'ID fallback'}`);
    console.log(`Using team output folder: ${teamDir}`);

    await page.screenshot({
      path: path.join(debugDir, 'team-page-loaded.png'),
      fullPage: true
    });

    console.log('Selecting Batting / Standard...');

    await selectStatsView(page, 'Batting', 'Standard');

    const grid = await getStatsGrid(page);

    if (!grid) {
      console.log('No DiamondKast batting grid found. Treating this as no stats recorded yet.');

      const noStatsOutput = {
        success: true,
        no_stats_recorded: true,
        captured_at: new Date().toISOString(),
        source_url: PG_TEAM_URL,
        team_name: teamName,
        team_name_override: PG_TEAM_NAME_OVERRIDE,
        detected_team_name: detectedTeamName,
        team_folder: teamDir,
        message: 'No DiamondKast batting stats grid was found for this team.',
        rows: [],
        stats_table_screenshots: [],
        spray_charts: []
      };

      const noStatsJsonPath = path.join(teamDir, 'perfectgame-output.json');
      fs.writeFileSync(noStatsJsonPath, JSON.stringify(noStatsOutput, null, 2), 'utf8');

      await page.screenshot({
        path: path.join(teamDir, 'no-stats-page.png'),
        fullPage: true
      });

      const deletedSprayBeforeClickPngFiles = deletePngFilesContainingBeforeClick(sprayDir);
      noStatsOutput.deleted_spray_before_click_png_files = deletedSprayBeforeClickPngFiles;

      fs.writeFileSync(noStatsJsonPath, JSON.stringify(noStatsOutput, null, 2), 'utf8');

      console.log(JSON.stringify(noStatsOutput, null, 2));

      await browser.close();
      return;
    }

    console.log(`Stats grid found with selector: ${grid.selector}`);

    await grid.locator.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(1000);

    await dismissCookieAndPolicyOverlay(page);

    const tableScreenshotPath = path.join(teamDir, 'diamondkast-batting-grid.png');

    await grid.locator.screenshot({
      path: tableScreenshotPath
    });

    console.log(`Saved batting grid screenshot: ${tableScreenshotPath}`);

    const rows = await extractRowsFromGrid(page, grid.selector);

    const statsJsonPath = path.join(teamDir, 'diamondkast-batting-stats.json');
    fs.writeFileSync(statsJsonPath, JSON.stringify(rows, null, 2), 'utf8');

    console.log(`Saved batting stats JSON: ${statsJsonPath}`);
    console.log(`Extracted player rows: ${rows.length}`);

    console.log('Capturing all requested stats table screenshots...');
    const statsTableScreenshots = await captureAllStatsTables(page, statsTablesDir);

    await selectStatsView(page, 'Batting', 'Standard');

    let sprayCharts = [];

    if (rows.length > 0) {
      await safeHideFloatingJunk(page);
      await removeLargeFloatingElementsButKeepStats(page);
      await dismissCookieAndPolicyOverlay(page);

      const battingStandardGrid = await getStatsGrid(page);

      if (!battingStandardGrid) {
        throw new Error('Could not reselect Batting / Standard grid before spray chart capture.');
      }

      sprayCharts = await captureSprayCharts(page, battingStandardGrid.selector, sprayDir);
    } else {
      console.log('Stats grid exists, but no player rows were extracted. Skipping spray charts.');
    }

    await forceCloseAnyOpenPopup(page);

    const deletedSprayBeforeClickPngFiles = deletePngFilesContainingBeforeClick(sprayDir);

    const output = {
      success: true,
      no_stats_recorded: rows.length === 0,
      captured_at: new Date().toISOString(),
      source_url: PG_TEAM_URL,
      team_name: teamName,
      team_name_override: PG_TEAM_NAME_OVERRIDE,
      detected_team_name: detectedTeamName,
      team_folder: teamDir,
      stat_type: 'DiamondKast Batting Standard Annual Statistics 2026',
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

    const finalOutputPath = path.join(teamDir, 'perfectgame-output.json');
    fs.writeFileSync(finalOutputPath, JSON.stringify(output, null, 2), 'utf8');

    console.log(JSON.stringify(output, null, 2));

    await browser.close();
  } catch (error) {
    const errorDir = path.join(OUTPUT_ROOT, 'error');
    ensureDirectory(errorDir);

    const errorScreenshotPath = path.join(errorDir, 'error-page.png');

    await dismissCookieAndPolicyOverlay(page).catch(() => {});

    await page.screenshot({
      path: errorScreenshotPath,
      fullPage: true
    }).catch(() => {});

    console.error(JSON.stringify({
      success: false,
      error: error.message,
      current_url: page.url(),
      screenshot: errorScreenshotPath
    }, null, 2));

    await browser.close();
    process.exit(1);
  }
})();