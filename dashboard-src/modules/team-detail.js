// ── Render main panel ─────────────────────────────────────────────────────────
function renderMain() {
  const t = selectedTeam;
  if (!t) return;

  const s        = t.stats || {};
  const lastGame = t.last_game ? new Date(t.last_game + 'T12:00:00').toLocaleDateString() : '—';

  document.getElementById('mainPanel').innerHTML = `
    <div class="team-panel">
      <div class="team-title">${escHtml(t.team_name)}</div>
      <div class="team-summary">
        <span>${s.games ?? s.game_count ?? t.game_count ?? 0} games</span>
        <span class="dot-sep">·</span>
        <span>${s.wins ?? '—'}-${s.losses ?? '—'}${s.ties ? '-' + s.ties : ''}</span>
        <span class="dot-sep">·</span>
        <span>${s.batters ?? '—'} batters</span>
        <span class="dot-sep">·</span>
        <span>Last ${lastGame}</span>
        <span class="dot-sep">·</span>
        <span class="${t.hasGC ? 'ok' : 'warn'}">PSG ${t.hasGC ? 'Ready' : 'Missing'}</span>
        <span class="dot-sep">·</span>
        <span class="${t.hasPG ? 'ok' : 'warn'}">PSP ${t.hasPG ? 'Ready' : 'Missing'}</span>
      </div>
      <div class="team-urls">
        ${t.gc_team_url ? `<a class="url-link" href="${t.gc_team_url}" target="_blank"><svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M9 15a5 5 0 0 0 7 0l3-3a5 5 0 1 0-7-7l-1 1"/><path d="M15 9a5 5 0 0 0-7 0l-3 3a5 5 0 1 0 7 7l1-1"/></svg> PSG</a>` : ''}
        ${t.pg_team_url ? `<a class="url-link" href="${t.pg_team_url}" target="_blank"><svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M9 15a5 5 0 0 0 7 0l3-3a5 5 0 1 0-7-7l-1 1"/><path d="M15 9a5 5 0 0 0-7 0l-3 3a5 5 0 1 0 7 7l1-1"/></svg> PSP</a>` : ''}
      </div>
    </div>

    ${renderPipelineActions()}

    <div class="main-tabs" id="mainTabs">
      ${t.is_our_team ? `
      <div class="main-tab ${activeTab==='self'?'active':''}"     onclick="switchTab('self')">Self-Scout</div>
      <div class="main-tab ${activeTab==='matchup'?'active':''}"  onclick="switchTab('matchup')">Matchup</div>
      <div class="main-tab ${activeTab==='roster'?'active':''}"   onclick="switchTab('roster')">Roster</div>
      ` : `
      <div class="main-tab ${activeTab==='run'?'active':''}"      onclick="switchTab('run')">Single Opponent Scout</div>
      `}
      <div class="main-tab ${activeTab==='games'?'active':''}"    onclick="switchTab('games')">Games</div>
      <div class="main-tab ${activeTab==='reports'?'active':''}"  onclick="switchTab('reports')">Reports</div>
    </div>

    <div class="main-content">
      ${t.is_our_team ? `
      <!-- SELF-SCOUT TAB -->
      <div class="main-pane ${activeTab==='self'?'active':''}" id="pane-self">
        ${renderSelfPane()}
      </div>

      <!-- MATCHUP TAB -->
      <div class="main-pane ${activeTab==='matchup'?'active':''}" id="pane-matchup">
        ${renderMatchupPane()}
      </div>

      <!-- ROSTER TAB -->
      <div class="main-pane ${activeTab==='roster'?'active':''}" id="pane-roster">
        <p class="log-empty" style="color:var(--muted)">Loading roster...</p>
      </div>
      ` : `
      <!-- RUN TAB -->
      <div class="main-pane ${activeTab==='run'?'active':''}" id="pane-run">
        ${renderRunPane()}
      </div>
      `}

      <!-- GAMES TAB -->
      <div class="main-pane ${activeTab==='games'?'active':''}" id="pane-games">
        <p class="log-empty" style="color:var(--muted)">Loading games...</p>
      </div>

      <!-- REPORTS TAB -->
      <div class="main-pane ${activeTab==='reports'?'active':''}" id="pane-reports">
        <p class="log-empty" style="color:var(--muted)">Loading reports...</p>
      </div>
    </div>

    ${renderJobLogBar()}
  `;

  if (activeTab === 'games')   loadGames();
  if (activeTab === 'reports') loadReports();
  if (activeTab === 'roster')  loadRoster();
}

// ── Pane renderers ────────────────────────────────────────────────────────────

function renderPipelineActions() {
  const t = selectedTeam;
  return `
    <div class="run-section">
      <div class="actions actions-hierarchy">
        <button class="btn btn-primary" onclick="runJob('full-pipeline')" ${t.game_count<1&&!t.gc_team_url?'disabled':''}><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M7 4v16l13-8z"/></svg> Full Pipeline</button>
        <button class="btn btn-secondary" onclick="runJob('report')" ${t.game_count<1?'disabled title="No games yet"':''}><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg> Generate Report</button>
        <span class="actions-divider"></span>
        <button class="btn btn-utility" onclick="runJob('gc-scraper')">PSG Analysis</button>
        <button class="btn btn-utility" onclick="runJob('pg-scraper')" ${!t.pg_team_url?'disabled title="No PSP URL"':''}>PSP Analysis</button>
        <div class="dropdown-wrap">
          <button class="btn btn-utility" onclick="toggleMoreMenu(event)">More ▾</button>
          <div class="dropdown-menu" id="pipelineMoreMenu">
            <button class="dropdown-item" onclick="closeAllMenus(); runJob('reingest')">Reingest</button>
            <button class="dropdown-item" onclick="closeAllMenus(); ${t.is_our_team ? `showEditMyTeam('${escHtml(t.id)}')` : `showEditTeam('${escHtml(t.id)}')`}">${t.is_our_team ? 'Edit Team' : 'Edit Opponent'}</button>
            <button class="dropdown-item danger" onclick="closeAllMenus(); ${t.is_our_team ? `removeMyTeam('${escHtml(t.id)}')` : `removeOpponent('${escHtml(t.id)}')`}">Remove Team</button>
          </div>
        </div>
      </div>
    </div>
    <hr class="divider">
  `;
}

// Single shared Job Log — used by every job type (GC/PG/Reingest/Generate
// Report/Full Pipeline/Self-Scout/Matchup). Rendered once, at the bottom of
// the panel, regardless of which tab is active, so there is never more than
// one Job Log visible at a time.
function renderJobLogBar() {
  return `
    <hr class="divider">
    <div class="job-log-bar">
      <span id="jobStatusPill" class="status-pill status-idle">Idle</span>
      <span id="jobLabel" style="color:var(--muted)">No job running</span>
      <button class="refresh-btn stop-job-btn" onclick="stopCurrentJob()">Stop Job</button>
      <button class="refresh-btn" id="jobLogToggleBtn" onclick="toggleJobLogDrawer()" style="margin-left:auto">View Logs</button>
    </div>
    <div class="job-log-drawer" id="jobLogDrawer">
      <div class="log-container" id="logContainer">
        <p class="log-empty">Run a pipeline step above to see logs here.</p>
      </div>
    </div>
  `;
}

function toggleJobLogDrawer() {
  const drawer = document.getElementById('jobLogDrawer');
  const btn = document.getElementById('jobLogToggleBtn');
  if (!drawer) return;
  const open = drawer.classList.toggle('open');
  if (btn) btn.textContent = open ? 'Hide Logs' : 'View Logs';
}

function renderRunPane() {
  return `
    <div class="section-label">Report Options</div>

    <div class="options-grid">
      <div class="opt-group">
        <label>Game Location</label>
        <input class="opt-input" id="opt-location" type="text" placeholder="e.g. Nashville, TN"
          value="${escHtml(opts.gameLocation)}" oninput="opts.gameLocation=this.value">
      </div>
      <div class="opt-group">
        <label>Game Date</label>
        <input class="opt-input" id="opt-date" type="date"
          value="${opts.gameDate}" oninput="opts.gameDate=this.value">
      </div>
      <div class="opt-group">
        <label>Game Time</label>
        <input class="opt-input" id="opt-time" type="time"
          value="${opts.gameTime}" oninput="opts.gameTime=this.value">
      </div>
      <div class="opt-group">
        <label>Game Scope</label>
        <select class="opt-select" id="opt-scope" onchange="opts.gameScope=this.value">
          <option value="all" ${opts.gameScope==='all'?'selected':''}>Entire Season</option>
          <option value="last10" ${opts.gameScope==='last10'?'selected':''}>Last 10 Games</option>
        </select>
      </div>
    </div>

    <div class="obs-group">
      <label>Human Observations <span style="font-weight:400;text-transform:none;letter-spacing:0">(live scouting notes — tell Jobu what you know and what you have seen)</span></label>
      <textarea class="obs-textarea" id="opt-obs" placeholder="e.g. Their #12 has a big leg kick and struggles with inside fastballs. Catcher has a weak arm, ran on him twice. Their CF was shading right on all their lefties..."
        oninput="opts.humanObs=this.value">${escHtml(opts.humanObs)}</textarea>
    </div>
  `;
}

function renderSelfPane() {
  return `
    <div class="mode-notice"><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg> Self-Scouting Mode — analyzes YOUR team's data for internal coaching review</div>

    <div class="section-label">Self-Scout Options</div>

    <div class="options-grid">
      <div class="opt-group">
        <label>Game Location</label>
        <input class="opt-input" type="text" placeholder="e.g. Nashville, TN"
          value="${escHtml(opts.gameLocation)}" oninput="opts.gameLocation=this.value">
      </div>
      <div class="opt-group">
        <label>Game Date</label>
        <input class="opt-input" type="date" value="${opts.gameDate}" oninput="opts.gameDate=this.value">
      </div>
      <div class="opt-group">
        <label>Game Scope</label>
        <select class="opt-select" onchange="opts.gameScope=this.value">
          <option value="all" ${opts.gameScope==='all'?'selected':''}>Entire Season</option>
          <option value="last10" ${opts.gameScope==='last10'?'selected':''}>Last 10 Games</option>
        </select>
      </div>
    </div>

    <div class="obs-group">
      <label>Coach Notes <span style="font-weight:400;text-transform:none;letter-spacing:0">(things you want Jobu to focus on)</span></label>
      <textarea class="obs-textarea" placeholder="e.g. We've been struggling with two-strike approaches. Our pitchers are throwing too many first-pitch balls. Focus on our RISP situations..."
        oninput="opts.humanObs=this.value">${escHtml(opts.humanObs)}</textarea>
    </div>

    <div class="obs-group">
      <label>Custom Self-Scout Prompt <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional — overrides default self-scouting instructions)</span></label>
      <textarea class="obs-textarea" style="min-height:90px" placeholder="e.g. Focus exclusively on our lineup's performance against left-handed pitching. Identify which hitters handle LHP well and which ones struggle. Give me a recommended batting order adjustment..."
        oninput="opts.customPrompt=this.value">${escHtml(opts.customPrompt)}</textarea>
    </div>

    <div class="actions">
      <button class="btn btn-scout" onclick="runSelfScout()" ${selectedTeam?.game_count<1?'disabled title="No games yet"':''}><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg> Generate Self-Scout Report</button>
    </div>
  `;
}

function renderMatchupPane() {
  // Default "Our Team" to whichever My Team is currently selected.
  if (!opts.matchupOurTeamId && selectedTeam?.is_our_team) {
    opts.matchupOurTeamId = selectedTeam.id;
  }

  const teamOptions = allTeams.map(t =>
    `<option value="${t.id}" ${String(t.id)===String(opts.matchupOurTeamId)?'selected':''}>${escHtml(t.team_name)}</option>`
  ).join('');
  const oppOptions = allTeams.filter(t => !t.is_our_team).map(t =>
    `<option value="${t.id}" ${String(t.id)===String(opts.matchupOppTeamId)?'selected':''}>${escHtml(t.team_name)}</option>`
  ).join('');

  return `
    <div class="mode-notice matchup-notice"><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"><polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" y1="19" x2="19.5" y2="12.5"/><line x1="16" y1="16" x2="20" y2="20"/><polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5"/><line x1="5.5" y1="13.5" x2="11" y2="19"/><line x1="8" y1="16" x2="4" y2="20"/></svg> Head-to-Head Matchup — identifies pitcher/hitter matchups and game plan vs a specific opponent</div>

    <div class="section-label">Teams</div>
    <div class="matchup-grid">
      <div class="matchup-team-box">
        <label>Our Team</label>
        <div class="team-select-wrap">
          <select id="matchup-our" onchange="opts.matchupOurTeamId=this.value">
            <option value="">— Select our team —</option>
            ${teamOptions}
          </select>
        </div>
      </div>
      <div class="matchup-team-box">
        <label>Opponent</label>
        <div class="team-select-wrap">
          <select id="matchup-opp" onchange="opts.matchupOppTeamId=this.value">
            <option value="">— Select opponent —</option>
            ${oppOptions}
          </select>
        </div>
      </div>
    </div>

    <div class="section-label">Game Context</div>
    <div class="options-grid">
      <div class="opt-group">
        <label>Game Location</label>
        <input class="opt-input" type="text" placeholder="e.g. Nashville, TN"
          value="${escHtml(opts.gameLocation)}" oninput="opts.gameLocation=this.value">
      </div>
      <div class="opt-group">
        <label>Game Date</label>
        <input class="opt-input" type="date" value="${opts.gameDate}" oninput="opts.gameDate=this.value">
      </div>
    </div>

    <div class="obs-group">
      <label>Probable Pitchers (Opponent) <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional — tell Jobu who you expect on the mound)</span></label>
      <input class="opt-input" style="width:100%" type="text" placeholder="e.g. #12 Johnson (ace), #7 Williams (lefty reliever likely in later innings)"
        value="${escHtml(opts.matchupProbable)}" oninput="opts.matchupProbable=this.value">
    </div>

    <div class="obs-group">
      <label>Human Observations <span style="font-weight:400;text-transform:none;letter-spacing:0">(live notes from watching them)</span></label>
      <textarea class="obs-textarea" placeholder="e.g. Their ace is sitting 77-80 with a sharp 12-6 curve. Saw them live Tuesday — they struggle to cover the outer third with RISP..."
        oninput="opts.humanObs=this.value">${escHtml(opts.humanObs)}</textarea>
    </div>

    <div class="obs-group">
      <label>Custom Matchup Focus <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional — direct what the AI focuses on)</span></label>
      <textarea class="obs-textarea" style="min-height:72px" placeholder="e.g. Focus on identifying which of our hitters have the best historical matchup profile against the type of pitching this team throws. Recommend specific lineup adjustments..."
        oninput="opts.customPrompt=this.value">${escHtml(opts.customPrompt)}</textarea>
    </div>

    <div class="actions">
      <button class="btn btn-matchup" onclick="runMatchup()"><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"><polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" y1="19" x2="19.5" y2="12.5"/><line x1="16" y1="16" x2="20" y2="20"/><polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5"/><line x1="5.5" y1="13.5" x2="11" y2="19"/><line x1="8" y1="16" x2="4" y2="20"/></svg> Generate Matchup Report</button>
    </div>
  `;
}

// ── Tab switching ────────────────────────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.main-tab').forEach(el => {
    const name = el.textContent.toLowerCase().replace(/[^a-z]/g,'');
    el.classList.toggle('active',
      name === tab || (tab==='self' && name==='selfscout') || (tab==='matchup' && name==='matchup') || (tab==='run' && name==='singleopponentscout')
    );
  });
  document.querySelectorAll('.main-pane').forEach(el => {
    el.classList.toggle('active', el.id === `pane-${tab}`);
  });
  if (tab === 'games')   loadGames();
  if (tab === 'reports') loadReports();
  if (tab === 'roster')  loadRoster();
}
