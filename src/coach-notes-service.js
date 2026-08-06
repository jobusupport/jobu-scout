'use strict';

// Write-side business logic for coach scouting notes on an opponent
// (Travel domain). Mirrors src/high-school-roster-service.js's established
// shape: pure validation + injected-adminClient orchestration.
//
// A note is scoped to an opponent team (required), and optionally to a
// specific opponent player and/or game -- see
// supabase/migrations/20260806031303_create_opponent_intelligence_domain.sql's
// header for why a "play/situation" observation is just a game-scoped note
// whose text names the specific play, rather than a fifth structural level.
//
// `include_in_report` and `is_archived` are independent: archiving is "this
// note was wrong," excluding is "still true, not for this specific
// report." Both default to the safe, useful choice (included, not
// archived) so a coach never has to remember to opt a note in.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_CATEGORIES = [
  'lineup', 'hitting_approach', 'pitching', 'defense', 'baserunning',
  'tendencies', 'personnel', 'injury_availability', 'situational', 'general',
];
const NOTE_TEXT_MAX_LENGTH = 4000;

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

function optionalUuid(value, fieldName) {
  if (value === undefined || value === null) return null;
  requireUuid(value, fieldName);
  return value;
}

function rejectUnknownFields(body, allowedKeys) {
  const present = Object.keys(body || {});
  const unknown = present.filter((k) => !allowedKeys.includes(k));
  if (unknown.length > 0) {
    throw typedError(`Unknown field(s): ${unknown.join(', ')}`, 400);
  }
}

// Server-side validation: rejects blank/whitespace-only text and anything
// over the same 4000-char limit the database itself enforces (this check
// exists so a caller gets a clean 400 instead of a raw 23514 from
// Postgres, not as a substitute for the DB constraint).
function requireNoteText(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw typedError('note_text is required and must be a non-empty string', 400);
  }
  const trimmed = value.trim();
  if (trimmed.length > NOTE_TEXT_MAX_LENGTH) {
    throw typedError(`note_text must be ${NOTE_TEXT_MAX_LENGTH} characters or fewer`, 400);
  }
  return trimmed;
}

function optionalCategory(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !NOTE_CATEGORIES.includes(value)) {
    throw typedError(`category must be one of: ${NOTE_CATEGORIES.join(', ')}`, 400);
  }
  return value;
}

function optionalDate(value, fieldName) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw typedError(`${fieldName} must be a valid YYYY-MM-DD date`, 400);
  }
  return value;
}

function optionalBoolean(value, fieldName) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw typedError(`${fieldName} must be a boolean`, 400);
  }
  return value;
}

const NOTE_SELECT_COLUMNS = 'id, org_id, author_user_id, opponent_team_id, opponent_player_id, game_id, observed_game_date, note_text, category, include_in_report, is_archived, created_at, updated_at';

const NOTE_CREATE_FIELDS = ['opponent_player_id', 'game_id', 'observed_game_date', 'note_text', 'category'];
const NOTE_UPDATE_FIELDS = ['note_text', 'category', 'include_in_report'];

function validateNoteCreate(body) {
  rejectUnknownFields(body, NOTE_CREATE_FIELDS);
  const note_text = requireNoteText(body?.note_text);
  const opponent_player_id = optionalUuid(body?.opponent_player_id, 'opponent_player_id');
  const game_id = optionalUuid(body?.game_id, 'game_id');
  const observed_game_date = optionalDate(body?.observed_game_date, 'observed_game_date');
  const category = optionalCategory(body?.category);
  return { note_text, opponent_player_id, game_id, observed_game_date, category };
}

function validateNoteUpdate(body) {
  rejectUnknownFields(body, NOTE_UPDATE_FIELDS);
  const patch = {};
  if (body?.note_text !== undefined) patch.note_text = requireNoteText(body.note_text);
  if (body?.category !== undefined) patch.category = optionalCategory(body.category);
  const includeInReport = optionalBoolean(body?.include_in_report, 'include_in_report');
  if (includeInReport !== undefined) patch.include_in_report = includeInReport;
  if (Object.keys(patch).length === 0) {
    throw typedError('At least one field must be provided.', 400);
  }
  return patch;
}

async function getOpponentTeamInOrg({ orgId, opponentTeamId, adminClient }) {
  requireUuid(opponentTeamId, 'opponentTeamId');
  const { data, error } = await adminClient
    .from('teams')
    .select('id, org_id, team_name, is_our_team')
    .eq('id', opponentTeamId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) { console.error('[coach-notes-service] team lookup failed:', error); throw typedError('Something went wrong. Please try again.', 500); }
  return data;
}

// Verifies playerId is an opponent_players row belonging to BOTH orgId
// and opponentTeamId. The org half is already enforced by
// coach_scouting_notes_org_player_fkey (a composite FK against
// opponent_players(org_id, id)), but that constraint has no way to also
// require the SAME opponent team as the note's own opponent_team_id --
// without this check, a note could reference a player who belongs to a
// DIFFERENT opponent within the same org (still no cross-org leak, since
// both ids stay org-scoped, but a real cross-opponent data-consistency
// gap: the note would list under one opponent while its player-scope
// pointed at a different one).
async function requirePlayerBelongsToOpponentTeam({ orgId, opponentTeamId, playerId, adminClient }) {
  const { data, error } = await adminClient
    .from('opponent_players')
    .select('id')
    .eq('id', playerId)
    .eq('org_id', orgId)
    .eq('team_id', opponentTeamId)
    .maybeSingle();
  if (error) { console.error('[coach-notes-service] player-team ownership check failed:', error); throw typedError('Something went wrong. Please try again.', 500); }
  if (!data) throw typedError('opponent_player_id must belong to the selected opponent team.', 400);
}

async function createNote({ orgId, authorUserId, opponentTeamId, body, adminClient }) {
  requireUuid(authorUserId, 'authorUserId');
  const team = await getOpponentTeamInOrg({ orgId, opponentTeamId, adminClient });
  if (!team) throw typedError('Opponent team not found', 404);

  const validated = validateNoteCreate(body);
  if (validated.opponent_player_id) {
    await requirePlayerBelongsToOpponentTeam({ orgId, opponentTeamId, playerId: validated.opponent_player_id, adminClient });
  }
  const { data, error } = await adminClient
    .from('coach_scouting_notes')
    .insert({
      org_id: orgId,
      author_user_id: authorUserId,
      opponent_team_id: opponentTeamId,
      ...validated,
    })
    .select(NOTE_SELECT_COLUMNS)
    .single();
  if (error) { console.error('[coach-notes-service] create failed:', error); throw typedError('Something went wrong. Please try again.', 500); }
  return data;
}

async function getNoteInOrg({ orgId, noteId, adminClient }) {
  requireUuid(noteId, 'noteId');
  const { data, error } = await adminClient
    .from('coach_scouting_notes')
    .select(NOTE_SELECT_COLUMNS)
    .eq('id', noteId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) { console.error('[coach-notes-service] note lookup failed:', error); throw typedError('Something went wrong. Please try again.', 500); }
  return data;
}

async function updateNote({ orgId, noteId, body, adminClient }) {
  const patch = validateNoteUpdate(body);
  const existing = await getNoteInOrg({ orgId, noteId, adminClient });
  if (!existing) throw typedError('Note not found', 404);
  if (existing.is_archived) throw typedError('Cannot edit an archived note.', 409);

  const { data, error } = await adminClient
    .from('coach_scouting_notes')
    .update(patch)
    .eq('org_id', orgId)
    .eq('id', noteId)
    .select(NOTE_SELECT_COLUMNS)
    .single();
  if (error) { console.error('[coach-notes-service] update failed:', error); throw typedError('Something went wrong. Please try again.', 500); }
  return data;
}

// Soft-delete only -- an archived note is retained (author/timestamp/text
// intact) but excluded from report context (see listNotesForReportContext)
// and from normal edit operations.
async function archiveNote({ orgId, noteId, adminClient }) {
  const existing = await getNoteInOrg({ orgId, noteId, adminClient });
  if (!existing) throw typedError('Note not found', 404);

  const { data, error } = await adminClient
    .from('coach_scouting_notes')
    .update({ is_archived: true })
    .eq('org_id', orgId)
    .eq('id', noteId)
    .select(NOTE_SELECT_COLUMNS)
    .single();
  if (error) { console.error('[coach-notes-service] archive failed:', error); throw typedError('Something went wrong. Please try again.', 500); }
  return data;
}

async function setNoteIncludeInReport({ orgId, noteId, include, adminClient }) {
  requireUuid(noteId, 'noteId');
  if (typeof include !== 'boolean') throw typedError('include must be a boolean', 400);
  const existing = await getNoteInOrg({ orgId, noteId, adminClient });
  if (!existing) throw typedError('Note not found', 404);

  const { data, error } = await adminClient
    .from('coach_scouting_notes')
    .update({ include_in_report: include })
    .eq('org_id', orgId)
    .eq('id', noteId)
    .select(NOTE_SELECT_COLUMNS)
    .single();
  if (error) { console.error('[coach-notes-service] include-toggle failed:', error); throw typedError('Something went wrong. Please try again.', 500); }
  return data;
}

// Full note list for the opponent-team management UI (shows author,
// updated-at, and both include/archive states so a coach can see what will
// and won't be sent to Claude -- see src/analyzer.js's
// buildCoachIntelligenceBlock for the consumer of the report-context
// subset of this same data).
async function listNotesForTeam({ orgId, opponentTeamId, adminClient, includeArchived = false }) {
  requireUuid(opponentTeamId, 'opponentTeamId');
  let query = adminClient
    .from('coach_scouting_notes')
    .select(NOTE_SELECT_COLUMNS)
    .eq('org_id', orgId)
    .eq('opponent_team_id', opponentTeamId)
    .order('updated_at', { ascending: false });
  if (!includeArchived) query = query.eq('is_archived', false);
  const { data, error } = await query;
  if (error) { console.error('[coach-notes-service] list failed:', error); throw typedError('Something went wrong. Please try again.', 500); }
  return data || [];
}

module.exports = {
  NOTE_CATEGORIES,
  NOTE_TEXT_MAX_LENGTH,
  isValidUuid,
  requireUuid,
  typedError,
  validateNoteCreate,
  validateNoteUpdate,
  getOpponentTeamInOrg,
  requirePlayerBelongsToOpponentTeam,
  createNote,
  getNoteInOrg,
  updateNote,
  archiveNote,
  setNoteIncludeInReport,
  listNotesForTeam,
};
