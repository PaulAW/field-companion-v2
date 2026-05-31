/* map-picker.js — Shared Leaflet map picker modal for GPS location selection */

var MapPicker = (() => {
  let _map         = null;
  let _callback    = null;
  let _zoneId      = null;       // zone to validate against (optional)
  let _propLayer   = null;
  let _zoneLayer   = null;
  let _labelLayer  = null;
  let _labelsOn    = true;

  const ESRI_TILES     = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const DEFAULT_CENTER = [41.0686, -91.9694];
  const DEFAULT_ZOOM   = 17;

  function init() {
    const cancelBtn = document.getElementById('map-picker-cancel');
    const useBtn    = document.getElementById('map-picker-use');
    if (cancelBtn) cancelBtn.addEventListener('click', close);
    if (useBtn)    useBtn.addEventListener('click', confirmLocation);
  }

  function open(opts) {
    opts    = opts || {};
    _callback = opts.onSelect || null;
    _zoneId   = opts.zone    || null;   // e.g. 'D' — used for out-of-zone warning

    const lat    = parseFloat(opts.lat) || DEFAULT_CENTER[0];
    const lng    = parseFloat(opts.lng) || DEFAULT_CENTER[1];
    const zoom   = opts.zoom  || DEFAULT_ZOOM;
    const center = [lat, lng];

    const modal = document.getElementById('map-picker-modal');
    if (!modal) return;
    modal.style.display = 'flex';

    if (!_map) {
      /* First open — create the map */
      if (typeof L === 'undefined') {
        alert('Map library not loaded. Check your internet connection and try again.');
        modal.style.display = 'none';
        return;
      }
      _map = L.map('map-picker-map', {
        center,
        zoom,
        zoomControl: false,
        attributionControl: false,
      });
      L.tileLayer(ESRI_TILES, { maxZoom: 19 }).addTo(_map);
      L.control.zoom({ position: 'topright' }).addTo(_map);
      _map.on('move',    updateCoords);
      _map.on('moveend', updateCoords);

      /* Layer groups */
      _propLayer  = L.layerGroup().addTo(_map);
      _zoneLayer  = L.layerGroup().addTo(_map);
      _labelLayer = L.layerGroup().addTo(_map);

      /* Label toggle button */
      addLabelToggle();
    } else {
      _map.setView(center, zoom);
    }

    /* Leaflet needs the container to be visible before sizing correctly */
    setTimeout(() => {
      _map.invalidateSize();
      updateCoords();
      loadBoundaries();
    }, 80);
  }

  /* ── Boundary drawing ── */
  function loadBoundaries() {
    _propLayer.clearLayers();
    _zoneLayer.clearLayers();
    _labelLayer.clearLayers();

    // Property boundary
    const propRaw = localStorage.getItem('fc_property_boundary');
    if (propRaw) {
      try {
        L.geoJSON(JSON.parse(propRaw), {
          style: { color: '#fff', weight: 2, fillOpacity: 0, dashArray: '6 4' },
        }).addTo(_propLayer);
      } catch(e) {}
    }

    // Zone boundaries
    const zoneRaw = localStorage.getItem('fc_zone_boundaries');
    if (!zoneRaw) return;
    let zones;
    try { zones = JSON.parse(zoneRaw); } catch(e) { return; }

    const allZones = App.getZones();
    Object.entries(zones).forEach(([zoneId, geojson]) => {
      const zoneDef = allZones.find(z => z.id === zoneId);
      const isHighlight = _zoneId && zoneId === _zoneId;
      const color = isHighlight ? '#4fc3f7'
                  : (zoneDef?.urgency === 'high' ? '#e53935' : '#4caf50');

      const layer = L.geoJSON(geojson, {
        style: {
          color,
          weight: isHighlight ? 3 : 2,
          fillOpacity: isHighlight ? 0.18 : 0.08,
          fillColor: color,
        },
      });
      layer.addTo(_zoneLayer);

      // Zone label
      const pos = getLabelPos(zoneId, geojson);
      if (pos) {
        const shortLabel = zoneId;
        const marker = L.marker(pos, {
          icon: L.divIcon({
            className: 'zone-label-icon',
            html: shortLabel,
            iconSize: null,
            iconAnchor: [0, 0],
          }),
          interactive: false,
          zIndexOffset: 500,
        });
        marker.addTo(_labelLayer);
      }
    });

    applyLabelVisibility();
    _map.on('zoomend', applyLabelVisibility);
  }

  function getLabelPos(zoneId, geojson) {
    // Check stored labelPos first
    try {
      const stored = JSON.parse(localStorage.getItem('fc_zone_boundaries') || '{}');
      const lp = stored[zoneId]?.properties?.labelPos;
      if (lp) {
        const coords = lp.coords || lp;
        if (Array.isArray(coords)) return coords;
        if (coords.lat != null) return [coords.lat, coords.lng];
      }
    } catch(e) {}
    // Fallback: centroid
    return polygonCentroid(geojson);
  }

  function polygonCentroid(geojson) {
    try {
      let ring;
      const t = geojson.type;
      if (t === 'FeatureCollection') {
        ring = geojson.features[0]?.geometry?.coordinates?.[0];
      } else if (t === 'Feature') {
        ring = geojson.geometry?.coordinates?.[0];
      } else if (t === 'Polygon') {
        ring = geojson.coordinates?.[0];
      } else if (t === 'MultiPolygon') {
        ring = geojson.coordinates?.[0]?.[0];
      }
      if (!ring || ring.length < 3) return null;
      const pts = ring.slice(0, -1);
      let sumLat = 0, sumLng = 0;
      pts.forEach(([lng, lat]) => { sumLat += lat; sumLng += lng; });
      return [sumLat / pts.length, sumLng / pts.length];
    } catch(e) { return null; }
  }

  function applyLabelVisibility() {
    if (!_map) return;
    const zoom = _map.getZoom();
    if (_labelsOn && zoom >= 17) {
      _map.addLayer(_labelLayer);
    } else {
      _map.removeLayer(_labelLayer);
    }
  }

  /* ── Label toggle button ── */
  function addLabelToggle() {
    const btn = L.control({ position: 'topright' });
    btn.onAdd = () => {
      const el = L.DomUtil.create('button', 'leaflet-bar leaflet-control');
      el.title = 'Toggle zone labels';
      el.style.cssText = 'width:30px;height:30px;font-size:16px;cursor:pointer;border:none;background:#fff;display:flex;align-items:center;justify-content:center;';
      el.textContent = '🏷️';
      L.DomEvent.on(el, 'click', e => {
        L.DomEvent.stopPropagation(e);
        _labelsOn = !_labelsOn;
        el.style.opacity = _labelsOn ? '1' : '0.4';
        applyLabelVisibility();
      });
      return el;
    };
    btn.addTo(_map);
  }

  /* ── Point-in-polygon (ray casting) ── */
  function pointInPolygon(lat, lng, geojson) {
    try {
      let rings = [];
      const t = geojson.type;
      if (t === 'FeatureCollection') {
        geojson.features.forEach(f => {
          const g = f.geometry;
          if (g.type === 'Polygon') rings.push(g.coordinates[0]);
          if (g.type === 'MultiPolygon') g.coordinates.forEach(poly => rings.push(poly[0]));
        });
      } else if (t === 'Feature') {
        const g = geojson.geometry;
        if (g.type === 'Polygon') rings.push(g.coordinates[0]);
        if (g.type === 'MultiPolygon') g.coordinates.forEach(poly => rings.push(poly[0]));
      } else if (t === 'Polygon') {
        rings.push(geojson.coordinates[0]);
      } else if (t === 'MultiPolygon') {
        geojson.coordinates.forEach(poly => rings.push(poly[0]));
      }

      return rings.some(ring => raycast(lng, lat, ring));
    } catch(e) { return false; }
  }

  function raycast(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  function close() {
    const modal = document.getElementById('map-picker-modal');
    if (modal) modal.style.display = 'none';
  }

  function confirmLocation() {
    if (!_map || !_callback) { close(); return; }
    const c = _map.getCenter();
    const lat = c.lat.toFixed(6);
    const lng = c.lng.toFixed(6);

    // Zone validation
    if (_zoneId) {
      const zoneRaw = localStorage.getItem('fc_zone_boundaries');
      if (zoneRaw) {
        try {
          const zones = JSON.parse(zoneRaw);
          const zoneGeoJSON = zones[_zoneId];
          if (zoneGeoJSON && !pointInPolygon(parseFloat(lat), parseFloat(lng), zoneGeoJSON)) {
            if (!confirm(`This location appears to be outside Zone ${_zoneId}.\n\nUse it anyway?`)) {
              return; // let user reposition
            }
          }
        } catch(e) {}
      }
    }

    _callback({ lat, lng });
    close();
  }

  function updateCoords() {
    if (!_map) return;
    const c  = _map.getCenter();
    const el = document.getElementById('map-picker-coords');
    if (el) el.textContent = `${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`;
  }

  return { init, open, close };
})();
