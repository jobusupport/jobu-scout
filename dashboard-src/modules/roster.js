// ── Roster ────────────────────────────────────────────────────────────────────
let rosterPlayers = [];

function availabilityBadge(p) {
  if (p.availability_status === 'injured') {
    const back = p.injury_return_date
      ? new Date(p.injury_return_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : 'TBD';
    return `<span class="badge roster-badge-injured">Injured · back ${back}</span>`;
  }
  if (p.availability_status === 'unavailable') {
    const until = p.unavailable_until
      ? new Date(p.unavailable_until + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : '?';
    return `<span class="badge roster-badge-unavailable">Unavailable until ${until}</span>`;
  }
  return `<span class="badge roster-badge-available">Available</span>`;
}

async function loadRoster() {
  const el = document.getElementById('pane-roster');
  if (!el || !selectedTeam) return;

  const res = await apiFetch(`/api/teams/${selectedTeam.id}/players`);
  rosterPlayers = await res.json();

  if (!rosterPlayers.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon"><svg viewBox="0 0 24 24" width="34" height="34" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"><circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/><path d="M17 11a4 4 0 0 0 0-8"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/></svg></div><h3>No players on the roster yet</h3><p>Add players manually, or pull in names already captured by PSG analysis.</p></div>
      <div class="actions" style="justify-content:center;margin-top:14px">
        <button class="btn btn-secondary" onclick="seedRosterFromGames()">Populate From Games</button>
        <button class="btn btn-primary" onclick="showAddPlayer()">Add Player</button>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div class="section-label" style="display:flex;align-items:center;justify-content:space-between">
      <span>${rosterPlayers.length} player${rosterPlayers.length !== 1 ? 's' : ''} on roster</span>
      <span style="display:flex;gap:8px">
        <button class="btn btn-utility" onclick="seedRosterFromGames()">Populate From Games</button>
        <button class="btn btn-primary" onclick="showAddPlayer()">Add Player</button>
      </span>
    </div>
    <div class="roster-list">
      ${rosterPlayers.map(p => `
        <div class="roster-row">
          <span class="roster-name">${escHtml(p.first_name)} ${escHtml(p.last_name)}</span>
          ${p.jersey_number ? `<span class="roster-jersey">#${escHtml(p.jersey_number)}</span>` : ''}
          ${p.handedness ? `<span class="roster-hand">${escHtml(p.handedness)}</span>` : ''}
          ${p.positions ? `<span class="roster-positions">${escHtml(p.positions)}</span>` : ''}
          ${p.is_pickup ? `<span class="badge roster-badge-pickup">Pickup</span>` : ''}
          ${availabilityBadge(p)}
          <span class="roster-actions">
            <button class="btn btn-outline roster-btn-sm" onclick="showEditPlayer(${p.id})">Edit</button>
            <button class="btn btn-outline roster-btn-sm danger" onclick="deletePlayerRow(${p.id})">Remove</button>
          </span>
        </div>
      `).join('')}
    </div>
  `;
}

async function seedRosterFromGames() {
  if (!selectedTeam) return;
  const res  = await apiFetch(`/api/teams/${selectedTeam.id}/players/seed-from-games`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Could not populate roster from games.'); return; }
  await loadRoster();
}

function onPlayerAvailabilityChange() {
  const value = document.querySelector('input[name="playerAvailability"]:checked')?.value || 'available';
  document.getElementById('playerUnavailableUntilWrap').style.display = value === 'unavailable' ? 'block' : 'none';
  document.getElementById('playerInjuryReturnWrap').style.display     = value === 'injured'     ? 'block' : 'none';
}

function resetPlayerModalFields() {
  document.getElementById('playerId').value               = '';
  document.getElementById('playerFirstName').value        = '';
  document.getElementById('playerLastName').value          = '';
  document.getElementById('playerJersey').value            = '';
  document.getElementById('playerHandedness').value        = '';
  document.getElementById('playerPositions').value         = '';
  document.getElementById('playerIsPickup').checked        = false;
  document.getElementById('playerUnavailableUntil').value  = '';
  document.getElementById('playerInjuryReturnDate').value  = '';
  document.querySelector('input[name="playerAvailability"][value="available"]').checked = true;
  onPlayerAvailabilityChange();
  document.getElementById('playerModalError').style.display = 'none';
}

function showAddPlayer() {
  resetPlayerModalFields();
  document.getElementById('playerModalTitle').textContent = 'Add Player';
  document.getElementById('playerModal').style.display = 'flex';
  document.getElementById('playerFirstName').focus();
}

function showEditPlayer(playerId) {
  const p = rosterPlayers.find(r => String(r.id) === String(playerId));
  if (!p) return;
  resetPlayerModalFields();
  document.getElementById('playerModalTitle').textContent = 'Edit Player';
  document.getElementById('playerId').value           = p.id;
  document.getElementById('playerFirstName').value    = p.first_name || '';
  document.getElementById('playerLastName').value     = p.last_name || '';
  document.getElementById('playerJersey').value       = p.jersey_number || '';
  document.getElementById('playerHandedness').value   = p.handedness || '';
  document.getElementById('playerPositions').value    = p.positions || '';
  document.getElementById('playerIsPickup').checked   = !!p.is_pickup;
  document.querySelector(`input[name="playerAvailability"][value="${p.availability_status || 'available'}"]`).checked = true;
  document.getElementById('playerUnavailableUntil').value = p.unavailable_until || '';
  document.getElementById('playerInjuryReturnDate').value = p.injury_return_date || '';
  onPlayerAvailabilityChange();
  document.getElementById('playerModal').style.display = 'flex';
}

function hidePlayerModal() {
  document.getElementById('playerModal').style.display = 'none';
}

async function submitPlayer() {
  const errEl = document.getElementById('playerModalError');
  errEl.style.display = 'none';

  const firstName = document.getElementById('playerFirstName').value.trim();
  const lastName  = document.getElementById('playerLastName').value.trim();
  if (!firstName || !lastName) {
    errEl.textContent = 'First and last name are required.';
    errEl.style.display = 'block';
    return;
  }

  const availabilityStatus = document.querySelector('input[name="playerAvailability"]:checked')?.value || 'available';
  const body = {
    firstName, lastName,
    jerseyNumber: document.getElementById('playerJersey').value.trim(),
    handedness: document.getElementById('playerHandedness').value,
    positions: document.getElementById('playerPositions').value,
    isPickup: document.getElementById('playerIsPickup').checked,
    availabilityStatus,
    unavailableUntil: document.getElementById('playerUnavailableUntil').value || null,
    injuryReturnDate: document.getElementById('playerInjuryReturnDate').value || null,
  };

  const playerId = document.getElementById('playerId').value;
  const url    = playerId ? `/api/teams/${selectedTeam.id}/players/${playerId}` : `/api/teams/${selectedTeam.id}/players`;
  const method = playerId ? 'PUT' : 'POST';

  const res  = await apiFetch(url, { method, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) {
    errEl.textContent = data.error || 'Could not save player.';
    errEl.style.display = 'block';
    return;
  }

  hidePlayerModal();
  await loadRoster();
}

async function deletePlayerRow(playerId) {
  if (!confirm('Remove this player from the roster?')) return;
  await apiFetch(`/api/teams/${selectedTeam.id}/players/${playerId}`, { method: 'DELETE' });
  await loadRoster();
}
