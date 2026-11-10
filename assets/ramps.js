/* Ramp rates: how fast generation rises and falls (MW per hour over 60 minutes), per day and per plant. */
(() => {
  const G = window.GX;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const card = (id) => document.getElementById(id);
  const fmtDay = (k) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Puerto_Rico', month: 'short', day: 'numeric' }).format(new Date(k + 'T12:00:00-04:00'));
  const hm = (s) => { if (!s) return ''; const [h, m] = s.split(':').map(Number); return (h % 12 || 12) + ':' + String(m).padStart(2, '0') + (h < 12 ? ' AM' : ' PM'); };
  const sign = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + G.f0(Math.abs(Math.round(v)));
  const PLANT_FUEL = { AES: 'Coal', 'EcoEléctrica': 'LNG', 'San Juan CC': 'LNG', 'Costa Sur Steam': 'LNG', 'Palo Seco Steam': 'Bunker C', 'Aguirre Steam': 'Bunker C', 'San Juan Steam': 'Bunker C',
    Cambalache: 'ULSD', 'Mayagüez': 'ULSD', 'Aguirre CC 1': 'ULSD', 'Aguirre CC 2': 'ULSD', 'GT stations (peakers)': 'ULSD', 'Palo Seco GT/CT': 'ULSD', 'Aguirre GT/CT': 'ULSD', 'Costa Sur GT/CT': 'ULSD',
    Hydro: 'Hydro', Solar: 'Solar', Wind: 'Wind', 'Landfill gas': 'Landfill gas' };

  function days() { return G.rows('daily_summary').filter((d) => d.ramp_up_max_mw_h != null).sort((a, b) => (a.day < b.day ? -1 : 1)); }
  function record(list, pick) { return list.reduce((a, d) => (!a || pick(d) > pick(a) ? d : a), null); }

  function kpis() {
    const box = card('ramp-kpis'); if (!box) return;
    const D = days(); box.replaceChildren();
    if (!D.length) { box.append(el('p', 'gx-note', 'Ramp records appear after the updater’s next run.')); return; }
    const last = D[D.length - 1], lastN = (n) => D.slice(-n);
    const k = (label, value, note) => { const d = el('div', 'gx-kpi'); d.append(el('div', 'gx-kpi-l', label), el('div', 'gx-kpi-v', value), el('div', 'gx-kpi-n', note)); box.append(d); };
    k((last.status === 'In progress' ? 'Today' : fmtDay(last.day)) + ': steepest rise', sign(last.ramp_up_max_mw_h) + ' MW/h', 'at ' + hm(last.ramp_up_at));
    k((last.status === 'In progress' ? 'Today' : fmtDay(last.day)) + ': steepest drop', sign(last.ramp_down_max_mw_h) + ' MW/h', 'at ' + hm(last.ramp_down_at));
    const w7 = lastN(7); k('Average daily steepest rise', '+' + G.f0(Math.round(d3.mean(w7, (d) => d.ramp_up_max_mw_h))) + ' MW/h', 'last ' + w7.length + ' days');
    for (const [n, lbl] of [[7, 'Record rise, 7 days'], [30, 'Record rise, 30 days'], [Infinity, 'Record rise, all time']]) {
      const r = record(n === Infinity ? D : lastN(n), (d) => d.ramp_up_max_mw_h);
      if (r) k(lbl, sign(r.ramp_up_max_mw_h) + ' MW/h', fmtDay(r.day) + ', ' + hm(r.ramp_up_at));
    }
  }

  function rampChart() {
    const box = card('ramp-chart'); if (!box) return;
    const D = days().slice(-30); if (!D.length) { G.failOrSkeleton(box, ['daily_summary']); return; }
    box.replaceChildren(); box.classList.remove('dash-skeleton');
    const lg = card('ramp-legend'); lg.replaceChildren();
    for (const [n, c] of [['Steepest rise', 'var(--rp-up)'], ['Steepest drop', 'var(--rp-down)']]) { const s = el('span'); const sw = el('span', 'gx-sw'); sw.style.background = c; s.append(sw, n); lg.append(s); }
    const W = box.clientWidth || 600, Hh = 260;
    const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('width', '100%').attr('height', Hh);
    const mx = d3.max(D, (d) => Math.max(d.ramp_up_max_mw_h || 0, -(d.ramp_down_max_mw_h || 0))) || 100;
    const y = d3.scaleLinear([-mx * 1.1, mx * 1.1], [Hh - 24, 10]).nice();
    const ml = G.measure(svg, y.ticks(5).map((v) => sign(v))) + 14;
    const x = d3.scaleBand(D.map((d) => d.day), [ml, W - 8]).padding(0.25);
    svg.append('g').selectAll('line').data(y.ticks(5)).join('line').attr('x1', ml).attr('x2', W - 8).attr('y1', y).attr('y2', y).attr('stroke', 'var(--cds-chart-grid)');
    svg.append('g').selectAll('text').data(y.ticks(5)).join('text').attr('x', ml - 6).attr('y', y).attr('dy', '0.35em').attr('text-anchor', 'end').text((v) => sign(v));
    svg.append('text').attr('x', ml - 6).attr('y', 6).attr('text-anchor', 'end').text('MW/h');
    svg.append('line').attr('x1', ml).attr('x2', W - 8).attr('y1', y(0)).attr('y2', y(0)).attr('stroke', 'var(--cds-chart-axis)');
    const every = Math.ceil(D.length / Math.max(3, Math.floor((W - ml) / 60)));
    svg.append('g').selectAll('text').data(D.filter((d, i) => i % every === 0)).join('text').attr('x', (d) => x(d.day) + x.bandwidth() / 2).attr('y', Hh - 6).attr('text-anchor', 'middle').text((d) => fmtDay(d.day));
    const tip = G.tipFor(box.closest('.gx-card'));
    for (const d of D) {
      svg.append('rect').attr('x', x(d.day)).attr('width', x.bandwidth()).attr('y', y(d.ramp_up_max_mw_h)).attr('height', Math.max(1, y(0) - y(d.ramp_up_max_mw_h))).attr('rx', 2).attr('fill', 'var(--rp-up)');
      if (d.ramp_down_max_mw_h != null) svg.append('rect').attr('x', x(d.day)).attr('width', x.bandwidth()).attr('y', y(0)).attr('height', Math.max(1, y(d.ramp_down_max_mw_h) - y(0))).attr('rx', 2).attr('fill', 'var(--rp-down)');
      svg.append('rect').attr('x', x(d.day) - 2).attr('width', x.bandwidth() + 4).attr('y', 0).attr('height', Hh - 24).attr('fill', 'transparent')
        .on('mousemove', (ev) => tip.show(ev, fmtDay(d.day) + (d.status === 'In progress' ? ' (so far)' : ''), [['var(--rp-up)', 'Steepest rise', sign(d.ramp_up_max_mw_h) + ' MW/h at ' + hm(d.ramp_up_at)], ['var(--rp-down)', 'Steepest drop', d.ramp_down_max_mw_h == null ? '—' : sign(d.ramp_down_max_mw_h) + ' MW/h at ' + hm(d.ramp_down_at)]]))
        .on('mouseleave', () => tip.hide());
    }
  }

  function rangeChart() {
    const box = card('range-chart'); if (!box) return;
    const D = G.rows('daily_summary').filter((d) => d.demand_max_mw != null && d.demand_min_mw != null).sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-30);
    if (!D.length) { G.failOrSkeleton(box, ['daily_summary']); return; }
    box.replaceChildren(); box.classList.remove('dash-skeleton');
    const lg = card('range-legend'); lg.replaceChildren();
    for (const [n, c] of [['Highest demand', 'var(--alert)'], ['Lowest demand', 'var(--c1)'], ['Dashed: trend', 'var(--muted)']]) { const s = el('span'); const sw = el('span', 'gx-sw'); sw.style.background = c; s.append(sw, n); lg.append(s); }
    const W = box.clientWidth || 600, Hh = 260;
    const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('width', '100%').attr('height', Hh);
    const y = d3.scaleLinear([d3.min(D, (d) => d.demand_min_mw) * 0.92, d3.max(D, (d) => d.demand_max_mw) * 1.04], [Hh - 24, 10]).nice();
    const ml = G.measure(svg, y.ticks(5).map(G.f0)) + 14;
    const x = d3.scaleBand(D.map((d) => d.day), [ml, W - 8]).padding(0.35);
    svg.append('g').selectAll('line').data(y.ticks(5)).join('line').attr('x1', ml).attr('x2', W - 8).attr('y1', y).attr('y2', y).attr('stroke', 'var(--cds-chart-grid)');
    svg.append('g').selectAll('text').data(y.ticks(5)).join('text').attr('x', ml - 6).attr('y', y).attr('dy', '0.35em').attr('text-anchor', 'end').text(G.f0);
    svg.append('text').attr('x', ml - 6).attr('y', 6).attr('text-anchor', 'end').text('MW');
    const every = Math.ceil(D.length / Math.max(3, Math.floor((W - ml) / 60)));
    svg.append('g').selectAll('text').data(D.filter((d, i) => i % every === 0)).join('text').attr('x', (d) => x(d.day) + x.bandwidth() / 2).attr('y', Hh - 6).attr('text-anchor', 'middle').text((d) => fmtDay(d.day));
    const tip = G.tipFor(box.closest('.gx-card'));
    // straight trend lines (least squares) through each day's highest and lowest demand
    const trend = (key, color) => { const n = D.length; if (n < 3) return null; const mx = (n - 1) / 2, my = d3.mean(D, (d) => d[key]);
      const slope = d3.sum(D, (d, i) => (i - mx) * (d[key] - my)) / d3.sum(D, (d, i) => (i - mx) ** 2), b0 = my - slope * mx;
      const cx = (i) => x(D[i].day) + x.bandwidth() / 2;
      svg.append('line').attr('x1', cx(0)).attr('x2', cx(n - 1)).attr('y1', y(b0)).attr('y2', y(b0 + slope * (n - 1))).attr('stroke', color).attr('stroke-width', 1.8).attr('stroke-dasharray', '6 4');
      return slope; };
    const sMax = trend('demand_max_mw', 'var(--alert)'), sMin = trend('demand_min_mw', 'var(--c1)');
    const tn = card('range-trend'); if (tn) tn.textContent = sMax == null ? '' : 'Trend over these ' + D.length + ' days: the daily peak is ' + (Math.abs(sMax) < 2 ? 'flat' : (sMax > 0 ? 'rising' : 'falling') + ' about ' + G.f0(Math.abs(Math.round(sMax))) + ' MW per day') + '; the daily low is ' + (Math.abs(sMin) < 2 ? 'flat' : (sMin > 0 ? 'rising' : 'falling') + ' about ' + G.f0(Math.abs(Math.round(sMin))) + ' MW per day') + '.';
    for (const d of D) {
      const cx = x(d.day) + x.bandwidth() / 2;
      svg.append('rect').attr('x', x(d.day)).attr('width', x.bandwidth()).attr('y', y(d.demand_max_mw)).attr('height', Math.max(1, y(d.demand_min_mw) - y(d.demand_max_mw))).attr('rx', 3).attr('fill', 'var(--c1)').attr('opacity', 0.25);
      svg.append('circle').attr('cx', cx).attr('cy', y(d.demand_max_mw)).attr('r', 3.5).attr('fill', 'var(--alert)');
      svg.append('circle').attr('cx', cx).attr('cy', y(d.demand_min_mw)).attr('r', 3.5).attr('fill', 'var(--c1)');
      svg.append('rect').attr('x', x(d.day) - 2).attr('width', x.bandwidth() + 4).attr('y', 0).attr('height', Hh - 24).attr('fill', 'transparent')
        .on('mousemove', (ev) => tip.show(ev, fmtDay(d.day) + (d.status === 'In progress' ? ' (so far)' : ''), [['var(--alert)', 'Highest demand', G.f0(d.demand_max_mw) + ' MW' + (d.demand_max_at ? ' at ' + hm(d.demand_max_at.slice(11, 16)) : '')], ['var(--c1)', 'Lowest demand', G.f0(d.demand_min_mw) + ' MW' + (d.demand_min_at ? ' at ' + hm(d.demand_min_at.slice(11, 16)) : '')], [null, 'Swing', G.f0(d.demand_max_mw - d.demand_min_mw) + ' MW']]))
        .on('mouseleave', () => tip.hide());
    }
  }

  function plantTable() {
    const tb = card('ramp-table'); if (!tb) return;
    const rows = G.rows('plant_ramps').filter((r) => r.typical_up != null || r.up_30d != null);
    if (!rows.length) { card('ramp-note').textContent = 'Plant ramp records appear after the updater’s next run.'; return; }
    const mx = d3.max(rows, (r) => r.typical_up || 0) || 1;
    const v = (x) => (x == null ? '—' : sign(x) + ' MW/h');
    G.table(tb, rows, [
      { k: 'plant', render: (td, r) => { const s = el('span', 'gx-sw'); s.style.background = G.color(PLANT_FUEL[r.plant] || 'ULSD'); td.append(s, r.plant); } },
      { k: 'typical_up', num: true, render: (td, r) => { const b = el('span', 'gx-inbar'); b.style.width = Math.max(2, ((r.typical_up || 0) / mx) * 80) + 'px'; b.style.background = G.color(PLANT_FUEL[r.plant] || 'ULSD'); td.append(b, v(r.typical_up)); } },
      { k: 'avg_daily_max_up_7d', num: true, fmt: (x) => v(x) },
      { k: 'up_7d', num: true, fmt: (x) => v(x) },
      { k: 'up_30d', num: true, fmt: (x) => v(x) },
      { k: 'up_all', num: true, render: (td, r) => { td.textContent = v(r.up_all); if (r.up_all_at) td.title = 'On ' + r.up_all_at; } },
      { k: 'typical_down', num: true, fmt: (x) => v(x) },
      { k: 'down_30d', num: true, fmt: (x) => v(x) },
    ], { key: 'plant', sortKey: 'typical_up', redraw: plantTable });
    card('ramp-note').textContent = 'Readings are about 15 minutes apart, so very short ramps are smoothed out. A plant’s ramp includes its units starting or stopping while the plant is online. Hover the all-time value to see when it happened.';
  }

  /* ---------- Reactive power (MVAr) and power factor over time ---------- */
  let rqView = 'mvar', rqPeriod = 'today', rqPlant = '', rqFreq = true;
  const H = 3600000, pr = (o) => { const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Puerto_Rico', ...o }); return (d) => f.format(d); };
  const tFmt = pr({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }), hFmt = pr({ hour: 'numeric' }), dFmt = pr({ month: 'short', day: 'numeric' });
  const prDay = (d) => { const [m, dd, y] = pr({ year: 'numeric', month: '2-digit', day: '2-digit' })(d).split('/'); return y + '-' + m + '-' + dd; };
  const PF = (mw, mvar) => window.PREPA.powerFactor(Math.max(0, Number(mw) || 0), Number(mvar) || 0);
  function reactiveRows() {
    const mk = (x) => ({ t: new Date(x.at), q: x.plant_mvar, p: x.plant_mw || {}, qt: x.mvar_total ?? d3.sum(Object.values(x.plant_mvar)), pt: x.gen_mw ?? d3.sum(Object.values(x.plant_mw || {})) });
    const hist = G.rows('history').filter((x) => x.plant_mvar).map(mk), seen = new Set(hist.map((x) => Math.floor(x.t / H)));
    const hourly = G.rows('cost_hourly').filter((x) => x.plant_mvar).map(mk).filter((x) => !seen.has(Math.floor(x.t / H)));
    const rows = [...hist, ...hourly].sort((a, b) => a.t - b.t);
    if (!rows.length) return rows;
    const now = rows[rows.length - 1].t, today = new Date(prDay(now) + 'T00:00:00-04:00');
    const [t0, t1] = rqPeriod === 'today' ? [today, now] : rqPeriod === 'yday' ? [new Date(+today - 864e5), new Date(+today - 1)] : [new Date(+now - (rqPeriod === '7d' ? 7 : 30) * 864e5), now];
    return rows.filter((x) => x.t >= t0 && x.t <= t1);
  }
  function reactive() {
    const box = card('rq-chart'); if (!box) return;
    for (const [id, v] of [['rq-view', rqView], ['rq-period', rqPeriod]]) document.querySelectorAll('#' + id + ' button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
    const rows = reactiveRows(), sel = card('rq-plant'), sum = card('rq-sum'), lg = card('rq-legend');
    const all = [...new Set(G.rows('live_units').map((u) => window.PREPA.plantGroup(u.plant)))];
    const plants = [...new Set([...all, ...rows.flatMap((x) => Object.keys(x.q))])].sort();
    if (rqPlant && !plants.includes(rqPlant)) rqPlant = '';
    sel.replaceChildren(...[['', 'All plants (system)'], ...plants.map((p) => [p, p])].map(([v, t]) => { const o = el('option', null, t); o.value = v; if (v === rqPlant) o.selected = true; return o; }));
    box.replaceChildren(); box.classList.remove('dash-skeleton'); lg.replaceChildren(); sum.replaceChildren();
    const W = box.clientWidth || 800, Hh = 300, MR = rqFreq ? 46 : 10;
    const fc = card('rq-freq'); if (fc) fc.checked = rqFreq;
    const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('width', '100%').attr('height', Hh);
    if (rows.length < 2) { svg.append('text').attr('x', W / 2).attr('y', Hh / 2).attr('text-anchor', 'middle').attr('class', 'empty').text('MVAr history starts with the first readings after this update; it fills in every 15 minutes.'); }
    const qOf = (x) => (rqPlant ? x.q[rqPlant] ?? 0 : x.qt), pOf = (x) => (rqPlant ? x.p[rqPlant] ?? 0 : x.pt), pfOf = (x) => (pOf(x) >= 1 ? PF(pOf(x), qOf(x)) : null);
    const chip = (lbl, val, cls) => { const s = el('span', 'ots ' + (cls || '')); s.append(el('b', null, lbl), ' ' + val); sum.append(s); };
    // current values from the live units
    const us = G.rows('live_units').filter((u) => !rqPlant || window.PREPA.plantGroup(u.plant) === rqPlant), P0 = d3.sum(us, (u) => Math.max(0, Number(u.mw) || 0)), Q0 = d3.sum(us, (u) => Number(u.mvar) || 0), pf0 = PF(P0, Q0);
    chip('Now', G.f0(Math.round(P0)) + ' MW, ' + G.f0(Math.round(Q0)) + ' MVAr');
    chip('Power factor now', pf0 == null ? '—' : pf0.toFixed(3) + (Q0 >= 0 ? ' lagging' : ' leading'), pf0 != null && pf0 < 0.9 ? 'mx' : '');
    const pfs = rows.map((x) => ({ t: x.t, v: pfOf(x) })).filter((x) => x.v != null);
    if (pfs.length) { const lo = pfs.reduce((a, x) => (x.v < a.v ? x : a), pfs[0]); chip('Average power factor', d3.mean(pfs, (x) => x.v).toFixed(3)); chip('Lowest', lo.v.toFixed(3) + ', ' + tFmt(lo.t), 'mn'); }
    if (rows.length < 2) return;
    const ml0 = 46, x = d3.scaleTime([rows[0].t, rows[rows.length - 1].t], [ml0, W - MR]);
    const span = rows[rows.length - 1].t - rows[0].t, fx = span > 3 * 864e5 ? dFmt : (d) => (Number(pr({ hour: 'numeric', hourCycle: 'h23' })(d)) % 24 === 0 ? dFmt(d) : hFmt(d));
    const axes = (y, fmt, unit) => {
      svg.append('g').selectAll('line').data(y.ticks(5)).join('line').attr('x1', ml0).attr('x2', W - MR).attr('y1', y).attr('y2', y).attr('stroke', 'var(--cds-chart-grid)');
      svg.append('g').selectAll('text').data(y.ticks(5)).join('text').attr('x', ml0 - 6).attr('y', y).attr('dy', '0.35em').attr('text-anchor', 'end').text(fmt);
      svg.append('text').attr('x', ml0 - 6).attr('y', 8).attr('text-anchor', 'end').text(unit);
      svg.append('g').selectAll('text').data(x.ticks(Math.max(3, Math.floor((W - ml0) / 90)))).join('text').attr('x', x).attr('y', Hh - 6).attr('text-anchor', 'middle').text(fx);
    };
    const gapSeq = (list, key) => { const out = []; list.forEach((d, i) => { if (i && d.t - list[i - 1].t > 2.5 * H) out.push({ t: d.t, [key]: null }); out.push(d); }); return out; };
    const fm = new Map(); for (const q of [...G.rows('trace_long'), ...G.rows('trace_recent'), ...G.rows('live_graph')]) { if (!q.time || q.frequency_hz == null) continue; const t = Math.floor(new Date(q.time) / 300000) * 300000; if (t >= +rows[0].t - 300000 && t <= +rows[rows.length - 1].t + 300000) fm.set(t, Number(q.frequency_hz)); }
    const fq = [...fm.entries()].sort((p, q) => p[0] - q[0]).map(([t, v]) => ({ t: new Date(t), v }));
    const fAt = (t) => { if (!fq.length) return null; const d = fq[d3.bisector((q) => q.t).center(fq, t)]; return d && Math.abs(d.t - t) <= 20 * 60000 ? d.v : null; };
    const drawFreq = () => { if (!rqFreq || fq.length < 2) return;
      const yf = d3.scaleLinear([Math.min(59.7, d3.min(fq, (d) => d.v) - 0.05), Math.max(60.3, d3.max(fq, (d) => d.v) + 0.05)], [Hh - 26, 14]);
      svg.append('g').selectAll('text').data(yf.ticks(5)).join('text').attr('x', W - MR + 6).attr('y', yf).attr('dy', '0.35em').attr('fill', 'var(--amber)').text((v) => v.toFixed(1));
      svg.append('text').attr('x', W - MR + 6).attr('y', 8).attr('fill', 'var(--amber)').text('Hz');
      const sq = []; fq.forEach((d, i) => { if (i && d.t - fq[i - 1].t > 30 * 60000) sq.push({ t: d.t, v: null }); sq.push(d); });
      svg.append('path').datum(sq).attr('fill', 'none').attr('stroke', 'var(--amber)').attr('stroke-width', 1.3).attr('stroke-opacity', 0.9).attr('pointer-events', 'none').attr('d', d3.line().defined((d) => d.v != null).x((d) => x(d.t)).y((d) => yf(d.v)).curve(d3.curveStepAfter));
      const s = el('span'); const sw = el('span', 'gx-sw'); sw.style.background = 'var(--amber)'; sw.style.height = '3px'; s.append(sw, 'Frequency (right axis)'); lg.append(s); };
    const fLine = (d) => (rqFreq && fAt(d.t) != null ? [['var(--amber)', 'Frequency', fAt(d.t).toFixed(2) + ' Hz']] : []);
    const tip = G.tipFor(box.closest('.gx-card')), rule = svg.append('line').attr('y1', 12).attr('y2', Hh - 26).attr('stroke', 'var(--cds-chart-reference)').attr('opacity', 0);
    const hover = (lines) => svg.append('rect').attr('x', ml0).attr('y', 0).attr('width', W - MR - ml0).attr('height', Hh - 26).attr('fill', 'transparent')
      .on('mousemove', (ev) => { const t = x.invert(d3.pointer(ev)[0]); const d = rows[d3.bisector((q) => q.t).center(rows, t)]; rule.attr('x1', x(d.t)).attr('x2', x(d.t)).attr('opacity', 1); tip.show(ev, tFmt(d.t), [...lines(d), ...fLine(d)]); })
      .on('mouseleave', () => { rule.attr('opacity', 0); tip.hide(); });
    if (rqView === 'pf') {
      const y = d3.scaleLinear([Math.min(0.8, Math.floor((d3.min(pfs, (d) => d.v) || 0.8) * 20) / 20), 1], [Hh - 26, 14]);
      axes(y, (v) => v.toFixed(2), 'PF');
      svg.append('line').attr('x1', ml0).attr('x2', W - MR).attr('y1', y(0.9)).attr('y2', y(0.9)).attr('stroke', 'var(--amber)').attr('stroke-dasharray', '4 4');
      svg.append('text').attr('x', W - 12).attr('y', y(0.9) - 4).attr('text-anchor', 'end').attr('fill', 'var(--amber)').text('0.90');
      svg.append('path').datum(gapSeq(pfs, 'v')).attr('fill', 'none').attr('stroke', 'var(--accent)').attr('stroke-width', 2).attr('d', d3.line().defined((d) => d.v != null).x((d) => x(d.t)).y((d) => y(d.v)).curve(d3.curveMonotoneX));
      const s = el('span'); const sw = el('span', 'gx-sw'); sw.style.background = 'var(--accent)'; s.append(sw, 'Power factor, ' + (rqPlant || 'whole system')); lg.append(s);
      hover((d) => [['var(--accent)', 'Power factor', pfOf(d) == null ? '— (not generating)' : pfOf(d).toFixed(3)], [null, 'MW', G.f0(Math.round(pOf(d)))], [null, 'MVAr', G.f0(Math.round(qOf(d)))]]);
    } else if (rqPlant) {
      const vals = rows.map((d) => ({ t: d.t, v: qOf(d) })), col = G.color(PLANT_FUEL[rqPlant] || 'ULSD');
      const y = d3.scaleLinear([Math.min(0, d3.min(vals, (d) => d.v)), Math.max(1, d3.max(vals, (d) => d.v)) * 1.1], [Hh - 26, 14]).nice();
      axes(y, G.f0, 'MVAr');
      svg.append('path').datum(gapSeq(vals, 'v')).attr('fill', col).attr('opacity', 0.25).attr('d', d3.area().defined((d) => d.v != null).x((d) => x(d.t)).y0(y(0)).y1((d) => y(d.v)).curve(d3.curveMonotoneX));
      svg.append('path').datum(gapSeq(vals, 'v')).attr('fill', 'none').attr('stroke', col).attr('stroke-width', 2).attr('d', d3.line().defined((d) => d.v != null).x((d) => x(d.t)).y((d) => y(d.v)).curve(d3.curveMonotoneX));
      svg.append('line').attr('x1', ml0).attr('x2', W - MR).attr('y1', y(0)).attr('y2', y(0)).attr('stroke', 'var(--cds-chart-axis)');
      const s = el('span'); const sw = el('span', 'gx-sw'); sw.style.background = col; s.append(sw, rqPlant + ', MVAr'); lg.append(s);
      hover((d) => [[col, 'MVAr', G.f1(qOf(d))], [null, 'MW', G.f1(pOf(d))], [null, 'Power factor', pfOf(d) == null ? '—' : pfOf(d).toFixed(3)]]);
    } else {
      const tot = {}; for (const d of rows) for (const [p, v] of Object.entries(d.q)) tot[p] = (tot[p] || 0) + Math.max(0, v);
      const top = Object.keys(tot).filter((p) => tot[p] > 0).sort((a, b) => tot[b] - tot[a]), keys = top.slice(0, 9), rest = top.slice(9);
      const fuelN = {}, colOf = (p) => { if (p === '__other') return 'var(--cds-chart-muted)'; return G.color(PLANT_FUEL[p] || 'ULSD'); };
      const data = gapSeq(rows.map((d) => { const o = { t: d.t, v: 1 }; for (const p of keys) o[p] = Math.max(0, d.q[p] || 0); if (rest.length) o.__other = d3.sum(rest, (p) => Math.max(0, d.q[p] || 0)); return o; }), 'v');
      const ks = [...keys, ...(rest.length ? ['__other'] : [])];
      const stack = d3.stack().keys(ks).value((d, k) => (d.v == null ? 0 : d[k] || 0))(data);
      const y = d3.scaleLinear([0, (d3.max(rows, (d) => Math.max(d.qt, d3.sum(Object.values(d.q), (v) => Math.max(0, v)))) || 1) * 1.08], [Hh - 26, 14]).nice();
      axes(y, G.f0, 'MVAr');
      const shade = new Map(); for (const p of keys) { const f = PLANT_FUEL[p] || 'ULSD'; fuelN[f] = (fuelN[f] || 0) + 1; shade.set(p, 1 - (fuelN[f] - 1) * 0.16); }
      svg.append('g').selectAll('path').data(stack).join('path').attr('fill', (s) => colOf(s.key)).attr('opacity', (s) => (s.key === '__other' ? 0.8 : Math.max(0.35, shade.get(s.key) * 0.92)))
        .attr('d', d3.area().defined((d) => d.data.v != null).x((d) => x(d.data.t)).y0((d) => y(d[0])).y1((d) => y(d[1])).curve(d3.curveMonotoneX));
      svg.append('path').datum(gapSeq(rows.map((d) => ({ t: d.t, v: d.qt })), 'v')).attr('fill', 'none').attr('stroke', 'var(--ink)').attr('stroke-width', 1.8).attr('stroke-dasharray', '5 4').attr('d', d3.line().defined((d) => d.v != null).x((d) => x(d.t)).y((d) => y(d.v)));
      for (const k of ks) { const s = el('span'); const sw = el('span', 'gx-sw'); sw.style.background = colOf(k); sw.style.opacity = k === '__other' ? 0.8 : Math.max(0.35, shade.get(k) * 0.92); s.append(sw, k === '__other' ? 'Other plants' : k); lg.append(s); }
      { const s = el('span'); const sw = el('span', 'gx-sw'); sw.style.background = 'var(--ink)'; sw.style.height = '3px'; s.append(sw, 'Net total'); lg.append(s); }
      hover((d) => [...ks.map((k) => [colOf(k), k === '__other' ? 'Other plants' : k, k === '__other' ? d3.sum(rest, (p) => Math.max(0, d.q[p] || 0)) : d.q[k] || 0]).filter((l) => Math.abs(l[2]) >= 0.5).sort((a, b) => b[2] - a[2]).map((l) => [l[0], l[1], G.f1(l[2]) + ' MVAr']), [null, 'Net total', G.f0(Math.round(d.qt)) + ' MVAr'], [null, 'System power factor', PF(d.pt, d.qt) == null ? '—' : PF(d.pt, d.qt).toFixed(3)]]);
    }
    drawFreq();
    card('rq-note').textContent = 'MVAr is reactive power: positive when a plant supplies it to the grid, negative when it absorbs it. Power factor = MW ÷ √(MW² + MVAr²); closer to 1 means less of the generators’ capacity goes to reactive power. MVAr has been recorded at every reading since this update, so earlier days have no data.';
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('#rq-view button'); if (a) { rqView = a.dataset.v; reactive(); }
    const b = e.target.closest('#rq-period button'); if (b) { rqPeriod = b.dataset.v; reactive(); }
  });
  document.addEventListener('change', (e) => { if (e.target.id === 'rq-plant') { rqPlant = e.target.value; reactive(); } if (e.target.id === 'rq-freq') { rqFreq = e.target.checked; reactive(); } });

  dash.onData(() => { for (const f of [kpis, rampChart, rangeChart, plantTable, reactive]) { try { f(); } catch (e) { console.error('ramps', e); } } });
})();
