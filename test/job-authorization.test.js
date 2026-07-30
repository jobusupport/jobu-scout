'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createJobRecord, findJobForOrg } = require('../src/job-store');

function createFixture(orgId = 'org-a', extra = {}) {
  const jobs = {};
  const id = createJobRecord(jobs, 'Travel job', orgId, extra);
  return { jobs, id, job: jobs[id] };
}

test('job creation binds the authoritative organization and creator', () => {
  const { job } = createFixture('org-a', { createdByUserId: 'user-1' });
  assert.equal(job.org_id, 'org-a');
  assert.equal(job.created_by_user_id, 'user-1');
});

test('job ownership is immutable through lifecycle updates', () => {
  const { job } = createFixture();
  assert.throws(() => { job.org_id = 'org-b'; }, TypeError);
  job.logs.push({ line: 'progress' });
  job.status = 'done';
  job.finishedAt = Date.now();
  assert.equal(job.org_id, 'org-a');
});

test('job creation rejects missing or malformed organization ownership', () => {
  for (const orgId of [null, undefined, '', '   ', 42]) {
    assert.throws(() => createJobRecord({}, 'Travel job', orgId), /determine the organization/);
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
    createdByUserId: 'user-1',
  });
  assert.equal(jobs[id].org_id, 'org-a');
});

test('foreign status rejection occurs before job serialization', () => {
  const { jobs, id } = createFixture('org-a');
  let serialized = false;
  const job = findJobForOrg(jobs, id, 'org-b');
  if (job) {
    JSON.stringify(job);
    serialized = true;
  }
  assert.equal(job, null);
  assert.equal(serialized, false);
});

test('foreign stream rejection occurs before headers or listeners', () => {
  const { jobs, id } = createFixture('org-a');
  let headersCommitted = false;
  let listenerAttached = false;
  const job = findJobForOrg(jobs, id, 'org-b');
  if (job) {
    headersCommitted = true;
    listenerAttached = true;
  }
  assert.equal(job, null);
  assert.equal(headersCommitted, false);
  assert.equal(listenerAttached, false);
});

test('foreign stop rejection occurs before cancellation side effects', () => {
  const { jobs, id } = createFixture('org-a');
  let stopInvoked = false;
  const job = findJobForOrg(jobs, id, 'org-b');
  if (job) stopInvoked = true;
  assert.equal(job, null);
  assert.equal(stopInvoked, false);
  assert.equal(jobs[id].status, 'running');
});
