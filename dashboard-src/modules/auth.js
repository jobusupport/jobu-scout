// ── Auth ──────────────────────────────────────────────────────────────────────
const AUTH_KEY = 'vs_auth';  // localStorage key
const DESIGN_MODE = false; // Production: login/auth enabled. Set true only in Claude Design preview.

// ── Mock data (used only when DESIGN_MODE is true) ───────────────────────
const MOCK_TEAMS = [
  {
    id: 1,
    team_name: 'VBA National 14U',
    gc_team_url: 'https://gc.com/mock-team',
    pg_team_url: 'https://perfectgame.org/mock-team',
    game_count: 12,
    last_game: '2026-06-21',
    hasGC: true,
    hasPG: true,
    hasGameUrls: true,
    stats: { wins: 8, losses: 4, plays: 842, batters: 14 }
  },
  {
    id: 2,
    team_name: 'Birmingham Stars 14U',
    gc_team_url: 'https://gc.com/mock-team-2',
    pg_team_url: null,
    game_count: 9,
    last_game: '2026-06-18',
    hasGC: true,
    hasPG: false,
    hasGameUrls: false,
    stats: { wins: 6, losses: 3, plays: 611, batters: 13 }
  }
];

const MOCK_GAMES = [
  {
    id: 101,
    gc_game_id: 'mock-game-101',
    gc_game_url: 'https://gc.com/mock-game',
    game_date: '2026-06-21',
    game_time: '4:00 PM',
    result: 'W',
    score_us: 7,
    score_them: 3,
    opponent_name: 'Excel Blue Wave National',
    location: 'River Run Park',
    season_type: 'Summer 2026'
  },
  {
    id: 102,
    gc_game_id: 'mock-game-102',
    gc_game_url: 'https://gc.com/mock-game-2',
    game_date: '2026-06-18',
    game_time: '6:30 PM',
    result: 'L',
    score_us: 4,
    score_them: 5,
    opponent_name: 'USA Prime',
    location: 'Hoover, AL',
    season_type: 'Summer 2026'
  }
];

const MOCK_REPORTS = [
  {
    name: 'VBA_National_14U_Scouting_Report.docx',
    size: 245760,
    mtime: Date.now()
  },
  {
    name: 'Birmingham_Stars_14U_Scouting_Report.pdf',
    size: 389120,
    mtime: Date.now() - 86400000
  }
];

function mockApiResponse(url, options = {}) {
  const path = typeof url === 'string' ? url : String(url);

  if (path === '/api/teams') {
    return Promise.resolve(new Response(JSON.stringify(MOCK_TEAMS), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
  }

  if (/^\/api\/teams\/\d+\/games/.test(path)) {
    return Promise.resolve(new Response(JSON.stringify(MOCK_GAMES), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
  }

  if (/^\/api\/teams\/\d+\/game-urls/.test(path)) {
    return Promise.resolve(new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
  }

  if (path === '/api/reports') {
    return Promise.resolve(new Response(JSON.stringify(MOCK_REPORTS), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
  }

  if (path.includes('/api/run/') || path.includes('/api/jobs/')) {
    return Promise.resolve(new Response(JSON.stringify({
      ok: true,
      jobId: 'design-preview-job',
      status: 'done',
      logs: [
        { t: Date.now(), line: 'Design preview mode: mock job started.' },
        { t: Date.now(), line: 'Design preview mode: mock job completed.' }
      ]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
  }

  return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  }));
}

function getSession() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY)); } catch { return null; }
}
function saveSession(data) {
  localStorage.setItem(AUTH_KEY, JSON.stringify(data));
}
function clearSession() {
  localStorage.removeItem(AUTH_KEY);
}

// Wraps fetch() to automatically attach Authorization header.
// If the server returns 401, clears session and shows login.
async function apiFetch(url, options = {}) {
  if (DESIGN_MODE) return mockApiResponse(url, options);
  const session = getSession();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (session?.accessToken) {
    headers['Authorization'] = `Bearer ${session.accessToken}`;
  }
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    clearSession();
    showLogin();
    throw new Error('Session expired — please sign in again.');
  }
  return res;
}

async function submitLogin() {
  const email    = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl    = document.getElementById('loginError');
  const btn      = document.getElementById('loginBtn');

  errEl.style.display = 'none';
  errEl.style.color = '';
  if (!email || !password) {
    errEl.textContent = 'Email and password are required.';
    errEl.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Signing in...';

  try {
    const res  = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || 'Sign in failed.';
      errEl.style.display = 'block';
      return;
    }
    saveSession(data);
    showDashboard(data.user);
    loadTeams();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
}

async function logout() {
  if (DESIGN_MODE) {
    showDashboard({ id: 'design-preview', email: 'design-preview@jobuscout.local' });
    loadTeams();
    return;
  }
  const session = getSession();
  if (session?.accessToken) {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${session.accessToken}` },
      });
    } catch {}
  }
  clearSession();
  showLogin();
}

function showLogin() {
  // TEMP CLAUDE DESIGN BYPASS: never show login while DESIGN_MODE is on.
  if (DESIGN_MODE) {
    const loginScreen = document.getElementById('loginScreen');
    if (loginScreen) loginScreen.classList.add('hidden');
    showDashboard({ id: 'design-preview', email: 'design-preview@jobuscout.local' });
    if (!window.__designModeLoadedTeams) {
      window.__designModeLoadedTeams = true;
      setTimeout(() => { if (typeof loadTeams === 'function') loadTeams(); }, 0);
    }
    return;
  }
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('forgotScreen').style.display = 'none';
  document.getElementById('resetPasswordScreen').style.display = 'none';
  document.getElementById('signupScreen').style.display = 'none';
  document.getElementById('userBadge').style.display = 'none';
  // Reset login form
  const errEl = document.getElementById('loginError');
  if (errEl) { errEl.style.display = 'none'; }
  const btn = document.getElementById('loginBtn');
  if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
}

// ── Forgot / Reset Password ─────────────────────────────────────────────────
function showForgotPassword() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('resetPasswordScreen').style.display = 'none';
  document.getElementById('signupScreen').style.display = 'none';
  document.getElementById('forgotScreen').style.display = 'flex';
  const errEl = document.getElementById('forgotError');
  const okEl  = document.getElementById('forgotSuccess');
  if (errEl) errEl.style.display = 'none';
  if (okEl)  okEl.style.display = 'none';
}

async function submitForgotPassword() {
  const email = document.getElementById('forgotEmail').value.trim();
  const errEl = document.getElementById('forgotError');
  const okEl  = document.getElementById('forgotSuccess');
  const btn   = document.getElementById('forgotBtn');
  errEl.style.display = 'none';
  okEl.style.display  = 'none';
  if (!email) { errEl.textContent = 'Email is required.'; errEl.style.display = 'block'; return; }

  btn.disabled = true;
  btn.textContent = 'Sending...';
  try {
    const res  = await fetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to send reset link.');
    okEl.textContent = data.message || 'If an account exists for that email, a reset link has been sent.';
    okEl.style.display = 'block';
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Reset Link';
  }
}

let __resetAccessToken = null;
function showResetPassword(accessToken) {
  __resetAccessToken = accessToken;
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('forgotScreen').style.display = 'none';
  document.getElementById('signupScreen').style.display = 'none';
  document.getElementById('resetPasswordScreen').style.display = 'flex';
}

// ── Sign Up ──────────────────────────────────────────────────────────────────
function showSignup(prefill = {}) {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('forgotScreen').style.display = 'none';
  document.getElementById('resetPasswordScreen').style.display = 'none';
  document.getElementById('signupScreen').style.display = 'flex';
  if (prefill.tier) document.getElementById('signupTier').value = prefill.tier;
  if (prefill.interval) document.getElementById('signupInterval').value = prefill.interval;
  updateSignupIntervalVisibility();
  const errEl = document.getElementById('signupError');
  if (errEl) errEl.style.display = 'none';
}

function updateSignupIntervalVisibility() {
  const tier = document.getElementById('signupTier').value;
  document.getElementById('signupIntervalField').style.display = tier === 'free' ? 'none' : 'block';
}

async function submitSignup() {
  const orgName  = document.getElementById('signupOrgName').value.trim();
  const email    = document.getElementById('signupEmail').value.trim();
  const password = document.getElementById('signupPassword').value;
  const tier     = document.getElementById('signupTier').value;
  const interval = document.getElementById('signupInterval').value;
  const errEl    = document.getElementById('signupError');
  const btn      = document.getElementById('signupBtn');

  errEl.style.display = 'none';
  if (!orgName || !email || !password) {
    errEl.textContent = 'Organization name, email, and password are required.';
    errEl.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Creating account...';
  try {
    const res  = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgName, email, password, tier, interval }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create account.');

    if (data.checkoutUrl) {
      saveSession(data);
      window.location.href = data.checkoutUrl;
    } else {
      // Don't auto-sign the new account in — land back on the sign-in screen
      // with a clear confirmation so it's obvious the account was created
      // (previously this jumped straight to the dashboard with no visible
      // change, which read as "nothing happened" and led to duplicate signups).
      showLogin();
      document.getElementById('loginEmail').value = email;
      const loginErr = document.getElementById('loginError');
      if (loginErr) {
        loginErr.style.color = '#2ecc71';
        loginErr.textContent = 'Account created! Sign in with your new password.';
        loginErr.style.display = 'block';
      }
    }
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Account';
  }
}

async function submitResetPassword() {
  const newPassword     = document.getElementById('resetNewPassword').value;
  const confirmPassword = document.getElementById('resetConfirmPassword').value;
  const errEl = document.getElementById('resetError');
  const btn   = document.getElementById('resetBtn');
  errEl.style.display = 'none';

  if (!newPassword || newPassword.length < 8) {
    errEl.textContent = 'Password must be at least 8 characters.'; errEl.style.display = 'block'; return;
  }
  if (newPassword !== confirmPassword) {
    errEl.textContent = 'Passwords do not match.'; errEl.style.display = 'block'; return;
  }

  btn.disabled = true;
  btn.textContent = 'Saving...';
  try {
    const res  = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: __resetAccessToken, newPassword }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to reset password.');
    __resetAccessToken = null;
    clearSession();
    showLogin();
    const loginErr = document.getElementById('loginError');
    if (loginErr) {
      loginErr.style.color = '#2ecc71';
      loginErr.textContent = 'Password updated. Sign in with your new password.';
      loginErr.style.display = 'block';
    }
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Set New Password';
  }
}

function showDashboard(user) {
  document.getElementById('loginScreen').classList.add('hidden');
  const badge = document.getElementById('userBadge');
  const emailEl = document.getElementById('userEmail');
  if (badge) badge.style.display = 'flex';
  if (emailEl) emailEl.textContent = user?.email || '';
  refreshAdminButton();
  renderSupportSessionBanner();
}
