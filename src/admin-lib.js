'use strict';

// Centralized Jobu Scout platform-admin authorization, audit logging, and
// secure customer-support-view session handling. Every admin-gated route in
// src/admin-api.js, and every customer route that needs to respect an active
// support session, goes through this module — do not scatter raw
// `user.email === 'support@jobuscout.com'` checks anywhere else.
//
// Authorization is backed by the `platform_admins` table (authoritative
// identity: user_id) plus the `is_jobu_admin()` SQL function, not by
// comparing email strings client-side. See migrations applied to project
// jqycdruhcaqdumuhirsw (admin_platform_admins, admin_audit_log, etc).

const crypto = require('crypto');
const { adminClient } = require('./supabase');

const SUPPORT_SESSION_READ_ONLY_MINUTES = 30;

// ── Authorization ────────────────────────────────────────────────────────────

// Returns { isAdmin, role } for a Supabase auth user (req.user). Never throws —
// on any lookup error this fails closed (isAdmin: false), per the requirement
// that admin access must fail closed when identity can't be verified.
async function isJobuAdmin(user) {
  if (!user?.id) return { isAdmin: false, role: null };
  try {
    const { data, error } = await adminClient
      .from('platform_admins')
      .select('role, is_active')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .maybeSingle();
    if (error || !data) return { isAdmin: false, role: null };
    return { isAdmin: true, role: data.role };
  } catch {
    return { isAdmin: false, role: null };
  }
}

// Express middleware. Must run after requireAuth (needs req.user). Denies are
// best-effort audit-logged so repeated probing of admin routes is visible.
function requireJobuAdmin(req, res, next) {
  isJobuAdmin(req.user).then(({ isAdmin, role }) => {
    if (!isAdmin) {
      logAdminAction({
        req,
        adminUser: req.user,
        adminRole: null,
        action: 'admin_access_denied',
        resourceType: 'route',
        resourceId: req.originalUrl,
      }).catch(() => {});
      return res.status(403).json({ error: 'Forbidden' });
    }
    req.adminRole = role;
    next();
  }).catch(() => res.status(403).json({ error: 'Forbidden' }));
}

// ── Audit log ────────────────────────────────────────────────────────────────

// Fire-and-forget-safe: callers should still `await` it where they want to
// guarantee ordering, but a logging failure must never break the underlying
// admin action. Only ever written by this service-role client — the table
// has no client-writable RLS policy.
async function logAdminAction({
  req, adminUser, adminRole, orgId = null, supportSessionId = null,
  action, resourceType = null, resourceId = null,
  oldValues = null, newValues = null, reason = null,
}) {
  try {
    await adminClient.from('admin_audit_log').insert({
      admin_user_id: adminUser?.id || null,
      admin_email: adminUser?.email || null,
      admin_role: adminRole || null,
      org_id: orgId,
      support_session_id: supportSessionId,
      action,
      resource_type: resourceType,
      resource_id: resourceId != null ? String(resourceId) : null,
      old_values: oldValues,
      new_values: newValues,
      reason,
      ip_address: req?.ip || req?.headers?.['x-forwarded-for'] || null,
      user_agent: req?.headers?.['user-agent'] || null,
    });
  } catch (err) {
    console.error('[admin-lib] failed to write audit log entry:', action, err.message);
  }
}

// ── Support-view sessions ───────────────────────────────────────────────────

function generateSupportToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Creates a read-only support session (interactive mode is schema-ready but
// intentionally not exposed here yet). Returns the full session row.
async function startSupportSession({ adminUser, orgId, reason }) {
  const token = generateSupportToken();
  const expiresAt = new Date(Date.now() + SUPPORT_SESSION_READ_ONLY_MINUTES * 60 * 1000).toISOString();
  const { data, error } = await adminClient
    .from('admin_support_sessions')
    .insert({
      admin_user_id: adminUser.id,
      org_id: orgId,
      reason,
      mode: 'read_only',
      token,
      expires_at: expiresAt,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function endSupportSession({ sessionId, adminUser, reason = null }) {
  const { data, error } = await adminClient
    .from('admin_support_sessions')
    .update({ ended_at: new Date().toISOString(), ended_reason: reason })
    .eq('id', sessionId)
    .eq('admin_user_id', adminUser.id)
    .is('ended_at', null)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Express middleware. Runs after requireAuth. If a valid, unexpired,
// not-yet-ended X-Support-Session token belonging to the requesting admin is
// present, scopes the request to the target org (req._orgId) — the same field
// getRequestOrgId() in server.js memoizes into, so every existing read
// handler transparently serves the support-view tenant with no changes.
// Silently no-ops (does not scope, does not error) when the header is absent,
// so normal customer requests are unaffected.
async function resolveSupportSession(req, res, next) {
  const token = req.headers['x-support-session'];
  if (!token) return next();

  try {
    const { data: session, error } = await adminClient
      .from('admin_support_sessions')
      .select('*')
      .eq('token', token)
      .maybeSingle();

    if (error || !session) {
      return res.status(401).json({ error: 'Invalid support session.' });
    }
    if (session.admin_user_id !== req.user?.id) {
      return res.status(403).json({ error: 'Support session does not belong to this account.' });
    }
    if (session.ended_at) {
      return res.status(401).json({ error: 'Support session has ended.' });
    }
    if (new Date(session.expires_at).getTime() < Date.now()) {
      return res.status(401).json({ error: 'Support session has expired.' });
    }
    const { isAdmin } = await isJobuAdmin(req.user);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    req._orgId = session.org_id;
    req._supportSession = session;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Express middleware. Place after resolveSupportSession on mutating routes.
// Blocks writes while a read-only support session is active; has no effect
// otherwise (normal customer requests, or a future interactive session).
function blockWriteDuringReadOnlySupport(req, res, next) {
  if (req._supportSession && req._supportSession.mode === 'read_only') {
    return res.status(403).json({
      error: 'This is a read-only support session — write actions are disabled.',
    });
  }
  next();
}

module.exports = {
  isJobuAdmin,
  requireJobuAdmin,
  logAdminAction,
  startSupportSession,
  endSupportSession,
  resolveSupportSession,
  blockWriteDuringReadOnlySupport,
  SUPPORT_SESSION_READ_ONLY_MINUTES,
};
