// ── Job runner ───────────────────────────────────────────────────────────────

function appendJobLogLine(logId, fallbackEl, line) {
  const liveEl = document.getElementById(logId) || fallbackEl;
  if (liveEl) appendLogLine(liveEl, line);
}

function updateSelectedTeamSummaryCounters(summary) {
  if (!summary || typeof summary !== 'object') return;

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value ?? '—';
  };

  setText('statGames', summary.games ?? summary.game_count ?? 0);
  setText('statWins', summary.wins ?? '—');
  setText('statLosses', summary.losses ?? '—');
  setText('statTies', summary.ties ?? '—');
  setText('statBatters', summary.batters ?? '—');

  const lastGame = summary.last_game || summary.lastGame || null;
  setText('statLastGame', lastGame ? new Date(`${lastGame}T12:00:00`).toLocaleDateString() : '—');

  if (selectedTeam) {
    selectedTeam.game_count = summary.games ?? summary.game_count ?? selectedTeam.game_count;
    selectedTeam.last_game = lastGame || selectedTeam.last_game;
    selectedTeam.stats = {
      ...(selectedTeam.stats || {}),
      games: summary.games ?? summary.game_count ?? selectedTeam.stats?.games,
      wins: summary.wins ?? selectedTeam.stats?.wins,
      losses: summary.losses ?? selectedTeam.stats?.losses,
      ties: summary.ties ?? selectedTeam.stats?.ties,
      batters: summary.batters ?? selectedTeam.stats?.batters,
      plays: summary.plays ?? selectedTeam.stats?.plays,
    };
  }
}

async function refreshSelectedTeamSummary() {
  if (!selectedTeam || !selectedTeam.id) return;
  try {
    const res = await apiFetch(`/api/teams/${encodeURIComponent(selectedTeam.id)}/summary`);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.error) return;
    updateSelectedTeamSummaryCounters(data);
  } catch (err) {
    // Keep job logs alive even if the live counter refresh has a temporary issue.
    console.warn('[dashboard] live summary refresh failed:', err.message);
  }
}

function startLiveTeamSummaryRefresh() {
  stopLiveTeamSummaryRefresh();
  refreshSelectedTeamSummary();
  liveTeamSummaryTimer = setInterval(refreshSelectedTeamSummary, 5000);
}

function stopLiveTeamSummaryRefresh() {
  if (liveTeamSummaryTimer) {
    clearInterval(liveTeamSummaryTimer);
    liveTeamSummaryTimer = null;
  }
}

async function runJob(type) {
  if (!selectedTeam) return;

  const logId = 'logContainer';
  const pillId = 'jobStatusPill';
  const labelId = 'jobLabel';

  if (jobStream) { jobStream.close(); jobStream = null; }
  currentJobType = type;

  const logEl = document.getElementById(logId);
  if (!logEl) return;
  logEl.innerHTML = '';
  setStatus(pillId, labelId, 'running', type);
  setStopButtonsVisible(true);
  startLiveTeamSummaryRefresh();

  const body = { teamId: selectedTeam.id };
  if (opts.gameLocation) body.gameLocation     = opts.gameLocation;
  if (opts.gameDate)     body.gameDate         = opts.gameDate;
  if (opts.gameTime)     body.gameTime         = opts.gameTime;
  if (opts.humanObs)     body.humanObservations= opts.humanObs;
  if (opts.gameScope)    body.gameScope        = opts.gameScope;
  if (opts.customPrompt) body.customPrompt     = opts.customPrompt;

  const endpoint = `/api/run/${type}`;
  const res  = await apiFetch(endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const { jobId } = await res.json();
  currentJobId = jobId;

  const _token1 = getSession()?.accessToken || '';
  jobStream = new EventSource(`/api/jobs/${jobId}/stream?token=${encodeURIComponent(_token1)}`);
  jobStream.onmessage = e => {
    const data = JSON.parse(e.data);
    if (data.done) {
      setStatus(pillId, labelId, data.status, type);
      setStopButtonsVisible(false);
      stopLiveTeamSummaryRefresh();
      refreshSelectedTeamSummary();
      currentJobId = null;
      currentJobType = null;
      jobStream.close();
      if (data.status === 'done' && (type === 'report' || type === 'full-pipeline' || type === 'self-scout' || type === 'matchup')) {
        if (activeTab === 'reports') setTimeout(loadReports, 1500);
      }
      return;
    }
    appendJobLogLine(logId, logEl, data.line);
  };
  jobStream.onerror = () => { appendJobLogLine(logId, logEl, '✗ Job log stream disconnected. Check Cloud Platform logs if the job is still running.'); setStatus(pillId, labelId, 'failed', type); setStopButtonsVisible(false); stopLiveTeamSummaryRefresh(); refreshSelectedTeamSummary(); if (jobStream) jobStream.close(); };
}

async function runSelfScout() {
  if (!selectedTeam) return;
  if (jobStream) { jobStream.close(); jobStream = null; }
  currentJobType = 'self-scout';

  const logEl  = document.getElementById('logContainer');
  if (!logEl) return;
  logEl.innerHTML = '';
  setStatus('jobStatusPill', 'jobLabel', 'running', 'self-scout');
  setStopButtonsVisible(true);

  const body = { teamId: selectedTeam.id };
  if (opts.gameLocation) body.gameLocation      = opts.gameLocation;
  if (opts.gameDate)     body.gameDate          = opts.gameDate;
  if (opts.humanObs)     body.humanObservations = opts.humanObs;
  if (opts.gameScope)    body.gameScope         = opts.gameScope;
  if (opts.customPrompt) body.customPrompt      = opts.customPrompt;

  const res = await apiFetch('/api/run/self-scout', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const { jobId: selfJobId } = await res.json();
  currentJobId = selfJobId;

  const _token2 = getSession()?.accessToken || '';
  jobStream = new EventSource(`/api/jobs/${selfJobId}/stream?token=${encodeURIComponent(_token2)}`);
  jobStream.onmessage = e => {
    const data = JSON.parse(e.data);
    if (data.done) {
      setStatus('jobStatusPill', 'jobLabel', data.status, 'self-scout');
      setStopButtonsVisible(false);
      currentJobId = null;
      currentJobType = null;
      jobStream.close();
      return;
    }
    appendJobLogLine('logContainer', logEl, data.line);
  };
  jobStream.onerror = () => { appendJobLogLine('logContainer', logEl, '✗ Job log stream disconnected. Check Cloud Platform logs if the job is still running.'); setStatus('jobStatusPill', 'jobLabel', 'failed', 'self-scout'); setStopButtonsVisible(false); if (jobStream) jobStream.close(); };
}

async function runMatchup() {
  const ourId = opts.matchupOurTeamId || document.getElementById('matchup-our')?.value || null;
  const oppId = opts.matchupOppTeamId || document.getElementById('matchup-opp')?.value || null;

  if (!ourId || !oppId) { alert('Please select both teams for the matchup report.'); return; }
  if (String(ourId) === String(oppId)) { alert('Our team and opponent must be different teams.'); return; }

  if (jobStream) { jobStream.close(); jobStream = null; }
  currentJobType = 'matchup';

  const logEl = document.getElementById('logContainer');
  if (!logEl) return;
  logEl.innerHTML = '';
  setStatus('jobStatusPill', 'jobLabel', 'running', 'matchup');
  setStopButtonsVisible(true);

  // server.js's /api/run/matchup expects `teamId` for the opponent (matching
  // every other /api/run/* route) plus an optional `ourTeamId` override.
  const body = { teamId: oppId, ourTeamId: ourId };
  if (opts.gameLocation)    body.gameLocation      = opts.gameLocation;
  if (opts.gameDate)        body.gameDate          = opts.gameDate;
  if (opts.humanObs)        body.humanObservations = opts.humanObs;
  if (opts.matchupProbable) body.probablePitchers  = opts.matchupProbable;
  if (opts.customPrompt)    body.customPrompt      = opts.customPrompt;

  const res = await apiFetch('/api/run/matchup', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const { jobId: matchupJobId } = await res.json();
  currentJobId = matchupJobId;

  const _token3 = getSession()?.accessToken || '';
  jobStream = new EventSource(`/api/jobs/${matchupJobId}/stream?token=${encodeURIComponent(_token3)}`);
  jobStream.onmessage = e => {
    const data = JSON.parse(e.data);
    if (data.done) {
      setStatus('jobStatusPill', 'jobLabel', data.status, 'matchup');
      setStopButtonsVisible(false);
      currentJobId = null;
      currentJobType = null;
      jobStream.close();
      return;
    }
    appendJobLogLine('logContainer', logEl, data.line);
  };
  jobStream.onerror = () => { appendJobLogLine('logContainer', logEl, '✗ Job log stream disconnected. Check Cloud Platform logs if the job is still running.'); setStatus('jobStatusPill', 'jobLabel', 'failed', 'matchup'); setStopButtonsVisible(false); if (jobStream) jobStream.close(); };
}

function setStopButtonsVisible(visible) {
  document.querySelectorAll('.stop-job-btn').forEach(btn => {
    btn.style.display = visible ? 'inline-flex' : 'none';
    btn.disabled = false;
    btn.textContent = 'Stop Job';
  });
}

function getCurrentJobUi() {
  return { logId: 'logContainer', pillId: 'jobStatusPill', labelId: 'jobLabel', label: currentJobType || 'gc-scraper' };
}

async function stopCurrentJob() {
  if (!currentJobId) { alert('No job is currently running.'); return; }
  const jobIdToStop = currentJobId;
  const ui = getCurrentJobUi();
  const logEl = document.getElementById(ui.logId);
  document.querySelectorAll('.stop-job-btn').forEach(btn => { btn.disabled = true; btn.textContent = 'Stopping...'; });
  if (logEl) appendLogLine(logEl, `Stop requested for job ${jobIdToStop}...`);

  try {
    // Do not use apiFetch() here. apiFetch() logs the user out on any 401.
    // Stop Job should remain an emergency brake even if the UI token expired.
    const session = getSession();
    const headers = { 'Content-Type': 'application/json' };
    if (session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;

    const res = await fetch(`/api/jobs/${jobIdToStop}/stop`, { method: 'POST', headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Stop failed with HTTP ${res.status}`);
    if (jobStream) { jobStream.close(); jobStream = null; }
    if (logEl) appendLogLine(logEl, '✗ Job stopped by user');
    setStatus(ui.pillId, ui.labelId, 'failed', ui.label);
  } catch (err) {
    if (logEl) appendLogLine(logEl, `Stop failed: ${err.message}`);
    alert(err.message);
  } finally {
    currentJobId = null;
    currentJobType = null;
    setStopButtonsVisible(false);
  }
}

function appendLogLine(container, line) {
  const p = document.createElement('p');
  p.className = 'log-line';
  if (/✓|done|success|complete/i.test(line))  p.classList.add('success');
  else if (/✗|error|fail|ERR/i.test(line))    p.classList.add('error');
  else if (/──|step \d/i.test(line))           p.classList.add('heading');
  p.textContent = line;
  container.appendChild(p);
  container.scrollTop = container.scrollHeight;
}

function setStatus(pillId, labelId, status, label) {
  const pill = document.getElementById(pillId);
  const lbl  = document.getElementById(labelId);
  if (!pill || !lbl) return;
  const names = {
    'gc-scraper': 'PSG Analysis', 'pg-scraper': 'PSP Analysis',
    'reingest': 'Reingest', 'report': 'Generate Report',
    'full-pipeline': 'Full Pipeline', 'self-scout': 'Self-Scout', 'matchup': 'Matchup',
  };
  lbl.textContent = names[label] || label;
  pill.className = `status-pill status-${status}`;
  pill.innerHTML = status === 'running'
    ? `<span class="spinner"></span> Running`
    : status === 'done' ? '✓ Done' : status === 'failed' ? '✗ Failed' : 'Idle';
  if (status === 'running') {
    const drawer = document.getElementById('jobLogDrawer');
    const btn = document.getElementById('jobLogToggleBtn');
    if (drawer && !drawer.classList.contains('open')) drawer.classList.add('open');
    if (btn) btn.textContent = 'Hide Logs';
  }
}

// ── Load games ────────────────────────────────────────────────────────────────
async function loadGames() {
  const el = document.getElementById('pane-games');
  if (!el || !selectedTeam) return;

  el.innerHTML = `<p class="log-empty" style="color:var(--muted)">Loading games...</p>`;

  let games;
  try {
    const res = await apiFetch(`/api/teams/${selectedTeam.id}/games`);
    if (!res.ok) throw new Error(`Server returned ${res.status} — restart server.js to pick up new endpoints`);
    games = await res.json();
  } catch (err) {
    el.innerHTML = `<div class="empty"><div class="empty-icon"><svg viewBox="0 0 24 24" width="34" height="34" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M12 3 2 20h20z"/><path d="M12 10v5M12 18h.01"/></svg></div><h3>Could not load games</h3><p>${escHtml(err.message)}</p></div>`;
    return;
  }

  if (!games.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon"><svg viewBox="0 0 24 24" width="34" height="34" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg></div><h3>No games in database</h3><p>Run PSG analysis to pull game data.</p></div>`;
    return;
  }

  el.innerHTML = `
    <div class="section-label">${games.length} game${games.length !== 1 ? 's' : ''} in database</div>
    <div class="games-list">
      ${games.map(g => {
        const result  = g.result || '?';
        const score   = (g.score_us != null && g.score_them != null) ? `${g.score_us}-${g.score_them}` : '—';
        const dateStr = g.game_date
          ? new Date(g.game_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          : '—';
        return `
          <div class="game-row">
            <span class="game-date">${dateStr}</span>
            <span class="game-opp">vs ${escHtml(g.opponent_name || 'Unknown')}</span>
            <span class="game-result ${['W','L','T'].includes(result) ? result : ''}">${result}</span>
            <span class="game-score">${score}</span>
            ${g.gc_game_url ? `<a class="game-link" href="${escHtml(g.gc_game_url)}" target="_blank"><svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg> GC</a>` : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// ── Load reports ──────────────────────────────────────────────────────────────
async function loadReports() {
  const el = document.getElementById('pane-reports');
  if (!el) return;

  const res     = await apiFetch('/api/reports');
  const reports = await res.json();

  const teamSlug = (selectedTeam?.team_name || '').replace(/\s+/g, '-').toLowerCase();
  const filtered = reports.filter(r => r.name.toLowerCase().includes(teamSlug));
  const all      = reports.filter(r => !filtered.includes(r));

  if (!filtered.length && !all.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon"><svg viewBox="0 0 24 24" width="34" height="34" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg></div><h3>No reports yet</h3><p>Run the pipeline to generate a scouting report.</p></div>`;
    return;
  }

  const renderItem = r => {
    const date = new Date(r.mtime).toLocaleDateString();
    const size = (r.size / 1024).toFixed(0) + ' KB';
    return `<div class="report-item">
      <span class="report-icon"><svg viewBox="0 0 24 24" width="17" height="17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"><rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/></svg></span>
      <div>
        <div class="report-name">${escHtml(r.name)}</div>
        <div class="report-meta">${date} · ${size}</div>
      </div>
      <a class="report-dl" href="/reports/${encodeURIComponent(r.name)}" download>Download</a>
    </div>`;
  };

  el.innerHTML =
    (filtered.length ? `<div class="section-label">This Team</div><div class="reports-list">${filtered.map(renderItem).join('')}</div>` : '') +
    (all.length ? `<div class="section-label" style="margin-top:16px">All Reports</div><div class="reports-list">${all.map(renderItem).join('')}</div>` : '');
}
