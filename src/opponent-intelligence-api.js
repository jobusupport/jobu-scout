'use strict';

// Opponent roster + coach scouting notes API. Mounted at
// /api/opponent-intelligence in server.js. Every route requires
// requireAuth -> resolveSupportSession -> requireTravelIntelligenceAccess,
// identical ordering to src/high-school-api.js's own guard chain, so a
// support session viewing a Travel-entitled customer sees that customer's
// own opponent data, and a Travel-only-entitled org behaves exactly like
// every other Travel route. Every write additionally runs
// blockWriteDuringReadOnlySupport immediately after resolveSupportSession.
//
// An "opponent" is a `teams` row with is_our_team=false -- routes below
// take :teamId (an existing teams.id) and never accept an org_id from the
// client for scoping (identical "the effective org always comes from
// req._orgId" rule src/high-school-api.js documents).
//
// Write-side validation/orchestration lives in
// src/opponent-roster-service.js and src/coach-notes-service.js
// (database-free unit-testable) -- route handlers here stay thin Express
// adapters, exactly like src/high-school-api.js's relationship to
// src/high-school-roster-service.js.

const express = require('express');
const { adminClient } = require('./supabase');
const { resolveSupportSession, blockWriteDuringReadOnlySupport } = require('./admin-lib');
const { getOrganizationCapabilities } = require('./product-capabilities');
const { resolveTrustedOrgId, buildAcceptedMembershipsQuery, mapErrorToResponse } = require('./org-resolution');
const { asyncHandler } = require('./express-helpers');
const rosterService = require('./opponent-roster-service');
const notesService = require('./coach-notes-service');
const { buildOpponentIntelligenceContext } = require('./report-context-builder');

async function selectSafe(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
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

// Pure decision function, unit-testable without a database -- mirrors
// src/high-school-api.js's hasHighSchoolEntitlement exactly, substituting
// the 'travel' product (opponent intelligence is Travel-domain
// functionality, same as the rest of this codebase's opponent-scouting
// features).
function hasTravelIntelligenceAccess(capabilities) {
  return Array.isArray(capabilities?.enabledProducts) && capabilities.enabledProducts.includes('travel');
}

async function requireTravelIntelligenceAccess(req, res, next) {
  try {
    const orgId = await getRequestOrgId(req);
    const capabilities = await getOrganizationCapabilities(orgId);
    if (!hasTravelIntelligenceAccess(capabilities)) {
      return res.status(403).json({ error: 'This organization does not have Travel access.' });
    }
    req._orgId = orgId;
    next();
  } catch (err) {
    return sendResolverError(res, err, 'requireTravelIntelligenceAccess');
  }
}

function requireAuthenticatedUserId(req, res) {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required.' });
    return null;
  }
  return userId;
}

module.exports = function createOpponentIntelligenceRouter({ requireAuth }) {
  const router = express.Router();

  // ── Roster ───────────────────────────────────────────────────────────

  router.get('/teams/:teamId/roster', requireAuth, resolveSupportSession, requireTravelIntelligenceAccess, asyncHandler(async (req, res) => {
    try {
      const roster = await rosterService.listOpponentRosterForTeam({ orgId: req._orgId, teamId: req.params.teamId, adminClient });
      res.json({ roster });
    } catch (err) {
      return sendResolverError(res, err, 'api/opponent-intelligence/teams/:teamId/roster');
    }
  }));

  router.post('/teams/:teamId/players', requireAuth, resolveSupportSession, requireTravelIntelligenceAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const player = await rosterService.createOpponentPlayer({ orgId: req._orgId, teamId: req.params.teamId, body: req.body, adminClient });
      res.status(201).json({ player });
    } catch (err) {
      return sendResolverError(res, err, 'api/opponent-intelligence/teams/:teamId/players (create)');
    }
  }));

  router.patch('/players/:playerId', requireAuth, resolveSupportSession, requireTravelIntelligenceAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const player = await rosterService.updateOpponentPlayer({ orgId: req._orgId, playerId: req.params.playerId, body: req.body, adminClient });
      res.json({ player });
    } catch (err) {
      return sendResolverError(res, err, 'api/opponent-intelligence/players/:playerId (update)');
    }
  }));

  // Read-only preview of what merging mergePlayerId into keepPlayerId would
  // affect (names + counts) -- never trusted as authorization for the
  // actual merge below, which independently re-validates everything this
  // reads. teamId scopes both players to the currently selected opponent,
  // rejecting a player from a different opponent team even within the
  // same org.
  router.get('/teams/:teamId/merge-preview', requireAuth, resolveSupportSession, requireTravelIntelligenceAccess, asyncHandler(async (req, res) => {
    try {
      const { keepPlayerId, mergePlayerId } = req.query || {};
      const preview = await rosterService.getOpponentMergePreview({ orgId: req._orgId, teamId: req.params.teamId, keepPlayerId, mergePlayerId, adminClient });
      res.json(preview);
    } catch (err) {
      return sendResolverError(res, err, 'api/opponent-intelligence/teams/:teamId/merge-preview');
    }
  }));

  router.post('/teams/:teamId/merge', requireAuth, resolveSupportSession, requireTravelIntelligenceAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const { keepPlayerId, mergePlayerId } = req.body || {};
      const player = await rosterService.mergeOpponentPlayers({ orgId: req._orgId, teamId: req.params.teamId, keepPlayerId, mergePlayerId, adminClient });
      res.json({ player });
    } catch (err) {
      return sendResolverError(res, err, 'api/opponent-intelligence/teams/:teamId/merge');
    }
  }));

  router.post('/players/:playerId/memberships', requireAuth, resolveSupportSession, requireTravelIntelligenceAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const teamId = req.body?.teamId;
      rosterService.requireUuid(teamId, 'teamId');
      const membership = await rosterService.addOpponentRosterMembership({ orgId: req._orgId, playerId: req.params.playerId, teamId, body: req.body, adminClient });
      res.status(201).json({ membership });
    } catch (err) {
      return sendResolverError(res, err, 'api/opponent-intelligence/players/:playerId/memberships (create)');
    }
  }));

  router.patch('/memberships/:membershipId', requireAuth, resolveSupportSession, requireTravelIntelligenceAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const membership = await rosterService.updateOpponentRosterMembership({ orgId: req._orgId, membershipId: req.params.membershipId, body: req.body, adminClient });
      res.json({ membership });
    } catch (err) {
      return sendResolverError(res, err, 'api/opponent-intelligence/memberships/:membershipId (update)');
    }
  }));

  router.delete('/memberships/:membershipId', requireAuth, resolveSupportSession, requireTravelIntelligenceAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const membership = await rosterService.removeOpponentRosterMembership({ orgId: req._orgId, membershipId: req.params.membershipId, adminClient });
      res.json({ membership });
    } catch (err) {
      return sendResolverError(res, err, 'api/opponent-intelligence/memberships/:membershipId (remove)');
    }
  }));

  // ── Import conflicts ─────────────────────────────────────────────────

  router.get('/players/:playerId/conflicts', requireAuth, resolveSupportSession, requireTravelIntelligenceAccess, asyncHandler(async (req, res) => {
    try {
      const conflicts = await rosterService.listUnresolvedImportConflicts({ orgId: req._orgId, playerId: req.params.playerId, adminClient });
      res.json({ conflicts });
    } catch (err) {
      return sendResolverError(res, err, 'api/opponent-intelligence/players/:playerId/conflicts');
    }
  }));

  router.post('/conflicts/:conflictId/resolve', requireAuth, resolveSupportSession, requireTravelIntelligenceAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const conflict = await rosterService.resolveImportConflict({ orgId: req._orgId, conflictId: req.params.conflictId, body: req.body, adminClient });
      res.json({ conflict });
    } catch (err) {
      return sendResolverError(res, err, 'api/opponent-intelligence/conflicts/:conflictId/resolve');
    }
  }));

  // ── Coach scouting notes ─────────────────────────────────────────────

  router.get('/teams/:teamId/notes', requireAuth, resolveSupportSession, requireTravelIntelligenceAccess, asyncHandler(async (req, res) => {
    try {
      const includeArchived = req.query?.includeArchived === 'true';
      const notes = await notesService.listNotesForTeam({ orgId: req._orgId, opponentTeamId: req.params.teamId, adminClient, includeArchived });
      res.json({ notes });
    } catch (err) {
      return sendResolverError(res, err, 'api/opponent-intelligence/teams/:teamId/notes');
    }
  }));

  router.post('/teams/:teamId/notes', requireAuth, resolveSupportSession, requireTravelIntelligenceAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const authorUserId = requireAuthenticatedUserId(req, res);
      if (!authorUserId) return;
      const note = await notesService.createNote({ orgId: req._orgId, authorUserId, opponentTeamId: req.params.teamId, body: req.body, adminClient });
      res.status(201).json({ note });
    } catch (err) {
      return sendResolverError(res, err, 'api/opponent-intelligence/teams/:teamId/notes (create)');
    }
  }));

  router.patch('/notes/:noteId', requireAuth, resolveSupportSession, requireTravelIntelligenceAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const note = await notesService.updateNote({ orgId: req._orgId, noteId: req.params.noteId, body: req.body, adminClient });
      res.json({ note });
    } catch (err) {
      return sendResolverError(res, err, 'api/opponent-intelligence/notes/:noteId (update)');
    }
  }));

  router.post('/notes/:noteId/archive', requireAuth, resolveSupportSession, requireTravelIntelligenceAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const note = await notesService.archiveNote({ orgId: req._orgId, noteId: req.params.noteId, adminClient });
      res.json({ note });
    } catch (err) {
      return sendResolverError(res, err, 'api/opponent-intelligence/notes/:noteId/archive');
    }
  }));

  router.patch('/notes/:noteId/include', requireAuth, resolveSupportSession, requireTravelIntelligenceAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const note = await notesService.setNoteIncludeInReport({ orgId: req._orgId, noteId: req.params.noteId, include: req.body?.include, adminClient });
      res.json({ note });
    } catch (err) {
      return sendResolverError(res, err, 'api/opponent-intelligence/notes/:noteId/include');
    }
  }));

  // ── Report-context preview ───────────────────────────────────────────
  // Read-only: shows exactly what buildOpponentIntelligenceContext would
  // assemble for this team WITHOUT exposing the raw prompt text -- only
  // the counts and any truncation, matching the "preview... never expose
  // the raw Claude prompt" requirement.
  router.get('/teams/:teamId/report-context-preview', requireAuth, resolveSupportSession, requireTravelIntelligenceAccess, asyncHandler(async (req, res) => {
    try {
      const context = await buildOpponentIntelligenceContext({ orgId: req._orgId, opponentTeamId: req.params.teamId, adminClient });
      res.json({ counts: context.counts, truncated: context.truncated });
    } catch (err) {
      return sendResolverError(res, err, 'api/opponent-intelligence/teams/:teamId/report-context-preview');
    }
  }));

  return router;
};
