'use strict';

const crypto = require('crypto');

function normalizeOrgId(orgId) {
  return typeof orgId === 'string' && orgId.trim() ? orgId.trim() : null;
}

function createJobRecord(jobs, label, orgId, { createdByUserId = null } = {}) {
  const authoritativeOrgId = normalizeOrgId(orgId);
  if (!authoritativeOrgId) {
    const err = new Error('Unable to determine the organization for this job.');
    err.statusCode = 403;
    throw err;
  }

  const id = crypto.randomUUID();
  const job = {
    id,
    label,
    status: 'running',
    logs: [],
    startedAt: Date.now(),
    pid: null,
    proc: null,
    created_by_user_id: createdByUserId || null,
  };

  Object.defineProperty(job, 'org_id', {
    value: authoritativeOrgId,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  jobs[id] = job;
  return id;
}

function findJobForOrg(jobs, id, orgId) {
  const authoritativeOrgId = normalizeOrgId(orgId);
  if (!authoritativeOrgId || typeof id !== 'string') return null;

  const job = jobs[id];
  if (!job || normalizeOrgId(job.org_id) !== authoritativeOrgId) return null;
  return job;
}

module.exports = {
  createJobRecord,
  findJobForOrg,
  normalizeOrgId,
};
