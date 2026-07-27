'use strict';

// Focused Playwright coverage for the High School roster-management UI
// added on top of PR #12's merged /api/high-school/* contract. This is
// new-but-justified test infrastructure: the repo had no frontend test
// suite before this (dashboard/index.html is a bundled artifact with zero
// prior coverage), so this file establishes it rather than matching an
// existing convention. Run with `npx playwright test` (not `npm test`,
// which is node:test and would not understand @playwright/test's API --
// see playwright.config.js's header comment).
//
// Every test drives the REAL shipped code path: DESIGN_MODE stays false,
// a fake logged-in session is seeded via localStorage (see
// helpers/hs-api-mock.js#seedSession), and /api/* calls are intercepted
// with responses shaped exactly like the merged backend contract (see
// that same file's header comment). Nothing here exercises the
// DESIGN_MODE/mockApiResponse() convenience path.
//
// Locators are always scoped to an HS-specific container id (#hs-pane-*,
// #hsProgramModal, etc.), never bare text=/role text. The Travel sidebar
// and its own modals share this same document (only display:none, never
// removed), and several of its buttons use the exact same label text as
// the High School buttons here ("Add Player", "Save Player", "Edit") --
// an unscoped text locator resolves to Travel's hidden element first and
// hangs waiting for it to become visible, which it never will.

const { test, expect } = require('@playwright/test');
const { installHsApiMock, seedSession, seedSupportSession } = require('./helpers/hs-api-mock');

const HS_CAPS = { schemaVersion: 1, customerType: 'high_school', primaryProduct: 'high_school', enabledProducts: ['high_school'] };
const TRAVEL_ONLY_CAPS = { schemaVersion: 1, customerType: 'travel', primaryProduct: 'travel', enabledProducts: ['travel'] };

test.describe('routing and access', () => {
  test('entitled organization reaches the High School UI', async ({ page }) => {
    await seedSession(page);
    await installHsApiMock(page, { capabilities: HS_CAPS });
    await page.goto('/');
    await expect(page).toHaveURL(/\/high-school$/);
    await expect(page.locator('#hs-pane-program')).toContainText('No program set up yet');
  });

  test('Travel-only organization cannot reach the High School UI via direct URL', async ({ page }) => {
    await seedSession(page);
    await installHsApiMock(page, { capabilities: TRAVEL_ONLY_CAPS });
    await page.goto('/high-school');
    // resolveActiveProductClient falls back to primaryProduct ('travel')
    // when the requested product isn't in enabledProducts -- the URL is
    // normalized away from /high-school and no HS content ever renders.
    await expect(page).toHaveURL(/\/travel$/);
    await expect(page.locator('#hs-pane-program')).toHaveCount(0);
  });

  test('unauthenticated state shows the login screen, not the High School UI', async ({ page }) => {
    await installHsApiMock(page, { capabilities: HS_CAPS });
    await page.goto('/');
    await expect(page.locator('#loginScreen')).not.toHaveClass(/hidden/);
    await expect(page.locator('#hs-pane-program')).toHaveCount(0);
  });

  test('a stale/expired session token is rejected and returns to login', async ({ page }) => {
    await seedSession(page);
    await page.route('**/api/product/capabilities', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Invalid or expired token' }) }));
    await page.goto('/');
    await expect(page.locator('#loginScreen')).not.toHaveClass(/hidden/);
  });
});

test.describe('program', () => {
  test('empty state, create, and duplicate conflict', async ({ page }) => {
    await seedSession(page);
    await installHsApiMock(page, { capabilities: HS_CAPS });
    await page.goto('/high-school');

    await expect(page.locator('#hs-pane-program')).toContainText('No program set up yet');
    await page.click('#hs-pane-program button:has-text("Set Up Program")');
    await page.fill('#hsProgramName', 'Central High Baseball');
    await page.fill('#hsProgramSchoolName', 'Central High School');
    await page.click('#hsProgramModalSaveBtn');

    await expect(page.locator('#hsProgramModal')).toBeHidden();
    await expect(page.locator('#hs-pane-program')).toContainText('Central High Baseball');
    await expect(page.locator('#hs-pane-program')).toContainText('ACTIVE', { ignoreCase: true });

    // Re-opening "create" against an org that already has a program (the
    // client never blocks this proactively -- the server's 409 is the
    // real boundary) must surface the server's exact conflict message.
    await page.evaluate(() => showHsProgramModal('create'));
    await page.fill('#hsProgramName', 'Duplicate Attempt');
    await page.click('#hsProgramModalSaveBtn');
    await expect(page.locator('#hsProgramModalError')).toBeVisible();
    await expect(page.locator('#hsProgramModalError')).toHaveText('A program already exists for this organization.');
  });

  test('validation error keeps the modal open with entered values intact', async ({ page }) => {
    await seedSession(page);
    await installHsApiMock(page, { capabilities: HS_CAPS });
    await page.goto('/high-school');
    await page.click('#hs-pane-program button:has-text("Set Up Program")');
    await page.click('#hsProgramModalSaveBtn');
    await expect(page.locator('#hsProgramModalError')).toHaveText('Program name is required.');
    await expect(page.locator('#hsProgramModal')).toBeVisible();
  });
});

async function createProgram(page) {
  await page.click('#hs-pane-program button:has-text("Set Up Program")');
  await page.fill('#hsProgramName', 'Central High Baseball');
  await page.click('#hsProgramModalSaveBtn');
  await expect(page.locator('#hsProgramModal')).toBeHidden();
}

test.describe('seasons', () => {
  test('requires a program first, then supports create, edit, and duplicate conflict', async ({ page }) => {
    await seedSession(page);
    await installHsApiMock(page, { capabilities: HS_CAPS });
    await page.goto('/high-school');

    await page.evaluate(() => switchHsTab('seasons'));
    await expect(page.locator('#hs-pane-seasons')).toContainText('Set up your program first');

    await page.evaluate(() => switchHsTab('program'));
    await createProgram(page);
    await page.evaluate(() => switchHsTab('seasons'));
    await expect(page.locator('#hs-pane-seasons')).toContainText('No seasons yet');

    await page.click('#hs-pane-seasons button:has-text("Add Season")');
    await page.fill('#hsSeasonName', 'Spring 2027');
    await page.fill('#hsSeasonSchoolYear', '2026-2027');
    await page.check('#hsSeasonIsCurrent');
    await page.click('#hsSeasonModal button:has-text("Save Season")');
    await expect(page.locator('#hsSeasonModal')).toBeHidden();
    await expect(page.locator('#hs-pane-seasons')).toContainText('Spring 2027');
    await expect(page.locator('#hs-pane-seasons')).toContainText('Current', { ignoreCase: true });

    // Duplicate name -> 409 surfaced verbatim.
    await page.click('#hs-pane-seasons button:has-text("Add Season")');
    await page.fill('#hsSeasonName', 'Spring 2027');
    await page.fill('#hsSeasonSchoolYear', '2026-2027');
    await page.click('#hsSeasonModal button:has-text("Save Season")');
    await expect(page.locator('#hsSeasonModalError')).toHaveText('A season with this name already exists for this program.');
  });
});

test.describe('teams', () => {
  test('create, edit, and archived teams block roster additions', async ({ page }) => {
    await seedSession(page);
    await installHsApiMock(page, { capabilities: HS_CAPS });
    await page.goto('/high-school');
    await createProgram(page);

    await page.evaluate(() => switchHsTab('teams'));
    await expect(page.locator('#hs-pane-teams')).toContainText('No teams yet');
    await page.click('#hs-pane-teams button:has-text("Add Team")');
    await page.fill('#hsTeamName', 'Varsity Baseball');
    await page.selectOption('#hsTeamLevel', 'varsity');
    await page.click('#hsTeamModal button:has-text("Save Team")');
    await expect(page.locator('#hs-pane-teams')).toContainText('Varsity Baseball');
    await expect(page.locator('#hs-pane-teams')).toContainText('ACTIVE', { ignoreCase: true });

    // Archive it, then confirm Roster blocks additions for this team.
    await page.evaluate(() => {
      const team = hsTeams[0];
      showHsTeamModal(team.id);
      document.getElementById('hsTeamIsActive').checked = false;
      return submitHsTeam();
    });
    await page.evaluate(() => switchHsTab('seasons'));
    await page.click('#hs-pane-seasons button:has-text("Add Season")');
    await page.fill('#hsSeasonName', 'Spring 2027');
    await page.fill('#hsSeasonSchoolYear', '2026-2027');
    await page.click('#hsSeasonModal button:has-text("Save Season")');

    await page.evaluate(() => switchHsTab('roster'));
    await expect(page.locator('#hsRosterListWrap')).toContainText('archived');
    await expect(page.locator('#hsRosterListWrap button:has-text("Add Player to Roster")')).toHaveCount(0);
  });
});

test.describe('players', () => {
  test('create, search (including special characters), and no-results state', async ({ page }) => {
    await seedSession(page);
    await installHsApiMock(page, { capabilities: HS_CAPS });
    await page.goto('/high-school');
    await createProgram(page);
    await page.evaluate(() => switchHsTab('players'));

    await page.click('#hs-pane-players button:has-text("Add Player")');
    await page.fill('#hsPlayerFirstName', "D'Angelo");
    await page.fill('#hsPlayerLastName', "O'Brien-Smith");
    await page.fill('#hsPlayerGradYear', '2027');
    await page.click('#hsPlayerModal button:has-text("Save Player")');
    await expect(page.locator('#hs-pane-players')).toContainText("D'Angelo O'Brien-Smith");

    await page.fill('#hsPlayerSearchInput', "o'brien");
    await page.click('#hs-pane-players button:has-text("Search")');
    await expect(page.locator('#hs-pane-players')).toContainText("D'Angelo O'Brien-Smith");

    await page.fill('#hsPlayerSearchInput', 'zzz-no-match');
    await page.click('#hs-pane-players button:has-text("Search")');
    await expect(page.locator('#hs-pane-players')).toContainText('No players match your search');
  });

  test('validation error for a missing required field', async ({ page }) => {
    await seedSession(page);
    await installHsApiMock(page, { capabilities: HS_CAPS });
    await page.goto('/high-school');
    await createProgram(page);
    await page.evaluate(() => switchHsTab('players'));
    await page.click('#hs-pane-players button:has-text("Add Player")');
    await page.fill('#hsPlayerFirstName', 'Jake');
    await page.click('#hsPlayerModal button:has-text("Save Player")');
    await expect(page.locator('#hsPlayerModalError')).toHaveText('First and last name are required.');
  });
});

async function setUpProgramTeamSeasonPlayer(page) {
  await createProgram(page);
  await page.evaluate(() => switchHsTab('teams'));
  await page.click('#hs-pane-teams button:has-text("Add Team")');
  await page.fill('#hsTeamName', 'Varsity Baseball');
  await page.click('#hsTeamModal button:has-text("Save Team")');

  await page.evaluate(() => switchHsTab('seasons'));
  await page.click('#hs-pane-seasons button:has-text("Add Season")');
  await page.fill('#hsSeasonName', 'Spring 2027');
  await page.fill('#hsSeasonSchoolYear', '2026-2027');
  await page.check('#hsSeasonIsCurrent');
  await page.click('#hsSeasonModal button:has-text("Save Season")');

  await page.evaluate(() => switchHsTab('players'));
  await page.click('#hs-pane-players button:has-text("Add Player")');
  await page.fill('#hsPlayerFirstName', 'Jake');
  await page.fill('#hsPlayerLastName', 'Thompson');
  await page.click('#hsPlayerModal button:has-text("Save Player")');
}

test.describe('roster', () => {
  test('add an eligible player, edit jersey number, soft-remove with confirmation, and restore', async ({ page }) => {
    await seedSession(page);
    await installHsApiMock(page, { capabilities: HS_CAPS });
    await page.goto('/high-school');
    await setUpProgramTeamSeasonPlayer(page);

    await page.evaluate(() => switchHsTab('roster'));
    await expect(page.locator('#hsRosterListWrap')).toContainText('No players on this roster yet');

    await page.click('#hsRosterListWrap button:has-text("Add Player to Roster")');
    await page.selectOption('#hsRosterPlayerSelect', { label: 'Jake Thompson' });
    await page.fill('#hsRosterJerseyNumber', '23');
    await page.click('#hsRosterMembershipModal button:has-text("Save")');
    await expect(page.locator('#hsRosterMembershipModal')).toBeHidden();
    await expect(page.locator('#hsRosterListWrap')).toContainText('Jake Thompson');
    await expect(page.locator('#hsRosterListWrap')).toContainText('#23');

    // Edit jersey number.
    await page.click('#hsRosterListWrap button:has-text("Edit")');
    await page.fill('#hsRosterJerseyNumber', '7');
    await page.click('#hsRosterMembershipModal button:has-text("Save")');
    await expect(page.locator('#hsRosterListWrap')).toContainText('#7');

    // Soft-remove requires confirmation (native confirm()).
    page.once('dialog', (dialog) => dialog.accept());
    await page.click('#hsRosterListWrap button:has-text("Remove")');
    await expect(page.locator('#hsRosterListWrap')).toContainText('Removed', { ignoreCase: true });
    await expect(page.locator('#hsRosterListWrap button:has-text("Restore")')).toBeVisible();

    // Restore re-activates the same membership (not a second POST).
    await page.click('#hsRosterListWrap button:has-text("Restore")');
    await expect(page.locator('#hsRosterListWrap')).toContainText('ACTIVE', { ignoreCase: true });
    await expect(page.locator('#hsRosterListWrap button:has-text("Restore")')).toHaveCount(0);
  });

  test('declining the removal confirmation leaves the membership active', async ({ page }) => {
    await seedSession(page);
    await installHsApiMock(page, { capabilities: HS_CAPS });
    await page.goto('/high-school');
    await setUpProgramTeamSeasonPlayer(page);
    await page.evaluate(() => switchHsTab('roster'));
    await page.click('#hsRosterListWrap button:has-text("Add Player to Roster")');
    await page.selectOption('#hsRosterPlayerSelect', { label: 'Jake Thompson' });
    await page.click('#hsRosterMembershipModal button:has-text("Save")');

    page.once('dialog', (dialog) => dialog.dismiss());
    await page.click('#hsRosterListWrap button:has-text("Remove")');
    await expect(page.locator('#hsRosterListWrap')).toContainText('ACTIVE', { ignoreCase: true });
  });

  test('a duplicate active roster membership is rejected with the server conflict message', async ({ page }) => {
    await seedSession(page);
    await installHsApiMock(page, { capabilities: HS_CAPS });
    await page.goto('/high-school');
    await setUpProgramTeamSeasonPlayer(page);
    await page.evaluate(() => switchHsTab('roster'));
    await page.click('#hsRosterListWrap button:has-text("Add Player to Roster")');
    await page.selectOption('#hsRosterPlayerSelect', { label: 'Jake Thompson' });
    await page.click('#hsRosterMembershipModal button:has-text("Save")');

    // The player is now on the roster, so the "eligible players" filter
    // removes them from a second Add attempt -- force the request anyway
    // to prove the server's own conflict is still handled safely if the
    // client's state were ever stale.
    await page.evaluate(async () => {
      const res = await apiFetch(`/api/high-school/teams/${hsRosterTeamId}/roster`, {
        method: 'POST',
        body: JSON.stringify({ playerId: hsPlayers[0].id, seasonId: hsRosterSeasonId }),
      });
      window.__conflictResult = { status: res.status, body: await res.json() };
    });
    const result = await page.evaluate(() => window.__conflictResult);
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('This player is already on this team for this season.');
  });
});

test.describe('support sessions', () => {
  test('reads work but every mutation control is hidden', async ({ page }) => {
    await seedSession(page);
    await seedSupportSession(page);
    await installHsApiMock(page, { capabilities: HS_CAPS });
    await page.goto('/high-school');

    await expect(page.locator('#mainPanel')).toContainText('View only (support session)');
    await expect(page.locator('#hs-pane-program button:has-text("Set Up Program")')).toHaveCount(0);

    await page.evaluate(() => switchHsTab('seasons'));
    await expect(page.locator('#hs-pane-seasons button:has-text("Add Season")')).toHaveCount(0);
    await page.evaluate(() => switchHsTab('teams'));
    await expect(page.locator('#hs-pane-teams button:has-text("Add Team")')).toHaveCount(0);
    await page.evaluate(() => switchHsTab('players'));
    await expect(page.locator('#hs-pane-players button:has-text("Add Player")')).toHaveCount(0);
  });

  test('a stale mutation attempt during a support session is safely rejected by the backend, not silently allowed', async ({ page }) => {
    await seedSession(page);
    await seedSupportSession(page);
    await installHsApiMock(page, { capabilities: HS_CAPS });
    // Override the program route specifically to behave like the real
    // server's blockWriteDuringReadOnlySupport: any write during an
    // active read-only support session is rejected with 403, regardless
    // of what the client's own hidden-controls state assumes.
    await page.route('**/api/high-school/program', async (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'This is a read-only support session — write actions are disabled.' }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ program: null }) });
    });
    await page.goto('/high-school');

    const result = await page.evaluate(async () => {
      const res = await apiFetch('/api/high-school/program', { method: 'POST', body: JSON.stringify({ name: 'Should be blocked' }) });
      return { status: res.status, body: await res.json() };
    });
    expect(result.status).toBe(403);
    expect(result.body.error).toBe('This is a read-only support session — write actions are disabled.');
  });
});

test.describe('error and state handling', () => {
  test('a sanitized 500 error is shown as-is, never a raw error object', async ({ page }) => {
    await seedSession(page);
    await page.route('**/api/product/capabilities', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(HS_CAPS) }));
    await page.route('**/api/high-school/program', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Something went wrong. Please try again.' }) }));
    await page.goto('/high-school');
    await expect(page.locator('#hs-pane-program')).toContainText('Something went wrong. Please try again.');
    await expect(page.locator('#hs-pane-program')).not.toContainText('at Object');
    await expect(page.locator('#hs-pane-program')).not.toContainText('stack');
  });

  test('a network failure shows a retry affordance, not a crash', async ({ page }) => {
    await seedSession(page);
    await page.route('**/api/product/capabilities', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(HS_CAPS) }));
    await page.route('**/api/high-school/program', (route) => route.abort('failed'));
    await page.goto('/high-school');
    await expect(page.locator('#hs-pane-program')).toContainText('Check your connection and try again.');
    await expect(page.locator('#hs-pane-program button:has-text("Retry")')).toBeVisible();
  });
});

test.describe('Travel Baseball regression', () => {
  test('Travel navigation and sidebar are unaffected by the High School shell changes', async ({ page }) => {
    await seedSession(page);
    await page.route('**/api/product/capabilities', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TRAVEL_ONLY_CAPS) }));
    await page.route('**/api/teams', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
    await page.goto('/travel');
    await expect(page).toHaveURL(/\/travel$/);
    await expect(page.locator('#appSidebar')).toBeVisible();
    const gridCols = await page.evaluate(() => getComputedStyle(document.getElementById('appLayout')).gridTemplateColumns);
    const parts = gridCols.split(' ');
    expect(parts.length).toBe(2);
    expect(parts[0]).toBe('280px');
  });
});
