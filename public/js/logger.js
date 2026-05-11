/* logger.js — Manual observation entry, history view, CSV export */

var Logger = (() => {
  let _mode = 'new';   // 'new' | 'history' | 'export'
  let _gpsCoords = null;
  let _observations = [];
  let _filterZone = '';

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
      });
    });
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
        lat: _gpsCoords ? _gpsCoords.lat : (center.lat || 41.0686),
        lng: _gpsCoords ? _gpsCoords.lng : (center.lng || -91.9694),
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
      await App.saveObservation(obs);
      App.toast('Observation saved ✓');
      resetForm();
    } catch (err) {
      App.toast('Save failed: ' + err.message);
    }
  }

  /* ── History ── */
  async function loadHistory() {
    const container = $('log-history-list');
    if (!container) return;

    try {
      const zone = ($('log-history-zone-filter') || {}).value || '';
      _observations = zone
        ? await App.getObservationsByZone(zone)
        : await App.getAllObservations();

      if (_observations.length === 0) {
        container.innerHTML = `<div class="empty-state"><span class="ico">📋</span>No observations yet.<br>Use Plant ID or the New Entry form to log plants.</div>`;
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

  function historyItemHTML(obs) {
    const badgeMap = {
      'Native':     'badge-native',
      'Invasive':   'badge-invasive',
      'Non-native': 'badge-nonnative',
      'Unknown':    'badge-zone',
    };
    const badgeCls = badgeMap[obs.native_status] || 'badge-zone';
    const keystone = obs.keystone === 'Yes' ? '<span class="badge badge-keystone">⭐ Keystone</span>' : '';
    return `
      <div class="history-item">
        <div class="hist-date">${App.formatDate(obs.date)} · Zone ${obs.zone}${obs.lat ? ` · ${obs.lat}, ${obs.lng}` : ''}</div>
        <div class="hist-name">${esc(obs.common_name)}</div>
        <div class="hist-meta">
          <span class="badge ${badgeCls}">${esc(obs.native_status || 'Unknown')}</span>
          ${keystone}
          <span class="badge badge-zone">Zone ${esc(obs.zone)}</span>
          ${obs.ai_identified ? '<span class="badge" style="background:#e8e0f8;color:#4a3a8a">🤖 AI</span>' : ''}
        </div>
        ${obs.action_needed ? `<div class="hist-action">→ ${esc(obs.action_needed)}</div>` : ''}
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
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn-outline btn-sm" id="obs-copy-csv">📋 Copy CSV</button>
          <button class="btn btn-sm btn-danger" id="obs-delete">🗑 Delete</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#obs-detail-close').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    modal.querySelector('#obs-copy-csv').addEventListener('click', () => App.copyToClipboard(csvRow));
    modal.querySelector('#obs-delete').addEventListener('click', async () => {
      if (!confirm(`Delete observation for "${obs.common_name}"?`)) return;
      await App.deleteObservation(obs.id);
      modal.remove();
      App.toast('Observation deleted');
      loadHistory();
    });
  }

  /* ── Export ── */
  function setupExport() {
    const btn = $('log-export-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const allObs = await App.getAllObservations();
      if (allObs.length === 0) { App.toast('No observations to export'); return; }
      const csv = App.obsArrayToCSV(allObs);
      App.downloadCSV(csv, `field-log-${App.todayISO()}.csv`);
    });

    const filterSel = $('log-history-zone-filter');
    if (filterSel) filterSel.addEventListener('change', loadHistory);
  }

  function esc(str) {
    return String(str || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  return { init };
})();
