'use strict';

// Write-side business logic for opponent rosters (Travel domain). Mirrors
// src/high-school-roster-service.js's established shape exactly -- pure
// validation functions plus orchestration functions that take an injected
// `adminClient`-shaped object, so every decision here is unit-testable
// without a live database.
//
// An "opponent" is a `teams` row with is_our_team=false -- see
// supabase/migrations/20260806031303_create_opponent_intelligence_domain.sql's
// own header for why no separate "opponents" entity was introduced.
//
// ── Identity model ─────────────────────────────────────────────────────
// opponent_players holds durable identity (name, bats/throws, class,
// lifecycle status). opponent_roster_memberships is a join connecting a
// player to a team at a point in time, and is the ONLY place jersey_number
// lives -- jersey numbers change between games and seasons and must never
// be used as identity. A player observed on the same team across multiple
// seasons is one opponent_players row with multiple
// opponent_roster_memberships rows, never re-created.
//
// ── Coach-confirmed-value protection ──────────────────────────────────
// `updateOpponentPlayer` is the COACH-facing edit path: every field named
// in the patch is written AND added to `confirmed_fields`, because a human
// explicitly editing a field IS confirming it. `applyImportedOpponentPlayerData`
// is the IMPORT-facing path: for each incoming field, if it is already in
// `confirmed_fields`, the import value is never written -- instead, if it
// differs from the current value, a row is recorded in
// opponent_roster_import_conflicts for later human review. Fields not yet
// confirmed are written normally and NOT added to confirmed_fields (only a
// human edit confirms a field, never an import).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPPONENT_PLAYER_STATUSES = ['active', 'graduated', 'transferred', 'not_participating', 'other_non_returning'];
const MEMBERSHIP_STATUSES = ['active', 'inactive'];
const BATS_VALUES = ['L', 'R', 'S'];
const THROWS_VALUES = ['L', 'R'];
// Fields eligible for coach-confirmed protection -- matches the migration's
// own header comment naming exactly these six.
const CONFIRMABLE_FIELDS = ['first_name', 'last_name', 'positions', 'bats', 'throws', 'class_or_grad_year'];
const UNIQUE_VIOLATION = '23505';

function typedError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function isValidUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function requireUuid(value, fieldName) {
  if (!isValidUuid(value)) {
    throw typedError(`${fieldName} must be a valid UUID`, 400);
  }
}

function rejectUnknownFields(body, allowedKeys) {
  const present = Object.keys(body || {});
  const unknown = present.filter((k) => !allowedKeys.includes(k));
  if (unknown.length > 0) {
    throw typedError(`Unknown field(s): ${unknown.join(', ')}`, 400);
  }
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw typedError(`${fieldName} is required and must be a non-empty string`, 400);
  }
  return value.trim();
}

function optionalString(value, fieldName) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw typedError(`${fieldName} must be a string`, 400);
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function optionalStringArray(value, fieldName) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw typedError(`${fieldName} must be an array of strings`, 400);
  }
  return value.map((v) => v.trim()).filter(Boolean);
}

function optionalEnum(value, fieldName, allowed) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw typedError(`${fieldName} must be one of: ${allowed.join(', ')}`, 400);
  }
  return value;
}

function mapWriteError(error, { conflictMessage }) {
  if (error?.code === UNIQUE_VIOLATION) {
    throw typedError(conflictMessage, 409);
  }
  console.error('[opponent-roster-service] write failed:', error);
  throw typedError('Something went wrong. Please try again.', 500);
}

// ── Players: pure validation ─────────────────────────────────────────────

const PLAYER_CREATE_FIELDS = ['first_name', 'last_name', 'positions', 'bats', 'throws', 'class_or_grad_year', 'status'];
const PLAYER_UPDATE_FIELDS = ['first_name', 'last_name', 'positions', 'bats', 'throws', 'class_or_grad_year', 'status'];

function validateOpponentPlayerCreate(body) {
  rejectUnknownFields(body, PLAYER_CREATE_FIELDS);
  const first_name = requireNonEmptyString(body?.first_name, 'first_name');
  const last_name = requireNonEmptyString(body?.last_name, 'last_name');
  const positions = optionalStringArray(body?.positions, 'positions');
  const bats = optionalEnum(body?.bats, 'bats', BATS_VALUES);
  const throws = optionalEnum(body?.throws, 'throws', THROWS_VALUES);
  const class_or_grad_year = optionalString(body?.class_or_grad_year, 'class_or_grad_year');
  const status = body?.status !== undefined ? optionalEnum(body.status, 'status', OPPONENT_PLAYER_STATUSES) : 'active';
  return { first_name, last_name, positions, bats, throws, class_or_grad_year, status };
}

function validateOpponentPlayerUpdate(body) {
  rejectUnknownFields(body, PLAYER_UPDATE_FIELDS);
  const patch = {};
  if (body?.first_name !== undefined) patch.first_name = requireNonEmptyString(body.first_name, 'first_name');
  if (body?.last_name !== undefined) patch.last_name = requireNonEmptyString(body.last_name, 'last_name');
  if (body?.positions !== undefined) patch.positions = optionalStringArray(body.positions, 'positions');
  if (body?.bats !== undefined) patch.bats = optionalEnum(body.bats, 'bats', BATS_VALUES);
  if (body?.throws !== undefined) patch.throws = optionalEnum(body.throws, 'throws', THROWS_VALUES);
  if (body?.class_or_grad_year !== undefined) patch.class_or_grad_year = optionalString(body.class_or_grad_year, 'class_or_grad_year');
  if (body?.status !== undefined) patch.status = optionalEnum(body.status, 'status', OPPONENT_PLAYER_STATUSES);
  if (Object.keys(patch).length === 0) {
    throw typedError('At least one field must be provided.', 400);
  }
  return patch;
}

// ── Players: orchestration ────────────────────────────────────────────────

const PLAYER_SELECT_COLUMNS = 'id, team_id, first_name, last_name, positions, bats, throws, class_or_grad_year, status, record_source, confirmed_fields, gc_match_status, last_observed_at, created_at, updated_at';

async function getTeamInOrg({ orgId, teamId, adminClient }) {
  requireUuid(teamId, 'teamId');
  const { data, error } = await adminClient
    .from('teams')
    .select('id, org_id, team_name, is_our_team, archived')
    .eq('id', teamId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) { console.error('[opponent-roster-service] team lookup failed:', error); throw typedError('Something went wrong. Please try again.', 500); }
  return data;
}

async function createOpponentPlayer({ orgId, teamId, body, adminClient }) {
  const team = await getTeamInOrg({ orgId, teamId, adminClient });
  if (!team) throw typedError('Opponent team not found', 404);

  const validated = validateOpponentPlayerCreate(body);
  const { data, error } = await adminClient
    .from('opponent_players')
    .insert({ org_id: orgId, team_id: teamId, ...validated, record_source: 'manual' })
    .select(PLAYER_SELECT_COLUMNS)
    .single();
  if (error) return mapWriteError(error, { conflictMessage: 'Unable to create opponent player.' });
  return data;
}

async function getOpponentPlayerInOrg({ orgId, playerId, adminClient }) {
  requireUuid(playerId, 'playerId');
  const { data, error } = await adminClient
    .from('opponent_players')
    .select(PLAYER_SELECT_COLUMNS)
    .eq('id', playerId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) { console.error('[opponent-roster-service] player lookup failed:', error); throw typedError('Something went wrong. Please try again.', 500); }
  return data;
}

// Coach-facing edit: every field in the patch is written, and its name is
// added to confirmed_fields (a human editing a field IS confirming it).
// Never removes an existing confirmation the patch didn't touch.
async function updateOpponentPlayer({ orgId, playerId, body, adminClient }) {
  requireUuid(playerId, 'playerId');
  const patch = validateOpponentPlayerUpdate(body);
  const existing = await getOpponentPlayerInOrg({ orgId, playerId, adminClient });
  if (!existing) throw typedError('Opponent player not found', 404);

  const newlyConfirmed = Object.keys(patch).filter((k) => CONFIRMABLE_FIELDS.includes(k));
  const confirmed_fields = Array.from(new Set([...(existing.confirmed_fields || []), ...newlyConfirmed]));

  const { data, error } = await adminClient
    .from('opponent_players')
    .update({ ...patch, confirmed_fields })
    .eq('org_id', orgId)
    .eq('id', playerId)
    .select(PLAYER_SELECT_COLUMNS)
    .single();
  if (error) return mapWriteError(error, { conflictMessage: 'Unable to update opponent player.' });
  return data;
}

async function listOpponentPlayers({ orgId, teamId, adminClient }) {
  requireUuid(teamId, 'teamId');
  const { data, error } = await adminClient
    .from('opponent_players')
    .select(PLAYER_SELECT_COLUMNS)
    .eq('org_id', orgId)
    .eq('team_id', teamId)
    .order('last_name')
    .order('first_name');
  if (error) { console.error('[opponent-roster-service] player list failed:', error); throw typedError('Something went wrong. Please try again.', 500); }
  return data || [];
}

// Import-facing write: never overwrites a coach-confirmed field. Any
// confirmed field whose imported value differs from the current value is
// recorded as a conflict for review instead of being silently discarded.
// Returns { data, conflicts } -- conflicts is always an array (possibly
// empty), never thrown as an error (a conflict is not a failure).
async function applyImportedOpponentPlayerData({ orgId, playerId, importedFields, source, adminClient }) {
  requireUuid(playerId, 'playerId');
  const existing = await getOpponentPlayerInOrg({ orgId, playerId, adminClient });
  if (!existing) throw typedError('Opponent player not found', 404);

  const confirmed = new Set(existing.confirmed_fields || []);
  const patch = {};
  const conflicts = [];

  for (const [field, importedValue] of Object.entries(importedFields || {})) {
    if (!CONFIRMABLE_FIELDS.includes(field)) continue;
    if (confirmed.has(field)) {
      const currentValue = existing[field];
      const currentStr = Array.isArray(currentValue) ? currentValue.join(',') : String(currentValue ?? '');
      const importedStr = Array.isArray(importedValue) ? importedValue.join(',') : String(importedValue ?? '');
      if (currentStr !== importedStr) {
        conflicts.push({
          org_id: orgId,
          opponent_player_id: playerId,
          field_name: field,
          coach_confirmed_value: currentStr,
          imported_value: importedStr,
          source: source || 'gamechanger',
        });
      }
      continue; // never overwrite a confirmed field
    }
    patch[field] = importedValue;
  }

  patch.last_observed_at = new Date().toISOString();
  patch.record_source = existing.record_source === 'manual' && Object.keys(patch).length === 1 ? existing.record_source : 'gamechanger';

  const { data, error } = await adminClient
    .from('opponent_players')
    .update(patch)
    .eq('org_id', orgId)
    .eq('id', playerId)
    .select(PLAYER_SELECT_COLUMNS)
    .single();
  if (error) return mapWriteError(error, { conflictMessage: 'Unable to apply imported opponent player data.' });

  let recordedConflicts = [];
  if (conflicts.length > 0) {
    const { data: conflictRows, error: conflictError } = await adminClient
      .from('opponent_roster_import_conflicts')
      .insert(conflicts)
      .select('id, field_name, coach_confirmed_value, imported_value, source, detected_at');
    if (conflictError) { console.error('[opponent-roster-service] failed to record import conflict:', conflictError); }
    else recordedConflicts = conflictRows || [];
  }

  return { data, conflicts: recordedConflicts };
}

// Shared by getOpponentMergePreview and mergeOpponentPlayers -- the preview
// and the actual merge must apply IDENTICAL validation (uuid shape, distinct
// players, org membership, and same-opponent-team membership), because the
// preview's result is never trusted as authorization for the merge itself;
// the merge re-derives and re-checks everything from the database at
// execution time. Throws the same typed errors either caller already
// exposes (404 org-scoped not-found, 400 same-player/wrong-team), so a
// stale preview followed by an execution against changed data fails with
// the same clear error a fresh preview would have shown.
async function loadAndValidateMergePair({ orgId, teamId, keepPlayerId, mergePlayerId, adminClient }) {
  requireUuid(teamId, 'teamId');
  requireUuid(keepPlayerId, 'keepPlayerId');
  requireUuid(mergePlayerId, 'mergePlayerId');
  if (keepPlayerId === mergePlayerId) throw typedError('keepPlayerId and mergePlayerId must be different players.', 400);

  const [keepPlayer, mergePlayer] = await Promise.all([
    getOpponentPlayerInOrg({ orgId, playerId: keepPlayerId, adminClient }),
    getOpponentPlayerInOrg({ orgId, playerId: mergePlayerId, adminClient }),
  ]);
  if (!keepPlayer) throw typedError('keepPlayerId player not found', 404);
  if (!mergePlayer) throw typedError('mergePlayerId player not found', 404);
  if (keepPlayer.team_id !== teamId || mergePlayer.team_id !== teamId) {
    throw typedError('Both players must belong to the selected opponent team.', 400);
  }
  return { keepPlayer, mergePlayer };
}

// Read-only: counts what a merge of mergePlayerId into keepPlayerId would
// affect, without changing anything. The UI's merge-confirmation dialog
// calls this to show real counts instead of a generic description --
// never computed from whatever subset of memberships/notes the browser
// happens to already have loaded, always a fresh org-scoped count query.
async function getOpponentMergePreview({ orgId, teamId, keepPlayerId, mergePlayerId, adminClient }) {
  const { keepPlayer, mergePlayer } = await loadAndValidateMergePair({ orgId, teamId, keepPlayerId, mergePlayerId, adminClient });

  const [membershipsResult, notesResult] = await Promise.all([
    adminClient.from('opponent_roster_memberships').select('id').eq('org_id', orgId).eq('opponent_player_id', mergePlayerId),
    adminClient.from('coach_scouting_notes').select('id').eq('org_id', orgId).eq('opponent_player_id', mergePlayerId),
  ]);
  if (membershipsResult.error) { console.error('[opponent-roster-service] merge preview: membership count failed:', membershipsResult.error); throw typedError('Something went wrong. Please try again.', 500); }
  if (notesResult.error) { console.error('[opponent-roster-service] merge preview: note count failed:', notesResult.error); throw typedError('Something went wrong. Please try again.', 500); }

  return {
    survivor: { id: keepPlayer.id, first_name: keepPlayer.first_name, last_name: keepPlayer.last_name },
    duplicate: { id: mergePlayer.id, first_name: mergePlayer.first_name, last_name: mergePlayer.last_name },
    membershipCount: (membershipsResult.data || []).length,
    noteCount: (notesResult.data || []).length,
  };
}

// Reassigns every membership and note from mergePlayerId to keepPlayerId
// (org- AND team-scoped, so a cross-org or cross-opponent merge attempt
// structurally cannot happen), unions confirmed_fields, then deletes the
// now-empty duplicate. Never deletes keepPlayerId. Independently re-runs
// every check loadAndValidateMergePair applies -- never trusts a
// previously returned preview, so a preview computed a moment earlier
// (whose counts could already be stale by the time the coach clicks
// confirm) cannot bypass this function's own authorization.
async function mergeOpponentPlayers({ orgId, teamId, keepPlayerId, mergePlayerId, adminClient }) {
  const { keepPlayer, mergePlayer } = await loadAndValidateMergePair({ orgId, teamId, keepPlayerId, mergePlayerId, adminClient });

  const { error: reassignMembershipsError } = await adminClient
    .from('opponent_roster_memberships')
    .update({ opponent_player_id: keepPlayerId })
    .eq('org_id', orgId)
    .eq('opponent_player_id', mergePlayerId);
  if (reassignMembershipsError) { console.error('[opponent-roster-service] merge: reassigning memberships failed:', reassignMembershipsError); throw typedError('Unable to merge opponent players.', 500); }

  const { error: reassignNotesError } = await adminClient
    .from('coach_scouting_notes')
    .update({ opponent_player_id: keepPlayerId })
    .eq('org_id', orgId)
    .eq('opponent_player_id', mergePlayerId);
  if (reassignNotesError) { console.error('[opponent-roster-service] merge: reassigning notes failed:', reassignNotesError); throw typedError('Unable to merge opponent players.', 500); }

  const mergedConfirmedFields = Array.from(new Set([...(keepPlayer.confirmed_fields || []), ...(mergePlayer.confirmed_fields || [])]));
  if (mergedConfirmedFields.length > (keepPlayer.confirmed_fields || []).length) {
    await adminClient.from('opponent_players').update({ confirmed_fields: mergedConfirmedFields }).eq('org_id', orgId).eq('id', keepPlayerId);
  }

  const { error: deleteError } = await adminClient
    .from('opponent_players')
    .delete()
    .eq('org_id', orgId)
    .eq('id', mergePlayerId);
  if (deleteError) { console.error('[opponent-roster-service] merge: deleting duplicate failed:', deleteError); throw typedError('Unable to merge opponent players.', 500); }

  return getOpponentPlayerInOrg({ orgId, playerId: keepPlayerId, adminClient });
}

// ── Roster memberships ────────────────────────────────────────────────────

const MEMBERSHIP_SELECT_COLUMNS = 'id, opponent_player_id, team_id, jersey_number, season_label, status, record_source, first_observed_at, last_observed_at, created_at, updated_at';

function validateMembershipCreate(body) {
  rejectUnknownFields(body, ['jersey_number', 'season_label']);
  const jersey_number = optionalString(body?.jersey_number, 'jersey_number');
  const season_label = optionalString(body?.season_label, 'season_label');
  return { jersey_number, season_label };
}

function validateMembershipUpdate(body) {
  rejectUnknownFields(body, ['jersey_number', 'season_label', 'status']);
  const patch = {};
  if (body?.jersey_number !== undefined) patch.jersey_number = optionalString(body.jersey_number, 'jersey_number');
  if (body?.season_label !== undefined) patch.season_label = optionalString(body.season_label, 'season_label');
  if (body?.status !== undefined) patch.status = optionalEnum(body.status, 'status', MEMBERSHIP_STATUSES);
  if (Object.keys(patch).length === 0) {
    throw typedError('At least one field must be provided.', 400);
  }
  return patch;
}

async function addOpponentRosterMembership({ orgId, playerId, teamId, body, adminClient }) {
  const [player, team] = await Promise.all([
    getOpponentPlayerInOrg({ orgId, playerId, adminClient }),
    getTeamInOrg({ orgId, teamId, adminClient }),
  ]);
  if (!player) throw typedError('Opponent player not found', 404);
  if (!team) throw typedError('Opponent team not found', 404);

  const validated = validateMembershipCreate(body);
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await adminClient
    .from('opponent_roster_memberships')
    .insert({ org_id: orgId, opponent_player_id: playerId, team_id: teamId, ...validated, first_observed_at: today, last_observed_at: today })
    .select(MEMBERSHIP_SELECT_COLUMNS)
    .single();
  if (error) return mapWriteError(error, { conflictMessage: 'This player already has a membership for this team and season.' });
  return data;
}

async function getMembershipInOrg({ orgId, membershipId, adminClient }) {
  requireUuid(membershipId, 'membershipId');
  const { data, error } = await adminClient
    .from('opponent_roster_memberships')
    .select(MEMBERSHIP_SELECT_COLUMNS)
    .eq('id', membershipId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) { console.error('[opponent-roster-service] membership lookup failed:', error); throw typedError('Something went wrong. Please try again.', 500); }
  return data;
}

async function updateOpponentRosterMembership({ orgId, membershipId, body, adminClient }) {
  const patch = validateMembershipUpdate(body);
  const existing = await getMembershipInOrg({ orgId, membershipId, adminClient });
  if (!existing) throw typedError('Roster membership not found', 404);

  const { data, error } = await adminClient
    .from('opponent_roster_memberships')
    .update(patch)
    .eq('org_id', orgId)
    .eq('id', membershipId)
    .select(MEMBERSHIP_SELECT_COLUMNS)
    .single();
  if (error) return mapWriteError(error, { conflictMessage: 'Unable to update roster membership.' });
  return data;
}

// Soft-delete only, matching hs_roster_memberships / removeRosterMembership.
async function removeOpponentRosterMembership({ orgId, membershipId, adminClient }) {
  const existing = await getMembershipInOrg({ orgId, membershipId, adminClient });
  if (!existing) throw typedError('Roster membership not found', 404);

  const { data, error } = await adminClient
    .from('opponent_roster_memberships')
    .update({ status: 'inactive' })
    .eq('org_id', orgId)
    .eq('id', membershipId)
    .select(MEMBERSHIP_SELECT_COLUMNS)
    .single();
  if (error) return mapWriteError(error, { conflictMessage: 'Unable to remove roster membership.' });
  return data;
}

async function listOpponentRosterMemberships({ orgId, teamId, adminClient }) {
  requireUuid(teamId, 'teamId');
  const { data, error } = await adminClient
    .from('opponent_roster_memberships')
    .select(MEMBERSHIP_SELECT_COLUMNS)
    .eq('org_id', orgId)
    .eq('team_id', teamId)
    .order('last_observed_at', { ascending: false });
  if (error) { console.error('[opponent-roster-service] membership list failed:', error); throw typedError('Something went wrong. Please try again.', 500); }
  return data || [];
}

// Combined roster view: each active player joined with their most recent
// active membership for this team (current jersey/season), matching the
// established "player identity separate from per-team jersey" model.
// Players with no membership on this team yet are still included with a
// null membership -- e.g. immediately after createOpponentPlayer, before
// addOpponentRosterMembership has been called.
async function listOpponentRosterForTeam({ orgId, teamId, adminClient }) {
  const [players, memberships] = await Promise.all([
    listOpponentPlayers({ orgId, teamId, adminClient }),
    listOpponentRosterMemberships({ orgId, teamId, adminClient }),
  ]);
  const latestMembershipByPlayer = new Map();
  for (const m of memberships) {
    if (m.status !== 'active') continue;
    const current = latestMembershipByPlayer.get(m.opponent_player_id);
    if (!current || new Date(m.last_observed_at || 0) > new Date(current.last_observed_at || 0)) {
      latestMembershipByPlayer.set(m.opponent_player_id, m);
    }
  }
  return players.map((player) => ({
    ...player,
    membership: latestMembershipByPlayer.get(player.id) || null,
  }));
}

// ── Import conflicts ───────────────────────────────────────────────────────

async function listUnresolvedImportConflicts({ orgId, playerId, adminClient }) {
  requireUuid(playerId, 'playerId');
  const { data, error } = await adminClient
    .from('opponent_roster_import_conflicts')
    .select('id, field_name, coach_confirmed_value, imported_value, source, detected_at, resolved_at, resolution')
    .eq('org_id', orgId)
    .eq('opponent_player_id', playerId)
    .is('resolved_at', null)
    .order('detected_at', { ascending: false });
  if (error) { console.error('[opponent-roster-service] conflict list failed:', error); throw typedError('Something went wrong. Please try again.', 500); }
  return data || [];
}

function validateResolution(body) {
  rejectUnknownFields(body, ['resolution']);
  const resolution = optionalEnum(body?.resolution, 'resolution', ['kept_coach_value', 'accepted_import_value']);
  if (!resolution) throw typedError('resolution is required.', 400);
  return resolution;
}

async function resolveImportConflict({ orgId, conflictId, body, adminClient }) {
  requireUuid(conflictId, 'conflictId');
  const resolution = validateResolution(body);
  const { data, error } = await adminClient
    .from('opponent_roster_import_conflicts')
    .update({ resolved_at: new Date().toISOString(), resolution })
    .eq('org_id', orgId)
    .eq('id', conflictId)
    .select('id, field_name, coach_confirmed_value, imported_value, source, detected_at, resolved_at, resolution')
    .single();
  if (error) { console.error('[opponent-roster-service] conflict resolve failed:', error); throw typedError('Something went wrong. Please try again.', 500); }
  return data;
}

module.exports = {
  OPPONENT_PLAYER_STATUSES,
  MEMBERSHIP_STATUSES,
  BATS_VALUES,
  THROWS_VALUES,
  CONFIRMABLE_FIELDS,
  isValidUuid,
  requireUuid,
  typedError,
  getTeamInOrg,
  validateOpponentPlayerCreate,
  validateOpponentPlayerUpdate,
  createOpponentPlayer,
  getOpponentPlayerInOrg,
  updateOpponentPlayer,
  listOpponentPlayers,
  applyImportedOpponentPlayerData,
  getOpponentMergePreview,
  mergeOpponentPlayers,
  validateMembershipCreate,
  validateMembershipUpdate,
  addOpponentRosterMembership,
  getMembershipInOrg,
  updateOpponentRosterMembership,
  removeOpponentRosterMembership,
  listOpponentRosterMemberships,
  listOpponentRosterForTeam,
  listUnresolvedImportConflicts,
  validateResolution,
  resolveImportConflict,
};
