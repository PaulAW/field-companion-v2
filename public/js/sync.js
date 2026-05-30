/* sync.js — Cloud sync: push local observations to D1, pull remote to IndexedDB */

var Sync = (() => {
  const BACKEND   = 'https://field-companion-backend.paulwiner5.workers.dev';
  const LAST_SYNC = 'fc_last_sync';

  let _syncing = false;

  function authHeader() {
    const tok = Auth.getToken();
    return tok ? { Authorization: 'Bearer ' + tok } : {};
  }

  /* ── Status message helpers ── */
  function setStatus(msg) {
    const el = document.getElementById('sync-status-msg');
    if (el) el.textContent = msg;
  }

  /* ── Push: upload all local observations that have no cloud_id ── */
  async function push() {
    if (!Auth.isSignedIn() || _syncing) return;
    _syncing = true;
    setStatus('Syncing…');
    try {
      const local = await App.getAllObservations();
      const unsynced = local.filter(o => !o.cloud_id);
      if (unsynced.length === 0) { setStatus('Up to date'); _syncing = false; return; }

      // Attach a client_id to each unsynced observation (use local id as client_id)
      const payload = unsynced.map(o => ({
        ...o,
        client_id: String(o.id), // stable dedup key
      }));

      const res = await fetch(BACKEND + '/observations/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Sync push failed: ' + res.status);
      const data = await res.json();
      setStatus(`Pushed ${data.upserted} observation${data.upserted !== 1 ? 's' : ''}`);
    } catch(e) {
      setStatus('Sync error: ' + e.message);
      console.warn('Sync push error:', e);
    } finally {
      _syncing = false;
    }
  }

  /* ── Pull: fetch remote observations newer than last sync, upsert to IndexedDB ── */
  async function pull() {
    if (!Auth.isSignedIn()) return;
    setStatus('Checking for updates…');
    try {
      const lastSync = localStorage.getItem(LAST_SYNC) || '0';
      const res = await fetch(BACKEND + '/observations?since=' + lastSync, {
        headers: authHeader(),
      });
      if (!res.ok) throw new Error('Pull failed: ' + res.status);
      const remote = await res.json();

      if (remote.length === 0) { setStatus('Up to date'); return; }

      // Upsert each remote observation into local IndexedDB
      // We don't want duplicates — check by (date, zone, common_name) or cloud_id
      const local  = await App.getAllObservations();
      const localKeys = new Set(local.map(o => `${o.date}|${o.zone}|${(o.common_name||'').toLowerCase()}`));

      let added = 0;
      for (const rObs of remote) {
        const key = `${rObs.date}|${rObs.zone}|${(rObs.common_name||'').toLowerCase()}`;
        if (localKeys.has(key)) continue; // already have it

        // Map cloud observation to local schema
        const obs = {
          date:             rObs.date,
          zone:             rObs.zone,
          lat:              rObs.lat || '',
          lng:              rObs.lng || '',
          location_desc:    rObs.location_desc || '',
          common_name:      rObs.common_name,
          latin_name:       rObs.latin_name || '',
          native_status:    rObs.native_status || 'Unknown',
          keystone:         rObs.keystone || 'No',
          observation_type: rObs.observation_type || '',
          action_needed:    rObs.action_needed || '',
          notes:            rObs.notes || '',
          ai_identified:    !!rObs.ai_identified,
          cloud_id:         rObs.id,
        };
        try {
          await App.saveObservation(obs);
          localKeys.add(key);
          added++;
        } catch(e) { /* skip */ }
      }

      localStorage.setItem(LAST_SYNC, Math.floor(Date.now() / 1000));
      setStatus(added > 0 ? `Pulled ${added} new observation${added !== 1 ? 's' : ''}` : 'Up to date');

      if (added > 0) {
        App.toast(`Synced ${added} observation${added !== 1 ? 's' : ''} from cloud ✓`);
        // Refresh any visible lists
        if (window.Logger && Logger.refreshIfVisible) Logger.refreshIfVisible();
        if (window.PropertyMap && PropertyMap.refreshIfVisible) PropertyMap.refreshIfVisible();
      }
    } catch(e) {
      setStatus('Sync error: ' + e.message);
      console.warn('Sync pull error:', e);
    }
  }

  /* ── Push boundaries to cloud ── */
  async function pushBoundaries() {
    if (!Auth.isSignedIn()) return;
    try {
      // Property boundary
      const propRaw = localStorage.getItem('fc_property_boundary');
      if (propRaw) {
        await fetch(BACKEND + '/boundaries', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...authHeader() },
          body: JSON.stringify({ type: 'property', zone_id: null, geojson: JSON.parse(propRaw) }),
        });
      }
      // Zone boundaries
      const zoneRaw = localStorage.getItem('fc_zone_boundaries');
      if (zoneRaw) {
        const zones = JSON.parse(zoneRaw);
        for (const [zoneId, geojson] of Object.entries(zones)) {
          await fetch(BACKEND + '/boundaries', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...authHeader() },
            body: JSON.stringify({ type: 'zone', zone_id: zoneId, geojson }),
          });
        }
      }
    } catch(e) {
      console.warn('Boundary push error:', e);
    }
  }

  /* ── Pull boundaries from cloud into localStorage ── */
  async function pullBoundaries() {
    if (!Auth.isSignedIn()) return;
    try {
      const res = await fetch(BACKEND + '/boundaries', { headers: authHeader() });
      if (!res.ok) return;
      const rows = await res.json();
      if (!rows.length) return;

      const propRow = rows.find(r => r.type === 'property');
      if (propRow) {
        localStorage.setItem('fc_property_boundary', propRow.geojson);
      }

      const zoneRows = rows.filter(r => r.type === 'zone');
      if (zoneRows.length) {
        const existing = JSON.parse(localStorage.getItem('fc_zone_boundaries') || '{}');
        zoneRows.forEach(r => {
          existing[r.zone_id] = JSON.parse(r.geojson);
        });
        localStorage.setItem('fc_zone_boundaries', JSON.stringify(existing));
      }
    } catch(e) {
      console.warn('Boundary pull error:', e);
    }
  }

  /* ── Full sync (push then pull) ── */
  async function fullSync() {
    await push();
    await pull();
    await pushBoundaries();
    await pullBoundaries();
  }

  return { push, pull, pushBoundaries, pullBoundaries, fullSync };
})();
