/* map-picker.js — Shared Leaflet map picker modal for GPS location selection */

var MapPicker = (() => {
  let _map      = null;
  let _callback = null;

  const ESRI_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const DEFAULT_CENTER = [41.0686, -91.9694];
  const DEFAULT_ZOOM   = 17;

  function init() {
    const cancelBtn = document.getElementById('map-picker-cancel');
    const useBtn    = document.getElementById('map-picker-use');
    if (cancelBtn) cancelBtn.addEventListener('click', close);
    if (useBtn)    useBtn.addEventListener('click', confirmLocation);
  }

  function open(opts) {
    opts = opts || {};
    _callback = opts.onSelect || null;

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
      _map.on('move', updateCoords);
      _map.on('moveend', updateCoords);
    } else {
      _map.setView(center, zoom);
    }

    /* Leaflet needs the container to be visible before sizing correctly */
    setTimeout(() => {
      _map.invalidateSize();
      updateCoords();
    }, 80);
  }

  function close() {
    const modal = document.getElementById('map-picker-modal');
    if (modal) modal.style.display = 'none';
  }

  function confirmLocation() {
    if (!_map || !_callback) { close(); return; }
    const c = _map.getCenter();
    _callback({ lat: c.lat.toFixed(6), lng: c.lng.toFixed(6) });
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
