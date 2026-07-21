// ── Init ──────────────────────────────────────────────────────────────────────
(function init() {
  // Supabase password-recovery links land here with tokens in the URL hash
  // (e.g. #access_token=...&type=recovery). Intercept before anything else.
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  if (hashParams.get('type') === 'recovery' && hashParams.get('access_token')) {
    const token = hashParams.get('access_token');
    history.replaceState({}, '', window.location.pathname + window.location.search);
    showResetPassword(token);
    return;
  }

  if (DESIGN_MODE) {
    const designUser = {
      id: 'design-preview',
      email: 'design-preview@jobuscout.local'
    };
    showDashboard(designUser);
    loadTeams();
    return;
  }

  const session = getSession();
  if (session?.accessToken) {
    // Already logged in — go straight to dashboard
    showDashboard(session.user);
    loadTeams();

    const billingParam = new URLSearchParams(window.location.search).get('billing');
    if (billingParam) {
      history.replaceState({}, '', window.location.pathname);
      const notice = billingParam === 'success'
        ? '<div style="background:rgba(46,204,113,0.12);border:1px solid #2ecc71;color:#2ecc71;padding:8px 10px;border-radius:4px;font-size:12px;margin-bottom:12px">Subscription updated successfully.</div>'
        : '<div style="background:rgba(231,76,60,0.12);border:1px solid #e74c3c;color:#e74c3c;padding:8px 10px;border-radius:4px;font-size:12px;margin-bottom:12px">Checkout was canceled.</div>';
      openBilling(notice);
    }
  } else {
    // Deep link from the marketing site, e.g. /?signup=1&tier=coach&interval=year
    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.get('signup')) {
      const tier = searchParams.get('tier');
      const interval = searchParams.get('interval');
      history.replaceState({}, '', window.location.pathname);
      showSignup({ tier, interval });
      setTimeout(() => document.getElementById('signupOrgName')?.focus(), 100);
      return;
    }

    // Show login screen, focus email field
    showLogin();
    setTimeout(() => document.getElementById('loginEmail')?.focus(), 100);
  }
})();