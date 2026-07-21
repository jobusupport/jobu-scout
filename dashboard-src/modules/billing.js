// ── Billing ──────────────────────────────────────────────────────────────────
const PLAN_LABELS = { free: 'Free', coach: 'Coach', organization: 'Organization' };

function openBilling(noticeHtml = '') {
  document.getElementById('billingModal').style.display = 'flex';
  loadBillingStatus(noticeHtml);
}
function closeBilling() {
  document.getElementById('billingModal').style.display = 'none';
}

async function loadBillingStatus(noticeHtml = '') {
  const el = document.getElementById('billingContent');
  el.innerHTML = 'Loading…';
  try {
    const res  = await apiFetch('/api/billing/status');
    const data = await res.json();
    if (!res.ok) { el.innerHTML = `<div style="color:#e74c3c">${escHtml(data.error || 'Failed to load billing status.')}</div>`; return; }

    const expires = data.planExpiresAt ? new Date(data.planExpiresAt).toLocaleDateString() : null;
    const statusLine = data.subscriptionStatus
      ? `<div style="color:var(--muted);font-size:12px;margin-top:2px">Status: ${escHtml(data.subscriptionStatus)}${expires ? ` · renews ${expires}` : ''}</div>`
      : '';

    let actionsHtml;
    if (data.canManageBilling) {
      actionsHtml = `
        <div style="margin-top:18px;display:flex;flex-direction:column;gap:8px">
          <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">Upgrade</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <button class="btn btn-outline" onclick="startCheckout('coach','month')">Coach — $49/mo</button>
            <button class="btn btn-outline" onclick="startCheckout('coach','year')">Coach — $490/yr</button>
            <button class="btn btn-outline" onclick="startCheckout('organization','month')">Organization — $199/mo</button>
            <button class="btn btn-outline" onclick="startCheckout('organization','year')">Organization — $1990/yr</button>
          </div>
          ${data.hasBillingAccount ? `<button class="btn btn-primary" style="margin-top:8px" onclick="openBillingPortal()">Manage Billing / Cancel</button>` : ''}
        </div>`;
    } else {
      actionsHtml = `<div style="color:var(--muted);font-size:12px;margin-top:14px">Only an organization admin can change plans or manage billing.</div>`;
    }

    const fmtLimit = (max) => (max >= 999999 ? 'Unlimited' : String(max));
    const fmtUsage = (used, max) => (max >= 999999 ? 'Unlimited' : `${used} / ${max}`);
    const usageRow = (label, used, max) => `
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text);padding:4px 0">
        <span style="color:var(--muted)">${label}</span>
        <span>${fmtUsage(used, max)}</span>
      </div>`;

    const reportPeriodLabel = data.reportLimitsAreLifetime ? 'lifetime' : 'this month';

    el.innerHTML = `
      ${noticeHtml}
      <div style="font-size:18px;font-weight:700">${escHtml(PLAN_LABELS[data.plan] || data.plan)} plan</div>
      ${statusLine}
      <div style="margin-top:12px;border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:2px 0">
        ${usageRow('Opponent teams', data.usage.opponentTeams, data.limits.maxOpponentTeams)}
        ${usageRow(`Scouting reports (${reportPeriodLabel})`, data.usage.scoutingReportsThisMonth, data.limits.maxReportsPerMonth)}
        ${usageRow(`Self-scout reports (${reportPeriodLabel})`, data.usage.selfScoutReportsThisMonth, data.limits.maxSelfScoutReportsPerMonth)}
        ${usageRow(`Matchup reports (${reportPeriodLabel})`, data.usage.matchupReportsThisMonth, data.limits.maxMatchupReportsPerMonth)}
        ${usageRow('Users', data.usage.userCount, data.limits.maxUsers)}
      </div>
      ${actionsHtml}
      <div id="billingError" style="color:#e74c3c;font-size:11px;margin-top:10px;display:none"></div>
    `;
  } catch (err) {
    el.innerHTML = `<div style="color:#e74c3c">${escHtml(err.message)}</div>`;
  }
}

async function startCheckout(tier, interval) {
  const errEl = document.getElementById('billingError');
  try {
    const res  = await apiFetch('/api/billing/create-checkout-session', {
      method: 'POST',
      body: JSON.stringify({ tier, interval }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start checkout.');
    window.location.href = data.url;
  } catch (err) {
    if (errEl) { errEl.textContent = err.message; errEl.style.display = 'block'; }
  }
}

async function openBillingPortal() {
  const errEl = document.getElementById('billingError');
  try {
    const res  = await apiFetch('/api/billing/create-portal-session', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to open billing portal.');
    window.location.href = data.url;
  } catch (err) {
    if (errEl) { errEl.textContent = err.message; errEl.style.display = 'block'; }
  }
}

