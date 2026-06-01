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

  const $ = id => document.getElementById(id);

  function init() {
    App.registerTab('map', { onShow });
  }

  function onShow() {
    if (!_initialized) {
      _initialized = true;
      initMap();
    } else {
      setTimeout(() => { if (_map) _map.invalidateSize(); }, 80);
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

    /* Boundary drawing via Leaflet.draw */
    setupDrawControl();

    /* My location button */
    addLocationControl();

    /* Zone label toggle button (A-6) */
    addLabelToggleControl();

    /* Zone management button (A-7) */
    addManageZonesControl();

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
        _map.closePopup();
        if (window.Tasks && Tasks.openAddTaskSheet) {
          Tasks.openAddTaskSheet({
            observation_id:   id,
            observation_name: name + (zone ? ' · Zone ' + zone : ''),
            zone,
          });
        }
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
        Object.entries(zoneMap).forEach(([zoneId, geojson]) => {
          const zone       = zones.find(z => z.id === zoneId);
          const color      = zone && zone.urgency === 'high' ? '#e53935' : '#43a047';
          const shortLabel = zone ? zone.id : zoneId;
          const fullLabel  = zone ? `${zone.id} – ${zone.name}` : zoneId;

          L.geoJSON(geojson, {
            style: { color, weight: 2, fillColor: color, fillOpacity: 0.15 },
            interactive: false,
          }).addTo(_zoneLayer);

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

    /* Populate zone picker */
    const zoneSel = $('map-boundary-zone');
    if (zoneSel) {
      zoneSel.innerHTML = App.getZones()
        .map(z => `<option value="${z.id}">Zone ${z.id} – ${z.name}</option>`)
        .join('') + '<option value="__new__">+ New zone…</option>';
      zoneSel.addEventListener('change', () => {
        const newRow = $('map-boundary-new-zone-row');
        if (newRow) newRow.style.display = zoneSel.value === '__new__' ? 'block' : 'none';
      });
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
      if (zoneId === '__new__') {
        const newId = ($('map-boundary-new-zone-id') || {}).value.trim().toUpperCase();
        if (!newId) { App.toast('Enter a zone ID'); return; }
        zoneId = newId;
      }
      if (!zoneId) { App.toast('Select a zone'); return; }
      const existing = JSON.parse(localStorage.getItem('fc_zone_boundaries') || '{}');
      existing[zoneId] = _pendingGeoJSON;
      localStorage.setItem('fc_zone_boundaries', JSON.stringify(existing));
      App.toast(`Zone ${zoneId} boundary saved ✓`);
    }

    _pendingGeoJSON = null;
    if (_drawnItems) _drawnItems.clearLayers();
    const panel = $('map-boundary-panel');
    if (panel) panel.style.display = 'none';
    loadBoundaries();

    // Push to cloud immediately so other devices get it
    if (window.Auth && Auth.isSignedIn() && window.Sync) {
      Sync.pushBoundaries().catch(console.warn);
    }
  }

  function cancelDraw() {
    _pendingGeoJSON = null;
    if (_drawnItems) _drawnItems.clearLayers();
    const panel = $('map-boundary-panel');
    if (panel) panel.style.display = 'none';
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
    if (!confirm(`Delete boundary for Zone ${zoneId}? This cannot be undone.`)) return;

    /* Remove from localStorage */
    try {
      const raw = localStorage.getItem('fc_zone_boundaries');
      if (raw) {
        const zoneMap = JSON.parse(raw);
        delete zoneMap[zoneId];
        localStorage.setItem('fc_zone_boundaries', JSON.stringify(zoneMap));
      }
    } catch(e) {}

    /* Delete from backend if signed in */
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

    loadBoundaries();
    renderZonesList();
    App.toast(`Zone ${zoneId} boundary deleted`);
  }

  /* ── My Location control ── */
  function addLocationControl() {
    const LocationBtn = L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const btn = L.DomUtil.create('button', 'map-locate-btn leaflet-bar');
        btn.innerHTML = '📍';
        btn.title = 'My location';
        btn.type  = 'button';
        L.DomEvent.on(btn, 'click', e => {
          L.DomEvent.stopPropagation(e);
          _map.locate({ setView: true, maxZoom: 18, enableHighAccuracy: true });
        });
        return btn;
      },
    });
    new LocationBtn().addTo(_map);

    _map.on('locationfound', e => {
      L.circleMarker(e.latlng, {
        radius: 9, fillColor: '#1976d2', color: '#fff', weight: 2.5, fillOpacity: 0.95,
      }).addTo(_map).bindPopup('📍 You are here').openPopup();
    });
    _map.on('locationerror', () => App.toast('Location unavailable'));
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

  function refreshIfVisible() {
    if (_initialized) refreshObservations();
  }

  function reloadBoundaries() {
    if (_initialized) loadBoundaries();
  }

  return { init, refreshIfVisible, reloadBoundaries };
})();
