'use strict';

const crypto = require('crypto');

const DEFAULT_STREAM_CREDENTIAL_TTL_MS = 2 * 60 * 1000;

function createStreamCredentialStore({
  now = () => Date.now(),
  randomBytes = crypto.randomBytes,
  ttlMs = DEFAULT_STREAM_CREDENTIAL_TTL_MS,
} = {}) {
  const bootstraps = new Map();
  const bootstrapByBinding = new Map();
  const activeStreams = new Map();

  function purgeExpired() {
    const currentTime = now();
    for (const [token, entry] of bootstraps) {
      if (entry.expiresAt <= currentTime) {
        bootstraps.delete(token);
        if (bootstrapByBinding.get(entry.bindingKey) === token) {
          bootstrapByBinding.delete(entry.bindingKey);
        }
      }
    }
    for (const [bindingKey, lease] of activeStreams) {
      if (lease.expiresAt <= currentTime) {
        activeStreams.delete(bindingKey);
        lease.close();
      }
    }
  }

  function bindingKeyFor({ user, jobId, orgId, supportSessionToken }) {
    const supportBinding = supportSessionToken
      ? crypto.createHash('sha256').update(supportSessionToken).digest('hex')
      : null;
    return JSON.stringify([
      user.id,
      jobId,
      orgId,
      supportBinding,
    ]);
  }

  return {
    // State machine:
    // issued bootstrap -> synchronously consumed -> active generation
    // -> disconnected/released -> fresh authenticated bootstrap for reconnect.
    // Tokens are never reinserted. Issuing a fresh bootstrap revokes an older
    // active generation for the same authorization context, allowing the
    // authenticated browser to recover if a stolen token won the initial race.
    issue({ user, jobId, orgId, supportSessionToken = null }) {
      if (!user?.id || typeof jobId !== 'string' || !jobId || typeof orgId !== 'string' || !orgId) {
        throw new TypeError('A verified user, job ID, and organization are required.');
      }
      purgeExpired();
      const bindingKey = bindingKeyFor({ user, jobId, orgId, supportSessionToken });
      const previousLease = activeStreams.get(bindingKey);
      if (previousLease) {
        activeStreams.delete(bindingKey);
        previousLease.close();
      }
      const previousBootstrap = bootstrapByBinding.get(bindingKey);
      if (previousBootstrap) bootstraps.delete(previousBootstrap);
      const token = randomBytes(32).toString('hex');
      const entry = Object.freeze({
        user: Object.freeze({ id: user.id, email: user.email || null }),
        jobId,
        orgId,
        supportSessionToken: supportSessionToken || null,
        bindingKey,
        generationId: randomBytes(16).toString('hex'),
        expiresAt: now() + ttlMs,
      });
      bootstraps.set(token, entry);
      bootstrapByBinding.set(bindingKey, token);
      return { token, expiresAt: entry.expiresAt };
    },

    consume(token, jobId) {
      purgeExpired();
      if (typeof token !== 'string' || !token) return null;
      const entry = bootstraps.get(token);
      if (!entry || entry.jobId !== jobId) return null;
      // Map lookup and deletion are synchronous: two competing HTTP requests
      // cannot both cross this transition in JavaScript's execution model.
      bootstraps.delete(token);
      if (bootstrapByBinding.get(entry.bindingKey) === token) {
        bootstrapByBinding.delete(entry.bindingKey);
      }
      return entry;
    },

    activate(entry, close) {
      purgeExpired();
      if (!entry || typeof close !== 'function' || entry.expiresAt <= now()) return null;
      if (activeStreams.has(entry.bindingKey)) return null;
      const lease = Object.freeze({
        bindingKey: entry.bindingKey,
        generationId: entry.generationId,
        expiresAt: entry.expiresAt,
        close,
      });
      activeStreams.set(entry.bindingKey, lease);
      return lease;
    },

    release(lease) {
      if (!lease) return;
      const active = activeStreams.get(lease.bindingKey);
      if (active?.generationId === lease.generationId) {
        activeStreams.delete(lease.bindingKey);
      }
    },

    size() {
      purgeExpired();
      return bootstraps.size;
    },

    activeSize() {
      purgeExpired();
      return activeStreams.size;
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
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  afterStreamCredentialConsumed = async () => {},
  onStreamOpened = () => {},
}) {
  async function requireJobOwnership(req, res, next) {
    try {
      const orgId = await getRequestOrgId(req);
      const job = findJobForOrg(jobs, req.params.id, orgId);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      req.job = job;
      req._jobOrgId = orgId;
      next();
    } catch (err) {
      return sendResolverError(res, err, 'requireJobOwnership');
    }
  }

  async function requireStreamAuth(req, res, next) {
    const credential = streamCredentials.consume(req.query.stream_token, req.params.id);
    if (!credential) return res.status(401).end();
    req.user = credential.user;
    if (credential.supportSessionToken) {
      req.headers['x-support-session'] = credential.supportSessionToken;
    }
    req._streamCredential = credential;
    await afterStreamCredentialConsumed(credential);
    next();
  }

  app.post('/api/jobs/:id/stream-credential', requireAuth, resolveSupportSession, requireTravelAccess, requireJobOwnership,
    (req, res) => {
      const issued = streamCredentials.issue({
        user: req.user,
        jobId: req.params.id,
        orgId: req._jobOrgId,
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
      let timer = null;
      let expiryTimer = null;
      let lease = null;
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (timer) clearIntervalFn(timer);
        if (expiryTimer) clearTimeoutFn(expiryTimer);
        timer = null;
        expiryTimer = null;
        if (lease) streamCredentials.release(lease);
      };
      const closeStream = () => {
        cleanup();
        if (!res.writableEnded) res.end();
      };
      if (req._jobOrgId !== req._streamCredential.orgId) {
        return res.status(401).end();
      }
      lease = streamCredentials.activate(req._streamCredential, closeStream);
      if (!lease) return res.status(401).end();

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      let cursor = 0;
      const send = () => {
        while (cursor < job.logs.length) {
          res.write(`data: ${JSON.stringify(job.logs[cursor++])}\n\n`);
        }
        if (job.status !== 'running') {
          res.write(`data: ${JSON.stringify({ done: true, status: job.status })}\n\n`);
          closeStream();
        }
      };
      timer = setIntervalFn(send, 300);
      expiryTimer = setTimeoutFn(closeStream, Math.max(0, lease.expiresAt - Date.now()));
      send();
      req.on('close', cleanup);
      onStreamOpened({ lease, req, res });
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
