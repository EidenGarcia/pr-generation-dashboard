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
  const plantColor = (p) => { const i = PLANT_ORDER.indexOf(p); return PALETTE[(i >= 0 ? i : PLANT_ORDER.length + (p.length % 5)) % PALETTE.length]; };
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
  function dayRows(range) {
    const d = G.rows('daily_summary').map((r) => ({ ...r, t: new Date(r.day + 'T12:00:00-04:00') }));
    if (!d.length) return d;
    const end = d[d.length - 1].t;
    return d.filter((r) => end - r.t <= RANGE_H[range] * H + 12 * H);
  }
  // series: [{ key, label, color, get(row) }]
  function stackChart(box, rows, series, opt) {
    box.replaceChildren(); box.classList.remove('dash-skeleton');
    const W = box.clientWidth || 700, Hh = opt.height || 340, top = opt.strip ? 26 : 10;
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
    const x = d3.scaleTime([new Date(+t0 - pad), new Date(+t1 + pad)], [ml, W - 8]);
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
    const tip = G.tipFor(box.closest('.gx-card'));
    const rule = svg.append('line').attr('y1', top).attr('y2', Hh - 26).attr('stroke', 'var(--cds-chart-reference)').attr('opacity', 0);
    svg.append('rect').attr('x', ml).attr('y', 0).attr('width', W - 8 - ml).attr('height', Hh - 26).attr('fill', 'transparent')
      .on('mousemove', (ev) => { const t = x.invert(d3.pointer(ev)[0]); const r = rows[d3.bisector((q) => q.t).center(rows, t)]; const tot = d3.sum(series, (s) => val(r, s)) || 1;
        rule.attr('x1', x(r.t)).attr('x2', x(r.t)).attr('opacity', 1);
        tip.show(ev, opt.daily ? pr({ weekday: 'short', month: 'short', day: 'numeric' })(r.t) : tFmt(r.t),
          [...series.filter((s) => val(r, s) > 0).sort((a, b) => val(r, b) - val(r, a)).slice(0, 12).map((s) => [s.color, s.label, G.f1(val(r, s)) + ' ' + opt.unit + ', ' + G.pct((val(r, s) / tot) * 100)]), [null, 'Total', G.f1(tot) + ' ' + opt.unit]]); })
      .on('mouseleave', () => { rule.attr('opacity', 0); tip.hide(); });
  }
  const weightsOf = (rows) => { const g = rows.slice(1).map((r, i) => (r.t - rows[i].t) / H).sort((a, b) => a - b), typ = g.length ? g[Math.floor(g.length / 2)] : 0.25; return rows.map((r, i) => Math.min(i < rows.length - 1 ? (rows[i + 1].t - r.t) / H : typ, 1)); };
  let fuelRange = '24h', plantRange = '24h';
  const plantHidden = new Set();
  function fuelChart() {
    const box = document.getElementById('fuel-chart'), leg = document.getElementById('fuel-legend'), note = document.getElementById('fuel-note');
    document.querySelectorAll('#fuel-range button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === fuelRange)));
    const daily = fuelRange === '30d' || fuelRange === 'all';
    const rows = daily ? dayRows(fuelRange) : readingRows(fuelRange);
    const keys = FUELS.filter(([k]) => rows.some((r) => (daily ? (r.energy_by_fuel_mwh || {})[k] : Number(r['mw_' + k])) > 0));
    const series = keys.map(([k, n]) => ({ key: k, label: n, color: G.color(n), get: daily ? (r) => ((r.energy_by_fuel_mwh || {})[k] || 0) / 1000 : (r) => r['mw_' + k] }));
    const w = daily ? rows.map(() => 1) : weightsOf(rows);
    const energy = Object.fromEntries(series.map((s) => [s.key, d3.sum(rows, (r, i) => (Number(s.get(r)) || 0) * w[i])]));
    const tot = d3.sum(Object.values(energy)) || 1, maj = series.reduce((a, s) => (!a || energy[s.key] > energy[a.key] ? s : a), null);
    leg.replaceChildren();
    for (const s of series) { const sp = el('span', maj && s.key === maj.key ? 'maj' : ''); const sw = el('span', 'gx-sw'); sw.style.background = s.color; sp.append(sw, s.label + ' ' + G.pct((energy[s.key] / tot) * 100)); if (maj && s.key === maj.key) sp.append(el('b', null, ' majority')); leg.append(sp); }
    stackChart(box, rows, series, { unit: daily ? 'GWh' : 'MW', daily, strip: true, height: 300, empty: daily ? 'Daily totals appear after the first day of readings.' : 'No readings in this period yet.' });
    note.textContent = rows.length < 4 ? 'This chart fills in with every reading: every 5 minutes while the page is open (saved on this device) and every 15 minutes from the GitHub updater.' : '';
  }
  function plantChart() {
    const box = document.getElementById('plant-chart'), leg = document.getElementById('plant-legend'), now = document.getElementById('plant-now');
    document.querySelectorAll('#plant-range button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === plantRange)));
    const daily = plantRange === '30d' || plantRange === 'all';
    const rows = daily ? dayRows(plantRange) : readingRows(plantRange);
    const src = (r) => (daily ? r.plant_energy_mwh : r.plant_mw) || {};
    const totals = {}; rows.forEach((r) => { for (const [p, v] of Object.entries(src(r))) totals[p] = (totals[p] || 0) + (Number(v) || 0); });
    const plants = Object.keys(totals).filter((p) => totals[p] > 0).sort((a, b) => totals[b] - totals[a]);
    const series = plants.filter((p) => !plantHidden.has(p)).map((p) => ({ key: p, label: p, color: plantColor(p), get: daily ? (r) => (src(r)[p] || 0) / 1000 : (r) => src(r)[p] || 0 }));
    stackChart(box, rows, series, { unit: daily ? 'GWh' : 'MW', daily, height: 360, empty: daily ? 'Daily totals appear after the first day of readings.' : 'No readings in this period yet.' });
    leg.replaceChildren();
    const head = el('div', 'pl-head'); head.append(el('span', null, 'Plant')); const allB = el('button', 'linkbtn', plantHidden.size ? 'Show all' : 'Hide all'); allB.type = 'button';
    allB.addEventListener('click', () => { if (plantHidden.size) plantHidden.clear(); else plants.forEach((p) => plantHidden.add(p)); plantChart(); }); head.append(allB); leg.append(head);
    for (const p of plants) {
      const b = el('button', 'pl-item' + (plantHidden.has(p) ? ' off' : '')); b.type = 'button'; b.setAttribute('aria-pressed', String(!plantHidden.has(p)));
      const sw = el('span', 'gx-sw'); sw.style.background = plantColor(p); b.append(sw, el('span', 'pl-n', p));
      b.addEventListener('click', () => { if (plantHidden.has(p)) plantHidden.delete(p); else plantHidden.add(p); plantChart(); }); leg.append(b);
    }
    // right now
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
  document.getElementById('fuel-range').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; fuelRange = b.dataset.v; fuelChart(); });
  document.getElementById('plant-range').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; plantRange = b.dataset.v; plantChart(); });

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
  let mapPlant = '', mapFilter = 'all';
  function mapView() {
    const box = document.getElementById('pr-map'), panel = document.getElementById('pr-map-panel'), sel = document.getElementById('map-plant'), lg = document.getElementById('map-legend');
    document.querySelectorAll('#map-filter button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === mapFilter)));
    const fc = G.rows('pr_map')[0], units = G.rows('live_units');
    if (!fc || !units.length) { G.failOrSkeleton(box, ['pr_map', 'live_units']); return; }
    const RENEW = ['Hydro', 'Solar', 'Wind', 'Landfill gas'];
    let sites = d3.groups(units, siteOf).map(([site, us]) => {
      const mw = d3.sum(us, (u) => Math.max(0, Number(u.mw))), on = us.filter((u) => u.status === 'Generating').length, cost = d3.sum(us, (u) => Number(u.cost_usd_per_hour) || 0);
      const costMW = d3.sum(us.filter((u) => u.status === 'Generating' && Number(u.cost_cents_kwh) > 0), (u) => Number(u.mw));
      const renewable = us.every((u) => RENEW.includes(u.fuel));
      return { site, us, mw, on, cost, cents: costMW ? cost / (costMW * 10) : null, renewable, ops: new Set(us.map((u) => u.operator)), state: on === us.length ? 'ok' : on > 0 ? 'partial' : renewable ? 'idle' : 'out', pos: SITES[site], muni: MUNI[site] };
    }).filter((s) => s.pos);
    sites = sites.filter((s) => mapFilter === 'all' || (mapFilter === 'renew' ? s.renewable : s.ops.has(mapFilter))).sort((a, b) => b.mw - a.mw);
    if (mapPlant && !sites.some((s) => s.site === mapPlant)) mapPlant = '';
    // plant picker
    const opts = [['', 'All plants'], ...sites.map((s) => [s.site, s.pos[2].replace(/ \(.+\)$/, '') + ' (' + G.f0(Math.round(s.mw)) + ' MW)'])];
    sel.replaceChildren(...opts.map(([v, t]) => { const o = el('option', null, t); o.value = v; if (v === mapPlant) o.selected = true; return o; }));
    // municipalities shaded by MW generated there
    const muniMW = d3.rollup(sites, (v) => d3.sum(v, (s) => s.mw), (s) => s.muni);
    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const base = dark ? '#243b52' : '#cdd8e1', deep = dark ? '#7fb6dd' : '#2f6385';
    const maxMW = d3.max([...muniMW.values()]) || 1;
    const shade = (m) => { const v = muniMW.get(m) || 0; return v > 0 ? d3.interpolateRgb(d3.interpolateRgb(base, deep)(0.25), deep)(Math.sqrt(v / maxMW)) : base; };
    box.replaceChildren(); box.classList.remove('dash-skeleton');
    const W = Math.max(320, box.clientWidth || 800), Hh = Math.round(W * 0.36);
    const proj = d3.geoMercator().fitExtent([[6, 6], [W - 6, Hh - 6]], fc), path = d3.geoPath(proj);
    const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('width', '100%').attr('height', Hh).attr('role', 'img').attr('aria-label', 'Map of Puerto Rico municipalities and power plants');
    const selSite = sites.find((s) => s.site === mapPlant);
    const tip = G.tipFor(box.closest('.gx-card'));
    svg.append('g').selectAll('path').data(fc.features).join('path').attr('class', 'muni').attr('d', path).attr('fill', (f) => shade(f.properties.name))
      .on('mousemove', (ev, f) => { const here = sites.filter((s) => s.muni === f.properties.name); tip.show(ev, f.properties.name, here.length ? here.map((s) => [null, s.pos[2].replace(/ \(.+\)$/, ''), G.f0(Math.round(s.mw)) + ' MW']) : [[null, 'No plant listed here', null]]); })
      .on('mouseleave', () => tip.hide())
      .on('click', (ev, f) => { const here = sites.filter((s) => s.muni === f.properties.name); if (here.length) { mapPlant = here[0].site; mapView(); } });
    if (selSite) svg.append('path').datum(fc.features.find((f) => f.properties.name === selSite.muni)).attr('class', 'muni-sel').attr('d', path);
    const gm = svg.append('g');
    for (const s of sites.slice().reverse()) {
      const [x, y] = proj([s.pos[1], s.pos[0]]), r = 3.5 + Math.sqrt(s.mw) * 0.6 * Math.min(1.4, W / 800);
      const g = gm.append('g').attr('class', 'site ' + s.state + (s.site === mapPlant ? ' sel' : '') + (selSite && s.site !== mapPlant ? ' dim' : '')).attr('transform', `translate(${x},${y})`).attr('tabindex', 0).attr('role', 'button')
        .attr('aria-label', s.pos[2] + ', ' + Math.round(s.mw) + ' MW');
      g.append('circle').attr('class', 'halo').attr('r', r + 4); g.append('circle').attr('class', 'dot').attr('r', r);
      const pick = () => { mapPlant = mapPlant === s.site ? '' : s.site; mapView(); };
      g.on('click', pick).on('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } })
        .on('mousemove', (ev) => { ev.stopPropagation(); tip.show(ev, s.pos[2], [[null, 'Output', G.f0(Math.round(s.mw)) + ' MW'], [null, 'Units on', s.on + ' of ' + s.us.length], [null, 'Cost', s.cost ? G.money(Math.round(s.cost)) + '/h' : 'no reported cost'], ...(s.cents ? [[null, 'Average', G.f1(s.cents) + ' ¢/kWh']] : [])]); })
        .on('mouseleave', () => tip.hide());
      const lb = LABEL[s.site] || (s.site === mapPlant ? [10, -10, 'start'] : null);
      if (lb && (!selSite || s.site === mapPlant)) {
        const t = gm.append('text').attr('class', 'site-lbl').attr('x', x + lb[0]).attr('y', y + lb[1]).attr('text-anchor', lb[2]);
        t.append('tspan').text(s.site.replace(/ \(.+\)$/, ''));
        t.append('tspan').attr('x', x + lb[0]).attr('dy', '1.15em').attr('class', 'site-sub').text(G.f0(Math.round(s.mw)) + ' MW' + (s.cost ? ', ' + G.moneyC(s.cost) + '/h' : ''));
      }
    }
    // legend
    lg.replaceChildren();
    const ramp = el('span', 'ramp'); ramp.style.background = `linear-gradient(90deg, ${base}, ${deep})`;
    lg.append(el('span', null, 'Municipality output: 0'), ramp, el('span', null, G.f0(Math.round(maxMW)) + ' MW'));
    for (const [c, t] of [['ok', 'All units on'], ['partial', 'Some on'], ['out', 'All off'], ['idle', 'No output (solar, wind, hydro)']]) { const sp = el('span'); sp.append(el('i', c), t); lg.append(sp); }
    // panel: selected plant with every unit's output and cost, or the island summary
    panel.replaceChildren();
    if (selSite) {
      const s = selSite;
      panel.append(el('div', 'mp-title', s.pos[2]), el('div', 'mp-s', s.muni + '. ' + G.f0(Math.round(s.mw)) + ' MW now, ' + s.on + ' of ' + s.us.length + ' units on'));
      const k = el('div', 'mp-k'); k.append(el('span', null, 'Cost now'), el('b', null, s.cost ? G.money(Math.round(s.cost)) + '/h' : '—'), el('span', null, 'Average'), el('b', null, s.cents ? G.f2(s.cents) + ' ¢/kWh' : '—')); panel.append(k);
      const tb = el('table', 'mp-t'); const th = el('tr'); for (const c of ['Unit', 'MW', '¢/kWh', '$/h']) th.append(el('th', null, c)); tb.append(th);
      for (const u of s.us) {
        const on = u.status === 'Generating'; const tr = el('tr', on ? '' : 'off');
        const n = el('td'); n.append(el('i', 'gx-dot ' + (on ? 'ok' : 'bad')), ' ' + (s.us.some((v) => v.plant !== s.us[0].plant) ? u.plant.replace(/^.*? (Steam|CC \d|CC|GT\/CT)$/, '$1') + ' ' : '') + u.unit);
        tr.append(n, el('td', 'num', on ? G.f1(Number(u.mw)) : 'OFF'), el('td', 'num', Number(u.cost_cents_kwh) > 0 ? G.f2(Number(u.cost_cents_kwh)) : '—'), el('td', 'num', on && Number(u.cost_usd_per_hour) > 0 ? G.moneyC(Number(u.cost_usd_per_hour)) : '—'));
        tb.append(tr);
      }
      panel.append(tb);
      const back = el('button', 'linkbtn', 'Show all plants'); back.type = 'button'; back.addEventListener('click', () => { mapPlant = ''; mapView(); }); panel.append(back);
    } else {
      const totMW = d3.sum(sites, (s) => s.mw), totC = d3.sum(sites, (s) => s.cost);
      panel.append(el('div', 'mp-title', mapFilter === 'all' ? 'All plants' : document.querySelector('#map-filter [data-v="' + mapFilter + '"]').textContent), el('div', 'mp-s', G.f0(Math.round(totMW)) + ' MW now, ' + G.money(Math.round(totC)) + '/h'));
      const tb = el('table', 'mp-t'); const th = el('tr'); for (const c of ['Plant', 'MW', '$/h', '¢/kWh']) th.append(el('th', null, c)); tb.append(th);
      for (const s of sites.filter((x) => x.mw > 0 || !x.renewable)) {
        const tr = el('tr', 'click' + (s.on ? '' : ' off')); const n = el('td'); n.append(el('i', 'gx-dot ' + (s.state === 'ok' ? 'ok' : s.state === 'partial' ? 'warn' : 'bad')), ' ' + s.pos[2].replace(/ \(.+\)$/, ''));
        tr.append(n, el('td', 'num', G.f0(Math.round(s.mw))), el('td', 'num', s.cost ? G.moneyC(s.cost) : '—'), el('td', 'num', s.cents ? G.f1(s.cents) : '—'));
        tr.addEventListener('click', () => { mapPlant = s.site; mapView(); }); tb.append(tr);
      }
      panel.append(tb);
    }
  }
  document.getElementById('map-plant').addEventListener('change', (e) => { mapPlant = e.target.value; mapView(); });
  document.getElementById('map-filter').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; mapFilter = b.dataset.v; mapPlant = ''; mapView(); });

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
  dash.onData(() => { for (const f of [histBar, fuelChart, plantChart, outageLog, gauges, daily, mapView]) { try { f(); } catch (e) { console.error(f.name, e); } } });
})();
