'use strict';

// Focused Playwright coverage for the opponent-roster and coach-scouting-notes
// UI added on top of PR #27's backend (src/opponent-roster-service.js,
// src/coach-notes-service.js, src/opponent-intelligence-api.js). Mirrors
// test/high-school-ui.spec.js's established convention exactly: DESIGN_MODE
// stays false, a fake logged-in session is seeded via localStorage, and
// /api/* calls are intercepted with responses shaped like the merged backend
// contract (see helpers/opponent-intelligence-api-mock.js's header comment).
// Nothing here exercises the DESIGN_MODE/mockApiResponse() convenience path.
// Run with `npx playwright test` (not `npm test`).
//
// Locators are always scoped to an opponent-intelligence-specific container
// (#pane-opp-roster, #oppPlayerModal, etc.), never bare text -- "Save
// Player" is reused verbatim by the pre-existing Travel My Team player modal
// AND the High School player modal, and an unscoped locator would resolve
// to one of those hidden elements first and hang. Same reasoning as
// test/high-school-ui.spec.js's own header comment.

const { test, expect } = require('@playwright/test');
const { installOppApiMock, seedSession, makeOpponentTeam } = require('./helpers/opponent-intelligence-api-mock');

async function gotoOpponent(page, db) {
  await page.goto('/travel');
  await page.click(`.team-item:has-text("${db.teams[0].team_name}")`);
}

test.describe('routing and tab access', () => {
  test('selecting an opponent reaches Roster and Scouting Notes tabs, and each tab click actually loads its data', async ({ page }) => {
    await seedSession(page);
    const db = await installOppApiMock(page, { teams: [makeOpponentTeam({ team_name: 'Birmingham Stars 14U' })] });
    await gotoOpponent(page, db);

    // Regression coverage: switchTab('opp-roster')/('opp-notes') must
    // themselves trigger the data fetch -- a prior version of this UI only
    // populated these panes from a one-time check inside renderMain() (run
    // once when the team is first selected, while the default active tab is
    // 'run'), so clicking the Roster/Scouting Notes tab did nothing but show
    // the static "Loading..." placeholder forever.
    await page.click('.main-tab:has-text("Roster")');
    await expect(page.locator('#pane-opp-roster')).toContainText('No opponent players yet', { timeout: 5000 });

    await page.click('.main-tab:has-text("Scouting Notes")');
    await expect(page.locator('#pane-opp-notes')).toContainText('No scouting notes yet', { timeout: 5000 });
  });

  test('unauthenticated state shows the login screen, not the opponent UI', async ({ page }) => {
    const db = await installOppApiMock(page, { teams: [makeOpponentTeam()] });
    await page.goto('/travel');
    await expect(page.locator('#loginScreen')).not.toHaveClass(/hidden/);
    await expect(page.locator('#pane-opp-roster')).toHaveCount(0);
  });
});

test.describe('roster: add, edit, and lifecycle status', () => {
  test('empty state, add a player with full detail, and every required field renders', async ({ page }) => {
    await seedSession(page);
    const db = await installOppApiMock(page, { teams: [makeOpponentTeam()] });
    await gotoOpponent(page, db);
    await page.click('.main-tab:has-text("Roster")');
    await expect(page.locator('#pane-opp-roster')).toContainText('No opponent players yet');

    await page.click('#pane-opp-roster button:has-text("Add Player")');
    await page.fill('#oppPlayerFirstName', 'Jaylen');
    await page.fill('#oppPlayerLastName', 'Marsh');
    await page.fill('#oppPlayerJersey', '7');
    await page.fill('#oppPlayerPositions', 'SS, 2B');
    await page.selectOption('#oppPlayerBats', 'R');
    await page.selectOption('#oppPlayerThrows', 'R');
    await page.fill('#oppPlayerClassYear', '2027');
    await page.selectOption('#oppPlayerStatus', 'active');
    await page.click('#oppPlayerModal button:has-text("Save Player")');
    await expect(page.locator('#oppPlayerModal')).toBeHidden();

    const row = page.locator('.roster-row', { hasText: 'Jaylen Marsh' });
    await expect(row).toContainText('#7');
    await expect(row).toContainText('SS/2B');
    await expect(row).toContainText('R/R');
    await expect(row).toContainText('2027');
    await expect(row).toContainText('Active');
    await expect(row).toContainText('Manually entered');
  });

  test('every lifecycle status renders its exact label', async ({ page }) => {
    await seedSession(page);
    const db = await installOppApiMock(page, { teams: [makeOpponentTeam()] });
    await gotoOpponent(page, db);
    await page.click('.main-tab:has-text("Roster")');

    const statuses = [
      ['active', 'Active'], ['graduated', 'Graduated'], ['transferred', 'Transferred'],
      ['not_participating', 'Not Participating'], ['other_non_returning', 'Other / Non-Returning'],
    ];
    for (const [value, label] of statuses) {
      await page.click('#pane-opp-roster button:has-text("Add Player")');
      await page.fill('#oppPlayerFirstName', 'Jo');
      await page.fill('#oppPlayerLastName', `Status-${value}`);
      await page.selectOption('#oppPlayerStatus', value);
      await page.click('#oppPlayerModal button:has-text("Save Player")');
      await expect(page.locator('.roster-row', { hasText: `Status-${value}` })).toContainText(label);
    }
  });

  // Regression coverage: submitOpponentPlayer() used to unconditionally
  // POST a new /memberships row whenever a jersey number was present, even
  // when editing a player who already had one. Because season_label is
  // never set from this form (always NULL), and the migration's own unique
  // constraint intentionally treats NULL season_label as non-deduplicating
  // (opponent_roster_memberships_player_team_season_key), that POST never
  // conflicted -- it silently created a second membership row on every
  // re-save instead of updating the jersey number in place. Fixed to PATCH
  // the existing membership (tracked via a hidden oppPlayerMembershipId
  // field populated by showEditOpponentPlayer) when one already exists.
  test('editing an existing player\'s jersey number updates the membership in place, not a duplicate', async ({ page }) => {
    await seedSession(page);
    const db = await installOppApiMock(page, { teams: [makeOpponentTeam()] });
    await gotoOpponent(page, db);
    await page.click('.main-tab:has-text("Roster")');

    await page.click('#pane-opp-roster button:has-text("Add Player")');
    await page.fill('#oppPlayerFirstName', 'Cole');
    await page.fill('#oppPlayerLastName', 'Beringer');
    await page.fill('#oppPlayerJersey', '21');
    await page.click('#oppPlayerModal button:has-text("Save Player")');
    await expect(page.locator('.roster-row', { hasText: 'Cole Beringer' })).toContainText('#21');
    expect(db.memberships.length).toBe(1);

    await page.locator('.roster-row', { hasText: 'Cole Beringer' }).locator('button:has-text("Edit")').click();
    await expect(page.locator('#oppPlayerJersey')).toHaveValue('21');
    await page.fill('#oppPlayerJersey', '99');
    await page.click('#oppPlayerModal button:has-text("Save Player")');
    await expect(page.locator('.roster-row', { hasText: 'Cole Beringer' })).toContainText('#99');

    expect(db.memberships.length).toBe(1);
    expect(db.memberships[0].jersey_number).toBe('99');
  });

  test('search filters by name and by jersey number', async ({ page }) => {
    await seedSession(page);
    const db = await installOppApiMock(page, { teams: [makeOpponentTeam()] });
    await gotoOpponent(page, db);
    await page.click('.main-tab:has-text("Roster")');

    for (const [first, last, jersey] of [['Jaylen', 'Marsh', '7'], ['Cole', 'Beringer', '21']]) {
      await page.click('#pane-opp-roster button:has-text("Add Player")');
      await page.fill('#oppPlayerFirstName', first);
      await page.fill('#oppPlayerLastName', last);
      await page.fill('#oppPlayerJersey', jersey);
      await page.click('#oppPlayerModal button:has-text("Save Player")');
      // submitOpponentPlayer()'s post-save await loadOpponentRoster() call is
      // still in flight when page.click() above returns (Playwright only
      // waits for the click to dispatch, not for the async handler it
      // triggers) -- each add must be confirmed on screen before starting
      // the next one, or a subsequent renderOpponentRosterList() re-render
      // (which regenerates the search input element itself) can race with
      // this loop's next action.
      await expect(page.locator('.roster-row', { hasText: `${first} ${last}` })).toBeVisible();
    }

    const search = page.locator('#pane-opp-roster input[placeholder="Search by name or jersey number..."]');
    await search.fill('marsh');
    await expect(page.locator('.roster-row', { hasText: 'Jaylen Marsh' })).toBeVisible();
    await expect(page.locator('.roster-row', { hasText: 'Cole Beringer' })).toHaveCount(0);

    await search.fill('21');
    await expect(page.locator('.roster-row', { hasText: 'Cole Beringer' })).toBeVisible();
    await expect(page.locator('.roster-row', { hasText: 'Jaylen Marsh' })).toHaveCount(0);

    await search.fill('zzz-no-match');
    await expect(page.locator('#pane-opp-roster')).toContainText('No players match');
  });

  test('validation error for missing required fields', async ({ page }) => {
    await seedSession(page);
    const db = await installOppApiMock(page, { teams: [makeOpponentTeam()] });
    await gotoOpponent(page, db);
    await page.click('.main-tab:has-text("Roster")');
    await page.click('#pane-opp-roster button:has-text("Add Player")');
    await page.click('#oppPlayerModal button:has-text("Save Player")');
    await expect(page.locator('#oppPlayerModalError')).toHaveText('First and last name are required.');
    await expect(page.locator('#oppPlayerModal')).toBeVisible();
  });
});

test.describe('roster: coach-confirmed values and import conflicts', () => {
  test('editing a field marks it coach-confirmed, and a later import conflict is shown without discarding either value', async ({ page }) => {
    await seedSession(page);
    const db = await installOppApiMock(page, { teams: [makeOpponentTeam()] });
    await gotoOpponent(page, db);
    await page.click('.main-tab:has-text("Roster")');

    await page.click('#pane-opp-roster button:has-text("Add Player")');
    await page.fill('#oppPlayerFirstName', 'Cole');
    await page.fill('#oppPlayerLastName', 'Beringer');
    await page.selectOption('#oppPlayerBats', 'L');
    await page.click('#oppPlayerModal button:has-text("Save Player")');

    await page.locator('.roster-row', { hasText: 'Cole Beringer' }).locator('button:has-text("Edit")').click();
    await page.selectOption('#oppPlayerBats', 'L');
    await page.click('#oppPlayerModal button:has-text("Save Player")');
    await expect(page.locator('.roster-row', { hasText: 'Cole Beringer' })).toContainText('confirmed');

    // Simulate an import that disagrees with the coach-confirmed bats value
    // directly against the mock db (no import UI exists yet), then reload
    // the roster the same way the real page does after a background
    // conflict fetch.
    const player = db.players.find((p) => p.first_name === 'Cole');
    db.conflicts.push({
      id: 'test-conflict-1', opponent_player_id: player.id, field_name: 'bats',
      coach_confirmed_value: 'L', imported_value: 'R', source: 'gamechanger',
      detected_at: new Date().toISOString(), resolved_at: null,
    });
    // A reload wipes client-side state (selectedTeam, activeTab) even
    // though the seeded session persists in localStorage -- the opponent
    // must be re-selected before its tab bar exists again.
    await page.reload();
    await page.click(`.team-item:has-text("${db.teams[0].team_name}")`);
    await page.click('.main-tab:has-text("Roster")');

    const row = page.locator('.roster-row', { hasText: 'Cole Beringer' });
    await expect(row).toContainText('Imported data disagrees with your saved value');
    await expect(row).toContainText('your value "L" vs. imported "R"');
    await expect(row).toContainText('B/T: L/');
  });

  test('resolving a conflict by keeping the coach value clears the banner without changing the field', async ({ page }) => {
    await seedSession(page);
    const db = await installOppApiMock(page, { teams: [makeOpponentTeam()] });
    await gotoOpponent(page, db);
    await page.click('.main-tab:has-text("Roster")');
    await page.click('#pane-opp-roster button:has-text("Add Player")');
    await page.fill('#oppPlayerFirstName', 'Cole');
    await page.fill('#oppPlayerLastName', 'Beringer');
    await page.selectOption('#oppPlayerBats', 'L');
    await page.click('#oppPlayerModal button:has-text("Save Player")');

    const player = db.players.find((p) => p.first_name === 'Cole');
    player.confirmed_fields = ['bats'];
    db.conflicts.push({
      id: 'test-conflict-2', opponent_player_id: player.id, field_name: 'bats',
      coach_confirmed_value: 'L', imported_value: 'R', source: 'gamechanger',
      detected_at: new Date().toISOString(), resolved_at: null,
    });
    // A reload wipes client-side state (selectedTeam, activeTab) even
    // though the seeded session persists in localStorage -- the opponent
    // must be re-selected before its tab bar exists again.
    await page.reload();
    await page.click(`.team-item:has-text("${db.teams[0].team_name}")`);
    await page.click('.main-tab:has-text("Roster")');
    await page.locator('.roster-row', { hasText: 'Cole Beringer' }).locator('button:has-text("Keep my value")').click();

    await expect(page.locator('.roster-row', { hasText: 'Cole Beringer' })).not.toContainText('disagrees');
    expect(db.players.find((p) => p.first_name === 'Cole').bats).toBe('L');
    expect(db.conflicts.find((c) => c.id === 'test-conflict-2').resolution).toBe('kept_coach_value');
  });

  test('resolving a conflict by accepting the imported value updates the field and clears the banner', async ({ page }) => {
    await seedSession(page);
    const db = await installOppApiMock(page, { teams: [makeOpponentTeam()] });
    await gotoOpponent(page, db);
    await page.click('.main-tab:has-text("Roster")');
    await page.click('#pane-opp-roster button:has-text("Add Player")');
    await page.fill('#oppPlayerFirstName', 'Cole');
    await page.fill('#oppPlayerLastName', 'Beringer');
    await page.selectOption('#oppPlayerBats', 'L');
    await page.click('#oppPlayerModal button:has-text("Save Player")');

    const player = db.players.find((p) => p.first_name === 'Cole');
    player.confirmed_fields = ['bats'];
    db.conflicts.push({
      id: 'test-conflict-3', opponent_player_id: player.id, field_name: 'bats',
      coach_confirmed_value: 'L', imported_value: 'R', source: 'gamechanger',
      detected_at: new Date().toISOString(), resolved_at: null,
    });
    // A reload wipes client-side state (selectedTeam, activeTab) even
    // though the seeded session persists in localStorage -- the opponent
    // must be re-selected before its tab bar exists again.
    await page.reload();
    await page.click(`.team-item:has-text("${db.teams[0].team_name}")`);
    await page.click('.main-tab:has-text("Roster")');
    await page.locator('.roster-row', { hasText: 'Cole Beringer' }).locator('button:has-text("Use imported value")').click();

    await expect(page.locator('.roster-row', { hasText: 'Cole Beringer' })).not.toContainText('disagrees');
    await expect(page.locator('.roster-row', { hasText: 'Cole Beringer' })).toContainText('B/T: R/');
    expect(db.players.find((p) => p.first_name === 'Cole').bats).toBe('R');
  });
});

test.describe('roster: merge duplicate player', () => {
  test('merge confirmation clearly shows the duplicate and surviving player, warns it cannot be casually reversed, and merges safely', async ({ page }) => {
    await seedSession(page);
    const db = await installOppApiMock(page, { teams: [makeOpponentTeam()] });
    await gotoOpponent(page, db);
    await page.click('.main-tab:has-text("Roster")');

    for (const [first, last] of [['Jaylen', 'Marsh'], ['Cole', 'Beringer']]) {
      await page.click('#pane-opp-roster button:has-text("Add Player")');
      await page.fill('#oppPlayerFirstName', first);
      await page.fill('#oppPlayerLastName', last);
      await page.click('#oppPlayerModal button:has-text("Save Player")');
      await expect(page.locator('.roster-row', { hasText: `${first} ${last}` })).toBeVisible();
    }

    await page.locator('.roster-row', { hasText: 'Cole Beringer' }).locator('button:has-text("Merge Duplicate")').click();
    await expect(page.locator('#oppMergeModal')).toContainText('permanently deleted');
    await expect(page.locator('#oppMergeDuplicateName')).toHaveValue('Cole Beringer');
    await expect(page.locator('#oppMergeKeepSelect')).toContainText('Jaylen Marsh');

    page.once('dialog', (dialog) => {
      expect(dialog.message()).toContain('Cole Beringer');
      expect(dialog.message()).toContain('Jaylen Marsh');
      expect(dialog.message().toLowerCase()).toContain('cannot be undone');
      dialog.accept();
    });
    await page.selectOption('#oppMergeKeepSelect', { label: 'Jaylen Marsh' });
    await page.click('#oppMergeModal button:has-text("Merge Players")');

    await expect(page.locator('#oppMergeModal')).toBeHidden();
    await expect(page.locator('.roster-row', { hasText: 'Cole Beringer' })).toHaveCount(0);
    await expect(page.locator('.roster-row', { hasText: 'Jaylen Marsh' })).toHaveCount(1);
  });

  test('declining the merge confirmation performs no merge', async ({ page }) => {
    await seedSession(page);
    const db = await installOppApiMock(page, { teams: [makeOpponentTeam()] });
    await gotoOpponent(page, db);
    await page.click('.main-tab:has-text("Roster")');
    for (const [first, last] of [['Jaylen', 'Marsh'], ['Cole', 'Beringer']]) {
      await page.click('#pane-opp-roster button:has-text("Add Player")');
      await page.fill('#oppPlayerFirstName', first);
      await page.fill('#oppPlayerLastName', last);
      await page.click('#oppPlayerModal button:has-text("Save Player")');
      await expect(page.locator('.roster-row', { hasText: `${first} ${last}` })).toBeVisible();
    }
    await page.locator('.roster-row', { hasText: 'Cole Beringer' }).locator('button:has-text("Merge Duplicate")').click();
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.click('#oppMergeModal button:has-text("Merge Players")');
    expect(db.players.length).toBe(2);
  });

  test('merging affected notes: a note on the duplicate player is reassigned to the surviving player', async ({ page }) => {
    await seedSession(page);
    const db = await installOppApiMock(page, { teams: [makeOpponentTeam()] });
    await gotoOpponent(page, db);
    await page.click('.main-tab:has-text("Roster")');
    for (const [first, last] of [['Jaylen', 'Marsh'], ['Cole', 'Beringer']]) {
      await page.click('#pane-opp-roster button:has-text("Add Player")');
      await page.fill('#oppPlayerFirstName', first);
      await page.fill('#oppPlayerLastName', last);
      await page.click('#oppPlayerModal button:has-text("Save Player")');
      await expect(page.locator('.roster-row', { hasText: `${first} ${last}` })).toBeVisible();
    }
    const duplicate = db.players.find((p) => p.first_name === 'Cole');
    const keep = db.players.find((p) => p.first_name === 'Jaylen');
    db.notes.push({
      id: 'test-note-merge-1', org_id: 'test-org', author_user_id: 'test-user-1',
      opponent_team_id: db.teams[0].id, opponent_player_id: duplicate.id, game_id: null,
      observed_game_date: null, note_text: 'Tips his changeup.', category: null,
      include_in_report: true, is_archived: false,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('.roster-row', { hasText: 'Cole Beringer' }).locator('button:has-text("Merge Duplicate")').click();
    await page.selectOption('#oppMergeKeepSelect', { label: 'Jaylen Marsh' });
    await page.click('#oppMergeModal button:has-text("Merge Players")');
    await expect(page.locator('#oppMergeModal')).toBeHidden();

    expect(db.notes.find((n) => n.id === 'test-note-merge-1').opponent_player_id).toBe(keep.id);
  });
});

test.describe('coach scouting notes', () => {
  test('empty state and quick-add with only note text', async ({ page }) => {
    await seedSession(page);
    const db = await installOppApiMock(page, { teams: [makeOpponentTeam()] });
    await gotoOpponent(page, db);
    await page.click('.main-tab:has-text("Scouting Notes")');
    await expect(page.locator('#pane-opp-notes')).toContainText('No scouting notes yet');
    await expect(page.locator('#pane-opp-notes')).toContainText('do not change recorded statistics');

    await page.fill('#oppNoteQuickText', 'Their #12 has a big leg kick.');
    await page.click('#pane-opp-notes button:has-text("Add Note")');
    await expect(page.locator('.roster-row', { hasText: 'Their #12 has a big leg kick.' })).toBeVisible();
    await expect(page.locator('#pane-opp-notes')).toContainText('Opponent');
    await expect(page.locator('#pane-opp-notes')).toContainText('Included in reports');
    await expect(page.locator('#pane-opp-notes')).toContainText('You ·');
  });

  test('quick-add with category, player association, and observed date', async ({ page }) => {
    await seedSession(page);
    const db = await installOppApiMock(page, { teams: [makeOpponentTeam()] });
    await gotoOpponent(page, db);
    await page.click('.main-tab:has-text("Roster")');
    await page.click('#pane-opp-roster button:has-text("Add Player")');
    await page.fill('#oppPlayerFirstName', 'Jaylen');
    await page.fill('#oppPlayerLastName', 'Marsh');
    await page.click('#oppPlayerModal button:has-text("Save Player")');

    await page.click('.main-tab:has-text("Scouting Notes")');
    await page.click('#pane-opp-notes summary:has-text("More options")');
    await page.fill('#oppNoteQuickText', 'Struggles with inside fastballs.');
    await page.selectOption('#oppNoteQuickCategory', 'hitting_approach');
    await page.selectOption('#oppNoteQuickPlayer', { label: 'Jaylen Marsh' });
    await page.fill('#oppNoteQuickDate', '2026-07-15');
    await page.click('#pane-opp-notes button:has-text("Add Note")');

    const row = page.locator('.roster-row', { hasText: 'Struggles with inside fastballs.' });
    await expect(row).toContainText('Player');
    await expect(row).toContainText('Hitting Approach');
    expect(db.notes[0].opponent_player_id).toBe(db.players[0].id);
    expect(db.notes[0].observed_game_date).toBe('2026-07-15');
  });

  test('editing a note updates its text, and the character limit is enforced client-side', async ({ page }) => {
    await seedSession(page);
    const db = await installOppApiMock(page, { teams: [makeOpponentTeam()] });
    await gotoOpponent(page, db);
    await page.click('.main-tab:has-text("Scouting Notes")');
    await page.fill('#oppNoteQuickText', 'Original note text.');
    await page.click('#pane-opp-notes button:has-text("Add Note")');

    await page.locator('.roster-row', { hasText: 'Original note text.' }).locator('button:has-text("Edit")').click();
    await expect(page.locator('#oppNoteEditText')).toHaveValue('Original note text.');
    await page.fill('#oppNoteEditText', 'Updated note text.');
    await page.click('#oppNoteEditModal button:has-text("Save Note")');
    await expect(page.locator('#oppNoteEditModal')).toBeHidden();
    await expect(page.locator('.roster-row', { hasText: 'Updated note text.' })).toBeVisible();

    // The textarea's own maxlength="4000" attribute already blocks typing
    // or filling past the limit in a real browser, so the >4000 branch of
    // submitOpponentNoteEdit()'s client-side length check is unreachable
    // through normal UI interaction -- this proves the HTML-level limit
    // itself is visibly enforced (Phase 3's "visibly enforce the length
    // limit" requirement), which is the guarantee a coach actually sees.
    await page.locator('.roster-row', { hasText: 'Updated note text.' }).locator('button:has-text("Edit")').click();
    const tooLong = 'x'.repeat(4500);
    await page.fill('#oppNoteEditText', tooLong);
    const actualValue = await page.locator('#oppNoteEditText').inputValue();
    expect(actualValue.length).toBe(4000);
    await page.click('#oppNoteEditModal button:has-text("Save Note")');
    await expect(page.locator('#oppNoteEditModal')).toBeHidden();
    expect(db.notes[0].note_text.length).toBe(4000);
  });

  test('archiving requires confirmation, removes the note from the active list, and excludes it from future reports', async ({ page }) => {
    await seedSession(page);
    const db = await installOppApiMock(page, { teams: [makeOpponentTeam()] });
    await gotoOpponent(page, db);
    await page.click('.main-tab:has-text("Scouting Notes")');
    await page.fill('#oppNoteQuickText', 'A note to archive.');
    await page.click('#pane-opp-notes button:has-text("Add Note")');

    page.once('dialog', (dialog) => {
      expect(dialog.message().toLowerCase()).toContain('archive');
      expect(dialog.message().toLowerCase()).toContain('never permanently deleted');
      dialog.dismiss();
    });
    await page.locator('.roster-row', { hasText: 'A note to archive.' }).locator('button:has-text("Archive")').click();
    await expect(page.locator('.roster-row', { hasText: 'A note to archive.' })).toBeVisible();

    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('.roster-row', { hasText: 'A note to archive.' }).locator('button:has-text("Archive")').click();
    await expect(page.locator('#pane-opp-notes')).toContainText('No scouting notes yet');
    expect(db.notes[0].is_archived).toBe(true);
  });

  test('toggling include/exclude updates the badge and the report-context preview count', async ({ page }) => {
    await seedSession(page);
    const db = await installOppApiMock(page, { teams: [makeOpponentTeam()] });
    await gotoOpponent(page, db);
    await page.click('.main-tab:has-text("Scouting Notes")');
    await page.fill('#oppNoteQuickText', 'Toggle me.');
    await page.click('#pane-opp-notes button:has-text("Add Note")');
    await expect(page.locator('#reportContextPreview')).toContainText('1 coach note will be included');

    await page.locator('.roster-row', { hasText: 'Toggle me.' }).locator('input[type="checkbox"]').uncheck();
    await expect(page.locator('.roster-row', { hasText: 'Toggle me.' })).toContainText('Excluded from reports');
    await expect(page.locator('#reportContextPreview')).toContainText('No coach notes will be sent');
  });

  // Coach note text must render strictly as text -- never be interpreted
  // as HTML/script -- and it is passed to the model as data inside an
  // explicitly-labeled, hard-ruled prompt section (see
  // src/report-context-builder.js's HARD_RULES), never as instructions to
  // the UI itself. This proves the client-side half of that: renderOpponentNotesList
  // uses escHtml() on note_text, and CSS white-space:pre-wrap preserves
  // line breaks without needing raw <br> tags.
  test('note text containing HTML/script-like content renders as literal text and preserves line breaks', async ({ page }) => {
    await seedSession(page);
    const db = await installOppApiMock(page, { teams: [makeOpponentTeam()] });
    await gotoOpponent(page, db);
    await page.click('.main-tab:has-text("Scouting Notes")');

    const dangerous = '<script>window.__xss=1</script>\nSecond line after a break.';
    await page.fill('#oppNoteQuickText', dangerous);
    await page.click('#pane-opp-notes button:has-text("Add Note")');

    const xssRan = await page.evaluate(() => window.__xss);
    expect(xssRan).toBeUndefined();
    await expect(page.locator('#pane-opp-notes')).toContainText('<script>window.__xss=1</script>');
    await expect(page.locator('#pane-opp-notes')).toContainText('Second line after a break.');
  });
});

test.describe('report-context preview', () => {
  test('shows exact terminology for game/player analysis readiness, and works with zero notes', async ({ page }) => {
    await seedSession(page);
    const db = await installOppApiMock(page, {
      teams: [makeOpponentTeam({ hasGC: true, hasPG: false })],
    });
    await gotoOpponent(page, db);

    const preview = page.locator('#reportContextPreview');
    await expect(preview).toContainText('Opponent Game Analysis Ready');
    await expect(preview).toContainText('Opponent Player Analysis Missing');
    await expect(preview).toContainText('No coach notes will be sent');
    await expect(preview).not.toContainText('PSG');
    await expect(preview).not.toContainText('PSP');
  });

  test('counts reflect roster and included-note totals, and never expose raw provenance JSON or internal IDs', async ({ page }) => {
    await seedSession(page);
    const db = await installOppApiMock(page, { teams: [makeOpponentTeam({ hasGC: false, hasPG: true })] });
    await gotoOpponent(page, db);
    await page.click('.main-tab:has-text("Roster")');
    await page.click('#pane-opp-roster button:has-text("Add Player")');
    await page.fill('#oppPlayerFirstName', 'Jaylen');
    await page.fill('#oppPlayerLastName', 'Marsh');
    await page.click('#oppPlayerModal button:has-text("Save Player")');
    await page.click('.main-tab:has-text("Scouting Notes")');
    await page.fill('#oppNoteQuickText', 'One included note.');
    await page.click('#pane-opp-notes button:has-text("Add Note")');

    const preview = page.locator('#reportContextPreview');
    await expect(preview).toContainText('1 opponent roster player');
    await expect(preview).toContainText('1 coach note will be included');
    await expect(preview).toContainText('Opponent Game Analysis Missing');
    await expect(preview).toContainText('Opponent Player Analysis Ready');

    const previewText = await preview.innerText();
    expect(previewText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(previewText.toLowerCase()).not.toContain('org_id');
    expect(previewText.toLowerCase()).not.toContain('record_source');
  });
});

test.describe('error handling', () => {
  test('a sanitized roster load error is shown with a retry affordance, never a raw error object', async ({ page }) => {
    await seedSession(page);
    const db = await installOppApiMock(page, { teams: [makeOpponentTeam()] });
    await gotoOpponent(page, db);
    await page.route('**/api/opponent-intelligence/teams/*/roster', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Something went wrong. Please try again.' }) }));
    await page.click('.main-tab:has-text("Roster")');
    await expect(page.locator('#pane-opp-roster')).toContainText('Something went wrong. Please try again.');
    await expect(page.locator('#pane-opp-roster')).not.toContainText('at Object');
    await expect(page.locator('#pane-opp-roster button:has-text("Retry")')).toBeVisible();
  });
});
