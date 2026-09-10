/* ============================================================
   STARTUP SURVIVOR — Admin / Judge Panel JS
   ============================================================ */

let _adminUser, _adminState;

/* ── Bootstrap ── */
document.addEventListener('DOMContentLoaded', () => {
  _adminUser = requireAuth('judge');
  if (!_adminUser) return;

  SS.refresh().then(() => { _adminState = SS.load(); renderAll(); }).catch(error => Toast.error('Unable to load command center', error.message));
  renderShockArsenal();
  setupGameControls();
  setupCustomShock();
  setupLogout();
  Poller.start(onStateChange);
});

/* ── Poll callback ── */
function onStateChange(state) {
  _adminState = state;
  Shocks.pruneExpired();
  renderAll();
}

function renderAll() {
  const state = SS.load();
  _adminState = state;
  renderTeamsTable(state);
  renderLeaderboard(state);
  renderActiveShocksPanel(state);
  renderGamePhaseUI(state.gamePhase);
  updateStatsBar(state);
}

/* ── Stats Bar ── */
function updateStatsBar(state) {
  const el = id => document.getElementById(id);
  el('statTeams')   && (el('statTeams').textContent   = state.teams.filter(t=>t.isActive).length);
  el('statShocks')  && (el('statShocks').textContent  = state.activeShocks.length);
  el('statPhase')   && (el('statPhase').textContent   = state.gamePhase.toUpperCase());
  el('statTick')    && (el('statTick').textContent    = Math.max(...Object.values(state.marketState || {}).map(m => m.tick || 0), 0));
}

/* ── Teams Table ── */
function renderTeamsTable(state) {
  const tbody = document.getElementById('teamsTableBody');
  if (!tbody) return;

  const teams = state.teams.filter(t => t.isActive);
  if (teams.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-cell">No teams have joined yet. Share the URL to get started.</td></tr>`;
    return;
  }

  tbody.innerHTML = teams.map((t, rank) => {
    const ms = state.marketState[t.id] || {};
    const profit = ms.netProfit || 0;
    const budget = ms.budget    || 0;
    const maxBudget = ms.maxBudget || 1;
    const budgetPct = Math.max(0, Math.min(100, (budget / maxBudget) * 100));

    return `
      <tr class="team-row">
        <td class="td-rank"><span class="rank-badge rank-${rank+1}">${rank+1}</span></td>
        <td class="td-team">
          <div class="team-cell-name">${t.teamName}</div>
          <div class="team-cell-startup">${t.startupName}</div>
        </td>
        <td><span class="badge ${catBadge(t.category)}">${t.category}</span></td>
        <td class="td-revenue text-green">${Fmt.currency(ms.totalRevenue || 0, true)}</td>
        <td class="${profit>=0?'text-green':'text-red'}">${Fmt.currency(profit, true)}</td>
        <td>
          <div class="mini-bar-wrap">
            <div class="mini-bar" style="width:${budgetPct}%;background:${budgetPct<20?'var(--red)':budgetPct<50?'var(--amber)':'var(--green)'}"></div>
          </div>
          <span style="font-size:11px;color:var(--text-muted)">${Fmt.currency(budget, true)}</span>
        </td>
        <td class="text-cyan">${(ms.conversionRate||0).toFixed(1)}%</td>
        <td>
          <div class="table-actions">
            ${Shocks.CATALOG.slice(0,3).map(s => `<button class="btn btn-sm btn-ghost shock-quick-btn" data-shock="${s.id}" data-team="${t.id}" title="${s.name}">${s.emoji}</button>`).join('')}
          </div>
        </td>
      </tr>`;
  }).join('');

  // Quick shock buttons
  tbody.querySelectorAll('.shock-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      deployShock(btn.dataset.shock, btn.dataset.team);
    });
  });
}

/* ── Leaderboard ── */
function renderLeaderboard(state) {
  const lb = document.getElementById('leaderboard');
  if (!lb) return;

  const ranked = Market.computeLeaderboard(state);
  if (ranked.length === 0) {
    lb.innerHTML = '<div class="lb-empty">Teams will appear here once they join and deploy strategies.</div>';
    return;
  }

  lb.innerHTML = ranked.map((t, i) => {
    const medal = ['🥇','🥈','🥉'][i] || `#${i+1}`;
    const bar   = ranked[0].totalRevenue > 0 ? (t.totalRevenue / ranked[0].totalRevenue) * 100 : 0;
    return `
      <div class="lb-row ${i===0?'lb-leader':''}">
        <div class="lb-rank">${medal}</div>
        <div class="lb-info">
          <div class="lb-name">${t.teamName} <span class="badge ${catBadge(t.category)} badge-sm">${t.category}</span></div>
          <div class="lb-startup">${t.startupName}</div>
          <div class="lb-bar-wrap"><div class="lb-bar" style="width:${bar}%"></div></div>
        </div>
        <div class="lb-stats">
          <div class="lb-revenue">${Fmt.currency(t.totalRevenue, true)}</div>
          <div class="lb-sub">${t.unitsSold} units · ${t.convRate.toFixed(1)}% CVR</div>
        </div>
      </div>`;
  }).join('');
}

/* ── Active Shocks Panel ── */
function renderActiveShocksPanel(state) {
  const el = document.getElementById('activeShocksPanel');
  if (!el) return;

  const shocks = state.activeShocks;
  if (shocks.length === 0) {
    el.innerHTML = '<div class="lb-empty">No active shocks. Deploy from the Arsenal below.</div>';
    return;
  }

  el.innerHTML = shocks.map(s => {
    const tl = Shocks.timeLeft(s);
    const col = Shocks.categoryColor(s.category);
    return `
      <div class="active-shock-chip" style="border-color:${col}44">
        <span>${s.emoji}</span>
        <div class="asc-body">
          <div class="asc-name">${s.name}</div>
          <div class="asc-time" data-expires="${s.expiresAt}">⏱ ${tl}</div>
        </div>
        <div class="asc-effects">
          ${s.effect.demand !==0     ? `<span style="color:${s.effect.demand>0?'var(--green)':'var(--red)'}">D${s.effect.demand>0?'+':''}${s.effect.demand}%</span>` : ''}
          ${s.effect.budget !==0     ? `<span style="color:${s.effect.budget>0?'var(--green)':'var(--red)'}">B${s.effect.budget>0?'+':''}${s.effect.budget}%</span>` : ''}
        </div>
        <button class="asc-remove" onclick="removeShock('${s.instanceId}')" title="Remove shock">✕</button>
      </div>`;
  }).join('');
}

setInterval(() => {
  document.querySelectorAll('.asc-time[data-expires]').forEach(el => {
    const ms = parseInt(el.dataset.expires) - Date.now();
    if (ms <= 0) { el.textContent = '⏱ Expired'; return; }
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    el.textContent = '⏱ ' + (mins > 0 ? `${mins}m ${secs}s` : `${secs}s`);
  });
}, 1000);

function removeShock(instanceId) {
  SS.request(`/api/shocks/${encodeURIComponent(instanceId)}`, { method: 'DELETE' })
    .then(() => SS.refresh()).then(() => { Toast.info('Shock Removed', 'Teams will feel the relief on their next tick.'); renderAll(); })
    .catch(error => Toast.error('Unable to remove shock', error.message));
}

/* ── Shock Arsenal ── */
function renderShockArsenal() {
  const grid = document.getElementById('shockGrid');
  if (!grid) return;

  grid.innerHTML = Shocks.CATALOG.map(shock => {
    const catColor = Shocks.categoryColor(shock.category);
    const sevColor = Shocks.severityColor(shock.severity);
    const eff = shock.effect;

    return `
      <div class="shock-card-admin" data-shock="${shock.id}" style="--cat-color:${catColor}">
        <div class="sca-header">
          <span class="sca-emoji">${shock.emoji}</span>
          <div class="sca-meta">
            <div class="sca-name">${shock.name}</div>
            <span class="badge" style="background:${sevColor}22;color:${sevColor};border:1px solid ${sevColor}44;font-size:10px">${shock.severity}</span>
          </div>
          <div class="sca-cat" style="color:${catColor}">${shock.category}</div>
        </div>
        <p class="sca-desc">${shock.description}</p>
        <div class="sca-effects">
          ${eff.demand!==0     ? `<span class="effect-pill-sm" style="color:${eff.demand>0?'var(--green)':'var(--red)'}">Demand ${eff.demand>0?'+':''}${eff.demand}%</span>` : ''}
          ${eff.budget!==0     ? `<span class="effect-pill-sm" style="color:${eff.budget>0?'var(--green)':'var(--red)'}">Budget ${eff.budget>0?'+':''}${eff.budget}%</span>` : ''}
          ${eff.conversion!==0 ? `<span class="effect-pill-sm" style="color:${eff.conversion>0?'var(--green)':'var(--red)'}">CVR ${eff.conversion>0?'+':''}${eff.conversion}%</span>` : ''}
          <span class="effect-pill-sm" style="color:var(--text-muted)">⏱ ${shock.duration} ticks</span>
        </div>
        <div class="sca-actions">
          <button class="btn btn-danger btn-sm" onclick="deployShock('${shock.id}', null)">⚡ Deploy All</button>
          <button class="btn btn-ghost btn-sm" onclick="openTargetModal('${shock.id}')">🎯 Target Team</button>
        </div>
      </div>`;
  }).join('');
}

/* ── Deploy shock ── */
async function deployShock(shockId, teamId = null) {
  const shock = Shocks.deployShock(shockId, teamId);
  if (!shock) return;
  try { await SS.request('/api/shocks/deploy', { method: 'POST', body: JSON.stringify({ shockId, targetTeamId: teamId }) }); await SS.refresh(); const target = teamId ? '→ Team' : '→ All Teams'; Toast.shock(`⚡ ${shock.name} Deployed`, `${target} • Duration: ${shock.duration} ticks`); renderAll(); }
  catch (error) { Toast.error('Shock deployment failed', error.message); }
}

/* ── Target modal ── */
function openTargetModal(shockId) {
  const modal = document.getElementById('targetModal');
  const sel   = document.getElementById('targetTeamSelect');
  if (!modal || !sel) return;

  const state = SS.load();
  sel.innerHTML = state.teams.filter(t=>t.isActive).map(t =>
    `<option value="${t.id}">${t.teamName} — ${t.startupName}</option>`
  ).join('');

  document.getElementById('targetDeployBtn').onclick = () => {
    deployShock(shockId, sel.value || null);
    modal.classList.remove('active');
  };

  modal.dataset.shockId = shockId;
  modal.classList.add('active');
}

document.addEventListener('DOMContentLoaded', () => {
  const m = document.getElementById('targetModal');
  if (m) {
    document.getElementById('targetCloseBtn')?.addEventListener('click', () => m.classList.remove('active'));
    m.addEventListener('click', e => { if (e.target === m) m.classList.remove('active'); });
  }
});

/* ── Game Controls ── */
function setupGameControls() {
  const actions = {
    startGame:  () => setPhase('active'),
    pauseGame:  () => setPhase('paused'),
    resumeGame: () => setPhase('active'),
    endGame:    () => { if (confirm('End the game? All teams will see a "Game Over" screen.')) setPhase('ended'); },
    resetGame:  () => { if (confirm('RESET everything? This clears all team data and scores!')) { SS.request('/api/game/reset', { method: 'POST' }).then(() => window.location.reload()).catch(error => Toast.error('Reset failed', error.message)); } },
  };
  Object.entries(actions).forEach(([id, fn]) => {
    document.getElementById(id)?.addEventListener('click', fn);
  });
}

function setPhase(phase) {
  const action = phase === 'active' ? (_adminState.gamePhase === 'paused' ? 'resume' : 'start') : phase === 'ended' ? 'end' : 'pause';
  SS.request(`/api/game/${action}`, { method: 'POST' }).then(() => SS.refresh()).then(() => { Toast.info(`Phase: ${phase.toUpperCase()}`, phase === 'active' ? 'Simulation is now LIVE!' : phase === 'ended' ? 'Game Over — check the leaderboard!' : ''); renderAll(); }).catch(error => Toast.error('Game control failed', error.message));
}

function renderGamePhaseUI(phase) {
  const el = document.getElementById('gamePhaseLabel');
  if (!el) return;
  const map = {
    lobby:  { t: '⏳ LOBBY',    c: 'badge-amber' },
    active: { t: '🟢 LIVE',    c: 'badge-green badge-pulse' },
    paused: { t: '⏸ PAUSED',   c: 'badge-amber' },
    ended:  { t: '🏁 GAME OVER',c: 'badge-purple' },
  };
  const info = map[phase] || map.lobby;
  el.textContent = info.t;
  el.className   = `badge ${info.c}`;

  // Show/hide buttons
  document.getElementById('startGame')?.style.setProperty ('display', phase==='lobby' ? '' : 'none');
  document.getElementById('pauseGame')?.style.setProperty ('display', phase==='active'? '' : 'none');
  document.getElementById('resumeGame')?.style.setProperty('display', phase==='paused'? '' : 'none');
  document.getElementById('endGame')?.style.setProperty   ('display', ['active','paused'].includes(phase) ? '' : 'none');
}

/* ── Custom Shock ── */
function setupCustomShock() {
  const form = document.getElementById('customShockForm');
  if (!form) return;
  form.addEventListener('submit', e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (!data.name) { Toast.error('Missing name', 'Please give the shock a name.'); return; }
    Shocks.deployCustomShock({ ...data, targetTeamId: null }).then(() => SS.refresh()).then(() => { Toast.shock(`⚡ Custom Shock: ${data.name}`, 'Deployed to all teams.'); form.reset(); renderAll(); }).catch(error => Toast.error('Custom shock failed', error.message));
  });
}

/* ── Helpers ── */
function catBadge(cat) {
  const m = { FinTech: 'badge-cyan', HealthTech: 'badge-green', EdTech: 'badge-purple', AgriTech: 'badge-amber', CleanTech: 'badge-red', RetailTech: 'badge-cyan' };
  return m[cat] || 'badge-cyan';
}

/* ── Logout ── */
function setupLogout() {
  document.getElementById('logoutBtn')?.addEventListener('click', () => {
    SS.logout().then(() => { window.location.href = 'index.html'; });
  });
}
