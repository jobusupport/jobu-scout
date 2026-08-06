'use strict';

// Preloaded via `node --test --require ./test/helpers/gc-network-guard.js`
// (see package.json's test script) for every node:test worker, BEFORE any
// test file runs. Defense-in-depth alongside
// src/gc-session-loader.js's isAutomatedTestMode() fail-closed path
// resolution: even if some future code path resolves a real (or
// real-looking) storageState file during a test, this guard makes an
// actual network request to GameChanger structurally impossible from
// within this process's Playwright browsers -- it does not merely rely on
// no auth file being present.
//
// Mechanism: monkey-patches `playwright`'s exported `chromium.launch` so
// every BrowserContext this process creates automatically has a
// context-level route handler that ABORTS any request whose hostname is
// gc.com or a subdomain of it (the real GameChanger origin), and falls
// back to normal handling (never interferes with hs-api-mock.js-style
// page.route mocks or any other host) for everything else. Every scraper
// in this codebase (src/scrape-game-urls.js, src/search-gamechanger-teams.js,
// src/high-school-gc-import.js) launches Chromium via this exact
// `chromium.launch()` -> `browser.newContext()` -> `context.newPage()`
// sequence, so there is no separate code path that could bypass this.
//
// Never logs the blocked URL's query string or any request header/body --
// only the hostname, which cannot carry session content.

const GC_HOSTNAME_RE = /(^|\.)gc\.com$/i;

function isGameChangerUrl(urlString) {
  try {
    return GC_HOSTNAME_RE.test(new URL(urlString).hostname);
  } catch {
    return false;
  }
}

let installed = false;

function installGcNetworkGuard() {
  if (installed) return;
  installed = true;

  let playwright;
  try {
    // eslint-disable-next-line global-require
    playwright = require('playwright');
  } catch {
    return; // playwright not present in this environment -- nothing to guard
  }
  if (!playwright?.chromium?.launch) return;

  const originalLaunch = playwright.chromium.launch.bind(playwright.chromium);
  playwright.chromium.launch = async function guardedLaunch(...launchArgs) {
    const browser = await originalLaunch(...launchArgs);
    const originalNewContext = browser.newContext.bind(browser);
    browser.newContext = async function guardedNewContext(...contextArgs) {
      const context = await originalNewContext(...contextArgs);
      await context.route('**/*', (route) => {
        const url = route.request().url();
        if (isGameChangerUrl(url)) {
          console.error('[gc-network-guard] BLOCKED an automated-test request to a real GameChanger host (hostname only, no path/query logged).');
          return route.abort('blockedbyclient');
        }
        return route.fallback();
      });
      return context;
    };
    return browser;
  };
}

installGcNetworkGuard();

module.exports = { isGameChangerUrl, installGcNetworkGuard };
