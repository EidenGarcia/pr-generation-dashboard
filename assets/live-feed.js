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
  const state = { busy: false, lastTry: null, okSource: null, okGraph: null, errSource: null, errGraph: null, snap: null, auto: true, next: null };
  try { state.auto = localStorage.getItem('pr-live-auto') !== 'off'; } catch { /* storage unavailable */ }
  let seq = 0, timer = null;

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

  // Merge what the browser read with what the hourly files hold; whichever is newer wins.
  const newer = (a, b) => String(a || '') >= String(b || '');
  dash.augment('live_units', (f) => (S.units && newer(S.units[0].snapshot, f[0] && f[0].snapshot) ? S.units : f));
  dash.augment('live_metrics', (f) => (S.metrics && newer(S.metrics[0] && S.metrics[0].snapshot, f[0] && f[0].snapshot) ? S.metrics : f));
  dash.augment('live_fuel_mix', (f) => (S.mix && newer(S.mix[0] && S.mix[0].snapshot, f[0] && f[0].snapshot) ? S.mix : f));
  dash.augment('live_graph', (f) => { const ft = f.filter((r) => r.time); return S.graph && newer(S.graph[S.graph.length - 1].time, ft.length && ft[ft.length - 1].time) ? S.graph : f; });
  dash.augment('forecast', (f) => (S.forecast && S.forecast.length ? S.forecast : f));
  dash.augment('forecast_summary', (f) => (S.fsum && (!f[0] || f[0].status !== 'ok' || newer(S.fsum.generated_at, f[0].generated_at)) ? [S.fsum] : f));
  dash.augment('history', (f) => (S.row && !f.some((r) => r.at === S.row.at) ? [...f, S.row] : f));
  dash.augment('unit_events', (f) => { const ids = new Set(f.map((e) => e.event_id)); return [...f, ...S.events.filter((e) => !ids.has(e.event_id))]; });
  dash.augment('frequency_events', (f) => (S.fevents.length ? P.mergeExcursions(f, S.fevents, S.fstep) : f));
  dash.augment('feed_health', (f) => [...f, ...S.checks]);
  dash.augment('status', (f) => { const s = { ...(f[0] || {}) }; if (S.temp != null) { s.temperature_f = S.temp; s.temperature_at = state.okGraph && P.isoAST(state.okGraph); } return [s]; });

  function ingestSource(vars, now) {
    const src = P.processSource(vars);
    const prev = S.units || dash.raw('live_units').data;
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
    if (L) { const ex = P.detectExcursions(g.rows, L); S.fevents = ex.episodes; S.fstep = ex.step || 300; }
    return g;
  }
  function rebuildForecast(now) {
    const hist = (dash.raw('history').data || []).filter((r) => !S.row || r.at !== S.row.at).concat(S.row ? [S.row] : []);
    const last = hist[hist.length - 1] || {};
    const fc = P.buildForecast({ graphRows: S.graph || [], history: hist, nextHourMw: last.next_hour_mw, availableMw: last.available_mw, demandNow: last.total_mw, now });
    if (fc.rows.length) { S.forecast = fc.rows; S.fsum = { ...fc.summary, via: 'browser' }; }
  }

  async function refresh() {
    if (state.busy) return;
    state.busy = true; state.lastTry = new Date(); ui();
    const now = new Date();
    const [ds, gr] = await Promise.all([load('dataSource'), load('dataGraph')]);
    if (gr.vars) { try { ingestGraph(gr.vars, now); state.okGraph = now; state.errGraph = null; } catch (e) { state.errGraph = e.message; } }
    else state.errGraph = gr.error;
    let info = null;
    if (ds.vars) { try { info = ingestSource(ds.vars, now); state.okSource = now; state.errSource = null; state.snap = info.src.snap; } catch (e) { state.errSource = 'Data not recognised: ' + e.message; } }
    else state.errSource = ds.error;
    if (S.graph || S.row) rebuildForecast(now);
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
    timer = setTimeout(() => { if (document.hidden) { schedule(); return; } refresh(); }, AUTO_MS);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.auto && state.lastTry && Date.now() - state.lastTry > AUTO_MS) refresh();
  });

  const pr = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Puerto_Rico', hour: 'numeric', minute: '2-digit' });
  function ui() {
    const btn = document.getElementById('refresh-btn'), stat = document.getElementById('live-stat'), tog = document.getElementById('auto-toggle'), box = document.getElementById('livectl');
    if (!btn) return;
    btn.disabled = state.busy; btn.textContent = state.busy ? 'Refreshing…' : 'Refresh now';
    tog.checked = state.auto;
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
    tog.addEventListener('change', () => {
      state.auto = tog.checked;
      try { localStorage.setItem('pr-live-auto', state.auto ? 'on' : 'off'); } catch { /* storage unavailable */ }
      schedule(); ui();
    });
    ui();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
  // First read shortly after the page's own files have loaded (they hold the previous reading used to spot changes).
  setTimeout(refresh, 1200);

  return { state, refresh, _ingestSource: ingestSource, _ingestGraph: ingestGraph, _rebuildForecast: rebuildForecast, _S: S };
})();
