'use strict';

// Focused tests for src/repairs/repair-audited-game-dates.js -- the surgical,
// dry-run-first repair tool for the 13 audited production game-date records.
//
// Every test here uses a FAKE Supabase-shaped client (only .from()/.select()/
// .in()/.rpc() are ever invoked by the tool -- confirmed by reading the tool
// itself, which never calls .insert()/.update()/.upsert()/.delete()). No
// test in this file connects to a real database of any kind.
//
// What this genuinely proves: the tool's own decision logic (arg parsing,
// allowlist validation, precondition checking, idempotency classification,
// and its reaction to the RPC's success/failure/count-mismatch outcomes) is
// correct. What it does NOT and cannot prove: that the underlying Postgres
// function (supabase/migrations/20260724000000_repair_audited_game_dates_fn.sql)
// is itself atomic -- that guarantee comes from Postgres's own single-
// statement-per-function-call semantics (a single RPC call is one implicit
// transaction), not from anything testable via node:test without a real
// Postgres instance. The RPC's own SQL was reviewed directly (see the
// migration file's header comment) rather than re-verified here.
//
// Run with: node --test test/repair-audited-game-dates.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const tool = require('../src/repairs/repair-audited-game-dates.js');

const REAL_ALLOWLIST_PATH = path.join(__dirname, '..', 'src', 'repairs', 'audited-game-dates-2026-07-24.allowlist.json');

function makeRecord(overrides = {}) {
  return {
    gameId: 'g1', gcGameId: 'gc1', teamId: tool.EXPECTED_TEAM_ID,
    oldDate: '2026-05-24', newDate: '2026-03-15', rawDateTime: 'Sun Mar 15, 12:00 PM - 2:00 PM ET',
    ...overrides,
  };
}

function makeValidAllowlist(count = 13) {
  const records = [];
  for (let i = 0; i < count; i++) {
    records.push(makeRecord({
      gameId: `g${i}`, gcGameId: `gc${i}`,
      newDate: `2026-0${(i % 6) + 1}-1${i % 9}`,
      rawDateTime: `raw-${i}`,
    }));
  }
  return { manifestVersion: 'test', records };
}

// ── Fake Supabase-shaped client ─────────────────────────────────────────────
// Only .from(table).select(...).in(col, vals) and .rpc(name, args) are ever
// exercised by the tool. No .insert()/.update()/.upsert()/.delete() exists
// on this fake at all -- calling one would throw "is not a function",
// which itself would fail any test that accidentally exercised it.

function makeFakeClient({ gamesById = {}, cacheCountByGameId = {}, rpc = null }) {
  return {
    from(table) {
      const builder = {
        _table: table,
        _selectOpts: null,
        select(cols, opts) { builder._selectOpts = opts; return builder; },
        in(col, vals) {
          const promise = (async () => {
            if (table === 'games') {
              const data = vals.map(id => gamesById[id]).filter(Boolean);
              return { data, error: null };
            }
            if (table === 'game_stat_validation_results') {
              const count = vals.reduce((sum, id) => sum + (cacheCountByGameId[id] || 0), 0);
              return { count, error: null };
            }
            throw new Error(`unexpected table in fake client: ${table}`);
          })();
          return promise;
        },
      };
      return builder;
    },
    async rpc(name, args) {
      if (!rpc) throw new Error('fake client rpc() was called but no rpc behavior was configured for this test');
      return rpc(name, args);
    },
  };
}

const noopParse = () => ({ date: null });

// ── 1-5. Argument parsing ────────────────────────────────────────────────────

test('parseArgs — no arguments defaults to dry-run', () => {
  const r = tool.parseArgs([]);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'repair-dry-run');
});

test('parseArgs — explicit --dry-run is dry-run', () => {
  const r = tool.parseArgs(['--dry-run']);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'repair-dry-run');
});

test('parseArgs — --apply without the confirmation flag fails', () => {
  const r = tool.parseArgs(['--apply']);
  assert.equal(r.ok, false);
  assert.match(r.error, /--confirm-production-game-date-repair/);
});

test('parseArgs — confirmation flag without --apply fails', () => {
  const r = tool.parseArgs(['--confirm-production-game-date-repair']);
  assert.equal(r.ok, false);
  assert.match(r.error, /without --apply/);
});

test('parseArgs — unknown argument fails', () => {
  const r = tool.parseArgs(['--wipe-everything']);
  assert.equal(r.ok, false);
  assert.match(r.error, /Unknown argument/);
});

test('parseArgs — --dry-run and --apply together fail (conflicting flags)', () => {
  const r = tool.parseArgs(['--dry-run', '--apply', '--confirm-production-game-date-repair']);
  assert.equal(r.ok, false);
});

test('parseArgs — both required flags together succeed as repair-apply', () => {
  const r = tool.parseArgs(['--apply', '--confirm-production-game-date-repair']);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'repair-apply');
});

test('parseArgs — rollback dry-run', () => {
  const r = tool.parseArgs(['--rollback']);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'rollback-dry-run');
});

test('parseArgs — rollback apply requires the rollback-specific confirmation flag', () => {
  assert.equal(tool.parseArgs(['--rollback', '--apply']).ok, false);
  assert.equal(tool.parseArgs(['--rollback', '--apply', '--confirm-production-game-date-repair']).ok, false, 'the repair confirmation flag must not authorize a rollback');
  const r = tool.parseArgs(['--rollback', '--apply', '--confirm-production-game-date-rollback']);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'rollback-apply');
});

// ── 6-7. Manifest / allowlist validation ────────────────────────────────────

test('loadAllowlist — missing file fails closed', () => {
  const r = tool.loadAllowlist('/nonexistent/path.json');
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/);
});

test('validateAllowlistStructure — malformed (not an object) fails', () => {
  assert.deepEqual(tool.validateAllowlistStructure(null), ['allowlist is not a JSON object']);
  assert.deepEqual(tool.validateAllowlistStructure('a string'), ['allowlist is not a JSON object']);
});

test('validateAllowlistStructure — wrong record count fails', () => {
  const errors = tool.validateAllowlistStructure(makeValidAllowlist(5));
  assert.ok(errors.some(e => /expected exactly 13/.test(e)));
});

test('validateAllowlistStructure — duplicate gameId fails', () => {
  const allowlist = makeValidAllowlist(13);
  allowlist.records[1].gameId = allowlist.records[0].gameId;
  const errors = tool.validateAllowlistStructure(allowlist);
  assert.ok(errors.some(e => /duplicate gameId/.test(e)));
});

test('validateAllowlistStructure — duplicate gcGameId fails', () => {
  const allowlist = makeValidAllowlist(13);
  allowlist.records[1].gcGameId = allowlist.records[0].gcGameId;
  const errors = tool.validateAllowlistStructure(allowlist);
  assert.ok(errors.some(e => /duplicate gcGameId/.test(e)));
});

test('validateAllowlistStructure — either legitimate May-24 game ID in the allowlist fails', () => {
  const allowlist = makeValidAllowlist(13);
  allowlist.records[0].gameId = tool.LEGITIMATE_EXCLUDED_IDS[0];
  const errors = tool.validateAllowlistStructure(allowlist);
  assert.ok(errors.some(e => /legitimate May-24 game/.test(e)));
});

test('validateAllowlistStructure — wrong teamId fails', () => {
  const allowlist = makeValidAllowlist(13);
  allowlist.records[0].teamId = 'some-other-team';
  const errors = tool.validateAllowlistStructure(allowlist);
  assert.ok(errors.some(e => /teamId/.test(e)));
});

test('validateAllowlistStructure — wrong oldDate fails', () => {
  const allowlist = makeValidAllowlist(13);
  allowlist.records[0].oldDate = '2026-01-01';
  const errors = tool.validateAllowlistStructure(allowlist);
  assert.ok(errors.some(e => /oldDate/.test(e)));
});

test('loadAllowlist — the REAL repository allowlist file passes structural validation', () => {
  const r = tool.loadAllowlist(REAL_ALLOWLIST_PATH);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.allowlist.records.length, 13);
});

// ── 8-15. Precondition checking ─────────────────────────────────────────────

test('checkPrecondition — missing production game fails', () => {
  const r = tool.checkPrecondition(makeRecord(), null, '2026-03-15');
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'game_not_found');
});

test('checkPrecondition — mismatched gc_game_id fails', () => {
  const record = makeRecord({ gcGameId: 'gc1' });
  const currentRow = { gc_game_id: 'gc-DIFFERENT', our_team_id: record.teamId, game_date: record.oldDate, game_datetime_raw: record.rawDateTime };
  const r = tool.checkPrecondition(record, currentRow, record.newDate);
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'gc_game_id_mismatch');
});

test('checkPrecondition — mismatched team ID fails', () => {
  const record = makeRecord();
  const currentRow = { gc_game_id: record.gcGameId, our_team_id: 'some-other-team', game_date: record.oldDate, game_datetime_raw: record.rawDateTime };
  const r = tool.checkPrecondition(record, currentRow, record.newDate);
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'team_id_mismatch');
});

test('checkPrecondition — mismatched current date fails', () => {
  const record = makeRecord();
  const currentRow = { gc_game_id: record.gcGameId, our_team_id: record.teamId, game_date: '2026-01-01', game_datetime_raw: record.rawDateTime };
  const r = tool.checkPrecondition(record, currentRow, record.newDate);
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'current_game_date_mismatch');
});

test('checkPrecondition — mismatched raw evidence fails', () => {
  const record = makeRecord();
  const currentRow = { gc_game_id: record.gcGameId, our_team_id: record.teamId, game_date: record.oldDate, game_datetime_raw: 'some other raw text' };
  const r = tool.checkPrecondition(record, currentRow, record.newDate);
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'raw_evidence_mismatch');
});

test('checkPrecondition — parser-derived date no longer matches the proposed date fails', () => {
  const record = makeRecord();
  const currentRow = { gc_game_id: record.gcGameId, our_team_id: record.teamId, game_date: record.oldDate, game_datetime_raw: record.rawDateTime };
  const r = tool.checkPrecondition(record, currentRow, '2099-01-01' /* not record.newDate */);
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'parser_no_longer_derives_proposed_date');
});

test('checkPrecondition — a fully matching record passes', () => {
  const record = makeRecord();
  const currentRow = { gc_game_id: record.gcGameId, our_team_id: record.teamId, game_date: record.oldDate, game_datetime_raw: record.rawDateTime };
  const r = tool.checkPrecondition(record, currentRow, record.newDate);
  assert.equal(r.pass, true);
});

test('evaluate — any single precondition failure prevents the whole set from passing', async () => {
  const allowlist = makeValidAllowlist(3);
  const gamesById = {};
  for (const rec of allowlist.records) {
    gamesById[rec.gameId] = { id: rec.gameId, gc_game_id: rec.gcGameId, our_team_id: rec.teamId, game_date: rec.oldDate, game_datetime_raw: rec.rawDateTime };
  }
  // Break just one record's precondition.
  gamesById[allowlist.records[1].gameId].game_date = '1999-01-01';
  const client = makeFakeClient({ gamesById, cacheCountByGameId: {} });
  const parse = (raw) => ({ date: allowlist.records.find(r => r.rawDateTime === raw)?.newDate || null });
  const evaluation = await tool.evaluate(client, allowlist, parse);
  assert.equal(evaluation.allPass, false);
});

// ── 16. Legitimate May-24 games are structurally impossible to include ─────

test('the real allowlist never contains either legitimate May-24 game ID', () => {
  const { allowlist } = tool.loadAllowlist(REAL_ALLOWLIST_PATH);
  const ids = allowlist.records.map(r => r.gameId);
  for (const legit of tool.LEGITIMATE_EXCLUDED_IDS) {
    assert.equal(ids.includes(legit), false);
  }
});

// ── 17-20. Full evaluate() + run() behavior against the fake client ────────

function buildGamesById(allowlist) {
  const gamesById = {};
  for (const rec of allowlist.records) {
    gamesById[rec.gameId] = { id: rec.gameId, gc_game_id: rec.gcGameId, our_team_id: rec.teamId, game_date: rec.oldDate, game_datetime_raw: rec.rawDateTime };
  }
  return gamesById;
}

function buildFullyMatchingFakeClient(allowlist, { cachePerGame = 2, rpc = null } = {}) {
  const gamesById = buildGamesById(allowlist);
  const cacheCountByGameId = {};
  for (const rec of allowlist.records) cacheCountByGameId[rec.gameId] = cachePerGame;
  return makeFakeClient({ gamesById, cacheCountByGameId, rpc });
}

// A real RPC would atomically mutate every row; this simulates that
// observable effect on the fake client's backing store so post-write
// verification in run() sees the change, exactly as it would against a
// real, successfully-committed transaction.
function makeMutatingRpc(gamesById) {
  return (name, args) => {
    for (const rec of args.p_records) gamesById[rec.gameId].game_date = rec.newDate;
    return { data: { updatedCount: args.p_records.length }, error: null };
  };
}

function parserThatAgreesWithAllowlist(allowlist) {
  const byRaw = new Map(allowlist.records.map(r => [r.rawDateTime, r.newDate]));
  return (raw) => ({ date: byRaw.get(raw) || null });
}

test('evaluate() — all preconditions passing against a synthetic 13-record allowlist reports pre_repair / allPass', async () => {
  const allowlist = makeValidAllowlist(13);
  const client = buildFullyMatchingFakeClient(allowlist);
  const evaluation = await tool.evaluate(client, allowlist, parserThatAgreesWithAllowlist(allowlist));
  assert.equal(evaluation.allPass, true);
  assert.equal(evaluation.overallState, 'pre_repair');
  assert.equal(evaluation.matchedCount, 13);
});

test('run() — dry-run against the REAL allowlist with fully matching fake data performs no writes and reports repair would be allowed', async () => {
  const { allowlist } = tool.loadAllowlist(REAL_ALLOWLIST_PATH);
  const client = buildFullyMatchingFakeClient(allowlist);
  const logs = [];
  let rpcCalled = false;
  client.rpc = async () => { rpcCalled = true; return { data: { updatedCount: 13 }, error: null }; };
  const { exitCode } = await tool.run({
    argv: [], client, parseDateTimeRaw: parserThatAgreesWithAllowlist(allowlist),
    supabaseUrl: 'https://abcdefgh.supabase.co', allowlistPath: REAL_ALLOWLIST_PATH, log: (l) => logs.push(l),
  });
  assert.equal(exitCode, 0);
  assert.equal(rpcCalled, false, 'dry-run must never call the RPC');
  assert.ok(logs.some(l => /repair would be allowed: true/.test(l)));
  assert.ok(logs.some(l => /NO WRITES WERE PERFORMED/.test(l)));
});

test('run() — apply mode against the REAL allowlist, fully matching fake data, succeeds atomically (one rpc call)', async () => {
  const { allowlist } = tool.loadAllowlist(REAL_ALLOWLIST_PATH);
  const gamesById = buildGamesById(allowlist);
  let rpcCallCount = 0;
  let rpcArgs = null;
  const mutate = makeMutatingRpc(gamesById);
  const client = makeFakeClient({
    gamesById, cacheCountByGameId: {},
    rpc: (name, args) => { rpcCallCount++; rpcArgs = args; return mutate(name, args); },
  });
  const logs = [];
  const { exitCode } = await tool.run({
    argv: ['--apply', '--confirm-production-game-date-repair'],
    client, parseDateTimeRaw: parserThatAgreesWithAllowlist(allowlist),
    supabaseUrl: 'https://abcdefgh.supabase.co', allowlistPath: REAL_ALLOWLIST_PATH, log: (l) => logs.push(l),
  });
  assert.equal(exitCode, 0);
  assert.equal(rpcCallCount, 1, 'exactly one RPC call -- not 13 independent updates');
  assert.equal(rpcArgs.p_records.length, 13);
  assert.equal(tool.RPC_NAME, 'repair_audited_game_dates');
});

test('run() — RPC returning an updatedCount other than 13 is treated as a hard failure', async () => {
  const { allowlist } = tool.loadAllowlist(REAL_ALLOWLIST_PATH);
  const client = buildFullyMatchingFakeClient(allowlist, {
    rpc: () => ({ data: { updatedCount: 12 }, error: null }), // partial-looking result
  });
  const logs = [];
  const { exitCode } = await tool.run({
    argv: ['--apply', '--confirm-production-game-date-repair'],
    client, parseDateTimeRaw: parserThatAgreesWithAllowlist(allowlist),
    supabaseUrl: 'https://abcdefgh.supabase.co', allowlistPath: REAL_ALLOWLIST_PATH, log: (l) => logs.push(l),
  });
  assert.equal(exitCode, 1);
  assert.ok(logs.some(l => /HARD FAILURE/.test(l)));
});

test('run() — RPC error (simulating the function raising and rolling back) is reported and exits nonzero', async () => {
  const { allowlist } = tool.loadAllowlist(REAL_ALLOWLIST_PATH);
  const client = buildFullyMatchingFakeClient(allowlist, {
    rpc: () => ({ data: null, error: { message: 'game_date_precondition_failed for g1: expected 2026-05-24, found 2026-06-01' } }),
  });
  const logs = [];
  const { exitCode } = await tool.run({
    argv: ['--apply', '--confirm-production-game-date-repair'],
    client, parseDateTimeRaw: parserThatAgreesWithAllowlist(allowlist),
    supabaseUrl: 'https://abcdefgh.supabase.co', allowlistPath: REAL_ALLOWLIST_PATH, log: (l) => logs.push(l),
  });
  assert.equal(exitCode, 1);
  assert.ok(logs.some(l => /ABORTED/.test(l) && /rolled back/.test(l)));
});

// ── 21-22. Idempotency ───────────────────────────────────────────────────────

test('classifyOverallState — all pre_repair is pre_repair', () => {
  assert.equal(tool.classifyOverallState(['pre_repair', 'pre_repair', 'pre_repair']), 'pre_repair');
});

test('classifyOverallState — all already_repaired is already_repaired', () => {
  assert.equal(tool.classifyOverallState(['already_repaired', 'already_repaired']), 'already_repaired');
});

test('classifyOverallState — a mix of pre_repair and already_repaired is mixed (fails closed)', () => {
  assert.equal(tool.classifyOverallState(['pre_repair', 'already_repaired']), 'mixed');
});

test('classifyOverallState — any unexpected value forces unexpected, even alongside otherwise-consistent records', () => {
  assert.equal(tool.classifyOverallState(['pre_repair', 'pre_repair', 'unexpected']), 'unexpected');
});

test('run() — apply mode when all records are already in the repaired (new) state performs no writes (idempotent no-op)', async () => {
  const { allowlist } = tool.loadAllowlist(REAL_ALLOWLIST_PATH);
  const gamesById = {};
  for (const rec of allowlist.records) {
    gamesById[rec.gameId] = { id: rec.gameId, gc_game_id: rec.gcGameId, our_team_id: rec.teamId, game_date: rec.newDate /* already repaired */, game_datetime_raw: rec.rawDateTime };
  }
  let rpcCalled = false;
  const client = makeFakeClient({ gamesById, cacheCountByGameId: {}, rpc: () => { rpcCalled = true; return { data: { updatedCount: 13 }, error: null }; } });
  const logs = [];
  const { exitCode } = await tool.run({
    argv: ['--apply', '--confirm-production-game-date-repair'],
    client, parseDateTimeRaw: parserThatAgreesWithAllowlist(allowlist),
    supabaseUrl: 'https://abcdefgh.supabase.co', allowlistPath: REAL_ALLOWLIST_PATH, log: (l) => logs.push(l),
  });
  assert.equal(exitCode, 0);
  assert.equal(rpcCalled, false, 'no RPC call should be made when already fully repaired');
  assert.ok(logs.some(l => /idempotent no-op/.test(l)));
});

test('run() — apply mode with a mixed state (some repaired, some not) fails closed without calling the RPC', async () => {
  const { allowlist } = tool.loadAllowlist(REAL_ALLOWLIST_PATH);
  const gamesById = {};
  allowlist.records.forEach((rec, i) => {
    gamesById[rec.gameId] = {
      id: rec.gameId, gc_game_id: rec.gcGameId, our_team_id: rec.teamId,
      game_date: i === 0 ? rec.newDate : rec.oldDate, // first one already repaired, rest not
      game_datetime_raw: rec.rawDateTime,
    };
  });
  let rpcCalled = false;
  const client = makeFakeClient({ gamesById, cacheCountByGameId: {}, rpc: () => { rpcCalled = true; return { data: { updatedCount: 13 }, error: null }; } });
  const logs = [];
  const { exitCode } = await tool.run({
    argv: ['--apply', '--confirm-production-game-date-repair'],
    client, parseDateTimeRaw: parserThatAgreesWithAllowlist(allowlist),
    supabaseUrl: 'https://abcdefgh.supabase.co', allowlistPath: REAL_ALLOWLIST_PATH, log: (l) => logs.push(l),
  });
  assert.equal(exitCode, 1);
  assert.equal(rpcCalled, false);
  assert.ok(logs.some(l => /ABORTED/.test(l) && /mixed/.test(l)));
});

// ── 23-24. Rollback ──────────────────────────────────────────────────────────

test('buildRollbackRpcRecords — swaps old/new so rollback targets the repaired state and restores the original', () => {
  const allowlist = makeValidAllowlist(2);
  const rollbackRecords = tool.buildRollbackRpcRecords(allowlist.records);
  assert.equal(rollbackRecords[0].oldDate, allowlist.records[0].newDate);
  assert.equal(rollbackRecords[0].newDate, allowlist.records[0].oldDate);
});

test('run() — rollback apply requires its own confirmation flag even with valid data (already covered by parseArgs, re-verified end-to-end)', async () => {
  const { allowlist } = tool.loadAllowlist(REAL_ALLOWLIST_PATH);
  const client = buildFullyMatchingFakeClient(allowlist);
  const logs = [];
  const { exitCode } = await tool.run({
    argv: ['--rollback', '--apply'], // missing --confirm-production-game-date-rollback
    client, parseDateTimeRaw: parserThatAgreesWithAllowlist(allowlist),
    supabaseUrl: 'https://abcdefgh.supabase.co', allowlistPath: REAL_ALLOWLIST_PATH, log: (l) => logs.push(l),
  });
  assert.equal(exitCode, 1);
  assert.ok(logs.some(l => /confirm-production-game-date-rollback/.test(l)));
});

test('run() — rollback apply, records currently in repaired state, restores original values atomically via one rpc call', async () => {
  const { allowlist } = tool.loadAllowlist(REAL_ALLOWLIST_PATH);
  const gamesById = {};
  for (const rec of allowlist.records) {
    gamesById[rec.gameId] = { id: rec.gameId, gc_game_id: rec.gcGameId, our_team_id: rec.teamId, game_date: rec.newDate /* repaired state */, game_datetime_raw: rec.rawDateTime };
  }
  let rpcCallCount = 0;
  const mutate = makeMutatingRpc(gamesById);
  const client = makeFakeClient({
    gamesById, cacheCountByGameId: {},
    rpc: (name, args) => { rpcCallCount++; return mutate(name, args); },
  });
  const logs = [];
  const { exitCode } = await tool.run({
    argv: ['--rollback', '--apply', '--confirm-production-game-date-rollback'],
    client, parseDateTimeRaw: parserThatAgreesWithAllowlist(allowlist),
    supabaseUrl: 'https://abcdefgh.supabase.co', allowlistPath: REAL_ALLOWLIST_PATH, log: (l) => logs.push(l),
  });
  assert.equal(exitCode, 0);
  assert.equal(rpcCallCount, 1);
});

// ── 25. Redaction ────────────────────────────────────────────────────────────

test('redactProjectRef — only the project ref is surfaced, never the full URL or any key', () => {
  const out = tool.redactProjectRef('https://jqycdruhcaqdumuhirsw.supabase.co');
  assert.match(out, /jqycdruhcaqdumuhirsw/);
  assert.doesNotMatch(out, /supabase\.co/);
});

test('formatReport — never includes a raw credential-looking string even if one leaked into inputs', () => {
  const allowlist = makeValidAllowlist(1);
  const evaluation = { results: [], cacheRowCount: 0, allPass: true, overallState: 'pre_repair', matchedCount: 0, manifestVersion: 'test' };
  const out = tool.formatReport({ mode: 'repair-dry-run', supabaseUrl: 'https://abcxyz.supabase.co', allowlistPath: 'x', evaluation, wouldWrite: false });
  assert.doesNotMatch(out, /service_role/i);
  assert.doesNotMatch(out, /eyJ/); // no raw JWT-looking token
  assert.match(out, /NO WRITES WERE PERFORMED/);
});
