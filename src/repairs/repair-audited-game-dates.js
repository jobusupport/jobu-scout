'use strict';

/**
 * repair-audited-game-dates.js
 *
 * Surgical, dry-run-first repair tool for the EXACT 13 games identified by
 * the read-only production game-date audit (game-date-production-audit.md /
 * game-date-remediation-manifest.json). It operates ONLY on the game IDs
 * listed in ./audited-game-dates-2026-07-24.allowlist.json -- it never
 * scans production for additional candidates, never widens the target set,
 * and never touches either of the two legitimately-correct "May 24" games
 * for the same team.
 *
 * This is NOT a general date-cleanup utility. If you are looking at this
 * file to fix a different set of games, write a new, separately-audited
 * allowlist and a new task -- do not broaden this one.
 *
 * IMPORTANT: this local allowlist file is a preflight/reporting aid for the
 * operator running this CLI -- it is NOT the security boundary. The actual
 * enforcement lives entirely inside the Postgres function
 * (supabase/migrations/20260724000000_repair_audited_game_dates_fn.sql),
 * which hardcodes the same 13-record mapping as an immutable literal and
 * accepts only a `repair`/`rollback` operation name -- no game ID, date, or
 * count is ever accepted from any caller, including this script. A caller
 * invoking that RPC directly, bypassing this CLI entirely, cannot widen or
 * alter the repair scope under any input.
 *
 * Usage:
 *   node src/repairs/repair-audited-game-dates.js                                        (dry-run, default)
 *   node src/repairs/repair-audited-game-dates.js --dry-run                               (dry-run, explicit)
 *   node src/repairs/repair-audited-game-dates.js --apply --confirm-production-game-date-repair
 *   node src/repairs/repair-audited-game-dates.js --rollback                              (rollback dry-run)
 *   node src/repairs/repair-audited-game-dates.js --rollback --apply --confirm-production-game-date-rollback
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment
 * (the same variables src/supabase.js already reads). Does NOT call
 * db.init() or any other code path that runs migrations, sets pragmas, or
 * otherwise mutates storage merely by starting up -- see src/supabase.js,
 * which is just `createClient(url, key)`.
 */

const fs = require('fs');
const path = require('path');

const ALLOWLIST_PATH = path.join(__dirname, 'audited-game-dates-2026-07-24.allowlist.json');
const EXPECTED_RECORD_COUNT = 13;
const EXPECTED_TEAM_ID = '8058e65c-254a-40f0-a2e4-64833f6ff30e';
const LEGITIMATE_EXCLUDED_IDS = [
  '0a37af14-509a-4cb2-8229-87571fec0af9',
  'e191766e-1258-4485-b48d-96aa3932d183',
];
const RPC_NAME = 'repair_audited_game_dates';

// ── Argument parsing ────────────────────────────────────────────────────────
// Pure function: no I/O, easy to test exhaustively. Fails CLOSED on any
// unrecognized flag or contradictory combination -- there is no default
// interpretation for an ambiguous invocation other than refusing to run.

function parseArgs(argv) {
  const known = new Set(['--dry-run', '--apply', '--confirm-production-game-date-repair', '--rollback', '--confirm-production-game-date-rollback']);
  const flags = new Set(argv);

  for (const arg of argv) {
    if (!known.has(arg)) {
      return { ok: false, error: `Unknown argument: ${arg}` };
    }
  }

  const dryRun = flags.has('--dry-run');
  const apply = flags.has('--apply');
  const confirmRepair = flags.has('--confirm-production-game-date-repair');
  const rollback = flags.has('--rollback');
  const confirmRollback = flags.has('--confirm-production-game-date-rollback');

  if (dryRun && apply) {
    return { ok: false, error: '--dry-run and --apply are mutually exclusive.' };
  }
  if (apply && !rollback && confirmRollback) {
    return { ok: false, error: '--confirm-production-game-date-rollback is only valid with --rollback.' };
  }
  if (rollback && confirmRepair) {
    return { ok: false, error: '--confirm-production-game-date-repair is only valid without --rollback.' };
  }
  if (!apply && (confirmRepair || confirmRollback)) {
    return { ok: false, error: 'A confirmation flag was given without --apply. Confirmation alone never triggers a write.' };
  }
  if (apply && !rollback && !confirmRepair) {
    return { ok: false, error: '--apply requires --confirm-production-game-date-repair.' };
  }
  if (apply && rollback && !confirmRollback) {
    return { ok: false, error: '--apply --rollback requires --confirm-production-game-date-rollback.' };
  }

  // No arguments, or --dry-run alone, or --rollback alone (rollback's own
  // default is also dry-run) -- every non-apply path is read-only.
  const mode = rollback
    ? (apply ? 'rollback-apply' : 'rollback-dry-run')
    : (apply ? 'repair-apply' : 'repair-dry-run');

  return { ok: true, mode };
}

// ── Allowlist loading + structural validation ───────────────────────────────
// Pure (given file contents); fails closed on anything malformed rather than
// guessing at a "best effort" interpretation.

// A plain /^\d{4}-\d{2}-\d{2}$/ shape check would accept a syntactically
// ISO-shaped but calendar-impossible date like "2026-02-30" -- Postgres's
// own ::date cast would reject that at write time (a real safety net for
// the hardcoded SQL values, already independently verified), but this
// function validates the LOCAL allowlist FILE's data quality, and should
// catch the same class of defect before it ever reaches that point. Round-
// tripping through UTC midnight and comparing the ISO-date slice back
// against the input catches exactly this: `new Date('2026-02-30T00:00:00Z')`
// silently normalizes to March 2, so the round-trip fails.
function isValidCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function validateAllowlistStructure(allowlist) {
  const errors = [];
  if (!allowlist || typeof allowlist !== 'object') {
    return ['allowlist is not a JSON object'];
  }
  if (!Array.isArray(allowlist.records)) {
    return ['allowlist.records is not an array'];
  }
  if (allowlist.records.length !== EXPECTED_RECORD_COUNT) {
    errors.push(`expected exactly ${EXPECTED_RECORD_COUNT} records, found ${allowlist.records.length}`);
  }

  const gameIds = new Set();
  const gcGameIds = new Set();
  const dupGameIds = new Set();
  const dupGcGameIds = new Set();

  for (const [i, rec] of allowlist.records.entries()) {
    const prefix = `record[${i}]`;
    if (!rec || typeof rec !== 'object') { errors.push(`${prefix} is not an object`); continue; }
    for (const field of ['gameId', 'gcGameId', 'teamId', 'oldDate', 'newDate', 'rawDateTime']) {
      if (typeof rec[field] !== 'string' || !rec[field]) errors.push(`${prefix}.${field} is missing or not a non-empty string`);
    }
    if (rec.teamId && rec.teamId !== EXPECTED_TEAM_ID) errors.push(`${prefix}.teamId is not the audited team ID`);
    if (rec.oldDate && rec.oldDate !== '2026-05-24') errors.push(`${prefix}.oldDate is not the audited stored date`);
    if (rec.newDate && !isValidCalendarDate(rec.newDate)) errors.push(`${prefix}.newDate is not a valid ISO calendar date`);
    if (rec.gameId && LEGITIMATE_EXCLUDED_IDS.includes(rec.gameId)) errors.push(`${prefix}.gameId is one of the two legitimate May-24 games -- must never be targeted`);

    if (rec.gameId) { if (gameIds.has(rec.gameId)) dupGameIds.add(rec.gameId); gameIds.add(rec.gameId); }
    if (rec.gcGameId) { if (gcGameIds.has(rec.gcGameId)) dupGcGameIds.add(rec.gcGameId); gcGameIds.add(rec.gcGameId); }
  }

  for (const id of dupGameIds) errors.push(`duplicate gameId: ${id}`);
  for (const id of dupGcGameIds) errors.push(`duplicate gcGameId: ${id}`);

  return errors;
}

function loadAllowlist(allowlistPath = ALLOWLIST_PATH) {
  if (!fs.existsSync(allowlistPath)) {
    return { ok: false, error: `Allowlist not found at ${allowlistPath}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
  } catch (e) {
    return { ok: false, error: `Allowlist is not valid JSON: ${e.message}` };
  }
  const errors = validateAllowlistStructure(parsed);
  if (errors.length) {
    return { ok: false, error: `Allowlist failed validation:\n  - ${errors.join('\n  - ')}` };
  }
  return { ok: true, allowlist: parsed };
}

// ── Precondition checking (pure, given a fetched current-row snapshot) ─────

function checkPrecondition(record, currentRow, parserDerivedDate, { skipParserCheck = false } = {}) {
  if (!currentRow) return { pass: false, reason: 'game_not_found' };
  if (currentRow.gc_game_id !== record.gcGameId) return { pass: false, reason: 'gc_game_id_mismatch' };
  if (currentRow.our_team_id !== record.teamId) return { pass: false, reason: 'team_id_mismatch' };
  if (currentRow.game_date !== record.oldDate) return { pass: false, reason: 'current_game_date_mismatch' };
  if (currentRow.game_datetime_raw !== record.rawDateTime) return { pass: false, reason: 'raw_evidence_mismatch' };
  // The "parser still derives the proposed date" check only makes sense for
  // the FORWARD repair direction -- it verifies the correction is still
  // what the current parser says is right. A rollback deliberately restores
  // the old, WRONG value (that's the entire point of undoing a repair), so
  // the parser will never agree with it by construction; skip this check
  // for rollback rather than have it always fail rollback preconditions.
  if (!skipParserCheck && parserDerivedDate !== record.newDate) return { pass: false, reason: 'parser_no_longer_derives_proposed_date' };
  return { pass: true, reason: null };
}

// ── Idempotency state classification (pure) ─────────────────────────────────

function classifyRecordState(record, currentRow) {
  if (!currentRow) return 'unexpected';
  if (currentRow.game_date === record.oldDate) return 'pre_repair';
  if (currentRow.game_date === record.newDate) return 'already_repaired';
  return 'unexpected';
}

function classifyOverallState(perRecordStates) {
  const states = new Set(perRecordStates);
  if (states.size === 1 && states.has('pre_repair')) return 'pre_repair';
  if (states.size === 1 && states.has('already_repaired')) return 'already_repaired';
  if (states.has('unexpected')) return 'unexpected';
  return 'mixed';
}

// ── RPC payload construction (pure) ─────────────────────────────────────────

function buildRpcRecords(allowlistRecords) {
  return allowlistRecords.map(r => ({
    gameId: r.gameId, gcGameId: r.gcGameId, teamId: r.teamId,
    oldDate: r.oldDate, newDate: r.newDate, rawDateTime: r.rawDateTime,
  }));
}

function buildRollbackRpcRecords(allowlistRecords) {
  // Rollback is the mirror image: restore oldDate, verify against newDate.
  return allowlistRecords.map(r => ({
    gameId: r.gameId, gcGameId: r.gcGameId, teamId: r.teamId,
    oldDate: r.newDate, newDate: r.oldDate, rawDateTime: r.rawDateTime,
  }));
}

// ── Redaction helper for anything printed ───────────────────────────────────

function redactProjectRef(supabaseUrl) {
  const m = String(supabaseUrl || '').match(/^https:\/\/([a-z0-9]+)\.supabase\.co/);
  return m ? `supabase project ref: ${m[1]}` : 'supabase project ref: (unrecognized URL shape, not printed)';
}

// ── I/O layer: fetching current rows + cache counts + calling the RPC ──────
// Every function here takes an injected `client` (anything exposing
// `.from()` and `.rpc()`, matching @supabase/supabase-js's shape) so tests
// never need a real database -- only `.select()` and, in apply mode, the
// single `.rpc()` call are ever used; no `.insert()/.update()/.upsert()/
// .delete()` call exists anywhere in this file.

async function fetchCurrentRows(client, gameIds) {
  const { data, error } = await client
    .from('games')
    .select('id, gc_game_id, our_team_id, game_date, game_time, game_datetime_raw')
    .in('id', gameIds);
  if (error) throw new Error(`Failed to fetch current game rows: ${error.message}`);
  const byId = new Map();
  for (const row of data || []) byId.set(row.id, row);
  return byId;
}

async function fetchCacheRowCount(client, gameIds) {
  const { count, error } = await client
    .from('game_stat_validation_results')
    .select('id', { count: 'exact', head: true })
    .in('game_id', gameIds);
  if (error) throw new Error(`Failed to count game_stat_validation_results rows: ${error.message}`);
  return count || 0;
}

async function evaluate(client, allowlist, parseDateTimeRaw, { isRollback = false } = {}) {
  const gameIds = allowlist.records.map(r => r.gameId);
  const currentById = await fetchCurrentRows(client, gameIds);
  const cacheRowCount = await fetchCacheRowCount(client, gameIds);

  const results = allowlist.records.map(record => {
    const currentRow = currentById.get(record.gameId) || null;
    const parserDerivedDate = currentRow ? (parseDateTimeRaw(currentRow.game_datetime_raw).date || null) : null;
    const precondition = checkPrecondition(record, currentRow, parserDerivedDate, { skipParserCheck: isRollback });
    const state = classifyRecordState(record, currentRow);
    return { record, currentRow, parserDerivedDate, precondition, state };
  });

  const allPass = results.every(r => r.precondition.pass);
  const overallState = classifyOverallState(results.map(r => r.state));

  return { results, cacheRowCount, allPass, overallState, matchedCount: [...currentById.keys()].length };
}

// ── Reporting (pure formatting, no I/O) ─────────────────────────────────────

function formatReport({ mode, supabaseUrl, allowlistPath, evaluation, wouldWrite }) {
  const lines = [];
  lines.push(`mode: ${mode}`);
  lines.push(redactProjectRef(supabaseUrl));
  lines.push(`allowlist: ${allowlistPath} (manifestVersion=${evaluation.manifestVersion || 'unknown'})`);
  lines.push(`expected target count: ${EXPECTED_RECORD_COUNT}`);
  lines.push(`actual matched target count: ${evaluation.matchedCount}`);
  lines.push('');
  for (const r of evaluation.results) {
    const status = r.precondition.pass ? 'PASS' : `FAIL (${r.precondition.reason})`;
    lines.push(`  ${r.record.gameId}: ${status} | current=${r.currentRow ? r.currentRow.game_date : 'N/A'} -> proposed=${r.record.newDate} | state=${r.state}`);
  }
  lines.push('');
  lines.push(`associated game_stat_validation_results rows for these ${EXPECTED_RECORD_COUNT} games: ${evaluation.cacheRowCount}`);
  lines.push('planned cache treatment: leave existing validation-run rows untouched (append-only historical log; no code path updates or deletes them; re-run src/validate-team-stats.js separately afterward to produce fresh, correctly-dated rows)');
  lines.push(`overall state: ${evaluation.overallState}`);
  lines.push(`all preconditions pass: ${evaluation.allPass}`);
  lines.push(`repair would be allowed: ${evaluation.allPass && evaluation.overallState === 'pre_repair'}`);
  lines.push('');
  lines.push(wouldWrite ? 'APPLY MODE -- see below for write result.' : 'NO WRITES WERE PERFORMED. This was a read-only dry-run.');
  return lines.join('\n');
}

// ── Main orchestration (I/O; the only part not directly unit-tested) ───────

async function run({ argv, client, parseDateTimeRaw, supabaseUrl, allowlistPath = ALLOWLIST_PATH, log = console.log }) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    log(`ERROR: ${parsed.error}`);
    return { exitCode: 1 };
  }

  const loaded = loadAllowlist(allowlistPath);
  if (!loaded.ok) {
    log(`ERROR: ${loaded.error}`);
    return { exitCode: 1 };
  }
  const allowlist = loaded.allowlist;
  const isRollback = parsed.mode.startsWith('rollback');
  const records = isRollback ? buildRollbackRpcRecords(allowlist.records) : buildRpcRecords(allowlist.records);
  const workingAllowlist = { ...allowlist, records };

  const evaluation = await evaluate(client, workingAllowlist, parseDateTimeRaw, { isRollback });
  evaluation.manifestVersion = allowlist.manifestVersion;

  const wouldWrite = parsed.mode === 'repair-apply' || parsed.mode === 'rollback-apply';
  log(formatReport({ mode: parsed.mode, supabaseUrl, allowlistPath, evaluation, wouldWrite }));

  if (!wouldWrite) {
    if (evaluation.overallState === 'already_repaired' && !isRollback) {
      log('\nAll records are already in the repaired state. No action needed.');
    }
    return { exitCode: evaluation.allPass || evaluation.overallState === 'already_repaired' ? 0 : 1 };
  }

  // ── Apply path ──────────────────────────────────────────────────────────
  if (evaluation.overallState === 'already_repaired') {
    log('\nAll records already match the target state -- no writes performed (idempotent no-op).');
    return { exitCode: 0 };
  }
  if (evaluation.overallState !== 'pre_repair') {
    log(`\nABORTED: overall state is "${evaluation.overallState}", not the expected pre-repair state. No writes performed.`);
    return { exitCode: 1 };
  }
  if (!evaluation.allPass) {
    log('\nABORTED: one or more preconditions failed. No writes performed.');
    return { exitCode: 1 };
  }

  // Re-fetch and re-check immediately before the transaction, per the
  // required "abort if anything changed since dry-run" behavior.
  const reEvaluation = await evaluate(client, workingAllowlist, parseDateTimeRaw, { isRollback });
  if (!reEvaluation.allPass || reEvaluation.overallState !== 'pre_repair') {
    log('\nABORTED: production state changed since the pre-apply check. No writes performed. Re-run dry-run and investigate before retrying.');
    return { exitCode: 1 };
  }

  // The RPC's ONLY parameter is the operation name -- the exact 13-record
  // before/after mapping lives hardcoded inside the Postgres function
  // itself (supabase/migrations/20260724000000_repair_audited_game_dates_fn.sql),
  // not in this payload. `records`/`workingAllowlist` above exist purely
  // for this CLI's own local preflight reporting to the operator -- they
  // are never sent to the database. The database independently enforces
  // the exact audited scope regardless of what this script does or does
  // not check; a caller invoking this RPC directly, bypassing this CLI
  // entirely, cannot influence which games or which dates are touched.
  const rpcOperation = isRollback ? 'rollback' : 'repair';
  const { data, error } = await client.rpc(RPC_NAME, { p_operation: rpcOperation });
  if (error) {
    log(`\nABORTED: RPC call failed, no changes were committed (the function rolled back internally): ${error.message}`);
    return { exitCode: 1 };
  }
  if (!data || data.updatedCount !== EXPECTED_RECORD_COUNT) {
    log(`\nHARD FAILURE: expected updatedCount=${EXPECTED_RECORD_COUNT}, RPC returned ${JSON.stringify(data)}. Investigate immediately -- this should be unreachable given the RPC's own internal assertion.`);
    return { exitCode: 1 };
  }

  const postEvaluation = await evaluate(client, workingAllowlist, parseDateTimeRaw, { isRollback });
  const allNowRepaired = postEvaluation.results.every(r => r.currentRow && r.currentRow.game_date === r.record.newDate);
  log(`\nPost-write verification: ${allNowRepaired ? 'PASS' : 'FAIL'} -- all ${EXPECTED_RECORD_COUNT} rows now show the proposed date.`);
  for (const r of postEvaluation.results) {
    log(`  ${r.record.gameId}: ${r.record.oldDate} -> ${r.currentRow ? r.currentRow.game_date : 'N/A'}`);
  }

  return { exitCode: allNowRepaired ? 0 : 1 };
}

module.exports = {
  parseArgs,
  isValidCalendarDate,
  validateAllowlistStructure,
  loadAllowlist,
  checkPrecondition,
  classifyRecordState,
  classifyOverallState,
  buildRpcRecords,
  buildRollbackRpcRecords,
  redactProjectRef,
  formatReport,
  evaluate,
  run,
  ALLOWLIST_PATH,
  EXPECTED_RECORD_COUNT,
  EXPECTED_TEAM_ID,
  LEGITIMATE_EXCLUDED_IDS,
  RPC_NAME,
};

if (require.main === module) {
  require('dotenv').config();
  const { adminClient } = require('../supabase');
  const { parseDateTimeRaw } = require('../normalizer');

  run({
    argv: process.argv.slice(2),
    client: adminClient,
    parseDateTimeRaw,
    supabaseUrl: process.env.SUPABASE_URL,
  }).then(({ exitCode }) => process.exit(exitCode)).catch(err => {
    console.error('FATAL:', err.stack || err.message || err);
    process.exit(1);
  });
}
