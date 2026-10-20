/*
 * Direct link to PREPA's live feeds from the visitor's browser.
 *   https://operationdata.prepa.pr.gov/dataSource.js  (all generation by plant and unit)
 *   https://operationdata.prepa.pr.gov/dataGraph.js   (last 24 hours, 5-minute steps)
 * Each file is loaded the way PREPA's own page loads it, as a script, but inside a sandboxed frame
 * that cannot touch this page. Only the data values are passed back. Refreshes every 5 minutes while
 * the page is open, and on demand with the Refresh now button.
 */
window.LIVE = (() => {
  const P = window.PREPA;
  const URLS = {
    dataSource: 'https://operationdata.prepa.pr.gov/dataSource.js',
    dataGraph: 'https://operationdata.prepa.pr.gov/dataGraph.js',
  };
  const NAMES = {
    dataSource: ['dataFechaAcualizado', 'dataFechaActualizado', 'dataFuelCost', 'dataByFuel', 'dataMetrics', 'dataLoadPerSite'],
    dataGraph: ['temperatura', 'dataGraph'],
  };
  const AUTO_MS = 5 * 60000;
  const S = { units: null, metrics: null, mix: null, graph: null, temp: null, forecast: null, fsum: null, events: [], fevents: [], fstep: 300, checks: [], row: null };
  const state = { wake: false, busy: false, lastTry: null, okSource: null, okGraph: null, errSource: null, errGraph: null, snap: null, auto: true, next: null };
  try { state.auto = localStorage.getItem('pr-live-auto') !== 'off'; state.wake = localStorage.getItem('pr-live-wake') === 'on'; } catch { /* storage unavailable */ }
  let seq = 0, timer = null, loader = null;
  // What this device has recorded (loaded from the local history database).
  const LOC = { checks: [], trace: [], events: [], since: null, lastUnits: null, daySums: [], ready: false, error: null };

  function load(feed, timeoutMs = 25000) {
    return new Promise((resolve) => {
      const id = 'pr' + (++seq) + '_' + Date.now();
      const names = JSON.stringify(NAMES[feed]);
      const probe = `var v={};${names}.forEach(function(n){try{v[n]=(0,eval)(n)}catch(e){}});parent.postMessage({id:${JSON.stringify(id)},vars:v},'*');`;
      const html = '<!doctype html><meta charset="utf-8">'
        + `<script src="${URLS[feed]}?t=${Date.now()}" onerror="parent.postMessage({id:'${id}',error:'PREPA did not deliver the file'},'*')"><\/script>`
        + `<script>${probe}<\/script>`;
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1;
      f.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
      const t0 = performance.now(); let done = false, to = null;
      const finish = (r) => { if (done) return; done = true; window.removeEventListener('message', onMsg); clearTimeout(to); f.remove(); resolve({ ...r, ms: Math.round(performance.now() - t0) }); };
      const onMsg = (ev) => {
        if (ev.source !== f.contentWindow || !ev.data || ev.data.id !== id) return;
        if (ev.data.error) return finish({ error: ev.data.error });
        const vars = ev.data.vars || {};
        if (!Object.values(vars).some((x) => x != null)) return finish({ error: 'File loaded but its data was not found' });
        finish({ vars });
      };
      window.addEventListener('message', onMsg);
      to = setTimeout(() => finish({ error: 'No answer from PREPA within ' + Math.round(timeoutMs / 1000) + ' s' }), timeoutMs);
      f.srcdoc = html;
      document.body.appendChild(f);
    });
  }

  loader = load;
  // Merge what this browser read (now and on earlier visits) with what the GitHub updater saved.
  const newer = (a, b) => String(a || '') >= String(b || '');
  const mergeBy = (key, ...lists) => { const m = new Map(); for (const l of lists) for (const r of l || []) if (r && r[key]) m.set(r[key], { ...(m.get(r[key]) || {}), ...r }); return [...m.values()].sort((x, y) => (x[key] < y[key] ? -1 : 1)); };
  dash.augment('live_units', (f) => (S.units && newer(S.units[0].snapshot, f[0] && f[0].snapshot) ? S.units : f));
  dash.augment('live_metrics', (f) => (S.metrics && newer(S.metrics[0] && S.metrics[0].snapshot, f[0] && f[0].snapshot) ? S.metrics : f));
  dash.augment('live_fuel_mix', (f) => (S.mix && newer(S.mix[0] && S.mix[0].snapshot, f[0] && f[0].snapshot) ? S.mix : f));
  dash.augment('live_graph', (f) => mergeBy('time', f.filter((r) => r.time), LOC.trace, S.graph));
  dash.augment('forecast', (f) => (S.forecast && S.forecast.length ? S.forecast : f));
  dash.augment('forecast_summary', (f) => (S.fsum && (!f[0] || f[0].status !== 'ok' || newer(S.fsum.generated_at, f[0].generated_at)) ? [S.fsum] : f));
  dash.augment('history', (f) => mergeBy('at', f, LOC.checks, S.row ? [S.row] : []));
  dash.augment('unit_events', (f) => mergeBy('event_id', f, LOC.events, S.events).sort((a, b) => (a.detected_at < b.detected_at ? -1 : 1)));
  // excursions are rebuilt from the saved 5-minute trace, so they survive reloads
  let fexCache = { n: -1, ev: [], step: 300 };
  dash.augment('frequency_events', (f) => {
    const L = (dash.raw('freq_limits').data || [])[0];
    if (L && LOC.trace.length && fexCache.n !== LOC.trace.length) { const ex = P.detectExcursions(LOC.trace, L); fexCache = { n: LOC.trace.length, ev: ex.episodes, step: ex.step || 300 }; }
    let out = fexCache.ev.length ? P.mergeExcursions(f, fexCache.ev, fexCache.step) : f;
    if (S.fevents.length) out = P.mergeExcursions(out, S.fevents, S.fstep);
    return out;
  });
  dash.augment('feed_health', (f) => [...f, ...S.checks]);
  dash.augment('daily_summary', (f) => { const today = P.isoAST(new Date()).slice(0, 10); const m = new Map(f.map((d) => [d.day, d.status === 'In progress' && d.day < today ? { ...d, status: (d.coverage_h || 0) >= 20 ? 'Complete' : 'Ended, partial data' } : d])); for (const d of LOC.daySums) { const o = m.get(d.day); if (!o || (d.coverage_h || 0) > (o.coverage_h || 0) + 0.25) m.set(d.day, { ...d, via: 'this device' }); } return [...m.values()].sort((a, b) => (a.day < b.day ? -1 : 1)); });
  dash.augment('status', (f) => { const s = { ...(f[0] || {}) }; if (S.temp != null) { s.temperature_f = S.temp; s.temperature_at = state.okGraph && P.isoAST(state.okGraph); } s.local_since = LOC.since; s.local_checks = LOC.checks.length; s.local_error = LOC.error; return [s]; });

  async function loadLocal() {
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      await HDB.prune();
      const since35 = new Date(Date.now() - 35 * 86400000).toISOString();
      const iso = (x) => new Date(x).toISOString();
      LOC.checks = (await HDB.all('checks')).filter((r) => iso(r.at) >= since35);
      LOC.trace = (await HDB.all('trace')).filter((r) => iso(r.time) >= since35);
      LOC.events = await HDB.all('events');
      LOC.since = await HDB.getMeta('since');
      LOC.lastUnits = await HDB.getMeta('last_units');
      LOC.daySums = (await HDB.getMeta('day_sums')) || [];
    } catch (e) { LOC.error = e.message; }
    LOC.ready = true; dash.rerun();
  }
  async function saveLocal(src, now) {
    try {
      if (!LOC.since) { LOC.since = P.isoAST(now); await HDB.setMeta('since', LOC.since); }
      if (S.row) { await HDB.put('checks', [S.row]); LOC.checks = mergeBy('at', LOC.checks, [S.row]); }
      if (S.graph) { await HDB.put('trace', S.graph); LOC.trace = mergeBy('time', LOC.trace, S.graph); }
      if (S.events.length) { await HDB.put('events', S.events); LOC.events = mergeBy('event_id', LOC.events, S.events); }
      if (src) { LOC.lastUnits = src.units; await HDB.setMeta('last_units', src.units); }
      // daily summaries from what this device recorded (kept for every day, even beyond 35 days)
      const L = (dash.raw('freq_limits').data || [])[0] || null, today = P.isoAST(now).slice(0, 10);
      const days = new Set(LOC.checks.map((c) => c.at.slice(0, 10)));
      const sums = new Map(LOC.daySums.map((d) => [d.day, d]));
      for (const d of days) {
        if (sums.has(d) && sums.get(d).status !== 'In progress' && d < today) continue;
        const ev = LOC.events.filter((e) => e.detected_at.slice(0, 10) === d && (e.event === 'Went offline' || e.event === 'Back online'));
        const fev = S.fevents.filter((e) => e.start.slice(0, 10) === d);
        sums.set(d, P.summarizeDay(d, LOC.checks.filter((c) => c.at.slice(0, 10) === d), LOC.trace.filter((r) => r.time.slice(0, 10) === d), ev, fev, L, d < today, now));
      }
      LOC.daySums = [...sums.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
      await HDB.setMeta('day_sums', LOC.daySums);
    } catch (e) { LOC.error = e.message; }
  }

  function ingestSource(vars, now) {
    const src = P.processSource(vars);
    const cands = [S.units, LOC.lastUnits, dash.raw('live_units').data].filter((u) => u && u[0] && u[0].snapshot);
    const prev = cands.sort((a, b) => (a[0].snapshot < b[0].snapshot ? 1 : -1))[0] || null;
    const prevSnap = prev && prev[0] && prev[0].snapshot;
    if (prevSnap && prevSnap !== src.snap && (new Date(src.snap) - new Date(prevSnap)) / 3600000 <= 3) {
      const pm = new Map(prev.map((u) => [u.unit_id, u]));
      for (const u of src.units) {
        const p = pm.get(u.unit_id); if (!p || p.status === u.status) continue;
        S.events.push({ event_id: `${src.snap}|${u.unit_id}`, detected_at: src.snap, previous_snapshot: prevSnap, plant: u.plant, unit: u.unit, operator: u.operator, fuel: u.fuel,
          event: u.status === 'Offline' ? 'Went offline' : 'Back online', mw_before: p.mw, mw_after: u.mw, via: 'browser' });
      }
    }
    S.units = src.units; S.metrics = src.metrics; S.mix = src.mix;
    S.row = { ...P.buildHistoryRow(src, S.graph ? { rows: S.graph } : null, now), via: 'browser', forecast_load_mw: null };
    return { src, prevSnap };
  }
  function ingestGraph(vars, now) {
    const g = P.processGraph(vars, now);
    if (!g.rows.length) throw new Error('No readings recognised in dataGraph.js');
    S.graph = g.rows; S.temp = g.temperature_f ?? S.temp;
    const L = (dash.raw('freq_limits').data || [])[0];
    if (L) { const ex = P.detectExcursions(mergeBy('time', LOC.trace, g.rows), L); S.fevents = ex.episodes; S.fstep = ex.step || 300; }
    return g;
  }
  function rebuildForecast(now) {
    const hist = mergeBy('at', dash.raw('history').data || [], LOC.checks, S.row ? [S.row] : []);
    const last = hist[hist.length - 1] || {};
    const fc = P.buildForecast({ graphRows: S.graph || [], history: hist, nextHourMw: last.next_hour_mw, availableMw: last.available_mw, demandNow: last.total_mw, now });
    if (fc.rows.length) { S.forecast = fc.rows; S.fsum = { ...fc.summary, via: 'browser' }; }
  }

  async function refresh() {
    if (state.busy) return;
    state.busy = true; state.lastTry = new Date(); ui();
    const now = new Date();
    const [ds, gr] = await Promise.all([loader('dataSource'), loader('dataGraph')]);
    if (gr.vars) { try { ingestGraph(gr.vars, now); state.okGraph = now; state.errGraph = null; } catch (e) { state.errGraph = e.message; } }
    else state.errGraph = gr.error;
    let info = null;
    if (ds.vars) { try { info = ingestSource(ds.vars, now); state.okSource = now; state.errSource = null; state.snap = info.src.snap; } catch (e) { state.errSource = 'Data not recognised: ' + e.message; } }
    else state.errSource = ds.error;
    if (S.graph || S.row) rebuildForecast(now);
    await saveLocal(info && info.src, now);
    const at = P.isoAST(now);
    S.checks.push({ at, feed: 'dataSource', ok: !state.errSource, http_status: null, ms: ds.ms, bytes: null, error: state.errSource, via: 'browser',
      feed_time: info ? info.src.snap : null, feed_age_min: info ? Math.round((now - new Date(info.src.snap)) / 60000) : null, feed_changed: info ? info.src.snap !== info.prevSnap : null });
    S.checks.push({ at, feed: 'dataGraph', ok: !state.errGraph, http_status: null, ms: gr.ms, bytes: null, error: state.errGraph, via: 'browser' });
    S.checks = S.checks.slice(-200);
    state.busy = false;
    schedule();
    dash.rerun(); ui();
  }

  function schedule() {
    clearTimeout(timer); state.next = null;
    if (!state.auto) return;
    state.next = new Date(Date.now() + AUTO_MS);
    // keep reading even when the tab is hidden or minimized, so an unattended page keeps recording
    timer = setTimeout(() => refresh(), AUTO_MS);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.auto && state.lastTry && Date.now() - state.lastTry > AUTO_MS) refresh();
    if (!document.hidden && state.wake) acquireWake();
  });
  // Keep the screen (and so the computer) awake while recording unattended.
  let wakeLock = null;
  async function acquireWake() {
    try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; ui(); }); } } catch { wakeLock = null; }
    ui();
  }
  function releaseWake() { try { wakeLock && wakeLock.release(); } catch { /* already released */ } wakeLock = null; ui(); }

  const pr = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Puerto_Rico', hour: 'numeric', minute: '2-digit' });
  function ui() {
    const btn = document.getElementById('refresh-btn'), stat = document.getElementById('live-stat'), tog = document.getElementById('auto-toggle'), box = document.getElementById('livectl');
    if (!btn) return;
    btn.disabled = state.busy; btn.textContent = state.busy ? 'Refreshing…' : 'Refresh now';
    tog.checked = state.auto;
    const wk = document.getElementById('wake-toggle'); if (wk) { wk.checked = state.wake; wk.parentElement.title = !('wakeLock' in navigator) ? 'This browser cannot keep the screen on; change the computer’s sleep settings instead.' : wakeLock ? 'Screen will stay on while this tab is visible.' : 'Keeps the screen on while this tab is visible.'; }
    box.classList.toggle('ok', !!state.okSource && !state.errSource);
    box.classList.toggle('bad', !!state.errSource);
    let t;
    if (state.busy && !state.okSource) t = 'Connecting to PREPA…';
    else if (state.errSource && !state.okSource) t = 'Could not read PREPA from this browser (' + state.errSource + '). Showing the latest hourly record.';
    else if (state.okSource) {
      t = 'Live from PREPA: data ' + pr.format(new Date(state.snap)) + ', read ' + pr.format(state.okSource) + '.';
      if (state.errSource) t += ' Last try failed: ' + state.errSource + '.';
      if (state.errGraph) t += ' 24-hour trace: ' + state.errGraph + '.';
      if (state.auto && state.next) t += ' Next refresh ' + pr.format(state.next) + '.';
    } else t = 'Not connected yet.';
    stat.textContent = t;
  }
  function wire() {
    const btn = document.getElementById('refresh-btn'), tog = document.getElementById('auto-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => refresh());
    const wk = document.getElementById('wake-toggle');
    if (wk) wk.addEventListener('change', () => { state.wake = wk.checked; try { localStorage.setItem('pr-live-wake', state.wake ? 'on' : 'off'); } catch { /* storage unavailable */ } if (state.wake) acquireWake(); else releaseWake(); });
    if (state.wake) acquireWake();
    tog.addEventListener('change', () => {
      state.auto = tog.checked;
      try { localStorage.setItem('pr-live-auto', state.auto ? 'on' : 'off'); } catch { /* storage unavailable */ }
      schedule(); ui();
    });
    ui();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
  // First read shortly after the page's own files have loaded (they hold the previous reading used to spot changes).
  loadLocal().finally(() => setTimeout(refresh, 600));

  async function exportCSV() {
    const rows = mergeBy('at', dash.raw('history').data || [], LOC.checks);
    const cols = ['at', 'total_mw', 'next_hour_mw', 'available_mw', 'spinning_mw', 'operating_mw', 'frequency_hz', 'genera_mw', 'genera_units_offline', 'units_offline', 'dispatch_cost_usd_h', 'avg_cents_kwh', 'genera_avg_cents_kwh', 'fossil_pct', 'renewable_pct', 'mw_lng', 'mw_bunker_c', 'mw_ulsd', 'mw_coal', 'mw_solar', 'mw_wind', 'mw_hydro', 'mw_landfill_gas'];
    const plants = [...new Set(rows.flatMap((r) => Object.keys(r.plant_mw || {})))].sort();
    const head = [...cols, ...plants.map((p) => 'mw ' + p)];
    const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v);
    const csv = head.map(q).join(',') + '\n' + rows.map((r) => [...cols.map((c) => r[c]), ...plants.map((p) => (r.plant_mw || {})[p])].map(q).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'pr-generation-history.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async function clearLocal() { await HDB.clear(); Object.assign(LOC, { checks: [], trace: [], events: [], since: null, lastUnits: null, daySums: [] }); dash.rerun(); }
  return { _setLoader: (f) => { loader = f; }, LOC, exportCSV, clearLocal, _saveLocal: saveLocal, _loadLocal: loadLocal, state, refresh, _ingestSource: ingestSource, _ingestGraph: ingestGraph, _rebuildForecast: rebuildForecast, _S: S };
})();
