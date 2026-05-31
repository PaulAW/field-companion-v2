/* app.js — Field Companion core: routing, data loading, IndexedDB, toast, offline */

const APP_BUILD = '2026-05-30-e';   // bump this letter each deploy for version tracking

const App = (() => {
  let _zones = [];
  let _tasks = {};
  let _driveLinks = {};
  let _propertyCtx = {};
  let _db = null;

  /* ── IndexedDB ── */
  function initDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('field-companion', 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('observations')) {
          const store = db.createObjectStore('observations', { keyPath: 'id', autoIncrement: true });
          store.createIndex('date',  'date',  { unique: false });
          store.createIndex('zone',  'zone',  { unique: false });
        }
      };
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  function getDB() { return _db; }

  function saveObservation(obs) {
    if (!_db) return Promise.reject(new Error('Database not ready'));
    return new Promise((resolve, reject) => {
      const tx = _db.transaction('observations', 'readwrite');
      const req = tx.objectStore('observations').add({ ...obs, created_at: Date.now() });
      req.onsuccess = e => {
        const localId = e.target.result;
        // Push to cloud immediately in background if signed in
        if (window.Auth && Auth.isSignedIn() && window.Sync) {
          Sync.push().catch(console.warn);
        }
        resolve(localId);
      };
      req.onerror = e => reject(e.target.error);
    });
  }

  function getAllObservations() {
    if (!_db) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const tx = _db.transaction('observations', 'readonly');
      const req = tx.objectStore('observations').getAll();
      req.onsuccess = e => resolve(e.target.result.reverse());
      req.onerror   = e => reject(e.target.error);
    });
  }

  function getObservationsByZone(zone) {
    if (!_db) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const tx = _db.transaction('observations', 'readonly');
      const idx = tx.objectStore('observations').index('zone');
      const req = idx.getAll(zone);
      req.onsuccess = e => resolve(e.target.result.reverse());
      req.onerror   = e => reject(e.target.error);
    });
  }

  function deleteObservation(id) {
    if (!_db) return Promise.reject(new Error('Database not ready'));
    return new Promise((resolve, reject) => {
      const tx = _db.transaction('observations', 'readwrite');
      const req = tx.objectStore('observations').delete(id);
      req.onsuccess = () => {
        // Push deletion to cloud in background if signed in
        if (window.Auth && Auth.isSignedIn() && window.Sync) {
          Sync.push().catch(console.warn);
        }
        resolve();
      };
      req.onerror = e => reject(e.target.error);
    });
  }

  function updateObservation(id, data) {
    if (!_db) return Promise.reject(new Error('Database not ready'));
    return new Promise((resolve, reject) => {
      const tx = _db.transaction('observations', 'readwrite');
      const store = tx.objectStore('observations');
      const getReq = store.get(id);
      getReq.onsuccess = e => {
        const existing = e.target.result;
        if (!existing) { reject(new Error('Observation not found')); return; }
        const updated = { ...existing, ...data, modified_at: Date.now() };
        const putReq = store.put(updated);
        putReq.onsuccess = () => {
          if (window.Auth && Auth.isSignedIn() && window.Sync) {
            Sync.push().catch(console.warn);
          }
          resolve();
        };
        putReq.onerror = e => reject(e.target.error);
      };
      getReq.onerror = e => reject(e.target.error);
    });
  }

  async function getPendingSyncCount() {
    const all = await getAllObservations();
    return all.filter(o => !o.cloud_id).length;
  }

  /* ── JSON data loaders ── */
  async function loadJSON(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`Failed to load ${path}`);
    return res.json();
  }

  async function loadAllData() {
    const base = 'js/data/';
    const [zones, tasks, driveLinks, ctx] = await Promise.all([
      loadJSON(base + 'zones.json'),
      loadJSON(base + 'tasks.json'),
      loadJSON(base + 'drive-links.json'),
      loadJSON(base + 'property-context.json'),
    ]);
    _zones      = zones;
    _tasks      = tasks;
    _driveLinks = driveLinks;
    _propertyCtx = ctx;
  }

  function getZones()       { return _zones; }
  function getZone(id)      { return _zones.find(z => z.id === id); }
  function getTasks()       { return _tasks; }
  function getDriveLinks()  { return _driveLinks; }
  function getPropertyCtx() { return _propertyCtx; }

  /* ── API key ── */
  function getApiKey()        { return localStorage.getItem('fc_api_key') || ''; }
  function setApiKey(key)     { localStorage.setItem('fc_api_key', key.trim()); }
  function clearApiKey()      { localStorage.removeItem('fc_api_key'); }

  /* ── Confidence threshold ── */
  function getConfidenceThreshold() { return localStorage.getItem('fc_confidence_threshold') || 'Medium'; }
  function setConfidenceThreshold(val) { localStorage.setItem('fc_confidence_threshold', val); }

  /* ── Tab routing ── */
  let _currentTab = 'plant-id';
  const _tabModules = {};

  function registerTab(id, mod) { _tabModules[id] = mod; }

  function switchTab(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    const screen = document.getElementById('screen-' + id);
    const btn    = document.querySelector(`[data-tab="${id}"]`);
    if (screen) screen.classList.add('active');
    if (btn)    btn.classList.add('active');
    _currentTab = id;
    if (_tabModules[id] && _tabModules[id].onShow) _tabModules[id].onShow();
  }

  /* ── Offline detection ── */
  function updateOnlineStatus() {
    const banner = document.getElementById('offline-banner');
    if (!navigator.onLine) {
      banner.classList.add('show');
    } else {
      banner.classList.remove('show');
    }
  }

  /* ── Toast notifications ── */
  let _toastTimer = null;
  function toast(msg, duration = 2500) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.remove('show'), duration);
  }

  /* ── Settings panel ── */
  function openSettings() {
    document.getElementById('settings-panel').classList.add('open');
    renderSettings();
  }
  function closeSettings() {
    document.getElementById('settings-panel').classList.remove('open');
    // Re-fire onShow for the active tab so API key warning refreshes
    if (_tabModules[_currentTab] && _tabModules[_currentTab].onShow) {
      _tabModules[_currentTab].onShow();
    }
  }

  function renderSettings() {
    if (window.Auth && Auth.renderAuthUI) Auth.renderAuthUI();
    const key = getApiKey();
    document.getElementById('api-key-input').value = key ? '••••••••••••••••' : '';
    document.getElementById('api-key-status').textContent = key
      ? '✓ API key saved on this device'
      : '⚠ No API key set — Plant ID disabled';
    document.getElementById('api-key-status').className = key ? 'alert alert-ok' : 'alert alert-warn';

    const ctx = getPropertyCtx();
    document.getElementById('settings-version').textContent = ctx.owner
      ? `${ctx.owner} · ${ctx.location} (${ctx.zip})`
      : 'Field Companion v2.0';

    const threshold = getConfidenceThreshold();
    ['High', 'Medium', 'Any'].forEach(val => {
      const pill = document.getElementById('conf-pill-' + val.toLowerCase());
      if (pill) pill.classList.toggle('selected', threshold === val);
    });
  }

  function setupSettings() {
    document.getElementById('settings-btn').addEventListener('click', openSettings);
    document.getElementById('settings-close').addEventListener('click', closeSettings);
    document.getElementById('settings-panel').addEventListener('click', e => {
      if (e.target === document.getElementById('settings-panel')) closeSettings();
    });

    document.getElementById('api-key-save').addEventListener('click', () => {
      const input = document.getElementById('api-key-input');
      const val = input.value.trim();
      if (val && !val.startsWith('••')) {
        setApiKey(val);
        input.value = '';
        toast('API key saved ✓');
        renderSettings();
      } else if (!val) {
        toast('Enter your API key first');
      }
    });

    document.getElementById('api-key-clear').addEventListener('click', () => {
      if (confirm('Remove saved API key? Plant ID will stop working until you add a new one.')) {
        clearApiKey();
        document.getElementById('api-key-input').value = '';
        renderSettings();
        toast('API key removed');
      }
    });

    ['High', 'Medium', 'Any'].forEach(val => {
      const pill = document.getElementById('conf-pill-' + val.toLowerCase());
      if (!pill) return;
      pill.addEventListener('click', () => {
        setConfidenceThreshold(val);
        renderSettings();
        toast('Confidence threshold updated');
      });
    });
  }

  /* ── Service Worker registration ── */
  function registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js').catch(console.warn);
    }
  }

  /* ── Date helpers ── */
  function todayISO() {
    return new Date().toISOString().split('T')[0];
  }

  function formatDate(iso) {
    const [y, m, d] = iso.split('-');
    return `${m}/${d}/${y}`;
  }

  /* ── CSV helpers ── */
  function obsToCSVRow(obs) {
    const fields = [
      obs.date, obs.zone,
      obs.lat || '', obs.lng || '',
      obs.location_desc || '',
      obs.common_name || '', obs.latin_name || '',
      obs.native_status || '', obs.keystone || 'No',
      obs.observation_type || '', obs.action_needed || '',
      '', 'Paul', obs.notes || ''
    ];
    return fields.map(f => {
      const s = String(f);
      return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',');
  }

  function obsArrayToCSV(list) {
    const header = 'Date,Zone,Lat,Lng,Location,Common Name,Latin Name,Native,Keystone,Type,Action,Photo,Logged By,Notes';
    return [header, ...list.map(obsToCSVRow)].join('\n');
  }

  function copyToClipboard(text) {
    if (navigator.clipboard) {
      return navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard ✓'));
    }
    const el = document.createElement('textarea');
    el.value = text; document.body.appendChild(el);
    el.select(); document.execCommand('copy');
    document.body.removeChild(el);
    toast('Copied to clipboard ✓');
  }

  function downloadCSV(content, filename) {
    const blob = new Blob([content], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /* ── Init ── */
  async function init() {
    // DB init runs in background — don't block UI on IndexedDB (can hang on mobile)
    initDB().catch(err => console.warn('Field Companion: IndexedDB unavailable:', err));

    try {
      await loadAllData();
    } catch (err) {
      console.error('Field Companion: data load error:', err);
    }

    window.addEventListener('online',  updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    updateOnlineStatus();

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    try { setupSettings(); }
    catch (e) { console.error('Field Companion: setupSettings failed:', e); }

    try { registerSW(); }
    catch (e) { console.error('Field Companion: registerSW failed:', e); }

    if (window.MapPicker) {
      try { MapPicker.init(); } catch(e) { console.error('Field Companion: MapPicker init failed:', e); }
    }

    const mods = [
      ['Auth',         window.Auth],
      ['PlantID',      window.PlantID],
      ['Logger',       window.Logger],
      ['Zones',        window.Zones],
      ['Tasks',        window.Tasks],
      ['PropertyMap',  window.PropertyMap],
      ['Drive',        window.Drive],
    ];
    for (const [name, mod] of mods) {
      if (mod) {
        try { mod.init(); }
        catch (e) { console.error('Field Companion:', name, 'init failed:', e); }
      }
    }

    // Kick off a background sync if signed in
    if (window.Auth && window.Sync && Auth.isSignedIn()) {
      setTimeout(() => Sync.fullSync().catch(console.warn), 2000);
    }

    const buildEl = document.getElementById('app-build');
    if (buildEl) buildEl.textContent = APP_BUILD;

    switchTab('plant-id');
  }

  return {
    init,
    getDB, saveObservation, updateObservation, getAllObservations, getObservationsByZone, deleteObservation, getPendingSyncCount,
    getZones, getZone, getTasks, getDriveLinks, getPropertyCtx,
    getApiKey, setApiKey,
    getConfidenceThreshold, setConfidenceThreshold,
    registerTab, switchTab,
    toast,
    todayISO, formatDate,
    obsToCSVRow, obsArrayToCSV, copyToClipboard, downloadCSV,
    openSettings, closeSettings,
  };
})();

document.addEventListener('DOMContentLoaded', App.init);
