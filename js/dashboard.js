/* ============================================================
   STARTUP SURVIVOR — Dashboard JS (Participant)
   ============================================================ */

let _user, _chartCtx, _chart, _lastState;

/* ── Bootstrap ── */
document.addEventListener('DOMContentLoaded', () => {
  _user = requireAuth('team');
  if (!_user) return;

  renderUserHeader();
  renderBMC();
  SS.refresh().then(syncFromState).catch(error => Toast.error('Unable to load game', error.message));
  startPolling();
  setupControls();
  setupBMCEditing();
  setupLogout();
  Shocks.pruneExpired();
});

/* ── Render header with team info ── */
function renderUserHeader() {
  document.getElementById('teamName').textContent   = _user.teamName;
  document.getElementById('startupName').textContent = _user.startupName;
  document.getElementById('categoryBadge').textContent = _user.category;
  document.getElementById('categoryBadge').className  = `badge ${categoryBadgeClass(_user.category)}`;
  if (_user.tagline) document.getElementById('tagline').textContent = '"' + _user.tagline + '"';
}

function categoryBadgeClass(cat) {
  const map = { FinTech: 'badge-cyan', HealthTech: 'badge-green', EdTech: 'badge-purple', AgriTech: 'badge-amber', CleanTech: 'badge-red', RetailTech: 'badge-cyan' };
  return map[cat] || 'badge-cyan';
}

/* ── Full state sync (called on poll) ── */
async function syncFromState() {
  if (!_lastState) await SS.refresh();
  const state = SS.load();
  _lastState  = state;
  renderBMC();

  const ms = state.marketState[_user.id];
  if (!ms) return;

  // Prune expired shocks
  const myShocks = Shocks.getForTeam(_user.id, state.activeShocks);

  updateMetricCards(ms);
  updateChart(ms);
  renderActiveShocks(myShocks, ms.category);
  renderEventLog(state, ms, myShocks);
  updateControlsFromState(ms, state.gamePhase);
  updatePhaseIndicator(state.gamePhase);
}

/* ── Metric Cards ── */
let _prevMetrics = {};
function updateMetricCards(ms) {
  const metrics = {
    revenue:    { el: 'metRevenue',    val: ms.totalRevenue,   fmt: v => Fmt.currency(v, true), color: 'var(--green)' },
    units:      { el: 'metUnits',      val: ms.totalUnitsSold, fmt: v => Fmt.units(v),           color: 'var(--cyan)' },
    conversion: { el: 'metConversion', val: ms.conversionRate, fmt: v => Fmt.percent(v),         color: 'var(--purple)' },
    price:      { el: 'metPrice',      val: ms.productPrice,   fmt: v => Fmt.currency(v),        color: 'var(--amber)' },
    demand:     { el: 'metDemand',     val: ms.demandIndex,    fmt: v => v.toFixed(1),            color: 'var(--cyan)' },
    quality:    { el: 'metQuality',    val: ms.qualityScore ?? null, fmt: v => v === null ? '—' : `★ ${Number(v).toFixed(1)}`, color: 'var(--amber)' },
    budget:     { el: 'metBudget',     val: ms.budget,         fmt: v => Fmt.currency(v, true),  color: ms.budget < ms.maxBudget * 0.2 ? 'var(--red)' : 'var(--green)' },
  };

  for (const [key, m] of Object.entries(metrics)) {
    const el = document.getElementById(m.el);
    if (!el) continue;
    const prev = _prevMetrics[key] ?? m.val;
    animateNumber(el, prev, m.val, 500, v => m.fmt(v));
    el.style.color = m.color;

    // Delta indicator
    const deltaEl = el.closest('.metric-card')?.querySelector('.metric-delta');
    if (deltaEl && _prevMetrics[key] !== undefined) {
      const diff = m.val - _prevMetrics[key];
      const pct  = _prevMetrics[key] !== 0 ? (diff / Math.abs(_prevMetrics[key])) * 100 : 0;
      if (Math.abs(pct) > 0.1) {
        deltaEl.innerHTML = diff >= 0
          ? `<span>▲</span> ${Fmt.delta(pct)}`
          : `<span>▼</span> ${Fmt.delta(pct)}`;
        deltaEl.className = `metric-delta ${diff >= 0 ? 'up' : 'down'}`;
      }
    }
  }

  _prevMetrics = { revenue: ms.totalRevenue, units: ms.totalUnitsSold, conversion: ms.conversionRate, price: ms.productPrice, demand: ms.demandIndex, quality: ms.qualityScore ?? null, budget: ms.budget };

  // Judge-rated product quality (updates via poll)
  renderQualityBadge(ms, state);

  // Budget health bar
  const pct = Math.max(0, Math.min(100, (ms.budget / ms.maxBudget) * 100));
  const budgetBar = document.getElementById('budgetBar');
  if (budgetBar) {
    budgetBar.style.width = pct + '%';
    budgetBar.style.background = pct < 20 ? 'var(--red)' : pct < 50 ? 'var(--amber)' : 'var(--green)';
  }

  // Tick counter
  const tickEl = document.getElementById('tickCount');
  if (tickEl) tickEl.textContent = ms.tick || 0;

  // Net profit
  const profitEl = document.getElementById('netProfit');
  if (profitEl) {
    profitEl.textContent = Fmt.currency(ms.netProfit, true);
    profitEl.style.color = ms.netProfit >= 0 ? 'var(--green)' : 'var(--red)';
  }
}

/* ── Judge-rated Product Quality (read-only for teams) ── */
function renderQualityBadge(ms, state) {
  const wrap = document.getElementById('qualityBadge');
  if (!wrap) return;
  const entry = (state.quality || {})[_user.id];
  const composite = entry ? entry.composite : (ms.qualityScore ?? null);
  const valEl = document.getElementById('metQuality');
  if (valEl) {
    if (composite === null || composite === undefined) { valEl.textContent = '—'; valEl.style.color = 'var(--text-muted)'; }
    else { valEl.textContent = `★ ${Number(composite).toFixed(1)}`; valEl.style.color = Quality.color(composite); }
  }
  if (composite === null || composite === undefined) {
    wrap.innerHTML = `<span class=\"qb-empty\">⭐ Awaiting judge product-rating</span>`;
    return;
  }
  const mult = Quality.multiplier(composite);
  const delta = Math.round((mult - 1) * 100);
  const attrs = (state.qualityAttributes && state.qualityAttributes.length ? state.qualityAttributes : Quality.FALLBACK_ATTRS);
  const scores = (entry && entry.scores) || {};
  const rows = attrs.map(a => {
    const s = scores[a.id];
    const dots = s === undefined
      ? '<span class=\"qb-na\">not rated</span>'
      : `<span class=\"qb-dots\" aria-hidden=\"true\">${'●'.repeat(s)}${'○'.repeat(10 - s)}</span> <span class=\"qb-score\">${s}/10</span>`;
    return `<div class=\"qb-row\"><span class=\"qb-label\">${a.label} <em>×${a.weight}</em></span>${dots}</div>`;
  }).join('');
  wrap.innerHTML = `
    <div class=\"qb-head\">
      <span class=\"qb-stars\">★ ${Number(composite).toFixed(1)}<span class=\"qb-max\">/10</span></span>
      <span class=\"qb-mult\" style=\"color:${delta >= 0 ? 'var(--green)' : 'var(--red)'}\">${delta >= 0 ? '+' : ''}${delta}% demand</span>
    </div>
    <div class=\"qb-attrs\">${rows}</div>`;
}

/* ── Revenue Chart (Canvas) ── */
function updateChart(ms) {
  const canvas = document.getElementById('revenueChart');
  if (!canvas) return;

  if (!_chartCtx) _chartCtx = canvas.getContext('2d');
  const ctx = _chartCtx;

  const W = canvas.offsetWidth;
  const H = canvas.offsetHeight;
  canvas.width  = W * devicePixelRatio;
  canvas.height = H * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);

  const rev  = ms.revenueHistory || [0];
  const dem  = ms.demandHistory  || [0];

  ctx.clearRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = (H / 4) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  // Draw data series
  drawLine(ctx, rev, W, H, '#00f5ff', true);
  drawLine(ctx, dem.map(d => d * 50), W, H, '#7c3aed', false);

  // Labels
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillText('Revenue', 8, 14);
  ctx.fillStyle = 'rgba(124,58,237,0.8)';
  ctx.fillText('Demand ×50', 8, 28);
}

function drawLine(ctx, data, W, H, color, filled) {
  if (data.length < 2) return;
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => ({
    x: (i / (data.length - 1)) * W,
    y: H - (v / max) * (H - 20) - 10,
  }));

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const cx = (pts[i-1].x + pts[i].x) / 2;
    ctx.bezierCurveTo(cx, pts[i-1].y, cx, pts[i].y, pts[i].x, pts[i].y);
  }

  if (filled) {
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, color + '60');
    grad.addColorStop(1, color + '00');
    ctx.fillStyle = grad;
    ctx.fill();
  }

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const cx = (pts[i-1].x + pts[i].x) / 2;
    ctx.bezierCurveTo(cx, pts[i-1].y, cx, pts[i].y, pts[i].x, pts[i].y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Last point dot
  const last = pts[pts.length - 1];
  ctx.beginPath();
  ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  ctx.fill();
  ctx.shadowBlur = 0;
}

/* ── Active Shocks Banner ── */
let _shownShockIds = new Set();
function renderActiveShocks(shocks, category) {
  const container = document.getElementById('shockBanner');
  const noShock   = document.getElementById('noShock');
  if (!container) return;

  if (shocks.length === 0) {
    container.innerHTML = '';
    if (noShock) noShock.style.display = 'flex';
    return;
  }
  if (noShock) noShock.style.display = 'none';

  container.innerHTML = shocks.map(shock => {
    const effect = { ...shock.effect };
    if (shock.id === 'pandemic_surge') effect.demand = category === 'HealthTech' ? 100 : -30;
    if (shock.id === 'green_mandate')  effect.demand = category === 'CleanTech'  ? 40  : -10;
    const timeLeft = Shocks.timeLeft(shock);
    const catColor = Shocks.categoryColor(shock.category);
    const sevColor = Shocks.severityColor(shock.severity);

    // Show toast only once per shock
    if (!_shownShockIds.has(shock.instanceId)) {
      _shownShockIds.add(shock.instanceId);
      Toast.shock(`⚡ ${shock.name}`, shock.description);
    }

    return `
      <div class="shock-card shock-${shock.category}" style="--shock-color:${catColor}">
        <div class="shock-header">
          <span class="shock-emoji">${shock.emoji}</span>
          <div class="shock-meta">
            <div class="shock-name">${shock.name}</div>
            <div class="shock-desc">${shock.description}</div>
          </div>
          <div class="shock-stats">
            <span class="badge badge-pulse" style="background:${sevColor}22;color:${sevColor};border-color:${sevColor}55">${shock.severity.toUpperCase()}</span>
            <div class="shock-timer" data-expires="${shock.expiresAt}">⏱ ${timeLeft}</div>
          </div>
        </div>
        <div class="shock-effects">
          ${effectPill('Demand', effect.demand)}
          ${effectPill('Budget', effect.budget)}
          ${effectPill('Conversion', effect.conversion)}
        </div>
      </div>`;
  }).join('');

  // Update timers every second
  updateShockTimers();
}

function effectPill(label, val) {
  if (val === 0) return '';
  const color = val > 0 ? 'var(--green)' : 'var(--red)';
  const sign  = val > 0 ? '+' : '';
  return `<span class="effect-pill" style="color:${color};border-color:${color}33;background:${color}11">${label} ${sign}${val}%</span>`;
}

function updateShockTimers() {
  document.querySelectorAll('.shock-timer[data-expires]').forEach(el => {
    const ms = parseInt(el.dataset.expires) - Date.now();
    if (ms <= 0) { el.textContent = '⏱ Expired'; return; }
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    el.textContent = '⏱ ' + (mins > 0 ? `${mins}m ${secs}s` : `${secs}s`);
  });
}
setInterval(updateShockTimers, 1000);

/* ── Event Log ── */
let _logEntries = [];
function renderEventLog(state, ms, shocks) {
  const now = Date.now();
  if (ms.deployCount > 0 && (_logEntries.length === 0 || _logEntries[0].tick !== ms.tick)) {
    _logEntries.unshift({
      tick: ms.tick,
      time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      revenue: ms.revenueHistory[ms.revenueHistory.length - 1] || 0,
      units: ms.unitsSold,
      demand: ms.demandIndex,
      conv: ms.conversionRate,
      shocks: shocks.map(s => s.name),
    });
    if (_logEntries.length > 30) _logEntries.pop();
  }

  const log = document.getElementById('eventLog');
  if (!log) return;

  if (_logEntries.length === 0) {
    log.innerHTML = '<div class="log-empty">Deploy your first strategy to start the simulation…</div>';
    return;
  }

  log.innerHTML = _logEntries.map((e, i) => `
    <div class="log-entry ${i === 0 ? 'log-latest' : ''}">
      <span class="log-time">${e.time}</span>
      <span class="log-tick">T${e.tick}</span>
      <span class="log-val green">+${Fmt.currency(e.revenue, true)}</span>
      <span class="log-val cyan">${Fmt.units(e.units)} units</span>
      <span class="log-val muted">${e.conv.toFixed(1)}% CVR</span>
      ${e.shocks.length ? `<span class="log-shock">⚡ ${e.shocks.join(', ')}</span>` : ''}
    </div>
  `).join('');
}

/* ── Controls ── */
function setupControls() {
  const priceSlider = document.getElementById('priceSlider');
  const priceInput  = document.getElementById('priceInput');
  const mktSlider   = document.getElementById('mktSlider');
  const mktInput    = document.getElementById('mktInput');
  const deployBtn   = document.getElementById('deployBtn');

  if (priceSlider && priceInput) {
    priceSlider.addEventListener('input', () => {
      priceInput.value = priceSlider.value;
      document.getElementById('priceDisplay').textContent = Fmt.currency(parseInt(priceSlider.value));
    });
    priceInput.addEventListener('input', () => {
      priceSlider.value = priceInput.value;
      document.getElementById('priceDisplay').textContent = Fmt.currency(parseInt(priceInput.value));
    });
  }

  if (mktSlider && mktInput) {
    mktSlider.addEventListener('input', () => {
      mktInput.value = mktSlider.value;
      document.getElementById('mktDisplay').textContent = Fmt.currency(parseInt(mktSlider.value));
    });
    mktInput.addEventListener('input', () => {
      mktSlider.value = mktInput.value;
      document.getElementById('mktDisplay').textContent = Fmt.currency(parseInt(mktInput.value));
    });
  }

  if (deployBtn) deployBtn.addEventListener('click', deployStrategy);
}

async function deployStrategy() {
  const btn = document.getElementById('deployBtn');
  if (btn.disabled) return;

  const state = SS.load();
  if (state.gamePhase === 'lobby') {
    Toast.warning('Game not started', 'Wait for the Game Master to start the session.');
    return;
  }
  if (state.gamePhase === 'ended') {
    Toast.info('Game over', 'The simulation has ended. Check the leaderboard!');
    return;
  }

  const price   = parseInt(document.getElementById('priceSlider')?.value || 999);
  const mktSpend = parseInt(document.getElementById('mktSlider')?.value  || 0);
  const segment = document.getElementById('segmentSelect')?.value || 'mass';

  // Animate button
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Simulating…';

  try {
    await SS.request(`/api/teams/${_user.id}/deploy`, { method: 'POST', body: JSON.stringify({ productPrice: price, marketingSpend: mktSpend, targetSegment: segment }) });
    await SS.refresh();
    syncFromState();
    Toast.success('Strategy Deployed!', `Tick ${SS.load().marketState[_user.id]?.tick || '?'} complete — check your metrics.`);
    floatEffect(document.getElementById('metRevenue'));
  } catch (error) { Toast.error('Deployment failed', error.message); }
  btn.disabled = false;
  btn.innerHTML = '<span>🚀</span> Deploy Strategy';
}

function floatEffect(el) {
  if (!el) return;
  const pop = document.createElement('div');
  pop.textContent = '+Rev';
  pop.style.cssText = `position:absolute;color:var(--green);font-weight:700;font-size:13px;pointer-events:none;animation:floatUp 0.8s ease-out forwards;z-index:999`;
  el.style.position = 'relative';
  el.appendChild(pop);
  setTimeout(() => pop.remove(), 900);
}

/* ── Update controls from state ── */
function updateControlsFromState(ms, phase) {
  const priceSlider = document.getElementById('priceSlider');
  const priceInput  = document.getElementById('priceInput');
  const mktSlider   = document.getElementById('mktSlider');
  const mktInput    = document.getElementById('mktInput');
  const deployBtn   = document.getElementById('deployBtn');

  if (priceSlider && ms.productPrice) {
    priceSlider.value = ms.productPrice;
    if (priceInput) priceInput.value = ms.productPrice;
    const disp = document.getElementById('priceDisplay');
    if (disp) disp.textContent = Fmt.currency(ms.productPrice);
  }
  if (mktSlider && ms.marketingSpend !== undefined) {
    mktSlider.value = ms.marketingSpend;
    if (mktInput) mktInput.value = ms.marketingSpend;
    const disp = document.getElementById('mktDisplay');
    if (disp) disp.textContent = Fmt.currency(ms.marketingSpend);
  }
  if (deployBtn) {
    deployBtn.disabled = phase === 'lobby' || phase === 'ended';
    if (phase === 'lobby')  deployBtn.title = 'Waiting for Game Master to start';
    if (phase === 'ended')  deployBtn.title = 'Game has ended';
    if (phase === 'active') deployBtn.title = '';
  }
}

/* ── Phase indicator ── */
function updatePhaseIndicator(phase) {
  const el = document.getElementById('phaseIndicator');
  if (!el) return;
  const map = {
    lobby:  { label: '⏳ Waiting to Start', cls: 'badge-amber' },
    active: { label: '🟢 LIVE',             cls: 'badge-green badge-pulse' },
    paused: { label: '⏸ Paused',            cls: 'badge-amber' },
    ended:  { label: '🏁 Game Over',         cls: 'badge-purple' },
  };
  const info = map[phase] || map.lobby;
  el.textContent = info.label;
  el.className   = `badge ${info.cls}`;
}

/* ── BMC ── */
function renderBMC() {
  const state = SS.load();
  const ms = state.marketState[_user.id];
  if (!ms?.bmc) return;
  const bmc = ms.bmc;
  const fields = ['keyPartners','keyActivities','keyResources','valueProposition','customerRelationships','channels','customerSegments','costStructure','revenueStreams'];
  fields.forEach(f => {
    const el = document.getElementById('bmc_' + f);
    if (el) el.textContent = bmc[f] || '';
  });
}

function setupBMCEditing() {
  document.querySelectorAll('.bmc-cell[data-field]').forEach(cell => {
    cell.addEventListener('click', () => openBMCEditor(cell.dataset.field, cell.dataset.label));
  });
}

function openBMCEditor(field, label) {
  const modal = document.getElementById('bmcModal');
  const titleEl = document.getElementById('bmcModalTitle');
  const input   = document.getElementById('bmcInput');
  if (!modal) return;

  titleEl.textContent = 'Edit: ' + label;
  const state = SS.load();
  const ms    = state.marketState[_user.id];
  input.value = ms?.bmc?.[field] || '';
  input.dataset.field = field;

  modal.classList.add('active');
  input.focus();
}

document.addEventListener('DOMContentLoaded', () => {
  const saveBtn  = document.getElementById('bmcSaveBtn');
  const closeBtn = document.getElementById('bmcCloseBtn');
  const modal    = document.getElementById('bmcModal');

  if (saveBtn) saveBtn.addEventListener('click', saveBMC);
  if (closeBtn) closeBtn.addEventListener('click', () => modal?.classList.remove('active'));
  if (modal) modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('active'); });
});

async function saveBMC() {
  const input = document.getElementById('bmcInput');
  const field = input?.dataset.field;
  if (!field) return;

  try { await SS.request(`/api/teams/${_user.id}/bmc`, { method: 'PATCH', body: JSON.stringify({ field, value: input.value }) }); await SS.refresh(); }
  catch (error) { Toast.error('BMC update failed', error.message); return; }

  renderBMC();
  document.getElementById('bmcModal')?.classList.remove('active');
  Toast.success('BMC Updated', 'Your canvas has been saved.');
}

/* ── Polling ── */
function startPolling() {
  Poller.start(syncFromState);
}

/* ── Logout ── */
function setupLogout() {
  const btn = document.getElementById('logoutBtn');
  if (btn) btn.addEventListener('click', () => {
    SS.logout().then(() => { window.location.href = 'index.html'; });
  });
}
