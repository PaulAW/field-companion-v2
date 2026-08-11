/* app.js — Field Companion core: routing, data loading, IndexedDB, toast, offline */

const APP_BUILD = '2026-08-11-a';   // bump this letter each deploy for version tracking

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
        // Clear cloud_id so the updated record gets re-pushed to cloud
        const updated = { ...existing, ...data, modified_at: Date.now(), cloud_id: null };
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

  function markObservationsSynced(ids) {
    if (!_db || !ids.length) return Promise.resolve();
    return new Promise(resolve => {
      const tx = _db.transaction('observations', 'readwrite');
      const store = tx.objectStore('observations');
      let pending = ids.length;
      const done = () => { if (--pending === 0) resolve(); };
      ids.forEach(id => {
        const req = store.get(id);
        req.onsuccess = e => {
          const rec = e.target.result;
          if (rec) { rec.cloud_id = 'synced'; store.put(rec); }
          done();
        };
        req.onerror = done;
      });
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

  function getCustomZones() {
    try { return JSON.parse(localStorage.getItem('fc_custom_zones') || '[]'); } catch { return []; }
  }
  function saveCustomZone(zone) {
    const existing = getCustomZones().filter(z => z.id !== zone.id);
    existing.push(zone);
    localStorage.setItem('fc_custom_zones', JSON.stringify(existing));
  }
  function getZones()  { return [..._zones, ...getCustomZones().filter(c => !_zones.find(z => z.id === c.id))]; }
  function getZone(id) { return getZones().find(z => z.id === id); }
  function getTasks()       { return _tasks; }
  function getDriveLinks()  { return _driveLinks; }
  function getPropertyCtx() { return _propertyCtx; }

  /* ── API key ── */
  function getApiKey()        { return localStorage.getItem('fc_api_key') || ''; }
  function setApiKey(key)     { localStorage.setItem('fc_api_key', key.trim()); }
  function clearApiKey()      { localStorage.removeItem('fc_api_key'); }

  /* ── PlantNet API key ── */
  function getPlantNetKey()    { return localStorage.getItem('fc_plantnet_key') || ''; }
  function setPlantNetKey(key) { localStorage.setItem('fc_plantnet_key', key.trim()); }
  function clearPlantNetKey()  { localStorage.removeItem('fc_plantnet_key'); }

  /* ── Confidence threshold ── */
  function getConfidenceThreshold() { return localStorage.getItem('fc_confidence_threshold') || 'Medium'; }
  function setConfidenceThreshold(val) { localStorage.setItem('fc_confidence_threshold', val); }

  /* ── Tab routing ── */
  let _currentTab = 'plant-id';
  const _tabModules  = {};
  const _tabScroll   = {};          // saved scrollTop per tab id
  const TAB_ORDER    = ['plant-id','log','zones','tasks','map','plants','drive'];

  function registerTab(id, mod) { _tabModules[id] = mod; }

  function switchTab(id) {
    // Save scroll position of current tab
    const screensEl = document.getElementById('screens');
    if (screensEl) _tabScroll[_currentTab] = screensEl.scrollTop;

    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    const screen = document.getElementById('screen-' + id);
    const btn    = document.querySelector(`[data-tab="${id}"]`);
    if (screen) screen.classList.add('active');
    if (btn)    btn.classList.add('active');
    _currentTab = id;
    if (_tabModules[id] && _tabModules[id].onShow) _tabModules[id].onShow();

    // Restore saved scroll position (after content renders)
    if (screensEl) {
      requestAnimationFrame(() => {
        screensEl.scrollTop = _tabScroll[id] || 0;
      });
    }
  }

  function initSwipeNav() {
    const screensEl = document.getElementById('screens');
    if (!screensEl) return;
    let startX = 0, startY = 0;
    screensEl.addEventListener('touchstart', e => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }, { passive: true });
    screensEl.addEventListener('touchend', e => {
      if (_currentTab === 'map') return;   // map needs swipe for panning
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      // Require a clear horizontal swipe (min 70px, more horizontal than vertical)
      if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const idx = TAB_ORDER.indexOf(_currentTab);
      if (dx < 0 && idx < TAB_ORDER.length - 1) switchTab(TAB_ORDER[idx + 1]);
      if (dx > 0 && idx > 0)                    switchTab(TAB_ORDER[idx - 1]);
    }, { passive: true });
  }

  /* ── Sync status dot ──
     red = offline (can't sync no matter what)
     yellow = online but not signed in (could sync, isn't)
     green = online and signed in (syncing/current) */
  function updateSyncStatusDot() {
    const dot = document.getElementById('sync-status-dot');
    if (!dot) return;
    const signedIn = !!(window.Auth && Auth.isSignedIn());
    let cls, label;
    if (!navigator.onLine) {
      cls = 'dot-red'; label = '📵 Offline — Plant ID unavailable, other tabs still work.';
    } else if (!signedIn) {
      cls = 'dot-yellow';
      const last = window.Auth && Auth.getLastUser && Auth.getLastUser();
      label = last
        ? `Online, not signed in — sign back in as ${last.name || last.email} to resume syncing.`
        : 'Online, not signed in — sign in via Settings to sync across devices.';
    } else {
      cls = 'dot-green'; label = 'Online and signed in — syncing.';
    }
    dot.classList.remove('dot-red', 'dot-yellow', 'dot-green');
    dot.classList.add(cls);
    dot.title = label;
    dot.setAttribute('aria-label', label);
  }

  /* Reconnecting while signed in should sync automatically — no manual
     "Sync now" required. Silent if there's nothing new (Sync/Tasks already
     toast on anything actually pulled). */
  function handleOnlineChange() {
    updateSyncStatusDot();
    if (navigator.onLine && window.Auth && Auth.isSignedIn()) {
      if (window.Sync) Sync.fullSync().catch(console.warn);
      if (window.Tasks && Tasks.refresh) Tasks.refresh();
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

    const pnKey = getPlantNetKey();
    const pnInput  = document.getElementById('plantnet-key-input');
    const pnStatus = document.getElementById('plantnet-key-status');
    if (pnInput)  pnInput.value = pnKey ? '••••••••••••••••' : '';
    if (pnStatus) {
      pnStatus.textContent  = pnKey ? '✓ PlantNet key saved — hybrid ID enabled' : '⚠ No PlantNet key — Claude-only ID';
      pnStatus.className    = pnKey ? 'alert alert-ok' : 'alert alert-warn';
    }

    const threshold = getConfidenceThreshold();
    ['High', 'Medium', 'Any'].forEach(val => {
      const pill = document.getElementById('conf-pill-' + val.toLowerCase());
      if (pill) pill.classList.toggle('selected', threshold === val);
    });
  }

  function setupSettings() {
    document.getElementById('settings-btn').addEventListener('click', openSettings);
    const statusDot = document.getElementById('sync-status-dot');
    if (statusDot) statusDot.addEventListener('click', () => {
      // title/hover doesn't work on touch devices — show the same text as a toast
      if (statusDot.title) toast(statusDot.title, 3500);
      openSettings();
    });
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

    document.getElementById('plantnet-key-save').addEventListener('click', () => {
      const input = document.getElementById('plantnet-key-input');
      const val = input.value.trim();
      if (val && !val.startsWith('••')) {
        setPlantNetKey(val);
        input.value = '';
        toast('PlantNet key saved ✓');
        renderSettings();
      } else if (!val) {
        toast('Enter your PlantNet key first');
      }
    });

    document.getElementById('plantnet-key-clear').addEventListener('click', () => {
      if (confirm('Remove PlantNet key? Plant ID will use Claude only.')) {
        clearPlantNetKey();
        document.getElementById('plantnet-key-input').value = '';
        renderSettings();
        toast('PlantNet key removed');
      }
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
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
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

    window.addEventListener('online',  handleOnlineChange);
    window.addEventListener('offline', handleOnlineChange);
    updateSyncStatusDot();

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
      ['Plants',       window.Plants],
      ['Drive',        window.Drive],
    ];
    for (const [name, mod] of mods) {
      if (mod) {
        try { mod.init(); }
        catch (e) { console.error('Field Companion:', name, 'init failed:', e); }
      }
    }

    // Verify stored session token is still valid; if it expired, clear it cleanly.
    // After verification, re-run onShow on Tasks so cloudMode is set correctly.
    if (window.Auth && Auth.isSignedIn()) {
      Auth.verifySession().then(stillValid => {
        if (!stillValid) {
          // Token expired — re-render Tasks in local mode with correct state
          if (window.Tasks) Tasks.init && Tasks.init();
        }
        // Kick off background sync if still signed in
        if (window.Sync && Auth.isSignedIn()) {
          setTimeout(() => Sync.fullSync().catch(console.warn), 2000);
        }
        updateSyncStatusDot();
      }).catch(console.warn);
    }

    const buildEl = document.getElementById('app-build');
    if (buildEl) buildEl.textContent = APP_BUILD;

    initSwipeNav();
    switchTab('plant-id');
  }

  return {
    init,
    getDB, saveObservation, updateObservation, getAllObservations, getObservationsByZone, deleteObservation, getPendingSyncCount, markObservationsSynced,
    getZones, getZone, saveCustomZone, getTasks, getDriveLinks, getPropertyCtx,
    getApiKey, setApiKey,
    getPlantNetKey, setPlantNetKey, clearPlantNetKey,
    getConfidenceThreshold, setConfidenceThreshold,
    registerTab, switchTab, getTabScroll: id => _tabScroll[id] || 0,
    toast, updateSyncStatusDot,
    todayISO, formatDate,
    obsToCSVRow, obsArrayToCSV, copyToClipboard, downloadCSV,
    openSettings, closeSettings,
  };
})();

document.addEventListener('DOMContentLoaded', App.init);
