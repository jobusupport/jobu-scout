'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createJobRecord, findJobForOrg } = require('../src/job-store');

const CREATOR_ID = 'abcdefab-cdef-4abc-8def-abcdefabcdef';

function createFixture(orgId = 'org-a', extra = {}) {
  const jobs = {};
  const id = createJobRecord(jobs, 'Travel job', orgId, {
    createdByUserId: CREATOR_ID,
    ...extra,
  });
  return { jobs, id, job: jobs[id] };
}

test('job creation binds authoritative organization and creator metadata', () => {
  const { job } = createFixture('org-a');
  assert.equal(job.org_id, 'org-a');
  assert.equal(job.created_by_user_id, CREATOR_ID);
  for (const property of ['org_id', 'created_by_user_id']) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(job, property), {
      value: property === 'org_id' ? 'org-a' : CREATOR_ID,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
});

test('job ownership and creator metadata resist assignment, deletion, and redefinition', () => {
  const { job } = createFixture();
  assert.throws(() => { job.org_id = 'org-b'; }, TypeError);
  assert.throws(() => { job.created_by_user_id = '22222222-2222-4222-8222-222222222222'; }, TypeError);
  assert.throws(() => { delete job.org_id; }, TypeError);
  assert.throws(() => { delete job.created_by_user_id; }, TypeError);
  assert.throws(() => Object.defineProperty(job, 'org_id', { value: 'org-b' }), TypeError);
  assert.throws(
    () => Object.defineProperty(job, 'created_by_user_id', {
      value: '22222222-2222-4222-8222-222222222222',
    }),
    TypeError
  );
  assert.equal(job.org_id, 'org-a');
  assert.equal(job.created_by_user_id, CREATOR_ID);
});

test('job ownership metadata survives progress, completion, failure, and stop-style updates', () => {
  const { job } = createFixture();
  job.logs.push({ line: 'progress' });
  job.status = 'done';
  job.finishedAt = Date.now();
  job.error = 'failure';
  job.stopping = true;
  assert.equal(job.org_id, 'org-a');
  assert.equal(job.created_by_user_id, CREATOR_ID);
});

test('job creation rejects missing or malformed organization ownership', () => {
  for (const orgId of [null, undefined, '', '   ', 42]) {
    assert.throws(() => createJobRecord({}, 'Travel job', orgId), /determine the organization/);
  }
});

test('job creation rejects missing, malformed, or ambiguous authoritative creator identity', () => {
  for (const creatorId of [null, undefined, '', '   ', 42, {}, 'user-1']) {
    assert.throws(
      () => createJobRecord({}, 'Travel job', 'org-a', { createdByUserId: creatorId }),
      /authenticated creator/
    );
  }
});

test('job IDs are distinct opaque UUID strings', () => {
  const ids = new Set(Array.from({ length: 50 }, () => createFixture().id));
  assert.equal(ids.size, 50);
  for (const id of ids) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});

test('an organization can retrieve its own job', () => {
  const { jobs, id, job } = createFixture('org-a');
  assert.equal(findJobForOrg(jobs, id, 'org-a'), job);
});

test('foreign, nonexistent, unowned, and malformed jobs all fail closed identically', () => {
  const { jobs, id } = createFixture('org-a');
  jobs.unowned = { id: 'unowned', status: 'running' };
  jobs.malformed = { id: 'malformed', org_id: 99, status: 'running' };
  assert.equal(findJobForOrg(jobs, id, 'org-b'), null);
  assert.equal(findJobForOrg(jobs, 'missing', 'org-a'), null);
  assert.equal(findJobForOrg(jobs, 'unowned', 'org-a'), null);
  assert.equal(findJobForOrg(jobs, 'malformed', 'org-a'), null);
});

test('caller-controlled ownership fields cannot override the authoritative argument', () => {
  const jobs = {};
  const id = createJobRecord(jobs, 'Travel job', 'org-a', {
    org_id: 'org-b',
    created_by_user_id: '22222222-2222-4222-8222-222222222222',
    createdByUserId: CREATOR_ID,
  });
  assert.equal(jobs[id].org_id, 'org-a');
  assert.equal(jobs[id].created_by_user_id, CREATOR_ID);
});
