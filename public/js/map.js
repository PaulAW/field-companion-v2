/* map.js — Property map: satellite view, observation pins, zone overlays, boundary drawing */

var PropertyMap = (() => {
  const ESRI_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const OSM_TILES  = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const DEFAULT_CENTER = [41.0686, -91.9694];
  const DEFAULT_ZOOM   = 17;

  const PIN_COLORS = {
    'Native':       '#2e9e4a',
    'Invasive':     '#e53935',
    'Non-native':   '#f57c00',
    'Naturalized':  '#0097a7',
    'Unknown':      '#78909c',
  };

  let _map          = null;
  let _clusterGroup = null;
  let _zoneLayer    = null;
  let _propLayer    = null;
  let _drawnItems   = null;
  let _initialized  = false;
  let _allObs       = [];
  let _filterStatus  = 'all';
  let _showArchived  = false;
  let _pendingGeoJSON = null;
  let _labelsVisible  = true;
  let _labelToggleBtn = null;
  let _labelLayer     = null;
  let _zoneBoundsMap  = {};   // zoneId → L.LatLngBounds, for flyToZone()
  let _zoneLayers     = {};   // zoneId → L.GeoJSON layer, for boundary flash
  let _zoneGeoRaw     = {};   // zoneId → raw GeoJSON, for point-in-polygon + centroid lookups

  /* Live location tracking */
  let _tracking           = false;
  let _watchId            = null;
  let _liveMarker         = null;
  let _liveAccuracyCircle = null;
  let _liveLatLng         = null;   // {lat,lng} of last known live fix
  let _liveFirstFix       = true;
  let _nearbyPanelEl      = null;
  let _locateBtn          = null;

  /* Find-a-plant search */
  let _highlightLayer = null;

  const $ = id => document.getElementById(id);

  function init() {
    App.registerTab('map', { onShow });
  }

  function saveMapPos() {
    if (!_map) return;
    const c = _map.getCenter();
    localStorage.setItem('fc_map_pos', JSON.stringify({ lat: c.lat, lng: c.lng, zoom: _map.getZoom() }));
  }

  function onShow() {
    if (!_initialized) {
      _initialized = true;
      initMap();
    } else {
      setTimeout(() => {
        if (!_map) return;
        _map.invalidateSize();
        // Restore last-saved position so the map re-opens where you left it
        try {
          const saved = JSON.parse(localStorage.getItem('fc_map_pos') || 'null');
          if (saved) _map.setView([saved.lat, saved.lng], saved.zoom, { animate: false });
        } catch(e) {}
      }, 80);
      refreshObservations();
      // Re-pull boundaries in case auth state changed since last visit
      if (window.Auth && Auth.isSignedIn() && window.Sync) {
        Sync.pullBoundaries().catch(console.warn);
      }
    }
  }

  /* ── Map initialisation ── */
  function initMap() {
    const ctx    = App.getPropertyCtx();
    const mc     = ctx.map_center || {};
    const center = [mc.lat || DEFAULT_CENTER[0], mc.lng || DEFAULT_CENTER[1]];
    const zoom   = mc.zoom || DEFAULT_ZOOM;

    _map = L.map('map-main', { zoomControl: true, attributionControl: true });
    _map.setView(center, zoom);

    // Save position whenever user pans or zooms
    _map.on('moveend', saveMapPos);

    /* Tile layers */
    const satellite = L.tileLayer(ESRI_TILES, {
      attribution: 'Tiles &copy; Esri &mdash; USGS, NOAA',
      maxZoom: 20,
    }).addTo(_map);

    const osm = L.tileLayer(OSM_TILES, {
      attribution: '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a>',
      maxZoom: 19,
    });

    L.control.layers(
      { '🛰 Satellite': satellite, '🗺 Street map': osm },
      {},
      { position: 'topright' }
    ).addTo(_map);

    /* Marker cluster group */
    if (window.L && L.markerClusterGroup) {
      _clusterGroup = L.markerClusterGroup({
        maxClusterRadius: 50,
        iconCreateFunction: cluster => {
          const n = cluster.getChildCount();
          return L.divIcon({
            html: `<div class="map-cluster">${n}</div>`,
            className: '',
            iconSize: [36, 36],
            iconAnchor: [18, 18],
          });
        },
      });
    } else {
      _clusterGroup = L.layerGroup(); // fallback: no clustering
    }
    _map.addLayer(_clusterGroup);

    /* Zone and property boundary layers */
    _zoneLayer  = L.layerGroup().addTo(_map);
    _propLayer  = L.layerGroup().addTo(_map);
    _labelLayer = L.layerGroup().addTo(_map);
    _highlightLayer = L.layerGroup().addTo(_map);

    /* Boundary drawing via Leaflet.draw */
    setupDrawControl();

    /* My location button */
    addLocationControl();

    /* Zone label toggle button (A-6) */
    addLabelToggleControl();

    /* Zone management button (A-7) */
    addManageZonesControl();

    /* Find-a-plant search button */
    addFindPlantControl();

    /* Zoom-level label control (A-5) */
    _map.on('zoomend', applyLabelVisibility);

    /* Wire popup archive/restore links */
    _map.on('popupopen', () => setTimeout(wirePopupLinks, 50));

    /* Filter bar */
    document.querySelectorAll('.map-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _filterStatus = btn.dataset.status;
        document.querySelectorAll('.map-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderPins();
        updateObsCount();
      });
    });

    /* Archive toggle button */
    const archiveBtn = $('map-archive-toggle');
    if (archiveBtn) {
      archiveBtn.addEventListener('click', () => {
        _showArchived = !_showArchived;
        archiveBtn.classList.toggle('active', _showArchived);
        archiveBtn.title = _showArchived ? 'Showing archived (removed) plants' : 'Show archived plants';
        renderPins();
        updateObsCount();
      });
    }

    /* Boundary confirm / cancel */
    const saveBtn   = $('map-boundary-save');
    const cancelBtn = $('map-boundary-cancel');
    if (saveBtn)   saveBtn.addEventListener('click', confirmBoundary);
    if (cancelBtn) cancelBtn.addEventListener('click', cancelDraw);

    /* Radio toggle for zone selector */
    document.querySelectorAll('input[name="map-boundary-type"]').forEach(r => {
      r.addEventListener('change', () => {
        const zoneRow = $('map-boundary-zone-row');
        if (zoneRow) zoneRow.style.display = r.value === 'zone' ? 'block' : 'none';
      });
    });

    /* Clear boundary buttons */
    const clearPropBtn = $('map-clear-property');
    if (clearPropBtn) clearPropBtn.addEventListener('click', () => {
      if (!confirm('Clear saved property boundary?')) return;
      localStorage.removeItem('fc_property_boundary');
      loadBoundaries();
      App.toast('Property boundary cleared');
    });

    const clearZoneBtn = $('map-clear-zone');
    if (clearZoneBtn) clearZoneBtn.addEventListener('click', () => {
      if (!confirm('Clear ALL saved zone boundaries?')) return;
      localStorage.removeItem('fc_zone_boundaries');
      loadBoundaries();
      App.toast('Zone boundaries cleared');
      renderZonesList();
    });

    /* Zone management panel close */
    const zonesClose = $('map-zones-close');
    if (zonesClose) zonesClose.addEventListener('click', closeZonesPanel);
    const zonesPanel = $('map-zones-panel');
    if (zonesPanel) zonesPanel.addEventListener('click', e => {
      if (e.target === zonesPanel) closeZonesPanel();
    });

    // Pull cloud boundaries first, then render
    if (window.Auth && Auth.isSignedIn() && window.Sync) {
      Sync.pullBoundaries().then(() => loadBoundaries()).catch(() => loadBoundaries());
    } else {
      loadBoundaries();
    }
    refreshObservations();

    setTimeout(() => { if (_map) _map.invalidateSize(); }, 80);
  }

  /* ── Observations ── */
  let _firstLoad = true;

  async function refreshObservations() {
    try {
      _allObs = await App.getAllObservations();
    } catch(e) {
      _allObs = [];
    }
    renderPins();
    updateObsCount();

    /* On first load, fit to observation bounds if any pins exist */
    if (_firstLoad) {
      _firstLoad = false;
      setTimeout(() => {
        try {
          const bounds = _clusterGroup.getBounds();
          if (bounds.isValid()) {
            _map.fitBounds(bounds, { padding: [48, 48], maxZoom: 18 });
          }
        } catch(e) {}
      }, 150);
    }
  }

  function renderPins() {
    if (!_clusterGroup) return;
    _clusterGroup.clearLayers();

    // Active or archived filter
    let obs = _showArchived
      ? _allObs.filter(o => o.removed)
      : _allObs.filter(o => !o.removed);

    // Status filter (only apply when showing active)
    if (!_showArchived && _filterStatus !== 'all') {
      obs = obs.filter(o => o.native_status === _filterStatus);
    }

    obs.forEach(o => {
      const lat = parseFloat(o.lat || o.latitude);
      const lng = parseFloat(o.lng || o.longitude);
      if (!lat || !lng || isNaN(lat) || isNaN(lng)) return;

      const isArchived = !!o.removed;
      const color = isArchived ? '#78909c' : (PIN_COLORS[o.native_status] || PIN_COLORS['Unknown']);
      const marker = L.circleMarker([lat, lng], {
        radius: 10,
        fillColor: isArchived ? '#fff' : color,
        color:     isArchived ? '#78909c' : '#fff',
        weight:    isArchived ? 2 : 2.5,
        opacity:   1,
        fillOpacity: isArchived ? 0 : 0.9,
        dashArray: isArchived ? '4 3' : null,
      });
      marker.bindPopup(pinPopupHTML(o), { maxWidth: 260 });
      _clusterGroup.addLayer(marker);
    });
  }

  function pinPopupHTML(o) {
    const color = o.removed ? '#78909c' : (PIN_COLORS[o.native_status] || PIN_COLORS['Unknown']);
    const date  = (App.formatDate ? App.formatDate(o.date) : o.date) || '';
    const archiveAction = o.removed
      ? `<br><a href="#" class="popup-restore-link" data-id="${o.id}" style="font-size:11px;color:var(--green)">↩️ Restore</a>`
      : `<br><a href="#" class="popup-archive-link" data-id="${o.id}" style="font-size:11px;color:#78909c">📦 Mark as Removed</a>`;
    return `
      <div style="font-size:13px;line-height:1.7;min-width:180px">
        <strong style="font-size:14px">${esc(o.common_name)}</strong>
        ${o.latin_name ? `<br><em style="font-size:11px;color:#666">${esc(o.latin_name)}</em>` : ''}
        ${o.removed ? `<br><em style="font-size:10px;color:#78909c">Archived · removed ${o.removed_on ? App.formatDate(o.removed_on) : ''}</em>` : ''}
        <br>
        <span style="display:inline-block;background:${color};color:#fff;border-radius:4px;padding:1px 7px;font-size:10px;margin-top:3px">${esc(o.native_status || 'Unknown')}</span>
        <span style="display:inline-block;background:#e8e0d0;color:#5a4f3e;border-radius:4px;padding:1px 7px;font-size:10px;margin-top:3px">Zone ${esc(o.zone)}</span>
        <br><span style="font-size:10px;color:#888">${esc(date)}</span>
        ${o.action_needed && !o.removed ? `<br><span style="font-size:11px;color:#555">→ ${esc(o.action_needed)}</span>` : ''}
        ${archiveAction}
        ${!o.removed ? `<br><a href="#" class="popup-edit-link" data-id="${o.id}" style="font-size:11px;color:var(--green)">✏️ Edit entry</a>` : ''}
        ${!o.removed ? `<br><a href="#" class="popup-add-task-link" data-id="${o.id}" data-name="${esc(o.common_name)}" data-zone="${esc(o.zone || '')}" style="font-size:11px;color:var(--green)">＋ Add task for this plant</a>` : ''}
      </div>`;
  }

  /* Wire popup archive/restore links after popup opens */
  function wirePopupLinks() {
    document.querySelectorAll('.popup-archive-link').forEach(a => {
      a.addEventListener('click', async e => {
        e.preventDefault();
        const id = parseInt(a.dataset.id);
        const obs = _allObs.find(o => o.id === id);
        if (!obs) return;
        if (!confirm(`Archive "${obs.common_name}" as removed?\nHidden by default — use 📦 toggle to view again.`)) return;
        await App.updateObservation(id, { removed: true, removed_on: App.todayISO() });
        App.toast(`${obs.common_name} archived ✓`);
        _map.closePopup();
        await refreshObservations();
        if (window.Logger) Logger.refreshIfVisible();
      });
    });
    document.querySelectorAll('.popup-restore-link').forEach(a => {
      a.addEventListener('click', async e => {
        e.preventDefault();
        const id = parseInt(a.dataset.id);
        const obs = _allObs.find(o => o.id === id);
        if (!obs) return;
        await App.updateObservation(id, { removed: false, removed_on: null });
        App.toast(`${obs.common_name} restored ✓`);
        _map.closePopup();
        await refreshObservations();
        if (window.Logger) Logger.refreshIfVisible();
      });
    });
    document.querySelectorAll('.popup-add-task-link').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        const id   = parseInt(a.dataset.id);
        const name = a.dataset.name;
        const zone = a.dataset.zone;
        const obs  = _allObs.find(o => o.id === id);
        _map.closePopup();
        if (window.Tasks && Tasks.openAddTaskSheet) {
          Tasks.openAddTaskSheet({
            observation_id:   id,
            observation_name: name + (zone ? ' · Zone ' + zone : ''),
            zone,
            text:             (obs && obs.action_needed) ? obs.action_needed : '',
            lat:              obs ? obs.lat : null,
            lng:              obs ? obs.lng : null,
          });
        }
      });
    });

    document.querySelectorAll('.popup-edit-link').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        const id  = parseInt(a.dataset.id);
        const obs = _allObs.find(o => o.id === id);
        if (!obs || !window.Logger) return;
        _map.closePopup();
        Logger.editObservation(obs);
      });
    });
  }

  function updateObsCount() {
    const el = $('map-obs-count');
    if (!el) return;
    const total  = _allObs.length;
    const mapped = _allObs.filter(o => {
      const lat = parseFloat(o.lat || o.latitude);
      return lat && !isNaN(lat);
    }).length;
    if (total === 0) {
      el.textContent = 'No observations logged yet';
    } else {
      el.textContent = `${mapped} pinned · ${total - mapped} without GPS`;
    }
  }

  /* ── Boundaries ── */
  function loadBoundaries() {
    _zoneLayer.clearLayers();
    _propLayer.clearLayers();

    /* Property boundary */
    try {
      const raw = localStorage.getItem('fc_property_boundary');
      if (raw) {
        L.geoJSON(JSON.parse(raw), {
          style: { color: '#ffffff', weight: 2.5, dashArray: '8 5', fillOpacity: 0.04 },
          interactive: false,
        }).addTo(_propLayer);
      }
    } catch(e) {}

    /* Zone boundaries */
    try {
      const raw = localStorage.getItem('fc_zone_boundaries');
      if (raw) {
        const zoneMap = JSON.parse(raw);
        const zones   = App.getZones();
        if (_labelLayer) _labelLayer.clearLayers();
        _zoneGeoRaw = {};
        Object.entries(zoneMap).forEach(([zoneId, geojson]) => {
          _zoneGeoRaw[zoneId] = geojson;
          const zone       = zones.find(z => z.id === zoneId);
          const color      = zone && zone.urgency === 'high' ? '#e53935' : '#43a047';
          const shortLabel = zone ? zone.id : zoneId;
          const fullLabel  = zone ? `${zone.id} – ${zone.name}` : zoneId;

          const zoneGeoLayer = L.geoJSON(geojson, {
            style: { color, weight: 2, fillColor: color, fillOpacity: 0.15 },
            interactive: false,
          }).addTo(_zoneLayer);
          try {
            _zoneBoundsMap[zoneId] = zoneGeoLayer.getBounds();
            _zoneLayers[zoneId]    = zoneGeoLayer;
          } catch(e) {}

          // A-4: DivIcon label marker — draggable, position persisted per zone
          const storedPos = _getLabelPos(zoneId);
          const center = storedPos || polygonCentroid(geojson);
          if (center && _labelLayer) {
            const makeIcon = (txt, hint) => L.divIcon({
              html: `<div class="zone-label-icon" title="${hint || ''}">${esc(txt)}</div>`,
              className: '',
              iconSize: [0, 0],
              iconAnchor: [0, 0],
            });
            const marker = L.marker(center, {
              icon: makeIcon(shortLabel, 'Drag to reposition'),
              interactive: true,
              draggable: true,
            });
            marker.on('click', e => {
              L.DomEvent.stopPropagation(e);
              marker.setIcon(makeIcon(fullLabel));
              setTimeout(() => marker.setIcon(makeIcon(shortLabel, 'Drag to reposition')), 2000);
            });
            marker.on('dragend', () => {
              const p = marker.getLatLng();
              _saveLabelPos(zoneId, [p.lat, p.lng]);
            });
            marker.addTo(_labelLayer);
          }
        });
        applyLabelVisibility();
      }
    } catch(e) {}
  }

  /* ── Boundary drawing ── */
  function setupDrawControl() {
    if (!window.L || !L.Control || !L.Control.Draw) return;

    _drawnItems = new L.FeatureGroup();
    _map.addLayer(_drawnItems);

    const drawControl = new L.Control.Draw({
      position: 'topleft',
      draw: {
        polygon: {
          allowIntersection: false,
          showArea: true,
          shapeOptions: { color: '#2e5c38', weight: 2.5, fillOpacity: 0.12 },
        },
        polyline:     false,
        rectangle:    false,
        circle:       false,
        marker:       false,
        circlemarker: false,
      },
      edit: { featureGroup: _drawnItems },
    });
    _map.addControl(drawControl);

    _map.on(L.Draw.Event.CREATED, e => {
      _drawnItems.clearLayers();
      _drawnItems.addLayer(e.layer);
      showBoundaryPrompt(e.layer.toGeoJSON());
    });
  }

  function showBoundaryPrompt(geojson) {
    _pendingGeoJSON = geojson;

    /* Populate zone picker — use onchange (not addEventListener) to avoid stacking listeners */
    const zoneSel = $('map-boundary-zone');
    if (zoneSel) {
      zoneSel.innerHTML = App.getZones()
        .map(z => `<option value="${z.id}">Zone ${z.id} – ${z.name}</option>`)
        .join('') + '<option value="__new__">+ New zone ID…</option>';
      zoneSel.onchange = () => {
        const newRow = $('map-boundary-new-zone-row');
        if (newRow) newRow.style.display = zoneSel.value === '__new__' ? 'block' : 'none';
        // Clear any previous custom zone ID when switching back
        const newIdEl = $('map-boundary-new-zone-id');
        if (newIdEl && zoneSel.value !== '__new__') newIdEl.value = '';
      };
      // Always hide the new-zone-id row when panel opens (reset state)
      const newRow = $('map-boundary-new-zone-row');
      if (newRow) newRow.style.display = 'none';
    }

    /* Reset radio to property */
    const propRadio = document.querySelector('input[name="map-boundary-type"][value="property"]');
    if (propRadio) {
      propRadio.checked = true;
      const zoneRow = $('map-boundary-zone-row');
      if (zoneRow) zoneRow.style.display = 'none';
    }

    const panel = $('map-boundary-panel');
    if (panel) panel.style.display = 'flex';
  }

  function confirmBoundary() {
    if (!_pendingGeoJSON) return;

    const typeEl = document.querySelector('input[name="map-boundary-type"]:checked');
    const type   = typeEl ? typeEl.value : 'property';

    if (type === 'property') {
      localStorage.setItem('fc_property_boundary', JSON.stringify(_pendingGeoJSON));
      App.toast('Property boundary saved ✓');
    } else {
      let zoneId = ($('map-boundary-zone') || {}).value;
      const isNew = zoneId === '__new__';
      if (isNew) {
        const newId = ($('map-boundary-new-zone-id') || {}).value.trim().toUpperCase();
        if (!newId) { App.toast('Enter a zone ID (single letter)'); return; }
        zoneId = newId;
      }
      if (!zoneId) { App.toast('Select a zone'); return; }
      const existing = JSON.parse(localStorage.getItem('fc_zone_boundaries') || '{}');
      if (existing[zoneId]) {
        showDuplicateZoneModal(zoneId);
        return;
      }
      existing[zoneId] = _pendingGeoJSON;
      localStorage.setItem('fc_zone_boundaries', JSON.stringify(existing));
      App.toast(`Zone ${zoneId} boundary saved ✓`);
      finishBoundarySave(isNew ? zoneId : null);
      return;
    }

    finishBoundarySave(null);
  }

  function cancelDraw() {
    _pendingGeoJSON = null;
    if (_drawnItems) _drawnItems.clearLayers();
    const panel = $('map-boundary-panel');
    if (panel) panel.style.display = 'none';
  }

  function showDuplicateZoneModal(zoneId) {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2000;display:flex;align-items:center;justify-content:center;padding:16px';
    modal.innerHTML = `
      <div style="background:#fff;border-radius:14px;padding:20px 18px;max-width:320px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,.3)">
        <h3 style="margin:0 0 8px;font-size:16px">Zone ${esc(zoneId)} already has a boundary</h3>
        <p style="font-size:13px;color:#555;margin:0 0 16px;line-height:1.5">What would you like to do with the shape you just drew?</p>
        <button id="dup-replace" class="btn" style="width:100%;margin-bottom:8px;background:#e53935;border-color:#e53935">⚠️ Replace Zone ${esc(zoneId)}'s boundary</button>
        <button id="dup-new" class="btn btn-outline" style="width:100%;margin-bottom:8px">＋ Save as a different zone instead</button>
        <button id="dup-cancel" class="btn btn-outline" style="width:100%;color:var(--muted)">Cancel — discard this shape</button>
      </div>`;
    document.body.appendChild(modal);

    document.getElementById('dup-replace').addEventListener('click', () => {
      modal.remove();
      const existing = JSON.parse(localStorage.getItem('fc_zone_boundaries') || '{}');
      existing[zoneId] = _pendingGeoJSON;
      localStorage.setItem('fc_zone_boundaries', JSON.stringify(existing));
      App.toast(`Zone ${zoneId} boundary replaced ✓`);
      finishBoundarySave(null);
    });

    document.getElementById('dup-new').addEventListener('click', () => {
      modal.remove();
      // Switch dropdown to __new__ and focus the ID input
      const zoneSel = $('map-boundary-zone');
      if (zoneSel) {
        zoneSel.value = '__new__';
        const newRow = $('map-boundary-new-zone-row');
        if (newRow) newRow.style.display = 'block';
        const newIdEl = $('map-boundary-new-zone-id');
        if (newIdEl) { newIdEl.value = ''; newIdEl.focus(); }
      }
    });

    document.getElementById('dup-cancel').addEventListener('click', () => {
      modal.remove();
      cancelDraw();
    });
  }

  function finishBoundarySave(newZoneId) {
    _pendingGeoJSON = null;
    if (_drawnItems) _drawnItems.clearLayers();
    const panel = $('map-boundary-panel');
    if (panel) panel.style.display = 'none';
    loadBoundaries();
    if (window.Auth && Auth.isSignedIn() && window.Sync) {
      Sync.pushBoundaries().catch(console.warn);
    }
    // If this was a brand-new zone ID, prompt user to fill in zone details
    if (newZoneId && !App.getZone(newZoneId)) {
      setTimeout(() => promptNewZoneInfo(newZoneId), 400);
    }
  }

  function promptNewZoneInfo(zoneId) {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2000;display:flex;align-items:flex-end;';
    modal.innerHTML = `
      <div style="background:var(--cream);border-radius:20px 20px 0 0;padding:20px 16px 40px;width:100%;max-width:480px;margin:0 auto">
        <h3 style="font-size:16px;margin:0 0 6px">Zone ${esc(zoneId)} — add info</h3>
        <p style="font-size:12px;color:var(--muted);margin:0 0 14px">New zone boundary saved. Give it a name and description so it appears in all lists.</p>
        <div class="field"><label class="lbl">Zone name</label>
          <input type="text" id="nz-name" placeholder="e.g. Creek Corridor" style="width:100%"></div>
        <div class="field" style="margin-top:8px"><label class="lbl">Description (optional)</label>
          <textarea id="nz-desc" rows="2" style="width:100%;resize:vertical" placeholder="What's in this zone?"></textarea></div>
        <div class="field" style="margin-top:8px"><label class="lbl">Goals (optional)</label>
          <textarea id="nz-goals" rows="2" style="width:100%;resize:vertical" placeholder="What do you want to achieve here?"></textarea></div>
        <div style="display:flex;gap:8px;margin-top:14px">
          <button class="btn" id="nz-save" type="button">Save zone info</button>
          <button class="btn btn-outline" id="nz-skip" type="button">Skip for now</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const nameEl = document.getElementById('nz-name');
    if (nameEl) nameEl.focus();
    const close = () => modal.remove();
    document.getElementById('nz-skip').addEventListener('click', close);
    document.getElementById('nz-save').addEventListener('click', () => {
      const name  = (document.getElementById('nz-name')  || {}).value.trim() || `Zone ${zoneId}`;
      const desc  = (document.getElementById('nz-desc')  || {}).value.trim() || '';
      const goals = (document.getElementById('nz-goals') || {}).value.trim() || '';
      App.saveCustomZone({ id: zoneId, name, description: desc, goals, notes: '',
        acres: 0, elevation: '', urgency: 'low', priority_action: null,
        invasives: [], target_natives: [] });
      close();
      App.toast(`Zone ${zoneId} — ${name} saved ✓`);
    });
  }

  /* ── A-7: Zone management panel ── */
  function addManageZonesControl() {
    const ManageZonesBtn = L.Control.extend({
      options: { position: 'topright' },
      onAdd() {
        const btn = L.DomUtil.create('button', 'leaflet-bar map-manage-zones-btn');
        btn.innerHTML = '🗂';
        btn.title = 'Manage zone boundaries';
        btn.type  = 'button';
        btn.style.cssText = 'background:white;border:none;cursor:pointer;padding:5px 8px;font-size:15px;display:block;line-height:1;';
        L.DomEvent.on(btn, 'click', e => {
          L.DomEvent.stopPropagation(e);
          openZonesPanel();
        });
        return btn;
      },
    });
    new ManageZonesBtn().addTo(_map);
  }

  function openZonesPanel() {
    renderZonesList();
    const panel = $('map-zones-panel');
    if (panel) panel.style.display = 'flex';
  }

  function closeZonesPanel() {
    const panel = $('map-zones-panel');
    if (panel) panel.style.display = 'none';
  }

  function renderZonesList() {
    const container = $('map-zones-list');
    if (!container) return;
    const raw = localStorage.getItem('fc_zone_boundaries');
    const zoneMap = raw ? JSON.parse(raw) : {};
    const zones   = App.getZones();
    const ids     = Object.keys(zoneMap).sort();
    if (ids.length === 0) {
      container.innerHTML = '<div style="font-size:13px;color:var(--muted);padding:4px 0">No zone boundaries saved.</div>';
      return;
    }
    container.innerHTML = ids.map(id => {
      const zone = zones.find(z => z.id === id);
      const label = zone ? `Zone ${zone.id} – ${zone.name}` : `Zone ${id}`;
      return `<div class="zone-delete-row" id="zone-del-row-${id}">
        <span style="font-size:13px;flex:1">${esc(label)}</span>
        <button class="btn btn-sm btn-outline" data-zone-del="${id}" style="font-size:11px;color:#e53935;border-color:#e53935;padding:3px 10px">Delete</button>
      </div>`;
    }).join('');
    container.querySelectorAll('[data-zone-del]').forEach(btn => {
      btn.addEventListener('click', () => deleteZoneBoundary(btn.dataset.zoneDel));
    });
  }

  async function deleteZoneBoundary(zoneId) {
    // Check for observations and tasks in this zone
    let zoneObs   = [];
    let zoneTasks = [];
    try { zoneObs = (await App.getAllObservations()).filter(o => o.zone === zoneId && !o.removed); } catch(e) {}
    try { zoneTasks = window.Tasks ? Tasks.getTasksForZone(zoneId) : []; } catch(e) {}

    // Check if this is a custom zone (user-created, not in static zones.json)
    const customZones = (() => { try { return JSON.parse(localStorage.getItem('fc_custom_zones') || '[]'); } catch { return []; } })();
    const isCustom = customZones.some(z => z.id === zoneId);

    // Build the confirmation modal
    const otherZones = App.getZones().filter(z => z.id !== zoneId);
    const hasData    = zoneObs.length > 0 || zoneTasks.length > 0;

    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2000;display:flex;align-items:center;justify-content:center;padding:16px';
    modal.innerHTML = `
      <div style="background:#fff;border-radius:14px;padding:20px 18px;max-width:340px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,.3)">
        <h3 style="margin:0 0 8px;font-size:16px">Delete Zone ${esc(zoneId)} boundary?</h3>
        ${hasData ? `<div style="background:#fff3e0;border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#555">
          <strong>⚠️ This zone has:</strong>
          ${zoneObs.length > 0 ? `<div>• ${zoneObs.length} observation${zoneObs.length !== 1 ? 's' : ''}</div>` : ''}
          ${zoneTasks.length > 0 ? `<div>• ${zoneTasks.length} task${zoneTasks.length !== 1 ? 's' : ''}</div>` : ''}
          <div style="margin-top:6px">Move these records to a different zone?</div>
          <select id="zdel-reassign" style="width:100%;margin-top:6px;font-size:12px">
            <option value="">— Keep "Zone ${esc(zoneId)}" tag —</option>
            ${otherZones.map(z => `<option value="${esc(z.id)}">Zone ${esc(z.id)} – ${esc(z.name)}</option>`).join('')}
          </select>
        </div>` : ''}
        ${isCustom ? `<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:12px;cursor:pointer">
          <input type="checkbox" id="zdel-remove-custom" checked>
          Also remove Zone ${esc(zoneId)} from all lists (Zones tab, dropdowns)
        </label>` : ''}
        <div style="display:flex;gap:8px">
          <button class="btn" id="zdel-confirm" style="background:#e53935;border-color:#e53935">Delete boundary</button>
          <button class="btn btn-outline" id="zdel-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    document.getElementById('zdel-cancel').addEventListener('click', () => modal.remove());

    document.getElementById('zdel-confirm').addEventListener('click', async () => {
      modal.remove();
      const reassignTo     = hasData ? ((document.getElementById('zdel-reassign') || {}).value || '') : '';
      const removeCustom   = isCustom && (document.getElementById('zdel-remove-custom') || {}).checked;

      /* Reassign observations */
      if (reassignTo && zoneObs.length > 0) {
        await Promise.all(zoneObs.map(o => App.updateObservation(o.id, { zone: reassignTo }).catch(console.warn)));
        App.toast(`${zoneObs.length} observation${zoneObs.length !== 1 ? 's' : ''} moved to Zone ${reassignTo}`);
      }

      /* Remove boundary from localStorage */
      try {
        const zoneMap = JSON.parse(localStorage.getItem('fc_zone_boundaries') || '{}');
        delete zoneMap[zoneId];
        localStorage.setItem('fc_zone_boundaries', JSON.stringify(zoneMap));
      } catch(e) {}

      /* Remove from backend */
      if (window.Auth && Auth.isSignedIn()) {
        try {
          const BACKEND = 'https://field-companion-backend.paulwiner5.workers.dev';
          const tok = Auth.getToken();
          await fetch(`${BACKEND}/boundaries/zone/${encodeURIComponent(zoneId)}`, {
            method: 'DELETE',
            headers: tok ? { Authorization: 'Bearer ' + tok } : {},
          });
        } catch(e) { console.warn('Zone boundary cloud delete failed:', e); }
      }

      /* Optionally remove custom zone from all lists */
      if (removeCustom) {
        const updated = customZones.filter(z => z.id !== zoneId);
        localStorage.setItem('fc_custom_zones', JSON.stringify(updated));
        // Also clear any zone overrides for this zone
        try {
          const overrides = JSON.parse(localStorage.getItem('fc_zone_overrides') || '{}');
          delete overrides[zoneId];
          localStorage.setItem('fc_zone_overrides', JSON.stringify(overrides));
        } catch(e) {}
        // Re-init zones tab to reflect removal
        if (window.Zones && Zones.init) Zones.init();
      }

      delete _zoneBoundsMap[zoneId];
      delete _zoneLayers[zoneId];
      loadBoundaries();
      renderZonesList();
      App.toast(`Zone ${zoneId} boundary deleted`);
    });
  }

  /* ── My Location control — toggles continuous live tracking ── */
  function addLocationControl() {
    const LocationBtn = L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const btn = L.DomUtil.create('button', 'map-locate-btn leaflet-bar');
        btn.innerHTML = '📍';
        btn.title = 'Track my location';
        btn.type  = 'button';
        _locateBtn = btn;
        L.DomEvent.on(btn, 'click', e => {
          L.DomEvent.stopPropagation(e);
          if (_tracking) stopTracking(); else startTracking();
        });
        return btn;
      },
    });
    new LocationBtn().addTo(_map);
  }

  function startTracking() {
    if (!navigator.geolocation) { App.toast('Location unavailable on this device'); return; }
    _tracking = true;
    _liveFirstFix = true;
    if (_locateBtn) { _locateBtn.classList.add('tracking'); _locateBtn.title = 'Stop tracking my location'; }
    _watchId = navigator.geolocation.watchPosition(onLocationUpdate, onLocationError, {
      enableHighAccuracy: true, maximumAge: 5000, timeout: 15000,
    });
  }

  function stopTracking() {
    _tracking = false;
    if (_watchId !== null) { navigator.geolocation.clearWatch(_watchId); _watchId = null; }
    if (_locateBtn) { _locateBtn.classList.remove('tracking'); _locateBtn.title = 'Track my location'; }
    if (_liveMarker)          { _map.removeLayer(_liveMarker); _liveMarker = null; }
    if (_liveAccuracyCircle)  { _map.removeLayer(_liveAccuracyCircle); _liveAccuracyCircle = null; }
    hideNearbyPanel();
    _liveLatLng = null;
  }

  function onLocationUpdate(pos) {
    const lat = pos.coords.latitude, lng = pos.coords.longitude, acc = pos.coords.accuracy || 15;
    _liveLatLng = { lat, lng };

    if (!_liveMarker) {
      _liveMarker = L.marker([lat, lng], {
        icon: L.divIcon({
          html: '<div class="map-live-dot"><div class="map-live-dot-pulse"></div></div>',
          className: '', iconSize: [16, 16], iconAnchor: [8, 8],
        }),
        interactive: false, zIndexOffset: 1000,
      }).addTo(_map);
    } else {
      _liveMarker.setLatLng([lat, lng]);
    }

    if (!_liveAccuracyCircle) {
      _liveAccuracyCircle = L.circle([lat, lng], {
        radius: acc, color: '#1976d2', weight: 1, fillColor: '#1976d2', fillOpacity: 0.08, interactive: false,
      }).addTo(_map);
    } else {
      _liveAccuracyCircle.setLatLng([lat, lng]).setRadius(acc);
    }

    if (_liveFirstFix) {
      _liveFirstFix = false;
      _map.setView([lat, lng], Math.max(_map.getZoom(), 18));
    }

    updateNearbyPanel(lat, lng);
  }

  function onLocationError() {
    App.toast('Location unavailable — check permissions');
    stopTracking();
  }

  /* ── Nearby-info panel: what's logged / due near the live location ── */
  function ensureNearbyPanel() {
    if (_nearbyPanelEl) return _nearbyPanelEl;
    const mapScreen = document.getElementById('screen-map');
    if (!mapScreen) return null;
    const el = document.createElement('div');
    el.id = 'map-nearby-panel';
    el.className = 'map-nearby-panel';
    mapScreen.appendChild(el);
    _nearbyPanelEl = el;
    return el;
  }

  function hideNearbyPanel() {
    if (_nearbyPanelEl) _nearbyPanelEl.style.display = 'none';
  }

  function updateNearbyPanel(lat, lng) {
    const panel = ensureNearbyPanel();
    if (!panel) return;

    // Which zone (if any) contains the live point
    let currentZone = null;
    for (const [zoneId, geojson] of Object.entries(_zoneGeoRaw)) {
      if (pointInPolygon(lat, lng, geojson)) { currentZone = App.getZone(zoneId) || { id: zoneId, name: zoneId }; break; }
    }

    // Nearby active observations with GPS
    const nearby = _allObs
      .filter(o => !o.removed)
      .map(o => {
        const olat = parseFloat(o.lat || o.latitude), olng = parseFloat(o.lng || o.longitude);
        if (!olat || !olng || isNaN(olat) || isNaN(olng)) return null;
        return { obs: o, dist: distanceMeters(lat, lng, olat, olng) };
      })
      .filter(x => x && x.dist <= 75)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 4);

    const openTasks = currentZone && window.Tasks
      ? Tasks.getTasksForZone(currentZone.id).filter(t => !t.completed)
      : [];

    const zoneHTML = currentZone
      ? `<strong>Zone ${esc(currentZone.id)} – ${esc(currentZone.name)}</strong>`
      : `<strong>Not inside a drawn zone</strong>`;

    const nearbyHTML = nearby.length
      ? nearby.map(x => `<div class="map-nearby-row">🌿 ${esc(x.obs.common_name)} <span class="map-nearby-dist">${Math.round(x.dist)}m</span></div>`).join('')
      : `<div class="map-nearby-row map-nearby-empty">No logged plants within 75m</div>`;

    const tasksHTML = currentZone
      ? `<div class="map-nearby-row map-nearby-tasks">${openTasks.length ? `📋 ${openTasks.length} open task${openTasks.length !== 1 ? 's' : ''} in this zone` : '📋 No open tasks in this zone'}</div>`
      : '';

    panel.innerHTML = `${zoneHTML}${nearbyHTML}${tasksHTML}`;
    panel.style.display = 'block';
    if (currentZone && window.Tasks) {
      panel.querySelector('.map-nearby-tasks')?.addEventListener('click', () => App.switchTab('tasks'));
    }
  }

  /* A-6: label toggle control */
  function addLabelToggleControl() {
    const LabelToggle = L.Control.extend({
      options: { position: 'topright' },
      onAdd() {
        const btn = L.DomUtil.create('button', 'leaflet-bar map-label-toggle-btn');
        btn.innerHTML = '🏷️';
        btn.title = 'Toggle zone labels';
        btn.type  = 'button';
        btn.style.cssText = 'background:white;border:none;cursor:pointer;padding:5px 8px;font-size:15px;display:block;line-height:1;';
        _labelToggleBtn = btn;
        L.DomEvent.on(btn, 'click', e => {
          L.DomEvent.stopPropagation(e);
          _labelsVisible = !_labelsVisible;
          btn.style.opacity = _labelsVisible ? '1' : '0.35';
          applyLabelVisibility();
        });
        return btn;
      },
    });
    new LabelToggle().addTo(_map);
  }

  /* ── Find-a-plant search control ── */
  function addFindPlantControl() {
    const FindBtn = L.Control.extend({
      options: { position: 'topright' },
      onAdd() {
        const btn = L.DomUtil.create('button', 'leaflet-bar map-find-plant-btn');
        btn.innerHTML = '🔍';
        btn.title = 'Find a plant by name';
        btn.type  = 'button';
        btn.style.cssText = 'background:white;border:none;cursor:pointer;padding:5px 8px;font-size:15px;display:block;line-height:1;';
        L.DomEvent.on(btn, 'click', e => {
          L.DomEvent.stopPropagation(e);
          openFindPlantModal();
        });
        return btn;
      },
    });
    new FindBtn().addTo(_map);
  }

  function openFindPlantModal() {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2000;display:flex;align-items:center;justify-content:center;padding:16px';
    modal.innerHTML = `
      <div style="background:#fff;border-radius:14px;padding:20px 18px;max-width:340px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,.3)">
        <h3 style="margin:0 0 10px;font-size:16px">Find a plant</h3>
        <input type="text" id="fp-query" placeholder="e.g. elderberry" style="width:100%;padding:8px 10px;font-size:14px;border:1px solid var(--border);border-radius:8px">
        <div id="fp-results" style="margin-top:12px;max-height:280px;overflow-y:auto"></div>
        <button class="btn btn-outline" id="fp-close" style="width:100%;margin-top:14px">Close</button>
      </div>`;
    document.body.appendChild(modal);

    const input   = document.getElementById('fp-query');
    const results = document.getElementById('fp-results');
    input.focus();

    const runSearch = () => {
      const q = input.value.trim();
      results.innerHTML = q.length < 2 ? '' : findPlantResultsHTML(q);
      results.querySelectorAll('[data-fp-obs]').forEach(el => {
        el.addEventListener('click', () => { flyToObs(parseInt(el.dataset.fpObs)); modal.remove(); });
      });
      results.querySelectorAll('[data-fp-zone]').forEach(el => {
        el.addEventListener('click', () => { flyToZone(el.dataset.fpZone); modal.remove(); });
      });
    };
    input.addEventListener('input', runSearch);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });

    document.getElementById('fp-close').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  }

  function findPlantResultsHTML(q) {
    const ql = q.toLowerCase();

    // 1. Logged observations matching name
    const matches = _allObs.filter(o => !o.removed &&
      ((o.common_name || '').toLowerCase().includes(ql) || (o.latin_name || '').toLowerCase().includes(ql)));

    if (matches.length) {
      highlightObs(matches);
      return matches.map(o => {
        let distHTML = '';
        if (_liveLatLng) {
          const lat = parseFloat(o.lat || o.latitude), lng = parseFloat(o.lng || o.longitude);
          if (lat && lng && !isNaN(lat) && !isNaN(lng)) {
            const d = distanceMeters(_liveLatLng.lat, _liveLatLng.lng, lat, lng);
            distHTML = ` <span style="color:var(--muted)">· ${Math.round(d)}m ${bearingCompass(_liveLatLng.lat, _liveLatLng.lng, lat, lng)}</span>`;
          }
        }
        return `<div data-fp-obs="${o.id}" style="padding:8px 4px;border-bottom:1px solid var(--border);cursor:pointer;font-size:13px">
          🌿 <strong>${esc(o.common_name)}</strong> — Zone ${esc(o.zone)}${distHTML}
        </div>`;
      }).join('');
    }

    // 2. No logged pins — fall back to zones whose text mentions this species
    clearHighlight();
    const zoneMatches = App.getZones().filter(z => {
      const haystack = [z.name, z.description, z.goals, ...(z.target_natives || []),
        ...(z.known_plantings_2016 || []), ...(z.known_plantings_2020_nw_corner || [])]
        .join(' ').toLowerCase();
      return haystack.includes(ql);
    });

    if (zoneMatches.length) {
      return zoneMatches.map(z => {
        let distHTML = '';
        if (_liveLatLng && _zoneGeoRaw[z.id]) {
          if (pointInPolygon(_liveLatLng.lat, _liveLatLng.lng, _zoneGeoRaw[z.id])) {
            distHTML = ` <span style="color:var(--green)">· you are here</span>`;
          } else {
            const c = polygonCentroid(_zoneGeoRaw[z.id]);
            if (c) {
              const d = distanceMeters(_liveLatLng.lat, _liveLatLng.lng, c[0], c[1]);
              distHTML = ` <span style="color:var(--muted)">· ~${Math.round(d)}m ${bearingCompass(_liveLatLng.lat, _liveLatLng.lng, c[0], c[1])}</span>`;
            }
          }
        }
        const boundaryNote = _zoneGeoRaw[z.id] ? '' : ' <span style="color:var(--muted)">(no boundary drawn yet)</span>';
        return `<div data-fp-zone="${esc(z.id)}" style="padding:8px 4px;border-bottom:1px solid var(--border);cursor:pointer;font-size:13px">
          No individual plants logged yet. Known planting area:<br>
          📍 <strong>Zone ${esc(z.id)} – ${esc(z.name)}</strong>${boundaryNote}${distHTML}
        </div>`;
      }).join('');
    }

    return `<div style="padding:8px 4px;font-size:13px;color:var(--muted)">No matches in logged plants or zone notes. Try a different name, or log this plant via Plant ID once you spot it.</div>`;
  }

  function highlightObs(matches) {
    clearHighlight();
    const pts = [];
    matches.forEach(o => {
      const lat = parseFloat(o.lat || o.latitude), lng = parseFloat(o.lng || o.longitude);
      if (!lat || !lng || isNaN(lat) || isNaN(lng)) return;
      pts.push([lat, lng]);
      L.circleMarker([lat, lng], {
        radius: 14, color: '#ffb300', weight: 3, fillColor: '#ffb300', fillOpacity: 0.25,
        className: 'map-highlight-pin',
      }).addTo(_highlightLayer);
    });
    if (pts.length) {
      if (pts.length === 1) _map.setView(pts[0], Math.max(_map.getZoom(), 19));
      else _map.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 19 });
    }
  }

  function clearHighlight() {
    if (_highlightLayer) _highlightLayer.clearLayers();
  }

  function applyLabelVisibility() {
    if (!_map || !_labelLayer) return;
    const show = _labelsVisible && _map.getZoom() >= 17;
    if (show && !_map.hasLayer(_labelLayer)) _map.addLayer(_labelLayer);
    else if (!show && _map.hasLayer(_labelLayer)) _map.removeLayer(_labelLayer);
  }

  /* Compute polygon centroid as average of outer ring vertices */
  function polygonCentroid(geojson) {
    try {
      let ring;
      const g = geojson.geometry || geojson;
      if (g.type === 'Polygon') ring = g.coordinates[0];
      else if (g.type === 'MultiPolygon') ring = g.coordinates[0][0];
      else if (g.type === 'Feature') return polygonCentroid(g.geometry);
      else if (g.type === 'FeatureCollection') return polygonCentroid(g.features[0]);
      else return null;
      if (!ring || ring.length < 3) return null;
      const pts = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
        ? ring.slice(0, -1) : ring; // drop closing duplicate
      let sumLat = 0, sumLng = 0;
      pts.forEach(([lng, lat]) => { sumLat += lat; sumLng += lng; });
      return [sumLat / pts.length, sumLng / pts.length];
    } catch(e) { return null; }
  }

  /* ── Zone label position persistence (stored inside boundary GeoJSON with timestamp) ── */
  function _getLabelPos(zoneId) {
    try {
      const raw = localStorage.getItem('fc_zone_boundaries');
      if (raw) {
        const zoneMap = JSON.parse(raw);
        const pos = zoneMap[zoneId] && zoneMap[zoneId].properties && zoneMap[zoneId].properties.labelPos;
        if (pos) return pos.coords || pos; // handle both {coords,t} and legacy [lat,lng]
      }
      const old = JSON.parse(localStorage.getItem('fc_zone_label_positions') || '{}');
      return old[zoneId] || null;
    } catch(e) { return null; }
  }

  function _saveLabelPos(zoneId, latlng) {
    try {
      const raw = localStorage.getItem('fc_zone_boundaries');
      if (!raw) return;
      const zoneMap = JSON.parse(raw);
      if (!zoneMap[zoneId]) return;
      if (!zoneMap[zoneId].properties) zoneMap[zoneId].properties = {};
      zoneMap[zoneId].properties.labelPos = { coords: latlng, t: Date.now() };
      localStorage.setItem('fc_zone_boundaries', JSON.stringify(zoneMap));
      if (window.Auth && Auth.isSignedIn() && window.Sync) {
        Sync.pushBoundaries().catch(console.warn);
      }
    } catch(e) {}
  }

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ── Geo helpers ── */
  function distanceMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function bearingCompass(lat1, lng1, lat2, lng2) {
    const toRad = d => d * Math.PI / 180;
    const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
    const deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(deg / 45) % 8];
  }

  /* Ray-casting point-in-polygon (outer ring only) against a boundary GeoJSON */
  function pointInPolygon(lat, lng, geojson) {
    const g = geojson.geometry || geojson;
    let rings;
    if (g.type === 'Polygon') rings = [g.coordinates[0]];
    else if (g.type === 'MultiPolygon') rings = g.coordinates.map(p => p[0]);
    else if (g.type === 'Feature') return pointInPolygon(lat, lng, g.geometry);
    else if (g.type === 'FeatureCollection') return g.features.some(f => pointInPolygon(lat, lng, f.geometry));
    else return false;
    return rings.some(ring => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        const intersect = ((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
      }
      return inside;
    });
  }

  function refreshIfVisible() {
    if (_initialized) refreshObservations();
  }

  function reloadBoundaries() {
    if (_initialized) loadBoundaries();
  }

  /* Fly to a specific observation pin — called from task obs-link */
  async function flyToObs(obsId) {
    App.switchTab('map');
    setTimeout(async () => {
      if (!_map) return;
      if (_initialized) _map.invalidateSize();
      // Tasks may store either the local IndexedDB id or the cloud observation id
      // (older links were saved inconsistently) — match against both.
      let obs = _allObs.find(o => o.id === obsId || o.cloud_id === obsId);
      if (!obs) {
        try {
          const all = await App.getAllObservations();
          obs = all.find(o => o.id === obsId || o.cloud_id === obsId);
          if (all.length) { _allObs = all; renderPins(); }
        } catch(e) {}
      }
      if (obs) {
        const lat = parseFloat(obs.lat || obs.latitude);
        const lng = parseFloat(obs.lng || obs.longitude);
        if (lat && lng && !isNaN(lat) && !isNaN(lng)) {
          _map.closePopup();
          _map.setView([lat, lng], 19);
          App.toast(`📍 ${obs.common_name}`);
        } else {
          App.toast(`${obs.common_name} has no GPS pin`);
        }
      } else {
        App.toast('Could not find this observation — it may not be linked correctly');
      }
    }, 150);
  }

  /* Fly to raw GPS coordinates with no observation record — called from task GPS link */
  function flyToCoords(lat, lng) {
    App.switchTab('map');
    setTimeout(() => {
      if (!_map) return;
      if (_initialized) _map.invalidateSize();
      if (!isNaN(lat) && !isNaN(lng)) {
        _map.closePopup();
        _map.setView([lat, lng], 19);
        App.toast(`📍 ${lat}, ${lng}`);
      }
    }, 150);
  }

  /* Fly to a zone boundary — called from Tasks zone-group view */
  function flyToZone(zoneId) {
    App.switchTab('map');
    setTimeout(() => {
      if (!_map) return;
      if (_initialized) _map.invalidateSize();
      const bounds = _zoneBoundsMap[zoneId];
      if (bounds && bounds.isValid()) {
        _map.fitBounds(bounds, { padding: [40, 40], maxZoom: 19 });
        // Double-flash the boundary polygon so the user can spot it
        const layer = _zoneLayers[zoneId];
        if (layer) {
          const normal = { fillOpacity: 0.15, weight: 2 };
          const bright = { fillOpacity: 0.6,  weight: 5  };
          layer.setStyle(bright);
          setTimeout(() => layer.setStyle(normal), 450);
          setTimeout(() => layer.setStyle(bright), 750);
          setTimeout(() => layer.setStyle(normal), 1200);
        }
      } else {
        App.toast(`No boundary drawn for Zone ${zoneId} yet`);
      }
    }, 150);
  }

  /* Fly to + highlight every pin for a given species (by common_name) —
     called from the Plants tab's "View on map" button. Reuses the same
     highlightObs() used by the map's own "Find a plant" search. */
  async function flyToSpecies(commonName) {
    App.switchTab('map');
    setTimeout(async () => {
      if (!_map) return;
      if (_initialized) _map.invalidateSize();
      let matches = _allObs.filter(o => !o.removed && (o.common_name || '').trim() === commonName);
      if (!matches.length) {
        try {
          const all = await App.getAllObservations();
          if (all.length) { _allObs = all; renderPins(); }
          matches = _allObs.filter(o => !o.removed && (o.common_name || '').trim() === commonName);
        } catch(e) {}
      }
      const hasGps = o => {
        const lat = parseFloat(o.lat || o.latitude), lng = parseFloat(o.lng || o.longitude);
        return !!(lat && lng && !isNaN(lat) && !isNaN(lng));
      };
      const withGps = matches.filter(hasGps);
      if (!withGps.length) {
        App.toast(matches.length ? `${commonName}: no GPS pins to show` : `No observations found for ${commonName}`);
        return;
      }
      _map.closePopup();
      highlightObs(withGps);
      App.toast(`📍 ${withGps.length} ${commonName} pin${withGps.length === 1 ? '' : 's'} highlighted`);
    }, 150);
  }

  return { init, refreshIfVisible, reloadBoundaries, flyToZone, flyToObs, flyToCoords, flyToSpecies };
})();
