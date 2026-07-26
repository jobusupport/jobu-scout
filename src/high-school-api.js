'use strict';

// High School domain API. Mounted at /api/high-school in server.js. Every
// route requires requireAuth -> resolveSupportSession -> requireHighSchoolAccess,
// in that order -- identical middleware ordering to GET /api/product/capabilities
// in server.js, so a support session viewing a High-School-entitled customer
// sees that customer's own HS records, and a support session viewing a
// Travel-only customer is denied exactly like any other unentitled
// organization. Every route that writes additionally runs
// blockWriteDuringReadOnlySupport immediately after resolveSupportSession,
// so an active (today, always read_only) support session can view a
// customer's High School data but can never mutate it.
//
// Covers the program/seasons/teams/players/roster-membership CRUD
// foundation for a later roster-management UI and GameChanger importer.
// Write-side validation and orchestration lives in
// src/high-school-roster-service.js (database-free unit-testable, the same
// separation src/admin-product-route.js already established for
// PATCH /api/admin/customers/:orgId/product) -- route handlers below stay
// thin Express adapters over that module, exactly like admin-api.js's own
// relationship to admin-product-route.js.
//
// No route ever accepts org_id, program_id, or any other parent scope from
// the client as something to trust -- the effective org always comes from
// req._orgId (requireHighSchoolAccess), and every parent record (program,
// team, season, player) referenced by a write is independently re-fetched
// scoped to that org before use, so a foreign-org id can never be linked in,
// regardless of what a caller supplies.
//
// Follows src/admin-api.js's factory pattern: requireAuth is injected
// (owned by server.js, so JWT verification logic isn't duplicated);
// everything else standalone-importable is required directly.

const express = require('express');
const { adminClient } = require('./supabase');
const { resolveSupportSession, blockWriteDuringReadOnlySupport } = require('./admin-lib');
const { getOrganizationCapabilities } = require('./product-capabilities');
const { resolveTrustedOrgId, buildAcceptedMembershipsQuery, mapErrorToResponse } = require('./org-resolution');
const { asyncHandler } = require('./express-helpers');
const rosterService = require('./high-school-roster-service');

// Same tolerance rule server.js's own isMissingRelationError/selectSafe/
// maybeSingleSafe apply to every other org-scoped query in this codebase
// (a missing table/column reads as "no rows" rather than a hard error) --
// reimplemented locally, scoped only to this module's own queries, rather
// than importing server.js's private helpers (server.js exports nothing;
// duplicating ~15 lines here is safer than restructuring server.js's
// existing, already-working Travel query helpers to export them).
function isMissingRelationError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  const code = String(err?.code || '').toUpperCase();
  return (
    (msg.includes('relation') && msg.includes('does not exist')) ||
    msg.includes('could not find the table') ||
    (msg.includes('column') && msg.includes('does not exist')) ||
    (msg.includes('could not find') && msg.includes('column')) ||
    code === '42703' ||
    code === 'PGRST204' ||
    msg.includes('schema cache')
  );
}

async function maybeSingleSafe(query) {
  try {
    const { data, error } = await query.maybeSingle();
    if (error) {
      if (isMissingRelationError(error)) return null;
      throw error;
    }
    return data || null;
  } catch (err) {
    if (isMissingRelationError(err)) return null;
    throw err;
  }
}

async function selectSafe(query) {
  try {
    const { data, error } = await query;
    if (error) {
      if (isMissingRelationError(error)) return [];
      throw error;
    }
    return data || [];
  } catch (err) {
    if (isMissingRelationError(err)) return [];
    throw err;
  }
}

async function getRequestOrgId(req) {
  const orgId = await resolveTrustedOrgId(req, {
    lookupAcceptedMemberships: (userId) =>
      selectSafe(buildAcceptedMembershipsQuery(adminClient, userId)),
  });
  req._orgId = orgId;
  return orgId;
}

function sendResolverError(res, err, context) {
  console.error(`[${context}]`, err);
  const { statusCode, message } = mapErrorToResponse(err);
  return res.status(statusCode).json({ error: message });
}

// ── High School domain authorization guard ───────────────────────────────
// Split into a pure decision function (hasHighSchoolEntitlement, unit
// tested exhaustively without a database) and the I/O wrapper around it,
// the same separation src/product-capabilities.js already uses between
// resolveOrganizationCapabilities (pure) and getOrganizationCapabilities
// (I/O). hasHighSchoolEntitlement trusts only the capabilities object it's
// given -- it has no access to a request, so there is nothing
// client-controlled to expand entitlements with; a non-array or missing
// enabledProducts fails closed to false, never true.
function hasHighSchoolEntitlement(capabilities) {
  return Array.isArray(capabilities?.enabledProducts) && capabilities.enabledProducts.includes('high_school');
}

// Reusable by every route below (and any future High School route). Never
// reads req.body/req.query for organization ownership or entitlements --
// the effective org comes only from getRequestOrgId (which itself trusts
// only req._orgId, already set by resolveSupportSession for a support
// view, or an authoritative org_members row), and entitlements come only
// from getOrganizationCapabilities's own database read. A Travel-only org
// receives the identical 403 shape a nonexistent-org lookup failure would
// produce -- this never reveals whether an organization exists or what
// its actual configuration is.
async function requireHighSchoolAccess(req, res, next) {
  try {
    const orgId = await getRequestOrgId(req);
    const capabilities = await getOrganizationCapabilities(orgId);
    if (!hasHighSchoolEntitlement(capabilities)) {
      return res.status(403).json({ error: 'This organization does not have High School access.' });
    }
    req._orgId = orgId;
    next();
  } catch (err) {
    return sendResolverError(res, err, 'requireHighSchoolAccess');
  }
}

async function getHsProgram(orgId) {
  return maybeSingleSafe(
    adminClient.from('hs_programs')
      .select('id, name, school_name, is_active')
      .eq('org_id', orgId)
      .limit(1)
  );
}

module.exports = function createHighSchoolRouter({ requireAuth }) {
  const router = express.Router();

  // ── Program ──────────────────────────────────────────────────────────

  router.get('/program', requireAuth, resolveSupportSession, requireHighSchoolAccess, asyncHandler(async (req, res) => {
    try {
      const program = await getHsProgram(req._orgId);
      // No program configured yet is a clean, valid empty state -- not an
      // error -- since HS entitlement and HS program provisioning are
      // separate steps (an org can be HS-entitled before its program
      // record exists).
      res.json({ program: program || null });
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/program');
    }
  }));

  router.post('/program', requireAuth, resolveSupportSession, requireHighSchoolAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const program = await rosterService.createProgram({ orgId: req._orgId, body: req.body, adminClient });
      res.status(201).json({ program });
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/program (create)');
    }
  }));

  router.patch('/program', requireAuth, resolveSupportSession, requireHighSchoolAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const program = await rosterService.updateProgram({ orgId: req._orgId, body: req.body, adminClient, getProgram: getHsProgram });
      res.json({ program });
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/program (update)');
    }
  }));

  // ── Seasons ──────────────────────────────────────────────────────────

  router.get('/seasons', requireAuth, resolveSupportSession, requireHighSchoolAccess, asyncHandler(async (req, res) => {
    try {
      const program = await getHsProgram(req._orgId);
      if (!program) return res.json({ seasons: [] });
      const seasons = await selectSafe(
        adminClient.from('hs_seasons')
          .select('id, name, school_year, start_date, end_date, is_current')
          .eq('org_id', req._orgId)
          .eq('program_id', program.id)
          .order('start_date', { ascending: false })
      );
      res.json({ seasons });
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/seasons');
    }
  }));

  router.get('/seasons/:seasonId', requireAuth, resolveSupportSession, requireHighSchoolAccess, asyncHandler(async (req, res) => {
    try {
      const season = await rosterService.getSeasonInOrg({ orgId: req._orgId, seasonId: req.params.seasonId, adminClient });
      if (!season) return res.status(404).json({ error: 'Season not found' });
      res.json({ season });
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/seasons/:seasonId');
    }
  }));

  router.post('/seasons', requireAuth, resolveSupportSession, requireHighSchoolAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const season = await rosterService.createSeason({ orgId: req._orgId, body: req.body, adminClient, getProgram: getHsProgram });
      res.status(201).json({ season });
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/seasons (create)');
    }
  }));

  router.patch('/seasons/:seasonId', requireAuth, resolveSupportSession, requireHighSchoolAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const season = await rosterService.updateSeason({ orgId: req._orgId, seasonId: req.params.seasonId, body: req.body, adminClient });
      res.json({ season });
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/seasons/:seasonId (update)');
    }
  }));

  // ── Teams ────────────────────────────────────────────────────────────

  router.get('/teams', requireAuth, resolveSupportSession, requireHighSchoolAccess, asyncHandler(async (req, res) => {
    try {
      const program = await getHsProgram(req._orgId);
      if (!program) return res.json({ teams: [] });
      const teams = await selectSafe(
        adminClient.from('hs_teams')
          .select('id, level, name, is_active')
          .eq('org_id', req._orgId)
          .eq('program_id', program.id)
          .order('name')
      );
      res.json({ teams });
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/teams');
    }
  }));

  router.get('/teams/:teamId', requireAuth, resolveSupportSession, requireHighSchoolAccess, asyncHandler(async (req, res) => {
    try {
      const team = await rosterService.getTeamInOrg({ orgId: req._orgId, teamId: req.params.teamId, adminClient });
      if (!team) return res.status(404).json({ error: 'Team not found' });
      res.json({ team });
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/teams/:teamId');
    }
  }));

  router.post('/teams', requireAuth, resolveSupportSession, requireHighSchoolAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const team = await rosterService.createTeam({ orgId: req._orgId, body: req.body, adminClient, getProgram: getHsProgram });
      res.status(201).json({ team });
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/teams (create)');
    }
  }));

  router.patch('/teams/:teamId', requireAuth, resolveSupportSession, requireHighSchoolAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const team = await rosterService.updateTeam({ orgId: req._orgId, teamId: req.params.teamId, body: req.body, adminClient });
      res.json({ team });
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/teams/:teamId (update)');
    }
  }));

  // ── Players ──────────────────────────────────────────────────────────
  // GET /players?q=<search> -- q is optional free-text, matched against
  // first/last/preferred name via a safely-escaped ilike (see
  // rosterService.listPlayers / escapeIlike). No pagination, matching the
  // existing HS list routes' own precedent (org-scoped row counts are
  // expected to be small).

  router.get('/players', requireAuth, resolveSupportSession, requireHighSchoolAccess, asyncHandler(async (req, res) => {
    try {
      const players = await rosterService.listPlayers({ orgId: req._orgId, search: req.query.q, adminClient });
      res.json({ players });
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/players');
    }
  }));

  router.get('/players/:playerId', requireAuth, resolveSupportSession, requireHighSchoolAccess, asyncHandler(async (req, res) => {
    try {
      const player = await rosterService.getPlayerInOrg({ orgId: req._orgId, playerId: req.params.playerId, adminClient });
      if (!player) return res.status(404).json({ error: 'Player not found' });
      res.json({ player });
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/players/:playerId');
    }
  }));

  router.post('/players', requireAuth, resolveSupportSession, requireHighSchoolAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const player = await rosterService.createPlayer({ orgId: req._orgId, body: req.body, adminClient, getProgram: getHsProgram });
      res.status(201).json({ player });
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/players (create)');
    }
  }));

  router.patch('/players/:playerId', requireAuth, resolveSupportSession, requireHighSchoolAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const player = await rosterService.updatePlayer({ orgId: req._orgId, playerId: req.params.playerId, body: req.body, adminClient });
      res.json({ player });
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/players/:playerId (update)');
    }
  }));

  // ── Roster ───────────────────────────────────────────────────────────
  // GET /teams/:teamId/roster?seasonId=<uuid> -- seasonId is optional,
  // defaulting to the program's current season (is_current = true) when
  // omitted. Every lookup filters by BOTH the requested ID and the
  // effective org_id (the same "existence + ownership" pattern
  // server.js's own assertTeamInRequestOrg already uses for Travel teams),
  // so a foreign-org teamId or seasonId returns the identical 404 a
  // nonexistent one would -- record existence for another tenant is never
  // revealed.
  router.get('/teams/:teamId/roster', requireAuth, resolveSupportSession, requireHighSchoolAccess, asyncHandler(async (req, res) => {
    try {
      const team = await maybeSingleSafe(
        adminClient.from('hs_teams').select('id').eq('id', req.params.teamId).eq('org_id', req._orgId).limit(1)
      );
      if (!team) return res.status(404).json({ error: 'Team not found' });

      let seasonId = req.query.seasonId || null;
      if (seasonId) {
        const season = await maybeSingleSafe(
          adminClient.from('hs_seasons').select('id').eq('id', seasonId).eq('org_id', req._orgId).limit(1)
        );
        if (!season) return res.status(404).json({ error: 'Season not found' });
      } else {
        const currentSeason = await maybeSingleSafe(
          adminClient.from('hs_seasons').select('id').eq('org_id', req._orgId).eq('is_current', true).limit(1)
        );
        seasonId = currentSeason?.id || null;
      }

      if (!seasonId) return res.json({ roster: [] });

      const memberships = await selectSafe(
        adminClient.from('hs_roster_memberships')
          .select('id, jersey_number, status, player_id')
          .eq('org_id', req._orgId)
          .eq('team_id', team.id)
          .eq('season_id', seasonId)
      );
      if (!memberships.length) return res.json({ roster: [] });

      const playerIds = memberships.map(m => m.player_id);
      const players = await selectSafe(
        adminClient.from('hs_players')
          .select('id, first_name, last_name, preferred_name, graduation_year')
          .eq('org_id', req._orgId)
          .in('id', playerIds)
      );
      const playerById = new Map(players.map(p => [p.id, p]));

      const roster = memberships.map(m => ({
        membershipId: m.id,
        jerseyNumber: m.jersey_number,
        status: m.status,
        player: playerById.get(m.player_id) || null,
      }));
      res.json({ roster });
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/teams/:teamId/roster');
    }
  }));

  // POST body: { playerId, seasonId, jerseyNumber? }. team_id always comes
  // from the URL, never the body -- team ownership is checked here (the
  // same existence+ownership pattern as the GET roster route above) before
  // delegating to rosterService, which independently re-checks player and
  // season ownership itself.
  router.post('/teams/:teamId/roster', requireAuth, resolveSupportSession, requireHighSchoolAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const team = await rosterService.getTeamInOrg({ orgId: req._orgId, teamId: req.params.teamId, adminClient });
      if (!team) return res.status(404).json({ error: 'Team not found' });
      const membership = await rosterService.addRosterMembership({ orgId: req._orgId, teamId: req.params.teamId, body: req.body, adminClient });
      res.status(201).json({ membership });
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/teams/:teamId/roster (add)');
    }
  }));

  router.patch('/teams/:teamId/roster/:membershipId', requireAuth, resolveSupportSession, requireHighSchoolAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const membership = await rosterService.updateRosterMembership({
        orgId: req._orgId, teamId: req.params.teamId, membershipId: req.params.membershipId, body: req.body, adminClient,
      });
      res.json({ membership });
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/teams/:teamId/roster/:membershipId (update)');
    }
  }));

  // Soft-remove only: sets status='inactive', never deletes the row. See
  // rosterService.removeRosterMembership's own comment for why.
  router.delete('/teams/:teamId/roster/:membershipId', requireAuth, resolveSupportSession, requireHighSchoolAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const membership = await rosterService.removeRosterMembership({
        orgId: req._orgId, teamId: req.params.teamId, membershipId: req.params.membershipId, adminClient,
      });
      res.json({ membership });
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/teams/:teamId/roster/:membershipId (remove)');
    }
  }));

  return router;
};

module.exports.requireHighSchoolAccess = requireHighSchoolAccess;
module.exports.hasHighSchoolEntitlement = hasHighSchoolEntitlement;
module.exports.getHsProgram = getHsProgram;
