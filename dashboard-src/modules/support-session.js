// ── Admin panel access ───────────────────────────────────────────────────────
// Never decided by comparing user.email client-side — the button's visibility
// only reflects what the server (GET /api/admin/status, backed by the
// platform_admins table) actually confirmed for this authenticated user.
// /admin and every /api/admin/* route independently re-verify this too.
async function refreshAdminButton() {
  const btn = document.getElementById('adminPanelBtn');
  if (!btn) return;
  try {
    const session = getSession();
    if (!session?.accessToken) { btn.style.display = 'none'; return; }
    const res = await fetch('/api/admin/status', {
      headers: { Authorization: 'Bearer ' + session.accessToken },
    });
    if (!res.ok) { btn.style.display = 'none'; return; }
    const data = await res.json();
    btn.style.display = data?.isAdmin ? '' : 'none';
  } catch (e) {
    btn.style.display = 'none';
  }
}

// ── Support-view session (admin browsing this dashboard scoped to a customer org) ──
const SUPPORT_SESSION_KEY = 'jobuSupportSession';

function getSupportSession() {
  try {
    const raw = sessionStorage.getItem(SUPPORT_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function renderSupportSessionBanner() {
  const banner = document.getElementById('supportSessionBanner');
  const text = document.getElementById('supportSessionText');
  const support = getSupportSession();
  if (!banner || !text) return;
  if (!support) { banner.style.display = 'none'; return; }
  const expires = support.expiresAt ? new Date(support.expiresAt) : null;
  if (expires && expires.getTime() < Date.now()) {
    sessionStorage.removeItem(SUPPORT_SESSION_KEY);
    banner.style.display = 'none';
    return;
  }
  text.textContent = 'Viewing Jobu Scout as ' + (support.orgName || 'customer') +
    ' — Read Only' + (expires ? (' (expires ' + expires.toLocaleTimeString() + ')') : '');
  banner.style.display = 'flex';
}

async function endSupportSessionView() {
  const support = getSupportSession();
  if (!support) return;
  try {
    const session = getSession();
    await fetch('/api/admin/support-sessions/' + support.sessionId + '/end', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (session?.accessToken || ''),
      },
    });
  } catch (e) {}
  sessionStorage.removeItem(SUPPORT_SESSION_KEY);
  window.location.href = '/admin';
}

// Auto-attach the active support session's token to same-origin API calls so
// every existing fetch() call site in this file transparently browses the
// support-view tenant's data without being individually rewritten. The
// server independently re-validates the token (expiry, ownership, admin
// status) on every request — this header is a transport convenience only.
(function installSupportSessionFetchWrapper() {
  const originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const support = getSupportSession();
    if (!support) return originalFetch(input, init);
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!url.startsWith('/api/')) return originalFetch(input, init);
    const opts = Object.assign({}, init);
    opts.headers = Object.assign({}, (init && init.headers) || {}, {
      'X-Support-Session': support.token,
    });
    return originalFetch(input, opts);
  };
})();
