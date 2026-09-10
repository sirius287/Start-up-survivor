/* ============================================================
   STARTUP SURVIVOR — Judge Product Quality panel (admin)
   Sliders 1-10 per attribute -> POST /api/quality/:teamId.
   Unsaved slider positions survive the 1.5s poll re-renders.
   ============================================================ */

let _qualityTeamId = null;

function qualityAttrs(state) {
  return (state.qualityAttributes && state.qualityAttributes.length ? state.qualityAttributes : Quality.FALLBACK_ATTRS);
}

function qualityEntry(state, teamId) {
  return (state.quality || {})[String(teamId)] || { scores: {}, composite: null };
}

/* Small chip shown in the contenders table Quality column. */
function qualityCell(teamId, state) {
  const entry = qualityEntry(state, teamId);
  if (entry.composite === null || entry.composite === undefined) return '<span class="q-unrated">—</span>';
  return `<button type="button" class="q-chip" data-quality-team="${teamId}" style="color:${Quality.color(entry.composite)}" title="Jump to rating panel">★ ${Number(entry.composite).toFixed(1)}</button>`;
}

function qualityOptionLabel(state, t) {
  const entry = qualityEntry(state, t.id);
  const label = entry.composite == null ? 'unrated' : `★ ${Number(entry.composite).toFixed(1)}`;
  return `${t.teamName} — ${t.startupName} (${label})`;
}

function sliderVal(teamId, attrId, entry) {
  const slider = document.getElementById('q_' + attrId);
  // Keep the judge's unsaved position when the panel re-renders on poll.
  if (slider && slider.dataset.team === String(teamId) && !slider.dataset.cleared) return slider.value;
  const saved = entry.scores ? entry.scores[attrId] : undefined;
  return saved === undefined ? 5 : saved;
}

function renderQualityPanel(state) {
  const sel = document.getElementById('qualityTeamSelect');
  const form = document.getElementById('qualityForm');
  const saveBtn = document.getElementById('saveQualityBtn');
  if (!sel || !form) return;

  const teams = state.teams.filter(t => t.isActive);
  if (teams.length === 0) {
    sel.innerHTML = '';
    form.innerHTML = '<div class="lb-empty">No teams have joined yet.</div>';
    if (saveBtn) saveBtn.disabled = true;
    _qualityTeamId = null;
    return;
  }
  if (saveBtn) saveBtn.disabled = false;

  if (!_qualityTeamId || !teams.some(t => String(t.id) === String(_qualityTeamId))) {
    _qualityTeamId = String(teams[0].id);
  }

  // Refresh the team picker without disrupting an open dropdown.
  const teamValues = teams.map(t => String(t.id)).join(',');
  const selValues = [...sel.options].map(o => o.value).join(',');
  if (selValues !== teamValues) {
    sel.innerHTML = teams.map(t => `<option value="${t.id}"></option>`).join('');
  }
  teams.forEach(t => {
    const opt = sel.querySelector(`option[value="${t.id}"]`);
    if (opt) opt.textContent = qualityOptionLabel(state, t);
  });
  if (sel.value !== String(_qualityTeamId)) sel.value = String(_qualityTeamId);

  const team = teams.find(t => String(t.id) === String(_qualityTeamId)) || teams[0];
  _qualityTeamId = String(team.id);
  const entry = qualityEntry(state, team.id);
  const attrs = qualityAttrs(state);

  // Don't rebuild sliders while the judge is interacting with them, or when
  // nothing changed — rebuilding mid-drag would drop the in-progress rating.
  const signature = [team.id, attrs.map(a => a.id).join(','), attrs.map(a => entry.scores?.[a.id] ?? '-').join(',')].join('|');
  const interacting = form.contains(document.activeElement) && document.activeElement?.classList?.contains('q-slider');
  if (form.dataset.signature === signature && form.querySelector('.q-slider')) {
    refreshQualitySummary(team.id, state);
    return;
  }
  if (interacting) return;
  form.dataset.signature = signature;

  form.innerHTML = `
    <div class="q-summary"></div>
    ${attrs.map(a => {
      const v = sliderVal(team.id, a.id, entry);
      const isNew = entry.scores?.[a.id] === undefined;
      return `
      <div class="control-group q-attr">
        <div class="cg-label-row">
          <label class="form-label" for="q_${a.id}">${a.label} <span class="q-weight">×${a.weight}</span></label>
          <span class="cg-value q-value" id="qval_${a.id}">${isNew ? '—' : `${v}/10`}</span>
        </div>
        <input type="range" class="form-range q-slider" id="q_${a.id}" data-attr="${a.id}" data-team="${team.id}"
          min="1" max="10" step="1" value="${v}" data-touched="${isNew ? '0' : '1'}"${isNew ? ' data-cleared="1"' : ''}
          aria-label="Rate ${a.label} from 1 to 10">
        <div class="cg-range-labels"><span>1 — poor</span><span>10 — elite</span></div>
        <div class="q-desc">${a.description}</div>
      </div>`;
    }).join('')}`;

  refreshQualitySummary(team.id, state);
  form.querySelectorAll('.q-slider').forEach(slider => {
    slider.addEventListener('input', () => {
      slider.dataset.touched = '1';
      delete slider.dataset.cleared;
      const out = document.getElementById('qval_' + slider.dataset.attr);
      if (out) out.textContent = `${slider.value}/10`;
      refreshQualitySummary(team.id, state);
    });
  });
}

function currentQualityDraft(teamId, attrs) {
  const draft = {};
  for (const a of attrs) {
    const slider = document.getElementById('q_' + a.id);
    if (slider && slider.dataset.team === String(teamId) && !slider.dataset.cleared) draft[a.id] = Number(slider.value);
  }
  return draft;
}

function refreshQualitySummary(teamId, state) {
  const attrs = qualityAttrs(state);
  const entry = qualityEntry(state, teamId);
  const draft = currentQualityDraft(teamId, attrs);
  const hasDraft = Object.keys(draft).length > 0;
  const shown = hasDraft ? Quality.composite(draft, attrs) : entry.composite;
  const summary = document.querySelector('#qualityForm .q-summary');
  if (!summary) return;
  if (shown === null || shown === undefined) {
    summary.innerHTML = `<span class="q-summary-score" style="color:var(--text-muted)">Not rated yet</span>
      <span class="q-summary-mult" style="color:var(--text-muted)">demand ±0%</span>`;
    return;
  }
  const delta = Math.round((Quality.multiplier(shown) - 1) * 100);
  summary.innerHTML = `<span class="q-summary-score" style="color:${Quality.color(shown)}">★ ${Number(shown).toFixed(1)} / 10${hasDraft ? ' <em class="q-preview-tag">preview</em>' : ''}</span>
    <span class="q-summary-mult" style="color:${delta >= 0 ? 'var(--green)' : 'var(--red)'}">demand ${delta >= 0 ? '+' : ''}${delta}%</span>`;
}

function setupQualityPanel() {
  const sel = document.getElementById('qualityTeamSelect');
  const saveBtn = document.getElementById('saveQualityBtn');
  if (sel) {
    sel.addEventListener('change', () => {
      _qualityTeamId = sel.value || null;
      const form = document.getElementById('qualityForm');
      if (form) delete form.dataset.signature; // force rebuild for the new team
      renderQualityPanel(SS.load());
    });
  }
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      if (!_qualityTeamId) { Toast.warning('No contender selected', 'Wait for a team to join first.'); return; }
      const state = SS.load();
      const attrs = qualityAttrs(state);
      const scores = {};
      for (const a of attrs) {
        const slider = document.getElementById('q_' + a.id);
        if (!slider || slider.dataset.team !== String(_qualityTeamId)) continue;
        if (slider.dataset.touched === '1' && !slider.dataset.cleared) scores[a.id] = Number(slider.value);
      }
      if (Object.keys(scores).length === 0) { Toast.warning('Nothing to save', 'Move at least one slider first.'); return; }
      saveBtn.disabled = true;
      try {
        const saved = await SS.request(`/api/quality/${encodeURIComponent(_qualityTeamId)}`, { method: 'POST', body: JSON.stringify({ scores }) });
        await SS.refresh();
        renderAll();
        Toast.success('Quality scores saved', `Composite ★ ${Number(saved.composite).toFixed(1)} — live in the market model.`);
      } catch (error) { Toast.error('Unable to save scores', error.message); }
      finally { saveBtn.disabled = false; }
    });
  }
  // Clicking a Quality chip in the contenders table jumps to that team.
  document.addEventListener('click', e => {
    const chip = e.target.closest?.('[data-quality-team]');
    if (!chip) return;
    _qualityTeamId = chip.dataset.qualityTeam;
    const form = document.getElementById('qualityForm');
    if (form) delete form.dataset.signature; // force rebuild for the new team
    renderQualityPanel(SS.load());
    document.getElementById('qualityTeamSelect')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}
