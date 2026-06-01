/* plant-id.js — Camera capture, Claude API call, result display */

var PlantID = (() => {
  let _photoBase64      = null;
  let _photoType        = 'image/jpeg';
  let _gpsCoords        = null;
  let _lastResult       = null;
  let _supplementalPhotos   = [];  // extra photos for low-confidence re-submission
  let _supplementalOrgans   = [];  // organ type per supplemental photo
  let _lastZone             = '';
  let _lastNotes            = '';
  let _plantNetCandidates   = null; // top-3 PlantNet results for hybrid flow
  let _selectedOrgan        = null; // organ type for primary photo

  const $ = id => document.getElementById(id);

  function init() {
    App.registerTab('plant-id', { onShow });
    setupPhotoInput();
    setupOrganSelect();
    setupGPS();
    setupZoneSelect();
    setupIdentifyBtn();
    renderApiKeyWarning();
    restorePhotoIfNeeded();
  }

  function restorePhotoIfNeeded() {
    try {
      const saved = sessionStorage.getItem('fc_photo_b64');
      if (!saved) return;
      _photoBase64 = saved;
      _photoType   = 'image/jpeg';
      const preview = $('pid-photo-preview');
      if (preview) {
        preview.src = 'data:image/jpeg;base64,' + saved;
        preview.style.display = 'block';
      }
      const organSection = $('pid-organ-section');
      if (organSection) organSection.style.display = 'block';
      updateIdentifyBtn();
    } catch(e) {}
  }

  function onShow() {
    renderApiKeyWarning();
    populateZoneSelect();
  }

  /* ── API key warning ── */
  function renderApiKeyWarning() {
    const warn = $('pid-apikey-warn');
    if (!warn) return;
    warn.style.display = App.getApiKey() ? 'none' : 'block';
  }

  /* ── Zone select ── */
  function populateZoneSelect() {
    const sel = $('pid-zone');
    if (!sel) return;
    const zones = App.getZones();
    const current = sel.value;
    sel.innerHTML = '<option value="">— select zone —</option>';
    zones.forEach(z => {
      const opt = document.createElement('option');
      opt.value = z.id;
      opt.textContent = `Zone ${z.id} – ${z.name}`;
      if (z.id === current) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  function setupZoneSelect() { populateZoneSelect(); }

  /* ── Organ selector ── */
  function setupOrganSelect() {
    const pills = document.querySelectorAll('#pid-organ-pills .organ-pill');
    pills.forEach(pill => {
      pill.addEventListener('click', () => {
        pills.forEach(p => p.classList.remove('selected'));
        pill.classList.add('selected');
        _selectedOrgan = pill.dataset.organ;
        updateIdentifyBtn();
      });
    });
  }

  function resetOrganSelect() {
    _selectedOrgan = null;
    document.querySelectorAll('#pid-organ-pills .organ-pill').forEach(p => p.classList.remove('selected'));
    const section = $('pid-organ-section');
    if (section) section.style.display = 'none';
  }

  /* ── Image compression ── */
  function compressImage(dataUrl, maxPx, quality) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxPx || h > maxPx) {
          if (w > h) { h = Math.round(h * maxPx / w); w = maxPx; }
          else        { w = Math.round(w * maxPx / h); h = maxPx; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = dataUrl;
    });
  }

  /* ── Photo input ── */
  function setupPhotoInput() {
    async function handleFile(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async ev => {
        const compressed = await compressImage(ev.target.result, 2000, 0.95);
        _photoBase64 = compressed.split(',')[1];
        _photoType   = 'image/jpeg';
        const preview = $('pid-photo-preview');
        preview.src  = compressed;
        preview.style.display = 'block';
        try { sessionStorage.setItem('fc_photo_b64', _photoBase64); } catch(e) {}
        // Show organ selector — reset any previous selection
        resetOrganSelect();
        const organSection = $('pid-organ-section');
        if (organSection) organSection.style.display = 'block';
        updateIdentifyBtn();
      };
      reader.readAsDataURL(file);
    }

    const cam = $('pid-camera-input');
    const gal = $('pid-gallery-input');
    if (cam) cam.addEventListener('change', handleFile);
    if (gal) gal.addEventListener('change', handleFile);
  }

  /* ── GPS ── */
  function setupGPS() {
    const btn = $('pid-gps-btn');
    if (btn) btn.addEventListener('click', captureGPS);

    const pickBtn = $('pid-pick-on-map');
    if (pickBtn) pickBtn.addEventListener('click', openMapPicker);

    const refineLink = $('pid-refine-map');
    if (refineLink) refineLink.addEventListener('click', openMapPicker);
  }

  function openMapPicker() {
    if (window.MapPicker) {
      const ctx = App.getPropertyCtx();
      const center = ctx.map_center || {};
      MapPicker.open({
        lat:  _gpsCoords ? _gpsCoords.lat : (center.lat || 41.0686),
        lng:  _gpsCoords ? _gpsCoords.lng : (center.lng || -91.9694),
        zone: $('pid-zone').value || null,
        onSelect: coords => setGPSCoords(coords),
      });
    }
  }

  function setGPSCoords(coords) {
    _gpsCoords = coords;
    const status = $('pid-gps-status');
    if (status) { status.textContent = `✓ ${coords.lat}, ${coords.lng}`; status.className = 'gps-status'; }
    const fallback = $('pid-gps-fallback');
    if (fallback) fallback.style.display = 'none';
    const refine = $('pid-gps-refine');
    if (refine) refine.style.display = 'block';
  }

  function captureGPS() {
    const status = $('pid-gps-status');
    if (status) { status.textContent = '📍 Locating...'; status.className = 'gps-status'; }
    const fallback = $('pid-gps-fallback');
    const refine   = $('pid-gps-refine');
    if (fallback) fallback.style.display = 'none';
    if (refine)   refine.style.display   = 'none';

    if (!navigator.geolocation) {
      if (status) { status.textContent = 'GPS not available'; status.className = 'gps-error'; }
      if (fallback) fallback.style.display = 'block';
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => setGPSCoords({
        lat: pos.coords.latitude.toFixed(6),
        lng: pos.coords.longitude.toFixed(6),
      }),
      () => {
        _gpsCoords = null;
        if (status) { status.textContent = 'GPS unavailable'; status.className = 'gps-error'; }
        if (fallback) fallback.style.display = 'block';
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  /* ── Identify button ── */
  function setupIdentifyBtn() {
    const btn = $('pid-identify-btn');
    if (btn) btn.addEventListener('click', runIdentification);
  }

  function updateIdentifyBtn() {
    const btn = $('pid-identify-btn');
    if (btn) btn.disabled = !(_photoBase64 && _selectedOrgan);
  }

  /* ── Clear / New plant ── */
  function clearForm() {
    _photoBase64        = null;
    _photoType          = 'image/jpeg';
    _gpsCoords          = null;
    _lastResult         = null;
    _supplementalPhotos   = [];
    _supplementalOrgans   = [];
    _lastZone             = '';
    _lastNotes            = '';
    _plantNetCandidates   = null;
    resetOrganSelect();
    try { sessionStorage.removeItem('fc_photo_b64'); } catch(e) {}

    const preview = $('pid-photo-preview');
    if (preview) { preview.src = ''; preview.style.display = 'none'; }

    const cam = $('pid-camera-input');
    const gal = $('pid-gallery-input');
    if (cam) cam.value = '';
    if (gal) gal.value = '';

    const gpsStatus = $('pid-gps-status');
    if (gpsStatus) { gpsStatus.textContent = ''; gpsStatus.className = 'gps-status'; }

    const fallback = $('pid-gps-fallback');
    if (fallback) fallback.style.display = 'none';
    const refine = $('pid-gps-refine');
    if (refine) refine.style.display = 'none';

    const notes = $('pid-notes');
    if (notes) notes.value = '';

    hideResult();
    updateIdentifyBtn();

    const screen = document.getElementById('screen-plant-id');
    if (screen) screen.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  /* ── Main identification flow ── */
  async function runIdentification() {
    if (!_photoBase64) { App.toast('Please select a photo first'); return; }

    const key = App.getApiKey();
    if (!key) { App.toast('Add your API key in Settings first'); App.openSettings(); return; }
    if (!navigator.onLine) { showOfflineMessage(); return; }

    _lastZone           = $('pid-zone').value;
    _lastNotes          = ($('pid-notes').value || '').trim();
    _supplementalPhotos = [];
    _supplementalOrgans = [];
    _plantNetCandidates = null;

    showSpinner(true);
    hideResult();

    const pnKey = App.getPlantNetKey();
    if (pnKey && navigator.onLine) {
      setSpinnerMsg('Step 1 of 2: Identifying species via PlantNet…');
      try {
        _plantNetCandidates = await callPlantNetAPI(pnKey, []);
        console.log('PlantNet candidates:', _plantNetCandidates);
      } catch(e) {
        console.warn('PlantNet failed:', e.status, e.message, e);
        if (e.status === 429) {
          App.toast('PlantNet daily limit reached — using Claude only');
        } else if (e.status === 401 || e.status === 403) {
          App.toast('PlantNet key rejected — re-enter key in Settings', 4000);
        } else {
          App.toast('PlantNet unavailable — using Claude only');
        }
        _plantNetCandidates = null;
      }
      setSpinnerMsg('Step 2 of 2: Getting property advice…');
    }

    try {
      const result = await callClaudeAPI(key, _lastNotes, null, _plantNetCandidates);
      _lastResult = result;
      showResult(result, _lastZone, _lastNotes);
    } catch (err) {
      showSpinner(false);
      showError(buildErrorMsg(err));
    }
  }

  /* Re-identify with supplemental photos */
  async function reIdentify() {
    const key = App.getApiKey();
    if (!key) return;

    showSpinner(true);
    hideResult();

    const pnKey = App.getPlantNetKey();
    if (pnKey && navigator.onLine) {
      setSpinnerMsg('Step 1 of 2: Identifying species…');
      try {
        _plantNetCandidates = await callPlantNetAPI(pnKey, _supplementalPhotos, _supplementalOrgans);
      } catch(e) {
        console.warn('PlantNet re-identify failed:', e.status, e.message, e);
        _plantNetCandidates = null;
      }
      setSpinnerMsg('Step 2 of 2: Getting property advice…');
    }

    const extraNote = _lastNotes
      ? _lastNotes + '\n\nPlease re-evaluate with the additional photo(s) provided.'
      : 'Please re-evaluate with the additional photo(s) provided.';

    try {
      const result = await callClaudeAPI(key, extraNote, _supplementalPhotos, _plantNetCandidates);
      _lastResult = result;
      showResult(result, _lastZone, _lastNotes);
    } catch (err) {
      showSpinner(false);
      showError(buildErrorMsg(err));
    }
  }

  function buildErrorMsg(err) {
    const raw = err.toString();
    if (!err.message || err.name === 'TypeError' || raw.toLowerCase().includes('fetch')) {
      return '⚠️ Network error — the API request was blocked or failed.<br><br>' +
             'Things to try:<br>' +
             '1. Check your API key is set in ⚙️ Settings<br>' +
             '2. In Brave: tap the lion icon → turn Shields OFF for this site<br>' +
             '3. Check your internet connection<br><br>' +
             '<small style="color:var(--muted)">Error detail: ' + esc(raw) + '</small>';
    }
    return esc(err.message) + '<br><small style="color:var(--muted)">' + esc(raw) + '</small>';
  }

  /* ── PlantNet API call ── */
  async function callPlantNetAPI(apiKey, extraPhotos, extraOrgans) {
    // Convert primary base64 photo to Blob
    const toBlob = (b64) => {
      const bytes = atob(b64);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      return new Blob([arr], { type: 'image/jpeg' });
    };

    const form = new FormData();
    form.append('images', toBlob(_photoBase64), 'photo.jpg');
    form.append('organs', _selectedOrgan || 'auto');
    if (extraPhotos && extraPhotos.length) {
      extraPhotos.forEach((p, i) => {
        form.append('images', toBlob(p.data), `photo${i+2}.jpg`);
        form.append('organs', (extraOrgans && extraOrgans[i]) || 'auto');
      });
    }

    const res = await fetch(
      `https://my-api.plantnet.org/v2/identify/all?include-related-images=false&no-reject=false&nb-results=3&lang=en&api-key=${encodeURIComponent(apiKey.trim())}`,
      { method: 'POST', body: form }
    );

    if (!res.ok) {
      const err = new Error('PlantNet error ' + res.status);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    return (data.results || []).slice(0, 3).map(r => ({
      scientificName: r.species?.scientificNameWithoutAuthor || '',
      commonName:     (r.species?.commonNames || [])[0] || '',
      score:          Math.round((r.score || 0) * 100),
    }));
  }

  /* ── Claude API call ── */
  async function callClaudeAPI(apiKey, userNotes, extraPhotos, plantNetCandidates) {
    const location = _gpsCoords
      ? `GPS: ${_gpsCoords.lat}, ${_gpsCoords.lng}`
      : 'Location: Southeast Iowa';

    const images = [
      { type: 'image', source: { type: 'base64', media_type: _photoType, data: _photoBase64 } },
    ];
    if (extraPhotos && extraPhotos.length) {
      extraPhotos.forEach(p => images.push(
        { type: 'image', source: { type: 'base64', media_type: p.type, data: p.data } }
      ));
    }

    let contextText = `${location}\nDate: ${App.todayISO()}`;
    if (plantNetCandidates && plantNetCandidates.length) {
      const list = plantNetCandidates
        .map((c, i) => `${i+1}. ${c.scientificName}${c.commonName ? ' (' + c.commonName + ')' : ''} — ${c.score}% confidence`)
        .join('\n');
      contextText += `\n\nPlantNet identified this plant as one of the following species (ranked by confidence):\n${list}\nBased on these candidates and the photo, determine which is most likely correct for SE Iowa, then provide property-specific action advice.`;
    }
    if (userNotes) contextText += '\n' + userNotes;

    const userMessage = [
      ...images,
      { type: 'text', text: contextText },
    ];

    const systemPrompt = App.getPropertyCtx().ai_system_prompt || fallbackSystemPrompt();

    const res = await fetch('https://field-companion-api.paulwiner5.workers.dev/', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) throw new Error('Invalid API key. Check Settings.');
      if (res.status === 429) throw new Error('Rate limit reached. Wait a moment and try again.');
      throw new Error(body.error?.message || `API error ${res.status}`);
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || '';

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      return JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch {
      throw new Error('Could not parse AI response. The model returned unexpected output.');
    }
  }

  /* Minimal fallback prompt if property-context fails to load */
  function fallbackSystemPrompt() {
    return `Identify the plant in the photo. Respond with valid JSON only:
{"common_name":"string","latin_name":"string","confidence":"High"|"Medium"|"Low","native_status":"Native"|"Invasive"|"Non-native"|"Naturalized"|"Unknown","keystone":true|false,"recommended_action":"REMOVE"|"NURTURE"|"MONITOR"|"UNKNOWN","action_detail":"string","fun_fact":"string","photo_tip":null,"log_entry":{"common_name":"string","latin_name":"string","native":"Native"|"Invasive"|"Non-native"|"Naturalized"|"Unknown","keystone":"Yes"|"No","observation_type":"string","action_needed":"string"}}`;
  }

  /* ── Confidence threshold check ── */
  function meetsThreshold(confidence, threshold) {
    if (threshold === 'Any')    return true;
    if (threshold === 'High')   return confidence === 'High';
    /* default Medium: High or Medium pass */
    return confidence === 'High' || confidence === 'Medium';
  }

  /* ── Result rendering ── */
  function showSpinner(on) {
    const spinner = $('pid-spinner');
    if (spinner) spinner.style.display = on ? 'flex' : 'none';
    if (on) {
      hideResult();
      setSpinnerMsg('Analyzing plant — this takes ~10 seconds…');
    }
  }

  function setSpinnerMsg(msg) {
    const el = $('pid-spinner-msg');
    if (el) el.textContent = msg;
  }

  function hideResult() {
    const r = $('pid-result');
    if (r) r.style.display = 'none';
  }

  function showOfflineMessage() {
    showSpinner(false);
    $('pid-result').style.display = 'block';
    $('pid-result').innerHTML = `
      <div class="alert alert-error">
        📵 <strong>No internet connection</strong><br>
        Plant ID requires the Claude AI service. You're currently offline.<br><br>
        ✅ You can still log this plant manually — switch to the Log tab.
      </div>`;
  }

  function showError(msg) {
    $('pid-result').style.display = 'block';
    $('pid-result').innerHTML = `<div class="alert alert-error">⚠️ ${msg}</div>`;
  }

  function nativeStatusBadge(status) {
    const map = { Native: 'badge-native', Invasive: 'badge-invasive', 'Non-native': 'badge-nonnative', Naturalized: 'badge-naturalized', Unknown: 'badge-zone' };
    return `<span class="badge ${map[status] || 'badge-zone'}">${esc(status || 'Unknown')}</span>`;
  }

  function actionClass(action) {
    return { REMOVE: 'action-remove', NURTURE: 'action-nurture', MONITOR: 'action-monitor' }[action] || 'action-unknown';
  }

  function actionIcon(action) {
    return { REMOVE: '🗑️', NURTURE: '🌱', MONITOR: '👁️', UNKNOWN: '❓' }[action] || '❓';
  }

  function confidenceBarHTML(confidence) {
    const widths = { High: '95%', Medium: '60%', Low: '30%' };
    const colors = { High: 'var(--green)', Medium: '#7a5a00', Low: 'var(--amber)' };
    const cls    = { High: 'high', Medium: 'medium', Low: 'low' };
    const w = widths[confidence] || '30%';
    const c = colors[confidence] || 'var(--amber)';
    const cl = cls[confidence] || 'low';
    return `<div class="confidence-bar-row">
      <span class="conf-label">Confidence:</span>
      <div class="progress-bar" style="flex:1;margin:0 6px"><div class="progress-fill" style="width:${w};background:${c}"></div></div>
      <span class="conf-value ${cl}">${esc(confidence || '')}</span>
    </div>`;
  }

  function showResult(result, zone, notes) {
    showSpinner(false);
    const threshold = App.getConfidenceThreshold();
    if (!meetsThreshold(result.confidence, threshold)) {
      showLowConfidenceResult(result, zone, notes);
    } else {
      showNormalResult(result, zone, notes);
    }
  }

  function showNormalResult(result, zone, notes) {
    const container = $('pid-result');
    container.style.display = 'block';

    const csvRow    = buildCSVRow(result, zone, notes);
    const isKeystone = result.keystone ? '<span class="badge badge-keystone">⭐ Keystone</span>' : '';
    const pnBadge = _plantNetCandidates && _plantNetCandidates.length
      ? `<div class="plantnet-badge">🌿 PlantNet: ${esc(_plantNetCandidates[0].scientificName)} (${_plantNetCandidates[0].score}%)</div>`
      : '';

    container.innerHTML = `
      <div class="result-card">
        <div class="result-name">${esc(result.common_name || 'Unknown plant')}</div>
        <div class="result-latin">${esc(result.latin_name || '')}</div>
        ${pnBadge}
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0">${nativeStatusBadge(result.native_status)} ${isKeystone}</div>
        ${confidenceBarHTML(result.confidence)}
        <div class="action-box ${actionClass(result.recommended_action)}" style="margin-top:10px">
          ${actionIcon(result.recommended_action)} <strong>${esc(result.recommended_action)}</strong> — ${esc(result.action_detail || '')}
        </div>
        ${result.fun_fact ? `<div class="fun-fact">📌 ${esc(result.fun_fact)}</div>` : ''}
        <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px">
          <div class="lbl">Log entry — copy to Google Sheet</div>
          <div class="mono-box" id="pid-csv-row">${esc(csvRow)}</div>
          <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
            <button class="btn btn-outline btn-sm" id="pid-copy-csv">📋 Copy CSV row</button>
            <button class="btn btn-sm" id="pid-save-obs">💾 Save observation</button>
          </div>
          <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
            ${result.action_detail ? `<button class="btn btn-outline btn-sm" id="pid-add-rec-task" style="color:var(--green);border-color:var(--green)">＋ Add recommended task</button>` : ''}
            <button class="btn btn-outline btn-sm" id="pid-add-task" style="color:var(--green);border-color:var(--green)">＋ Add task</button>
          </div>
        </div>
        <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
          <div style="font-size:11px;color:var(--muted);margin-bottom:6px">Not confident? Add another photo to sharpen the ID:</div>
          <div class="organ-pills" id="pid-normal-supp-organ-pills" style="margin-bottom:8px">
            <button type="button" class="organ-pill" data-organ="leaf">🍃 Leaf</button>
            <button type="button" class="organ-pill" data-organ="flower">🌸 Flower</button>
            <button type="button" class="organ-pill" data-organ="fruit">🍇 Fruit</button>
            <button type="button" class="organ-pill" data-organ="bark">🌳 Bark</button>
            <button type="button" class="organ-pill" data-organ="habit">🌿 Habit</button>
            <button type="button" class="organ-pill" data-organ="other">❓ Other</button>
          </div>
          <label class="btn btn-outline" id="pid-normal-supp-label" style="width:100%;text-align:center;cursor:pointer;box-sizing:border-box;display:block">
            📷 Add photo to improve ID
            <input type="file" id="pid-normal-supp-input" accept="image/*" capture="environment" style="display:none">
          </label>
        </div>
        <div style="margin-top:10px">
          <button class="btn btn-outline" id="pid-new-plant" style="width:100%">🔄 New plant</button>
        </div>
      </div>`;

    $('pid-copy-csv').addEventListener('click', () => App.copyToClipboard(csvRow));
    $('pid-save-obs').addEventListener('click', () => saveObservation(result, zone, notes, csvRow));
    $('pid-new-plant').addEventListener('click', clearForm);

    const addRecTaskBtn = $('pid-add-rec-task');
    if (addRecTaskBtn && window.Tasks) {
      addRecTaskBtn.addEventListener('click', () => {
        Tasks.openAddTaskSheet({
          text:             result.action_detail || '',
          zone:             zone || '',
          urgent:           result.recommended_action === 'REMOVE',
          observation_name: result.common_name + (zone ? ' · Zone ' + zone : ''),
        });
      });
    }
    const addTaskBtn = $('pid-add-task');
    if (addTaskBtn && window.Tasks) {
      addTaskBtn.addEventListener('click', () => {
        Tasks.openAddTaskSheet({
          zone:             zone || '',
          observation_name: result.common_name + (zone ? ' · Zone ' + zone : ''),
        });
      });
    }

    // Supplemental photo from normal result
    let _normalSuppOrgan = null;
    const normalPills = document.querySelectorAll('#pid-normal-supp-organ-pills .organ-pill');
    normalPills.forEach(pill => {
      pill.addEventListener('click', () => {
        normalPills.forEach(p => p.classList.remove('selected'));
        pill.classList.add('selected');
        _normalSuppOrgan = pill.dataset.organ;
      });
    });
    $('pid-normal-supp-input').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      if (!_normalSuppOrgan) {
        App.toast('Please select which part of the plant you photographed first');
        return;
      }
      const reader = new FileReader();
      reader.onload = async ev => {
        const compressed = await compressImage(ev.target.result, 2000, 0.95);
        _supplementalPhotos.push({ data: compressed.split(',')[1], type: 'image/jpeg' });
        _supplementalOrgans.push(_normalSuppOrgan);
        await reIdentify();
      };
      reader.readAsDataURL(file);
    });
  }

  function showLowConfidenceResult(result, zone, notes) {
    const container = $('pid-result');
    container.style.display = 'block';

    const isKeystone = result.keystone ? '<span class="badge badge-keystone">⭐ Keystone</span>' : '';
    const photoTip   = result.photo_tip
      ? `<div style="font-size:10px;color:var(--muted);background:#f5f0e8;border-radius:6px;padding:6px;margin-top:8px">💡 <em>${esc(result.photo_tip)}</em></div>`
      : '';

    container.innerHTML = `
      <div class="alert alert-warn">⚠️ <strong>Low confidence</strong> — Claude isn't certain about this ID. A second photo can help.</div>
      <div class="result-card">
        <div class="result-name">${esc(result.common_name || 'Unknown plant')}?</div>
        <div class="result-latin">${esc(result.latin_name || '')}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0">
          ${nativeStatusBadge(result.native_status)} ${isKeystone}
          <span class="badge" style="background:#fdf0d8;color:#7a4e00">⚠️ Low confidence</span>
        </div>
        ${confidenceBarHTML(result.confidence)}
        <div class="action-box ${actionClass(result.recommended_action)}" style="margin-top:10px">
          ${actionIcon(result.recommended_action)} <strong>${esc(result.recommended_action)}</strong> — ${esc(result.action_detail || '')}
        </div>
        ${result.fun_fact ? `<div class="fun-fact">📌 ${esc(result.fun_fact)}</div>` : ''}
        ${photoTip}
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:4px">
        <div style="font-size:12px;color:var(--label);font-weight:600;margin-bottom:2px">Add another photo to improve ID:</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:2px">What part will you photograph?</div>
        <div class="organ-pills" id="pid-supp-organ-pills">
          <button type="button" class="organ-pill" data-organ="leaf">🍃 Leaf</button>
          <button type="button" class="organ-pill" data-organ="flower">🌸 Flower</button>
          <button type="button" class="organ-pill" data-organ="fruit">🍇 Fruit</button>
          <button type="button" class="organ-pill" data-organ="bark">🌳 Bark</button>
          <button type="button" class="organ-pill" data-organ="habit">🌿 Habit</button>
          <button type="button" class="organ-pill" data-organ="other">❓ Other</button>
        </div>
        <label class="btn btn-amber" style="cursor:pointer" id="pid-supp-photo-label">
          📷 Add photo to improve ID
          <input type="file" id="pid-supplemental-input" accept="image/*" capture="environment" style="display:none">
        </label>
        <button class="btn btn-outline" id="pid-save-anyway">Save anyway (low confidence)</button>
        <button class="btn btn-outline" id="pid-low-conf-new-plant">🔄 New plant</button>
      </div>`;

    // Wire up supplemental organ pills
    let _suppOrganSelected = null;
    const suppPills = document.querySelectorAll('#pid-supp-organ-pills .organ-pill');
    suppPills.forEach(pill => {
      pill.addEventListener('click', () => {
        suppPills.forEach(p => p.classList.remove('selected'));
        pill.classList.add('selected');
        _suppOrganSelected = pill.dataset.organ;
        // Enable photo button once organ is picked
        const photoLabel = $('pid-supp-photo-label');
        if (photoLabel) photoLabel.style.opacity = '1';
      });
    });

    $('pid-supplemental-input').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      if (!_suppOrganSelected) {
        App.toast('Please select which part of the plant you photographed first');
        return;
      }
      const reader = new FileReader();
      reader.onload = async ev => {
        const compressed = await compressImage(ev.target.result, 2000, 0.95);
        _supplementalPhotos.push({ data: compressed.split(',')[1], type: 'image/jpeg' });
        _supplementalOrgans.push(_suppOrganSelected);
        await reIdentify();
      };
      reader.readAsDataURL(file);
    });

    $('pid-save-anyway').addEventListener('click', () => showNormalResult(result, zone, notes));
    $('pid-low-conf-new-plant').addEventListener('click', clearForm);

    // Add task from low-confidence card too
    const lcAddTaskBtn = document.createElement('button');
    lcAddTaskBtn.className = 'btn btn-outline';
    lcAddTaskBtn.style.cssText = 'color:var(--green);border-color:var(--green)';
    lcAddTaskBtn.textContent = '＋ Add task';
    lcAddTaskBtn.addEventListener('click', () => {
      if (window.Tasks) Tasks.openAddTaskSheet({
        zone: zone || '',
        observation_name: result.common_name + (zone ? ' · Zone ' + zone : ''),
        text: result.action_detail || '',
      });
    });
    const lcActions = container.querySelector('[id="pid-low-conf-new-plant"]');
    if (lcActions && lcActions.parentNode) lcActions.parentNode.insertBefore(lcAddTaskBtn, lcActions);
  }

  function buildCSVRow(result, zone, notes) {
    const log = result.log_entry || {};
    const obs = {
      date:             App.todayISO(),
      zone:             zone || '',
      lat:              _gpsCoords?.lat || '',
      lng:              _gpsCoords?.lng || '',
      location_desc:    ($('pid-notes').value || '').trim(),
      common_name:      result.common_name || log.common_name || '',
      latin_name:       result.latin_name  || log.latin_name  || '',
      native_status:    result.native_status || log.native || '',
      keystone:         result.keystone ? 'Yes' : 'No',
      observation_type: log.observation_type || result.native_status || '',
      action_needed:    log.action_needed || result.action_detail || '',
      notes:            notes || '',
    };
    return App.obsToCSVRow(obs);
  }

  async function saveObservation(result, zone, notes, csvRow) {
    const log = result.log_entry || {};
    const obs = {
      date:             App.todayISO(),
      zone:             zone || '',
      lat:              _gpsCoords?.lat || '',
      lng:              _gpsCoords?.lng || '',
      location_desc:    ($('pid-notes').value || '').trim(),
      common_name:      result.common_name || log.common_name || '',
      latin_name:       result.latin_name  || log.latin_name  || '',
      native_status:    result.native_status || log.native || '',
      keystone:         result.keystone ? 'Yes' : 'No',
      observation_type: log.observation_type || '',
      action_needed:    log.action_needed || result.action_detail || '',
      notes:            notes || '',
      ai_identified:    true,
      confidence:       result.confidence || null,
    };
    try {
      await App.saveObservation(obs);
      App.toast('Observation saved ✓');
      const btn = $('pid-save-obs');
      if (btn) { btn.textContent = '✓ Saved'; btn.disabled = true; }
    } catch (err) {
      App.toast('Save failed: ' + err.message);
    }
  }

  function esc(str) {
    return String(str || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

  return { init };
})();
