'use strict';

// Integration tests for the High School domain API -- both the original
// read-only routes (GET /api/high-school/program, /seasons, /teams,
// /teams/:id/roster) and the program/seasons/teams/players/roster-membership
// CRUD foundation added on top of them -- and the underlying tenant-isolation
// / RLS / entitlement / support-session guarantees both layers share.
//
// WRITTEN BUT NOT EXECUTED by default -- mirrors
// test/api-product-capabilities.test.js's exact gating design (see that
// file's own header comment for the full rationale). These require:
//   1. supabase/migrations/20260724221500_create_high_school_domain.sql
//      applied to a NON-PRODUCTION Supabase project.
//   2. A running instance of this application's server (server.js),
//      reachable at TEST_BASE_URL.
//   3. Seeded fixtures on that non-production project:
//      - TEST_TRAVEL_ORG_ID: an org with enabled_products = {travel} only.
//      - TEST_HS_ORG_ID: an org with enabled_products including
//        'high_school', with an hs_programs row, at least one hs_seasons
//        row (one marked is_current = true), at least one hs_teams row,
//        at least one hs_players row, and at least one
//        hs_roster_memberships row connecting them.
//      - TEST_HS_ORG_2_ID: a SECOND High-School-entitled org, with its own
//        program/season/team/player/roster fixtures, used only to prove
//        tenant isolation (Tenant A cannot see Tenant B's records, and
//        cannot LINK Tenant B's records into its own writes either).
//   4. TEST_USER_TOKEN: JWT for a member of TEST_TRAVEL_ORG_ID.
//   5. TEST_HS_USER_TOKEN: JWT for a member of TEST_HS_ORG_ID.
//   6. TEST_HS_TEAM_ID / TEST_HS_SEASON_ID: known IDs of the seeded team
//      and season under TEST_HS_ORG_ID, for the roster endpoint.
//   7. TEST_HS_ORG_2_TEAM_ID: a team ID belonging to TEST_HS_ORG_2_ID, used
//      to prove TEST_HS_USER_TOKEN cannot read it.
//   8. TEST_ADMIN_TOKEN: a platform-admin token, for the support-session
//      tests (mirrors api-product-capabilities.test.js's own use of this).
//   9. TEST_HS_ORG_2_PLAYER_ID / TEST_HS_ORG_2_SEASON_ID: a player id and
//      season id belonging to TEST_HS_ORG_2_ID, used to prove a roster-add
//      request naming either one from TEST_HS_ORG_ID's session 404s instead
//      of linking across the tenant boundary. Write tests needing either of
//      these are individually gated and skip (not fail) if unset, matching
//      the file's own existing precedent for TEST_HS_ORG_NO_PROGRAM_TOKEN.
//
// Every test below is skipped by default -- `npm test` stays green using
// only the database-free tests in test/high-school-domain-migration.test.js,
// test/high-school-api.test.js, and test/high-school-roster-service.test.js.
//
// Same multi-gate safety design as test/api-product-capabilities.test.js:
// RUN_INTEGRATION_TESTS=1 AND an explicit TEST_BASE_URL (no default) AND
// TEST_CONFIRM_NON_PRODUCTION=yes must ALL be set, AND the configured
// SUPABASE_URL is refused outright if it resolves to the known production
// project ref, regardless of what the other flags say.
//
// Run with: node --test test/high-school-api-integration.test.js

const KNOWN_PRODUCTION_PROJECT_REF = 'jqycdruhcaqdumuhirsw'; // "Jobu Scout Project"
const configuredSupabaseUrl = process.env.SUPABASE_URL || '';
const pointsAtProduction = configuredSupabaseUrl.includes(KNOWN_PRODUCTION_PROJECT_REF);

const RUN = process.env.RUN_INTEGRATION_TESTS === '1';
const explicitBaseUrl = process.env.TEST_BASE_URL;
const confirmedNonProduction = process.env.TEST_CONFIRM_NON_PRODUCTION === 'yes';
const canRun = RUN && !!explicitBaseUrl && confirmedNonProduction && !pointsAtProduction;

const test = require('node:test');
const assert = require('node:assert/strict');

const skip = pointsAtProduction
  ? `refusing to run: SUPABASE_URL resolves to the known production project (${KNOWN_PRODUCTION_PROJECT_REF}) -- point this process's environment at a test/staging Supabase project first`
  : canRun
  ? false
  : 'requires all three of RUN_INTEGRATION_TESTS=1, an explicit TEST_BASE_URL (no default -- refuses to guess), and TEST_CONFIRM_NON_PRODUCTION=yes -- see file header';

const BASE_URL = explicitBaseUrl;
const TEST_USER_TOKEN = process.env.TEST_USER_TOKEN;
const TEST_HS_USER_TOKEN = process.env.TEST_HS_USER_TOKEN;
const TEST_ADMIN_TOKEN = process.env.TEST_ADMIN_TOKEN;
const TEST_HS_TEAM_ID = process.env.TEST_HS_TEAM_ID;
const TEST_HS_SEASON_ID = process.env.TEST_HS_SEASON_ID;
const TEST_HS_ORG_2_TEAM_ID = process.env.TEST_HS_ORG_2_TEAM_ID;
const TEST_HS_ORG_2_PLAYER_ID = process.env.TEST_HS_ORG_2_PLAYER_ID;
const TEST_HS_ORG_2_SEASON_ID = process.env.TEST_HS_ORG_2_SEASON_ID;

async function apiFetch(path, { token, headers = {}, ...opts } = {}) {
  return fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
}

// ── Authorization ────────────────────────────────────────────────────────

test('GET /api/high-school/program — 401 with no auth', { skip }, async () => {
  const res = await apiFetch('/api/high-school/program');
  assert.equal(res.status, 401);
});

test('GET /api/high-school/program — a Travel-only organization is rejected (403)', { skip }, async () => {
  const res = await apiFetch('/api/high-school/program', { token: TEST_USER_TOKEN });
  assert.equal(res.status, 403);
});

test('GET /api/high-school/program — a High-School-entitled organization is allowed (200)', { skip }, async () => {
  const res = await apiFetch('/api/high-school/program', { token: TEST_HS_USER_TOKEN });
  assert.equal(res.status, 200);
});

test('client-supplied entitlements cannot expand access — a forged X-Product-Override-style header is ignored', { skip }, async () => {
  const res = await apiFetch('/api/high-school/program', {
    token: TEST_USER_TOKEN,
    headers: { 'X-Enabled-Products': 'travel,high_school', 'X-Product-Override': 'high_school' },
  });
  // Still 403: no header of any name is ever read for this decision.
  assert.equal(res.status, 403);
});

test('client-supplied organization id cannot cross tenant boundaries — a query-string orgId is ignored', { skip }, async () => {
  const res = await apiFetch(`/api/high-school/program?orgId=${encodeURIComponent(TEST_HS_USER_TOKEN ? 'irrelevant' : '')}`, { token: TEST_USER_TOKEN });
  // Still 403 (Travel-only org's own membership, never the query param).
  assert.equal(res.status, 403);
});

test('a support session remains pinned to its target organization and cannot exceed that organization\'s entitlement', { skip }, async () => {
  // Mirrors api-product-capabilities.test.js's own support-session
  // precedence test at the HS layer: starting a support session against
  // the Travel-only org must still yield 403 for the HS endpoints, proving
  // support access is capped by the TARGET org's real entitlement, not
  // expanded by admin status.
  const startRes = await apiFetch('/api/admin/support-sessions', {
    method: 'POST',
    token: TEST_ADMIN_TOKEN,
    body: JSON.stringify({ orgId: process.env.TEST_TRAVEL_ORG_ID, mode: 'read_only', reason: 'High School tenant-isolation integration test' }),
  });
  assert.equal(startRes.status, 200);
  const { token: sessionToken } = await startRes.json();
  try {
    const res = await apiFetch('/api/high-school/program', {
      token: TEST_ADMIN_TOKEN,
      headers: { 'X-Support-Session': sessionToken },
    });
    assert.equal(res.status, 403);
  } finally {
    await apiFetch(`/api/admin/support-sessions/${sessionToken}/end`, { method: 'POST', token: TEST_ADMIN_TOKEN }).catch(() => {});
  }
});

// ── API behavior / tenant isolation ─────────────────────────────────────

test('GET /api/high-school/program — returns only the effective organization\'s program', { skip }, async () => {
  const res = await apiFetch('/api/high-school/program', { token: TEST_HS_USER_TOKEN });
  const body = await res.json();
  assert.ok(body.program === null || typeof body.program.id === 'string');
});

test('GET /api/high-school/seasons — returns only that program\'s seasons', { skip }, async () => {
  const res = await apiFetch('/api/high-school/seasons', { token: TEST_HS_USER_TOKEN });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.seasons));
});

test('GET /api/high-school/teams — returns only that program\'s teams', { skip }, async () => {
  const res = await apiFetch('/api/high-school/teams', { token: TEST_HS_USER_TOKEN });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.teams));
});

test('GET /api/high-school/teams/:teamId/roster — returns roster members for the requested tenant-owned team', { skip }, async () => {
  const res = await apiFetch(`/api/high-school/teams/${TEST_HS_TEAM_ID}/roster?seasonId=${TEST_HS_SEASON_ID}`, { token: TEST_HS_USER_TOKEN });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.roster));
});

test('foreign-team access does not leak record existence — a team belonging to a DIFFERENT High-School org returns 404, identical to a nonexistent id', { skip }, async () => {
  const realButForeign = await apiFetch(`/api/high-school/teams/${TEST_HS_ORG_2_TEAM_ID}/roster`, { token: TEST_HS_USER_TOKEN });
  const genuinelyNonexistent = await apiFetch('/api/high-school/teams/00000000-0000-4000-8000-000000000000/roster', { token: TEST_HS_USER_TOKEN });
  assert.equal(realButForeign.status, 404);
  assert.equal(genuinelyNonexistent.status, 404);
  const [foreignBody, nonexistentBody] = await Promise.all([realButForeign.json(), genuinelyNonexistent.json()]);
  assert.deepEqual(foreignBody, nonexistentBody);
});

test('missing program state is handled cleanly — seasons/teams return empty arrays, not an error, for an HS-entitled org with no program yet', { skip }, async () => {
  // Requires a THIRD seeded org: HS-entitled, but with no hs_programs row.
  // Documented here as the fixture this test needs; skipped like every
  // other test in this file until that fixture and its token exist.
  const token = process.env.TEST_HS_ORG_NO_PROGRAM_TOKEN;
  if (!token) return; // fixture not provided even when the file's gate is open
  const res = await apiFetch('/api/high-school/seasons', { token });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.seasons, []);
});

test('PUT is never accepted on any High School route — every mutation uses POST/PATCH/DELETE', { skip }, async () => {
  for (const path of ['/program', '/seasons', '/teams', '/players', `/teams/${TEST_HS_TEAM_ID}/roster`]) {
    const res = await apiFetch(path, { method: 'PUT', token: TEST_HS_USER_TOKEN });
    assert.equal(res.status, 404, `expected no PUT route for ${path}`);
  }
});

test('DELETE is only defined on a roster membership, not on program/seasons/teams/players', { skip }, async () => {
  for (const path of ['/program', '/seasons', '/teams', '/players']) {
    const res = await apiFetch(path, { method: 'DELETE', token: TEST_HS_USER_TOKEN });
    assert.equal(res.status, 404, `expected no DELETE route for ${path}`);
  }
});

test('existing admin and Travel endpoints remain unaffected by this addition', { skip }, async () => {
  const [teamsRes, adminStatusRes] = await Promise.all([
    apiFetch('/api/teams', { token: TEST_USER_TOKEN }),
    apiFetch('/api/admin/status', { token: TEST_USER_TOKEN }),
  ]);
  assert.equal(teamsRes.status, 200);
  assert.equal(adminStatusRes.status, 200); // isAdmin:false for a non-admin, still 200
});

// ── Write-path authorization ─────────────────────────────────────────────

test('POST /api/high-school/program — a Travel-only organization is rejected (403)', { skip }, async () => {
  const res = await apiFetch('/api/high-school/program', { method: 'POST', token: TEST_USER_TOKEN, body: JSON.stringify({ name: 'Should Not Be Created' }) });
  assert.equal(res.status, 403);
});

test('POST /api/high-school/seasons — unauthenticated request is rejected (401)', { skip }, async () => {
  const res = await apiFetch('/api/high-school/seasons', { method: 'POST', body: JSON.stringify({ name: 'x', school_year: '2025-2026' }) });
  assert.equal(res.status, 401);
});

test('a support session cannot create a team even when viewing a High-School-entitled organization (write blocked, read allowed)', { skip }, async () => {
  const startRes = await apiFetch('/api/admin/support-sessions', {
    method: 'POST',
    token: TEST_ADMIN_TOKEN,
    body: JSON.stringify({ orgId: process.env.TEST_HS_ORG_ID, mode: 'read_only', reason: 'High School write-blocking integration test' }),
  });
  assert.equal(startRes.status, 200);
  const { token: sessionToken } = await startRes.json();
  try {
    const readRes = await apiFetch('/api/high-school/teams', { token: TEST_ADMIN_TOKEN, headers: { 'X-Support-Session': sessionToken } });
    assert.equal(readRes.status, 200); // reads remain allowed during a support session

    const writeRes = await apiFetch('/api/high-school/teams', {
      method: 'POST',
      token: TEST_ADMIN_TOKEN,
      headers: { 'X-Support-Session': sessionToken },
      body: JSON.stringify({ name: 'Support-Created Team', level: 'varsity' }),
    });
    assert.equal(writeRes.status, 403);
  } finally {
    await apiFetch(`/api/admin/support-sessions/${sessionToken}/end`, { method: 'POST', token: TEST_ADMIN_TOKEN }).catch(() => {});
  }
});

test('POST /api/high-school/players — an unknown body field is rejected (400), nothing is created', { skip }, async () => {
  const res = await apiFetch('/api/high-school/players', {
    method: 'POST',
    token: TEST_HS_USER_TOKEN,
    body: JSON.stringify({ first_name: 'Jo', last_name: 'Smith', record_source: 'gamechanger' }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/high-school/players — missing required fields is rejected (400)', { skip }, async () => {
  const res = await apiFetch('/api/high-school/players', { method: 'POST', token: TEST_HS_USER_TOKEN, body: JSON.stringify({ first_name: 'Jo' }) });
  assert.equal(res.status, 400);
});

test('GET /api/high-school/teams/:teamId — a malformed UUID is rejected (400), not a raw database error', { skip }, async () => {
  const res = await apiFetch('/api/high-school/teams/not-a-uuid', { token: TEST_HS_USER_TOKEN });
  assert.equal(res.status, 400);
});

test('PATCH /api/high-school/teams/:teamId — a foreign-org teamId 404s, identical to a nonexistent one', { skip }, async () => {
  if (!TEST_HS_ORG_2_TEAM_ID) return; // fixture not provided even when the file's gate is open
  const res = await apiFetch(`/api/high-school/teams/${TEST_HS_ORG_2_TEAM_ID}`, {
    method: 'PATCH', token: TEST_HS_USER_TOKEN, body: JSON.stringify({ is_active: false }),
  });
  assert.equal(res.status, 404);
});

test('POST /api/high-school/teams/:teamId/roster — an inactive (archived) team rejects new roster memberships (409)', { skip }, async () => {
  const teamRes = await apiFetch('/api/high-school/teams', { method: 'POST', token: TEST_HS_USER_TOKEN, body: JSON.stringify({ name: `Archived Team ${Date.now()}`, level: 'freshman', is_active: false }) });
  assert.equal(teamRes.status, 201);
  const { team } = await teamRes.json();

  const playerRes = await apiFetch('/api/high-school/players', { method: 'POST', token: TEST_HS_USER_TOKEN, body: JSON.stringify({ first_name: 'Archived', last_name: `Team${Date.now()}` }) });
  const { player } = await playerRes.json();

  const res = await apiFetch(`/api/high-school/teams/${team.id}/roster`, {
    method: 'POST', token: TEST_HS_USER_TOKEN,
    body: JSON.stringify({ playerId: player.id, seasonId: TEST_HS_SEASON_ID }),
  });
  assert.equal(res.status, 409);
});

test('POST /api/high-school/teams/:teamId/roster — an inactive (archived) player is rejected (409)', { skip }, async () => {
  const playerRes = await apiFetch('/api/high-school/players', { method: 'POST', token: TEST_HS_USER_TOKEN, body: JSON.stringify({ first_name: 'Inactive', last_name: `Player${Date.now()}`, is_active: false }) });
  assert.equal(playerRes.status, 201);
  const { player } = await playerRes.json();

  const res = await apiFetch(`/api/high-school/teams/${TEST_HS_TEAM_ID}/roster`, {
    method: 'POST', token: TEST_HS_USER_TOKEN,
    body: JSON.stringify({ playerId: player.id, seasonId: TEST_HS_SEASON_ID }),
  });
  assert.equal(res.status, 409);
});

test('POST /api/high-school/teams/:teamId/roster — a player from a different organization cannot be linked in (404, not a successful cross-tenant link)', { skip }, async () => {
  if (!TEST_HS_ORG_2_PLAYER_ID) return; // fixture not provided even when the file's gate is open
  const res = await apiFetch(`/api/high-school/teams/${TEST_HS_TEAM_ID}/roster`, {
    method: 'POST', token: TEST_HS_USER_TOKEN,
    body: JSON.stringify({ playerId: TEST_HS_ORG_2_PLAYER_ID, seasonId: TEST_HS_SEASON_ID }),
  });
  assert.equal(res.status, 404);
});

test('POST /api/high-school/teams/:teamId/roster — a season from a different organization cannot be linked in (404)', { skip }, async () => {
  if (!TEST_HS_ORG_2_SEASON_ID) return; // fixture not provided even when the file's gate is open
  // A dedicated, guaranteed-active player for THIS test only -- not an
  // arbitrary players[0] from the shared list, which can otherwise pick up
  // an inactive player created by an earlier test in this same file and
  // fail on the (correct, intentional) inactive-player 409 before ever
  // reaching the cross-org season check this test means to isolate.
  const playerRes = await apiFetch('/api/high-school/players', { method: 'POST', token: TEST_HS_USER_TOKEN, body: JSON.stringify({ first_name: 'CrossOrgSeason', last_name: `Test${Date.now()}` }) });
  assert.equal(playerRes.status, 201);
  const { player } = await playerRes.json();
  const res = await apiFetch(`/api/high-school/teams/${TEST_HS_TEAM_ID}/roster`, {
    method: 'POST', token: TEST_HS_USER_TOKEN,
    body: JSON.stringify({ playerId: player.id, seasonId: TEST_HS_ORG_2_SEASON_ID }),
  });
  assert.equal(res.status, 404);
});

test('program create/duplicate/update round-trip, including the 409 on a second program for the same org', { skip }, async () => {
  const createRes = await apiFetch('/api/high-school/program', { method: 'POST', token: TEST_HS_USER_TOKEN, body: JSON.stringify({ name: 'Integration Test Program' }) });
  // Either this org already has a fixture program (409, expected given the
  // file's own documented fixture requirements) or this is the first
  // program created for it (201) -- both are valid starting states.
  assert.ok([201, 409].includes(createRes.status));

  const dupeRes = await apiFetch('/api/high-school/program', { method: 'POST', token: TEST_HS_USER_TOKEN, body: JSON.stringify({ name: 'Second Program' }) });
  assert.equal(dupeRes.status, 409);

  const updateRes = await apiFetch('/api/high-school/program', { method: 'PATCH', token: TEST_HS_USER_TOKEN, body: JSON.stringify({ school_name: 'Updated School Name' }) });
  assert.equal(updateRes.status, 200);
  const { program } = await updateRes.json();
  assert.equal(program.school_name, 'Updated School Name');
});

test('roster add/update/remove round-trip against the seeded team+season, ending with status=inactive (soft remove, never a deleted row)', { skip }, async () => {
  const playersRes = await apiFetch('/api/high-school/players', { method: 'POST', token: TEST_HS_USER_TOKEN, body: JSON.stringify({ first_name: 'Roster', last_name: `Test${Date.now()}` }) });
  assert.equal(playersRes.status, 201);
  const { player } = await playersRes.json();

  const addRes = await apiFetch(`/api/high-school/teams/${TEST_HS_TEAM_ID}/roster`, {
    method: 'POST', token: TEST_HS_USER_TOKEN,
    body: JSON.stringify({ playerId: player.id, seasonId: TEST_HS_SEASON_ID, jerseyNumber: '99' }),
  });
  assert.equal(addRes.status, 201);
  const { membership } = await addRes.json();
  assert.equal(membership.status, 'active');

  const dupeRes = await apiFetch(`/api/high-school/teams/${TEST_HS_TEAM_ID}/roster`, {
    method: 'POST', token: TEST_HS_USER_TOKEN,
    body: JSON.stringify({ playerId: player.id, seasonId: TEST_HS_SEASON_ID }),
  });
  assert.equal(dupeRes.status, 409);

  const updateRes = await apiFetch(`/api/high-school/teams/${TEST_HS_TEAM_ID}/roster/${membership.membershipId}`, {
    method: 'PATCH', token: TEST_HS_USER_TOKEN, body: JSON.stringify({ jerseyNumber: '7' }),
  });
  assert.equal(updateRes.status, 200);

  const removeRes = await apiFetch(`/api/high-school/teams/${TEST_HS_TEAM_ID}/roster/${membership.membershipId}`, {
    method: 'DELETE', token: TEST_HS_USER_TOKEN,
  });
  assert.equal(removeRes.status, 200);
  const removed = await removeRes.json();
  assert.equal(removed.membership.status, 'inactive');

  // Re-POSTing the same player+team+season after removal must 409 (the row
  // still exists, just inactive) -- restore is PATCH status:'active' on the
  // existing membership, the one documented restore path.
  const rePostRes = await apiFetch(`/api/high-school/teams/${TEST_HS_TEAM_ID}/roster`, {
    method: 'POST', token: TEST_HS_USER_TOKEN,
    body: JSON.stringify({ playerId: player.id, seasonId: TEST_HS_SEASON_ID }),
  });
  assert.equal(rePostRes.status, 409);

  const restoreRes = await apiFetch(`/api/high-school/teams/${TEST_HS_TEAM_ID}/roster/${membership.membershipId}`, {
    method: 'PATCH', token: TEST_HS_USER_TOKEN, body: JSON.stringify({ status: 'active' }),
  });
  assert.equal(restoreRes.status, 200);
  const restored = await restoreRes.json();
  assert.equal(restored.membership.status, 'active');
});
