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

  /* ---------- Generation by fuel over time ---------- */
  function fuelChart() {
    const box = document.getElementById('fuel-chart'), leg = document.getElementById('fuel-legend'), note = document.getElementById('fuel-note');
    let rows = G.rows('history').map((r) => ({ ...r, t: new Date(r.at) })).sort((a, b) => a.t - b.t);
    if (!rows.length) { G.failOrSkeleton(box, ['history']); return; }
    const end = rows[rows.length - 1].t; rows = rows.filter((r) => end - r.t <= 24 * H);
    const keys = FUELS.filter(([k]) => rows.some((r) => num(r['mw_' + k]) > 0));
    const val = (r, k) => num(r['mw_' + k]) || 0;
    // time-weighted energy share over the window
    const gaps = rows.slice(1).map((r, i) => (r.t - rows[i].t) / H).sort((a, b) => a - b), typ = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0.25;
    const wts = rows.map((r, i) => Math.min(i < rows.length - 1 ? (rows[i + 1].t - r.t) / H : typ, 1));
    const energy = Object.fromEntries(keys.map(([k]) => [k, d3.sum(rows, (r, i) => val(r, k) * wts[i])]));
    const totE = d3.sum(Object.values(energy)) || 1;
    const last = rows[rows.length - 1], lastTot = d3.sum(keys, ([k]) => val(last, k)) || 1;
    const majK = keys.reduce((a, [k]) => (energy[k] > (energy[a] || -1) ? k : a), null);
    leg.replaceChildren();
    for (const [k, n] of keys) {
      const s = el('span', k === majK ? 'maj' : ''); const sw = el('span', 'gx-sw'); sw.style.background = G.color(n);
      s.append(sw, n + ' ' + G.pct((energy[k] / totE) * 100) + ' (' + G.f0(Math.round(val(last, k))) + ' MW now)'); if (k === majK) s.append(el('b', null, ' majority')); leg.append(s);
    }
    box.replaceChildren(); box.classList.remove('dash-skeleton');
    const W = box.clientWidth || 700, Hh = 300, top = 26;
    const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('width', '100%').attr('height', Hh);
    const stack = d3.stack().keys(keys.map(([k]) => k)).value((r, k) => val(r, k))(rows);
    const y = d3.scaleLinear([0, (d3.max(rows, (r) => d3.sum(keys, ([k]) => val(r, k))) || 1) * 1.05], [Hh - 26, top + 8]).nice();
    const ml = G.measure(svg, y.ticks(5).map(G.f0)) + 12;
    const span = rows.length > 1 ? [rows[0].t, end] : [new Date(+end - H), new Date(+end + H)];
    const x = d3.scaleTime(span, [ml, W - 8]);
    svg.append('g').selectAll('line').data(y.ticks(5)).join('line').attr('x1', ml).attr('x2', W - 8).attr('y1', y).attr('y2', y).attr('stroke', 'var(--cds-chart-grid)');
    svg.append('g').selectAll('text').data(y.ticks(5)).join('text').attr('x', ml - 6).attr('y', y).attr('dy', '0.35em').attr('text-anchor', 'end').text(G.f0);
    svg.append('text').attr('x', ml - 6).attr('y', top + 2).attr('text-anchor', 'end').text('MW');
    svg.append('g').selectAll('text').data(x.ticks(Math.max(3, Math.floor((W - ml) / 90)))).join('text').attr('x', x).attr('y', Hh - 6).attr('text-anchor', 'middle').text(hFmt);
    if (rows.length > 1) {
      svg.append('g').selectAll('path').data(stack).join('path').attr('fill', (s) => G.color(FUELS.find(([k]) => k === s.key)[1])).attr('opacity', 0.9)
        .attr('d', d3.area().x((d) => x(d.data.t)).y0((d) => y(d[0])).y1((d) => y(d[1])).curve(d3.curveStepAfter));
      // majority strip
      rows.forEach((r, i) => { const mk = keys.reduce((a, [k]) => (val(r, k) > val(r, a || k) ? k : a || k), null); const x0 = x(r.t), x1 = i < rows.length - 1 ? x(rows[i + 1].t) : W - 8;
        svg.append('rect').attr('x', x0).attr('y', 4).attr('width', Math.max(1, x1 - x0)).attr('height', 12).attr('fill', G.color(FUELS.find(([k]) => k === mk)[1])); });
      svg.append('text').attr('x', ml - 6).attr('y', 14).attr('text-anchor', 'end').text('Majority');
    } else {
      let acc = 0; const bw = 40, cx = x(end);
      for (const [k, n] of keys) { const v = val(last, k); svg.append('rect').attr('x', cx - bw / 2).attr('y', y(acc + v)).attr('width', bw).attr('height', y(acc) - y(acc + v)).attr('fill', G.color(n)); acc += v; }
    }
    note.textContent = rows.length < 4 ? 'The chart fills in as checks accumulate (every 15 minutes on GitHub, every 5 minutes while this page is open).' : '';
    const tip = G.tipFor(box.closest('.gx-card'));
    const rule = svg.append('line').attr('y1', top).attr('y2', Hh - 26).attr('stroke', 'var(--cds-chart-reference)').attr('opacity', 0);
    svg.append('rect').attr('x', ml).attr('y', 0).attr('width', W - 8 - ml).attr('height', Hh - 26).attr('fill', 'transparent')
      .on('mousemove', (ev) => { const t = x.invert(d3.pointer(ev)[0]); const i = Math.max(0, d3.bisector((r) => r.t).right(rows, t) - 1); const r = rows[i]; const tot = d3.sum(keys, ([k]) => val(r, k)) || 1;
        rule.attr('x1', x(r.t)).attr('x2', x(r.t)).attr('opacity', 1);
        tip.show(ev, tFmt(r.t), [...keys.filter(([k]) => val(r, k) > 0).sort((a, b) => val(r, b[0]) - val(r, a[0])).map(([k, n]) => [G.color(n), n, G.f0(Math.round(val(r, k))) + ' MW, ' + G.pct((val(r, k) / tot) * 100)]), [null, 'Total', G.f0(Math.round(tot)) + ' MW']]); })
      .on('mouseleave', () => { rule.attr('opacity', 0); tip.hide(); });
    if (!rows.length || !lastTot) note.textContent = 'No fuel data yet.';
  }

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

  /* ---------- Map ---------- */
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
  // Simplified outline of Puerto Rico, Vieques and Culebra as [latitude, longitude] points (a drawing, not a survey).
  const ISLANDS = [
    [[18.515, -67.155], [18.512, -67.03], [18.49, -66.88], [18.482, -66.70], [18.492, -66.55], [18.49, -66.40], [18.482, -66.27], [18.462, -66.16], [18.472, -66.118],
     [18.455, -66.03], [18.445, -65.92], [18.40, -65.79], [18.385, -65.70], [18.375, -65.625], [18.30, -65.625], [18.23, -65.595], [18.19, -65.69], [18.12, -65.75],
     [18.03, -65.81], [17.99, -65.88], [17.97, -66.00], [17.955, -66.07], [17.935, -66.15], [17.945, -66.25], [17.958, -66.40], [17.975, -66.55], [17.985, -66.64],
     [17.995, -66.78], [17.955, -66.88], [17.945, -66.98], [17.93, -67.10], [17.932, -67.19], [18.02, -67.18], [18.11, -67.20], [18.20, -67.165], [18.30, -67.24],
     [18.365, -67.27], [18.40, -67.20], [18.43, -67.165]],
    [[18.152, -65.57], [18.16, -65.45], [18.135, -65.30], [18.105, -65.27], [18.09, -65.40], [18.105, -65.55]],
    [[18.335, -65.33], [18.335, -65.25], [18.29, -65.245], [18.285, -65.32]],
  ];
  const LABEL = { 'San Juan': [14, 18, 'start'], 'Palo Seco': [-14, 18, 'end'], 'Costa Sur': [-14, -10, 'end'], 'EcoEléctrica': [14, -12, 'start'], Aguirre: [-8, 30, 'end'],
    AES: [16, -12, 'start'], Cambalache: [0, -14, 'middle'], 'Mayagüez': [14, 4, 'start'] };
  let selected = null;
  function mapView() {
    const box = document.getElementById('pr-map'), panel = document.getElementById('pr-map-panel');
    const units = G.rows('live_units'); if (!units.length) { G.failOrSkeleton(box, ['live_units']); return; }
    box.replaceChildren(); box.classList.remove('dash-skeleton');
    const W = Math.max(320, box.clientWidth || 700), lon0 = -67.32, lon1 = -65.2, lat0 = 18.56, lat1 = 17.88, k = Math.cos(18.2 * Math.PI / 180);
    const sx = (W - 16) / ((lon1 - lon0) * k), Hh = Math.round((lat0 - lat1) * sx) + 16;
    const P = ([la, lo]) => [8 + (lo - lon0) * k * sx, 8 + (lat0 - la) * sx];
    const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('width', '100%').attr('height', Hh).attr('role', 'img').attr('aria-label', 'Schematic map of Puerto Rico with power plants');
    const defs = svg.append('defs');
    const f = defs.append('filter').attr('id', 'isl-sh').attr('x', '-5%').attr('y', '-5%').attr('width', '110%').attr('height', '120%');
    f.append('feDropShadow').attr('dx', 0).attr('dy', 3).attr('stdDeviation', 4).attr('flood-color', '#000').attr('flood-opacity', 0.15);
    for (const isl of ISLANDS) svg.append('path').attr('class', 'island').attr('filter', 'url(#isl-sh)').attr('d', d3.line().curve(d3.curveCatmullRomClosed.alpha(0.5))(isl.map(P)));
    svg.append('text').attr('class', 'sea-lbl').attr('x', P([18.53, -66.5])[0]).attr('y', 14).attr('text-anchor', 'middle').text('Atlantic Ocean');
    svg.append('text').attr('class', 'sea-lbl').attr('x', P([17.9, -66.5])[0]).attr('y', Hh - 4).attr('text-anchor', 'middle').text('Caribbean Sea');
    svg.append('text').attr('class', 'sea-lbl small').attr('x', P([18.04, -65.42])[0]).attr('y', P([18.04, -65.42])[1]).attr('text-anchor', 'middle').text('Vieques');
    svg.append('text').attr('class', 'sea-lbl small').attr('x', P([18.37, -65.29])[0]).attr('y', P([18.37, -65.29])[1]).attr('text-anchor', 'middle').text('Culebra');
    const sites = d3.groups(units, siteOf).map(([site, us]) => {
      const mw = d3.sum(us, (u) => Math.max(0, Number(u.mw))), on = us.filter((u) => u.status === 'Generating').length;
      const renewable = us.every((u) => ['Hydro', 'Solar', 'Wind', 'Landfill gas'].includes(u.fuel));
      return { site, us, mw, on, state: on === us.length ? 'ok' : on > 0 ? 'partial' : renewable ? 'idle' : 'out', pos: SITES[site] };
    }).filter((s) => s.pos).sort((a, b) => b.mw - a.mw);
    if (!selected || !sites.some((s) => s.site === selected)) selected = sites[0] && sites[0].site;
    const tip = G.tipFor(box.closest('.gx-card'));
    const gm = svg.append('g');
    for (const s of sites.slice().reverse()) {
      const [x, y] = P([s.pos[0], s.pos[1]]), r = 4 + Math.sqrt(s.mw) * 0.7 * Math.min(1.3, W / 700);
      const g = gm.append('g').attr('class', 'site ' + s.state + (s.site === selected ? ' sel' : '')).attr('transform', `translate(${x},${y})`).attr('tabindex', 0).attr('role', 'button')
        .attr('aria-label', s.pos[2] + ', ' + Math.round(s.mw) + ' MW, ' + s.on + ' of ' + s.us.length + ' units on');
      g.append('circle').attr('class', 'halo').attr('r', r + 4);
      g.append('circle').attr('class', 'dot').attr('r', r);
      const pick = () => { selected = s.site; mapView(); };
      g.on('click', pick).on('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } })
        .on('mousemove', (ev) => tip.show(ev, s.pos[2], [[null, 'Output', G.f0(Math.round(s.mw)) + ' MW'], [null, 'Units on', s.on + ' of ' + s.us.length]]))
        .on('mouseleave', () => tip.hide());
      const lb = LABEL[s.site];
      if (lb) { gm.append('text').attr('class', 'site-lbl').attr('x', x + lb[0]).attr('y', y + lb[1]).attr('text-anchor', lb[2]).text(s.site + ' ' + G.f0(Math.round(s.mw)) + ' MW'); }
    }
    // side panel: units of the selected plant
    panel.replaceChildren();
    const s = sites.find((x) => x.site === selected);
    if (s) {
      panel.append(el('div', 'mp-title', s.pos[2]), el('div', 'mp-s', G.f0(Math.round(s.mw)) + ' MW now, ' + s.on + ' of ' + s.us.length + ' units on'));
      for (const u of s.us) { const r = el('div', 'mp-u' + (u.status === 'Generating' ? '' : ' off')); r.append(el('i', 'gx-dot ' + (u.status === 'Generating' ? 'ok' : 'bad')), el('span', null, (s.us.some((v) => v.plant !== s.us[0].plant) ? u.plant.replace(/^.*? (Steam|CC \d|CC|GT\/CT)$/, '$1') + ' ' : '') + u.unit), el('span', 'mp-v', u.status === 'Generating' ? G.f1(Number(u.mw)) + ' MW' : 'OFF')); panel.append(r); }
    }
  }

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
  dash.onData(() => { for (const f of [fuelChart, outageLog, gauges, daily, mapView]) { try { f(); } catch (e) { console.error(f.name, e); } } });
})();
