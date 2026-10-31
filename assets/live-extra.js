/* Live page: fuel over time, plant map, 24-hour outage log, unit gauges, daily summary */
(() => {
  const G = window.GX;
  const H = 3600000;
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const pr = (o) => { const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Puerto_Rico', ...o }); return (d) => f.format(d); };
  const tFmt = pr({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const hFmt = pr({ hour: 'numeric' });
  const dur = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? m + ' min' : m < 2880 ? Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min' : (m / 1440).toFixed(1) + ' days'; };
  const FUELS = [['lng', 'LNG'], ['bunker_c', 'Bunker C'], ['ulsd', 'ULSD'], ['coal', 'Coal'], ['solar', 'Solar'], ['wind', 'Wind'], ['hydro', 'Hydro'], ['landfill_gas', 'Landfill gas']];
  let gaugeOp = 'Genera PR';

  /* ---------- Stacked charts over time (fuel and plant) ---------- */
  const RANGE_H = { '24h': 24, '7d': 168, '30d': 720, all: Infinity };
  const PALETTE = ['#4e79a7', '#59a14f', '#e15759', '#f28e2b', '#76b7b2', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#1f77b4', '#d62728', '#9467bd',
    '#17becf', '#bcbd22', '#8c564b', '#e377c2', '#aec7e8', '#ffbb78', '#98df8a', '#c5b0d5', '#7f7f7f'];
  const PLANT_ORDER = ['Aguirre Steam', 'Costa Sur Steam', 'San Juan CC', 'Palo Seco Steam', 'AES', 'EcoEléctrica', 'San Juan Steam', 'Cambalache', 'Mayagüez', 'GT stations (peakers)',
    'Aguirre CC 1', 'Aguirre CC 2', 'Palo Seco GT/CT', 'Costa Sur GT/CT', 'Aguirre GT/CT', 'Hydro', 'Solar', 'Wind', 'Landfill gas'];
  // Plant colors are shades of the plant's fuel color, so the plant and fuel charts and the rest of the page agree.
  const FALLBACK = { '--c1': '#1f5fa8', '--c2': '#7a5534', '--c3': '#c47a14', '--c4': '#4a5560', '--c5': '#d8ac1c', '--c6': '#2a9d8f', '--c7': '#3d8fd1', '--c8': '#6f8f2f', '--cds-chart-muted': '#b9c6d2' };
  const cssVar = (v) => { const m = /var\((--[\w-]+)\)/.exec(v); return m ? getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || FALLBACK[m[1]] || '#888' : v; };
  let plantColorMap = {};
  function buildPlantColors(plants) {
    const fm = { Hydro: 'Hydro', Solar: 'Solar', Wind: 'Wind', 'Landfill gas': 'Landfill gas' };
    for (const u of G.rows('live_units')) { const g = window.PREPA.plantGroup(u.plant); if (!fm[g]) fm[g] = G.norm(u.fuel); }
    const out = {};
    for (const [fuel, ps] of d3.group(plants.slice().sort((a, b) => PLANT_ORDER.indexOf(a) - PLANT_ORDER.indexOf(b)), (p) => fm[p] || 'Other')) {
      const base = d3.hsl(cssVar(G.color(fuel)));
      ps.forEach((p, i) => { const c = d3.hsl(base); if (ps.length > 1) c.l = Math.max(0.28, Math.min(0.78, base.l + (i / (ps.length - 1) - 0.5) * 0.36)); out[p] = c.formatHex(); });
    }
    plantColorMap = out; return out;
  }
  const plantColor = (p) => plantColorMap[p] || '#888';
  // Readings in the period: this device and the GitHub updater, plus the updater's hourly averages where no reading exists.
  function readingRows(range) {
    const raw = G.rows('history').filter((r) => r.at).map((r) => ({ ...r, t: new Date(r.at) }));
    const rawHours = new Set(raw.map((r) => r.at.slice(0, 13)));
    const hourly = G.rows('plant_hourly').filter((r) => !rawHours.has(r.at.slice(0, 13))).map((r) => ({ ...r, t: new Date(r.at) }));
    const rows = [...raw, ...hourly].sort((a, b) => a.t - b.t);
    if (!rows.length) return rows;
    const end = rows[rows.length - 1].t;
    return rows.filter((r) => end - r.t <= RANGE_H[range] * H);
  }
  // Even time grid from PREPA's continuous generation record; the plant and fuel split is interpolated between readings.
  function uniformRows(range) {
    const stepMs = range === '24h' ? 300000 : 900000;
    const bins = new Map();
    for (const r of [...G.rows('trace_recent'), ...G.rows('live_graph')]) { if (!r.time || num(r.generation_mw) == null) continue; const k = Math.floor(new Date(r.time) / stepMs) * stepMs; const o = bins.get(k) || { s: 0, n: 0 }; o.s += Number(r.generation_mw); o.n++; bins.set(k, o); }
    const readings = readingRows('all').filter((r) => r.plant_mw && Object.keys(r.plant_mw).length);
    if (bins.size < 2 || !readings.length) return { rows: readingRows(range), readings, uniform: false };
    const times = [...bins.keys()].sort((a, b) => a - b), end = times[times.length - 1];
    const sel = times.filter((t) => end - t <= RANGE_H[range] * H);
    const sh = readings.map((r) => {
      const ptot = d3.sum(Object.values(r.plant_mw)) || 1, p = {}; for (const [k, v] of Object.entries(r.plant_mw)) p[k] = Math.max(0, v) / ptot;
      const ftot = d3.sum(FUELS, ([k]) => Number(r['mw_' + k]) || 0) || 1, f = {}; for (const [k] of FUELS) f[k] = (Number(r['mw_' + k]) || 0) / ftot;
      return { t: +r.t, p, f };
    });
    const mix = (a, b, w) => { const o = {}; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) o[k] = (a[k] || 0) * (1 - w) + (b[k] || 0) * w; return o; };
    const rows = sel.map((t) => {
      let lo = 0, hi = sh.length - 1, i = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (sh[m].t <= t) { i = m; lo = m + 1; } else hi = m - 1; }
      const a = sh[Math.max(0, i)], b = sh[Math.min(sh.length - 1, i + 1)];
      const w = i < 0 ? 0 : b.t === a.t ? 0 : Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
      const p = i < 0 ? sh[0].p : mix(a.p, b.p, w), f = i < 0 ? sh[0].f : mix(a.f, b.f, w);
      const o = bins.get(t), g = o.s / o.n;
      const row = { t: new Date(t), total_mw: g, plant_mw: {}, _near: Math.min(Math.abs(t - a.t), Math.abs(t - b.t)) };
      for (const [k, v] of Object.entries(p)) row.plant_mw[k] = v * g;
      for (const [k] of FUELS) row['mw_' + k] = (f[k] || 0) * g;
      return row;
    });
    return { rows, readings: readings.filter((r) => end - r.t <= RANGE_H[range] * H), uniform: true };
  }
  function dayRows(range) {
    const d = G.rows('daily_summary').map((r) => ({ ...r, t: new Date(r.day + 'T12:00:00-04:00') }));
    if (!d.length) return d;
    const end = d[d.length - 1].t;
    return d.filter((r) => end - r.t <= RANGE_H[range] * H + 12 * H);
  }
  // series: [{ key, label, color, get(row) }]
  function stackChart(box, rows, series, opt) {
    box.replaceChildren(); box.classList.remove('dash-skeleton');
    const full = !!document.fullscreenElement && document.fullscreenElement.contains(box);
    const W = box.clientWidth || 700, Hh = full ? Math.max(360, Math.round(window.innerHeight * 0.62)) : opt.height || 340, top = opt.strip ? 26 : 10;
    if (opt.domain) rows = rows.filter((r) => r.t >= opt.domain[0] && r.t <= opt.domain[1]);
    const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('width', '100%').attr('height', Hh);
    if (!rows.length || !series.length) { svg.append('text').attr('x', W / 2).attr('y', Hh / 2).attr('text-anchor', 'middle').attr('class', 'empty').text(opt.empty || 'No readings in this period yet.'); return; }
    // break the areas where readings are missing for a while
    const gaps = rows.slice(1).map((r, i) => r.t - rows[i].t).sort((a, b) => a - b), typ = gaps.length ? gaps[Math.floor(gaps.length / 2)] : H;
    const maxGap = opt.daily ? 1.6 * 86400000 : Math.max(2 * H, typ * 4);
    const seq = []; rows.forEach((r, i) => { if (i && r.t - rows[i - 1].t > maxGap) seq.push({ t: new Date(+rows[i - 1].t + typ), _gap: true }); seq.push(r); });
    const val = (r, s) => (r._gap ? 0 : Math.max(0, Number(s.get(r)) || 0));
    const stacked = d3.stack().keys(series.map((s) => s.key)).value((r, k) => val(r, series.find((s) => s.key === k)))(seq);
    const maxY = d3.max(seq, (r) => d3.sum(series, (s) => val(r, s))) || 1;
    const y = d3.scaleLinear([0, maxY * 1.05], [Hh - 26, top + 6]).nice();
    const ml = G.measure(svg, y.ticks(5).map(G.f0)) + 14;
    const t0 = rows[0].t, t1 = rows[rows.length - 1].t;
    const pad = rows.length === 1 ? (opt.daily ? 86400000 : H) : opt.daily ? 43200000 : 0;
    const x = d3.scaleTime(opt.domain || [new Date(+t0 - pad), new Date(+t1 + pad)], [ml, W - 8]);
    svg.append('g').selectAll('line').data(y.ticks(5)).join('line').attr('x1', ml).attr('x2', W - 8).attr('y1', y).attr('y2', y).attr('stroke', 'var(--cds-chart-grid)');
    svg.append('g').selectAll('text').data(y.ticks(5)).join('text').attr('x', ml - 6).attr('y', y).attr('dy', '0.35em').attr('text-anchor', 'end').text(G.f0);
    svg.append('text').attr('x', ml - 6).attr('y', top + 2).attr('text-anchor', 'end').text(opt.unit);
    const span = x.domain()[1] - x.domain()[0];
    const fmtX = span > 3 * 86400000 ? pr({ month: 'short', day: 'numeric' }) : (d) => (Number(pr({ hour: 'numeric', hourCycle: 'h23' })(d)) % 24 === 0 ? pr({ month: 'short', day: 'numeric' })(d) : hFmt(d));
    svg.append('g').selectAll('text').data(x.ticks(Math.max(3, Math.floor((W - ml) / 90)))).join('text').attr('x', x).attr('y', Hh - 6).attr('text-anchor', 'middle').text(fmtX);
    const fewDays = opt.daily && rows.length < 8;
    if (fewDays || rows.length === 1) {
      const bw = Math.max(10, Math.min(60, ((W - ml) / Math.max(rows.length, 3)) * 0.6));
      for (const r of rows) { let acc = 0; for (const s of series) { const v = val(r, s); if (!v) continue; svg.append('rect').attr('x', x(r.t) - bw / 2).attr('y', y(acc + v)).attr('width', bw).attr('height', y(acc) - y(acc + v)).attr('fill', s.color); acc += v; } }
    } else {
      svg.append('g').selectAll('path').data(stacked).join('path').attr('fill', (st) => series.find((s) => s.key === st.key).color).attr('opacity', 0.92).attr('stroke', (st) => series.find((s) => s.key === st.key).color).attr('stroke-width', 0.6)
        .attr('d', d3.area().defined((d) => !d.data._gap).x((d) => x(d.data.t)).y0((d) => y(d[0])).y1((d) => y(d[1])).curve(opt.daily ? d3.curveMonotoneX : d3.curveStepAfter));
    }
    if (opt.strip && !opt.daily && rows.length > 1) {
      rows.forEach((r, i) => { let best = null; for (const s of series) if (!best || val(r, s) > val(r, best)) best = s;
        const x0 = x(r.t), x1 = i < rows.length - 1 && rows[i + 1].t - r.t <= maxGap ? x(rows[i + 1].t) : x0 + 2;
        svg.append('rect').attr('x', x0).attr('y', 4).attr('width', Math.max(1, x1 - x0)).attr('height', 12).attr('fill', best.color); });
      svg.append('text').attr('x', ml - 6).attr('y', 14).attr('text-anchor', 'end').text('Majority');
    }
    // ticks under the axis where actual unit readings were taken
    if (opt.ticks && opt.ticks.length) svg.append('g').selectAll('line').data(opt.ticks.filter((t) => t >= x.domain()[0] && t <= x.domain()[1])).join('line')
      .attr('x1', x).attr('x2', x).attr('y1', Hh - 26).attr('y2', Hh - 20).attr('stroke', 'var(--ink)').attr('stroke-width', 1.4);
    const tip = G.tipFor(box.closest('.gx-card'));
    const rule = svg.append('line').attr('y1', top).attr('y2', Hh - 26).attr('stroke', 'var(--cds-chart-reference)').attr('opacity', 0);
    const brush = d3.brushX().extent([[ml, 0], [W - 8, Hh - 26]]).on('end', (ev) => {
      if (!ev.selection || !opt.onZoom) return; const [a, b] = ev.selection; if (b - a < 8) { bg.call(brush.move, null); return; } opt.onZoom([x.invert(a), x.invert(b)]); });
    const bg = svg.append('g').attr('class', 'brush').call(brush);
    svg.on('dblclick', () => opt.onZoom && opt.onZoom(null));
    bg.select('.overlay')
      .on('mousemove.tip', (ev) => { const t = x.invert(d3.pointer(ev)[0]); const r = rows[d3.bisector((q) => q.t).center(rows, t)]; const tot = d3.sum(series, (s) => val(r, s)) || 1;
        rule.attr('x1', x(r.t)).attr('x2', x(r.t)).attr('opacity', 1);
        tip.show(ev, opt.daily ? pr({ weekday: 'short', month: 'short', day: 'numeric' })(r.t) : tFmt(r.t),
          [...series.filter((s) => val(r, s) > 0).sort((a, b) => val(r, b) - val(r, a)).slice(0, 12).map((s) => [s.color, s.label, G.f1(val(r, s)) + ' ' + opt.unit + ', ' + G.pct((val(r, s) / tot) * 100)]), [null, 'Total', G.f1(tot) + ' ' + opt.unit],
            ...(r._near != null ? [[null, r._near <= 20 * 60000 ? 'Split from a reading' : 'Split estimated', r._near <= 20 * 60000 ? 'within 20 min' : 'nearest reading ' + Math.round(r._near / 60000) + ' min away']] : [])]); })
      .on('mouseleave.tip', () => { rule.attr('opacity', 0); tip.hide(); });
  }
  const weightsOf = (rows) => { const g = rows.slice(1).map((r, i) => (r.t - rows[i].t) / H).sort((a, b) => a - b), typ = g.length ? g[Math.floor(g.length / 2)] : 0.25; return rows.map((r, i) => Math.min(i < rows.length - 1 ? (rows[i + 1].t - r.t) / H : typ, 1)); };
  let otRange = '24h', otView = 'plant', otZoom = null;
  function setOtZoom(z) { otZoom = z; overTime(); }
  const plantHidden = new Set();
  function fuelChart() {
    const box = document.getElementById('fuel-chart'), leg = document.getElementById('fuel-legend'), note = document.getElementById('fuel-note');
    const daily = otRange === '30d' || otRange === 'all';
    const U = daily ? null : uniformRows(otRange);
    const rows = daily ? dayRows(otRange) : U.rows;
    const keys = FUELS.filter(([k]) => rows.some((r) => (daily ? (r.energy_by_fuel_mwh || {})[k] : Number(r['mw_' + k])) > 0));
    const series = keys.map(([k, n]) => ({ key: k, label: n, color: G.color(n), get: daily ? (r) => ((r.energy_by_fuel_mwh || {})[k] || 0) / 1000 : (r) => r['mw_' + k] }));
    const w = daily ? rows.map(() => 1) : weightsOf(rows);
    const energy = Object.fromEntries(series.map((s) => [s.key, d3.sum(rows, (r, i) => (Number(s.get(r)) || 0) * w[i])]));
    const tot = d3.sum(Object.values(energy)) || 1, maj = series.reduce((a, s) => (!a || energy[s.key] > energy[a.key] ? s : a), null);
    leg.replaceChildren();
    for (const s of series) { const sp = el('span', maj && s.key === maj.key ? 'maj' : ''); const sw = el('span', 'gx-sw'); sw.style.background = s.color; sp.append(sw, s.label + ' ' + G.pct((energy[s.key] / tot) * 100)); if (maj && s.key === maj.key) sp.append(el('b', null, ' majority')); leg.append(sp); }
    stackChart(box, rows, series, { domain: otZoom, onZoom: setOtZoom, ticks: U ? U.readings.map((r) => r.t) : null, unit: daily ? 'GWh' : 'MW', daily, strip: true, height: 320, empty: daily ? 'Daily totals appear after the first day of readings.' : 'No readings in this period yet.' });
  }
  function plantChart() {
    const box = document.getElementById('plant-chart'), leg = document.getElementById('plant-legend'), now = document.getElementById('plant-now');
    const daily = otRange === '30d' || otRange === 'all';
    const U = daily ? null : uniformRows(otRange);
    const rows = daily ? dayRows(otRange) : U.rows;
    const src = (r) => (daily ? r.plant_energy_mwh : r.plant_mw) || {};
    const totals = {}; rows.forEach((r) => { for (const [p, v] of Object.entries(src(r))) totals[p] = (totals[p] || 0) + (Number(v) || 0); });
    const plants = Object.keys(totals).filter((p) => totals[p] > 0).sort((a, b) => totals[b] - totals[a]);
    buildPlantColors(plants);
    const series = plants.filter((p) => !plantHidden.has(p)).map((p) => ({ key: p, label: p, color: plantColor(p), get: daily ? (r) => (src(r)[p] || 0) / 1000 : (r) => src(r)[p] || 0 }));
    stackChart(box, rows, series, { domain: otZoom, onZoom: setOtZoom, ticks: U ? U.readings.map((r) => r.t) : null, unit: daily ? 'GWh' : 'MW', daily, height: 360, empty: daily ? 'Daily totals appear after the first day of readings.' : 'No readings in this period yet.' });
    leg.replaceChildren();
    const head = el('div', 'pl-head'); head.append(el('span', null, 'Plant')); const allB = el('button', 'linkbtn', plantHidden.size ? 'Show all' : 'Hide all'); allB.type = 'button';
    allB.addEventListener('click', () => { if (plantHidden.size) plantHidden.clear(); else plants.forEach((p) => plantHidden.add(p)); plantChart(); }); head.append(allB); leg.append(head);
    for (const p of plants) {
      const b = el('button', 'pl-item' + (plantHidden.has(p) ? ' off' : '')); b.type = 'button'; b.setAttribute('aria-pressed', String(!plantHidden.has(p)));
      const sw = el('span', 'gx-sw'); sw.style.background = plantColor(p); b.append(sw, el('span', 'pl-n', p));
      b.addEventListener('click', () => { if (plantHidden.has(p)) plantHidden.delete(p); else plantHidden.add(p); plantChart(); }); leg.append(b);
    }
    if (!now) return;
    now.replaceChildren();
    const last = G.rows('history').filter((r) => r.plant_mw).slice(-1)[0];
    if (!last) { now.append(el('p', 'gx-note', 'Waiting for a reading.')); return; }
    const entries = Object.entries(last.plant_mw).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]); const tot = d3.sum(entries, (e) => e[1]) || 1, mx = entries[0] ? entries[0][1] : 1;
    for (const [p, v] of entries) {
      const r = el('div', 'pn-row'); const cost = (last.plant_cost || {})[p];
      const bar = el('span', 'pn-bar'); const f = el('span'); f.style.width = (v / mx) * 100 + '%'; f.style.background = plantColor(p); bar.append(f);
      r.append(el('span', 'pn-n', p), bar, el('span', 'pn-v', G.f0(Math.round(v)) + ' MW'), el('span', 'pn-s', G.pct((v / tot) * 100)), el('span', 'pn-c', cost ? G.moneyC(cost) + '/h' : '—'));
      now.append(r);
    }
  }
  function overTime() {
    document.querySelectorAll('#ot-range button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === otRange)));
    document.querySelectorAll('#ot-view button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === otView)));
    document.getElementById('ot-reset').hidden = !otZoom;
    document.getElementById('ot-plant').hidden = otView !== 'plant'; document.getElementById('ot-fuel').hidden = otView !== 'fuel';
    if (otView === 'plant') plantChart(); else fuelChart();
    const rows = otRange === '30d' || otRange === 'all' ? dayRows(otRange) : readingRows(otRange);
    const U = rows.length && otRange !== '30d' && otRange !== 'all' ? uniformRows(otRange) : null;
    document.getElementById('fuel-note').textContent = !rows.length ? 'This chart fills in as readings are saved.' : U && U.uniform ? 'Total generation every ' + (otRange === '24h' ? '5' : '15') + ' minutes from PREPA’s record; the split comes from ' + U.readings.length + ' readings of every unit in this period (ticks under the chart) and is estimated between them.' : '';
  }
  document.getElementById('ot-range').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; otRange = b.dataset.v; otZoom = null; overTime(); });
  document.getElementById('ot-reset').addEventListener('click', () => setOtZoom(null));
  document.getElementById('ot-view').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; otView = b.dataset.v; overTime(); });

  /* ---------- History status ---------- */
  function histBar() {
    const t = document.getElementById('hist-text'); const st = G.rows('status')[0] || {};
    const hist = G.rows('history'), first = hist[0];
    const gh = st.runner === 'GitHub Actions' && st.last_run;
    let txt = st.local_error ? 'This browser cannot save history (' + st.local_error + '). ' : st.local_since ? 'Saving history on this device since ' + tFmt(new Date(st.local_since)) + ' (' + G.f0(st.local_checks || 0) + ' readings). ' : 'History on this device starts with the first reading. ';
    txt += gh ? 'Shared history from the GitHub updater, last run ' + tFmt(new Date(st.last_run)) + '. ' : 'The GitHub updater has not run yet, so history only covers the times this page was open. ';
    if (first) txt += 'Charts cover ' + tFmt(new Date(first.at)) + ' onward.';
    t.textContent = txt;
  }
  document.getElementById('hist-csv').addEventListener('click', () => window.LIVE && LIVE.exportCSV());

  /* ---------- 24-hour outage log (paired out / back) ---------- */
  function outageLog() {
    const evs = G.rows('unit_events').filter((e) => e.event === 'Went offline' || e.event === 'Back online').map((e) => ({ ...e, t: new Date(e.detected_at) })).sort((a, b) => a.t - b.t);
    const units = G.rows('live_units');
    const anchor = units.length ? new Date(units[0].snapshot) : evs.length ? evs[evs.length - 1].t : new Date();
    const open = new Map(), rows = [];
    for (const e of evs) {
      const k = e.plant + '|' + e.unit;
      if (e.event === 'Went offline') { if (!open.has(k)) open.set(k, e); }
      else { const o = open.get(k); rows.push({ key: k + '|' + (o ? o.detected_at : 'before|' + e.detected_at), plant: e.plant, unit: e.unit, out: o ? o.t : null, back: e.t, lost: o ? Number(o.mw_before) : null }); open.delete(k); }
    }
    for (const [k, o] of open) rows.push({ key: k + '|' + o.detected_at, plant: o.plant, unit: o.unit, out: o.t, back: null, lost: Number(o.mw_before) });
    const recent = rows.filter((r) => (r.out && anchor - r.out <= 24 * H) || (r.back && anchor - r.back <= 24 * H) || (!r.back));
    document.getElementById('events-empty').hidden = !(G.ok('unit_events') && !recent.length);
    G.table(document.getElementById('outlog-table'), recent.map((r) => ({ ...r, unit_name: r.plant + ', ' + r.unit, out_v: r.out ? +r.out : 0, back_v: r.back ? +r.back : 0, dur_v: (r.back || anchor) - (r.out || r.back || anchor), state: r.back ? 'Back in service' : 'Still out' })), [
      { k: 'unit_name' },
      { k: 'out_v', fmt: (v, r) => (r.out ? tFmt(r.out) : 'before monitoring') },
      { k: 'back_v', fmt: (v, r) => (r.back ? tFmt(r.back) : '—') },
      { k: 'dur_v', num: true, fmt: (v, r) => (r.out ? (r.back ? '' : 'so far ') + dur(v) : '—') },
      { k: 'lost', num: true, fmt: (v) => (v == null ? '—' : G.f1(v)) },
      { k: 'state', render: (td, r) => { const off = !r.back; const s = el('span', 'gx-pill ' + (off ? 'gx-t-bad' : 'gx-t-ok')); s.append(el('i', 'gx-dot ' + (off ? 'bad' : 'ok')), r.state); td.append(s); } },
    ], { key: 'key', sortKey: 'out_v', redraw: () => dash.rerun() });
  }

  /* ---------- Municipal map ---------- */
  const SITES = {
    'San Juan': [18.425, -66.085, 'San Juan (steam, combined cycle, TM units)'], 'Palo Seco': [18.448, -66.160, 'Palo Seco (steam, CT blocks, TM units)'],
    Aguirre: [17.975, -66.255, 'Aguirre (steam, combined cycle)'], 'Costa Sur': [18.005, -66.800, 'Costa Sur (steam)'],
    Cambalache: [18.4705, -66.6990, 'Cambalache'], 'Mayagüez': [18.2140, -67.1570, 'Mayagüez'], AES: [17.965, -66.120, 'AES (coal)'], 'EcoEléctrica': [18.000, -66.705, 'EcoEléctrica (LNG)'],
    'Vega Baja': [18.4700, -66.4050, 'Vega Baja peakers'], Jobos: [17.995, -66.180, 'Jobos peakers'], Daguao: [18.2180, -65.6820, 'Daguao peakers'], Yabucoa: [18.0420, -65.8650, 'Yabucoa peakers'],
    'Dos Bocas (hydro)': [18.3330, -66.6670, 'Dos Bocas (hydro)'], 'Caonillas (hydro)': [18.2780, -66.6520, 'Caonillas (hydro)'], 'Garzas (hydro)': [18.1220, -66.7350, 'Garzas (hydro)'],
    'Rio Blanco (hydro)': [18.2400, -65.8000, 'Río Blanco (hydro)'], 'Toro Negro (hydro)': [18.1700, -66.4900, 'Toro Negro (hydro)'], 'Yauco (hydro)': [18.0700, -66.8600, 'Yauco (hydro)'],
    Pattern: [17.9670, -66.4050, 'Pattern Santa Isabel (wind)'], 'Punta Lima': [18.2100, -65.6600, 'Punta Lima (wind)'], 'San Fermin': [18.4000, -65.9100, 'San Fermín (solar)'],
    Ilumina: [17.9750, -66.1100, 'Ilumina (solar)'], Horizon: [17.9900, -66.2900, 'Horizon (solar)'], 'Coto Laurel': [18.0450, -66.5500, 'Coto Laurel (solar)'],
    Oriana: [18.4650, -67.0300, 'Oriana (solar)'], Fonroche: [18.1400, -65.8300, 'Fonroche (solar)'], 'Toa Baja': [18.4400, -66.2100, 'Toa Baja (landfill gas)'], Fajardo: [18.3100, -65.6700, 'Fajardo (landfill gas)'],
  };
  const siteOf = (u) => {
    if (u.plant === 'GT stations (peakers)') return u.unit === 'FEMA GT SJ' ? 'San Juan' : u.unit === 'FEMA GT PS' ? 'Palo Seco' : u.unit;
    if (['Wind', 'Solar', 'Landfill'].includes(u.plant)) return u.unit;
    if (/\(hydro\)$/.test(u.plant)) return u.plant;
    return u.plant.replace(/ (Steam|CC( \d)?|GT\/CT)$/, '');
  };
  const MUNI = { 'San Juan': 'San Juan', 'Palo Seco': 'Toa Baja', Aguirre: 'Salinas', 'Costa Sur': 'Guayanilla', Cambalache: 'Arecibo', 'Mayagüez': 'Mayagüez', AES: 'Guayama', 'EcoEléctrica': 'Peñuelas',
    'Vega Baja': 'Vega Baja', Jobos: 'Guayama', Daguao: 'Ceiba', Yabucoa: 'Yabucoa', 'Dos Bocas (hydro)': 'Utuado', 'Caonillas (hydro)': 'Utuado', 'Garzas (hydro)': 'Peñuelas', 'Rio Blanco (hydro)': 'Naguabo',
    'Toro Negro (hydro)': 'Villalba', 'Yauco (hydro)': 'Yauco', Pattern: 'Santa Isabel', 'Punta Lima': 'Naguabo', 'San Fermin': 'Loíza', Ilumina: 'Guayama', Horizon: 'Salinas', 'Coto Laurel': 'Ponce',
    Oriana: 'Isabela', Fonroche: 'Humacao', 'Toa Baja': 'Toa Baja', Fajardo: 'Fajardo' };
  const LABEL = { 'San Juan': [10, -10, 'start'], 'Palo Seco': [-10, -10, 'end'], 'Costa Sur': [-12, 16, 'end'], 'EcoEléctrica': [10, -12, 'start'], Aguirre: [-6, 24, 'end'],
    AES: [12, 18, 'start'], Cambalache: [0, -14, 'middle'], 'Mayagüez': [12, 4, 'start'] };
  let mapPlant = '', mapFilter = 'all', ptStatus = 'all', ptMode = 'plants', ptQuery = '';
  const RENEW = ['Hydro', 'Solar', 'Wind', 'Landfill gas'];
  function allSites() {
    const cap = (G.rows('unit_capacity')[0] || { units: {} }).units;
    return d3.groups(G.rows('live_units'), siteOf).map(([site, us]) => {
      const mw = d3.sum(us, (u) => Math.max(0, Number(u.mw))), on = us.filter((u) => u.status === 'Generating').length, cost = d3.sum(us, (u) => Number(u.cost_usd_per_hour) || 0);
      const costMW = d3.sum(us.filter((u) => u.status === 'Generating' && Number(u.cost_cents_kwh) > 0), (u) => Number(u.mw));
      const renewable = us.every((u) => RENEW.includes(u.fuel));
      const fuels = [...new Set(us.map((u) => G.norm(u.fuel)))];
      return { site, us, mw, on, cost, cents: costMW ? cost / (costMW * 10) : null, renewable, ops: new Set(us.map((u) => u.operator)), operator: [...new Set(us.map((u) => u.operator))].join(', '),
        fuel: fuels.join(', '), state: on === us.length ? 'ok' : on > 0 ? 'partial' : renewable ? 'idle' : 'out', pos: SITES[site], muni: MUNI[site], cap };
    }).filter((x) => x.pos);
  }
  const byOperator = (x) => mapFilter === 'all' || (mapFilter === 'renew' ? x.renewable : x.ops.has(mapFilter));
  const label = (x) => x.pos[2].replace(/ \(.+\)$/, '');
  function mapView() {
    const box = document.getElementById('pr-map'), lg = document.getElementById('map-legend');
    document.querySelectorAll('#map-filter button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === mapFilter)));
    const fc = G.rows('pr_map')[0];
    if (!fc || !G.rows('live_units').length) { G.failOrSkeleton(box, ['pr_map', 'live_units']); return; }
    const sites = allSites().filter(byOperator).sort((a, b) => b.mw - a.mw);
    if (mapPlant && !sites.some((x) => x.site === mapPlant)) mapPlant = '';
    box.replaceChildren(); box.classList.remove('dash-skeleton');
    const W = Math.max(300, box.clientWidth || 700), Hh = Math.round(W * 0.42);
    const proj = d3.geoMercator().fitExtent([[6, 18], [W - 6, Hh - 6]], fc), path = d3.geoPath(proj);
    const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('width', '100%').attr('height', Hh).attr('role', 'img').attr('aria-label', 'Map of Puerto Rico with power plants');
    // the whole island in one color, municipal lines hidden
    svg.append('g').selectAll('path').data(fc.features).join('path').attr('class', 'land').attr('d', path);
    const tip = G.tipFor(box.closest('.gx-card'));
    const gm = svg.append('g');
    for (const x of sites.slice().reverse()) {
      const [px, py] = proj([x.pos[1], x.pos[0]]), r = 3.5 + Math.sqrt(x.mw) * 0.55 * Math.min(1.4, W / 700);
      const g = gm.append('g').attr('class', 'site ' + x.state + (x.site === mapPlant ? ' sel' : '') + (mapPlant && x.site !== mapPlant ? ' dim' : '')).attr('transform', `translate(${px},${py})`).attr('tabindex', 0).attr('role', 'button')
        .attr('aria-label', x.pos[2] + ', ' + Math.round(x.mw) + ' MW');
      g.append('circle').attr('class', 'halo').attr('r', r + 4); g.append('circle').attr('class', 'dot').attr('r', r);
      const pick = () => { selectPlant(mapPlant === x.site ? '' : x.site); };
      g.on('click', pick).on('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } })
        .on('mousemove', (ev) => tip.show(ev, x.pos[2], [[null, 'Output', G.f0(Math.round(x.mw)) + ' MW'], [null, 'Units on', x.on + ' of ' + x.us.length], [null, 'Cost', x.cost ? G.money(Math.round(x.cost)) + '/h' : 'no reported cost'], ...(x.cents ? [[null, 'Average', G.f1(x.cents) + ' ¢/kWh']] : [])]))
        .on('mouseleave', () => tip.hide());
      const lb = LABEL[x.site] || (x.site === mapPlant ? [10, -10, 'start'] : null);
      if (lb && (!mapPlant || x.site === mapPlant)) {
        const t = gm.append('text').attr('class', 'site-lbl').attr('x', px + lb[0]).attr('y', py + lb[1]).attr('text-anchor', lb[2]);
        t.append('tspan').text(label(x));
        t.append('tspan').attr('x', px + lb[0]).attr('dy', '1.15em').attr('class', 'site-sub').text(G.f0(Math.round(x.mw)) + ' MW' + (x.cost ? ', ' + G.moneyC(x.cost) + '/h' : ''));
      }
    }
    lg.replaceChildren();
    for (const [c, t] of [['ok', 'All units on'], ['partial', 'Some units on'], ['out', 'All units off'], ['idle', 'Solar, wind or hydro with no output']]) { const sp = el('span'); sp.append(el('i', c), t); lg.append(sp); }
    lg.append(el('span', 'ap', 'Dot size follows MW. Locations approximate.'));
  }
  function selectPlant(site) { mapPlant = site; if (site) ptMode = 'units'; mapView(); plantTable(); }
  function plantTable() {
    const tb = document.getElementById('pt-table'), chip = document.getElementById('pt-chip'), kp = document.getElementById('pt-kpis');
    document.querySelectorAll('#pt-status button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === ptStatus)));
    document.querySelectorAll('#pt-mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === ptMode)));
    if (!G.ok('live_units')) return;
    const q = ptQuery.trim().toLowerCase();
    const sites = allSites().filter(byOperator).filter((x) => !mapPlant || x.site === mapPlant);
    chip.hidden = !mapPlant; chip.replaceChildren();
    if (mapPlant) { const x = sites[0]; chip.append('Showing ' + (x ? x.pos[2] : mapPlant) + (x && x.muni ? ', ' + x.muni : '') + ' '); const b = el('button', 'linkbtn', 'Show all plants'); b.type = 'button'; b.addEventListener('click', () => { ptMode = 'plants'; selectPlant(''); }); chip.append(b); }
    let rows, cols;
    if (ptMode === 'plants') {
      rows = sites.filter((x) => (ptStatus === 'all' || (ptStatus === 'on' ? x.on > 0 : x.on === 0)) && (!q || (x.pos[2] + ' ' + x.fuel + ' ' + x.operator + ' ' + (x.muni || '')).toLowerCase().includes(q)))
        .map((x) => ({ key: x.site, plant: label(x), muni: x.muni || '', operator: x.operator, fuel: x.fuel, state: x.state, units_on: x.on, units: x.us.length, mw: x.mw, cost: x.cost, cents: x.cents, _x: x }));
      const totMW = d3.sum(rows, (r) => r.mw) || 1;
      rows.forEach((r) => { r.share = (r.mw / totMW) * 100; });
      cols = [
        ['Plant', { k: 'plant', render: (td, r) => { td.append(el('span', 'pt-name', r.plant)); if (r.muni) td.append(el('span', 'pt-sub', r.muni)); } }],
        ['Operator', { k: 'operator' }], ['Fuel', { k: 'fuel' }],
        ['Status', { k: 'state', render: (td, r) => { const m = { ok: ['ok', 'All on'], partial: ['warn', 'Partly on'], out: ['bad', 'All off'], idle: ['', 'No output'] }[r.state]; const sp = el('span', 'gx-pill'); const d = el('i', 'gx-dot ' + m[0]); if (!m[0]) d.style.background = 'var(--steel)'; sp.append(d, m[1]); td.append(sp); } }],
        ['Units on', { k: 'units_on', num: true, fmt: (v, r) => v + ' / ' + r.units }], ['MW', { k: 'mw', num: true, fmt: (v) => G.f1(v) }], ['Share', { k: 'share', num: true, fmt: (v) => G.pct(v) }],
        ['$/hour', { k: 'cost', num: true, fmt: (v) => (v ? G.money(Math.round(v)) : '—') }], ['¢/kWh', { k: 'cents', num: true, fmt: (v) => (v ? G.f2(v) : '—') }],
      ];
    } else {
      rows = sites.flatMap((x) => x.us.map((u) => ({ x, u }))).filter(({ u }) => (ptStatus === 'all' || (ptStatus === 'on' ? u.status === 'Generating' : u.status !== 'Generating')) && (!q || (u.unit + ' ' + u.plant + ' ' + u.fuel).toLowerCase().includes(q)))
        .map(({ x, u }) => { const rated = (x.cap[u.unit_id] || {}).rated_mw ?? null; return { key: u.unit_id, unit: u.unit, plant: u.plant, fuel: G.norm(u.fuel), status: u.status, mw: Math.max(0, Number(u.mw)), rated, load: rated ? (Math.max(0, Number(u.mw)) / rated) * 100 : null, cents: Number(u.cost_cents_kwh) || null, cost: Number(u.cost_usd_per_hour) || 0 }; });
      cols = [
        ['Unit', { k: 'unit', render: (td, r) => { td.append(el('span', 'pt-name', r.unit)); td.append(el('span', 'pt-sub', r.plant)); } }],
        ['Fuel', { k: 'fuel' }],
        ['Status', { k: 'status', render: (td, r) => { const on = r.status === 'Generating'; const sp = el('span', 'gx-pill ' + (on ? 'gx-t-ok' : 'gx-t-bad')); sp.append(el('i', 'gx-dot ' + (on ? 'ok' : 'bad')), on ? 'ON' : 'OFF'); td.append(sp); } }],
        ['MW', { k: 'mw', num: true, fmt: (v) => G.f1(v) }], ['Rated MW', { k: 'rated', num: true, fmt: (v) => (v == null ? '—' : G.f0(v)) }], ['Load', { k: 'load', num: true, fmt: (v) => (v == null ? '—' : G.pct(v)) }],
        ['¢/kWh', { k: 'cents', num: true, fmt: (v) => (v ? G.f2(v) : '—') }], ['$/hour', { k: 'cost', num: true, fmt: (v) => (v ? G.money(Math.round(v)) : '—') }],
      ];
    }
    // header for the current mode (sorting resets when the columns change)
    const sig = ptMode + cols.length;
    if (tb.dataset.sig !== sig) { tb.dataset.sig = sig; tb._sort = { key: 'mw', dir: 'desc' }; const tr = el('tr'); for (const [t, c] of cols) { const th = el('th', c.num ? 'num' : '', t); th.dataset.field = c.k; tr.append(th); } tb.tHead.replaceChildren(tr); }
    const tot = { key: '__total', plant: 'Total', unit: 'Total', mw: d3.sum(rows, (r) => r.mw), cost: d3.sum(rows, (r) => r.cost), share: rows.length ? 100 : null, units_on: d3.sum(rows, (r) => r.units_on || 0), units: d3.sum(rows, (r) => r.units || 0), _total: true };
    tot.cents = null;
    G.table(tb, rows.length ? [...rows, tot] : [], cols.map(([, c]) => ({ ...c, render: c.render ? (td, r) => (r._total ? (td.textContent = c.k === 'plant' || c.k === 'unit' ? 'Total (' + rows.length + ')' : '') : c.render(td, r)) : undefined, fmt: c.fmt ? (v, r) => (r._total && !['mw', 'cost', 'share', 'units_on'].includes(c.k) ? '' : c.fmt(v, r)) : (v, r) => (r._total ? '' : v == null ? '—' : String(v)) })),
      { key: 'key', pinLast: (r) => r._total, rowStyle: (tr, r) => { if (r._total) tr.className = 'pt-total'; else if (ptMode === 'plants') { tr.classList.add('pt-click'); tr.addEventListener('click', () => selectPlant(r.key)); } }, redraw: plantTable });
    document.getElementById('pt-empty').hidden = rows.length > 0;
    // small totals under the map
    kp.replaceChildren();
    const k = (l, v, n) => { const d = el('div', 'gx-kpi'); d.append(el('div', 'gx-kpi-l', l), el('div', 'gx-kpi-v', v), el('div', 'gx-kpi-n', n)); kp.append(d); };
    const all = sites; const mwAll = d3.sum(all, (x) => x.mw), cAll = d3.sum(all, (x) => x.cost);
    k('Output shown', G.f0(Math.round(mwAll)) + ' MW', all.length + ' plant' + (all.length === 1 ? '' : 's'));
    k('Cost per hour', G.moneyC(cAll), mwAll ? '$' + (cAll / (mwAll * 1000)).toFixed(3) + ' per kWh' : '');
    k('Units on', G.f0(d3.sum(all, (x) => x.on)) + ' / ' + G.f0(d3.sum(all, (x) => x.us.length)), 'generating now');
  }
  document.getElementById('map-filter').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; mapFilter = b.dataset.v; mapPlant = ''; mapView(); plantTable(); });
  document.getElementById('pt-status').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; ptStatus = b.dataset.v; plantTable(); });
  document.getElementById('pt-mode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; ptMode = b.dataset.v; plantTable(); });
  document.getElementById('pt-q').addEventListener('input', (e) => { ptQuery = e.target.value; plantTable(); });

  /* ---------- Unit gauges ---------- */
  function gauges() {
    const box = document.getElementById('gauges');
    document.querySelectorAll('#board-filter button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === gaugeOp)));
    if (!G.ok('live_units')) { G.failOrSkeleton(box, ['live_units']); return; }
    box.replaceChildren(); box.classList.remove('dash-skeleton');
    const cap = G.rows('unit_capacity')[0] || { units: {}, plants: {} };
    const ranges = G.rows('unit_ranges')[0] || {};
    const units = G.rows('live_units').filter((u) => gaugeOp === 'all' || u.operator === gaugeOp);
    const plants = d3.groups(units, (u) => u.plant).map(([p, us]) => ({ p, us, mw: d3.sum(us, (u) => Math.max(0, Number(u.mw))), on: us.filter((u) => u.status === 'Generating').length }))
      .sort((a, b) => b.mw - a.mw || a.p.localeCompare(b.p));
    for (const pl of plants) {
      const ratedUnits = pl.us.map((u) => (cap.units[u.unit_id] || {}).rated_mw).filter((v) => v != null);
      const plantRated = (cap.plants[pl.p] || {}).rated_mw ?? (ratedUnits.length === pl.us.length ? d3.sum(ratedUnits) : null);
      const card = el('div', 'gplant' + (pl.on === 0 ? ' out' : pl.on < pl.us.length ? ' partial' : ''));
      const hd = el('div', 'gplant-h'); hd.append(el('div', 'gplant-n', pl.p), el('div', 'gplant-m', G.f0(Math.round(pl.mw)) + (plantRated ? ' of ' + G.f0(plantRated) : '') + ' MW, ' + pl.on + '/' + pl.us.length + ' on'));
      card.append(hd);
      if (plantRated) { const bar = el('div', 'gplant-bar'); const f = el('span'); f.style.width = Math.min(100, (pl.mw / plantRated) * 100) + '%'; f.style.background = G.color(pl.us[0].fuel); bar.append(f); card.append(bar); }
      card.append(el('div', 'plant-f', pl.us[0].fuel + ', ' + pl.us[0].operator));
      const grid = el('div', 'ggrid');
      for (const u of pl.us) {
        const c = cap.units[u.unit_id] || {}, rg = ranges[u.unit_id] || null, mwv = Math.max(0, Number(u.mw)), on = u.status === 'Generating';
        const max = c.rated_mw ?? (Math.max(rg ? rg.max_on_mw : 0, mwv) || 1);
        const tile = el('div', 'gunit' + (on ? '' : ' off'));
        tile.title = u.unit + ': ' + G.f2(Number(u.mw)) + ' MW' + (c.rated_mw ? ', rated ' + c.rated_mw + ' MW (' + c.source + ')' : ', no published rating') + (rg ? '. Seen running between ' + G.f1(rg.min_on_mw) + ' and ' + G.f1(rg.max_on_mw) + ' MW' : '') + (Number(u.cost_cents_kwh) > 0 ? '. Cost ' + G.f2(Number(u.cost_cents_kwh)) + ' ¢/kWh' : '');
        const S = 96, R = 38, cx = S / 2, cy = 46;
        const svg = d3.select(tile).append('svg').attr('viewBox', `0 0 ${S} 58`).attr('width', '100%').attr('height', 58);
        const sc = d3.scaleLinear([0, max], [-Math.PI / 2, Math.PI / 2]).clamp(true);
        const arc = d3.arc().innerRadius(R - 8).outerRadius(R);
        const g = svg.append('g').attr('transform', `translate(${cx},${cy})`);
        g.append('path').attr('d', arc({ startAngle: -Math.PI / 2, endAngle: Math.PI / 2 })).attr('fill', 'var(--cds-chart-grid)');
        if (rg) g.append('path').attr('d', d3.arc().innerRadius(R + 1).outerRadius(R + 4)({ startAngle: sc(rg.min_on_mw), endAngle: Math.max(sc(rg.max_on_mw), sc(rg.min_on_mw) + 0.03) })).attr('fill', 'var(--muted)').attr('opacity', 0.45);
        if (mwv > 0) g.append('path').attr('d', arc({ startAngle: -Math.PI / 2, endAngle: sc(mwv) })).attr('fill', on ? G.color(u.fuel) : 'var(--cds-chart-muted)');
        g.append('text').attr('class', 'gv').attr('text-anchor', 'middle').attr('y', -4).text(on ? G.f0(Math.round(mwv)) : 'OFF');
        g.append('text').attr('class', 'gm').attr('text-anchor', 'middle').attr('y', 9).text(on ? 'MW' : '');
        g.append('text').attr('class', 'gm').attr('x', -R + 4).attr('y', 11).attr('text-anchor', 'middle').text('0');
        g.append('text').attr('class', 'gm').attr('x', R - 4).attr('y', 11).attr('text-anchor', 'middle').text(G.f0(max) + (c.rated_mw ? '' : ' obs.'));
        const ft = el('div', 'gunit-f'); ft.append(el('span', 'gunit-n', u.unit), el('span', 'gstat ' + (on ? 'on' : 'off'), on ? 'ON' : 'OFF'));
        tile.append(ft); grid.append(tile);
      }
      card.append(grid); box.append(card);
    }
  }
  document.getElementById('board-filter').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; gaugeOp = b.dataset.v; gauges(); });

  /* ---------- Daily summary ---------- */
  function daily() {
    const kp = document.getElementById('day-kpis'); kp.replaceChildren();
    const days = G.rows('daily_summary');
    const kpi = (l, v, n) => { const d = el('div', 'gx-kpi'); d.append(el('div', 'gx-kpi-l', l), el('div', 'gx-kpi-v', v), el('div', 'gx-kpi-n', n)); kp.append(d); };
    if (!days.length) { kp.append(el('p', 'gx-note', G.st('daily_summary').status === 'error' ? 'The daily summary file has not been written yet: it appears after the first GitHub run.' : 'Loading…')); }
    else {
      const s = days[days.length - 1];
      const dname = pr({ weekday: 'short', month: 'short', day: 'numeric' })(new Date(s.day + 'T12:00:00-04:00'));
      kpi('Max demand, ' + dname, s.demand_max_mw == null ? '—' : G.f0(s.demand_max_mw) + ' MW', s.demand_max_at ? 'at ' + s.demand_max_at + ' (' + s.status.toLowerCase() + ')' : s.status);
      kpi('Min demand', s.demand_min_mw == null ? '—' : G.f0(s.demand_min_mw) + ' MW', s.demand_min_at ? 'at ' + s.demand_min_at : '');
      kpi('Max / min generation', s.gen_max_mw == null ? '—' : G.f0(Math.round(s.gen_max_mw)) + ' / ' + G.f0(Math.round(s.gen_min_mw)), 'MW, at ' + (s.gen_max_at || '—') + ' / ' + (s.gen_min_at || '—'));
      kpi('Majority fuel', s.majority_fuel || '—', ['lng', 'bunker_c', 'ulsd', 'coal'].map((k) => ({ lng: 'LNG', bunker_c: 'Bunker', ulsd: 'ULSD', coal: 'Coal' }[k] + ' ' + (s['share_' + k + '_pct'] ?? 0) + '%')).join(', '));
      kpi('Total cost of the day', G.moneyC(s.total_cost_usd), s.coverage_h >= 23.5 ? 'full day' : G.f1(s.coverage_h) + ' h covered; full-day pace ' + G.moneyC(s.cost_full_day_estimate_usd));
      kpi('Average cost', s.avg_cost_usd_per_kwh == null ? '—' : '$' + s.avg_cost_usd_per_kwh.toFixed(3) + '/kWh', 'all generation');
      kpi('Frequency max / min', s.freq_max_hz == null ? '—' : s.freq_max_hz.toFixed(2) + ' / ' + s.freq_min_hz.toFixed(2), 'Hz; average ' + (s.freq_avg_hz == null ? '—' : s.freq_avg_hz.toFixed(3)));
      kpi('Outages', G.f0(s.units_went_offline), 'units went offline; ' + s.units_came_back + ' came back');
    }
    G.table(document.getElementById('day-table'), days.slice().reverse(), [
      { k: 'day', fmt: (v, r) => pr({ weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })(new Date(v + 'T12:00:00-04:00')) + (r.status === 'In progress' ? ' (so far)' : '') },
      { k: 'demand_max_mw', num: true, fmt: (v, r) => (v == null ? '—' : G.f0(v) + ' at ' + r.demand_max_at) },
      { k: 'demand_min_mw', num: true, fmt: (v, r) => (v == null ? '—' : G.f0(v) + ' at ' + r.demand_min_at) },
      { k: 'gen_max_mw', num: true, fmt: (v) => (v == null ? '—' : G.f0(Math.round(v))) }, { k: 'gen_min_mw', num: true, fmt: (v) => (v == null ? '—' : G.f0(Math.round(v))) },
      { k: 'majority_fuel', fmt: (v) => v || '—' }, { k: 'total_cost_usd', num: true, fmt: (v) => (v == null ? '—' : G.moneyC(v)) },
      { k: 'avg_cost_usd_per_kwh', num: true, fmt: (v) => (v == null ? '—' : '$' + v.toFixed(3)) },
      { k: 'freq_max_hz', num: true, fmt: (v) => (v == null ? '—' : v.toFixed(2)) }, { k: 'freq_min_hz', num: true, fmt: (v) => (v == null ? '—' : v.toFixed(2)) }, { k: 'freq_avg_hz', num: true, fmt: (v) => (v == null ? '—' : v.toFixed(3)) },
      { k: 'units_went_offline', num: true },
      { k: 'day', render: (td, r) => { const a = el('a', null, r.day + '.txt'); a.href = 'logs/daily/' + r.day + '.txt'; td.append(a); if (r.units_went_offline || r.units_came_back) { td.append(' · '); const b = el('a', null, 'outages'); b.href = 'logs/outages/' + r.day + '.log'; td.append(b); } } },
    ], { key: 'day', redraw: () => dash.rerun() });
  }

  // Each part draws on its own, so a problem in one never blocks the others.
  dash.onData(() => { for (const f of [histBar, overTime, outageLog, gauges, daily, mapView, plantTable]) { try { f(); } catch (e) { console.error(f.name, e); } } });
})();
