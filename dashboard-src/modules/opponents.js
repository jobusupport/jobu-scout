// ── Utility ───────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Add Team Modal ────────────────────────────────────────────────────────────
function showAddTeam() {
  document.getElementById('addTeamModal').style.display = 'flex';
  document.getElementById('addName').focus();
  document.getElementById('addTeamError').style.display = 'none';
}
function hideAddTeam() {
  document.getElementById('addTeamModal').style.display    = 'none';
  document.getElementById('addName').value                 = '';
  document.getElementById('addGcUrl').value                = '';
  document.getElementById('addPgUrl').value                = '';
  document.getElementById('addSheetUrl').value             = '';
  document.getElementById('replaceAllTeams').checked       = false;
  document.getElementById('addTeamError').style.display    = 'none';
  document.getElementById('sheetSyncResult').style.display = 'none';
  switchAddTab('manual');
}
function switchAddTab(tab) {
  document.getElementById('paneManual').style.display = tab === 'manual' ? 'block' : 'none';
  document.getElementById('paneSheet').style.display  = tab === 'sheet'  ? 'block' : 'none';
  const m = document.getElementById('tabManual'), s = document.getElementById('tabSheet');
  m.style.borderBottomColor = tab === 'manual' ? 'var(--accent)' : 'transparent';
  m.style.color             = tab === 'manual' ? 'var(--accent)' : 'var(--muted)';
  s.style.borderBottomColor = tab === 'sheet'  ? 'var(--accent)' : 'transparent';
  s.style.color             = tab === 'sheet'  ? 'var(--accent)' : 'var(--muted)';
  document.getElementById('addTeamError').style.display = 'none';
}
async function submitAddTeam() {
  const teamName = document.getElementById('addName').value.trim();
  const errEl    = document.getElementById('addTeamError');
  if (!teamName) { errEl.textContent = 'Team name is required.'; errEl.style.display = 'block'; return; }
  const res  = await apiFetch('/api/teams/add', {
    method: 'POST',
    body: JSON.stringify({ teamName, gcTeamUrl: document.getElementById('addGcUrl').value.trim(), pgTeamUrl: document.getElementById('addPgUrl').value.trim() }),
  });
  const data = await res.json();
  if (!res.ok) { errEl.textContent = data.error || 'Failed.'; errEl.style.display = 'block'; return; }
  hideAddTeam();
  await loadTeams();
}
async function submitSyncSheet() {
  const csvUrl   = document.getElementById('addSheetUrl').value.trim();
  const replace  = document.getElementById('replaceAllTeams').checked;
  const resultEl = document.getElementById('sheetSyncResult');
  const btn      = document.getElementById('syncSheetBtn');
  const errEl    = document.getElementById('addTeamError');
  errEl.style.display = resultEl.style.display = 'none';
  if (!csvUrl) { errEl.textContent = 'Please paste a published CSV URL.'; errEl.style.display = 'block'; return; }
  btn.disabled = true; btn.textContent = 'Syncing...';
  try {
    const res  = await apiFetch('/api/settings/sheet', {
      method: 'POST',
      body: JSON.stringify({ csvUrl, replace }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Sync failed.'; errEl.style.display = 'block'; return; }
    resultEl.style.color      = '#2ecc71';
    resultEl.textContent      = `✓ ${data.message}`;
    resultEl.style.display    = 'block';
    setTimeout(async () => { hideAddTeam(); await loadTeams(); }, 1500);
  } catch (err) {
    errEl.textContent = err.message; errEl.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Sync Sheet';
  }
}

// ── Edit / Remove Opponent ───────────────────────────────────────────────────
function showEditTeam(teamId) {
  const team = allTeams.find(t => String(t.id) === String(teamId));
  if (!team) { alert('Opponent not found. Refresh the list and try again.'); return; }
  document.getElementById('editTeamId').value = team.id;
  document.getElementById('editName').value   = team.team_name || '';
  document.getElementById('editGcUrl').value  = team.gc_team_url || '';
  document.getElementById('editPgUrl').value  = team.pg_team_url || '';
  document.getElementById('editTeamError').style.display = 'none';
  document.getElementById('editTeamModal').style.display = 'flex';
  document.getElementById('editName').focus();
}

function hideEditTeam() {
  document.getElementById('editTeamModal').style.display = 'none';
  document.getElementById('editTeamError').style.display = 'none';
}

async function submitEditTeam() {
  const teamId = document.getElementById('editTeamId').value;
  const teamName = document.getElementById('editName').value.trim();
  const gcTeamUrl = document.getElementById('editGcUrl').value.trim();
  const pgTeamUrl = document.getElementById('editPgUrl').value.trim();
  const errEl = document.getElementById('editTeamError');

  if (!teamName) { errEl.textContent = 'Team name is required.'; errEl.style.display = 'block'; return; }

  const res = await apiFetch(`/api/teams/${teamId}`, {
    method: 'PUT',
    body: JSON.stringify({ teamName, gcTeamUrl, pgTeamUrl }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { errEl.textContent = data.error || 'Failed to update opponent.'; errEl.style.display = 'block'; return; }

  hideEditTeam();
  await loadTeams();
  selectTeamById(teamId);
}

async function removeOpponent(teamId) {
  const team = allTeams.find(t => String(t.id) === String(teamId));
  if (!team) { alert('Opponent not found. Refresh the list and try again.'); return; }

  const ok = confirm(`Remove "${team.team_name}" from your opponent list?

This just hides them from the list — all games and stats stay in the database, and you can bring them back later.`);
  if (!ok) return;

  const res = await apiFetch(`/api/teams/${teamId}/archive`, {
    method: 'PATCH',
    body: JSON.stringify({ archived: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { alert(data.error || 'Failed to remove opponent.'); return; }

  if (selectedTeam && String(selectedTeam.id) === String(teamId)) {
    selectedTeam = null;
    document.getElementById('mainPanel').innerHTML = `<div class="empty empty-hero"><div class="empty-icon"><svg viewBox="0 0 24 24" width="34" height="34" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="0.9" fill="currentColor"/></svg></div><h3>Select a team to get started</h3><p>Choose a team from the list on the left</p></div>`;
  }

  await loadTeams();
}
