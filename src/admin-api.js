'use strict';

// Jobu Scout platform-admin API. Mounted at /api/admin in server.js. Every
// route (other than /status) requires requireAuth + requireJobuAdmin — see
// src/admin-lib.js for the centralized authorization/audit helpers.

const express = require('express');
const { adminClient } = require('./supabase');
const { limitsColumnsForTier } = require('./stripe');
const {
  isJobuAdmin,
  requireJobuAdmin,
  logAdminAction,
  startSupportSession,
  endSupportSession,
  resolveSupportSession,
} = require('./admin-lib');
const { handleProductChange } = require('./admin-product-route');

const UNLIMITED_VALUE = 999999; // matches the sentinel already used on the house account

const METRIC_KEYS = [
  'max_opponent_teams',
  'max_reports_per_month',
  'max_users',
  'max_self_scout_reports_per_month',
  'max_matchup_reports_per_month',
];

function escapeIlike(s) {
  return String(s).replace(/[%_,]/g, m => '\\' + m);
}

function paginationParams(req, { defaultSize = 25, maxSize = 100 } = {}) {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || defaultSize, 1), maxSize);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  return { page, pageSize, from, to };
}

// requireAuth is owned by server.js — injected so this module doesn't
// duplicate JWT verification logic.
module.exports = function createAdminRouter({ requireAuth }) {
  const router = express.Router();

  // ── Status (used by the dashboard button + the admin page's own gate) ─────
  router.get('/status', requireAuth, async (req, res) => {
    const { isAdmin, role } = await isJobuAdmin(req.user);
    res.json({ isAdmin, role });
  });

  router.use(requireAuth, requireJobuAdmin);

  // ── Dashboard ───────────────────────────────────────────────────────────
  router.get('/dashboard', async (req, res) => {
    const { data, error } = await adminClient.rpc('admin_dashboard_metrics');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // ── Customers ───────────────────────────────────────────────────────────
  router.get('/customers', async (req, res) => {
    const { page, pageSize, from, to } = paginationParams(req);
    let query = adminClient.from('admin_customer_overview').select('*', { count: 'exact' });

    const search = (req.query.search || '').trim();
    if (search) {
      const esc = escapeIlike(search);
      query = query.or(`name.ilike.%${esc}%,slug.ilike.%${esc}%,contact_email.ilike.%${esc}%`);
    }
    if (req.query.status) query = query.eq('status', req.query.status);
    if (req.query.plan) query = query.eq('plan', req.query.plan);

    query = query.order('created_at', { ascending: false }).range(from, to);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ customers: data, total: count, page, pageSize });
  });

  router.get('/customers/:orgId', async (req, res) => {
    const { orgId } = req.params;
    const [orgRes, membersRes, teamsRes, reportsRes, scrapesRes, overridesRes, notesRes, auditRes] = await Promise.all([
      adminClient.from('admin_customer_overview').select('*').eq('id', orgId).maybeSingle(),
      adminClient.from('org_members').select('id,user_id,role,accepted_at,created_at').eq('org_id', orgId).order('created_at'),
      adminClient.from('teams').select('id,team_name,is_our_team,archived,created_at').eq('org_id', orgId).order('created_at', { ascending: false }),
      adminClient.from('reports').select('id,title,report_type,status,format,generated_at,created_at,error_message').eq('org_id', orgId).order('created_at', { ascending: false }).limit(25),
      adminClient.from('scrape_jobs').select('id,source,status,games_found,games_ingested,started_at,finished_at,error_message,created_at').eq('org_id', orgId).order('created_at', { ascending: false }).limit(25),
      adminClient.from('org_entitlement_overrides').select('*').eq('org_id', orgId).order('created_at', { ascending: false }),
      adminClient.from('org_support_notes').select('*').eq('org_id', orgId).order('created_at', { ascending: false }),
      adminClient.from('admin_audit_log').select('*').eq('org_id', orgId).order('created_at', { ascending: false }).limit(25),
    ]);

    if (orgRes.error) return res.status(500).json({ error: orgRes.error.message });
    if (!orgRes.data) return res.status(404).json({ error: 'Customer not found' });

    const members = await Promise.all((membersRes.data || []).map(async m => {
      try {
        const { data } = await adminClient.auth.admin.getUserById(m.user_id);
        return { ...m, email: data?.user?.email || null };
      } catch {
        return { ...m, email: null };
      }
    }));

    res.json({
      organization: orgRes.data,
      members,
      teams: teamsRes.data || [],
      reports: reportsRes.data || [],
      scrapeJobs: scrapesRes.data || [],
      overrides: overridesRes.data || [],
      notes: notesRes.data || [],
      auditLog: auditRes.data || [],
    });
  });

  router.post('/customers/:orgId/status', async (req, res) => {
    const { orgId } = req.params;
    const { status, reason } = req.body || {};
    if (!['active', 'suspended', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: "status must be 'active', 'suspended', or 'cancelled'" });
    }
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required.' });

    const { data: before } = await adminClient.from('organizations').select('status').eq('id', orgId).maybeSingle();
    if (!before) return res.status(404).json({ error: 'Customer not found' });

    const { error } = await adminClient.from('organizations').update({ status }).eq('id', orgId);
    if (error) return res.status(500).json({ error: error.message });

    await logAdminAction({
      req, adminUser: req.user, adminRole: req.adminRole, orgId,
      action: 'tenant_status_changed', resourceType: 'organization', resourceId: orgId,
      oldValues: { status: before.status }, newValues: { status }, reason,
    });
    res.json({ ok: true, status });
  });

  router.post('/customers/:orgId/overrides', async (req, res) => {
    const { orgId } = req.params;
    const { metricKey, value, isUnlimited, expiresAt, reason, action } = req.body || {};
    if (!METRIC_KEYS.includes(metricKey)) return res.status(400).json({ error: 'Unknown metric key' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required.' });

    const { data: org } = await adminClient.from('organizations').select(`plan, ${metricKey}`).eq('id', orgId).maybeSingle();
    if (!org) return res.status(404).json({ error: 'Customer not found' });
    const previousValue = org[metricKey];

    let newValue;
    if (action === 'restore_default') {
      newValue = limitsColumnsForTier(org.plan)[metricKey];
    } else if (isUnlimited) {
      newValue = UNLIMITED_VALUE;
    } else {
      newValue = parseInt(value, 10);
      if (!Number.isFinite(newValue) || newValue < 0) {
        return res.status(400).json({ error: 'value must be a non-negative integer' });
      }
    }

    const { error: updateErr } = await adminClient.from('organizations').update({ [metricKey]: newValue }).eq('id', orgId);
    if (updateErr) return res.status(500).json({ error: updateErr.message });

    await adminClient.from('org_entitlement_overrides').insert({
      org_id: orgId,
      metric_key: metricKey,
      previous_value: previousValue,
      override_value: newValue,
      is_unlimited: newValue === UNLIMITED_VALUE,
      expires_at: expiresAt || null,
      reason,
      created_by: req.user.id,
    });

    await logAdminAction({
      req, adminUser: req.user, adminRole: req.adminRole, orgId,
      action: action === 'restore_default' ? 'entitlement_restored_default' : 'entitlement_overridden',
      resourceType: 'organization', resourceId: orgId,
      oldValues: { [metricKey]: previousValue }, newValues: { [metricKey]: newValue }, reason,
    });

    res.json({ ok: true, metricKey, previousValue, newValue });
  });

  // Slice 2 (Phase 2 RFC §14). resolveSupportSession is mounted only on
  // this route -- it's a no-op when no X-Support-Session header is
  // present, and populates req._supportSession when one is, which
  // handleProductChange uses to unconditionally deny the request (see its
  // own comment: changing product access must always be an action taken
  // as the admin, never "as" a support session).
  router.patch('/customers/:orgId/product', resolveSupportSession, async (req, res) => {
    try {
      const result = await handleProductChange({
        orgId: req.params.orgId,
        body: req.body,
        hasSupportSession: !!req._supportSession,
        adminUser: req.user,
        adminRole: req.adminRole,
        req,
        fetchOrg: (id) => adminClient.from('organizations').select('id').eq('id', id).maybeSingle(),
        callRpc: (fn, args) => adminClient.rpc(fn, args),
      });
      res.json(result);
    } catch (err) {
      const statusCode = err.statusCode || 500;
      const message = err.statusCode ? err.message : 'Something went wrong. Please try again.';
      res.status(statusCode).json({ error: message });
    }
  });

  router.post('/customers/:orgId/notes', async (req, res) => {
    const { orgId } = req.params;
    const note = (req.body?.note || '').trim();
    if (!note) return res.status(400).json({ error: 'note is required' });

    const { data, error } = await adminClient
      .from('org_support_notes')
      .insert({ org_id: orgId, admin_user_id: req.user.id, note })
      .select('*')
      .single();
    if (error) return res.status(500).json({ error: error.message });

    await logAdminAction({
      req, adminUser: req.user, adminRole: req.adminRole, orgId,
      action: 'support_note_added', resourceType: 'organization', resourceId: orgId,
    });
    res.json({ ok: true, note: data });
  });

  // ── Support-view sessions ───────────────────────────────────────────────
  router.post('/support-sessions', async (req, res) => {
    const { orgId, reason } = req.body || {};
    if (!orgId) return res.status(400).json({ error: 'orgId is required' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required.' });

    const { data: org } = await adminClient.from('organizations').select('id,name').eq('id', orgId).maybeSingle();
    if (!org) return res.status(404).json({ error: 'Customer not found' });

    const session = await startSupportSession({ adminUser: req.user, orgId, reason });

    await logAdminAction({
      req, adminUser: req.user, adminRole: req.adminRole, orgId,
      supportSessionId: session.id, action: 'support_session_started',
      resourceType: 'organization', resourceId: orgId, reason,
    });

    res.json({
      ok: true,
      sessionId: session.id,
      token: session.token,
      orgId: org.id,
      orgName: org.name,
      mode: session.mode,
      expiresAt: session.expires_at,
    });
  });

  router.post('/support-sessions/:id/end', async (req, res) => {
    const session = await endSupportSession({
      sessionId: req.params.id, adminUser: req.user, reason: req.body?.reason || null,
    });
    if (!session) return res.status(404).json({ error: 'Support session not found or already ended.' });

    await logAdminAction({
      req, adminUser: req.user, adminRole: req.adminRole, orgId: session.org_id,
      supportSessionId: session.id, action: 'support_session_ended',
      resourceType: 'organization', resourceId: session.org_id,
    });
    res.json({ ok: true });
  });

  // ── Reports ─────────────────────────────────────────────────────────────
  router.get('/reports', async (req, res) => {
    const { page, pageSize, from, to } = paginationParams(req);
    let query = adminClient
      .from('reports')
      .select('id,org_id,title,report_type,status,format,ai_model,games_analyzed,error_message,created_at,generated_at,created_by', { count: 'exact' });

    if (req.query.orgId) query = query.eq('org_id', req.query.orgId);
    if (req.query.status) query = query.eq('status', req.query.status);
    if (req.query.reportType) query = query.eq('report_type', req.query.reportType);

    query = query.order('created_at', { ascending: false }).range(from, to);
    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const orgIds = [...new Set((data || []).map(r => r.org_id).filter(Boolean))];
    let orgNames = {};
    if (orgIds.length) {
      const { data: orgs } = await adminClient.from('organizations').select('id,name').in('id', orgIds);
      orgNames = Object.fromEntries((orgs || []).map(o => [o.id, o.name]));
    }
    const reports = (data || []).map(r => ({ ...r, orgName: orgNames[r.org_id] || null }));
    res.json({ reports, total: count, page, pageSize });
  });

  // ── Usage / AI cost ─────────────────────────────────────────────────────
  router.get('/usage', async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const { data: events, error } = await adminClient
      .from('ai_usage_events')
      .select('org_id, model, input_tokens, output_tokens, estimated_cost_usd, success, created_at, report_id')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(5000);
    if (error) return res.status(500).json({ error: error.message });

    const byModel = {}, byOrg = {}, byDay = {};
    let totalCost = 0, totalInput = 0, totalOutput = 0, failedCost = 0;

    for (const e of events) {
      const cost = Number(e.estimated_cost_usd) || 0;
      totalCost += cost;
      totalInput += e.input_tokens || 0;
      totalOutput += e.output_tokens || 0;
      if (!e.success) failedCost += cost;

      (byModel[e.model] ??= { model: e.model, cost: 0, inputTokens: 0, outputTokens: 0, count: 0 });
      byModel[e.model].cost += cost;
      byModel[e.model].inputTokens += e.input_tokens || 0;
      byModel[e.model].outputTokens += e.output_tokens || 0;
      byModel[e.model].count += 1;

      const orgKey = e.org_id || 'unattributed';
      (byOrg[orgKey] ??= { orgId: e.org_id, cost: 0, count: 0 });
      byOrg[orgKey].cost += cost;
      byOrg[orgKey].count += 1;

      const day = e.created_at.slice(0, 10);
      (byDay[day] ??= { day, cost: 0, count: 0 });
      byDay[day].cost += cost;
      byDay[day].count += 1;
    }

    const orgIds = Object.values(byOrg).map(o => o.orgId).filter(Boolean);
    let orgNames = {};
    if (orgIds.length) {
      const { data: orgs } = await adminClient.from('organizations').select('id,name').in('id', orgIds);
      orgNames = Object.fromEntries((orgs || []).map(o => [o.id, o.name]));
    }
    const byOrgList = Object.values(byOrg)
      .map(o => ({ ...o, orgName: o.orgId ? (orgNames[o.orgId] || 'Unknown') : 'Unattributed (CLI run)' }))
      .sort((a, b) => b.cost - a.cost);

    res.json({
      days,
      totals: { costUsd: totalCost, inputTokens: totalInput, outputTokens: totalOutput, failedCostUsd: failedCost, eventCount: events.length },
      byModel: Object.values(byModel).sort((a, b) => b.cost - a.cost),
      byOrg: byOrgList,
      byDay: Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)),
    });
  });

  // ── System health ───────────────────────────────────────────────────────
  router.get('/system-health', async (req, res) => {
    const [runningScrapes, failingScrapes, queuedReports, failedReports, orgs] = await Promise.all([
      adminClient.from('scrape_jobs').select('id,org_id,team_id,source,source_url,started_at').eq('status', 'running'),
      adminClient.from('scrape_jobs').select('id,org_id,team_id,source,error_message,finished_at').eq('status', 'failed').order('finished_at', { ascending: false }).limit(25),
      adminClient.from('reports').select('id,org_id,title,report_type,created_at').in('status', ['pending', 'generating']).order('created_at'),
      adminClient.from('reports').select('id,org_id,title,report_type,error_message,updated_at').eq('status', 'failed').order('updated_at', { ascending: false }).limit(25),
      adminClient.from('admin_customer_overview').select('id,name,last_successful_scrape_at').order('last_successful_scrape_at', { ascending: true, nullsFirst: true }).limit(50),
    ]);

    const staleThresholdMs = 14 * 24 * 60 * 60 * 1000;
    const staleScrapeOrgs = (orgs.data || []).filter(o => {
      if (!o.last_successful_scrape_at) return true;
      return Date.now() - new Date(o.last_successful_scrape_at).getTime() > staleThresholdMs;
    }).slice(0, 20);

    res.json({
      runningScrapes: runningScrapes.data || [],
      failingScrapes: failingScrapes.data || [],
      queuedReports: queuedReports.data || [],
      failedReports: failedReports.data || [],
      staleScrapeOrgs,
    });
  });

  // ── Audit log ───────────────────────────────────────────────────────────
  router.get('/audit-log', async (req, res) => {
    const { page, pageSize, from, to } = paginationParams(req, { defaultSize: 50, maxSize: 200 });
    let query = adminClient.from('admin_audit_log').select('*', { count: 'exact' });
    if (req.query.orgId) query = query.eq('org_id', req.query.orgId);
    if (req.query.adminId) query = query.eq('admin_user_id', req.query.adminId);
    if (req.query.action) query = query.eq('action', req.query.action);
    if (req.query.from) query = query.gte('created_at', req.query.from);
    if (req.query.to) query = query.lte('created_at', req.query.to);
    query = query.order('created_at', { ascending: false }).range(from, to);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ entries: data, total: count, page, pageSize });
  });

  // ── Feature flags ───────────────────────────────────────────────────────
  router.get('/feature-flags', async (req, res) => {
    const { data, error } = await adminClient.from('feature_flags').select('*').order('key');
    if (error) return res.status(500).json({ error: error.message });
    res.json({ flags: data });
  });

  router.post('/feature-flags', async (req, res) => {
    const { key, name, description } = req.body || {};
    if (!key || !name) return res.status(400).json({ error: 'key and name are required' });

    const { data, error } = await adminClient
      .from('feature_flags')
      .insert({ key, name, description: description || null })
      .select('*')
      .single();
    if (error) return res.status(500).json({ error: error.message });

    await logAdminAction({
      req, adminUser: req.user, adminRole: req.adminRole,
      action: 'feature_flag_created', resourceType: 'feature_flag', resourceId: key, newValues: data,
    });
    res.json({ ok: true, flag: data });
  });

  router.put('/feature-flags/:key', async (req, res) => {
    const { key } = req.params;
    const { isGloballyEnabled, enabledPlans, reason } = req.body || {};

    const { data: before } = await adminClient.from('feature_flags').select('*').eq('key', key).maybeSingle();
    if (!before) return res.status(404).json({ error: 'Feature flag not found' });

    const updates = {};
    if (typeof isGloballyEnabled === 'boolean') updates.is_globally_enabled = isGloballyEnabled;
    if (Array.isArray(enabledPlans)) updates.enabled_plans = enabledPlans;
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

    const { data, error } = await adminClient.from('feature_flags').update(updates).eq('key', key).select('*').single();
    if (error) return res.status(500).json({ error: error.message });

    await logAdminAction({
      req, adminUser: req.user, adminRole: req.adminRole,
      action: 'feature_flag_changed', resourceType: 'feature_flag', resourceId: key,
      oldValues: before, newValues: data, reason: reason || null,
    });
    res.json({ ok: true, flag: data });
  });

  // ── Platform settings ───────────────────────────────────────────────────
  router.get('/settings', async (req, res) => {
    const { data, error } = await adminClient.from('platform_settings').select('*').eq('id', true).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ settings: data });
  });

  router.put('/settings', async (req, res) => {
    const { reason, ...fields } = req.body || {};
    const ALLOWED = ['monthly_ai_budget_usd', 'hard_ai_spend_limit_usd', 'last_verified_credit_balance_usd', 'budget_ceiling_action', 'maintenance_mode'];
    const updates = {};
    for (const k of ALLOWED) if (k in fields) updates[k] = fields[k];
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

    if ('last_verified_credit_balance_usd' in updates) {
      updates.credit_balance_verified_at = new Date().toISOString();
      updates.credit_balance_verified_by = req.user.id;
    }
    updates.updated_by = req.user.id;

    const { data: before } = await adminClient.from('platform_settings').select('*').eq('id', true).maybeSingle();
    const { data, error } = await adminClient.from('platform_settings').update(updates).eq('id', true).select('*').single();
    if (error) return res.status(500).json({ error: error.message });

    await logAdminAction({
      req, adminUser: req.user, adminRole: req.adminRole,
      action: 'platform_settings_changed', resourceType: 'platform_settings', resourceId: 'singleton',
      oldValues: before, newValues: data, reason: reason || null,
    });
    res.json({ ok: true, settings: data });
  });

  return router;
};
