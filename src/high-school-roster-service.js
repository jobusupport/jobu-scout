'use strict';

// Write-side business logic for the High School domain: program, seasons,
// teams, players, and roster memberships. Mirrors src/admin-product-route.js's
// established shape exactly -- pure validation functions plus orchestration
// functions that take an injected `adminClient`-shaped object, so every
// decision here is unit-testable without a live database. The Express router
// in src/high-school-api.js stays a thin adapter over this module, the same
// relationship admin-api.js already has with admin-product-route.js.
//
// ── Response/request field casing ───────────────────────────────────────
// Every resource here uses the SAME field-name casing in its request body as
// in its response body, and that casing matches whatever the pre-existing
// read-only GET routes in src/high-school-api.js already return: snake_case,
// a direct passthrough of the Postgres column names for program/seasons/
// teams/players. This is a deliberate choice, not an oversight -- a client
// that reads a resource and later writes it back never has to translate
// between two different cases for the same field. Roster memberships are the
// one exception, because GET /teams/:teamId/roster already ships a camelCase
// response shape (membershipId/jerseyNumber) before this module existed;
// changing that would be a breaking change to already-tested behavior this
// task has no reason to make, so roster stays camelCase end-to-end instead.
//
// ── Why no multi-statement transaction/RPC function is needed here ───────
// admin_update_org_product_fn exists because that route MUST atomically
// update one row AND insert an audit-log row together (see that migration's
// own header comment). Nothing in this module has that shape: every
// operation below is exactly one write to exactly one table
// (hs_programs / hs_seasons / hs_teams / hs_players /
// hs_roster_memberships), which Postgres already makes atomic on its own via
// PostgREST's per-call implicit transaction. No custom SQL function, and no
// application-level multi-step transaction, is introduced by this module.
//
// ── record_source is never client-settable ────────────────────────────────
// 'gamechanger' is reserved for the future importer (see
// src/high-school-importer-contract.js). Every write in this module either
// omits record_source (falling through to the schema's own 'manual' default)
// or, where relevant, is documented as never accepting it from the request
// body -- there is no code path here that lets a client claim
// record_source='gamechanger'.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEAM_LEVELS = ['varsity', 'junior_varsity', 'freshman'];
const ROSTER_STATUSES = ['active', 'inactive'];
// Matches supabase/migrations/20260803120000_add_hs_player_lifecycle_status.sql's
// hs_players_status_check exactly. is_active remains selectable/returned as
// a database-generated column (status = 'active') -- never written to
// directly by this module (see resolvePlayerStatusInput below).
const PLAYER_STATUSES = ['active', 'graduated', 'transferred', 'not_participating', 'other_non_returning'];
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

// Pure. Every *validate* function below shares this shape: reject unknown
// keys first (a caller relying on a field this route silently ignores must
// get a loud 400, not a silent no-op -- same rule admin-product-route.js's
// validateProductChangeRequest already enforces), then check the fields it
// does know about.
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

function optionalBoolean(value, fieldName) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw typedError(`${fieldName} must be a boolean`, 400);
  }
  return value;
}

// YYYY-MM-DD only -- matches the `date` column type; anything else would
// either be rejected by Postgres with a raw, unsanitized error or silently
// misparsed, neither of which is acceptable here.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function optionalDate(value, fieldName) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw typedError(`${fieldName} must be a valid YYYY-MM-DD date`, 400);
  }
  return value;
}

function mapWriteError(error, { conflictMessage }) {
  if (error?.code === UNIQUE_VIOLATION) {
    throw typedError(conflictMessage, 409);
  }
  console.error('[high-school-roster-service] write failed:', error);
  throw typedError('Something went wrong. Please try again.', 500);
}

// ── Program ──────────────────────────────────────────────────────────────

function validateProgramCreate(body) {
  rejectUnknownFields(body, ['name', 'school_name']);
  const name = requireNonEmptyString(body?.name, 'name');
  const schoolName = optionalString(body?.school_name, 'school_name');
  return { name, school_name: schoolName };
}

function validateProgramUpdate(body) {
  rejectUnknownFields(body, ['name', 'school_name', 'is_active']);
  const patch = {};
  if (body?.name !== undefined) patch.name = requireNonEmptyString(body.name, 'name');
  if (body?.school_name !== undefined) patch.school_name = optionalString(body.school_name, 'school_name');
  const isActive = optionalBoolean(body?.is_active, 'is_active');
  if (isActive !== undefined) patch.is_active = isActive;
  if (Object.keys(patch).length === 0) {
    throw typedError('At least one field must be provided.', 400);
  }
  return patch;
}

async function createProgram({ orgId, body, adminClient }) {
  const validated = validateProgramCreate(body);
  const { data, error } = await adminClient
    .from('hs_programs')
    .insert({ org_id: orgId, ...validated })
    .select('id, name, school_name, is_active')
    .single();
  if (error) return mapWriteError(error, { conflictMessage: 'A program already exists for this organization.' });
  return data;
}

async function updateProgram({ orgId, body, adminClient, getProgram }) {
  const patch = validateProgramUpdate(body);
  const existing = await getProgram(orgId);
  if (!existing) throw typedError('Program not found. Create one first.', 404);

  const { data, error } = await adminClient
    .from('hs_programs')
    .update(patch)
    .eq('org_id', orgId)
    .eq('id', existing.id)
    .select('id, name, school_name, is_active')
    .single();
  if (error) return mapWriteError(error, { conflictMessage: 'A program already exists for this organization.' });
  return data;
}

// ── Seasons ──────────────────────────────────────────────────────────────

function validateSeasonCreate(body) {
  rejectUnknownFields(body, ['name', 'school_year', 'start_date', 'end_date', 'is_current']);
  const name = requireNonEmptyString(body?.name, 'name');
  const schoolYear = requireNonEmptyString(body?.school_year, 'school_year');
  const startDate = optionalDate(body?.start_date, 'start_date');
  const endDate = optionalDate(body?.end_date, 'end_date');
  if (startDate && endDate && endDate < startDate) {
    throw typedError('end_date must not be before start_date.', 400);
  }
  const isCurrent = optionalBoolean(body?.is_current, 'is_current') ?? false;
  return { name, school_year: schoolYear, start_date: startDate, end_date: endDate, is_current: isCurrent };
}

function validateSeasonUpdate(body) {
  rejectUnknownFields(body, ['name', 'school_year', 'start_date', 'end_date', 'is_current']);
  const patch = {};
  if (body?.name !== undefined) patch.name = requireNonEmptyString(body.name, 'name');
  if (body?.school_year !== undefined) patch.school_year = requireNonEmptyString(body.school_year, 'school_year');
  if (body?.start_date !== undefined) patch.start_date = optionalDate(body.start_date, 'start_date');
  if (body?.end_date !== undefined) patch.end_date = optionalDate(body.end_date, 'end_date');
  const isCurrent = optionalBoolean(body?.is_current, 'is_current');
  if (isCurrent !== undefined) patch.is_current = isCurrent;
  if (Object.keys(patch).length === 0) {
    throw typedError('At least one field must be provided.', 400);
  }
  if (
    patch.start_date !== undefined && patch.end_date !== undefined &&
    patch.start_date && patch.end_date && patch.end_date < patch.start_date
  ) {
    throw typedError('end_date must not be before start_date.', 400);
  }
  return patch;
}

async function createSeason({ orgId, body, adminClient, getProgram }) {
  const validated = validateSeasonCreate(body);
  const program = await getProgram(orgId);
  if (!program) throw typedError('Create a program before adding seasons.', 404);

  const { data, error } = await adminClient
    .from('hs_seasons')
    .insert({ org_id: orgId, program_id: program.id, ...validated })
    .select('id, program_id, name, school_year, start_date, end_date, is_current')
    .single();
  if (error) return mapWriteError(error, { conflictMessage: 'A season with this name already exists for this program.' });
  return data;
}

async function getSeasonInOrg({ orgId, seasonId, adminClient }) {
  requireUuid(seasonId, 'seasonId');
  const { data, error } = await adminClient
    .from('hs_seasons')
    .select('id, program_id, name, school_year, start_date, end_date, is_current')
    .eq('id', seasonId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) { console.error('[high-school-roster-service] season lookup failed:', error); throw typedError('Something went wrong. Please try again.', 500); }
  return data;
}

async function updateSeason({ orgId, seasonId, body, adminClient }) {
  requireUuid(seasonId, 'seasonId');
  const patch = validateSeasonUpdate(body);
  const existing = await getSeasonInOrg({ orgId, seasonId, adminClient });
  if (!existing) throw typedError('Season not found', 404);

  const { data, error } = await adminClient
    .from('hs_seasons')
    .update(patch)
    .eq('org_id', orgId)
    .eq('id', seasonId)
    .select('id, program_id, name, school_year, start_date, end_date, is_current')
    .single();
  if (error) return mapWriteError(error, { conflictMessage: 'A season with this name already exists for this program.' });
  return data;
}

// ── Teams ────────────────────────────────────────────────────────────────

function validateTeamCreate(body) {
  rejectUnknownFields(body, ['name', 'level', 'is_active']);
  const name = requireNonEmptyString(body?.name, 'name');
  if (!TEAM_LEVELS.includes(body?.level)) {
    throw typedError(`level must be one of: ${TEAM_LEVELS.join(', ')}`, 400);
  }
  const isActive = optionalBoolean(body?.is_active, 'is_active') ?? true;
  return { name, level: body.level, is_active: isActive };
}

function validateTeamUpdate(body) {
  rejectUnknownFields(body, ['name', 'level', 'is_active']);
  const patch = {};
  if (body?.name !== undefined) patch.name = requireNonEmptyString(body.name, 'name');
  if (body?.level !== undefined) {
    if (!TEAM_LEVELS.includes(body.level)) {
      throw typedError(`level must be one of: ${TEAM_LEVELS.join(', ')}`, 400);
    }
    patch.level = body.level;
  }
  const isActive = optionalBoolean(body?.is_active, 'is_active');
  if (isActive !== undefined) patch.is_active = isActive;
  if (Object.keys(patch).length === 0) {
    throw typedError('At least one field must be provided.', 400);
  }
  return patch;
}

async function createTeam({ orgId, body, adminClient, getProgram }) {
  const validated = validateTeamCreate(body);
  const program = await getProgram(orgId);
  if (!program) throw typedError('Create a program before adding teams.', 404);

  const { data, error } = await adminClient
    .from('hs_teams')
    .insert({ org_id: orgId, program_id: program.id, ...validated })
    .select('id, program_id, level, name, is_active')
    .single();
  if (error) return mapWriteError(error, { conflictMessage: 'A team with this name already exists for this program.' });
  return data;
}

async function getTeamInOrg({ orgId, teamId, adminClient }) {
  requireUuid(teamId, 'teamId');
  const { data, error } = await adminClient
    .from('hs_teams')
    .select('id, program_id, level, name, is_active')
    .eq('id', teamId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) { console.error('[high-school-roster-service] team lookup failed:', error); throw typedError('Something went wrong. Please try again.', 500); }
  return data;
}

async function updateTeam({ orgId, teamId, body, adminClient }) {
  requireUuid(teamId, 'teamId');
  const patch = validateTeamUpdate(body);
  const existing = await getTeamInOrg({ orgId, teamId, adminClient });
  if (!existing) throw typedError('Team not found', 404);

  const { data, error } = await adminClient
    .from('hs_teams')
    .update(patch)
    .eq('org_id', orgId)
    .eq('id', teamId)
    .select('id, program_id, level, name, is_active')
    .single();
  if (error) return mapWriteError(error, { conflictMessage: 'A team with this name already exists for this program.' });
  return data;
}

// ── Players ──────────────────────────────────────────────────────────────

const MIN_GRADUATION_YEAR = 2000; // matches hs_players_graduation_year_check

function optionalGraduationYear(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < MIN_GRADUATION_YEAR) {
    throw typedError(`graduation_year must be an integer >= ${MIN_GRADUATION_YEAR}`, 400);
  }
  return value;
}

// ── Player status / legacy is_active compatibility ─────────────────────
//
// hs_players.is_active is a database-generated column (status = 'active')
// -- see supabase/migrations/20260803120000_add_hs_player_lifecycle_status.sql,
// applied to production 2026-08-05 (production version 20260805202830). This
// module never writes is_active directly (Postgres itself rejects that,
// since it's `generated always as ... stored`); it always resolves an
// incoming request to a `status` value before touching the database.
//
// `is_active` stays a fully accepted, permanent compatibility input on
// create/update -- it is a live, currently-tested part of the API contract
// (see test/high-school-api-integration.test.js's is_active-bearing
// requests), not deprecated surface to remove.
function legacyIsActiveToStatus(isActive) {
  // Conservative on purpose: a legacy is_active=false caller never told us
  // WHY the player is inactive, so it is never guessed as 'graduated' or
  // 'transferred' -- only the schema's own conservative default for an
  // unknown non-active reason.
  return isActive ? 'active' : 'other_non_returning';
}

// A boolean agrees with a status at exactly the coarseness is_active is
// capable of expressing: is_active=true means 'active' and nothing else;
// is_active=false is compatible with ANY non-active status, since the
// boolean alone can never say which one.
function isActiveAgreesWithStatus(isActive, status) {
  return isActive ? status === 'active' : status !== 'active';
}

// Pure. Resolves the effective `status` for a player create/update request
// that may supply `status`, legacy `is_active`, both, or neither.
//   - status only            -> validated status, used as-is.
//   - is_active only         -> mapped via legacyIsActiveToStatus.
//   - neither                -> returns undefined (caller decides: 'active'
//                                default on create, "leave unchanged" on
//                                update).
//   - both, agreeing         -> accepted; `status` (the more specific of the
//                                two signals) is used -- never a silent
//                                override, since the two inputs already say
//                                the same thing.
//   - both, conflicting       -> throws 400 naming both fields. Never
//                                silently prefers one over the other.
// `isActive` must already be undefined-or-boolean (validate with
// optionalBoolean before calling this).
function resolvePlayerStatusInput({ status, isActive }) {
  const hasStatus = status !== undefined;
  const hasIsActive = isActive !== undefined;

  if (hasStatus && !PLAYER_STATUSES.includes(status)) {
    throw typedError(`status must be one of: ${PLAYER_STATUSES.join(', ')}`, 400);
  }
  if (!hasStatus && !hasIsActive) return undefined;
  if (hasStatus && !hasIsActive) return status;
  if (!hasStatus && hasIsActive) return legacyIsActiveToStatus(isActive);

  // Both supplied.
  if (!isActiveAgreesWithStatus(isActive, status)) {
    throw typedError(`status and is_active disagree (status: '${status}', is_active: ${isActive}); provide only one`, 400);
  }
  return status;
}

const PLAYER_SELECT_COLUMNS = 'id, program_id, first_name, last_name, preferred_name, graduation_year, status, is_active';

function validatePlayerCreate(body) {
  rejectUnknownFields(body, ['first_name', 'last_name', 'preferred_name', 'graduation_year', 'is_active', 'status']);
  const firstName = requireNonEmptyString(body?.first_name, 'first_name');
  const lastName = requireNonEmptyString(body?.last_name, 'last_name');
  const preferredName = optionalString(body?.preferred_name, 'preferred_name');
  const graduationYear = optionalGraduationYear(body?.graduation_year);
  const isActive = optionalBoolean(body?.is_active, 'is_active');
  const status = resolvePlayerStatusInput({ status: body?.status, isActive }) ?? 'active';
  return { first_name: firstName, last_name: lastName, preferred_name: preferredName, graduation_year: graduationYear, status };
}

function validatePlayerUpdate(body) {
  rejectUnknownFields(body, ['first_name', 'last_name', 'preferred_name', 'graduation_year', 'is_active', 'status']);
  const patch = {};
  if (body?.first_name !== undefined) patch.first_name = requireNonEmptyString(body.first_name, 'first_name');
  if (body?.last_name !== undefined) patch.last_name = requireNonEmptyString(body.last_name, 'last_name');
  if (body?.preferred_name !== undefined) patch.preferred_name = optionalString(body.preferred_name, 'preferred_name');
  if (body?.graduation_year !== undefined) patch.graduation_year = optionalGraduationYear(body.graduation_year);
  const isActive = optionalBoolean(body?.is_active, 'is_active');
  const status = resolvePlayerStatusInput({ status: body?.status, isActive });
  if (status !== undefined) patch.status = status;
  if (Object.keys(patch).length === 0) {
    throw typedError('At least one field must be provided.', 400);
  }
  return patch;
}

async function createPlayer({ orgId, body, adminClient, getProgram }) {
  const validated = validatePlayerCreate(body);
  const program = await getProgram(orgId);
  if (!program) throw typedError('Create a program before adding players.', 404);

  const { data, error } = await adminClient
    .from('hs_players')
    .insert({ org_id: orgId, program_id: program.id, ...validated })
    .select(PLAYER_SELECT_COLUMNS)
    .single();
  if (error) return mapWriteError(error, { conflictMessage: 'Unable to create player.' });
  return data;
}

async function getPlayerInOrg({ orgId, playerId, adminClient }) {
  requireUuid(playerId, 'playerId');
  const { data, error } = await adminClient
    .from('hs_players')
    .select(PLAYER_SELECT_COLUMNS)
    .eq('id', playerId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) { console.error('[high-school-roster-service] player lookup failed:', error); throw typedError('Something went wrong. Please try again.', 500); }
  return data;
}

async function updatePlayer({ orgId, playerId, body, adminClient }) {
  requireUuid(playerId, 'playerId');
  const patch = validatePlayerUpdate(body);
  const existing = await getPlayerInOrg({ orgId, playerId, adminClient });
  if (!existing) throw typedError('Player not found', 404);

  const { data, error } = await adminClient
    .from('hs_players')
    .update(patch)
    .eq('org_id', orgId)
    .eq('id', playerId)
    .select(PLAYER_SELECT_COLUMNS)
    .single();
  if (error) return mapWriteError(error, { conflictMessage: 'Unable to update player.' });
  return data;
}

// Escapes PostgREST ilike wildcard/separator characters in free-text search
// input -- identical convention to admin-api.js's own escapeIlike, applied
// here so a search string containing %, _, or , can't alter the query shape.
function escapeIlike(s) {
  return String(s).replace(/[%_,]/g, (m) => '\\' + m);
}

async function listPlayers({ orgId, search, adminClient }) {
  let query = adminClient
    .from('hs_players')
    .select(PLAYER_SELECT_COLUMNS)
    .eq('org_id', orgId)
    .order('last_name')
    .order('first_name');
  const trimmed = typeof search === 'string' ? search.trim() : '';
  if (trimmed) {
    const escaped = escapeIlike(trimmed);
    query = query.or(`first_name.ilike.%${escaped}%,last_name.ilike.%${escaped}%,preferred_name.ilike.%${escaped}%`);
  }
  const { data, error } = await query;
  if (error) { console.error('[high-school-roster-service] player list failed:', error); throw typedError('Something went wrong. Please try again.', 500); }
  return data || [];
}

// ── Roster memberships ──────────────────────────────────────────────────

function validateRosterAdd(body) {
  rejectUnknownFields(body, ['playerId', 'seasonId', 'jerseyNumber']);
  requireUuid(body?.playerId, 'playerId');
  requireUuid(body?.seasonId, 'seasonId');
  const jerseyNumber = optionalString(body?.jerseyNumber, 'jerseyNumber');
  return { playerId: body.playerId, seasonId: body.seasonId, jerseyNumber };
}

function validateRosterUpdate(body) {
  rejectUnknownFields(body, ['jerseyNumber', 'status']);
  const patch = {};
  if (body?.jerseyNumber !== undefined) patch.jersey_number = optionalString(body.jerseyNumber, 'jerseyNumber');
  if (body?.status !== undefined) {
    if (!ROSTER_STATUSES.includes(body.status)) {
      throw typedError(`status must be one of: ${ROSTER_STATUSES.join(', ')}`, 400);
    }
    patch.status = body.status;
  }
  if (Object.keys(patch).length === 0) {
    throw typedError('At least one field must be provided.', 400);
  }
  return patch;
}

function toRosterMembershipResponse(row) {
  return {
    membershipId: row.id,
    teamId: row.team_id,
    seasonId: row.season_id,
    playerId: row.player_id,
    jerseyNumber: row.jersey_number,
    status: row.status,
  };
}

// Adds an existing player to a team for a given season. Team, player, and
// season ownership are each independently re-checked here via their own
// org-scoped lookup -- not merely trusted from a caller that may have
// already fetched one of them for its own purposes -- so a foreign-org id
// supplied for any of the three can never be linked, regardless of what the
// caller already validated (the same "defense in depth is two-sided, not
// one-sided" reasoning src/admin-product-route.js documents for its own
// duplicated checks).
//
// Both the team and the player must currently be active. An archived
// (is_active=false) team or non-active player is still fully readable --
// nothing here hides it -- but new roster memberships are exactly the kind
// of write an archival flag exists to prevent going forward; both
// hs_teams.is_active and hs_players.is_active already exist for this in the
// deployed schema, so this is enforced in application code, not a new
// migration. player.is_active is always correctly populated by
// getPlayerInOrg as the real generated column (status = 'active'). Seasons
// have no is_active column at all (see high-school-roster-service's own
// header/PR notes), so no equivalent check exists for season -- there is
// nothing to check.
async function addRosterMembership({ orgId, teamId, body, adminClient }) {
  const validated = validateRosterAdd(body);

  const [team, player, season] = await Promise.all([
    getTeamInOrg({ orgId, teamId, adminClient }),
    getPlayerInOrg({ orgId, playerId: validated.playerId, adminClient }),
    getSeasonInOrg({ orgId, seasonId: validated.seasonId, adminClient }),
  ]);
  if (!team) throw typedError('Team not found', 404);
  if (!team.is_active) throw typedError('Cannot add a roster membership to an inactive team.', 409);
  if (!player) throw typedError('Player not found', 404);
  if (!player.is_active) throw typedError('Cannot add an inactive player to a roster.', 409);
  if (!season) throw typedError('Season not found', 404);

  const { data, error } = await adminClient
    .from('hs_roster_memberships')
    .insert({
      org_id: orgId,
      team_id: teamId,
      player_id: validated.playerId,
      season_id: validated.seasonId,
      jersey_number: validated.jerseyNumber,
    })
    .select('id, team_id, season_id, player_id, jersey_number, status')
    .single();
  if (error) return mapWriteError(error, { conflictMessage: 'This player is already on this team for this season.' });
  return toRosterMembershipResponse(data);
}

async function getMembershipInOrgAndTeam({ orgId, teamId, membershipId, adminClient }) {
  requireUuid(membershipId, 'membershipId');
  const { data, error } = await adminClient
    .from('hs_roster_memberships')
    .select('id, team_id, season_id, player_id, jersey_number, status')
    .eq('id', membershipId)
    .eq('org_id', orgId)
    .eq('team_id', teamId)
    .maybeSingle();
  if (error) { console.error('[high-school-roster-service] membership lookup failed:', error); throw typedError('Something went wrong. Please try again.', 500); }
  return data;
}

async function updateRosterMembership({ orgId, teamId, membershipId, body, adminClient }) {
  requireUuid(membershipId, 'membershipId');
  const patch = validateRosterUpdate(body);
  const existing = await getMembershipInOrgAndTeam({ orgId, teamId, membershipId, adminClient });
  if (!existing) throw typedError('Roster membership not found', 404);

  const { data, error } = await adminClient
    .from('hs_roster_memberships')
    .update(patch)
    .eq('org_id', orgId)
    .eq('team_id', teamId)
    .eq('id', membershipId)
    .select('id, team_id, season_id, player_id, jersey_number, status')
    .single();
  if (error) return mapWriteError(error, { conflictMessage: 'Unable to update roster membership.' });
  return toRosterMembershipResponse(data);
}

// "Remove" is always a soft update to status='inactive', never a row
// DELETE -- matches src/high-school-importer-contract.js's own documented
// reconciliation policy ("Membership rows never appear in a 'delete' list")
// so historical roster membership is preserved by construction, the same
// way a future importer's own writes will behave.
async function removeRosterMembership({ orgId, teamId, membershipId, adminClient }) {
  requireUuid(membershipId, 'membershipId');
  const existing = await getMembershipInOrgAndTeam({ orgId, teamId, membershipId, adminClient });
  if (!existing) throw typedError('Roster membership not found', 404);

  const { data, error } = await adminClient
    .from('hs_roster_memberships')
    .update({ status: 'inactive' })
    .eq('org_id', orgId)
    .eq('team_id', teamId)
    .eq('id', membershipId)
    .select('id, team_id, season_id, player_id, jersey_number, status')
    .single();
  if (error) return mapWriteError(error, { conflictMessage: 'Unable to remove roster membership.' });
  return toRosterMembershipResponse(data);
}

module.exports = {
  UUID_RE,
  TEAM_LEVELS,
  ROSTER_STATUSES,
  PLAYER_STATUSES,
  legacyIsActiveToStatus,
  isActiveAgreesWithStatus,
  resolvePlayerStatusInput,
  isValidUuid,
  requireUuid,
  typedError,
  validateProgramCreate,
  validateProgramUpdate,
  validateSeasonCreate,
  validateSeasonUpdate,
  validateTeamCreate,
  validateTeamUpdate,
  validatePlayerCreate,
  validatePlayerUpdate,
  validateRosterAdd,
  validateRosterUpdate,
  createProgram,
  updateProgram,
  createSeason,
  updateSeason,
  getSeasonInOrg,
  createTeam,
  updateTeam,
  getTeamInOrg,
  createPlayer,
  updatePlayer,
  getPlayerInOrg,
  listPlayers,
  addRosterMembership,
  updateRosterMembership,
  removeRosterMembership,
  getMembershipInOrgAndTeam,
};
