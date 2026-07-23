'use strict';

// Focused tests for Correction 2: src/pipeline.js's recalculateTeamStats()
// used to contain a block of temporary, explicitly-labeled diagnostic
// logging (`// ── Diagnostic logging ──` ... `// ── End diagnostic logging ──`,
// tagged `[pipeline][diag]`) added while chasing down a real/synthetic-test
// discrepancy. It was never meant to ship. Two layers of proof:
//   1. A source-text regression guard -- the diagnostic markers/tag can
//      never silently reappear in the shipped file.
//   2. A real behavioral test -- recalculateTeamStats() is actually
//      invoked (not reimplemented) with a fake ./db and ./stats-engine
//      injected via require.cache, and every console.log call is captured
//      to prove no `[diag]`-tagged line is ever emitted, while confirming
//      the function's real, non-diagnostic logging still fires normally.
//
// Run with: node --test test/pipeline-diagnostic-logging.test.js

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const PIPELINE_SRC_PATH = path.join(__dirname, '..', 'src', 'pipeline.js');

test('src/pipeline.js source no longer contains the temporary diagnostic-logging block or its [diag] tag', () => {
  const source = fs.readFileSync(PIPELINE_SRC_PATH, 'utf8');
  assert.doesNotMatch(source, /\[diag\]/);
  assert.doesNotMatch(source, /Diagnostic logging/i);
  assert.doesNotMatch(source, /Temporary instrumentation/i);
  assert.doesNotMatch(source, /End diagnostic logging/i);
});

// ── Behavioral proof: the real recalculateTeamStats(), fake dependencies ───

// Permissive fake Supabase-style client -- recalculateTeamStats() makes
// several `.from(table).<verb>(...).eq(...).then(cb)` writes on the
// USE_SUPABASE path (persisting unattributed-error counts, wiping advanced
// stats) that are unrelated to this correction. Rather than trace/mock
// every exact call, this fake accepts any chain and resolves harmlessly,
// so the test stays focused on what it's actually proving: no [diag] log
// line is ever emitted, and the real status log still is.
function makeFakePermissiveSupabaseDb() {
  const builder = {
    update: () => builder, delete: () => builder, insert: () => builder,
    upsert: () => builder, select: () => builder, eq: () => builder,
    then: (resolve) => Promise.resolve({ data: null, error: null }).then(resolve),
  };
  return { from: () => builder };
}

function freshPipelineWithFakes({ gameData, processGamesResult }) {
  const dbPath = require.resolve('../src/db');
  const statsEnginePath = require.resolve('../src/stats-engine');
  const pipelinePath = require.resolve('../src/pipeline');

  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      init() {},
      getDb() { return makeFakePermissiveSupabaseDb(); },
      getGameDataForStatsEngine() { return gameData; },
    },
  };
  require.cache[statsEnginePath] = {
    id: statsEnginePath, filename: statsEnginePath, loaded: true,
    exports: {
      processGames() { return processGamesResult; },
      processGameFile() { throw new Error('not used by this test'); },
    },
  };
  delete require.cache[pipelinePath];
  return require('../src/pipeline');
}

function makeGame(gameId, { batting = [], pitching = [], plays = [] } = {}) {
  return { meta: { gameId }, boxScore: { batting, pitching }, plays };
}

test('recalculateTeamStats — never emits a [pipeline][diag]-tagged log line, but still emits its real operational logging', async () => {
  const originalUseSupabase = process.env.USE_SUPABASE;
  process.env.USE_SUPABASE = 'true';

  const gameData = [
    makeGame('g1', { batting: [{ isOurTeam: true }, { isOurTeam: false }], pitching: [{}], plays: [{}] }),
    makeGame('g2', { batting: [], pitching: [], plays: [] }),
  ];
  const pipeline = freshPipelineWithFakes({
    gameData,
    processGamesResult: { players: {}, opponentBatters: {}, ourPitchers: {}, pitchers: {}, unattributedErrors: { ourSide: 0, opponentSide: 0 } },
  });

  const originalConsoleLog = console.log;
  const capturedLines = [];
  console.log = (...args) => { capturedLines.push(args.map(String).join(' ')); };

  try {
    await pipeline.recalculateTeamStats(42, {});
  } finally {
    console.log = originalConsoleLog;
    if (originalUseSupabase === undefined) delete process.env.USE_SUPABASE;
    else process.env.USE_SUPABASE = originalUseSupabase;
  }

  const diagLines = capturedLines.filter(line => line.includes('[diag]'));
  assert.deepEqual(diagLines, [], `expected no [diag]-tagged log lines, got: ${JSON.stringify(diagLines)}`);

  // The real, non-diagnostic status log for this same call path must still fire --
  // proves the fix removed only the diagnostic block, not the function's actual logging.
  assert.ok(
    capturedLines.some(line => line.includes('[pipeline] Recalculating stats from 2 game(s) for team 42')),
    `expected the real recalculation status log; got: ${JSON.stringify(capturedLines)}`
  );
});
