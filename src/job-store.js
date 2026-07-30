'use strict';

const crypto = require('crypto');

function normalizeOrgId(orgId) {
  return typeof orgId === 'string' && orgId.trim() ? orgId.trim() : null;
}

function normalizeCreatorId(userId) {
  if (typeof userId !== 'string') return null;
  const normalized = userId.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : null;
}

function createJobRecord(jobs, label, orgId, { createdByUserId = null } = {}) {
  const authoritativeOrgId = normalizeOrgId(orgId);
  if (!authoritativeOrgId) {
    const err = new Error('Unable to determine the organization for this job.');
    err.statusCode = 403;
    throw err;
  }

  const authoritativeCreatorId = normalizeCreatorId(createdByUserId);
  if (!authoritativeCreatorId) {
    const err = new Error('Unable to determine the authenticated creator for this job.');
    err.statusCode = 401;
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
  };

  Object.defineProperties(job, {
    org_id: {
      value: authoritativeOrgId,
      enumerable: true,
      writable: false,
      configurable: false,
    },
    created_by_user_id: {
      value: authoritativeCreatorId,
      enumerable: true,
      writable: false,
      configurable: false,
    },
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
  normalizeCreatorId,
  normalizeOrgId,
};
