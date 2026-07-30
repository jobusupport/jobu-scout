'use strict';

const crypto = require('crypto');

const DEFAULT_STREAM_CREDENTIAL_TTL_MS = 2 * 60 * 1000;

function createStreamCredentialStore({
  now = () => Date.now(),
  randomBytes = crypto.randomBytes,
  ttlMs = DEFAULT_STREAM_CREDENTIAL_TTL_MS,
} = {}) {
  const credentials = new Map();

  function purgeExpired() {
    const currentTime = now();
    for (const [token, entry] of credentials) {
      if (entry.expiresAt <= currentTime) credentials.delete(token);
    }
  }

  return {
    issue({ user, jobId, supportSessionToken = null }) {
      if (!user?.id || typeof jobId !== 'string' || !jobId) {
        throw new TypeError('A verified user and job ID are required.');
      }
      purgeExpired();
      const token = randomBytes(32).toString('hex');
      const entry = Object.freeze({
        user: Object.freeze({ id: user.id, email: user.email || null }),
        jobId,
        supportSessionToken: supportSessionToken || null,
        expiresAt: now() + ttlMs,
      });
      credentials.set(token, entry);
      return { token, expiresAt: entry.expiresAt };
    },

    resolve(token, jobId) {
      purgeExpired();
      if (typeof token !== 'string' || !token) return null;
      const entry = credentials.get(token);
      if (!entry || entry.jobId !== jobId) return null;
      return entry;
    },

    revoke(token) {
      credentials.delete(token);
    },

    size() {
      purgeExpired();
      return credentials.size;
    },
  };
}

function registerTravelJobRoutes(app, {
  jobs,
  requireAuth,
  resolveSupportSession,
  requireTravelAccess,
  blockWriteDuringReadOnlySupport,
  getRequestOrgId,
  findJobForOrg,
  sendResolverError,
  stopJobProcess,
  appendLog,
  finishJob,
  streamCredentials,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  async function requireJobOwnership(req, res, next) {
    try {
      const orgId = await getRequestOrgId(req);
      const job = findJobForOrg(jobs, req.params.id, orgId);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      req.job = job;
      next();
    } catch (err) {
      return sendResolverError(res, err, 'requireJobOwnership');
    }
  }

  function requireStreamAuth(req, res, next) {
    const credential = streamCredentials.resolve(req.query.stream_token, req.params.id);
    if (!credential) return res.status(401).end();
    req.user = credential.user;
    if (credential.supportSessionToken) {
      req.headers['x-support-session'] = credential.supportSessionToken;
    }
    req._streamCredential = credential;
    next();
  }

  app.post('/api/jobs/:id/stream-credential', requireAuth, resolveSupportSession, requireTravelAccess, requireJobOwnership,
    (req, res) => {
      const issued = streamCredentials.issue({
        user: req.user,
        jobId: req.params.id,
        supportSessionToken: req.headers['x-support-session'] || null,
      });
      res.json({ streamToken: issued.token, expiresAt: new Date(issued.expiresAt).toISOString() });
    }
  );

  app.get('/api/jobs/:id', requireAuth, resolveSupportSession, requireTravelAccess, requireJobOwnership,
    (req, res) => {
      const { proc, org_id, created_by_user_id, ...publicJob } = req.job;
      res.json(publicJob);
    }
  );

  app.get('/api/jobs/:id/stream', requireStreamAuth, resolveSupportSession, requireTravelAccess, requireJobOwnership,
    (req, res) => {
      const job = req.job;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      let cursor = 0;
      let timer = null;
      const clearTimer = () => {
        if (!timer) return;
        clearIntervalFn(timer);
        timer = null;
      };
      const send = () => {
        while (cursor < job.logs.length) {
          res.write(`data: ${JSON.stringify(job.logs[cursor++])}\n\n`);
        }
        if (job.status !== 'running') {
          res.write(`data: ${JSON.stringify({ done: true, status: job.status })}\n\n`);
          clearTimer();
          res.end();
        }
      };
      timer = setIntervalFn(send, 300);
      send();
      req.on('close', clearTimer);
    }
  );

  app.post('/api/jobs/:id/stop', requireAuth, resolveSupportSession, requireTravelAccess, blockWriteDuringReadOnlySupport, requireJobOwnership,
    (req, res) => {
      const job = req.job;
      if (job.status !== 'running') {
        return res.json({ ok: true, message: 'Job already finished' });
      }

      job.stopping = true;
      appendLog(req.params.id, '✗ Stop requested by user');

      try {
        const stopped = stopJobProcess(job);
        if (!stopped) appendLog(req.params.id, 'No active child process was attached to this job.');
        finishJob(req.params.id, false, -1);
        return res.json({ ok: true, stopped });
      } catch (err) {
        appendLog(req.params.id, `Stop failed: ${err.message}`);
        finishJob(req.params.id, false, -1);
        return res.status(500).json({ error: err.message });
      }
    }
  );

  return { requireJobOwnership, requireStreamAuth };
}

module.exports = {
  createStreamCredentialStore,
  registerTravelJobRoutes,
  DEFAULT_STREAM_CREDENTIAL_TTL_MS,
};
