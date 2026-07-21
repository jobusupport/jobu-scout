// ── State ────────────────────────────────────────────────────────────────────
let selectedTeam = null;
let allTeams     = [];
let currentJobId   = null;
let currentJobType = null;
let jobStream      = null;
let liveTeamSummaryTimer = null;
let activeTab      = 'run';

// Persisted options across team switches
const opts = {
  gameLocation:     '',
  gameDate:         new Date().toISOString().slice(0, 10), // defaults to today
  gameTime:         '',
  humanObs:         '',
  gameScope:        'all',
  customPrompt:     '',
  matchupOurTeamId: null,
  matchupOppTeamId: null,
  matchupProbable:  '',
};

// ── Load teams ───────────────────────────────────────────────────────────────
async function loadTeams() {
  const res   = await apiFetch('/api/teams');
  allTeams    = await res.json();
  const list  = document.getElementById('teamList');
  const opponentTeams = allTeams.filter(t => !t.is_our_team);

  if (!opponentTeams.length) {
    list.innerHTML = `<div class="empty"><div class="empty-icon"><svg viewBox="0 0 24 24" width="34" height="34" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"><circle cx="12" cy="12" r="9"/><path d="M6.5 4.8c2.4 3.4 2.4 11 0 14.4M17.5 4.8c-2.4 3.4-2.4 11 0 14.4"/></svg></div><p>No teams yet.<br>Run PSG analysis first.</p></div>`;
    renderMyTeams();
    return;
  }

  list.innerHTML = opponentTeams.map(t => `
    <div class="team-item ${String(selectedTeam?.id) === String(t.id) ? 'active' : ''}"
         data-team-id="${escHtml(t.id)}"
         onclick="selectTeamById(this.dataset.teamId)">
      <div class="team-row-main">
        <div class="team-name">${escHtml(t.team_name)}</div>
        <div class="team-actions">
          <button class="team-kebab-btn" title="More actions" onclick="event.stopPropagation(); toggleTeamMenu(event, '${escHtml(t.id)}')">⋯</button>
          <div class="dropdown-menu" id="teamMenu-${escHtml(t.id)}">
            <button class="dropdown-item" onclick="event.stopPropagation(); closeAllMenus(); showEditTeam('${escHtml(t.id)}')">Edit</button>
            <button class="dropdown-item danger" onclick="event.stopPropagation(); closeAllMenus(); removeOpponent('${escHtml(t.id)}')">Remove</button>
          </div>
        </div>
      </div>
      <div class="team-meta">
        <span class="badge badge-games">${escHtml(t.game_count)} games</span>
        ${t.hasGC ? `<span class="badge badge-gc">PSG ✓</span>` : ''}
        ${t.hasPG ? `<span class="badge badge-pg">PSP ✓</span>` : ''}
        ${t.stats?.wins != null ? `<span class="badge badge-wins">${escHtml(t.stats.wins)}W-${escHtml(t.stats.losses)}L</span>` : ''}
      </div>
    </div>
  `).join('');
  renderMyTeams();
  if (selectedTeam) {
    const refreshed = allTeams.find(t => String(t.id) === String(selectedTeam.id));
    if (refreshed) selectedTeam = refreshed;
  }
}

function selectTeamById(teamId) {
  selectTeam(teamId);
}

function selectTeam(teamId) {
  selectedTeam = allTeams.find(t => String(t.id) === String(teamId));
  if (!selectedTeam) {
    console.error('Team not found for id:', teamId);
    return;
  }
  // 'run' (Single Opponent Scout) only exists for opponents; 'self'/'matchup'
  // only exist for My Team. Switch to a tab that actually exists for the
  // newly selected team's type, defaulting to Games/Reports otherwise.
  const ourTeamTabs = ['self', 'matchup', 'games', 'reports'];
  const opponentTabs = ['run', 'games', 'reports'];
  const validTabs = selectedTeam.is_our_team ? ourTeamTabs : opponentTabs;
  if (!validTabs.includes(activeTab)) {
    activeTab = selectedTeam.is_our_team ? 'self' : 'run';
  }
  renderMain();
  document.querySelectorAll('.team-item').forEach(el => {
    el.classList.toggle('active', String(el.dataset.teamId) === String(selectedTeam.id));
  });
}

// ── My Team ───────────────────────────────────────────────────────────────────
// Backed by the real `teams` table now (teams.is_our_team = true), not
// localStorage. allTeams is populated by loadTeams() from GET /api/teams.
function getMyTeams() {
  return (allTeams || []).filter(t => t.is_our_team);
}

function showMyTeam() {
  document.getElementById('myName').value  = '';
  document.getElementById('myGcUrl').value = '';
  document.getElementById('myPgUrl').value = '';
  document.getElementById('myYear').value  = '';
  document.querySelectorAll('.mySeason').forEach(c => c.checked = false);
  const err = document.getElementById('myTeamError');
  if (err) err.style.display = 'none';
  document.getElementById('myTeamModal').style.display = 'flex';
}
function hideMyTeam() {
  document.getElementById('myTeamModal').style.display = 'none';
}
async function submitMyTeam() {
  const name    = document.getElementById('myName').value.trim();
  const gcUrl   = document.getElementById('myGcUrl').value.trim();
  const pgUrl   = document.getElementById('myPgUrl').value.trim();
  const year    = document.getElementById('myYear').value.trim();
  const seasons = [...document.querySelectorAll('.mySeason:checked')].map(c => c.value);
  const err     = document.getElementById('myTeamError');
  if (!name) { err.textContent = 'Team name is required.'; err.style.display = 'block'; return; }
  if (!year) { err.textContent = 'Team year is required.'; err.style.display = 'block'; return; }
  if (!seasons.length) { err.textContent = 'Choose at least one season.'; err.style.display = 'block'; return; }

  const res = await apiFetch('/api/teams/add', {
    method: 'POST',
    body: JSON.stringify({
      teamName: name, gcTeamUrl: gcUrl, pgTeamUrl: pgUrl,
      isOurTeam: true, seasonYear: year, seasonType: seasons.join(','),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { err.textContent = data.error || 'Failed to save team.'; err.style.display = 'block'; return; }

  hideMyTeam();
  await loadTeams();
}
async function removeMyTeam(teamId) {
  const team = (allTeams || []).find(t => String(t.id) === String(teamId));
  if (!team) { alert('Team not found. Refresh and try again.'); return; }

  const ok = confirm(`Remove "${team.team_name}" from My Team?

This just hides it from the list — all games and stats stay in the database, and you can bring it back later.`);
  if (!ok) return;

  const res = await apiFetch(`/api/teams/${teamId}/archive`, {
    method: 'PATCH',
    body: JSON.stringify({ archived: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { alert(data.error || 'Failed to remove team.'); return; }
  await loadTeams();
}
function showEditMyTeam(teamId) {
  const t = (allTeams || []).find(x => String(x.id) === String(teamId));
  if (!t) { alert('Team not found. Refresh and try again.'); return; }
  document.getElementById('editMyTeamIdx').value = t.id;
  document.getElementById('editMyName').value  = t.team_name    || '';
  document.getElementById('editMyGcUrl').value = t.gc_team_url  || '';
  document.getElementById('editMyPgUrl').value = t.pg_team_url  || '';
  document.getElementById('editMyYear').value  = t.season_year  || '';
  const seasons = (t.season_type || '').split(',').map(s => s.trim()).filter(Boolean);
  document.querySelectorAll('.editMySeason').forEach(c => { c.checked = seasons.includes(c.value); });
  document.getElementById('editMyTeamError').style.display = 'none';
  document.getElementById('editMyTeamModal').style.display = 'flex';
  document.getElementById('editMyName').focus();
}
function hideEditMyTeam() {
  document.getElementById('editMyTeamModal').style.display = 'none';
  document.getElementById('editMyTeamError').style.display = 'none';
}
async function submitEditMyTeam() {
  const teamId  = document.getElementById('editMyTeamIdx').value;
  const name    = document.getElementById('editMyName').value.trim();
  const gcUrl   = document.getElementById('editMyGcUrl').value.trim();
  const pgUrl   = document.getElementById('editMyPgUrl').value.trim();
  const year    = document.getElementById('editMyYear').value.trim();
  const seasons = [...document.querySelectorAll('.editMySeason:checked')].map(c => c.value);
  const err     = document.getElementById('editMyTeamError');
  if (!name) { err.textContent = 'Team name is required.'; err.style.display = 'block'; return; }
  if (!year) { err.textContent = 'Team year is required.'; err.style.display = 'block'; return; }
  if (!seasons.length) { err.textContent = 'Choose at least one season.'; err.style.display = 'block'; return; }

  const res = await apiFetch(`/api/teams/${teamId}`, {
    method: 'PUT',
    body: JSON.stringify({
      teamName: name, gcTeamUrl: gcUrl, pgTeamUrl: pgUrl,
      seasonYear: year, seasonType: seasons.join(','),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { err.textContent = data.error || 'Failed to update team.'; err.style.display = 'block'; return; }

  hideEditMyTeam();
  await loadTeams();
}
function renderMyTeams() {
  const list = document.getElementById('myTeamList');
  if (!list) return;
  const myTeams = getMyTeams();
  if (!myTeams.length) {
    list.innerHTML = `<div class="empty" style="padding:18px 14px"><p style="font-size:12px;color:var(--muted)">No team set yet.<br>Click <b style="color:var(--accent)">+ Add</b> to enter your team.</p></div>`;
    return;
  }
  list.innerHTML = myTeams.map((t) => `
    <div class="team-item ${String(selectedTeam?.id) === String(t.id) ? 'active' : ''}"
         data-team-id="${escHtml(t.id)}"
         onclick="selectTeamById(this.dataset.teamId)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div class="team-name">${escHtml(t.team_name)}</div>
        <div class="team-actions">
          <button class="team-kebab-btn" title="More actions" onclick="event.stopPropagation(); toggleTeamMenu(event, '${escHtml(t.id)}')">⋯</button>
          <div class="dropdown-menu" id="teamMenu-${escHtml(t.id)}">
            <button class="dropdown-item" onclick="event.stopPropagation(); closeAllMenus(); showEditMyTeam('${escHtml(t.id)}')">Edit</button>
            <button class="dropdown-item danger" onclick="event.stopPropagation(); closeAllMenus(); removeMyTeam('${escHtml(t.id)}')">Remove</button>
          </div>
        </div>
      </div>
      <div class="team-meta">
        ${t.season_year ? `<span class="badge badge-year">${escHtml(t.season_year)}</span>` : ''}
        ${(t.season_type || '').split(',').map(s => s.trim()).filter(Boolean).map(s => `<span class="badge badge-season">${escHtml(s)}</span>`).join('')}
        ${t.gc_team_url ? `<span class="badge badge-gc">PSG ✓</span>` : ''}
        ${t.pg_team_url ? `<span class="badge badge-pg">PSP ✓</span>` : ''}
        <span class="badge badge-games">${escHtml(t.game_count ?? 0)} games</span>
      </div>
    </div>
  `).join('');
}
