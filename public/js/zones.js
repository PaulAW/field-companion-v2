/* zones.js — Zone grid, detail view, tasks, and in-app description editing */

var Zones = (() => {
  let _showingDetail = false;
  const OVERRIDES_KEY = 'fc_zone_overrides';

  const $ = id => document.getElementById(id);

  function init() {
    App.registerTab('zones', { onShow });
  }

  function onShow() {
    if (!_showingDetail) renderGrid();
  }

  /* ── Zone overrides (user-edited fields saved to localStorage) ── */
  function getOverrides() {
    try { return JSON.parse(localStorage.getItem(OVERRIDES_KEY) || '{}'); } catch { return {}; }
  }

  function saveOverride(zoneId, fields) {
    const overrides = getOverrides();
    overrides[zoneId] = { ...(overrides[zoneId] || {}), ...fields };
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
  }

  function mergeZone(z) {
    const overrides = getOverrides();
    return overrides[z.id] ? { ...z, ...overrides[z.id] } : z;
  }

  /* ── Grid ── */
  function renderGrid() {
    _showingDetail = false;
    const container = $('zones-container');
    if (!container) return;
    const zones = App.getZones().map(mergeZone);

    container.innerHTML = `
      <div class="zone-grid" id="zone-grid">
        ${zones.map(z => zoneCardHTML(z)).join('')}
      </div>
      <div class="zone-hint">Tap any zone for full detail</div>`;

    container.querySelectorAll('.zone-card').forEach((el, i) => {
      el.addEventListener('click', () => renderDetail(zones[i]));
    });
  }

  function zoneCardHTML(z) {
    const urgent = z.urgency === 'high';
    const issue  = z.priority_action
      ? z.priority_action.replace(/^(URGENT:|#\d+ PRIORITY:)\s*/i, '').split('.')[0]
      : '';
    return `
      <div class="zone-card ${urgent ? 'urgent' : ''}">
        <div class="zn">Zone ${esc(z.id)}${urgent ? ' ⚠️' : ''}</div>
        <div class="zd">${esc(z.name)} · ${z.acres} ac</div>
        ${urgent && issue ? `<div class="zp">${esc(issue.substring(0, 60))}</div>` : ''}
      </div>`;
  }

  /* ── Detail ── */
  function renderDetail(zone) {
    zone = mergeZone(zone); // apply any overrides
    _showingDetail = true;
    const container = $('zones-container');
    if (!container) return;

    const urgentClass = zone.urgency === 'high' ? 'action-remove' : 'action-nurture';

    const invasivesList = (zone.invasives || []).length
      ? zone.invasives.map(s => `<li>${esc(s)}</li>`).join('')
      : '<li style="color:var(--muted)">None confirmed</li>';

    const targetsList = (zone.target_natives || []).map(s => `<li>${esc(s)}</li>`).join('');

    // Tasks for this zone
    const zoneTasks = (window.Tasks && Tasks.getTasksForZone)
      ? Tasks.getTasksForZone(zone.id)
      : [];
    const tasksHTML = zoneTasks.length
      ? zoneTasks.map(t => `
          <div class="zone-task-row ${t.completed ? 'zone-task-done' : ''}">
            <span class="zone-task-check ${t.completed ? 'done' : ''}"></span>
            <span class="zone-task-season">${seasonEmoji(t.season)}</span>
            <span class="zone-task-text">${esc(t.text)}</span>
            ${t.urgent && !t.completed ? '<span class="badge badge-urgent" style="font-size:9px;padding:1px 5px">urgent</span>' : ''}
          </div>`).join('')
      : '<p style="font-size:12px;color:var(--muted)">No tasks tagged to this zone.</p>';

    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <button class="zone-detail-back" id="zone-back-btn">← All zones</button>
        <button class="btn btn-sm btn-outline" id="zone-edit-btn" style="font-size:12px">✏️ Edit info</button>
      </div>
      <div class="result-card">
        <div class="result-name">Zone ${esc(zone.id)} — <span id="zone-detail-name">${esc(zone.name)}</span></div>
        <div class="result-latin">${zone.acres} acres · ${esc(zone.elevation)}</div>

        ${zone.priority_action ? `
          <div class="zone-detail-section">
            <h4>Priority action</h4>
            <div class="action-box ${urgentClass}">${esc(zone.priority_action)}</div>
          </div>` : ''}

        <div class="zone-detail-section">
          <h4>Description</h4>
          <p style="font-size:13px;color:var(--text);line-height:1.6">${esc(zone.description)}</p>
        </div>

        <div class="zone-detail-section">
          <h4>Goals</h4>
          <p style="font-size:13px;color:var(--text);line-height:1.6">${esc(zone.goals)}</p>
        </div>

        <div class="zone-detail-section">
          <h4>Invasives present</h4>
          <ul>${invasivesList}</ul>
        </div>

        <div class="zone-detail-section">
          <h4>Target natives to add</h4>
          <ul>${targetsList}</ul>
        </div>

        <div class="zone-detail-section">
          <h4>Notes</h4>
          <p style="font-size:12px;color:var(--label);line-height:1.6">${esc(zone.notes)}</p>
        </div>

        <div class="zone-detail-section">
          <h4 style="display:flex;justify-content:space-between;align-items:center">
            Tasks for Zone ${esc(zone.id)}
            <button class="btn btn-sm btn-outline" id="zone-add-task-btn" style="font-size:11px;color:var(--green);border-color:var(--green)">＋ Add task</button>
          </h4>
          <div id="zone-tasks-list">${tasksHTML}</div>
        </div>
      </div>`;

    $('zone-back-btn').addEventListener('click', renderGrid);

    $('zone-edit-btn').addEventListener('click', () => openEditSheet(zone));

    const addTaskBtn = $('zone-add-task-btn');
    if (addTaskBtn && window.Tasks) {
      addTaskBtn.addEventListener('click', () => {
        Tasks.openAddTaskSheet({ zone: zone.id });
      });
    }
  }

  /* ── Edit sheet ── */
  function openEditSheet(zone) {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:400;display:flex;align-items:flex-end;';
    modal.innerHTML = `
      <div style="background:var(--cream);border-radius:20px 20px 0 0;padding:20px 16px 40px;width:100%;max-height:85dvh;overflow-y:auto;max-width:480px;margin:0 auto">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <h3 style="font-size:16px">Edit Zone ${esc(zone.id)}</h3>
          <button id="ze-close" style="background:none;border:none;font-size:24px;cursor:pointer;color:var(--muted)">✕</button>
        </div>
        <div class="field">
          <label class="lbl">Zone name</label>
          <input type="text" id="ze-name" value="${esc(zone.name)}" style="width:100%">
        </div>
        <div class="field" style="margin-top:10px">
          <label class="lbl">Description</label>
          <textarea id="ze-desc" rows="3" style="width:100%;resize:vertical">${esc(zone.description)}</textarea>
        </div>
        <div class="field" style="margin-top:10px">
          <label class="lbl">Goals</label>
          <textarea id="ze-goals" rows="3" style="width:100%;resize:vertical">${esc(zone.goals)}</textarea>
        </div>
        <div class="field" style="margin-top:10px">
          <label class="lbl">Notes</label>
          <textarea id="ze-notes" rows="2" style="width:100%;resize:vertical">${esc(zone.notes || '')}</textarea>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:8px">Changes are saved on this device. Zone boundaries and acreage are not editable here.</div>
        <div style="display:flex;gap:8px;margin-top:16px">
          <button class="btn" id="ze-save" type="button">Save</button>
          <button class="btn btn-outline" id="ze-cancel" type="button">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    document.getElementById('ze-close').addEventListener('click', close);
    document.getElementById('ze-cancel').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });

    document.getElementById('ze-save').addEventListener('click', () => {
      const name  = (document.getElementById('ze-name') || {}).value || zone.name;
      const desc  = (document.getElementById('ze-desc') || {}).value || zone.description;
      const goals = (document.getElementById('ze-goals') || {}).value || zone.goals;
      const notes = (document.getElementById('ze-notes') || {}).value || '';
      saveOverride(zone.id, { name, description: desc, goals, notes });
      close();
      // Re-render detail with updated data
      const updatedZone = mergeZone(App.getZones().find(z => z.id === zone.id) || zone);
      renderDetail(updatedZone);
      App.toast(`Zone ${zone.id} info updated ✓`);
    });
  }

  /* ── Helpers ── */
  function seasonEmoji(seasonId) {
    const map = { spring: '🌱', summer: '☀️', fall: '🍂', winter: '❄️' };
    return map[seasonId] || '📋';
  }

  function esc(str) {
    return String(str || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  return { init };
})();
