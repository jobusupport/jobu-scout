'use strict';

// Playwright route-mock for /api/* used by test/high-school-ui.spec.js.
// Intercepts the REAL fetch() calls the shipped dashboard/index.html makes
// (apiFetch never goes through DESIGN_MODE's mockApiResponse in this
// harness -- DESIGN_MODE stays false, exactly as committed) and answers
// them with responses shaped exactly like src/high-school-api.js /
// src/high-school-roster-service.js's real contract: same routes, same
// request/response field casing (snake_case everywhere except roster
// memberships, which are camelCase), same status codes and error
// messages. This mock must never grow behavior the real server doesn't
// have -- if the real contract changes, this file must change with it,
// not the other way around.

let idCounter = 100;
function nextId() { return 'test-' + (++idCounter); }

function freshDb() {
  return {
    program: null, seasons: [], teams: [], players: [], roster: [],
    // GameChanger import mock state -- deliberately separate from the
    // Slice 1A CRUD state above. importRuns/collectionEnabled/publishedStats
    // are mutated directly by tests (not just through routes) so a test can
    // drive a run through review -> ready-to-publish -> published without
    // needing a real collector or Supabase behind it.
    importRuns: [],
    collectionEnabled: true,
    publishedStats: { verifiedTotals: null, playerAdvancedStats: [], pitcherAdvancedStats: [] },
  };
}

async function readJsonBody(route) {
  const data = route.request().postData();
  if (!data) return {};
  try { return JSON.parse(data); } catch (e) { return {}; }
}

function json(route, body, status) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

// Mirrors src/high-school-roster-service.js's rejectUnknownFields exactly
// (same allowlists, same 400 shape) -- without this, the mock would be
// MORE permissive than the real server, silently accepting a client
// request the real API would reject. The UI never actually sends an
// unlisted field (verified by direct code review during this PR's
// review), but this keeps that guarantee enforced by the mock itself
// rather than only by inspection, and lets a defense-in-depth test prove
// the server-side rejection is still what the client would see if that
// ever changed.
function unknownFieldError(body, allowedKeys) {
  const present = Object.keys(body || {});
  const unknown = present.filter((k) => !allowedKeys.includes(k));
  if (unknown.length > 0) {
    return { error: `Unknown field(s): ${unknown.join(', ')}` };
  }
  return null;
}

// capabilities: the GET /api/product/capabilities response this org should
// see. Pass enabledProducts without 'high_school' to simulate a
// Travel-only/unentitled org.
async function installHsApiMock(page, { capabilities, forbidden = false } = {}) {
  const db = freshDb();
  const caps = capabilities || {
    schemaVersion: 1,
    customerType: 'high_school',
    primaryProduct: 'high_school',
    enabledProducts: ['high_school'],
  };

  await page.route('**/api/product/capabilities', (route) => json(route, caps, 200));

  await page.route('**/api/high-school/**', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const method = route.request().method();

    if (forbidden) {
      return json(route, { error: 'This organization does not have High School access.' }, 403);
    }

    if (pathname === '/api/high-school/program') {
      if (method === 'GET') return json(route, { program: db.program }, 200);
      if (method === 'POST') {
        const body = await readJsonBody(route);
        const unknownErr = unknownFieldError(body, ['name', 'school_name']);
        if (unknownErr) return json(route, unknownErr, 400);
        if (db.program) return json(route, { error: 'A program already exists for this organization.' }, 409);
        if (!body.name || !String(body.name).trim()) {
          return json(route, { error: 'name is required and must be a non-empty string' }, 400);
        }
        db.program = { id: nextId(), name: body.name.trim(), school_name: body.school_name || null, is_active: true };
        return json(route, { program: db.program }, 201);
      }
      if (method === 'PATCH') {
        const body = await readJsonBody(route);
        const unknownErr = unknownFieldError(body, ['name', 'school_name', 'is_active']);
        if (unknownErr) return json(route, unknownErr, 400);
        if (!db.program) return json(route, { error: 'Program not found. Create one first.' }, 404);
        if (body.name !== undefined) db.program.name = body.name;
        if (body.school_name !== undefined) db.program.school_name = body.school_name;
        if (body.is_active !== undefined) db.program.is_active = body.is_active;
        return json(route, { program: db.program }, 200);
      }
    }

    if (pathname === '/api/high-school/seasons') {
      if (method === 'GET') return json(route, { seasons: db.seasons }, 200);
      if (method === 'POST') {
        const body = await readJsonBody(route);
        const unknownErr = unknownFieldError(body, ['name', 'school_year', 'start_date', 'end_date', 'is_current']);
        if (unknownErr) return json(route, unknownErr, 400);
        if (!db.program) return json(route, { error: 'Create a program before adding seasons.' }, 404);
        if (!body.name || !body.school_year) {
          return json(route, { error: 'name is required and must be a non-empty string' }, 400);
        }
        if (db.seasons.some((s) => s.name === body.name)) {
          return json(route, { error: 'A season with this name already exists for this program.' }, 409);
        }
        const season = {
          id: nextId(), name: body.name, school_year: body.school_year,
          start_date: body.start_date || null, end_date: body.end_date || null,
          is_current: !!body.is_current,
        };
        db.seasons.push(season);
        return json(route, { season }, 201);
      }
    }
    let m = pathname.match(/^\/api\/high-school\/seasons\/([^/]+)$/);
    if (m && method === 'PATCH') {
      const body = await readJsonBody(route);
      const unknownErr = unknownFieldError(body, ['name', 'school_year', 'start_date', 'end_date', 'is_current']);
      if (unknownErr) return json(route, unknownErr, 400);
      const season = db.seasons.find((s) => s.id === m[1]);
      if (!season) return json(route, { error: 'Season not found' }, 404);
      Object.assign(season, body);
      return json(route, { season }, 200);
    }

    if (pathname === '/api/high-school/teams') {
      if (method === 'GET') return json(route, { teams: db.teams }, 200);
      if (method === 'POST') {
        const body = await readJsonBody(route);
        const unknownErr = unknownFieldError(body, ['name', 'level', 'is_active']);
        if (unknownErr) return json(route, unknownErr, 400);
        if (!db.program) return json(route, { error: 'Create a program before adding teams.' }, 404);
        if (!body.name) return json(route, { error: 'name is required and must be a non-empty string' }, 400);
        if (db.teams.some((t) => t.name === body.name)) {
          return json(route, { error: 'A team with this name already exists for this program.' }, 409);
        }
        const team = { id: nextId(), name: body.name, level: body.level, is_active: body.is_active !== undefined ? body.is_active : true };
        db.teams.push(team);
        return json(route, { team }, 201);
      }
    }
    m = pathname.match(/^\/api\/high-school\/teams\/([^/]+)$/);
    if (m && method === 'PATCH') {
      const body = await readJsonBody(route);
      const unknownErr = unknownFieldError(body, ['name', 'level', 'is_active']);
      if (unknownErr) return json(route, unknownErr, 400);
      const team = db.teams.find((t) => t.id === m[1]);
      if (!team) return json(route, { error: 'Team not found' }, 404);
      Object.assign(team, body);
      return json(route, { team }, 200);
    }

    if (pathname === '/api/high-school/players') {
      if (method === 'GET') {
        const q = url.searchParams.get('q');
        let players = db.players;
        if (q) {
          const needle = q.toLowerCase();
          players = players.filter((p) =>
            p.first_name.toLowerCase().includes(needle) ||
            p.last_name.toLowerCase().includes(needle) ||
            (p.preferred_name || '').toLowerCase().includes(needle));
        }
        return json(route, { players }, 200);
      }
      if (method === 'POST') {
        const body = await readJsonBody(route);
        const unknownErr = unknownFieldError(body, ['first_name', 'last_name', 'preferred_name', 'graduation_year', 'is_active']);
        if (unknownErr) return json(route, unknownErr, 400);
        if (!db.program) return json(route, { error: 'Create a program before adding players.' }, 404);
        if (!body.first_name || !body.last_name) {
          return json(route, { error: 'first_name is required and must be a non-empty string' }, 400);
        }
        const player = {
          id: nextId(), first_name: body.first_name, last_name: body.last_name,
          preferred_name: body.preferred_name || null, graduation_year: body.graduation_year || null,
          is_active: body.is_active !== undefined ? body.is_active : true,
        };
        db.players.push(player);
        return json(route, { player }, 201);
      }
    }
    m = pathname.match(/^\/api\/high-school\/players\/([^/]+)$/);
    if (m && method === 'PATCH') {
      const body = await readJsonBody(route);
      const unknownErr = unknownFieldError(body, ['first_name', 'last_name', 'preferred_name', 'graduation_year', 'is_active']);
      if (unknownErr) return json(route, unknownErr, 400);
      const player = db.players.find((p) => p.id === m[1]);
      if (!player) return json(route, { error: 'Player not found' }, 404);
      Object.assign(player, body);
      return json(route, { player }, 200);
    }

    m = pathname.match(/^\/api\/high-school\/teams\/([^/]+)\/roster$/);
    if (m && method === 'GET') {
      const teamId = m[1];
      const seasonId = url.searchParams.get('seasonId');
      const roster = db.roster.filter((r) => r.teamId === teamId && (!seasonId || r.seasonId === seasonId));
      const withPlayer = roster.map((r) => ({
        membershipId: r.membershipId, jerseyNumber: r.jerseyNumber, status: r.status,
        player: db.players.find((p) => p.id === r.playerId) || null,
      }));
      return json(route, { roster: withPlayer }, 200);
    }
    if (m && method === 'POST') {
      const teamId = m[1];
      const body = await readJsonBody(route);
      const unknownErr = unknownFieldError(body, ['playerId', 'seasonId', 'jerseyNumber']);
      if (unknownErr) return json(route, unknownErr, 400);
      const team = db.teams.find((t) => t.id === teamId);
      if (!team) return json(route, { error: 'Team not found' }, 404);
      if (!team.is_active) return json(route, { error: 'Cannot add a roster membership to an inactive team.' }, 409);
      const player = db.players.find((p) => p.id === body.playerId);
      if (!player) return json(route, { error: 'Player not found' }, 404);
      if (!player.is_active) return json(route, { error: 'Cannot add an inactive player to a roster.' }, 409);
      if (db.roster.some((r) => r.teamId === teamId && r.seasonId === body.seasonId && r.playerId === body.playerId)) {
        return json(route, { error: 'This player is already on this team for this season.' }, 409);
      }
      const row = { membershipId: nextId(), teamId, seasonId: body.seasonId, playerId: body.playerId, jerseyNumber: body.jerseyNumber || null, status: 'active' };
      db.roster.push(row);
      return json(route, { membership: row }, 201);
    }
    m = pathname.match(/^\/api\/high-school\/teams\/([^/]+)\/roster\/([^/]+)$/);
    if (m && (method === 'PATCH' || method === 'DELETE')) {
      const row = db.roster.find((r) => r.teamId === m[1] && r.membershipId === m[2]);
      if (!row) return json(route, { error: 'Roster membership not found' }, 404);
      if (method === 'DELETE') { row.status = 'inactive'; return json(route, { membership: row }, 200); }
      const body = await readJsonBody(route);
      const unknownErr = unknownFieldError(body, ['jerseyNumber', 'status']);
      if (unknownErr) return json(route, unknownErr, 400);
      if (body.jerseyNumber !== undefined) row.jerseyNumber = body.jerseyNumber;
      if (body.status !== undefined) row.status = body.status;
      return json(route, { membership: row }, 200);
    }

    // ── GameChanger import mock surface (Slice 1A.2) -- matches
    // src/high-school-import-routes.js's real contract: same paths, same
    // status codes, same response field names. Kept in this same
    // catch-all so every existing test (which never touches these routes)
    // is completely unaffected.
    m = pathname.match(/^\/api\/high-school\/teams\/([^/]+)\/gc-source$/);
    if (m && method === 'PATCH') {
      const team = db.teams.find((t) => t.id === m[1]);
      if (!team) return json(route, { error: 'Team not found' }, 404);
      const body = await readJsonBody(route);
      if (!body.gcTeamUrl) return json(route, { error: 'gcTeamUrl is required' }, 400);
      if (!/^https:\/\/web\.gc\.com\/teams\/[^/]+\/[^/?#]+/i.test(body.gcTeamUrl)) {
        return json(route, { error: 'gcTeamUrl must be a GameChanger team URL (https://web.gc.com/teams/<org>/<team>).' }, 400);
      }
      const externalTeamId = body.gcTeamUrl.split('/').filter(Boolean).pop();
      const conflict = db.teams.find((t) => t.id !== team.id && t.gc_external_team_id === externalTeamId);
      if (conflict) return json(route, { error: 'This GameChanger team is already bound to another team in your organization.' }, 409);
      team.gc_team_url = body.gcTeamUrl.split(/[?#]/)[0];
      team.gc_external_team_id = externalTeamId;
      return json(route, { team }, 200);
    }

    m = pathname.match(/^\/api\/high-school\/teams\/([^/]+)\/seasons\/([^/]+)\/import-runs$/);
    if (m && method === 'GET') {
      const [, teamId, seasonId] = m;
      const runs = db.importRuns.filter((r) => r.team_id === teamId && r.season_id === seasonId);
      return json(route, { importRuns: runs, collectionEnabled: db.collectionEnabled }, 200);
    }
    if (m && method === 'POST') {
      const [, teamId, seasonId] = m;
      const team = db.teams.find((t) => t.id === teamId);
      if (!team?.gc_team_url) return json(route, { error: 'This team has no GameChanger source connected yet.' }, 400);
      if (!db.collectionEnabled) return json(route, { error: 'Automated GameChanger collection is currently disabled.' }, 503);
      const run = {
        id: nextId(), team_id: teamId, season_id: seasonId, status: 'running',
        games_discovered: null, games_processed: null, games_succeeded: null, games_failed: null,
        created_at: new Date().toISOString(),
        reconciliation: { matched: [], ambiguous: [], unmatched: [] },
        validations: [], publishable: false, games: [],
      };
      db.importRuns.unshift(run);
      return json(route, { importRun: run, jobId: nextId() }, 201);
    }

    m = pathname.match(/^\/api\/high-school\/teams\/([^/]+)\/seasons\/([^/]+)\/import-runs\/([^/]+)$/);
    if (m && method === 'GET') {
      const [, , , runId] = m;
      const run = db.importRuns.find((r) => r.id === runId);
      if (!run) return json(route, { error: 'Import run not found' }, 404);
      return json(route, {
        importRun: run,
        games: run.games || [],
        validations: run.validations || [],
        reconciliation: run.reconciliation || { matched: [], ambiguous: [], unmatched: [] },
        publishable: !!run.publishable,
        liveJob: run.liveJob || null,
      }, 200);
    }

    m = pathname.match(/^\/api\/high-school\/teams\/([^/]+)\/seasons\/([^/]+)\/import-runs\/([^/]+)\/cancel$/);
    if (m && method === 'POST') {
      const run = db.importRuns.find((r) => r.id === m[3]);
      if (!run || run.status !== 'running') return json(route, { error: 'This import is not currently running.' }, 409);
      run.status = 'failed';
      run.error_summary = 'Cancelled by user.';
      return json(route, { ok: true, stopped: true }, 200);
    }

    m = pathname.match(/^\/api\/high-school\/teams\/([^/]+)\/seasons\/([^/]+)\/import-runs\/([^/]+)\/retry$/);
    if (m && method === 'POST') {
      const [, teamId, seasonId, runId] = m;
      const prior = db.importRuns.find((r) => r.id === runId);
      if (!prior) return json(route, { error: 'Import run not found' }, 404);
      if (!['failed', 'partial'].includes(prior.status)) return json(route, { error: 'Only a failed or partial import run can be retried.' }, 409);
      if (!db.collectionEnabled) return json(route, { error: 'Automated GameChanger collection is currently disabled.' }, 503);
      const run = {
        id: nextId(), team_id: teamId, season_id: seasonId, status: 'running',
        games_discovered: null, games_processed: null, games_succeeded: null, games_failed: null,
        created_at: new Date().toISOString(),
        reconciliation: { matched: [], ambiguous: [], unmatched: [] },
        validations: [], publishable: false, games: [],
      };
      db.importRuns.unshift(run);
      return json(route, { importRun: run, jobId: nextId() }, 201);
    }

    m = pathname.match(/^\/api\/high-school\/teams\/([^/]+)\/seasons\/([^/]+)\/import-runs\/([^/]+)\/publish$/);
    if (m && method === 'POST') {
      const run = db.importRuns.find((r) => r.id === m[3]);
      if (!run) return json(route, { error: 'Import run not found' }, 404);
      if (run.status !== 'succeeded') return json(route, { error: 'Only a fully succeeded import run can be published.' }, 409);
      if (!run.publishable) return json(route, { error: 'This import is not ready to publish (validation issues remain unresolved).' }, 409);
      db.publishedStats = {
        verifiedTotals: { games: run.games_succeeded ?? run.games?.length ?? 0, confidence: 'high', updated_at: new Date().toISOString() },
        playerAdvancedStats: (run.reconciliation?.matched || []).map((p) => ({ playerId: p.playerId, k_pct: 18.2, bb_pct: 9.4 })),
        pitcherAdvancedStats: [],
      };
      return json(route, { verifiedTotals: db.publishedStats.verifiedTotals, publishedPlayers: (run.reconciliation?.matched || []).map((p) => ({ playerId: p.playerId, published: true })) }, 200);
    }

    m = pathname.match(/^\/api\/high-school\/teams\/([^/]+)\/seasons\/([^/]+)\/stats$/);
    if (m && method === 'GET') {
      return json(route, db.publishedStats, 200);
    }

    return json(route, { error: 'Not found (test mock)' }, 404);
  });

  return db;
}

// Logs the page in without a real backend: seeds localStorage with a
// session shape apiFetch() accepts (an accessToken), via an init script so
// it exists before the bundler's DOMContentLoaded unpack runs and before
// any app code reads it.
async function seedSession(page) {
  await page.addInitScript(() => {
    localStorage.setItem('vs_auth', JSON.stringify({
      accessToken: 'test-token',
      user: { email: 'coach@example.test' },
    }));
  });
}

async function seedSupportSession(page, overrides = {}) {
  await page.addInitScript((session) => {
    sessionStorage.setItem('jobuSupportSession', JSON.stringify(session));
  }, {
    token: 'test-support-token',
    orgId: 'test-org',
    orgName: 'Central High Athletics',
    expiresAt: Date.now() + 15 * 60000,
    sessionId: 'test-support-session',
    mode: 'read_only',
    ...overrides,
  });
}

module.exports = { installHsApiMock, seedSession, seedSupportSession };
