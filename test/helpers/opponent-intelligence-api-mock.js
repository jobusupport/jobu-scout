'use strict';

// Playwright route-mock for /api/teams and /api/opponent-intelligence/* used
// by test/opponent-intelligence-ui.spec.js. Mirrors test/helpers/hs-api-mock.js's
// established convention exactly: intercepts the REAL fetch() calls the
// shipped dashboard/index.html makes (DESIGN_MODE stays false; nothing here
// exercises the DESIGN_MODE/mockApiResponse() convenience path), answering
// with responses shaped exactly like src/opponent-intelligence-api.js /
// src/opponent-roster-service.js / src/coach-notes-service.js's real
// contract: same routes, same field names, same status codes and error
// messages. This mock must never grow behavior the real server doesn't
// have -- if the real contract changes, this file must change with it.

let idCounter = 200;
function nextId() { return 'test-opp-' + (++idCounter); }

const OPPONENT_PLAYER_STATUSES = ['active', 'graduated', 'transferred', 'not_participating', 'other_non_returning'];
const CONFIRMABLE_FIELDS = ['first_name', 'last_name', 'positions', 'bats', 'throws', 'class_or_grad_year'];
const NOTE_TEXT_MAX_LENGTH = 4000;

function freshDb(teams) {
  return {
    teams: teams || [],
    players: [],
    memberships: [],
    conflicts: [],
    notes: [],
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

function unknownFieldError(body, allowedKeys) {
  const present = Object.keys(body || {});
  const unknown = present.filter((k) => !allowedKeys.includes(k));
  if (unknown.length > 0) return { error: `Unknown field(s): ${unknown.join(', ')}` };
  return null;
}

function rosterViewOf(db, player) {
  const activeMemberships = db.memberships.filter((m) => m.opponent_player_id === player.id && m.status === 'active');
  const membership = activeMemberships.sort((a, b) => (b.last_observed_at || '').localeCompare(a.last_observed_at || ''))[0] || null;
  return { ...player, membership };
}

// teams: array of { id, team_name, is_our_team, gc_team_url, game_count,
// hasGC, hasPG, stats: { wins, losses } } -- shaped like the real GET
// /api/teams response (see server.js's app.get('/api/teams', ...)).
async function installOppApiMock(page, { capabilities, teams, forbidden = false } = {}) {
  const db = freshDb(teams);
  const caps = capabilities || {
    schemaVersion: 1, customerType: 'travel', primaryProduct: 'travel', enabledProducts: ['travel'],
  };

  await page.route('**/api/product/capabilities', (route) => json(route, caps, 200));
  await page.route('**/api/teams', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return json(route, db.teams, 200);
  });
  await page.route('**/api/reports', (route) => json(route, [], 200));

  await page.route('**/api/opponent-intelligence/**', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const method = route.request().method();

    if (forbidden) {
      return json(route, { error: 'This organization does not have Travel access.' }, 403);
    }

    let m = pathname.match(/^\/api\/opponent-intelligence\/teams\/([^/]+)\/roster$/);
    if (m && method === 'GET') {
      const teamId = m[1];
      const roster = db.players.filter((p) => p.team_id === teamId).map((p) => rosterViewOf(db, p));
      return json(route, { roster }, 200);
    }

    m = pathname.match(/^\/api\/opponent-intelligence\/teams\/([^/]+)\/players$/);
    if (m && method === 'POST') {
      const teamId = m[1];
      const body = await readJsonBody(route);
      const unknownErr = unknownFieldError(body, ['first_name', 'last_name', 'positions', 'bats', 'throws', 'class_or_grad_year', 'status']);
      if (unknownErr) return json(route, unknownErr, 400);
      if (!body.first_name || !String(body.first_name).trim()) return json(route, { error: 'first_name is required and must be a non-empty string' }, 400);
      if (!body.last_name || !String(body.last_name).trim()) return json(route, { error: 'last_name is required and must be a non-empty string' }, 400);
      if (body.status !== undefined && !OPPONENT_PLAYER_STATUSES.includes(body.status)) {
        return json(route, { error: `status must be one of: ${OPPONENT_PLAYER_STATUSES.join(', ')}` }, 400);
      }
      const player = {
        id: nextId(), team_id: teamId,
        first_name: body.first_name.trim(), last_name: body.last_name.trim(),
        positions: body.positions || [], bats: body.bats || null, throws: body.throws || null,
        class_or_grad_year: body.class_or_grad_year || null, status: body.status || 'active',
        record_source: 'manual', confirmed_fields: [], last_observed_at: new Date().toISOString(),
      };
      db.players.push(player);
      return json(route, { player }, 201);
    }

    m = pathname.match(/^\/api\/opponent-intelligence\/players\/([^/]+)$/);
    if (m && method === 'PATCH') {
      const playerId = m[1];
      const body = await readJsonBody(route);
      const unknownErr = unknownFieldError(body, ['first_name', 'last_name', 'positions', 'bats', 'throws', 'class_or_grad_year', 'status']);
      if (unknownErr) return json(route, unknownErr, 400);
      const player = db.players.find((p) => p.id === playerId);
      if (!player) return json(route, { error: 'Opponent player not found' }, 404);
      if (body.status !== undefined && !OPPONENT_PLAYER_STATUSES.includes(body.status)) {
        return json(route, { error: `status must be one of: ${OPPONENT_PLAYER_STATUSES.join(', ')}` }, 400);
      }
      const newlyConfirmed = Object.keys(body).filter((k) => CONFIRMABLE_FIELDS.includes(k));
      player.confirmed_fields = Array.from(new Set([...(player.confirmed_fields || []), ...newlyConfirmed]));
      Object.assign(player, body);
      return json(route, { player }, 200);
    }

    // Mirrors src/opponent-roster-service.js's loadAndValidateMergePair
    // exactly: both players must exist in this org AND belong to the
    // team named in the URL, or the request 400/404s -- shared by both
    // the preview and the actual merge below, matching the real
    // contract's own "the merge never trusts a previously returned
    // preview" guarantee (each route call here re-validates from db.players
    // fresh, never from anything the other route returned).
    function validateMergePair(teamId, keepPlayerId, mergePlayerId) {
      if (!keepPlayerId || !mergePlayerId) return { error: json(route, { error: 'keepPlayerId and mergePlayerId are required' }, 400) };
      if (keepPlayerId === mergePlayerId) return { error: json(route, { error: 'keepPlayerId and mergePlayerId must be different players.' }, 400) };
      const keepPlayer = db.players.find((p) => p.id === keepPlayerId);
      const mergePlayer = db.players.find((p) => p.id === mergePlayerId);
      if (!keepPlayer) return { error: json(route, { error: 'keepPlayerId player not found' }, 404) };
      if (!mergePlayer) return { error: json(route, { error: 'mergePlayerId player not found' }, 404) };
      if (keepPlayer.team_id !== teamId || mergePlayer.team_id !== teamId) {
        return { error: json(route, { error: 'Both players must belong to the selected opponent team.' }, 400) };
      }
      return { keepPlayer, mergePlayer };
    }

    m = pathname.match(/^\/api\/opponent-intelligence\/teams\/([^/]+)\/merge-preview$/);
    if (m && method === 'GET') {
      const teamId = m[1];
      const keepPlayerId = url.searchParams.get('keepPlayerId');
      const mergePlayerId = url.searchParams.get('mergePlayerId');
      const result = validateMergePair(teamId, keepPlayerId, mergePlayerId);
      if (result.error) return result.error;
      const { keepPlayer, mergePlayer } = result;
      const membershipCount = db.memberships.filter((mm) => mm.opponent_player_id === mergePlayer.id).length;
      const noteCount = db.notes.filter((n) => n.opponent_player_id === mergePlayer.id).length;
      return json(route, {
        survivor: { id: keepPlayer.id, first_name: keepPlayer.first_name, last_name: keepPlayer.last_name },
        duplicate: { id: mergePlayer.id, first_name: mergePlayer.first_name, last_name: mergePlayer.last_name },
        membershipCount, noteCount,
      }, 200);
    }

    m = pathname.match(/^\/api\/opponent-intelligence\/teams\/([^/]+)\/merge$/);
    if (m && method === 'POST') {
      const teamId = m[1];
      const body = await readJsonBody(route);
      const result = validateMergePair(teamId, body.keepPlayerId, body.mergePlayerId);
      if (result.error) return result.error;
      const { keepPlayer, mergePlayer } = result;
      db.memberships.forEach((mem) => { if (mem.opponent_player_id === mergePlayer.id) mem.opponent_player_id = keepPlayer.id; });
      db.notes.forEach((n) => { if (n.opponent_player_id === mergePlayer.id) n.opponent_player_id = keepPlayer.id; });
      keepPlayer.confirmed_fields = Array.from(new Set([...(keepPlayer.confirmed_fields || []), ...(mergePlayer.confirmed_fields || [])]));
      db.players = db.players.filter((p) => p.id !== mergePlayer.id);
      return json(route, { player: rosterViewOf(db, keepPlayer) }, 200);
    }

    m = pathname.match(/^\/api\/opponent-intelligence\/players\/([^/]+)\/memberships$/);
    if (m && method === 'POST') {
      const playerId = m[1];
      const body = await readJsonBody(route);
      const unknownErr = unknownFieldError(body, ['teamId', 'jersey_number', 'season_label']);
      if (unknownErr) return json(route, unknownErr, 400);
      const player = db.players.find((p) => p.id === playerId);
      if (!player) return json(route, { error: 'Opponent player not found' }, 404);
      const today = new Date().toISOString().slice(0, 10);
      const membership = {
        id: nextId(), opponent_player_id: playerId, team_id: body.teamId,
        jersey_number: body.jersey_number || null, season_label: body.season_label || null,
        status: 'active', first_observed_at: today, last_observed_at: today,
      };
      db.memberships.push(membership);
      return json(route, { membership }, 201);
    }

    m = pathname.match(/^\/api\/opponent-intelligence\/memberships\/([^/]+)$/);
    if (m && method === 'PATCH') {
      const membership = db.memberships.find((mm) => mm.id === m[1]);
      if (!membership) return json(route, { error: 'Roster membership not found' }, 404);
      const body = await readJsonBody(route);
      const unknownErr = unknownFieldError(body, ['jersey_number', 'season_label', 'status']);
      if (unknownErr) return json(route, unknownErr, 400);
      if (Object.keys(body).length === 0) return json(route, { error: 'At least one field must be provided.' }, 400);
      Object.assign(membership, body);
      return json(route, { membership }, 200);
    }
    if (m && method === 'DELETE') {
      const membership = db.memberships.find((mm) => mm.id === m[1]);
      if (!membership) return json(route, { error: 'Roster membership not found' }, 404);
      membership.status = 'inactive';
      return json(route, { membership }, 200);
    }

    m = pathname.match(/^\/api\/opponent-intelligence\/players\/([^/]+)\/conflicts$/);
    if (m && method === 'GET') {
      const conflicts = db.conflicts.filter((c) => c.opponent_player_id === m[1] && !c.resolved_at);
      return json(route, { conflicts }, 200);
    }

    m = pathname.match(/^\/api\/opponent-intelligence\/conflicts\/([^/]+)\/resolve$/);
    if (m && method === 'POST') {
      const conflict = db.conflicts.find((c) => c.id === m[1]);
      if (!conflict) return json(route, { error: 'Something went wrong. Please try again.' }, 500);
      const body = await readJsonBody(route);
      if (!['kept_coach_value', 'accepted_import_value'].includes(body.resolution)) {
        return json(route, { error: 'resolution is required.' }, 400);
      }
      conflict.resolved_at = new Date().toISOString();
      conflict.resolution = body.resolution;
      return json(route, { conflict }, 200);
    }

    m = pathname.match(/^\/api\/opponent-intelligence\/teams\/([^/]+)\/notes$/);
    if (m && method === 'GET') {
      const teamId = m[1];
      const includeArchived = url.searchParams.get('includeArchived') === 'true';
      let notes = db.notes.filter((n) => n.opponent_team_id === teamId);
      if (!includeArchived) notes = notes.filter((n) => !n.is_archived);
      return json(route, { notes }, 200);
    }
    if (m && method === 'POST') {
      const teamId = m[1];
      const body = await readJsonBody(route);
      const unknownErr = unknownFieldError(body, ['opponent_player_id', 'game_id', 'observed_game_date', 'note_text', 'category']);
      if (unknownErr) return json(route, unknownErr, 400);
      const text = typeof body.note_text === 'string' ? body.note_text.trim() : '';
      if (!text) return json(route, { error: 'note_text is required and must be a non-empty string' }, 400);
      if (text.length > NOTE_TEXT_MAX_LENGTH) return json(route, { error: `note_text must be ${NOTE_TEXT_MAX_LENGTH} characters or fewer` }, 400);
      if (body.opponent_player_id) {
        const referencedPlayer = db.players.find((p) => p.id === body.opponent_player_id);
        if (!referencedPlayer || referencedPlayer.team_id !== teamId) {
          return json(route, { error: 'opponent_player_id must belong to the selected opponent team.' }, 400);
        }
      }
      const note = {
        id: nextId(), org_id: 'test-org', author_user_id: 'test-user-1',
        opponent_team_id: teamId, opponent_player_id: body.opponent_player_id || null,
        game_id: body.game_id || null, observed_game_date: body.observed_game_date || null,
        note_text: text, category: body.category || null,
        include_in_report: true, is_archived: false,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      db.notes.push(note);
      return json(route, { note }, 201);
    }

    m = pathname.match(/^\/api\/opponent-intelligence\/notes\/([^/]+)$/);
    if (m && method === 'PATCH') {
      const note = db.notes.find((n) => n.id === m[1]);
      if (!note) return json(route, { error: 'Note not found' }, 404);
      if (note.is_archived) return json(route, { error: 'Cannot edit an archived note.' }, 409);
      const body = await readJsonBody(route);
      const unknownErr = unknownFieldError(body, ['note_text', 'category', 'include_in_report']);
      if (unknownErr) return json(route, unknownErr, 400);
      if (body.note_text !== undefined) {
        const text = typeof body.note_text === 'string' ? body.note_text.trim() : '';
        if (!text) return json(route, { error: 'note_text is required and must be a non-empty string' }, 400);
        if (text.length > NOTE_TEXT_MAX_LENGTH) return json(route, { error: `note_text must be ${NOTE_TEXT_MAX_LENGTH} characters or fewer` }, 400);
        note.note_text = text;
      }
      if (body.category !== undefined) note.category = body.category;
      if (body.include_in_report !== undefined) note.include_in_report = body.include_in_report;
      note.updated_at = new Date().toISOString();
      return json(route, { note }, 200);
    }

    m = pathname.match(/^\/api\/opponent-intelligence\/notes\/([^/]+)\/archive$/);
    if (m && method === 'POST') {
      const note = db.notes.find((n) => n.id === m[1]);
      if (!note) return json(route, { error: 'Note not found' }, 404);
      note.is_archived = true;
      note.updated_at = new Date().toISOString();
      return json(route, { note }, 200);
    }

    m = pathname.match(/^\/api\/opponent-intelligence\/notes\/([^/]+)\/include$/);
    if (m && method === 'PATCH') {
      const note = db.notes.find((n) => n.id === m[1]);
      if (!note) return json(route, { error: 'Note not found' }, 404);
      const body = await readJsonBody(route);
      if (typeof body.include !== 'boolean') return json(route, { error: 'include must be a boolean' }, 400);
      note.include_in_report = body.include;
      note.updated_at = new Date().toISOString();
      return json(route, { note }, 200);
    }

    m = pathname.match(/^\/api\/opponent-intelligence\/teams\/([^/]+)\/report-context-preview$/);
    if (m && method === 'GET') {
      const teamId = m[1];
      const roster = db.players.filter((p) => p.team_id === teamId);
      const notes = db.notes.filter((n) => n.opponent_team_id === teamId && !n.is_archived);
      const included = notes.filter((n) => n.include_in_report);
      return json(route, {
        counts: { rosterIncluded: roster.length, notesIncluded: included.length },
        // Tests can set db.forcedTruncated = { rosterOmitted, notesOmitted }
        // to exercise the "older context omitted" indicator without needing
        // 60+ synthetic notes or 100+ synthetic players.
        truncated: db.forcedTruncated || { rosterOmitted: 0, notesOmitted: 0 },
      }, 200);
    }

    return json(route, { error: 'Not found (test mock)' }, 404);
  });

  return db;
}

// Logs the page in without a real backend -- identical convention to
// test/helpers/hs-api-mock.js#seedSession (same localStorage key/shape).
async function seedSession(page) {
  await page.addInitScript(() => {
    localStorage.setItem('vs_auth', JSON.stringify({
      accessToken: 'test-token',
      user: { id: 'test-user-1', email: 'coach@example.test' },
    }));
  });
}

function makeOpponentTeam(overrides = {}) {
  return {
    id: nextId(), team_name: 'Test Opponents', is_our_team: false,
    gc_team_url: null, game_count: 5, hasGC: true, hasPG: false,
    stats: { wins: 3, losses: 2 },
    ...overrides,
  };
}

module.exports = { installOppApiMock, seedSession, makeOpponentTeam, nextId };
