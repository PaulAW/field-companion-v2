/* logger.js — Manual observation entry, history view, CSV export */

var Logger = (() => {
  let _mode = 'history';   // 'new' | 'history' | 'export'
  let _gpsCoords = null;
  let _observations = [];
  let _filterZone = '';
  let _editingId = null;   // non-null when editing an existing observation
  let _showArchived = false;  // toggle to show removed/archived observations

  const $ = id => document.getElementById(id);

  function init() {
    App.registerTab('log', { onShow });
    setupSubtabs();
    setupForm();
    setupGPS();
    setupExport();
  }

  function onShow() {
    if (_mode === 'history') loadHistory();
    if (_mode === 'new') resetForm();
  }

  /* ── Sub-tab switching ── */
  function setupSubtabs() {
    document.querySelectorAll('.log-subtab').forEach(btn => {
      btn.addEventListener('click', () => {
        _mode = btn.dataset.mode;
        document.querySelectorAll('.log-subtab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        $('log-panel-new').style.display     = _mode === 'new'     ? 'block' : 'none';
        $('log-panel-history').style.display  = _mode === 'history'  ? 'block' : 'none';
        $('log-panel-export').style.display   = _mode === 'export'   ? 'block' : 'none';
        if (_mode === 'history') loadHistory();
        if (_mode === 'new' && !_editingId) resetForm();
      });
    });
  }

  function switchToNewEntry() {
    _mode = 'new';
    document.querySelectorAll('.log-subtab').forEach(b => b.classList.remove('active'));
    const newBtn = document.querySelector('.log-subtab[data-mode="new"]');
    if (newBtn) newBtn.classList.add('active');
    $('log-panel-new').style.display    = 'block';
    $('log-panel-history').style.display = 'none';
    $('log-panel-export').style.display  = 'none';
  }

  /* ── Zone dropdown (shared helper) ── */
  function populateZoneSelect(selectId) {
    const sel = $(selectId);
    if (!sel) return;
    const zones = App.getZones();
    sel.innerHTML = '<option value="">— select zone —</option>';
    zones.forEach(z => {
      const opt = document.createElement('option');
      opt.value = z.id;
      opt.textContent = `Zone ${z.id} – ${z.name}`;
      sel.appendChild(opt);
    });
  }

  /* ── New observation form ── */
  function setupForm() {
    populateZoneSelect('log-zone');
    populateZoneSelect('log-history-zone-filter');

    $('log-date').value = App.todayISO();

    $('log-save-btn').addEventListener('click', handleSave);

    const cancelLink = $('log-edit-cancel');
    if (cancelLink) cancelLink.addEventListener('click', () => {
      _editingId = null;
      resetForm();
    });
  }

  function resetForm() {
    $('log-date').value = App.todayISO();
    $('log-zone').value = '';
    $('log-gps-status').textContent = '';
    $('log-gps-status').className = 'gps-status';
    _gpsCoords = null;
    const fallback = $('log-gps-fallback');
    if (fallback) fallback.style.display = 'none';
    const refine = $('log-gps-refine');
    if (refine) refine.style.display = 'none';
    ['log-location-desc','log-common-name','log-latin-name','log-action-needed','log-notes']
      .forEach(id => { if ($(id)) $(id).value = ''; });
    ['log-native-status','log-keystone','log-obs-type'].forEach(id => {
      if ($(id)) $(id).value = $(id).options[0].value;
    });

    // Restore form to "new" state
    _editingId = null;
    const title = $('log-form-title');
    if (title) title.textContent = 'New observation';
    const cancelLink = $('log-edit-cancel');
    if (cancelLink) cancelLink.style.display = 'none';
    const dupBanner = $('log-duplicate-banner');
    if (dupBanner) dupBanner.style.display = 'none';
    const saveBtn = $('log-save-btn');
    if (saveBtn) saveBtn.textContent = '💾 Save observation';
  }

  /* ── GPS ── */
  function setupGPS() {
    const btn = $('log-gps-btn');
    if (btn) btn.addEventListener('click', captureGPS);

    const pickBtn   = $('log-pick-on-map');
    if (pickBtn) pickBtn.addEventListener('click', openMapPicker);

    const refineLink = $('log-refine-map');
    if (refineLink) refineLink.addEventListener('click', openMapPicker);
  }

  function openMapPicker() {
    if (window.MapPicker) {
      const ctx = App.getPropertyCtx();
      const center = ctx.map_center || {};
      MapPicker.open({
        lat:  _gpsCoords ? _gpsCoords.lat : (center.lat || 41.0686),
        lng:  _gpsCoords ? _gpsCoords.lng : (center.lng || -91.9694),
        zone: $('log-zone').value || null,
        onSelect: coords => setGPSCoords(coords),
      });
    }
  }

  function setGPSCoords(coords) {
    _gpsCoords = coords;
    const status = $('log-gps-status');
    if (status) { status.textContent = `✓ ${coords.lat}, ${coords.lng}`; status.className = 'gps-status'; }
    const fallback = $('log-gps-fallback');
    if (fallback) fallback.style.display = 'none';
    const refine = $('log-gps-refine');
    if (refine) refine.style.display = 'block';
  }

  function captureGPS() {
    const status   = $('log-gps-status');
    const fallback = $('log-gps-fallback');
    const refine   = $('log-gps-refine');
    if (status)   { status.textContent = '📍 Locating...'; status.className = 'gps-status'; }
    if (fallback) fallback.style.display = 'none';
    if (refine)   refine.style.display   = 'none';

    if (!navigator.geolocation) {
      if (status)   { status.textContent = 'GPS not available'; status.className = 'gps-error'; }
      if (fallback) fallback.style.display = 'block';
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => setGPSCoords({ lat: pos.coords.latitude.toFixed(6), lng: pos.coords.longitude.toFixed(6) }),
      () => {
        _gpsCoords = null;
        if (status)   { status.textContent = 'GPS unavailable'; status.className = 'gps-error'; }
        if (fallback) fallback.style.display = 'block';
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  /* ── Save ── */
  async function handleSave() {
    const commonName = $('log-common-name').value.trim();
    const zone       = $('log-zone').value;
    if (!commonName) { App.toast('Enter at least a common name'); return; }
    if (!zone)       { App.toast('Select a zone'); return; }

    const obs = {
      date:             $('log-date').value || App.todayISO(),
      zone,
      lat:              _gpsCoords?.lat || '',
      lng:              _gpsCoords?.lng || '',
      location_desc:    $('log-location-desc').value.trim(),
      common_name:      commonName,
      latin_name:       $('log-latin-name').value.trim(),
      native_status:    $('log-native-status').value,
      keystone:         $('log-keystone').value,
      observation_type: $('log-obs-type').value,
      action_needed:    $('log-action-needed').value.trim(),
      notes:            $('log-notes').value.trim(),
      ai_identified:    false,
    };

    try {
      if (_editingId) {
        const savedId = _editingId;
        await App.updateObservation(savedId, obs);
        App.toast('Observation updated ✓');
        resetForm();
        // Switch to History and scroll to the updated entry
        _mode = 'history';
        document.querySelectorAll('.log-subtab').forEach(b => b.classList.remove('active'));
        const histBtn = document.querySelector('.log-subtab[data-mode="history"]');
        if (histBtn) histBtn.classList.add('active');
        $('log-panel-new').style.display     = 'none';
        $('log-panel-history').style.display = 'block';
        $('log-panel-export').style.display  = 'none';
        await loadHistory();
        setTimeout(() => {
          const el = document.querySelector(`.history-item[data-obs-id="${savedId}"]`);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.style.outline = '2px solid var(--green)';
            setTimeout(() => { el.style.outline = ''; }, 2000);
          }
        }, 150);
      } else {
        await App.saveObservation(obs);
        App.toast('Observation saved ✓');
        resetForm();
      }
    } catch (err) {
      App.toast('Save failed: ' + err.message);
    }
  }

  /* ── Edit observation ── */
  function editObservation(obs) {
    App.switchTab('log');
    switchToNewEntry();

    _editingId = obs.id;

    // Pre-populate fields
    $('log-date').value = obs.date || App.todayISO();
    $('log-zone').value = obs.zone || '';
    $('log-location-desc').value = obs.location_desc || '';
    $('log-common-name').value   = obs.common_name   || '';
    $('log-latin-name').value    = obs.latin_name     || '';
    $('log-native-status').value = obs.native_status  || 'Unknown';
    $('log-keystone').value      = obs.keystone       || 'No';
    $('log-obs-type').value      = obs.observation_type || 'Observation';
    $('log-action-needed').value = obs.action_needed  || '';
    $('log-notes').value         = obs.notes          || '';

    // GPS
    if (obs.lat && obs.lng) {
      _gpsCoords = { lat: obs.lat, lng: obs.lng };
      const status = $('log-gps-status');
      if (status) { status.textContent = `✓ ${obs.lat}, ${obs.lng}`; status.className = 'gps-status'; }
      const refine = $('log-gps-refine');
      if (refine) refine.style.display = 'block';
    } else {
      _gpsCoords = null;
      const status = $('log-gps-status');
      if (status) { status.textContent = ''; status.className = 'gps-status'; }
    }

    // Update form chrome
    const title = $('log-form-title');
    if (title) title.textContent = `Editing observation from ${App.formatDate(obs.date)}`;
    const cancelLink = $('log-edit-cancel');
    if (cancelLink) cancelLink.style.display = 'inline';
    const dupBanner = $('log-duplicate-banner');
    if (dupBanner) dupBanner.style.display = 'none';
    const saveBtn = $('log-save-btn');
    if (saveBtn) saveBtn.textContent = '💾 Save changes';
  }

  /* ── Duplicate observation ── */
  function duplicateObservation(obs) {
    App.switchTab('log');
    switchToNewEntry();

    _editingId = null;

    // Pre-populate all fields except date and GPS
    $('log-date').value          = App.todayISO();
    $('log-zone').value          = obs.zone || '';
    $('log-location-desc').value = obs.location_desc || '';
    $('log-common-name').value   = obs.common_name   || '';
    $('log-latin-name').value    = obs.latin_name     || '';
    $('log-native-status').value = obs.native_status  || 'Unknown';
    $('log-keystone').value      = obs.keystone       || 'No';
    $('log-obs-type').value      = obs.observation_type || 'Observation';
    $('log-action-needed').value = obs.action_needed  || '';
    $('log-notes').value         = obs.notes          || '';

    // Clear GPS
    _gpsCoords = null;
    const status = $('log-gps-status');
    if (status) { status.textContent = 'No GPS — capture or pick on map'; status.className = 'gps-status'; }
    const fallback = $('log-gps-fallback');
    if (fallback) fallback.style.display = 'none';
    const refine = $('log-gps-refine');
    if (refine) refine.style.display = 'none';

    // Restore form title to normal
    const title = $('log-form-title');
    if (title) title.textContent = 'New observation';
    const cancelLink = $('log-edit-cancel');
    if (cancelLink) cancelLink.style.display = 'none';

    // Show duplicate banner
    const dupBanner = $('log-duplicate-banner');
    if (dupBanner) {
      dupBanner.textContent = `Duplicated from ${App.formatDate(obs.date)} — update location before saving`;
      dupBanner.style.display = 'block';
    }
    const saveBtn = $('log-save-btn');
    if (saveBtn) saveBtn.textContent = '💾 Save observation';
  }

  /* ── History ── */
  async function loadHistory() {
    const container = $('log-history-list');
    if (!container) return;

    renderSyncStatus();
    renderArchiveToggle();

    try {
      const zone = ($('log-history-zone-filter') || {}).value || '';
      const all = zone
        ? await App.getObservationsByZone(zone)
        : await App.getAllObservations();

      // Split into active and archived
      _observations = _showArchived
        ? all.filter(o => o.removed)
        : all.filter(o => !o.removed);

      if (_observations.length === 0) {
        container.innerHTML = _showArchived
          ? `<div class="empty-state"><span class="ico">📦</span>No archived observations.</div>`
          : `<div class="empty-state"><span class="ico">📋</span>No observations yet.<br>Use Plant ID or the New Entry form to log plants.</div>`;
        return;
      }

      container.innerHTML = _observations.map(obs => historyItemHTML(obs)).join('');

      container.querySelectorAll('.history-item').forEach((el, i) => {
        el.addEventListener('click', () => showObsDetail(_observations[i]));
      });

    } catch (err) {
      container.innerHTML = `<div class="alert alert-error">Error loading history: ${err.message}</div>`;
    }
  }

  function renderArchiveToggle() {
    let toggleEl = $('log-archive-toggle');
    if (!toggleEl) {
      toggleEl = document.createElement('div');
      toggleEl.id = 'log-archive-toggle';
      toggleEl.style.cssText = 'margin-bottom:10px;text-align:right';
      const historyList = $('log-history-list');
      if (historyList && historyList.parentNode) {
        historyList.parentNode.insertBefore(toggleEl, historyList);
      }
    }
    toggleEl.innerHTML = `<button type="button" class="btn btn-sm btn-outline" id="log-archive-btn" style="font-size:11px;${_showArchived ? 'background:var(--amber);color:#fff;border-color:var(--amber)' : ''}">
      ${_showArchived ? '← Active entries' : '📦 Show archived'}
    </button>`;
    const btn = $('log-archive-btn');
    if (btn) btn.addEventListener('click', () => {
      _showArchived = !_showArchived;
      loadHistory();
    });
  }

  /* A-3: render sync status row */
  async function renderSyncStatus() {
    const el = $('log-sync-status');
    if (!el) return;
    if (!window.Auth || !Auth.isSignedIn()) {
      el.style.display = 'none';
      return;
    }
    try {
      const pending = await App.getPendingSyncCount();
      if (pending === 0) {
        el.style.cssText = 'display:block;font-size:12px;padding:6px 10px;border-radius:6px;color:#2e7d32;background:#e8f5e9;cursor:default';
        el.textContent = '✓ All synced';
      } else {
        el.style.cssText = 'display:block;font-size:12px;padding:6px 10px;border-radius:6px;color:#e65100;background:#fff3e0;cursor:pointer';
        el.textContent = `⚠ ${pending} pending sync — tap to sync`;
        el.onclick = async () => {
          el.textContent = 'Syncing…';
          try {
            await Sync.push();
          } catch(e) { /* ignore */ }
          renderSyncStatus();
        };
      }
    } catch(e) {
      el.style.display = 'none';
    }
  }

  function historyItemHTML(obs) {
    const badgeMap = {
      'Native':      'badge-native',
      'Invasive':    'badge-invasive',
      'Non-native':  'badge-nonnative',
      'Naturalized': 'badge-naturalized',
      'Unknown':     'badge-zone',
    };
    const badgeCls = badgeMap[obs.native_status] || 'badge-zone';
    const keystone = obs.keystone === 'Yes' ? '<span class="badge badge-keystone">⭐ Keystone</span>' : '';
    const archivedStyle = obs.removed ? 'opacity:0.6' : '';
    const nameStyle     = obs.removed ? 'text-decoration:line-through' : '';
    const removedBadge  = obs.removed
      ? `<span class="badge" style="background:#78909c;color:#fff">📦 Removed ${obs.removed_on ? App.formatDate(obs.removed_on) : ''}</span>`
      : '';
    return `
      <div class="history-item" data-obs-id="${obs.id}" style="${archivedStyle}">
        <div class="hist-date">${App.formatDate(obs.date)} · Zone ${obs.zone}${obs.lat ? ` · ${obs.lat}, ${obs.lng}` : ''}</div>
        <div class="hist-name" style="${nameStyle}">${esc(obs.common_name)}</div>
        <div class="hist-meta">
          <span class="badge ${badgeCls}">${esc(obs.native_status || 'Unknown')}</span>
          ${keystone}
          ${removedBadge}
          <span class="badge badge-zone">Zone ${esc(obs.zone)}</span>
          ${obs.ai_identified ? '<span class="badge" style="background:#e8e0f8;color:#4a3a8a">🤖 AI</span>' : ''}
        </div>
        ${obs.action_needed && !obs.removed ? `<div class="hist-action">→ ${esc(obs.action_needed)}</div>` : ''}
      </div>`;
  }

  function showObsDetail(obs) {
    const csvRow = App.obsToCSVRow(obs);
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:300;display:flex;align-items:flex-end;';
    modal.innerHTML = `
      <div style="background:var(--cream);border-radius:20px 20px 0 0;padding:20px 16px 40px;width:100%;max-height:85dvh;overflow-y:auto;max-width:480px;margin:0 auto">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <h3 style="font-size:16px">${esc(obs.common_name)}</h3>
          <button id="obs-detail-close" style="background:none;border:none;font-size:24px;cursor:pointer;color:var(--muted)">✕</button>
        </div>
        <div class="card" style="margin-bottom:10px">
          <div class="lbl">Details</div>
          <div style="font-size:12px;line-height:1.8;color:var(--text)">
            <div><strong>Date:</strong> ${App.formatDate(obs.date)}</div>
            <div><strong>Zone:</strong> ${obs.zone}</div>
            ${obs.lat ? `<div><strong>GPS:</strong> ${obs.lat}, ${obs.lng}</div>` : ''}
            ${obs.location_desc ? `<div><strong>Location:</strong> ${esc(obs.location_desc)}</div>` : ''}
            ${obs.latin_name ? `<div><strong>Latin:</strong> <em>${esc(obs.latin_name)}</em></div>` : ''}
            <div><strong>Status:</strong> ${esc(obs.native_status || 'Unknown')}</div>
            <div><strong>Keystone:</strong> ${esc(obs.keystone || 'No')}</div>
            ${obs.action_needed ? `<div><strong>Action:</strong> ${esc(obs.action_needed)}</div>` : ''}
            ${obs.notes ? `<div><strong>Notes:</strong> ${esc(obs.notes)}</div>` : ''}
          </div>
        </div>
        <div class="lbl">CSV row for Google Sheet</div>
        <div class="mono-box">${esc(csvRow)}</div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <button class="btn btn-outline btn-sm" id="obs-copy-csv">📋 Copy CSV</button>
          ${!obs.removed ? `<button class="btn btn-outline btn-sm" id="obs-edit">✏️ Edit</button>` : ''}
          ${!obs.removed ? `<button class="btn btn-outline btn-sm" id="obs-duplicate">📋 Duplicate</button>` : ''}
          ${!obs.removed ? `<button class="btn btn-outline btn-sm" id="obs-add-task" style="color:var(--green);border-color:var(--green)">＋ Add Task</button>` : ''}
          ${!obs.removed
            ? `<button class="btn btn-outline btn-sm" id="obs-archive" style="color:#78909c;border-color:#78909c">📦 Mark Removed</button>`
            : `<button class="btn btn-outline btn-sm" id="obs-restore" style="color:var(--green);border-color:var(--green)">↩️ Restore</button>`}
          <button class="btn btn-sm btn-danger" id="obs-delete">🗑 Delete</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#obs-detail-close').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    modal.querySelector('#obs-copy-csv').addEventListener('click', () => App.copyToClipboard(csvRow));

    const editBtn = modal.querySelector('#obs-edit');
    if (editBtn) editBtn.addEventListener('click', () => { modal.remove(); editObservation(obs); });

    const addTaskBtn = modal.querySelector('#obs-add-task');
    if (addTaskBtn) addTaskBtn.addEventListener('click', () => {
      modal.remove();
      if (window.Tasks && Tasks.openAddTaskSheet) {
        Tasks.openAddTaskSheet({
          observation_id:   obs.id,
          observation_name: obs.common_name + (obs.zone ? ' · Zone ' + obs.zone : ''),
          zone:             obs.zone || '',
          text:             obs.action_needed || '',
        });
      }
    });

    const dupBtn = modal.querySelector('#obs-duplicate');
    if (dupBtn) dupBtn.addEventListener('click', () => { modal.remove(); duplicateObservation(obs); });

    const archiveBtn = modal.querySelector('#obs-archive');
    if (archiveBtn) archiveBtn.addEventListener('click', async () => {
      if (!confirm(`Archive "${obs.common_name}" as removed?\nIt will be hidden by default — use "Show archived" to find it again.`)) return;
      await App.updateObservation(obs.id, { removed: true, removed_on: App.todayISO() });
      modal.remove();
      App.toast(`${obs.common_name} archived ✓`);
      loadHistory();
      if (window.PropertyMap) PropertyMap.refreshIfVisible();
    });

    const restoreBtn = modal.querySelector('#obs-restore');
    if (restoreBtn) restoreBtn.addEventListener('click', async () => {
      await App.updateObservation(obs.id, { removed: false, removed_on: null });
      modal.remove();
      App.toast(`${obs.common_name} restored ✓`);
      loadHistory();
      if (window.PropertyMap) PropertyMap.refreshIfVisible();
    });

    modal.querySelector('#obs-delete').addEventListener('click', async () => {
      if (!confirm(`Permanently delete "${obs.common_name}"?\nThis cannot be undone.`)) return;
      await App.deleteObservation(obs.id);
      modal.remove();
      App.toast('Observation deleted');
      loadHistory();
      if (window.PropertyMap) PropertyMap.refreshIfVisible();
    });
  }

  /* ── Export ── */
  function setupExport() {
    const btn = $('log-export-btn');
    if (btn) {
      btn.addEventListener('click', async () => {
        const allObs = await App.getAllObservations();
        if (allObs.length === 0) { App.toast('No observations to export'); return; }
        const csv = App.obsArrayToCSV(allObs);
        App.downloadCSV(csv, `field-log-${App.todayISO()}.csv`);
      });
    }

    const filterSel = $('log-history-zone-filter');
    if (filterSel) filterSel.addEventListener('change', loadHistory);

    setupImport();
  }

  /* ── Import ── */
  function setupImport() {
    const input = $('log-import-input');
    if (!input) return;
    input.addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => importCSV(ev.target.result);
      reader.readAsText(file);
      input.value = ''; // allow re-selecting same file
    });
  }

  async function importCSV(text) {
    const statusEl = $('log-import-status');
    if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Importing…'; statusEl.className = ''; }

    const lines = parseCSVLines(text);
    if (lines.length < 2) {
      if (statusEl) { statusEl.textContent = 'No data rows found in file.'; statusEl.className = 'alert alert-error'; }
      return;
    }

    // Skip header row; build a dedup key set from existing observations
    const existing  = await App.getAllObservations();
    const dupKeys   = new Set(existing.map(o => `${o.date}|${o.zone}|${(o.common_name||'').toLowerCase()}`));

    let imported = 0, skipped = 0, errors = 0;

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i];
      if (cols.length < 6) continue; // skip blank/malformed rows

      // Column order: Date,Zone,Lat,Lng,Location,Common Name,Latin Name,Native,Keystone,Type,Action,Photo,Logged By,Notes
      const obs = {
        date:             cols[0]  || App.todayISO(),
        zone:             cols[1]  || '',
        lat:              cols[2]  || '',
        lng:              cols[3]  || '',
        location_desc:    cols[4]  || '',
        common_name:      cols[5]  || '',
        latin_name:       cols[6]  || '',
        native_status:    cols[7]  || 'Unknown',
        keystone:         cols[8]  || 'No',
        observation_type: cols[9]  || 'Observation',
        action_needed:    cols[10] || '',
        notes:            cols[13] || '',
        ai_identified:    false,
      };

      if (!obs.common_name) { skipped++; continue; }

      const key = `${obs.date}|${obs.zone}|${obs.common_name.toLowerCase()}`;
      if (dupKeys.has(key)) { skipped++; continue; }

      try {
        await App.saveObservation(obs);
        dupKeys.add(key);
        imported++;
      } catch(e) {
        errors++;
      }
    }

    const msg = `✓ Imported ${imported} observation${imported !== 1 ? 's' : ''}` +
      (skipped ? ` · ${skipped} skipped (duplicates or empty)` : '') +
      (errors  ? ` · ${errors} errors` : '');

    if (statusEl) {
      statusEl.textContent = msg;
      statusEl.className = imported > 0 ? 'alert alert-ok' : 'alert alert-warn';
    }
    if (imported > 0) App.toast(`Imported ${imported} observation${imported !== 1 ? 's' : ''} ✓`);
  }

  /* Parse a CSV string into an array of string arrays, handling quoted fields */
  function parseCSVLines(text) {
    const rows = [];
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const cols = [];
      let cur = '', inQuote = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuote) {
          if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (ch === '"')                    { inQuote = false; }
          else                                    { cur += ch; }
        } else {
          if (ch === '"')  { inQuote = true; }
          else if (ch === ',') { cols.push(cur); cur = ''; }
          else { cur += ch; }
        }
      }
      cols.push(cur);
      rows.push(cols);
    }
    return rows;
  }

  function esc(str) {
    return String(str || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function refreshIfVisible() {
    if (_mode === 'history') loadHistory();
  }

  return { init, refreshIfVisible };
})();
