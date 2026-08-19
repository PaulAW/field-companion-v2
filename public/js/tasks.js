/* tasks.js — Seasonal maintenance checklist: localStorage (offline) + D1 backend (cloud) */

var Tasks = (() => {
  const STORAGE_KEY = 'fc_tasks';      // legacy localStorage completion state
  const BACKEND     = 'https://field-companion-backend.paulwiner5.workers.dev';

  /* _tasks: array of task objects when in cloud mode
     {id, season, text, zone, urgent(bool), completed(bool), sort_order} */
  let _tasks       = [];
  let _cloudMode   = false;
  let _loading     = false;
  let _editingId   = null;   // task id currently in edit mode (null = none)
  let _editLinkCtl = null;   // wireLinkSection() handle for the task currently being edited
  let _viewMode       = localStorage.getItem('fc_tasks_view') || 'season'; // 'season' | 'zone'
  let _openZoneGroups = new Set(JSON.parse(localStorage.getItem('fc_open_zone_groups') || '[]'));
  let _localFallback  = false;  // true when cloud mode intended but the last fetch failed/was empty

  function saveOpenGroups() {
    localStorage.setItem('fc_open_zone_groups', JSON.stringify([..._openZoneGroups]));
  }

  const $ = id => document.getElementById(id);

  function init() {
    App.registerTab('tasks', { onShow });
    onShow();
  }

  let _restoreScrollOnRender = false;

  function onShow() {
    _restoreScrollOnRender = true;   // flag render() to restore scroll after content loads
    const wasCloud = _cloudMode;
    _cloudMode = !!(window.Auth && Auth.isSignedIn());
    if (_cloudMode) {
      loadCloudTasks();
    } else {
      loadLocalTasks();
      render();
    }
  }

  /* ── Auth header helper ── */
  function authHeader() {
    const tok = Auth.getToken ? Auth.getToken() : null;
    return tok ? { Authorization: 'Bearer ' + tok } : {};
  }

  /* ── Cloud mode: fetch from backend ── */
  async function loadCloudTasks() {
    if (_loading) return;
    _loading = true;
    try {
      const res = await fetch(BACKEND + '/tasks', {
        headers: { ...authHeader() },
      });
      if (!res.ok) throw new Error('Tasks fetch failed: ' + res.status);
      const data = await res.json();
      const cloudTasks = (data.tasks || []).map(normaliseCloud);
      // If backend returns 0 tasks, show local static tasks as a display fallback
      // but keep _cloudMode = true so the user can still add/edit tasks via cloud.
      if (cloudTasks.length === 0) {
        console.warn('Tasks: cloud returned 0 tasks, showing local static tasks');
        _localFallback = true;
        loadLocalTasks();   // loads display data only — _cloudMode stays true
      } else {
        _localFallback = false;
        _tasks = cloudTasks;
        _tasks.sort((a, b) => (a.sort_order - b.sort_order) || a.text.localeCompare(b.text));
      }
      render();
    } catch(e) {
      // Network/auth error (including an expired session) — show local tasks for
      // display but keep cloud mode so the UI remains functional when connectivity
      // recovers. This previously failed completely silently — render() now shows
      // a banner whenever _localFallback is true so it's never invisible again.
      console.warn('Tasks cloud load failed, showing local tasks as fallback:', e);
      _localFallback = true;
      loadLocalTasks();   // loads display data only — _cloudMode stays true
      render();
    } finally {
      _loading = false;
    }
  }

  function normaliseCloud(t) {
    return {
      id:               t.id,
      season:           t.season,
      text:             t.text,
      zone:             t.zone || null,
      urgent:           !!(t.urgent === 1 || t.urgent === true),
      completed:        !!(t.completed === 1 || t.completed === true),
      sort_order:       t.sort_order || 0,
      observation_id:   t.observation_id || null,
      observation_name: t.observation_name || null,
      lat:              t.lat || null,
      lng:              t.lng || null,
      no_location:      !!(t.no_location === 1 || t.no_location === true),
      created_at:       t.created_at || null,
      _cloud: true,
    };
  }

  /* ── Local mode: build task list from static JSON + localStorage state ──
     Note: does NOT touch _cloudMode — that is controlled solely by onShow().
     Falling back to local data does not mean the user is signed out.          */
  function loadLocalTasks() {
    let state = {};
    try { state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch {}
    const data = App.getTasks();
    if (!data || !data.seasons) { _tasks = []; return; }
    _tasks = [];
    let order = 0;
    data.seasons.forEach(season => {
      (season.tasks || []).forEach(t => {
        _tasks.push({
          id: t.id, season: season.id, text: t.text,
          zone: t.zone || null, urgent: !!t.urgent,
          completed: !!state[t.id], sort_order: order++,
          _cloud: false,
        });
      });
    });
    // Merge in locally-added custom tasks
    try {
      const custom = JSON.parse(localStorage.getItem('fc_custom_tasks') || '[]');
      custom.forEach(t => {
        _tasks.push({ ...t, completed: !!state[t.id], _cloud: false });
      });
    } catch {}
  }

  /* ── Migrate device-local custom tasks to the cloud on sign-in ──
     Custom tasks added while this device was signed out (or silently in
     local-fallback mode) live only in this browser's localStorage and are
     invisible to cloud mode / the MCP server. Push them to D1 so signing in
     doesn't quietly orphan them. */
  async function migrateLocalTasks() {
    let custom = [];
    try { custom = JSON.parse(localStorage.getItem('fc_custom_tasks') || '[]'); } catch(e) { return; }
    const localOnly = custom.filter(t => String(t.id || '').startsWith('local-'));
    if (localOnly.length === 0) return;

    let state = {};
    try { state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch(e) {}

    let migrated = 0;
    const stillLocal = [];
    for (const t of custom) {
      if (!String(t.id || '').startsWith('local-')) { continue; }
      try {
        const res = await fetch(BACKEND + '/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader() },
          body: JSON.stringify({
            season: t.season, text: t.text, zone: t.zone || null,
            urgent: t.urgent ? 1 : 0, sort_order: t.sort_order || 9000,
            observation_id: t.observation_id || null, observation_name: t.observation_name || null,
            lat: t.lat || null, lng: t.lng || null,
            // Locally-created tasks predate the link requirement — fall back to "general
            // task" on migration rather than getting stuck retrying forever.
            no_location: !(t.observation_id || (t.lat && t.lng)),
          }),
        });
        if (!res.ok) throw new Error(res.status);
        const data = await res.json();
        if (state[t.id]) {
          await fetch(`${BACKEND}/tasks/${encodeURIComponent(data.id)}/toggle`, {
            method: 'POST', headers: { ...authHeader() },
          });
        }
        migrated++;
      } catch(e) {
        console.warn('Task migration failed for', t.id, e);
        stillLocal.push(t); // keep it locally so we retry on next sign-in
      }
    }

    // Drop successfully-migrated tasks from local storage so cloud mode
    // (which never reads fc_custom_tasks) doesn't leave stale duplicates behind.
    const kept = custom.filter(t => !String(t.id || '').startsWith('local-')).concat(stillLocal);
    localStorage.setItem('fc_custom_tasks', JSON.stringify(kept));

    if (migrated > 0) App.toast(`Moved ${migrated} local task${migrated !== 1 ? 's' : ''} to the cloud ✓`);
  }

  function saveLocalCustomTask(task) {
    // Generate a local id if not present
    if (!task.id) task.id = 'local-' + Date.now();
    try {
      const existing = JSON.parse(localStorage.getItem('fc_custom_tasks') || '[]');
      existing.push({ ...task, sort_order: 9000 + existing.length });
      localStorage.setItem('fc_custom_tasks', JSON.stringify(existing));
      // Refresh _tasks
      loadLocalTasks();
      renderSeason(task.season);
    } catch(e) { console.warn('saveLocalCustomTask failed:', e); }
  }

  /* ── Toggle completion ── */
  async function toggleTask(taskId) {
    const task = _tasks.find(t => t.id === taskId);
    if (!task) return;
    task.completed = !task.completed;
    rerenderTask(taskId);
    updateSeasonProgress(task.season);

    if (_cloudMode) {
      try {
        const res = await fetch(`${BACKEND}/tasks/${encodeURIComponent(taskId)}/toggle`, {
          method: 'POST',
          headers: { ...authHeader() },
        });
        if (!res.ok) throw new Error(res.status);
        const data = await res.json();
        task.completed = !!(data.completed === 1 || data.completed === true);
        rerenderTask(taskId);
        updateSeasonProgress(task.season);
      } catch(e) {
        console.warn('Task toggle sync failed:', e);
        // Revert optimistic update
        task.completed = !task.completed;
        rerenderTask(taskId);
        updateSeasonProgress(task.season);
      }
    } else {
      // Save to localStorage
      const state = {};
      _tasks.forEach(t => { if (t.completed) state[t.id] = true; });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
  }

  /* ── Clear season checkmarks ── */
  async function clearSeason(seasonId) {
    const seasonTasks = _tasks.filter(t => t.season === seasonId && t.completed);
    if (seasonTasks.length === 0) { App.toast('No completed tasks to clear'); return; }
    const label = seasonLabel(seasonId);
    if (!confirm(`Clear ${seasonTasks.length} completed task${seasonTasks.length > 1 ? 's' : ''} for ${label}?`)) return;

    seasonTasks.forEach(t => { t.completed = false; });
    renderSeason(seasonId);

    if (_cloudMode) {
      try {
        await Promise.all(seasonTasks.map(t =>
          fetch(`${BACKEND}/tasks/${encodeURIComponent(t.id)}/toggle`, {
            method: 'POST',
            headers: { ...authHeader() },
          })
        ));
      } catch(e) { console.warn('Clear season sync failed:', e); }
    } else {
      const state = {};
      _tasks.forEach(t => { if (t.completed) state[t.id] = true; });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
    App.toast(`${label} tasks reset`);
  }

  /* ── Add task ── */
  async function addTask(seasonId, text, zone, urgent, obsId, obsName, lat, lng, noLocation) {
    text = text.trim();
    if (!text) { App.toast('Enter task text'); return; }

    const now = new Date().toISOString();

    if (_cloudMode) {
      const maxOrder = _tasks.filter(t => t.season === seasonId).reduce((m, t) => Math.max(m, t.sort_order), 0);
      try {
        const res = await fetch(BACKEND + '/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader() },
          body: JSON.stringify({
            season: seasonId, text, zone: zone || null,
            urgent: urgent ? 1 : 0, sort_order: maxOrder + 1,
            observation_id: obsId || null, observation_name: obsName || null,
            lat: lat || null, lng: lng || null, no_location: !!noLocation,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || res.status);
        }
        const data = await res.json();
        _tasks.push(normaliseCloud({
          id: data.id, season: seasonId, text,
          zone: zone || null, urgent: urgent ? 1 : 0, completed: 0,
          sort_order: maxOrder + 1,
          observation_id: obsId || null, observation_name: obsName || null,
          lat: lat || null, lng: lng || null, created_at: now,
        }));
        renderSeason(seasonId);
        App.toast('Task added ✓');
      } catch(e) {
        console.warn('Add task failed:', e);
        App.toast('Failed to add task: ' + e.message);
      }
    } else {
      saveLocalCustomTask({
        id: 'local-' + Date.now(),
        season: seasonId, text, zone: zone || null,
        urgent: !!urgent, sort_order: 9000,
        observation_id: obsId || null, observation_name: obsName || null,
        lat: lat || null, lng: lng || null, no_location: !!noLocation, created_at: now,
      });
      App.toast('Task saved locally ✓');
    }
  }

  /* ── Shared plant/GPS link controls — used by both the Add Task sheet and inline task edit.
     Every manually-created task must resolve to one of: a linked observation, GPS coordinates,
     or an explicit "general task" flag — otherwise it can silently lose all trace of what it
     was about, the way some AI-authored tasks did before this existed. ── */
  function linkSectionHTML(idPrefix, opts) {
    opts = opts || {};
    return `
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
        <label class="lbl">Link to a plant or place</label>
        <div style="font-size:11px;color:var(--muted);margin-bottom:6px">Required, so this task can't lose its location — pick one:</div>
        <input type="text" id="${idPrefix}-obs-search" list="${idPrefix}-obs-list" placeholder="🔗 Search a logged plant…" style="width:100%;margin-bottom:8px">
        <datalist id="${idPrefix}-obs-list"></datalist>
        <button class="btn btn-outline btn-sm" id="${idPrefix}-gps-btn" type="button" style="width:100%;margin-bottom:4px">📍 Capture current GPS</button>
        <div id="${idPrefix}-gps-status" class="gps-status" style="min-height:14px;margin-bottom:8px">${opts.lat && opts.lng ? `✓ ${esc(opts.lat)}, ${esc(opts.lng)}` : ''}</div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
          <input type="checkbox" id="${idPrefix}-no-location" ${opts.noLocation ? 'checked' : ''}> General task — not tied to a specific plant or spot
        </label>
      </div>`;
  }

  function wireLinkSection(idPrefix, opts) {
    opts = opts || {};
    let gpsCoords = (opts.lat && opts.lng) ? { lat: opts.lat, lng: opts.lng } : null;
    let linkedObs = opts.observationId ? { id: opts.observationId, name: opts.observationName } : null;
    const obsMap  = {};

    const gpsBtn      = $(`${idPrefix}-gps-btn`);
    const gpsStatus   = $(`${idPrefix}-gps-status`);
    const searchInput = $(`${idPrefix}-obs-search`);
    const datalist    = $(`${idPrefix}-obs-list`);
    const noLocEl     = $(`${idPrefix}-no-location`);

    if (gpsBtn) gpsBtn.addEventListener('click', () => {
      if (!gpsStatus) return;
      gpsStatus.textContent = '📍 Locating (satellite lock can take up to 12s)…'; gpsStatus.className = 'gps-status';
      App.captureGPS().then(fix => {
        gpsCoords = { lat: fix.lat, lng: fix.lng };
        const weak = fix.accuracy != null && fix.accuracy > App.GPS_ACCURACY_GOOD_M;
        gpsStatus.textContent = weak
          ? `✓ ${fix.lat}, ${fix.lng} (±${Math.round(fix.accuracy)}m — weak signal, consider retrying)`
          : `✓ ${fix.lat}, ${fix.lng}`;
        gpsStatus.className = weak ? 'gps-error' : 'gps-status';
      }).catch(err => {
        gpsCoords = null;
        gpsStatus.textContent = err.message; gpsStatus.className = 'gps-error';
      });
    });

    if (searchInput && datalist) {
      if (opts.observationName) searchInput.value = opts.observationName;
      (window.App && App.getAllObservations ? App.getAllObservations() : Promise.resolve([]))
        .then(obs => {
          obs.slice(0, 150).forEach(o => {
            if (!o.common_name) return;
            const label = `${o.common_name}${o.zone ? ' · Zone ' + o.zone : ''}${o.date ? ' · ' + o.date : ''}`;
            obsMap[label] = o;
            const opt = document.createElement('option');
            opt.value = label;
            datalist.appendChild(opt);
          });
        }).catch(() => {});
      searchInput.addEventListener('input', () => {
        const match = obsMap[searchInput.value];
        linkedObs = match ? { id: match.id, name: `${match.common_name}${match.zone ? ' · Zone ' + match.zone : ''}` } : null;
      });
    }

    return {
      getState() {
        return {
          observation_id:   linkedObs ? linkedObs.id : null,
          observation_name: linkedObs ? linkedObs.name : null,
          lat:              gpsCoords ? gpsCoords.lat : null,
          lng:              gpsCoords ? gpsCoords.lng : null,
          no_location:      noLocEl ? noLocEl.checked : false,
        };
      },
    };
  }

  /* ── Shared "Add Task" sheet — callable from Plant ID, Log, Map ── */
  function openAddTaskSheet(prefill) {
    prefill = prefill || {};
    const defaultSeason  = prefill.season || currentSeasonId();
    const alreadyLinked  = !!prefill.observation_id;
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:400;display:flex;align-items:flex-end;';
    modal.innerHTML = `
      <div style="background:var(--cream);border-radius:20px 20px 0 0;padding:20px 16px 40px;width:100%;max-height:80dvh;overflow-y:auto;max-width:480px;margin:0 auto">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <h3 style="font-size:16px">Add Task</h3>
          <button id="ats-close" style="background:none;border:none;font-size:24px;cursor:pointer;color:var(--muted)">✕</button>
        </div>
        ${alreadyLinked ? `<div style="font-size:11px;background:#f0f4f0;color:var(--green);border-radius:6px;padding:5px 9px;margin-bottom:10px">🔗 Linked to: <strong>${esc(prefill.observation_name)}</strong>${(prefill.lat && prefill.lng) ? ` · 📍 ${esc(prefill.lat)}, ${esc(prefill.lng)}` : ' · <span style="color:var(--red)">⚠️ no GPS on this observation</span>'}</div>` : ''}
        <div class="field">
          <label class="lbl">Task description</label>
          <input type="text" id="ats-text" value="${esc(prefill.text || '')}" placeholder="What needs to be done?" style="width:100%">
        </div>
        <div style="display:flex;gap:10px;margin-top:8px">
          <div class="field" style="flex:1">
            <label class="lbl">Season</label>
            <select id="ats-season" style="width:100%">
              ${SEASONS.map(s => `<option value="${s.id}" ${s.id === defaultSeason ? 'selected' : ''}>${s.emoji} ${s.label}</option>`).join('')}
            </select>
          </div>
          <div class="field" style="flex:1">
            <label class="lbl">Zone</label>
            <select id="ats-zone" style="width:100%">
              <option value="">Any zone</option>
              ${App.getZones().map(z => `<option value="${esc(z.id)}" ${prefill.zone === z.id ? 'selected' : ''}>Zone ${esc(z.id)}</option>`).join('')}
            </select>
          </div>
        </div>
        <label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13px;cursor:pointer">
          <input type="checkbox" id="ats-urgent" ${prefill.urgent ? 'checked' : ''}> Mark as urgent
        </label>
        ${alreadyLinked ? '' : linkSectionHTML('ats')}
        <div style="display:flex;gap:8px;margin-top:16px">
          <button class="btn" id="ats-save" type="button">Save Task</button>
          <button class="btn btn-outline" id="ats-cancel" type="button">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const textInput = document.getElementById('ats-text');
    if (textInput) { textInput.focus(); textInput.select(); }

    const link = alreadyLinked ? null : wireLinkSection('ats', {});

    const close = () => modal.remove();
    document.getElementById('ats-close').addEventListener('click', close);
    document.getElementById('ats-cancel').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });

    document.getElementById('ats-save').addEventListener('click', async () => {
      const text   = (document.getElementById('ats-text') || {}).value || '';
      const season = (document.getElementById('ats-season') || {}).value || currentSeasonId();
      const zone   = (document.getElementById('ats-zone') || {}).value || '';
      const urgent = (document.getElementById('ats-urgent') || {}).checked || false;
      if (!text.trim()) { App.toast('Enter a task description'); return; }

      let obsId = prefill.observation_id || null;
      let obsName = prefill.observation_name || null;
      let lat = prefill.lat || null, lng = prefill.lng || null, noLocation = false;
      if (link) {
        const state = link.getState();
        obsId = state.observation_id;
        obsName = state.observation_name;
        lat = state.lat;
        lng = state.lng;
        noLocation = state.no_location;
        if (!obsId && !(lat && lng) && !noLocation) {
          App.toast('Link this task to a plant, capture GPS, or mark it as a general task');
          return;
        }
      }

      // Duplicate check — same text in same season
      const normalise = s => s.toLowerCase().replace(/\s+/g,' ').trim();
      const dup = _tasks.find(t =>
        t.season === season && normalise(t.text) === normalise(text)
      );
      if (dup) {
        if (!confirm(`A very similar task already exists in ${seasonLabel(season)}:\n\n"${dup.text}"\n\nSave anyway?`)) return;
      }

      await addTask(season, text, zone, urgent, obsId, obsName, lat, lng, noLocation);
      close();
    });
  }

  /* ── Edit task (cloud only) ── */
  function startEdit(taskId) {
    // Close any currently open edit first
    if (_editingId && _editingId !== taskId) {
      const prevTask = _tasks.find(t => t.id === _editingId);
      const prevTextEl = $(`task-edit-text-${_editingId}`);
      const hasUnsaved = prevTextEl && prevTask && prevTextEl.value.trim() !== prevTask.text;
      if (hasUnsaved) {
        if (!confirm('You have unsaved changes on another task. Discard them and edit this one?')) return;
      }
      cancelEdit();
    }
    _editingId = taskId;
    renderTask(taskId);
  }

  /* Public — called from zone detail to open edit on Tasks tab */
  let _pendingEditId = null;
  function openEditFromExternal(taskId) {
    _pendingEditId = taskId;
    App.switchTab('tasks');
    // onShow → loadCloudTasks → render() will pick up _pendingEditId
  }

  function cancelEdit() {
    const prev = _editingId;
    _editingId = null;
    _editLinkCtl = null;
    if (prev) renderTask(prev);
  }

  async function saveEdit(taskId) {
    const task = _tasks.find(t => t.id === taskId);
    if (!task) return;
    const textEl = $(`task-edit-text-${taskId}`);
    const zoneEl = $(`task-edit-zone-${taskId}`);
    const urgEl  = $(`task-edit-urgent-${taskId}`);
    const text = textEl ? textEl.value.trim() : task.text;
    if (!text) { App.toast('Task text cannot be empty'); return; }

    const zone   = zoneEl ? (zoneEl.value || null) : task.zone;
    const urgent = urgEl ? urgEl.checked : task.urgent;
    const link   = _editLinkCtl ? _editLinkCtl.getState() : {
      observation_id: task.observation_id, observation_name: task.observation_name,
      lat: task.lat, lng: task.lng, no_location: task.no_location,
    };

    task.text = text;
    task.zone = zone;
    task.urgent = urgent;
    task.observation_id = link.observation_id;
    task.observation_name = link.observation_name;
    task.lat = link.lat;
    task.lng = link.lng;
    task.no_location = link.no_location;
    _editingId  = null;
    _editLinkCtl = null;
    renderTask(taskId);
    updateSeasonProgress(task.season);

    try {
      const res = await fetch(`${BACKEND}/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({
          text, zone: zone || null, urgent: urgent ? 1 : 0,
          observation_id: link.observation_id || null, observation_name: link.observation_name || null,
          lat: link.lat || null, lng: link.lng || null, no_location: !!link.no_location,
        }),
      });
      if (!res.ok) throw new Error(res.status);
    } catch(e) {
      console.warn('Save edit failed:', e);
      App.toast('Save failed — try again');
    }
  }

  /* ── Delete task (cloud only) ── */
  async function deleteTask(taskId) {
    const task = _tasks.find(t => t.id === taskId);
    if (!task) return;
    if (!confirm(`Delete this task?\n"${task.text}"\nThis cannot be undone.`)) return;

    const seasonId = task.season;
    _tasks = _tasks.filter(t => t.id !== taskId);
    _editingId = null;
    renderSeason(seasonId);

    try {
      const res = await fetch(`${BACKEND}/tasks/${encodeURIComponent(taskId)}`, {
        method: 'DELETE',
        headers: { ...authHeader() },
      });
      if (!res.ok) throw new Error(res.status);
      App.toast('Task deleted');
    } catch(e) {
      console.warn('Delete task failed:', e);
      App.toast('Delete failed — try again');
    }
  }

  /* ── Season helpers ── */
  const SEASONS = [
    { id: 'spring', label: 'Spring', emoji: '🌱', months: 'Apr–May',  open: m => m >= 4 && m <= 5 },
    { id: 'summer', label: 'Summer', emoji: '☀️',  months: 'Jun–Aug',  open: m => m >= 6 && m <= 8 },
    { id: 'fall',   label: 'Fall',   emoji: '🍂', months: 'Sep–Nov',  open: m => m >= 9 && m <= 11 },
    { id: 'winter', label: 'Winter', emoji: '❄️',  months: 'Dec–Mar',  open: m => m <= 3 || m >= 12 },
  ];

  function currentSeasonId() {
    const m = new Date().getMonth() + 1;
    return (SEASONS.find(s => s.open(m)) || SEASONS[0]).id;
  }

  function seasonLabel(seasonId) {
    const s = SEASONS.find(s => s.id === seasonId);
    return s ? s.label : seasonId;
  }

  /* ── Render ── */
  function render() {
    const container = $('tasks-container');
    if (!container) return;

    const fallbackBanner = (_cloudMode && _localFallback) ? `
      <div class="alert alert-warn" style="margin-bottom:10px">
        ⚠️ Showing local tasks only — cloud sync failed or your session expired, so this may not match what's on your other devices.
        <a href="#" id="tasks-resync-link" style="color:inherit;text-decoration:underline;font-weight:600">Retry</a>
      </div>` : '';

    const toggleHTML = `
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:12px">
        <span style="font-size:11px;color:var(--muted);flex-shrink:0">Group by:</span>
        <button class="btn btn-sm tasks-view-toggle ${_viewMode==='season' ? '' : 'btn-outline'}" data-view="season">Season</button>
        <button class="btn btn-sm tasks-view-toggle ${_viewMode==='zone'   ? '' : 'btn-outline'}" data-view="zone">Zone</button>
      </div>`;

    if (_viewMode === 'zone') {
      container.innerHTML = fallbackBanner + toggleHTML + zoneGroupsHTML();
      container.querySelectorAll('.tasks-view-toggle').forEach(btn =>
        btn.addEventListener('click', () => { _viewMode = btn.dataset.view; localStorage.setItem('fc_tasks_view', _viewMode); render(); })
      );
      wireZoneGroupEvents();
    } else {
      const curSeason = currentSeasonId();
      container.innerHTML = fallbackBanner + toggleHTML + SEASONS.map(s => seasonOuterHTML(s, s.id === curSeason)).join('');
      container.querySelectorAll('.tasks-view-toggle').forEach(btn =>
        btn.addEventListener('click', () => { _viewMode = btn.dataset.view; localStorage.setItem('fc_tasks_view', _viewMode); render(); })
      );
      SEASONS.forEach(s => wireSeasonEvents(s.id));
    }

    const resyncLink = $('tasks-resync-link');
    if (resyncLink) resyncLink.addEventListener('click', e => { e.preventDefault(); onShow(); });

    // Restore scroll position when returning to this tab after async cloud load
    if (_restoreScrollOnRender) {
      _restoreScrollOnRender = false;
      const screensEl = document.getElementById('screens');
      const saved = App.getTabScroll ? App.getTabScroll('tasks') : 0;
      if (screensEl && saved) setTimeout(() => { screensEl.scrollTop = saved; }, 60);
    }

    // Apply any pending external edit request (e.g. from Zone detail)
    if (_pendingEditId) {
      const id = _pendingEditId;
      _pendingEditId = null;
      setTimeout(() => {
        startEdit(id);
        // Scroll the opened edit row into view
        setTimeout(() => {
          const row = document.getElementById(`task-row-${id}`);
          if (row) row.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 50);
      }, 80);
    }
  }

  /* ── Zone group view ── */
  function zoneGroupsHTML() {
    const allZones   = App.getZones();
    const zoneIds    = [...new Set(_tasks.map(t => t.zone || ''))].sort();
    // Build ordered list: known zones first (in A-B-C order), then '' last
    const knownIds   = allZones.map(z => z.id);
    const ordered    = [
      ...knownIds.filter(id => zoneIds.includes(id)),
      ...zoneIds.filter(id => id && !knownIds.includes(id)),
    ];
    if (zoneIds.includes('')) ordered.push('');

    if (ordered.length === 0) return '<p style="color:var(--muted);font-size:13px">No tasks yet.</p>';

    // First-time: open first group by default if nothing saved
    if (_openZoneGroups.size === 0 && ordered.length > 0) {
      _openZoneGroups.add(ordered[0] || '__none__');
      saveOpenGroups();
    }
    return ordered.map(zId => zoneGroupHTML(zId, allZones)).join('');
  }

  function zoneGroupHTML(zoneId, allZones) {
    const isOpen = _openZoneGroups.has(zoneId || '__none__');
    const zone    = allZones.find(z => z.id === zoneId);
    const label   = zoneId ? `Zone ${zoneId}${zone ? ' — ' + zone.name : ''}` : 'Any Zone';
    const tasks   = zoneId
      ? _tasks.filter(t => t.zone && t.zone.split(',').map(s => s.trim()).includes(zoneId))
      : _tasks.filter(t => !t.zone);
    const total   = tasks.length;
    const done    = tasks.filter(t => t.completed).length;
    const urgent  = tasks.filter(t => t.urgent && !t.completed).length;
    const groupId = zoneId || '__none__';

    return `<div class="season-block" id="zgroup-block-${groupId}">
      <div class="season-header ${isOpen ? 'open' : ''}" id="zgroup-hd-${groupId}">
        <div style="flex:1;min-width:0">
          <div class="season-title" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(label)}</div>
          ${urgent > 0 ? `<span class="badge badge-urgent">${urgent} urgent</span>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
          ${zoneId ? `<button class="btn btn-sm btn-outline" data-zgroup-zones="${esc(zoneId)}" style="font-size:10px;padding:2px 7px">Detail</button>` : ''}
          ${zoneId ? `<button class="btn btn-sm btn-outline" data-zgroup-map="${esc(zoneId)}" style="font-size:10px;padding:2px 7px">📍 Map</button>` : ''}
          <span class="season-progress" id="zgroup-prog-${groupId}">${done}/${total}</span>
          <span class="season-chevron">▶</span>
        </div>
      </div>
      <div class="progress-bar" style="${isOpen ? '' : 'display:none'}" id="zgroup-progbar-${groupId}">
        <div class="progress-fill" style="width:${total ? Math.round(done/total*100) : 0}%"></div>
      </div>
      <div class="season-body ${isOpen ? 'open' : ''}" id="zgroup-body-${groupId}">
        <div id="zgroup-tasks-${groupId}">
          ${tasks.map(t => taskItemHTML(t)).join('')}
        </div>
        ${total === 0 ? '<p style="font-size:12px;color:var(--muted);padding:4px 0">No tasks for this zone.</p>' : ''}
      </div>
    </div>`;
  }

  function wireZoneGroupEvents() {
    document.querySelectorAll('[id^="zgroup-hd-"]').forEach(hd => {
      const groupId = hd.id.replace('zgroup-hd-', '');
      const body    = $(`zgroup-body-${groupId}`);
      const prog    = $(`zgroup-progbar-${groupId}`);
      if (!body) return;
      // Collapse/expand on header click (but not on buttons)
      hd.addEventListener('click', e => {
        if (e.target.closest('button')) return;
        const isOpen = body.classList.contains('open');
        body.classList.toggle('open', !isOpen);
        hd.classList.toggle('open', !isOpen);
        if (prog) prog.style.display = isOpen ? 'none' : '';
        // Persist open/closed state
        const gId = groupId === '__none__' ? '__none__' : groupId;
        if (isOpen) _openZoneGroups.delete(gId); else _openZoneGroups.add(gId);
        saveOpenGroups();
      });
      // Wire task rows
      const taskList = $(`zgroup-tasks-${groupId}`);
      if (taskList) taskList.querySelectorAll('.task-item[data-task-id]').forEach(row => wireTaskEvents(row));
    });

    // Zone detail buttons
    document.querySelectorAll('[data-zgroup-zones]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const zId = btn.dataset.zgroupZones;
        if (window.Zones && Zones.showZone) Zones.showZone(zId);
      });
    });

    // Map buttons
    document.querySelectorAll('[data-zgroup-map]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const zId = btn.dataset.zgroupMap;
        if (window.PropertyMap && PropertyMap.flyToZone) PropertyMap.flyToZone(zId);
      });
    });
  }

  function seasonOuterHTML(s, isOpen) {
    const tasks     = _tasks.filter(t => t.season === s.id);
    const total     = tasks.length;
    const done      = tasks.filter(t => t.completed).length;
    const pct       = total ? Math.round((done / total) * 100) : 0;
    const urgent    = tasks.filter(t => t.urgent && !t.completed).length;

    return `<div class="season-block" id="season-block-${s.id}">
      <div class="season-header ${isOpen ? 'open' : ''}" id="season-hd-${s.id}">
        <div>
          <div class="season-title">${s.emoji} ${s.label} <span style="font-size:11px;font-weight:400;color:var(--muted)">${s.months}</span></div>
          ${urgent > 0 ? `<span class="badge badge-urgent">${urgent} urgent</span>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="season-progress" id="season-prog-count-${s.id}">${done}/${total}</span>
          <span class="season-chevron">▶</span>
        </div>
      </div>
      <div class="progress-bar" style="${isOpen ? '' : 'display:none'}" id="season-prog-${s.id}">
        <div class="progress-fill" style="width:${pct}%"></div>
      </div>
      <div class="season-body ${isOpen ? 'open' : ''}" id="season-body-${s.id}">
        <div id="season-tasks-${s.id}">
          ${tasks.map(t => taskItemHTML(t)).join('')}
        </div>
        ${addTaskFormHTML(s.id)}
        <div class="season-footer">
          <button class="btn btn-outline btn-sm" id="season-clear-${s.id}">Clear ${s.label} checkmarks</button>
        </div>
      </div>
    </div>`;
  }

  function addTaskFormHTML(seasonId) {
    if (!_cloudMode) return '';
    // Opens the shared Add Task sheet (openAddTaskSheet) rather than duplicating the
    // text/zone/urgent fields here — that sheet is also where the required plant/GPS
    // link or "general task" flag lives, so there's one place enforcing that rule.
    return `<div class="add-task-row" id="add-task-row-${seasonId}">
      <button class="btn btn-sm btn-outline add-task-btn" id="add-task-btn-${seasonId}" type="button" style="font-size:12px">+ Add task</button>
    </div>`;
  }

  function taskItemHTML(task) {
    if (_editingId === task.id) return taskEditHTML(task);
    const done = task.completed;
    // A "linked" plant reference is only useful if it can actually resolve to something —
    // an observation_name with no id and no coordinates is a leftover label with nothing
    // behind it (some older AI-authored tasks are like this) and must not render as if
    // it were clickable.
    const hasObsId = !!(task.observation_name && task.observation_id);
    const hasGps = !!(task.lat && task.lng);
    const nameOnly = !!task.observation_name && !hasObsId && !hasGps;
    const obsLink = hasObsId
      ? `<div class="task-obs-link" data-fly-obs="${task.observation_id}" style="font-size:10px;color:var(--green);margin-top:1px;cursor:pointer;display:inline-flex;align-items:center;gap:3px">🔗 ${esc(task.observation_name)} <span style="opacity:0.6;font-size:9px">📍</span></div>`
      : (hasGps
        ? `<div class="task-obs-link" data-fly-coords="${esc(task.lat)},${esc(task.lng)}" style="font-size:10px;color:var(--green);margin-top:1px;cursor:pointer;display:inline-flex;align-items:center;gap:3px">📍 ${task.observation_name ? esc(task.observation_name) + ' · ' : ''}${esc(task.lat)}, ${esc(task.lng)}</div>`
        : (nameOnly
          ? `<span style="font-size:10px;color:var(--muted);margin-top:1px;display:inline-flex;align-items:center;gap:3px" title="No plant record or GPS was ever saved for this task">${esc(task.observation_name)} <span style="opacity:0.7">(no location saved)</span></span>`
          : ''));
    // Seeded checklist items (no created_at/lat/lng, no observation) predate this requirement
    // and are intentionally general — only flag tasks added after that had no location option offered.
    const unlinkedBadge = (!hasObsId && !hasGps && !task.no_location && task.created_at)
      ? `<span style="font-size:9px;color:var(--red);border:1px solid var(--red);border-radius:4px;padding:1px 4px;margin-left:4px" title="No linked plant or GPS location">⚠️ unlinked</span>`
      : '';
    const dateLabel = task.created_at
      ? `<span style="color:var(--muted);font-size:10px"> · ${formatTaskDate(task.created_at)}</span>`
      : '';
    return `<div class="task-item" id="task-row-${task.id}" data-task-id="${task.id}">
      <div class="task-check ${done ? 'done' : ''}"></div>
      <div class="task-text ${done ? 'done' : ''} ${task.urgent && !done ? 'task-urgent' : ''}" style="flex:1">
        ${esc(task.text)}
        ${task.zone ? `<span style="color:var(--muted);font-size:10px"> · Zone ${esc(task.zone)}</span>` : ''}
        ${dateLabel}
        ${unlinkedBadge}
        ${obsLink}
      </div>
      ${_cloudMode ? `<button class="task-edit-btn" data-edit="${task.id}" type="button" title="Edit task" style="background:none;border:none;cursor:pointer;font-size:13px;padding:2px 5px;color:var(--muted)">✏️</button>` : ''}
    </div>`;
  }

  function taskEditHTML(task) {
    const zones = App.getZones();
    return `<div class="task-item task-item-editing" id="task-row-${task.id}" data-task-id="${task.id}">
      <div style="flex:1">
        <input type="text" id="task-edit-text-${task.id}" value="${esc(task.text)}" style="width:100%;margin-bottom:6px">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
          <select id="task-edit-zone-${task.id}" style="font-size:12px;max-width:150px">
            <option value="">Any zone</option>
            ${zones.map(z => `<option value="${esc(z.id)}" ${task.zone === z.id ? 'selected' : ''}>Zone ${esc(z.id)} – ${esc(z.name)}</option>`).join('')}
          </select>
          <label style="font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer">
            <input type="checkbox" id="task-edit-urgent-${task.id}" ${task.urgent ? 'checked' : ''}> Urgent
          </label>
        </div>
        ${linkSectionHTML(`task-edit-${task.id}`, { lat: task.lat, lng: task.lng, noLocation: task.no_location })}
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn btn-sm" data-save-edit="${task.id}" type="button">Save</button>
          <button class="btn btn-sm btn-outline" data-cancel-edit="${task.id}" type="button">Cancel</button>
          <button class="btn btn-sm btn-outline" data-delete-task="${task.id}" type="button" style="color:#e53935;border-color:#e53935;margin-left:auto">Delete</button>
        </div>
      </div>
    </div>`;
  }

  /* ── Re-render helpers ── */
  function renderTask(taskId) {
    const task = _tasks.find(t => t.id === taskId);
    if (!task) return;
    const row = $(`task-row-${taskId}`);
    if (!row) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = taskItemHTML(task);
    const newRow = tmp.firstElementChild;
    row.replaceWith(newRow);
    wireTaskEvents(newRow);
    if (_editingId === taskId) {
      _editLinkCtl = wireLinkSection(`task-edit-${taskId}`, {
        lat: task.lat, lng: task.lng,
        observationId: task.observation_id, observationName: task.observation_name,
      });
    }
  }

  function rerenderTask(taskId) {
    renderTask(taskId);
  }

  function renderSeason(seasonId) {
    const block = $(`season-block-${seasonId}`);
    if (!block) { render(); return; }
    const s      = SEASONS.find(s => s.id === seasonId);
    if (!s) return;
    const isOpen = block.querySelector('.season-body').classList.contains('open');
    const tmp    = document.createElement('div');
    tmp.innerHTML = seasonOuterHTML(s, isOpen);
    const newBlock = tmp.firstElementChild;
    block.replaceWith(newBlock);
    wireSeasonEvents(seasonId);
  }

  function wireTaskEvents(row) {
    if (!row) return;
    const taskId = row.dataset.taskId;
    if (!taskId) return;
    // Toggle on click (but not on buttons/links)
    row.addEventListener('click', e => {
      if (e.target.closest('[data-edit]') || e.target.closest('[data-save-edit]') ||
          e.target.closest('[data-cancel-edit]') || e.target.closest('[data-delete-task]') ||
          e.target.closest('.task-obs-link') ||
          e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON') return;
      toggleTask(taskId);
    });
    const editBtn = row.querySelector('[data-edit]');
    if (editBtn) editBtn.addEventListener('click', e => { e.stopPropagation(); startEdit(editBtn.dataset.edit); });
    const saveBtn = row.querySelector('[data-save-edit]');
    if (saveBtn) saveBtn.addEventListener('click', e => { e.stopPropagation(); saveEdit(saveBtn.dataset.saveEdit); });
    const cancelBtn = row.querySelector('[data-cancel-edit]');
    if (cancelBtn) cancelBtn.addEventListener('click', e => { e.stopPropagation(); cancelEdit(); });
    const delBtn = row.querySelector('[data-delete-task]');
    if (delBtn) delBtn.addEventListener('click', e => { e.stopPropagation(); deleteTask(delBtn.dataset.deleteTask); });
    // Observation link → fly to plant pin on Map tab
    const obsLink = row.querySelector('.task-obs-link[data-fly-obs]');
    if (obsLink) obsLink.addEventListener('click', e => {
      e.stopPropagation();
      const obsId = parseInt(obsLink.dataset.flyObs);
      if (obsId && window.PropertyMap && PropertyMap.flyToObs) PropertyMap.flyToObs(obsId);
    });
    // GPS-only link (no observation record) → fly to the raw coordinates
    const coordsLink = row.querySelector('.task-obs-link[data-fly-coords]');
    if (coordsLink) coordsLink.addEventListener('click', e => {
      e.stopPropagation();
      const [lat, lng] = (coordsLink.dataset.flyCoords || '').split(',').map(parseFloat);
      if (!isNaN(lat) && !isNaN(lng) && window.PropertyMap && PropertyMap.flyToCoords) {
        PropertyMap.flyToCoords(lat, lng);
      }
    });
  }

  function wireSeasonEvents(seasonId) {
    const header = $(`season-hd-${seasonId}`);
    const body   = $(`season-body-${seasonId}`);
    const prog   = $(`season-prog-${seasonId}`);
    if (header) {
      header.addEventListener('click', () => {
        const isOpen = body.classList.contains('open');
        body.classList.toggle('open', !isOpen);
        header.classList.toggle('open', !isOpen);
        if (prog) prog.style.display = isOpen ? 'none' : '';
      });
    }

    // Wire existing task rows
    const taskList = $(`season-tasks-${seasonId}`);
    if (taskList) {
      taskList.querySelectorAll('.task-item[data-task-id]').forEach(row => wireTaskEvents(row));
    }

    // Clear button
    const clearBtn = $(`season-clear-${seasonId}`);
    if (clearBtn) clearBtn.addEventListener('click', e => { e.stopPropagation(); clearSeason(seasonId); });

    // Add task button → shared Add Task sheet (carries the plant/GPS link requirement)
    if (_cloudMode) {
      const addBtn = $(`add-task-btn-${seasonId}`);
      if (addBtn) addBtn.addEventListener('click', e => {
        e.stopPropagation();
        openAddTaskSheet({ season: seasonId });
      });
    }
  }

  function updateSeasonProgress(seasonId) {
    const tasks = _tasks.filter(t => t.season === seasonId);
    const done  = tasks.filter(t => t.completed).length;
    const pct   = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
    const bar   = $(`season-prog-${seasonId}`);
    if (bar) bar.querySelector('.progress-fill').style.width = pct + '%';
    const cnt = $(`season-prog-count-${seasonId}`);
    if (cnt) cnt.textContent = `${done}/${tasks.length}`;
  }

  function formatTaskDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function esc(str) {
    return String(str || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function getTasksForZone(zoneId) {
    return _tasks.filter(t => t.zone && t.zone.split(',').map(z => z.trim()).includes(zoneId));
  }

  return { init, openAddTaskSheet, getTasksForZone, openEditFromExternal, migrateLocalTasks, refresh: onShow };
})();
