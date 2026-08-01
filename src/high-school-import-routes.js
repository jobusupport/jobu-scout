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
// Import jobs reuse src/job-store.js's createJobRecord/findJobForOrg
// unmodified (already product-neutral, already the tenant-binding
// mechanism PR #21 hardened for Travel) against the SAME shared in-memory
// `jobs` object server.js already owns -- passed in as a dependency here,
// the same way server.js already passes it to registerTravelJobRoutes.

const path = require('path');
const { spawn: realSpawn } = require('child_process');
const policy = require('./gc-collection-policy');
const { mapErrorToResponse } = require('./org-resolution');
const rosterService = require('./high-school-roster-service');
const { createJobRecord, findJobForOrg } = require('./job-store');

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
    spawn = realSpawn, // overridable in tests only -- production always uses the real child_process.spawn
  } = deps;

  async function loadTeamAndSeason(orgId, teamId, seasonId) {
    const team = await rosterService.getTeamInOrg({ orgId, teamId, adminClient });
    if (!team) throw rosterService.typedError('Team not found', 404);
    const season = await rosterService.getSeasonInOrg({ orgId, seasonId, adminClient });
    if (!season) throw rosterService.typedError('Season not found', 404);
    return { team, season };
  }

  // Existing, currently-active roster for this team+season, shaped exactly
  // as src/high-school-importer-contract.js's matchPlayerCandidates
  // expects ({id, normalizedFirstName, normalizedLastName}) -- reads
  // hs_players.normalized_first_name/normalized_last_name, the generated
  // columns that module's own matching logic is built against, never a
  // freshly-lowercased copy computed here (would risk silently diverging
  // from the DB's own normalization rule).
  async function loadActiveRosterForReconciliation(orgId, teamId, seasonId) {
    const { data, error } = await adminClient
      .from('hs_roster_memberships')
      .select('player_id, hs_players!inner(id, normalized_first_name, normalized_last_name)')
      .eq('org_id', orgId)
      .eq('team_id', teamId)
      .eq('season_id', seasonId)
      .eq('status', 'active');
    if (error) throw error;
    return (data || []).map((row) => ({
      id: row.hs_players.id,
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
        },
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
      liveJob.stopping = true;
      if (liveJob.proc?.send) {
        try { liveJob.proc.send('cancel'); } catch { /* process may have exited between the status check and here */ }
      }
      const stopped = stopJobProcess(liveJob);
      const importService = req.app.locals.highSchoolImportService;
      await importService.failImportRun({ orgId: req._orgId, importRunId: req.params.runId, failureStage: 'discovery', rawErrorMessage: 'Cancelled by user.' });
      finishJob(liveJob.id, false, -1);
      res.json({ ok: true, stopped });
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
}

module.exports = { registerHighSchoolImportRoutes, normalizeAndValidateGcTeamUrl };
