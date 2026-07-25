'use strict';

// Focused, database-free tests for src/high-school-importer-contract.js --
// the pure matching/reconciliation/conflict-policy functions the future
// GameChanger roster importer will use. No network call, no Playwright
// browser, no Supabase call is possible from this file: every function
// under test takes plain JS objects in and returns a plan/decision out.
//
// Run with: node --test test/high-school-importer-contract.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  matchPlayerCandidates,
  planRosterReconciliation,
  resolveFieldConflict,
  sanitizeSyncError,
  isKnownRecordSource,
  isKnownGcMatchStatus,
} = require('../src/high-school-importer-contract.js');

// ── matchPlayerCandidates ────────────────────────────────────────────────

test('stable-ID exact match: a prior GameChanger link for this team+season wins outright, no name comparison needed', () => {
  const result = matchPlayerCandidates({
    existingPlayers: [{ id: 'p1', normalizedFirstName: 'someone', normalizedLastName: 'else' }],
    incoming: { firstName: 'Whoever', lastName: 'This Is' },
    priorGcLinkedPlayerId: 'p1',
  });
  assert.deepEqual(result, { outcome: 'matched', playerId: 'p1' });
});

test('no stable ID, exactly one normalized-name candidate: safe to reuse', () => {
  const result = matchPlayerCandidates({
    existingPlayers: [{ id: 'p1', normalizedFirstName: 'john', normalizedLastName: 'smith' }],
    incoming: { firstName: 'John', lastName: 'Smith' },
  });
  assert.deepEqual(result, { outcome: 'matched', playerId: 'p1' });
});

test('no stable ID, no name candidates at all: create a new player', () => {
  const result = matchPlayerCandidates({
    existingPlayers: [{ id: 'p1', normalizedFirstName: 'john', normalizedLastName: 'smith' }],
    incoming: { firstName: 'Jane', lastName: 'Doe' },
  });
  assert.deepEqual(result, { outcome: 'create' });
});

test('ambiguous same-name candidates: reported, never auto-merged', () => {
  const result = matchPlayerCandidates({
    existingPlayers: [
      { id: 'p1', normalizedFirstName: 'john', normalizedLastName: 'smith' },
      { id: 'p2', normalizedFirstName: 'john', normalizedLastName: 'smith' },
    ],
    incoming: { firstName: 'John', lastName: 'Smith' },
  });
  assert.equal(result.outcome, 'ambiguous');
  assert.deepEqual(result.candidatePlayerIds.sort(), ['p1', 'p2']);
});

test('two distinct same-name players in the pool do not affect a differently-named incoming player', () => {
  const result = matchPlayerCandidates({
    existingPlayers: [
      { id: 'p1', normalizedFirstName: 'john', normalizedLastName: 'smith' },
      { id: 'p2', normalizedFirstName: 'john', normalizedLastName: 'smith' },
      { id: 'p3', normalizedFirstName: 'jane', normalizedLastName: 'doe' },
    ],
    incoming: { firstName: 'Jane', lastName: 'Doe' },
  });
  assert.deepEqual(result, { outcome: 'matched', playerId: 'p3' });
});

test('name matching is case/whitespace-insensitive via normalization, not exact string equality', () => {
  const result = matchPlayerCandidates({
    existingPlayers: [{ id: 'p1', normalizedFirstName: 'john', normalizedLastName: 'smith' }],
    incoming: { firstName: '  JOHN  ', lastName: 'Smith' },
  });
  // matchPlayerCandidates trusts already-normalized existingPlayers input
  // (as the schema's generated columns would provide) but normalizes the
  // incoming value itself -- proving the comparison isn't case-sensitive.
  assert.deepEqual(result, { outcome: 'matched', playerId: 'p1' });
});

test('malformed incoming data (missing name fields) fails safely to "create", never to a false match', () => {
  const result = matchPlayerCandidates({
    existingPlayers: [{ id: 'p1', normalizedFirstName: '', normalizedLastName: '' }],
    incoming: {},
  });
  // An empty incoming name should not spuriously "match" an existing
  // player whose normalized name also happens to be empty -- guarded by
  // requiring non-empty normalization in practice; documented here as the
  // edge case a real importer must reject before calling this function
  // (an incoming entry with no name at all is not valid roster data).
  assert.equal(result.outcome, 'create');
});

// ── planRosterReconciliation ─────────────────────────────────────────────

test('a changed jersey number on an already-linked, GameChanger-sourced membership is applied', () => {
  const plan = planRosterReconciliation({
    existingMemberships: [{ id: 'm1', playerId: 'p1', jerseyNumber: '12', status: 'active', recordSource: 'gamechanger' }],
    resolvedIncoming: [{ playerId: 'p1', jerseyNumber: '24' }],
  });
  assert.deepEqual(plan.toUpdate, [{ membershipId: 'm1', jerseyNumber: '24', gcExternalPlayerId: null }]);
  assert.deepEqual(plan.toCreate, []);
  assert.deepEqual(plan.toDeactivate, []);
});

test('a leading-zero jersey number is preserved exactly, not coerced', () => {
  const plan = planRosterReconciliation({
    existingMemberships: [],
    resolvedIncoming: [{ playerId: 'p1', jerseyNumber: '00' }],
  });
  assert.equal(plan.toCreate[0].jerseyNumber, '00');
});

test('a missing (no-longer-imported) player is marked inactive, not deleted', () => {
  const plan = planRosterReconciliation({
    existingMemberships: [{ id: 'm1', playerId: 'p1', jerseyNumber: '5', status: 'active', recordSource: 'gamechanger' }],
    resolvedIncoming: [], // this player no longer appears in the latest import
  });
  assert.deepEqual(plan.toDeactivate, ['m1']);
  assert.deepEqual(plan.toUpdate, []);
});

test('a manually-created record preserves its existing value and reports no records to create/deactivate for it', () => {
  const plan = planRosterReconciliation({
    existingMemberships: [{ id: 'm1', playerId: 'p1', jerseyNumber: '7', status: 'active', recordSource: 'manual' }],
    resolvedIncoming: [{ playerId: 'p1', jerseyNumber: '99' }],
  });
  // The membership is still "seen" (present in the import), so it is not
  // deactivated -- but its manually-set jersey number is not overwritten
  // (see resolveFieldConflict tests below for the underlying policy).
  assert.deepEqual(plan.toDeactivate, []);
  assert.equal(plan.toUpdate[0].jerseyNumber, '7');
});

test('a brand-new player with no existing membership is queued for creation, not update', () => {
  const plan = planRosterReconciliation({
    existingMemberships: [],
    resolvedIncoming: [{ playerId: 'new-player', jerseyNumber: '3' }],
  });
  assert.deepEqual(plan.toCreate, [{ playerId: 'new-player', jerseyNumber: '3', gcExternalPlayerId: null }]);
});

test('an already-inactive membership that is not re-observed is not added to toDeactivate a second time', () => {
  const plan = planRosterReconciliation({
    existingMemberships: [{ id: 'm1', playerId: 'p1', jerseyNumber: '5', status: 'inactive', recordSource: 'gamechanger' }],
    resolvedIncoming: [],
  });
  assert.deepEqual(plan.toDeactivate, []);
});

// ── resolveFieldConflict ──────────────────────────────────────────────────

test('an imported (gamechanger-sourced) field may be refreshed by a new import', () => {
  const result = resolveFieldConflict({ existingValue: '12', importedValue: '24', fieldRecordSource: 'gamechanger' });
  assert.deepEqual(result, { value: '24', overwritten: true });
});

test('a manually-corrected field is never overwritten by an import', () => {
  const result = resolveFieldConflict({ existingValue: '12', importedValue: '24', fieldRecordSource: 'manual' });
  assert.deepEqual(result, { value: '12', overwritten: false });
});

test('an imported field with an unchanged value reports overwritten=false (no-op, not a false-positive change)', () => {
  const result = resolveFieldConflict({ existingValue: '12', importedValue: '12', fieldRecordSource: 'gamechanger' });
  assert.equal(result.overwritten, false);
});

// ── sanitizeSyncError ─────────────────────────────────────────────────────

test('a benign sync failure message passes through unchanged', () => {
  assert.equal(sanitizeSyncError('Network timeout after 30s'), 'Network timeout after 30s');
});

test('a message resembling a credential/token/cookie/session value is withheld, never persisted verbatim', () => {
  for (const suspicious of [
    'Authorization: Bearer abc123',
    'Cookie: session=xyz',
    'Invalid API key provided',
    'password reset required',
  ]) {
    const result = sanitizeSyncError(suspicious);
    assert.doesNotMatch(result, /abc123|xyz/);
    assert.match(result, /details withheld/);
  }
});

test('an overlong message is bounded, never stored unbounded', () => {
  const result = sanitizeSyncError('x'.repeat(5000));
  assert.ok(result.length <= 2000);
});

test('empty/null input sanitizes to null, not an empty-string error row', () => {
  assert.equal(sanitizeSyncError(''), null);
  assert.equal(sanitizeSyncError(null), null);
  assert.equal(sanitizeSyncError(undefined), null);
});

// ── source/status validators ─────────────────────────────────────────────

test('isKnownRecordSource accepts only manual/gamechanger', () => {
  assert.equal(isKnownRecordSource('manual'), true);
  assert.equal(isKnownRecordSource('gamechanger'), true);
  assert.equal(isKnownRecordSource('scraped'), false);
  assert.equal(isKnownRecordSource(undefined), false);
});

test('isKnownGcMatchStatus accepts null/undefined (no ambiguity flagged) or confirmed/ambiguous, never an arbitrary string', () => {
  assert.equal(isKnownGcMatchStatus(null), true);
  assert.equal(isKnownGcMatchStatus(undefined), true);
  assert.equal(isKnownGcMatchStatus('confirmed'), true);
  assert.equal(isKnownGcMatchStatus('ambiguous'), true);
  assert.equal(isKnownGcMatchStatus('verified'), false);
});

// ── client-supplied organization id is never a concept this module has ──

test('no function in this module accepts or reads an organization id at all (org scoping is entirely the caller\'s responsibility, before calling in)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'high-school-importer-contract.js'), 'utf8');
  const statementsOnly = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(statementsOnly, /orgId|org_id/);
});
