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
    for (const [n, c] of [['Highest demand', 'var(--alert)'], ['Lowest demand', 'var(--c1)']]) { const s = el('span'); const sw = el('span', 'gx-sw'); sw.style.background = c; s.append(sw, n); lg.append(s); }
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

  dash.onData(() => { for (const f of [kpis, rampChart, rangeChart, plantTable]) { try { f(); } catch (e) { console.error('ramps', e); } } });
})();
