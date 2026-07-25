'use strict';

// Read-only High School domain API. Mounted at /api/high-school in
// server.js. Every route requires requireAuth -> resolveSupportSession ->
// requireHighSchoolAccess, in that order -- identical middleware ordering
// to GET /api/product/capabilities in server.js, so a support session
// viewing a High-School-entitled customer sees that customer's own HS
// records, and a support session viewing a Travel-only customer is denied
// exactly like any other unentitled organization.
//
// This is the foundation slice only: read-only retrieval of a program,
// its seasons, its teams, and one team's roster for one season. No
// mutation route exists here, and none reads req.body.
//
// Follows src/admin-api.js's factory pattern: requireAuth is injected
// (owned by server.js, so JWT verification logic isn't duplicated);
// everything else standalone-importable is required directly.

const express = require('express');
const { adminClient } = require('./supabase');
const { resolveSupportSession } = require('./admin-lib');
const { getOrganizationCapabilities } = require('./product-capabilities');
const { resolveTrustedOrgId, buildAcceptedMembershipsQuery, mapErrorToResponse } = require('./org-resolution');
const { asyncHandler } = require('./express-helpers');

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

  return router;
};

module.exports.requireHighSchoolAccess = requireHighSchoolAccess;
module.exports.hasHighSchoolEntitlement = hasHighSchoolEntitlement;
module.exports.getHsProgram = getHsProgram;
