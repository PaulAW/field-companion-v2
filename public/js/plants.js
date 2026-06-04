/* plants.js — Species inventory: aggregates all observations by common name */

var Plants = (() => {
  let _obs              = [];
  let _groupBy          = localStorage.getItem('fc_plants_group') || 'status';
  let _sortBy           = localStorage.getItem('fc_plants_sort')  || 'count';
  let _expanded         = new Set(JSON.parse(localStorage.getItem('fc_plants_expanded') || '[]'));
  let _collapsedStatuses = new Set(JSON.parse(localStorage.getItem('fc_plants_collapsed_status') || '[]'));

  const $ = id => document.getElementById(id);

  function init() {
    App.registerTab('plants', { onShow });
  }

  async function onShow() {
    const screensEl = document.getElementById('screens');
    const savedScroll = App.getTabScroll ? App.getTabScroll('plants') : 0;
    try {
      _obs = (await App.getAllObservations()).filter(o => !o.removed);
    } catch(e) {
      _obs = [];
    }
    render();
    // Restore scroll after async render — setTimeout outlasts rAF to survive browser reflow
    if (screensEl && savedScroll) setTimeout(() => { screensEl.scrollTop = savedScroll; }, 60);
  }

  /* ── Aggregate observations by common_name ── */
  function aggregate() {
    const map = {};
    _obs.forEach(o => {
      const key = (o.common_name || 'Unknown').trim();
      if (!map[key]) {
        map[key] = {
          common_name:  key,
          latin_name:   o.latin_name || '',
          native_status: o.native_status || 'Unknown',
          keystone:     o.keystone === 'Yes' || o.keystone === true,
          observations: [],
          zones:        new Set(),
          last_date:    '',
        };
      }
      map[key].observations.push(o);
      if (o.zone) o.zone.split(',').forEach(z => map[key].zones.add(z.trim()));
      if (!map[key].last_date || (o.date && o.date > map[key].last_date)) map[key].last_date = o.date;
    });
    return Object.values(map);
  }

  function sortSpecies(list) {
    return list.slice().sort((a, b) => {
      if (_sortBy === 'count') return b.observations.length - a.observations.length;
      if (_sortBy === 'date')  return (b.last_date || '').localeCompare(a.last_date || '');
      return a.common_name.localeCompare(b.common_name);
    });
  }

  const STATUS_ORDER = ['Native', 'Naturalized', 'Non-native', 'Invasive', 'Unknown'];
  const STATUS_EMOJI = { Native: '🌿', Naturalized: '🔵', 'Non-native': '🟠', Invasive: '🚫', Unknown: '❓' };

  /* ── Render ── */
  function render() {
    const container = $('plants-container');
    if (!container) return;
    const species = sortSpecies(aggregate());
    if (species.length === 0) {
      container.innerHTML = `
        <div class="card" style="text-align:center;padding:32px 16px;color:var(--muted)">
          <div style="font-size:32px;margin-bottom:8px">🌱</div>
          <div style="font-size:14px">No observations yet.</div>
          <div style="font-size:12px;margin-top:4px">Use Plant ID or Log to record plants.</div>
        </div>`;
      return;
    }

    const controls = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
        <div style="display:flex;gap:4px;align-items:center">
          <span style="font-size:11px;color:var(--muted)">Group:</span>
          <button class="btn btn-sm ${_groupBy==='status'?'':'btn-outline'}" data-group="status">By status</button>
          <button class="btn btn-sm ${_groupBy==='all'?'':'btn-outline'}" data-group="all">All</button>
        </div>
        <div style="display:flex;gap:4px;align-items:center">
          <span style="font-size:11px;color:var(--muted)">Sort:</span>
          <button class="btn btn-sm ${_sortBy==='count'?'':'btn-outline'}" data-sort="count">Count</button>
          <button class="btn btn-sm ${_sortBy==='name'?'':'btn-outline'}" data-sort="name">A–Z</button>
          <button class="btn btn-sm ${_sortBy==='date'?'':'btn-outline'}" data-sort="date">Recent</button>
        </div>
        <span style="font-size:11px;color:var(--muted);margin-left:auto">${species.length} species · ${_obs.length} observations</span>
      </div>`;

    let listHTML = '';
    if (_groupBy === 'status') {
      STATUS_ORDER.forEach(status => {
        const group = species.filter(s => s.native_status === status);
        if (!group.length) return;
        const collapsed = _collapsedStatuses.has(status);
        listHTML += `<div class="plants-status-header" data-status-toggle="${esc(status)}" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center">
          <span>${STATUS_EMOJI[status] || ''} ${status} <span style="font-size:11px;font-weight:400;color:var(--muted)">(${group.length})</span></span>
          <span style="font-size:12px">${collapsed ? '▸' : '▾'}</span>
        </div>`;
        if (!collapsed) group.forEach(s => { listHTML += speciesCardHTML(s); });
      });
    } else {
      species.forEach(s => { listHTML += speciesCardHTML(s); });
    }

    container.innerHTML = controls + listHTML;

    // Wire controls
    container.querySelectorAll('[data-group]').forEach(btn =>
      btn.addEventListener('click', () => { _groupBy = btn.dataset.group; localStorage.setItem('fc_plants_group', _groupBy); render(); }));
    container.querySelectorAll('[data-sort]').forEach(btn =>
      btn.addEventListener('click', () => { _sortBy = btn.dataset.sort; localStorage.setItem('fc_plants_sort', _sortBy); render(); }));
    container.querySelectorAll('[data-status-toggle]').forEach(hd =>
      hd.addEventListener('click', () => {
        const s = hd.dataset.statusToggle;
        if (_collapsedStatuses.has(s)) _collapsedStatuses.delete(s); else _collapsedStatuses.add(s);
        localStorage.setItem('fc_plants_collapsed_status', JSON.stringify([..._collapsedStatuses]));
        render();
      }));

    // Wire species cards
    container.querySelectorAll('.plants-species-card').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.closest('button')) return;
        const key = card.dataset.species;
        if (_expanded.has(key)) _expanded.delete(key); else _expanded.add(key);
        localStorage.setItem('fc_plants_expanded', JSON.stringify([..._expanded]));
        const detail = card.querySelector('.plants-obs-list');
        if (detail) detail.style.display = _expanded.has(key) ? 'block' : 'none';
        const chevron = card.querySelector('.plants-chevron');
        if (chevron) chevron.textContent = _expanded.has(key) ? '▾' : '▸';
      });
    });

    // Wire "Log" buttons — open that observation in the Log edit form
    container.querySelectorAll('[data-obs-log]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const obsId = parseInt(btn.dataset.obsLog);
        const obs   = _obs.find(o => o.id === obsId);
        if (obs && window.Logger && Logger.editObservation) Logger.editObservation(obs);
      });
    });
  }

  function speciesCardHTML(s) {
    const key      = s.common_name;
    const isOpen   = _expanded.has(key);
    const badgeMap = { Native: 'badge-native', Invasive: 'badge-invasive', 'Non-native': 'badge-nonnative', Naturalized: 'badge-naturalized', Unknown: 'badge-zone' };
    const badge    = `<span class="badge ${badgeMap[s.native_status] || 'badge-zone'}" style="font-size:10px">${esc(s.native_status)}</span>`;
    const keystone = s.keystone ? '<span class="badge badge-keystone" style="font-size:10px">⭐ Keystone</span>' : '';
    const zones    = [...s.zones].sort().join(', ');
    const last     = s.last_date ? App.formatDate(s.last_date) : '';

    const obsList = s.observations.map(o => {
      const d = o.date ? App.formatDate(o.date) : '';
      return `<div style="font-size:11px;padding:5px 0;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:flex-start">
        <div style="flex:1">
          ${d ? `<span style="color:var(--muted)">${esc(d)}</span> · ` : ''}
          ${o.zone ? `Zone ${esc(o.zone)} · ` : ''}
          ${o.action_needed ? esc(o.action_needed.substring(0, 80)) : '<em style="color:var(--muted)">No action noted</em>'}
        </div>
        <button class="btn btn-sm btn-outline" data-obs-log="${o.id}" style="font-size:10px;padding:2px 7px;flex-shrink:0">Log</button>
      </div>`;
    }).join('');

    return `<div class="plants-species-card card" data-species="${esc(key)}" style="margin-bottom:8px;cursor:pointer">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:14px">${esc(s.common_name)}</div>
          ${s.latin_name ? `<div style="font-size:11px;color:var(--muted);font-style:italic">${esc(s.latin_name)}</div>` : ''}
          <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">${badge}${keystone}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:4px">
            ${s.observations.length} obs${s.observations.length !== 1 ? '' : ''}
            ${zones ? ' · Zones ' + esc(zones) : ''}
            ${last ? ' · Last ' + esc(last) : ''}
          </div>
        </div>
        <span class="plants-chevron" style="color:var(--muted);font-size:14px;flex-shrink:0;padding-top:2px">${isOpen ? '▾' : '▸'}</span>
      </div>
      <div class="plants-obs-list" style="display:${isOpen ? 'block' : 'none'};margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
        ${obsList}
      </div>
    </div>`;
  }

  function esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  return { init };
})();
