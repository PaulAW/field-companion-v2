/* map.js — Property map: satellite view, observation pins, zone overlays, boundary drawing */

var PropertyMap = (() => {
  const ESRI_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const OSM_TILES  = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const DEFAULT_CENTER = [41.0686, -91.9694];
  const DEFAULT_ZOOM   = 17;

  const PIN_COLORS = {
    'Native':     '#2e9e4a',
    'Invasive':   '#e53935',
    'Non-native': '#f57c00',
    'Unknown':    '#78909c',
  };

  let _map          = null;
  let _clusterGroup = null;
  let _zoneLayer    = null;
  let _propLayer    = null;
  let _drawnItems   = null;
  let _initialized  = false;
  let _allObs       = [];
  let _filterStatus = 'all';
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

    /* Zoom-level label control (A-5) */
    _map.on('zoomend', applyLabelVisibility);

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
      if (!confirm('Clear all saved zone boundaries?')) return;
      localStorage.removeItem('fc_zone_boundaries');
      loadBoundaries();
      App.toast('Zone boundaries cleared');
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

    const obs = _filterStatus === 'all'
      ? _allObs
      : _allObs.filter(o => o.native_status === _filterStatus);

    let plotted = 0;
    obs.forEach(o => {
      const lat = parseFloat(o.lat || o.latitude);
      const lng = parseFloat(o.lng || o.longitude);
      if (!lat || !lng || isNaN(lat) || isNaN(lng)) return;

      const color = PIN_COLORS[o.native_status] || PIN_COLORS['Unknown'];
      const marker = L.circleMarker([lat, lng], {
        radius: 8,
        fillColor: color,
        color: '#fff',
        weight: 2,
        opacity: 1,
        fillOpacity: 0.9,
      });
      marker.bindPopup(pinPopupHTML(o), { maxWidth: 260 });
      _clusterGroup.addLayer(marker);
      plotted++;
    });
  }

  function pinPopupHTML(o) {
    const color = PIN_COLORS[o.native_status] || PIN_COLORS['Unknown'];
    const date  = (App.formatDate ? App.formatDate(o.date) : o.date) || '';
    return `
      <div style="font-size:13px;line-height:1.7;min-width:180px">
        <strong style="font-size:14px">${esc(o.common_name)}</strong>
        ${o.latin_name ? `<br><em style="font-size:11px;color:#666">${esc(o.latin_name)}</em>` : ''}
        <br>
        <span style="display:inline-block;background:${color};color:#fff;border-radius:4px;padding:1px 7px;font-size:10px;margin-top:3px">${esc(o.native_status || 'Unknown')}</span>
        <span style="display:inline-block;background:#e8e0d0;color:#5a4f3e;border-radius:4px;padding:1px 7px;font-size:10px;margin-top:3px">Zone ${esc(o.zone)}</span>
        <br><span style="font-size:10px;color:#888">${esc(date)}</span>
        ${o.action_needed ? `<br><span style="font-size:11px;color:#555">→ ${esc(o.action_needed)}</span>` : ''}
      </div>`;
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
          }).addTo(_zoneLayer);

          // A-4: DivIcon label marker at polygon centroid — no Leaflet tooltip chrome
          const center = polygonCentroid(geojson);
          if (center && _labelLayer) {
            const makeIcon = txt => L.divIcon({
              html: `<div class="zone-label-icon">${esc(txt)}</div>`,
              className: '',
              iconSize: [0, 0],
              iconAnchor: [0, 0],
            });
            const marker = L.marker(center, { icon: makeIcon(shortLabel), interactive: true });
            marker.on('click', e => {
              L.DomEvent.stopPropagation(e);
              marker.setIcon(makeIcon(fullLabel));
              setTimeout(() => marker.setIcon(makeIcon(shortLabel)), 2000);
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
