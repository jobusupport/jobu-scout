'use strict';

// Security Slice T2: focused tests for src/pipeline.js#ensureTeam's new
// organization-context requirement. The REAL pipeline.js is exercised
// (not reimplemented); only ./db is replaced via require.cache
// injection, the same technique test/pipeline-diagnostic-logging.test.js
// already uses.
//
// Run with: node --test test/pipeline-org-context.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const DB_PATH = require.resolve('../src/db');
const PIPELINE_PATH = require.resolve('../src/pipeline');

function freshPipelineWithFakeDb({ useSupabase }) {
  const upsertTeamCalls = [];
  require.cache[DB_PATH] = {
    id: DB_PATH,
    filename: DB_PATH,
    loaded: true,
    exports: {
      init() {},
      useSupabase: () => useSupabase,
      upsertTeam(team) {
        upsertTeamCalls.push(team);
        return useSupabase ? Promise.resolve('fake-team-id') : 'fake-team-id';
      },
    },
  };
  delete require.cache[PIPELINE_PATH];
  const pipeline = require('../src/pipeline');
  return { pipeline, upsertTeamCalls };
}

function cleanup() {
  delete require.cache[DB_PATH];
  delete require.cache[PIPELINE_PATH];
}

test('ensureTeam: Supabase mode, missing orgId -- rejects with OrgContextRequiredError BEFORE calling db.upsertTeam', async () => {
  const { pipeline, upsertTeamCalls } = freshPipelineWithFakeDb({ useSupabase: true });
  try {
    await assert.rejects(
      () => pipeline.ensureTeam({ teamName: 'Synthetic Tigers' }),
      (err) => {
        assert.equal(err.name, 'OrgContextRequiredError');
        assert.match(err.message, /orgId/);
        return true;
      }
    );
    assert.deepEqual(upsertTeamCalls, [], 'db.upsertTeam must never be called when org context is missing');
  } finally {
    cleanup();
  }
});

test('ensureTeam: Supabase mode, blank orgId -- rejects, no adapter call', async () => {
  const { pipeline, upsertTeamCalls } = freshPipelineWithFakeDb({ useSupabase: true });
  try {
    await assert.rejects(() => pipeline.ensureTeam({ teamName: 'Synthetic Tigers', orgId: '   ' }));
    assert.deepEqual(upsertTeamCalls, []);
  } finally {
    cleanup();
  }
});

test('ensureTeam: Supabase mode, orgId present -- succeeds and forwards the exact team object (including orgId) to db.upsertTeam', async () => {
  const { pipeline, upsertTeamCalls } = freshPipelineWithFakeDb({ useSupabase: true });
  try {
    const team = { teamName: 'Synthetic Tigers', orgId: '11111111-1111-4111-8111-111111111111' };
    const teamId = await pipeline.ensureTeam(team);
    assert.equal(teamId, 'fake-team-id');
    assert.equal(upsertTeamCalls.length, 1);
    assert.equal(upsertTeamCalls[0].orgId, team.orgId);
  } finally {
    cleanup();
  }
});

test('ensureTeam: Supabase mode, team.org_id (snake_case) is also accepted', async () => {
  const { pipeline, upsertTeamCalls } = freshPipelineWithFakeDb({ useSupabase: true });
  try {
    await pipeline.ensureTeam({ teamName: 'Synthetic Tigers', org_id: '22222222-2222-4222-8222-222222222222' });
    assert.equal(upsertTeamCalls.length, 1);
  } finally {
    cleanup();
  }
});

test('ensureTeam: SQLite/local-development mode -- org context is NOT required (intentional, documented exception)', async () => {
  const { pipeline, upsertTeamCalls } = freshPipelineWithFakeDb({ useSupabase: false });
  try {
    const teamId = await pipeline.ensureTeam({ teamName: 'Synthetic Tigers' }); // no orgId
    assert.equal(teamId, 'fake-team-id');
    assert.equal(upsertTeamCalls.length, 1, 'db.upsertTeam must still be called in SQLite mode without org context');
  } finally {
    cleanup();
  }
});

test('ensureTeam: mode decision uses db.useSupabase() (the single authoritative check), not a second/divergent flag -- ' +
     'proven by a fake db module whose useSupabase() return value alone flips the requirement', async () => {
  const supabaseRun = freshPipelineWithFakeDb({ useSupabase: true });
  try {
    await assert.rejects(() => supabaseRun.pipeline.ensureTeam({ teamName: 'X' }));
  } finally {
    cleanup();
  }

  const sqliteRun = freshPipelineWithFakeDb({ useSupabase: false });
  try {
    await assert.doesNotReject(() => sqliteRun.pipeline.ensureTeam({ teamName: 'X' }));
  } finally {
    cleanup();
  }
});

test('ensureTeam: a fake db module lacking useSupabase() entirely (e.g. a minimal test double) ' +
     'does not crash -- treated as non-Supabase mode rather than throwing a TypeError', async () => {
  require.cache[DB_PATH] = {
    id: DB_PATH, filename: DB_PATH, loaded: true,
    exports: { init() {}, upsertTeam: () => 'fake-team-id' }, // no useSupabase export
  };
  delete require.cache[PIPELINE_PATH];
  const pipeline = require('../src/pipeline');
  try {
    const teamId = await pipeline.ensureTeam({ teamName: 'X' });
    assert.equal(teamId, 'fake-team-id');
  } finally {
    cleanup();
  }
});
