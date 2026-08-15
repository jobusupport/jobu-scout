'use strict';

// High School GameChanger import HTTP surface -- source-team binding,
// import run lifecycle (start/status/list/cancel/retry), publication, and
// authenticated stat viewing. Mounted onto the SAME router
// src/high-school-api.js already builds (via registerHighSchoolImportRoutes,
// called once from that file's factory, right before it returns the
// router) -- so every route below inherits that file's own
// requireAuth -> resolveSupportSession -> requireHighSchoolAccess chain
// verbatim, and every mutating route below additionally requires
// blockWriteDuringReadOnlySupport, in that exact order, matching every
// existing High School route's established pattern (see
// high-school-api.js's own header comment).
//
// This file adds NO new authorization primitive. Team/season ownership is
// re-verified via high-school-roster-service.js's own exported
// getTeamInOrg/getSeasonInOrg (the same functions every existing write
// route already uses) -- never a bespoke lookup, so this can never
// silently diverge from the tenant-isolation guarantee those functions
// already provide.
//
// Import jobs reuse src/job-store.js's createJobRecord unmodified (already
// product-neutral, already the tenant-binding mechanism PR #21 hardened for
// Travel) against the SAME shared in-memory `jobs` object server.js already
// owns -- passed in as a dependency here, the same way server.js already
// passes it to registerTravelJobRoutes. Job lookups in THIS file (cancel,
// status, the kill-switch watchdog) search by import-run id rather than
// job id, so they use an inline `Object.values(jobs).find(...)` scoped by
// `j.org_id === req._orgId` instead of job-store's own findJobForOrg (which
// looks up by job id, a different key this file never has on hand) --
// the org_id-scoping guarantee is the same either way.

const path = require('path');
const { spawn: realSpawn } = require('child_process');
const policy = require('./gc-collection-policy');
const { mapErrorToResponse } = require('./org-resolution');
const rosterService = require('./high-school-roster-service');
const { createJobRecord } = require('./job-store');

const GC_TEAM_URL_RE = /^https:\/\/web\.gc\.com\/teams\/([^/]+)\/([^/?#]+)/i;

function sendResolverError(res, err, context) {
  console.error(`[${context}]`, err);
  const { statusCode, message } = mapErrorToResponse(err);
  return res.status(statusCode).json({ error: message });
}

// Normalizes and validates a coach-supplied GameChanger team URL, deriving
// the bare external team id GC-readiness columns expect
// (hs_teams.gc_external_team_id) -- see high-school-api.js's own team-URL
// format note for why this shape was chosen; mirrors
// src/search-gamechanger-teams.js's normalizeTeamUrl for the "prefix a bare
// /teams/... path" case, but is intentionally its own small, HS-scoped
// function rather than importing that module (which has real Playwright
// require()s at its top and is not meant to be pulled into a plain HTTP
// route handler).
function normalizeAndValidateGcTeamUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const withScheme = trimmed.startsWith('/teams/') ? `https://web.gc.com${trimmed}` : trimmed;
  const match = GC_TEAM_URL_RE.exec(withScheme);
  if (!match) {
    const err = new Error('gcTeamUrl must be a GameChanger team URL (https://web.gc.com/teams/<org>/<team>).');
    err.statusCode = 400;
    throw err;
  }
  return { normalizedUrl: withScheme.split(/[?#]/)[0], externalTeamId: match[2] };
}

function registerHighSchoolImportRoutes(router, deps) {
  const {
    adminClient,
    resolveSupportSession,
    blockWriteDuringReadOnlySupport,
    requireHighSchoolAccess,
    asyncHandler,
    requireAuth,
    jobs,
    appendLog,
    finishJob,
    attachJobProcess,
    stopJobProcess,
    importService: sharedImportService, // direct reference for the watchdog, which runs outside any request and has no `req.app.locals` to read
    spawn = realSpawn, // overridable in tests only -- production always uses the real child_process.spawn
  } = deps;

  // ── Genuine, runtime-responsive kill-switch propagation ────────────────
  //
  // The spawned collector child receives a ONE-TIME copy of process.env at
  // spawn -- it can never observe a later change to the server's own
  // environment on its own. Making GC_COLLECTION_ENABLED an actual runtime
  // control (not just a boot-time value a fresh process happens to read)
  // means the LONG-LIVED SERVER PROCESS -- which always sees a fresh
  // policy.isCollectionEnabled() on every call -- has to be the one that
  // notices the switch flip and PUSHES a stop signal to every active job,
  // rather than a child ever polling its own frozen copy. This function is
  // that push: called on a bounded interval by the real setInterval set up
  // in server.js (see gc-collection-policy.getKillSwitchWatchdogIntervalMs),
  // and callable directly and synchronously by tests to simulate a tick
  // without any real timer or wall-clock wait.
  //
  // This never waits for a user to open a status or list endpoint -- it is
  // not triggered by any HTTP request at all.
  function gracefulStopThenEscalate(job, { reason = 'cancel' } = {}) {
    const proc = job.proc;
    job.stopping = true;
    if (!proc || !proc.pid) return false;

    let settled = false;
    try { proc.once('exit', () => { settled = true; }); } catch { /* proc may already be gone */ }

    if (typeof proc.send === 'function' && proc.connected) {
      try {
        proc.send({ type: reason === 'kill_switch' ? 'kill_switch_disabled' : 'cancel' });
      } catch {
        /* IPC channel may already be closed -- the escalation timer below
           still guarantees the process is stopped either way. */
      }
    }

    const graceMs = policy.getCancelGraceMs();
    const escalationTarget = { proc, pid: proc.pid, status: 'running' };
    const timer = setTimeout(() => {
      if (settled) return;
      stopJobProcess(escalationTarget);
    }, graceMs);
    timer.unref?.();

    return true;
  }

  // Authoritative for BOTH why a run stopped and what its final persisted
  // status is -- this never depends on the child process cooperating,
  // finishing its own bookkeeping, or even still existing by the time this
  // resolves. The child's own graceful shutdown (see high-school-gc-import.js)
  // is still valuable for finishing the in-flight game cleanly, but DB
  // correctness never depends on it.
  async function markInterruptedRun(job, { rawErrorMessage }) {
    const importService = sharedImportService;
    if (!importService || !job.org_id || !job.importRunId) return;
    try {
      await importService.failImportRun({
        orgId: job.org_id,
        importRunId: job.importRunId,
        failureStage: 'discovery',
        rawErrorMessage,
      });
    } catch (err) {
      console.error('[hs-gc-import-watchdog] failed to mark interrupted run', err);
    }
  }

  // Called on a bounded interval (see server.js). Idempotent per job via
  // killSwitchHandled -- a job is signaled and marked exactly once, not
  // repeatedly on every subsequent tick while it winds down. Returns the
  // list of affected job ids, useful for tests and observability.
  function killSwitchWatchdogTick() {
    if (policy.isCollectionEnabled()) return [];
    const affected = [];
    for (const job of Object.values(jobs)) {
      if (job.productKind !== 'high_school_gc_import') continue;
      if (job.status !== 'running') continue;
      if (job.killSwitchHandled) continue;
      job.killSwitchHandled = true;
      affected.push(job.id);
      markInterruptedRun(job, { rawErrorMessage: 'Automated GameChanger collection was disabled by an operator while this run was in progress.' });
      gracefulStopThenEscalate(job, { reason: 'kill_switch' });
      finishJob(job.id, false, -1);
    }
    return affected;
  }

  async function loadTeamAndSeason(orgId, teamId, seasonId) {
    const team = await rosterService.getTeamInOrg({ orgId, teamId, adminClient });
    if (!team) throw rosterService.typedError('Team not found', 404);
    const season = await rosterService.getSeasonInOrg({ orgId, seasonId, adminClient });
    if (!season) throw rosterService.typedError('Season not found', 404);
    return { team, season };
  }

  // Existing, currently-active roster for this team+season, shaped exactly
  // as src/high-school-importer-contract.js's matchPlayerCandidates
  // expects, plus the roster-scoped stable provider ID Slice 2C may use for
  // verified canonical player mapping -- reads
  // hs_players.normalized_first_name/normalized_last_name, the generated
  // columns that module's own matching logic is built against, never a
  // freshly-lowercased copy computed here (would risk silently diverging
  // from the DB's own normalization rule).
  async function loadActiveRosterForReconciliation(orgId, teamId, seasonId) {
    const { data, error } = await adminClient
      .from('hs_roster_memberships')
      .select('player_id, gc_external_player_id, hs_players!inner(id, normalized_first_name, normalized_last_name)')
      .eq('org_id', orgId)
      .eq('team_id', teamId)
      .eq('season_id', seasonId)
      .eq('status', 'active');
    if (error) throw error;
    return (data || []).map((row) => ({
      id: row.hs_players.id,
      playerId: row.hs_players.id,
      gcExternalPlayerId: row.gc_external_player_id,
      normalizedFirstName: row.hs_players.normalized_first_name,
      normalizedLastName: row.hs_players.normalized_last_name,
    }));
  }

  function countActiveHsImportJobsForOrg(orgId) {
    return Object.values(jobs).filter(
      (j) => j.org_id === orgId && j.productKind === 'high_school_gc_import' && j.status === 'running'
    ).length;
  }

  // ── Source-team binding ──────────────────────────────────────────────
  router.patch('/teams/:teamId/gc-source', requireAuth, resolveSupportSession, requireHighSchoolAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const team = await rosterService.getTeamInOrg({ orgId: req._orgId, teamId: req.params.teamId, adminClient });
      if (!team) return res.status(404).json({ error: 'Team not found' });

      const { gcTeamUrl } = req.body || {};
      if (!gcTeamUrl) return res.status(400).json({ error: 'gcTeamUrl is required' });
      const { normalizedUrl, externalTeamId } = normalizeAndValidateGcTeamUrl(gcTeamUrl);

      // Changing the binding only ever touches this team's own two columns
      // -- no persisted import-run or canonical-game row references
      // gc_team_url dynamically, so this can never silently reassign a
      // historical import to a different source team.
      const { data, error } = await adminClient
        .from('hs_teams')
        .update({ gc_team_url: normalizedUrl, gc_external_team_id: externalTeamId, record_source: 'gamechanger' })
        .eq('id', team.id)
        .eq('org_id', req._orgId)
        .select('id, gc_team_url, gc_external_team_id, roster_sync_status')
        .maybeSingle();
      if (error) {
        if (error.code === '23505') {
          return res.status(409).json({ error: 'This GameChanger team is already bound to another team in your organization.' });
        }
        throw error;
      }
      res.json({ team: data });
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/teams/:teamId/gc-source (update)');
    }
  }));

  // Shared "start a new import run" implementation -- called both by the
  // POST /import-runs route directly and by the /retry route (a retry is
  // just a fresh call to this same path, see that route's own comment for
  // why re-dispatching to it rather than duplicating this logic is safer
  // than it sounds: no Express internals are involved, it's a plain
  // function call).
  async function startImportRun(req, res, context) {
    try {
      const { team, season } = await loadTeamAndSeason(req._orgId, req.params.teamId, req.params.seasonId);
      if (!team.gc_team_url) {
        return res.status(400).json({ error: 'This team has no GameChanger source connected yet.' });
      }
      if (!policy.isCollectionEnabled()) {
        return res.status(503).json({ error: 'Automated GameChanger collection is currently disabled.' });
      }
      if (countActiveHsImportJobsForOrg(req._orgId) >= policy.getMaxConcurrentImportJobs()) {
        return res.status(429).json({ error: 'Too many High School imports are already running for your organization. Try again shortly.' });
      }

      const importService = req.app.locals.highSchoolImportService;
      const run = await importService.startImportRun({
        orgId: req._orgId,
        programId: team.program_id,
        teamId: team.id,
        seasonId: season.id,
        sourceProvider: 'gamechanger',
        sourceTeamRef: team.gc_external_team_id || team.gc_team_url,
        triggerKind: 'manual',
        config: {},
      });

      const existingPlayers = await loadActiveRosterForReconciliation(req._orgId, team.id, season.id);

      const jobId = createJobRecord(jobs, `High School GameChanger import — ${team.name}`, req._orgId, { createdByUserId: req.user.id });
      jobs[jobId].productKind = 'high_school_gc_import';
      jobs[jobId].importRunId = run.id;
      jobs[jobId].teamId = team.id;
      jobs[jobId].seasonId = season.id;

      const scriptPath = path.join(__dirname, 'high-school-gc-import.js');
      const child = spawn('node', [scriptPath], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          HS_IMPORT_ORG_ID: req._orgId,
          HS_IMPORT_PROGRAM_ID: team.program_id,
          HS_IMPORT_TEAM_ID: team.id,
          HS_IMPORT_SEASON_ID: season.id,
          HS_IMPORT_RUN_ID: run.id,
          HS_IMPORT_TEAM_LABEL: team.name,
          HS_IMPORT_GC_TEAM_URL: team.gc_team_url,
          HS_IMPORT_EXISTING_PLAYERS_JSON: JSON.stringify(existingPlayers),
          HS_IMPORT_ENGINE_PERSISTENCE_ENABLED: '1',
        },
        // 'ipc' makes proc.send()/process.on('message', ...) actually work
        // between this server and the child -- without it, send() is
        // silently undefined and a graceful cancel/kill-switch message can
        // never be delivered (see gracefulStopThenEscalate above). detached
        // (non-Windows only, matching server.js's own spawnJob/makeRunStep
        // pattern) puts the child in its own process group so a later
        // process-group kill (stopJobProcess) reaches Playwright's Chromium
        // descendant too, not just the immediate Node child.
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        detached: process.platform !== 'win32',
      });
      attachJobProcess(jobId, child);
      child.stdout.on('data', (chunk) => String(chunk).split('\n').filter(Boolean).forEach((l) => appendLog(jobId, policy.sanitizeCollectionErrorMessage(l))));
      child.stderr.on('data', (chunk) => String(chunk).split('\n').filter(Boolean).forEach((l) => appendLog(jobId, policy.sanitizeCollectionErrorMessage(l))));
      child.on('close', (code) => finishJob(jobId, code === 0, code));

      res.status(201).json({ importRun: run, jobId });
    } catch (err) {
      return sendResolverError(res, err, context);
    }
  }

  router.post('/teams/:teamId/seasons/:seasonId/import-runs', requireAuth, resolveSupportSession, requireHighSchoolAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    return startImportRun(req, res, 'api/high-school/import-runs (start)');
  }));

  // ── List recent import runs for a team+season ────────────────────────
  router.get('/teams/:teamId/seasons/:seasonId/import-runs', requireAuth, resolveSupportSession, requireHighSchoolAccess, asyncHandler(async (req, res) => {
    try {
      await loadTeamAndSeason(req._orgId, req.params.teamId, req.params.seasonId);
      const importService = req.app.locals.highSchoolImportService;
      const importRuns = await importService.listImportRuns({ orgId: req._orgId, teamId: req.params.teamId, seasonId: req.params.seasonId });
      res.json({ importRuns, collectionEnabled: policy.isCollectionEnabled() });
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/import-runs (list)');
    }
  }));

  // ── Import run status + reconciliation/validation review ────────────
  router.get('/teams/:teamId/seasons/:seasonId/import-runs/:runId', requireAuth, resolveSupportSession, requireHighSchoolAccess, asyncHandler(async (req, res) => {
    try {
      await loadTeamAndSeason(req._orgId, req.params.teamId, req.params.seasonId);
      const importService = req.app.locals.highSchoolImportService;
      const { run, games: runGames, validations } = await importService.getImportRunDetail({ orgId: req._orgId, importRunId: req.params.runId });
      if (!run || run.team_id !== req.params.teamId || run.season_id !== req.params.seasonId) {
        return res.status(404).json({ error: 'Import run not found' });
      }

      const matched = new Map();
      const ambiguous = new Map();
      const unmatched = new Map();
      for (const g of runGames || []) {
        const r = g.diagnostics?.reconciliation;
        if (!r) continue;
        for (const m of r.matched || []) matched.set(m.playerId, m.name);
        for (const a of r.ambiguous || []) ambiguous.set(a.name, a.candidatePlayerIds);
        for (const u of r.unmatched || []) unmatched.set(u.name, true);
      }

      const blockingValidation = (validations || []).some((v) => v.validation_status === 'mismatched');
      const publishable = run.status === 'succeeded' && !blockingValidation && (validations || []).every((v) => v.has_box_score);

      // Live job progress, if the spawned process is still tracked in
      // memory (server restart or process exit after completion means
      // this is simply absent -- the persisted DB rows above remain the
      // durable source of truth regardless).
      const liveJob = Object.values(jobs).find((j) => j.importRunId === run.id && j.org_id === req._orgId);

      res.json({
        importRun: run,
        games: (runGames || []).map((g) => ({
          id: g.id,
          sourceGameRef: g.source_game_ref,
          discoveryStatus: g.discovery_status,
          gameOutcome: g.game_outcome,
          hsGameId: g.hs_game_id,
        })),
        validations: validations || [],
        reconciliation: {
          matched: [...matched.entries()].map(([playerId, name]) => ({ playerId, name })),
          ambiguous: [...ambiguous.entries()].map(([name, candidatePlayerIds]) => ({ name, candidatePlayerIds })),
          unmatched: [...unmatched.keys()].map((name) => ({ name })),
        },
        publishable,
        liveJob: liveJob ? { id: liveJob.id, status: liveJob.status, logs: liveJob.logs.slice(-100) } : null,
      });
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/import-runs/:runId (status)');
    }
  }));

  // ── Cancel a running import ───────────────────────────────────────────
  router.post('/teams/:teamId/seasons/:seasonId/import-runs/:runId/cancel', requireAuth, resolveSupportSession, requireHighSchoolAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      await loadTeamAndSeason(req._orgId, req.params.teamId, req.params.seasonId);
      const liveJob = Object.values(jobs).find((j) => j.importRunId === req.params.runId && j.org_id === req._orgId);
      if (!liveJob || liveJob.status !== 'running') {
        return res.status(409).json({ error: 'This import is not currently running.' });
      }
      // The run's persisted status is marked here, synchronously, before
      // this route even attempts to stop the process -- correctness never
      // depends on the child cooperating with the graceful IPC message or
      // even still existing by the time the grace period elapses.
      const importService = req.app.locals.highSchoolImportService;
      await importService.failImportRun({ orgId: req._orgId, importRunId: req.params.runId, failureStage: 'discovery', rawErrorMessage: 'Cancelled by user.' });
      const initiated = gracefulStopThenEscalate(liveJob, { reason: 'cancel' });
      finishJob(liveJob.id, false, -1);
      res.json({ ok: true, stopped: initiated });
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/import-runs/:runId/cancel');
    }
  }));

  // ── Retry an eligible failed/partial import ──────────────────────────
  router.post('/teams/:teamId/seasons/:seasonId/import-runs/:runId/retry', requireAuth, resolveSupportSession, requireHighSchoolAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const { team, season } = await loadTeamAndSeason(req._orgId, req.params.teamId, req.params.seasonId);
      const importService = req.app.locals.highSchoolImportService;
      const { run: priorRun } = await importService.getImportRunDetail({ orgId: req._orgId, importRunId: req.params.runId });
      if (!priorRun || priorRun.team_id !== team.id || priorRun.season_id !== season.id) {
        return res.status(404).json({ error: 'Import run not found' });
      }
      if (!['failed', 'partial'].includes(priorRun.status)) {
        return res.status(409).json({ error: 'Only a failed or partial import run can be retried.' });
      }
      // A retry is a brand-new run, not a mutation of the old one -- calls
      // the exact same startImportRun implementation the POST route above
      // uses (including its own kill switch / concurrency checks), and
      // relies entirely on the persistence layer's own existing idempotency
      // (resolveOrCreateGame select-then-insert-with-reselect-on-conflict)
      // to skip games the failed run already completed successfully
      // before it failed.
      return startImportRun(req, res, 'api/high-school/import-runs/:runId/retry');
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/import-runs/:runId/retry');
    }
  }));

  // ── Publish the reviewed import ───────────────────────────────────────
  router.post('/teams/:teamId/seasons/:seasonId/import-runs/:runId/publish', requireAuth, resolveSupportSession, requireHighSchoolAccess, blockWriteDuringReadOnlySupport, asyncHandler(async (req, res) => {
    try {
      const { team, season } = await loadTeamAndSeason(req._orgId, req.params.teamId, req.params.seasonId);
      const importService = req.app.locals.highSchoolImportService;
      const { run, games: runGames } = await importService.getImportRunDetail({ orgId: req._orgId, importRunId: req.params.runId });
      if (!run || run.team_id !== team.id || run.season_id !== season.id) {
        return res.status(404).json({ error: 'Import run not found' });
      }
      if (run.status !== 'succeeded') {
        return res.status(409).json({ error: 'Only a fully succeeded import run can be published.' });
      }

      // Slice 2C collection runs are already published atomically by the
      // ingestion RPC that finalized them. A later review-button click is a
      // read-only acknowledgement, never a second generation write.
      if (run.result_summary?.generationId) {
        const published = await importService.getPublishedStats({ orgId: req._orgId, teamId: team.id, seasonId: season.id });
        return res.json({
          alreadyPublished: true,
          generationId: run.result_summary.generationId,
          verifiedTotals: published.verifiedTotals,
          publishedPlayers: published.playerAdvancedStats,
          publishedPitchers: published.pitcherAdvancedStats,
        });
      }

      // The publish service call independently re-derives and re-checks
      // box-score coverage and mismatch counts itself -- this route never
      // trusts any client-supplied aggregate.
      // getCapturedGamesForRun rebuilds the exact captured (already
      // isHighSchoolTeam-tagged) box-score/play-by-play shape from this
      // run's OWN persisted raw snapshots -- never a fresh scrape, never
      // anything the HTTP request body could influence.
      const gamesForAggregate = await importService.getCapturedGamesForRun({ orgId: req._orgId, importRunId: run.id });
      if (gamesForAggregate.length === 0) {
        return res.status(409).json({ error: 'This import run has no successfully captured games to publish.' });
      }

      const totals = await importService.publishVerifiedTotals({
        orgId: req._orgId,
        programId: team.program_id,
        teamId: team.id,
        seasonId: season.id,
        importRunId: run.id,
        games: gamesForAggregate,
      });

      const matchedPlayers = new Map();
      for (const g of runGames || []) {
        for (const m of g.diagnostics?.reconciliation?.matched || []) matchedPlayers.set(m.playerId, true);
      }
      const publishedPlayers = [];
      for (const playerId of matchedPlayers.keys()) {
        try {
          const stats = await importService.publishPlayerAdvancedStats({
            orgId: req._orgId, programId: team.program_id, teamId: team.id, seasonId: season.id, importRunId: run.id, hsPlayerId: playerId, stats: {},
          });
          publishedPlayers.push({ playerId, published: true, current: stats.is_current });
        } catch (err) {
          publishedPlayers.push({ playerId, published: false, error: mapErrorToResponse(err).message });
        }
      }

      res.json({ verifiedTotals: totals, publishedPlayers });
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/import-runs/:runId/publish');
    }
  }));

  // ── Authenticated stat viewing ────────────────────────────────────────
  router.get('/teams/:teamId/seasons/:seasonId/stats', requireAuth, resolveSupportSession, requireHighSchoolAccess, asyncHandler(async (req, res) => {
    try {
      await loadTeamAndSeason(req._orgId, req.params.teamId, req.params.seasonId);
      const importService = req.app.locals.highSchoolImportService;
      const stats = await importService.getPublishedStats({ orgId: req._orgId, teamId: req.params.teamId, seasonId: req.params.seasonId });
      res.json(stats);
    } catch (err) {
      return sendResolverError(res, err, 'api/high-school/teams/:teamId/seasons/:seasonId/stats');
    }
  }));

  // Returned so the caller (src/high-school-api.js -> server.js) can wire
  // killSwitchWatchdogTick to a real setInterval -- this function itself
  // never starts a timer, so calling registerHighSchoolImportRoutes never
  // has a global-timer side effect, and tests can invoke the tick directly
  // and synchronously without any real wall-clock wait or leaked interval.
  return { killSwitchWatchdogTick };
}

module.exports = { registerHighSchoolImportRoutes, normalizeAndValidateGcTeamUrl };
