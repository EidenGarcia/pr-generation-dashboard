/* Dispatch cost analytics: merit order, who carries the load, economic redispatch, load duration curve.
   All built from the saved readings (every 15 minutes, every 5 while the page is open) and PREPA's 5-minute trace. */
(() => {
  const G = window.GX, H = 3600000;
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const pr = (o) => { const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Puerto_Rico', ...o }); return (d) => f.format(d); };
  const tFmt = pr({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }), hm = pr({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dayKey = (d) => { const [m, dd, y] = pr({ year: 'numeric', month: '2-digit', day: '2-digit' })(d).split('/'); return `${y}-${m}-${dd}`; };
  const MUST_TAKE = new Set(['Hydro', 'Solar', 'Wind', 'Landfill gas']);
  const BASELOAD = new Set(['San Juan Steam', 'Palo Seco Steam', 'Aguirre Steam', 'Costa Sur Steam', 'AES', 'EcoEléctrica', 'San Juan CC']);
  const FUEL_LABEL = { LNG: 'Natural gas', 'Bunker C': 'Bunker C', ULSD: 'Diesel', Coal: 'Coal', Solar: 'Renewables', Wind: 'Renewables', Hydro: 'Renewables', 'Landfill gas': 'Renewables' };
  const fuelColor = (f) => (FUEL_LABEL[f] === 'Renewables' ? G.color('Solar') : G.color(f));
  const legend = (box, items) => { box.replaceChildren(); for (const [n, c] of items) { const s = el('span'); const sw = el('span', 'gx-sw'); sw.style.background = c; s.append(sw, n); box.append(s); } };
  const card = (id) => document.getElementById(id);
  function plantFuel() { const m = { Hydro: 'Hydro', Solar: 'Solar', Wind: 'Wind', 'Landfill gas': 'Landfill gas' }; for (const u of G.rows('live_units')) { const g = window.PREPA.plantGroup(u.plant); if (!m[g]) m[g] = G.norm(u.fuel); } return m; }
  // Readings with per-plant data: since midnight (Puerto Rico) when there are enough, otherwise the last 24 hours.
  function windowRows() {
    const rows = G.rows('history').filter((r) => r.plant_mw).map((r) => ({ ...r, t: new Date(r.at) })).sort((a, b) => a.t - b.t);
    if (!rows.length) return { rows, label: '' };
    const last = rows[rows.length - 1], today = rows.filter((r) => dayKey(r.t) === dayKey(last.t));
    return today.length >= 8 ? { rows: today, label: 'today' } : { rows: rows.filter((r) => last.t - r.t <= 24 * H), label: 'in the last 24 hours' };
  }
  const price = (r, p) => { const mw = (r.plant_mw || {})[p], c = (r.plant_cost || {})[p]; return mw >= 1 && c > 0 ? c / mw : null; }; // $/MWh = ($/h) / MW
  function plantStats(rows) {
    const out = {}; const last = rows[rows.length - 1];
    for (const r of rows) for (const [p, v] of Object.entries(r.plant_mw || {})) {
      const o = out[p] || (out[p] = { p, max: 0, min: null, price: null, now: 0 });
      if (v > o.max) o.max = v; if (v >= 1) o.min = o.min == null ? v : Math.min(o.min, v);
      const pz = price(r, p); if (pz != null) o.price = pz; // latest known cost
    }
    for (const o of Object.values(out)) o.now = Math.max(0, (last.plant_mw || {})[o.p] || 0);
    return out;
  }

  /* ---------- Merit order ---------- */
  let meritMode = 'now';
  // Right now: only plants generating at the latest reading. Block width = capacity of the units online now
  // (rated MW, or the most each unit has been seen producing), solid up to current output. Height = cost per MWh now.
  function meritNow() {
    const units = G.rows('live_units'), cap = (G.rows('unit_capacity')[0] || { units: {} }).units, rng = G.rows('unit_ranges')[0] || {};
    const by = new Map();
    for (const u of units) {
      if (u.status !== 'Generating') continue;
      const p = window.PREPA.plantGroup(u.plant), mw = Math.max(0, Number(u.mw));
      const o = by.get(p) || { p, now: 0, avail: 0, cost: 0, costMW: 0, fuel: G.norm(u.fuel), units: 0 };
      const c = cap[u.unit_id] && cap[u.unit_id].rated_mw, seen = rng[u.unit_id] && rng[u.unit_id].max_on_mw;
      o.now += mw; o.avail += Math.max(mw, c || seen || mw); o.units++;
      if (Number(u.cost_cents_kwh) > 0) { o.cost += Number(u.cost_usd_per_hour); o.costMW += mw; }
      by.set(p, o);
    }
    const blocks = [...by.values()].filter((o) => o.now >= 1).map((o) => ({ ...o, max: MUST_TAKE.has(o.p) ? o.now : o.avail, price: o.costMW ? o.cost / o.costMW : MUST_TAKE.has(o.p) ? 0 : null }));
    const demand = d3.sum(blocks, (b) => b.now);
    return { blocks, demand, peak: null, when: units[0] ? tFmt(new Date(units[0].snapshot)) : '' };
  }
  function meritToday() {
    const { rows, label } = windowRows(); if (!rows.length) return null;
    const st = plantStats(rows), fm = plantFuel(), last = rows[rows.length - 1];
    const blocks = Object.values(st).filter((o) => o.max >= 1).map((o) => ({ ...o, fuel: fm[o.p] }));
    return { blocks, demand: num(last.total_mw), peak: d3.max(rows, (r) => num(r.total_mw)), label };
  }
  function merit() {
    const box = card('merit-chart'); if (!box) return;
    document.querySelectorAll('#merit-mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === meritMode)));
    const M = meritMode === 'now' ? meritNow() : meritToday();
    if (!M || !M.blocks.length) { G.failOrSkeleton(box, ['live_units']); return; }
    const must = M.blocks.filter((o) => MUST_TAKE.has(o.p)).sort((a, b) => (a.price || 0) - (b.price || 0));
    const disp = M.blocks.filter((o) => !MUST_TAKE.has(o.p) && o.price != null).sort((a, b) => a.price - b.price);
    const seq = [...must, ...disp]; let acc = 0; for (const b of seq) { b.x0 = acc; acc += b.max; b.x1 = acc; }
    const demandNow = M.demand, peak = M.peak;
    card('merit-note').textContent = meritMode === 'now'
      ? 'Plants generating at ' + M.when + '. Block width is the capacity of the units online now (rated MW, or the most each unit has been seen producing); the solid part is what each plant is producing, the light part its unused room. Height is its cost per MWh now. Renewables appear only when they are producing.'
      : 'Widths are the most each plant produced ' + M.label + '; heights are its cost per MWh at its latest reading. Plants with no reported cost are left out.';
    const fuelsShown = [...new Set(seq.map((b) => FUEL_LABEL[b.fuel] || b.fuel))];
    legend(card('merit-legend'), [['Renewables (must-take)', fuelColor('Solar')], ['Coal', G.color('Coal')], ['Natural gas', G.color('LNG')], ['Bunker C', G.color('Bunker C')], ['Diesel', G.color('ULSD')]].filter(([n]) => fuelsShown.includes(n.replace(' (must-take)', ''))));
    box.replaceChildren(); box.classList.remove('dash-skeleton');
    const W = box.clientWidth || 640, Hh = 320;
    const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('width', '100%').attr('height', Hh);
    const y = d3.scaleLinear([0, (d3.max(seq, (b) => b.price || 0) || 100) * 1.12], [Hh - 34, 26]).nice();
    const ml = G.measure(svg, y.ticks(5).map((v) => '$' + G.f0(v))) + 14;
    const x = d3.scaleLinear([0, Math.max(acc, peak || 0, demandNow || 0) * 1.02], [ml, W - 10]);
    svg.append('g').selectAll('line').data(y.ticks(5)).join('line').attr('x1', ml).attr('x2', W - 10).attr('y1', y).attr('y2', y).attr('stroke', 'var(--cds-chart-grid)');
    svg.append('g').selectAll('text').data(y.ticks(5)).join('text').attr('x', ml - 6).attr('y', y).attr('dy', '0.35em').attr('text-anchor', 'end').text((v) => '$' + G.f0(v));
    svg.append('text').attr('x', 2).attr('y', 14).text('$/MWh');
    svg.append('g').selectAll('text').data(x.ticks(6)).join('text').attr('x', x).attr('y', Hh - 18).attr('text-anchor', 'middle').text(G.f0);
    svg.append('text').attr('x', W - 10).attr('y', Hh - 3).attr('text-anchor', 'end').text(meritMode === 'now' ? 'Cumulative MW online' : 'Cumulative MW');
    svg.append('line').attr('x1', ml).attr('x2', W - 10).attr('y1', y(0)).attr('y2', y(0)).attr('stroke', 'var(--cds-chart-axis)');
    const tip = G.tipFor(box.closest('.gx-card'));
    for (const b of seq) {
      const col = fuelColor(b.fuel), running = b.now >= 1, outOfMerit = running && demandNow != null && b.x0 > demandNow + 0.5 && !MUST_TAKE.has(b.p);
      const top = y(b.price || 0), h = Math.max(1, y(0) - top), x0 = x(b.x0) + 0.75, wAll = Math.max(1, x(b.x1) - x(b.x0) - 1.5);
      const wNow = meritMode === 'now' ? Math.max(1, Math.min(wAll, x(b.x0 + b.now) - x(b.x0) - 1.5)) : wAll;
      if (meritMode === 'now' && wNow < wAll) svg.append('rect').attr('x', x0).attr('y', top).attr('width', wAll).attr('height', h).attr('rx', 2).attr('fill', col).attr('opacity', 0.28);
      svg.append('rect').attr('x', x0).attr('y', top).attr('width', wNow).attr('height', h).attr('rx', 2).attr('fill', col).attr('opacity', meritMode === 'now' || running ? 0.95 : 0.4);
      svg.append('rect').attr('x', x0).attr('y', top).attr('width', wAll).attr('height', h).attr('rx', 2).attr('fill', 'transparent').attr('stroke', outOfMerit ? 'var(--alert)' : 'none').attr('stroke-width', 1.6)
        .on('mousemove', (ev) => tip.show(ev, b.p, [[col, FUEL_LABEL[b.fuel] || b.fuel, null], [null, 'Cost', b.price ? '$' + G.f0(b.price) + '/MWh' : 'no reported cost'], [null, 'Producing now', running ? G.f0(Math.round(b.now)) + ' MW' : 'not running'],
          ...(meritMode === 'now' ? [[null, 'Online capacity', G.f0(Math.round(b.max)) + ' MW'], [null, 'Unused room', G.f0(Math.max(0, Math.round(b.max - b.now))) + ' MW']] : [[null, 'Most ' + M.label, G.f0(Math.round(b.max)) + ' MW']]), ...(outOfMerit ? [[null, 'Running out of merit', null]] : [])]))
        .on('mouseleave', () => tip.hide());
    }
    const vline = (v, t) => { if (v == null) return; svg.append('line').attr('x1', x(v)).attr('x2', x(v)).attr('y1', 22).attr('y2', y(0)).attr('stroke', 'var(--ink)').attr('stroke-dasharray', '4 4').attr('opacity', 0.7);
      svg.append('text').attr('x', x(v)).attr('y', 12).attr('text-anchor', x(v) > W - 120 ? 'end' : 'middle').attr('class', 'lbl-strong').text(t + ' ' + G.f0(Math.round(v)) + ' MW'); };
    vline(demandNow, meritMode === 'now' ? 'Demand now' : 'Now');
    if (peak && Math.abs(x(peak) - x(demandNow || 0)) > 40) vline(peak, 'Peak ' + (M.label === 'today' ? 'today' : '24 h'));
    const om = seq.filter((b) => b.now >= 1 && demandNow != null && b.x0 > demandNow + 0.5 && !MUST_TAKE.has(b.p));
    const room = meritMode === 'now' ? d3.sum(seq.filter((b) => demandNow != null && b.x1 <= demandNow + 0.5 && !MUST_TAKE.has(b.p)), (b) => Math.max(0, b.max - b.now)) : 0;
    card('merit-sum').textContent = demandNow == null ? '' : om.length
      ? om.length + ' plant(s) running out of merit now (outlined in red): ' + om.map((b) => b.p).join(', ') + '.' + (meritMode === 'now' && room >= 1 ? ' Cheaper plants online have about ' + G.f0(Math.round(room)) + ' MW of unused room.' : '')
      : 'Every plant running now sits within the merit order for current demand.';
  }
  document.addEventListener('click', (e) => { const b = e.target.closest('#merit-mode button'); if (!b) return; meritMode = b.dataset.v; try { merit(); } catch (err) { console.error(err); } });

  /* ---------- Who is carrying the load ---------- */
  function carriers() {
    const box = card('carry-chart'); if (!box) return;
    const { rows, label } = windowRows();
    if (!rows.length) { G.failOrSkeleton(box, ['history']); return; }
    card('carry-note').textContent = 'Share of generation at each reading ' + label + '. Baseload: the steam units, AES, EcoEléctrica and San Juan combined cycle. Peaking: the diesel turbines (Cambalache, Mayagüez, Aguirre combined cycle, the GT stations). Renewables: solar, wind, hydro and landfill gas.';
    const cats = [['base', 'Baseload plants', G.color('LNG')], ['peak', 'Peaking plants', G.color('ULSD')], ['ren', 'Renewables', fuelColor('Solar')]];
    legend(card('carry-legend'), cats.map(([, n, c]) => [n, c]));
    const data = rows.map((r) => { const o = { t: r.t, base: 0, peak: 0, ren: 0 }; for (const [p, v] of Object.entries(r.plant_mw || {})) { const mw = Math.max(0, v); if (MUST_TAKE.has(p)) o.ren += mw; else if (BASELOAD.has(p)) o.base += mw; else o.peak += mw; } const tot = o.base + o.peak + o.ren || 1; o.base /= tot; o.peak /= tot; o.ren /= tot; return o; });
    box.replaceChildren(); box.classList.remove('dash-skeleton');
    const W = box.clientWidth || 640, Hh = 300;
    const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('width', '100%').attr('height', Hh);
    const y = d3.scaleLinear([0, 1], [Hh - 26, 10]), ml = 44;
    const x = d3.scaleTime(d3.extent(data, (d) => d.t), [ml, W - 10]);
    svg.append('g').selectAll('line').data(y.ticks(5)).join('line').attr('x1', ml).attr('x2', W - 10).attr('y1', y).attr('y2', y).attr('stroke', 'var(--cds-chart-grid)');
    svg.append('g').selectAll('text').data(y.ticks(5)).join('text').attr('x', ml - 6).attr('y', y).attr('dy', '0.35em').attr('text-anchor', 'end').text((v) => Math.round(v * 100) + '%');
    svg.append('g').selectAll('text').data(x.ticks(Math.max(3, Math.floor((W - ml) / 80)))).join('text').attr('x', x).attr('y', Hh - 6).attr('text-anchor', 'middle').text(hm);
    const stack = d3.stack().keys(['base', 'peak', 'ren'])(data);
    svg.append('g').selectAll('path').data(stack).join('path').attr('fill', (s) => cats.find((c) => c[0] === s.key)[2]).attr('opacity', 0.9)
      .attr('d', d3.area().x((d) => x(d.data.t)).y0((d) => y(d[0])).y1((d) => y(d[1])).curve(d3.curveMonotoneX));
    const tip = G.tipFor(box.closest('.gx-card'));
    svg.append('rect').attr('x', ml).attr('y', 0).attr('width', W - 10 - ml).attr('height', Hh - 26).attr('fill', 'transparent')
      .on('mousemove', (ev) => { const t = x.invert(d3.pointer(ev)[0]); const d = data[d3.bisector((q) => q.t).center(data, t)]; tip.show(ev, tFmt(d.t), cats.map(([k, n, c]) => [c, n, G.pct(d[k] * 100)])); })
      .on('mouseleave', () => tip.hide());
    const lastD = data[data.length - 1];
    card('carry-sum').textContent = 'Right now baseload plants supply ' + G.pct(lastD.base * 100) + ', peaking plants ' + G.pct(lastD.peak * 100) + ' and renewables ' + G.pct(lastD.ren * 100) + ' of generation.';
  }

  /* ---------- What would change right now (economic redispatch) ---------- */
  function redispatch() {
    const box = card('redis-chart'); if (!box) return;
    const { rows, label } = windowRows();
    if (!rows.length) { G.failOrSkeleton(box, ['history']); return; }
    const st = plantStats(rows), last = rows[rows.length - 1];
    const online = Object.values(st).filter((o) => o.now >= 1 && !MUST_TAKE.has(o.p) && o.price != null && o.min != null).sort((a, b) => a.price - b.price);
    const D = d3.sum(online, (o) => o.now);
    let rem = D - d3.sum(online, (o) => o.min);
    for (const o of online) { o.opt = o.min; const add = Math.max(0, Math.min(o.max - o.min, rem)); o.opt += add; rem -= add; o.delta = o.opt - o.now; }
    const saving = d3.sum(online, (o) => o.now * o.price) - d3.sum(online, (o) => o.opt * o.price);
    card('redis-note').textContent = 'Megawatts each running plant would gain or lose if today’s demand at the latest reading were met cheapest-first, keeping every plant between the lowest and highest output it ran at ' + label + '. Sorted cheapest at top. It ignores ramp rates, reserve needs, transmission limits and contracts, so it shows direction, not an instruction.';
    legend(card('redis-legend'), [['Load more', G.color('LNG')], ['Load less', G.color('ULSD')]]);
    box.replaceChildren(); box.classList.remove('dash-skeleton');
    const shown = online.filter((o) => Math.abs(o.delta) >= 0.5);
    if (!shown.length) { box.append(el('p', 'gx-note', 'The plants running now are already in cost order for current demand.')); card('redis-sum').textContent = ''; return; }
    const W = box.clientWidth || 640, rowH = 30, Hh = shown.length * rowH + 16;
    const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('width', '100%').attr('height', Hh);
    const lw = G.measure(svg, shown.map((o) => o.p)) + 12, mx = d3.max(shown, (o) => Math.abs(o.delta)) || 1;
    const x = d3.scaleLinear([-mx, mx], [lw + 50, W - 60]);
    svg.append('line').attr('x1', x(0)).attr('x2', x(0)).attr('y1', 0).attr('y2', Hh).attr('stroke', 'var(--cds-chart-axis)');
    const tip = G.tipFor(box.closest('.gx-card'));
    shown.forEach((o, i) => {
      const yy = 6 + i * rowH, up = o.delta > 0;
      svg.append('text').attr('x', lw - 8).attr('y', yy + 11).attr('dy', '0.35em').attr('text-anchor', 'end').attr('class', 'lbl-strong').text(o.p);
      svg.append('rect').attr('x', up ? x(0) : x(o.delta)).attr('y', yy).attr('width', Math.max(2, Math.abs(x(o.delta) - x(0)))).attr('height', rowH - 8).attr('rx', 3).attr('fill', up ? G.color('LNG') : G.color('ULSD'))
        .on('mousemove', (ev) => tip.show(ev, o.p, [[null, 'Now', G.f0(Math.round(o.now)) + ' MW'], [null, 'Cheapest-first', G.f0(Math.round(o.opt)) + ' MW'], [null, 'Range ' + label, G.f0(Math.round(o.min)) + '–' + G.f0(Math.round(o.max)) + ' MW'], [null, 'Cost', '$' + G.f0(o.price) + '/MWh']]))
        .on('mouseleave', () => tip.hide());
      svg.append('text').attr('x', up ? x(o.delta) + 6 : x(o.delta) - 6).attr('y', yy + 11).attr('dy', '0.35em').attr('text-anchor', up ? 'start' : 'end').text((up ? '+' : '−') + G.f0(Math.abs(Math.round(o.delta))) + ' MW');
    });
    card('redis-sum').textContent = saving > 1 ? 'Meeting the same ' + G.f0(Math.round(D)) + ' MW cheapest-first would cost about ' + G.money(Math.round(saving)) + ' less per hour (' + G.money(Math.round(saving * 24)) + ' a day at this level).' : '';
  }

  /* ---------- Load duration curve ---------- */
  function ldc() {
    const box = card('ldc-chart'); if (!box) return;
    const m = new Map();
    for (const r of [...G.rows('trace_recent'), ...G.rows('live_graph')]) { if (!r.time || num(r.generation_mw) == null) continue; m.set(Math.floor(new Date(r.time) / 300000), Number(r.generation_mw)); }
    const keys = [...m.keys()].sort((a, b) => a - b); if (!keys.length) { G.failOrSkeleton(box, ['live_graph']); return; }
    const end = keys[keys.length - 1], vals = keys.filter((k) => end - k < 288).map((k) => m.get(k)).sort((a, b) => b - a);
    const base = vals[vals.length - 1], peak = vals[0], n = vals.length;
    box.replaceChildren(); box.classList.remove('dash-skeleton');
    const W = box.clientWidth || 640, Hh = 300;
    const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('width', '100%').attr('height', Hh);
    const y = d3.scaleLinear([0, peak * 1.08], [Hh - 34, 12]).nice();
    const ml = G.measure(svg, y.ticks(5).map(G.f0)) + 14;
    const x = d3.scaleLinear([0, 1], [ml, W - 10]), px = (i) => (n > 1 ? i / (n - 1) : 0);
    legend(card('ldc-legend'), [['Base load', G.color('LNG')], ['Above base load', G.color('Bunker C')]]);
    svg.append('g').selectAll('line').data(y.ticks(5)).join('line').attr('x1', ml).attr('x2', W - 10).attr('y1', y).attr('y2', y).attr('stroke', 'var(--cds-chart-grid)');
    svg.append('g').selectAll('text').data(y.ticks(5)).join('text').attr('x', ml - 6).attr('y', y).attr('dy', '0.35em').attr('text-anchor', 'end').text(G.f0);
    svg.append('g').selectAll('text').data([0, 0.2, 0.4, 0.6, 0.8, 1]).join('text').attr('x', x).attr('y', Hh - 18).attr('text-anchor', 'middle').text((v) => Math.round(v * 100) + '%');
    svg.append('text').attr('x', W - 10).attr('y', Hh - 3).attr('text-anchor', 'end').text('Share of the day load is at or above this level');
    svg.append('rect').attr('x', ml).attr('y', y(base)).attr('width', W - 10 - ml).attr('height', y(0) - y(base)).attr('fill', G.color('LNG')).attr('opacity', 0.85);
    svg.append('path').datum(vals).attr('fill', G.color('Bunker C')).attr('opacity', 0.5).attr('d', d3.area().x((v, i) => x(px(i))).y0(y(base)).y1((v) => y(v)));
    svg.append('path').datum(vals).attr('fill', 'none').attr('stroke', 'var(--ink)').attr('stroke-width', 1.8).attr('d', d3.line().x((v, i) => x(px(i))).y((v) => y(v)));
    svg.append('text').attr('x', W - 16).attr('y', y(base) + 18).attr('text-anchor', 'end').attr('class', 'ldc-lbl').text('Base load ' + G.f0(Math.round(base)) + ' MW, ' + G.pct((base / peak) * 100) + ' of peak');
    const dot = svg.append('circle').attr('r', 4.5).attr('fill', 'var(--ink)').attr('opacity', 0);
    const tip = G.tipFor(box.closest('.gx-card'));
    svg.append('rect').attr('x', ml).attr('y', 0).attr('width', W - 10 - ml).attr('height', Hh - 34).attr('fill', 'transparent')
      .on('mousemove', (ev) => { const f = Math.max(0, Math.min(1, x.invert(d3.pointer(ev)[0]))); const i = Math.round(f * (n - 1)); const v = vals[i];
        dot.attr('cx', x(px(i))).attr('cy', y(v)).attr('opacity', 1);
        tip.show(ev, 'At or above for ' + G.pct(px(i) * 100) + ' of the day', [[null, G.f0(Math.round(v)) + ' MW', null], [null, G.f0(Math.round(v - base)) + ' MW above base load', null]]); })
      .on('mouseleave', () => { dot.attr('opacity', 0); tip.hide(); });
    const above90 = vals[Math.floor(n * 0.1)];
    card('ldc-sum').textContent = 'Peak ' + G.f0(Math.round(peak)) + ' MW, base ' + G.f0(Math.round(base)) + ' MW. Load was above ' + G.f0(Math.round(above90)) + ' MW for only 10% of the time, so about ' + G.f0(Math.round(peak - above90)) + ' MW of capacity is needed for just a few hours a day.';
  }

  dash.onData(() => { for (const f of [merit, carriers, redispatch, ldc]) { try { f(); } catch (e) { console.error(f.name, e); } } });
})();
