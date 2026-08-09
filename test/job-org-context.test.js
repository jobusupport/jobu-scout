'use strict';

// Security Slice T2: focused unit tests for src/job-org-context.js, the
// single contract between a server-spawned (or trusted-operator-invoked)
// Travel child process and the organization it is trusted to act as.
//
// Run with: node --test test/job-org-context.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { JOB_ORG_ENV_VAR, requireJobOrgContext } = require('../src/job-org-context');
const { OrgContextRequiredError } = require('../src/org-context-errors');

test('JOB_ORG_ENV_VAR is the documented, Jobu-specific name', () => {
  assert.equal(JOB_ORG_ENV_VAR, 'JOBU_JOB_ORG_ID');
});

test('requireJobOrgContext: missing key fails closed with OrgContextRequiredError', () => {
  assert.throws(() => requireJobOrgContext({}), (err) => {
    assert.ok(err instanceof OrgContextRequiredError);
    assert.match(err.message, /JOBU_JOB_ORG_ID/);
    assert.doesNotMatch(err.message, /gc\.com/i, 'error must never reference GameChanger');
    return true;
  });
});

test('requireJobOrgContext: blank string fails closed', () => {
  assert.throws(() => requireJobOrgContext({ JOBU_JOB_ORG_ID: '' }), OrgContextRequiredError);
});

test('requireJobOrgContext: whitespace-only string fails closed', () => {
  assert.throws(() => requireJobOrgContext({ JOBU_JOB_ORG_ID: '   \t  ' }), OrgContextRequiredError);
});

test('requireJobOrgContext: non-string value fails closed', () => {
  assert.throws(() => requireJobOrgContext({ JOBU_JOB_ORG_ID: undefined }), OrgContextRequiredError);
});

test('requireJobOrgContext: valid value is returned, trimmed', () => {
  const orgId = requireJobOrgContext({ JOBU_JOB_ORG_ID: '  11111111-1111-4111-8111-111111111111  ' });
  assert.equal(orgId, '11111111-1111-4111-8111-111111111111');
});

test('requireJobOrgContext: reads only JOBU_JOB_ORG_ID, ignoring similarly-named or legacy keys', () => {
  assert.throws(
    () => requireJobOrgContext({ GC_ORG_ID: 'x', ORG_ID: 'x', orgId: 'x' }),
    OrgContextRequiredError,
    'must not accept a differently-named env var as a substitute'
  );
});

test('requireJobOrgContext: does not read the real process.env by default when an explicit (empty) env is not passed -- ' +
     'i.e. the injectable env parameter is actually used, not merely accepted and ignored', () => {
  const original = process.env.JOBU_JOB_ORG_ID;
  process.env.JOBU_JOB_ORG_ID = 'real-process-env-value';
  try {
    const orgId = requireJobOrgContext({ JOBU_JOB_ORG_ID: 'injected-value' });
    assert.equal(orgId, 'injected-value', 'the injected env object must take precedence over process.env');
  } finally {
    if (original === undefined) delete process.env.JOBU_JOB_ORG_ID; else process.env.JOBU_JOB_ORG_ID = original;
  }
});
