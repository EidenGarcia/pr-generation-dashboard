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
  const up2 = (v) => d3.format(',.2f')(Math.ceil(v * 100 - 1e-9) / 100); // round up to two decimals
  const legend = (box, items) => { box.replaceChildren(); for (const [n, c] of items) { const s = el('span'); const sw = el('span', 'gx-sw'); sw.style.background = c; s.append(sw, n); box.append(s); } };
  const card = (id) => document.getElementById(id);
  function plantFuel() { const m = { Hydro: 'Hydro', Solar: 'Solar', Wind: 'Wind', 'Landfill gas': 'Landfill gas', AES: 'Coal', 'EcoEléctrica': 'LNG', 'San Juan CC': 'LNG', 'Costa Sur Steam': 'LNG', 'Palo Seco Steam': 'Bunker C', 'Aguirre Steam': 'Bunker C', 'San Juan Steam': 'Bunker C', Cambalache: 'ULSD', 'Mayagüez': 'ULSD', 'Aguirre CC 1': 'ULSD', 'Aguirre CC 2': 'ULSD', 'GT stations (peakers)': 'ULSD', 'Palo Seco GT/CT': 'ULSD', 'Aguirre GT/CT': 'ULSD', 'Costa Sur GT/CT': 'ULSD' }; for (const u of G.rows('live_units')) { const g = window.PREPA.plantGroup(u.plant); if (!m[g]) m[g] = G.norm(u.fuel); } return m; }
  // Readings with per-plant data: since midnight (Puerto Rico) when there are enough, otherwise the last 24 hours.
  function windowRows() {
    const rows = G.rows('history').filter((r) => r.plant_mw).map((r) => ({ ...r, t: new Date(r.at) })).sort((a, b) => a.t - b.t);
    if (!rows.length) return { rows, label: '' };
    const last = rows[rows.length - 1], today = rows.filter((r) => dayKey(r.t) === dayKey(last.t));
    return today.length >= 8 ? { rows: today, label: 'today' } : { rows: rows.filter((r) => last.t - r.t <= 24 * H), label: 'in the last 24 hours' };
  }
  const price = (r, p) => { const mw = (r.plant_mw || {})[p], c = (r.plant_cost || {})[p]; return mw >= 1 && c > 0 && window.COSTS.normalPlantMW(p, mw) ? c / mw : null; }; // $/MWh = ($/h) / MW, only at normal load
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
      const o = by.get(p) || { p, now: 0, avail: 0, cost: 0, costMW: 0, fuel: G.norm(u.fuel), units: 0, us: [] };
      o.us.push(u);
      const c = cap[u.unit_id] && cap[u.unit_id].rated_mw, seen = rng[u.unit_id] && rng[u.unit_id].max_on_mw;
      o.now += mw; o.avail += Math.max(mw, c || seen || mw); o.units++;
      if (Number(u.cost_cents_kwh) > 0) { o.cost += Number(u.cost_usd_per_hour); o.costMW += mw; }
      by.set(p, o);
    }
    const blocks = [...by.values()].filter((o) => o.now >= 1).map((o) => { const pp = window.COSTS.plantPrice(o.p, o.us); return { ...o, max: MUST_TAKE.has(o.p) ? o.now : o.avail, price: pp.price != null ? pp.price : MUST_TAKE.has(o.p) ? 0 : null, basis: pp.basis, lowUnits: o.us.filter((u) => window.COSTS.lowLoad(u)).length }; });
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
        .on('mousemove', (ev) => tip.show(ev, b.p, [[col, FUEL_LABEL[b.fuel] || b.fuel, null], [null, 'Cost', b.price ? '$' + up2(b.price) + '/MWh' + (b.basis === 'typical' ? ' (typical at normal load)' : '') : 'no reported cost'], ...(b.lowUnits ? [[null, b.lowUnits + ' unit(s) at low output', 'cost not used']] : []), [null, 'Producing now', running ? G.f0(Math.round(b.now)) + ' MW' : 'not running'],
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
    const shown = online.filter((o) => Math.abs(o.delta) >= 1.5); // ignore changes of 1 MW or less
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
        .on('mousemove', (ev) => tip.show(ev, o.p, [[null, 'Now', G.f0(Math.round(o.now)) + ' MW'], [null, 'Cheapest-first', G.f0(Math.round(o.opt)) + ' MW'], [null, 'Range ' + label, G.f0(Math.round(o.min)) + '–' + G.f0(Math.round(o.max)) + ' MW'], [null, 'Cost', '$' + up2(o.price) + '/MWh']]))
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

  /* ---------- Cost through the day (average by hour of day) ---------- */
  let cdPeriod = '7d', pdPeriod = '7d', pdPlant = '';
  const FK = [['lng', 'LNG', 'Natural gas'], ['bunker_c', 'Bunker C', 'Bunker C'], ['ulsd', 'ULSD', 'Diesel'], ['coal', 'Coal', 'Coal'], ['solar', 'Solar', 'Solar'], ['wind', 'Wind', 'Wind'], ['hydro', 'Hydro', 'Hydro'], ['landfill_gas', 'Landfill gas', 'Landfill gas']];
  const prHour = (d) => Number(pr({ hour: 'numeric', hourCycle: 'h23' })(d)) % 24;
  const hLabel = (h) => (h === 0 ? '12 AM' : h < 12 ? h + ' AM' : h === 12 ? '12 PM' : h - 12 + ' PM');
  // hourly rows: the updater's 35-day profile, plus this browser's own readings for hours the file doesn't have yet
  function hourlyRows() {
    const m = new Map(G.rows('cost_hourly').map((r) => [r.at.slice(0, 13), { ...r }]));
    const loc = new Map();
    for (const r of G.rows('history')) { if (!r.at || !r.plant_mw) continue; const k = r.at.slice(0, 13); if (m.has(k)) continue; (loc.get(k) || loc.set(k, []).get(k)).push(r); }
    for (const [k, list] of loc) {
      const row = { at: k + ':00:00-04:00', n: list.length, plant_mw: {}, plant_cost: {} };
      for (const r of list) {
        for (const [key, v] of Object.entries(r)) if (/^(total_mw|dispatch_cost_usd_h|cost_[a-z_]+|mw_[a-z_]+)$/.test(key) && Number.isFinite(Number(v))) row[key] = (row[key] || 0) + Number(v) / list.length;
        for (const [p, v] of Object.entries(r.plant_mw || {})) row.plant_mw[p] = (row.plant_mw[p] || 0) + Number(v) / list.length;
        for (const [p, v] of Object.entries(r.plant_cost || {})) row.plant_cost[p] = (row.plant_cost[p] || 0) + Number(v) / list.length;
      }
      m.set(k, row);
    }
    return [...m.values()].map((r) => ({ ...r, t: new Date(r.at) })).sort((a, b) => a.t - b.t);
  }
  function periodRows(period) {
    const rows = hourlyRows(); if (!rows.length) return { rows, days: 0, label: '' };
    const lastDay = dayKey(rows[rows.length - 1].t);
    const sel = period === 'today' ? rows.filter((r) => dayKey(r.t) === lastDay) : rows.filter((r) => rows[rows.length - 1].t - r.t < (period === '7d' ? 7 : 30) * 24 * H);
    const days = new Set(sel.map((r) => dayKey(r.t))).size;
    return { rows: sel, days, label: period === 'today' ? 'today' : 'average of the last ' + days + ' day' + (days === 1 ? '' : 's') };
  }
  // average each value by hour of day
  function profile(rows, get) {
    const acc = Array.from({ length: 24 }, () => ({ s: {}, n: 0 }));
    for (const r of rows) { const a = acc[prHour(r.t)]; a.n++; for (const [k, v] of Object.entries(get(r))) a.s[k] = (a.s[k] || 0) + (Number(v) || 0); }
    return acc.map((a, h) => ({ h, n: a.n, v: Object.fromEntries(Object.entries(a.s).map(([k, s]) => [k, s / (a.n || 1)])) }));
  }
  function seg(id, val, set) { document.querySelectorAll('#' + id + ' button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === val))); }
  function hourAxes(svg, W, Hh, y, yMoney, y2) {
    const ml = G.measure(svg, y.ticks(5).map(yMoney)) + 14, mr = y2 ? G.measure(svg, ['$0.000']) + 14 : 10;
    const x = d3.scaleBand(d3.range(24), [ml, W - mr]).padding(0.18);
    svg.append('g').selectAll('line').data(y.ticks(5)).join('line').attr('x1', ml).attr('x2', W - mr).attr('y1', y).attr('y2', y).attr('stroke', 'var(--cds-chart-grid)');
    svg.append('g').selectAll('text').data(y.ticks(5)).join('text').attr('x', ml - 6).attr('y', y).attr('dy', '0.35em').attr('text-anchor', 'end').text(yMoney);
    svg.append('g').selectAll('text').data([0, 3, 6, 9, 12, 15, 18, 21]).join('text').attr('x', (h) => x(h) + x.bandwidth() / 2).attr('y', Hh - 6).attr('text-anchor', 'middle').text(hLabel);
    if (y2) svg.append('g').selectAll('text').data(y2.ticks(4)).join('text').attr('x', W - mr + 6).attr('y', y2).attr('dy', '0.35em').attr('class', 'lbl-strong').text((v) => '$' + v.toFixed(3));
    return { x, ml, mr };
  }
  function costDay() {
    const box = card('costday-chart'); if (!box) return;
    seg('cd-period', cdPeriod);
    const P = periodRows(cdPeriod);
    if (!P.rows.length) { G.failOrSkeleton(box, ['history']); return; }
    const prof = profile(P.rows, (r) => { const o = { total: r.dispatch_cost_usd_h || 0, mw: r.total_mw || 0 }; for (const [k] of FK) if ((r['mw_' + k] || 0) >= 1) o[k] = r['cost_' + k] || 0; return o; });
    const fuels = FK.filter(([k]) => prof.some((p) => (p.v[k] || 0) >= 1));
    const tot = d3.sum(prof, (p) => p.v.total || 0) || 1;
    legend(card('costday-legend'), fuels.filter(([k]) => d3.sum(prof, (p) => p.v[k] || 0) / tot >= 0.001).map(([k, f, n]) => [n + ' ' + G.pct((d3.sum(prof, (p) => p.v[k] || 0) / tot) * 100), G.color(f)]));
    box.replaceChildren(); box.classList.remove('dash-skeleton');
    const W = box.clientWidth || 640, Hh = 300;
    const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('width', '100%').attr('height', Hh);
    const y = d3.scaleLinear([0, (d3.max(prof, (p) => d3.sum(fuels, ([k]) => p.v[k] || 0)) || 1) * 1.1], [Hh - 26, 12]).nice();
    const kwh = prof.map((p) => (p.v.mw ? p.v.total / (p.v.mw * 1000) : null));
    const y2 = d3.scaleLinear([0, (d3.max(kwh) || 0.1) * 1.25], [Hh - 26, 12]).nice();
    const { x } = hourAxes(svg, W, Hh, y, (v) => G.moneyC(v), y2);
    const tip = G.tipFor(box.closest('.gx-card'));
    for (const p of prof) {
      if (!p.n) continue; let acc = 0;
      for (const [k, f] of fuels) { const v = p.v[k] || 0; if (!v) continue; svg.append('rect').attr('x', x(p.h)).attr('width', x.bandwidth()).attr('y', y(acc + v)).attr('height', y(acc) - y(acc + v)).attr('fill', G.color(f)).attr('opacity', 0.92); acc += v; }
      svg.append('rect').attr('x', x(p.h)).attr('width', x.bandwidth()).attr('y', 0).attr('height', Hh - 26).attr('fill', 'transparent')
        .on('mousemove', (ev) => tip.show(ev, hLabel(p.h) + ' (' + P.label + ')', [...fuels.filter(([k]) => p.v[k] >= 1).sort((a, b) => p.v[b[0]] - p.v[a[0]]).map(([k, f, n]) => [G.color(f), n, G.money(Math.round(p.v[k])) + '/h, ' + G.pct((p.v[k] / (p.v.total || 1)) * 100)]), [null, 'Total', G.money(Math.round(p.v.total)) + '/h'], [null, 'Cost per kWh', kwh[p.h] == null ? '—' : '$' + kwh[p.h].toFixed(3) + '/kWh']]))
        .on('mouseleave', () => tip.hide());
    }
    const pts = prof.filter((p) => kwh[p.h] != null);
    svg.append('path').datum(pts).attr('fill', 'none').attr('stroke', 'var(--ink)').attr('stroke-width', 2).attr('d', d3.line().x((p) => x(p.h) + x.bandwidth() / 2).y((p) => y2(kwh[p.h])).curve(d3.curveMonotoneX));
    svg.append('g').selectAll('circle').data(pts).join('circle').attr('cx', (p) => x(p.h) + x.bandwidth() / 2).attr('cy', (p) => y2(kwh[p.h])).attr('r', 2.5).attr('fill', 'var(--ink)');
    const hi = pts.reduce((a, p) => (p.v.total > a.v.total ? p : a), pts[0]), lo = pts.reduce((a, p) => (p.v.total < a.v.total ? p : a), pts[0]);
    const topF = fuels.map(([k, f, n]) => [n, d3.sum(prof, (p) => p.v[k] || 0) / tot]).sort((a, b) => b[1] - a[1])[0];
    card('costday-sum').textContent = 'Cost peaks around ' + hLabel(hi.h) + ' (' + G.moneyC(hi.v.total) + '/h, $' + (kwh[hi.h] || 0).toFixed(3) + '/kWh) and is lowest around ' + hLabel(lo.h) + ' (' + G.moneyC(lo.v.total) + '/h). ' + (topF ? topF[0] + ' accounts for ' + G.pct(topF[1] * 100) + ' of the cost.' : '');
    card('costday-note').textContent = 'Bars: average dispatch cost per hour by fuel (left scale). Line: average cost per kWh of all generation (right scale). ' + (cdPeriod === 'today' ? 'Today so far.' : 'Each hour averaged over the ' + P.days + ' days with readings.');
  }
  /* ---------- Cost by plant through the day ---------- */
  const FALLBACK = { '--c1': '#4c7de0', '--c2': '#4fae87', '--c3': '#e3a42c', '--c4': '#e07a3f', '--c5': '#e384b1', '--c6': '#a08be0', '--c7': '#59b4d9', '--c8': '#98b85a' };
  const cssColor = (v) => { const m = /var\((--[\w-]+)\)/.exec(v); return m ? getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || FALLBACK[m[1]] || '#888' : v; };
  function plantColors(plants) {
    const fm = plantFuel(), out = {};
    for (const [fuel, ps] of d3.group(plants, (p) => fm[p] || 'Other')) { const base = d3.hsl(cssColor(fuelColor(fuel)));
      ps.forEach((p, i) => { const c = d3.hsl(base); if (ps.length > 1) c.l = Math.max(0.3, Math.min(0.78, base.l + (i / (ps.length - 1) - 0.5) * 0.34)); out[p] = c.formatHex(); }); }
    return out;
  }
  function plantDay() {
    const box = card('plantday-chart'), sel = card('pd-plant'); if (!box || !sel) return;
    seg('pd-period', pdPeriod);
    const P = periodRows(pdPeriod);
    if (!P.rows.length) { G.failOrSkeleton(box, ['history']); return; }
    const costOf = (r, p) => ((r.plant_mw || {})[p] >= 1 ? (r.plant_cost || {})[p] || 0 : 0);
    const totals = {}; for (const r of P.rows) for (const p of Object.keys(r.plant_cost || {})) totals[p] = (totals[p] || 0) + costOf(r, p);
    const plants = Object.keys(totals).filter((p) => totals[p] > 0).sort((a, b) => totals[b] - totals[a]);
    if (pdPlant && !plants.includes(pdPlant)) pdPlant = '';
    sel.replaceChildren(...[['', 'All plants'], ...plants.map((p) => [p, p])].map(([v, t]) => { const o = el('option', null, t); o.value = v; if (v === pdPlant) o.selected = true; return o; }));
    const colors = plantColors(plants);
    box.replaceChildren(); box.classList.remove('dash-skeleton');
    const W = box.clientWidth || 640, Hh = 300, tip = G.tipFor(box.closest('.gx-card'));
    const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('width', '100%').attr('height', Hh);
    if (!pdPlant) {
      const top = plants.slice(0, 9), rest = plants.slice(9);
      const prof = profile(P.rows, (r) => { const o = {}; for (const p of top) o[p] = costOf(r, p); if (rest.length) o.__other = d3.sum(rest, (p) => costOf(r, p)); return o; });
      const keys = [...top, ...(rest.length ? ['__other'] : [])], col = (k) => (k === '__other' ? 'var(--cds-chart-muted)' : colors[k]);
      legend(card('plantday-legend'), keys.map((k) => [k === '__other' ? 'Other plants' : k, col(k)]));
      const y = d3.scaleLinear([0, (d3.max(prof, (p) => d3.sum(keys, (k) => p.v[k] || 0)) || 1) * 1.1], [Hh - 26, 12]).nice();
      const { x } = hourAxes(svg, W, Hh, y, (v) => G.moneyC(v));
      for (const p of prof) { if (!p.n) continue; let acc = 0;
        for (const k of keys) { const v = p.v[k] || 0; if (v < 1) continue; svg.append('rect').attr('x', x(p.h)).attr('width', x.bandwidth()).attr('y', y(acc + v)).attr('height', y(acc) - y(acc + v)).attr('fill', col(k)).attr('opacity', 0.92); acc += v; }
        svg.append('rect').attr('x', x(p.h)).attr('width', x.bandwidth()).attr('y', 0).attr('height', Hh - 26).attr('fill', 'transparent')
          .on('mousemove', (ev) => tip.show(ev, hLabel(p.h) + ' (' + P.label + ')', [...keys.filter((k) => p.v[k] >= 1).sort((a, b) => p.v[b] - p.v[a]).map((k) => [col(k), k === '__other' ? 'Other plants' : k, G.money(Math.round(p.v[k])) + '/h']), [null, 'Total', G.money(Math.round(acc)) + '/h']]))
          .on('mouseleave', () => tip.hide()); }
      const hi = prof.reduce((a, p) => (d3.sum(keys, (k) => p.v[k] || 0) > d3.sum(keys, (k) => a.v[k] || 0) ? p : a), prof[0]);
      const share = plants.length ? totals[plants[0]] / (d3.sum(plants, (p) => totals[p]) || 1) : 0;
      card('plantday-sum').textContent = plants.length ? plants[0] + ' carries the largest share of the cost (' + G.pct(share * 100) + '). The most expensive hour is around ' + hLabel(hi.h) + '.' : '';
    } else {
      const p0 = pdPlant;
      const prof = profile(P.rows, (r) => ({ cost: costOf(r, p0), mw: (r.plant_mw || {})[p0] >= 1 ? r.plant_mw[p0] : 0, on: (r.plant_mw || {})[p0] >= 1 ? 1 : 0 }));
      const price = prof.map((p) => (p.v.mw >= 1 && window.COSTS.normalPlantMW(p0, p.v.mw) ? p.v.cost / p.v.mw : null));
      legend(card('plantday-legend'), [[p0 + ', $/hour', colors[p0]], ['Cost per MWh', 'var(--ink)']]);
      const y = d3.scaleLinear([0, (d3.max(prof, (p) => p.v.cost) || 1) * 1.15], [Hh - 26, 12]).nice();
      const y2 = d3.scaleLinear([0, (d3.max(price) || 1) * 1.2], [Hh - 26, 12]).nice();
      const ml = G.measure(svg, y.ticks(5).map(G.moneyC)) + 14, mr = G.measure(svg, ['$0,000']) + 14;
      const x = d3.scaleBand(d3.range(24), [ml, W - mr]).padding(0.18);
      svg.append('g').selectAll('line').data(y.ticks(5)).join('line').attr('x1', ml).attr('x2', W - mr).attr('y1', y).attr('y2', y).attr('stroke', 'var(--cds-chart-grid)');
      svg.append('g').selectAll('text').data(y.ticks(5)).join('text').attr('x', ml - 6).attr('y', y).attr('dy', '0.35em').attr('text-anchor', 'end').text(G.moneyC);
      svg.append('g').selectAll('text').data(y2.ticks(4)).join('text').attr('x', W - mr + 6).attr('y', y2).attr('dy', '0.35em').attr('class', 'lbl-strong').text((v) => '$' + G.f0(v));
      svg.append('g').selectAll('text').data([0, 3, 6, 9, 12, 15, 18, 21]).join('text').attr('x', (h) => x(h) + x.bandwidth() / 2).attr('y', Hh - 6).attr('text-anchor', 'middle').text(hLabel);
      for (const p of prof) { if (!p.n) continue;
        if (p.v.cost >= 1) svg.append('rect').attr('x', x(p.h)).attr('width', x.bandwidth()).attr('y', y(p.v.cost)).attr('height', y(0) - y(p.v.cost)).attr('rx', 2).attr('fill', colors[p0]).attr('opacity', 0.9);
        svg.append('rect').attr('x', x(p.h)).attr('width', x.bandwidth()).attr('y', 0).attr('height', Hh - 26).attr('fill', 'transparent')
          .on('mousemove', (ev) => tip.show(ev, p0 + ', ' + hLabel(p.h), [[colors[p0], 'Average cost', G.money(Math.round(p.v.cost)) + '/h'], [null, 'Average output', p.v.mw >= 1 ? G.f0(Math.round(p.v.mw)) + ' MW' : 'off'], [null, 'Cost per MWh', price[p.h] == null ? '—' : '$' + up2(price[p.h])], [null, 'Running', G.pct(p.v.on * 100) + ' of readings']]))
          .on('mouseleave', () => tip.hide()); }
      const pts = prof.filter((p) => price[p.h] != null);
      svg.append('path').datum(pts).attr('fill', 'none').attr('stroke', 'var(--ink)').attr('stroke-width', 2).attr('d', d3.line().x((p) => x(p.h) + x.bandwidth() / 2).y((p) => y2(price[p.h])).curve(d3.curveMonotoneX));
      svg.append('g').selectAll('circle').data(pts).join('circle').attr('cx', (p) => x(p.h) + x.bandwidth() / 2).attr('cy', (p) => y2(price[p.h])).attr('r', 2.5).attr('fill', 'var(--ink)');
      const avgP = d3.mean(pts, (p) => price[p.h]), runH = prof.filter((p) => p.v.on >= 0.5).length;
      card('plantday-sum').textContent = pts.length ? p0 + ' averages $' + up2(avgP) + '/MWh and runs in most readings during ' + runH + ' of 24 hours.' : p0 + ' did not run in this period.';
    }
    card('plantday-note').textContent = (pdPlant ? 'Bars: average cost per hour (left scale). Line: cost per MWh (right scale).' : 'Average cost per hour of each plant, stacked; the nine most costly plants are shown, the rest grouped.') + ' Readings below 1 MW are left out, and the cost per MWh line skips hours when the plant ran under ' + Math.round(window.COSTS.minPct() * 100) + '% of its capacity. ' + (pdPeriod === 'today' ? 'Today so far.' : 'Each hour averaged over the ' + P.days + ' days with readings.');
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('#cd-period button'); if (a) { cdPeriod = a.dataset.v; try { costDay(); } catch (err) { console.error(err); } }
    const b = e.target.closest('#pd-period button'); if (b) { pdPeriod = b.dataset.v; try { plantDay(); } catch (err) { console.error(err); } }
  });
  document.addEventListener('change', (e) => { if (e.target.id === 'pd-plant') { pdPlant = e.target.value; try { plantDay(); } catch (err) { console.error(err); } } });

  /* ---------- Share of energy vs share of cost, by plant ---------- */
  let shPeriod = '7d', shFuel = 'all';
  const FAMILY = { LNG: 'gas', 'Bunker C': 'bunker', ULSD: 'diesel', Coal: 'coal', Solar: 'renew', Wind: 'renew', Hydro: 'renew', 'Landfill gas': 'renew' };
  const FAM_LABEL = { gas: 'Natural gas', bunker: 'Bunker C', diesel: 'Diesel', coal: 'Coal', renew: 'Renewables' };
  const FAM_FUEL = { gas: 'LNG', bunker: 'Bunker C', diesel: 'ULSD', coal: 'Coal', renew: 'Solar' };
  function plantOperator() {
    const m = { AES: 'Independent (PPOA)', 'EcoEléctrica': 'Independent (PPOA)', Solar: 'Independent (PPOA)', Wind: 'Independent (PPOA)', 'Landfill gas': 'Independent (PPOA)', Hydro: 'PREPA (hydro)' };
    for (const u of G.rows('live_units')) { const g = window.PREPA.plantGroup(u.plant); if (!m[g]) m[g] = u.operator; }
    return (p) => m[p] || 'Genera PR';
  }
  // energy (MWh) and cost ($) per plant over hourly rows; an hour counts for a plant when it averaged at least 1 MW
  function plantTotals(rows) {
    const E = {}, C = {}, Hr = {};
    for (const r of rows) for (const [p, mw] of Object.entries(r.plant_mw || {})) { if (!(mw >= 1)) continue; E[p] = (E[p] || 0) + mw; C[p] = (C[p] || 0) + ((r.plant_cost || {})[p] || 0); Hr[p] = (Hr[p] || 0) + 1; }
    return { E, C, Hr };
  }
  function shares() {
    const box = card('share-chart'); if (!box) return;
    seg('sh-period', shPeriod); seg('sh-fuel', shFuel);
    const P = periodRows(shPeriod);
    if (!P.rows.length) { G.failOrSkeleton(box, ['history']); return; }
    const { E, C } = plantTotals(P.rows), fm = plantFuel(), op = plantOperator();
    const totE = d3.sum(Object.values(E)) || 1, totC = d3.sum(Object.values(C)) || 1;
    const all = Object.keys(E).filter((p) => E[p] >= 1).map((p) => ({ p, fam: FAMILY[fm[p]] || 'diesel', e: E[p] / totE, c: (C[p] || 0) / totC, kwh: (C[p] || 0) / (E[p] * 1000), op: op(p) }));
    all.forEach((x) => { x.ratio = x.e > 0 ? x.c / x.e : null; });
    const rows = all.filter((x) => shFuel === 'all' || x.fam === shFuel).sort((a, b) => b.c - a.c);
    legend(card('share-legend'), [['Share of energy', 'var(--cds-chart-muted)'], ['Share of cost (fuel color)', G.color('LNG')]]);
    box.replaceChildren(); box.classList.remove('dash-skeleton');
    const W = box.clientWidth || 800, rowH = 34, Hh = rows.length * rowH + 22;
    const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('width', '100%').attr('height', Hh);
    const lw = G.measure(svg, rows.map((x) => x.p)) + 14, rw = 150;
    const x = d3.scaleLinear([0, d3.max(rows, (r) => Math.max(r.e, r.c)) || 0.01], [lw, W - rw]).nice();
    svg.append('g').selectAll('line').data(x.ticks(5)).join('line').attr('x1', x).attr('x2', x).attr('y1', 14).attr('y2', Hh).attr('stroke', 'var(--cds-chart-grid)');
    svg.append('g').selectAll('text').data(x.ticks(5)).join('text').attr('x', x).attr('y', 10).attr('text-anchor', 'middle').text((v) => Math.round(v * 100) + '%');
    svg.append('text').attr('x', W - rw + 12).attr('y', 10).text('Cost ÷ energy');
    const tip = G.tipFor(box.closest('.gx-card'));
    rows.forEach((r, i) => {
      const y0 = 18 + i * rowH, col = fuelColor(FAM_FUEL[r.fam]);
      svg.append('text').attr('x', lw - 8).attr('y', y0 + 13).attr('text-anchor', 'end').attr('class', 'lbl-strong').text(r.p);
      svg.append('rect').attr('x', lw).attr('y', y0 + 2).attr('width', Math.max(1, x(r.e) - lw)).attr('height', 11).attr('rx', 2).attr('fill', 'var(--cds-chart-muted)');
      svg.append('rect').attr('x', lw).attr('y', y0 + 15).attr('width', Math.max(1, x(r.c) - lw)).attr('height', 11).attr('rx', 2).attr('fill', col);
      const hot = r.ratio >= 1.5, cool = r.ratio <= 0.75;
      svg.append('text').attr('x', W - rw + 12).attr('y', y0 + 18).attr('class', 'ratio' + (r.c === 0 ? '' : hot ? ' hot' : cool ? ' cool' : '')).text(r.ratio == null ? '—' : r.c === 0 ? 'no cost reported' : '×' + r.ratio.toFixed(2) + '  $' + r.kwh.toFixed(3) + '/kWh');
      svg.append('rect').attr('x', 0).attr('y', y0).attr('width', W).attr('height', rowH - 2).attr('fill', 'transparent')
        .on('mousemove', (ev) => tip.show(ev, r.p, [[null, FAM_LABEL[r.fam] + ', ' + r.op, null], ['var(--cds-chart-muted)', 'Share of energy', G.pct(r.e * 100)], [col, 'Share of cost', G.pct(r.c * 100)], [null, 'Cost ÷ energy', r.ratio == null ? '—' : '×' + r.ratio.toFixed(2)], [null, 'Cost per kWh', '$' + r.kwh.toFixed(3)]]))
        .on('mouseleave', () => tip.hide());
    });
    // summaries by fuel and by operator
    const sumBy = (key) => { const m = new Map(); for (const x of all) { const k = key(x); const o = m.get(k) || { k, e: 0, c: 0 }; o.e += x.e; o.c += x.c; m.set(k, o); } return [...m.values()].map((o) => ({ ...o, ratio: o.e ? o.c / o.e : null, kwh: o.e ? (o.c * totC) / (o.e * totE * 1000) : null })).sort((a, b) => b.c - a.c); };
    const fam = sumBy((x) => x.fam), ops = sumBy((x) => x.op);
    G.table(card('share-fuel-table'), fam.map((o) => ({ ...o, name: FAM_LABEL[o.k] })), [
      { k: 'name', render: (td, r) => { const s = el('span', 'gx-sw'); s.style.background = fuelColor(FAM_FUEL[r.k]); td.append(s, r.name); } },
      { k: 'e', num: true, fmt: (v) => G.pct(v * 100) }, { k: 'c', num: true, fmt: (v) => G.pct(v * 100) },
      { k: 'ratio', num: true, render: (td, r) => { td.textContent = r.ratio == null ? '—' : '×' + r.ratio.toFixed(2); td.className = 'num ratio-cell' + (r.ratio >= 1.5 ? ' hot' : r.ratio <= 0.75 ? ' cool' : ''); } },
      { k: 'kwh', num: true, fmt: (v) => (v == null ? '—' : '$' + v.toFixed(3)) },
    ], { key: 'k', sortKey: 'c', redraw: shares });
    G.table(card('share-op-table'), ops.map((o) => ({ ...o, name: o.k === 'Independent (PPOA)' ? 'Private producers (PPOA)' : o.k })), [
      { k: 'name' }, { k: 'e', num: true, fmt: (v) => G.pct(v * 100) }, { k: 'c', num: true, fmt: (v) => G.pct(v * 100) },
      { k: 'ratio', num: true, render: (td, r) => { td.textContent = r.ratio == null || r.c === 0 ? '—' : '×' + r.ratio.toFixed(2); td.className = 'num ratio-cell' + (r.c === 0 ? '' : r.ratio >= 1.5 ? ' hot' : r.ratio <= 0.75 ? ' cool' : ''); } },
      { k: 'kwh', num: true, fmt: (v, r) => (v == null || r.c === 0 ? 'no cost reported' : '$' + v.toFixed(3)) },
    ], { key: 'k', sortKey: 'c', redraw: shares });
    const worst = all.filter((x) => x.e >= 0.001 && x.c > 0).sort((a, b) => b.ratio - a.ratio)[0], priv = ops.find((o) => o.k === 'Independent (PPOA)'), gen = ops.find((o) => o.k === 'Genera PR');
    const parts = [];
    if (worst) parts.push(worst.p + ' produced ' + G.pct(worst.e * 100) + ' of the energy but ' + G.pct(worst.c * 100) + ' of the cost (×' + worst.ratio.toFixed(1) + ', $' + worst.kwh.toFixed(2) + '/kWh).');
    if (priv && gen) parts.push('Private producers produced ' + G.pct(priv.e * 100) + ' of the energy for ' + G.pct(priv.c * 100) + ' of the cost; Genera’s plants ' + G.pct(gen.e * 100) + ' for ' + G.pct(gen.c * 100) + '.');
    card('share-sum').textContent = parts.join(' ');
    card('share-note').textContent = (shPeriod === 'today' ? 'Today so far' : 'The last ' + P.days + ' days') + ', from every saved reading. Cost is the dispatch cost PREPA reports for each unit (MW × its cost per kWh), including units idling at low output. A ratio above 1 means a plant costs more than its share of the energy; below 1, less.';
  }

  /* ---------- Highest-cost plants: cost per hour while running, and hours run ---------- */
  function ranking() {
    const tb = card('rank-table'); if (!tb) return;
    const R30 = periodRows('30d'), R7 = periodRows('7d'), RT = periodRows('today');
    if (!R30.rows.length) return;
    const t30 = plantTotals(R30.rows), t7 = plantTotals(R7.rows), tt = plantTotals(RT.rows), fm = plantFuel();
    const rows = Object.keys(t30.Hr).filter((p) => (t30.C[p] || 0) > 0).map((p) => {
      const h7 = t7.Hr[p] || 0;
      const perH = h7 ? (t7.C[p] || 0) / h7 : (t30.C[p] || 0) / t30.Hr[p];
      const kwhE = h7 ? t7.E[p] : t30.E[p], kwhC = h7 ? t7.C[p] : t30.C[p];
      return { p, fuel: fm[p], perH, kwh: kwhE ? kwhC / (kwhE * 1000) : null, today: tt.Hr[p] || 0, h7, h30: t30.Hr[p] || 0, perDay: (t30.Hr[p] || 0) / (R30.days || 1) };
    });
    const mx = d3.max(rows, (r) => r.perH) || 1;
    G.table(tb, rows, [
      { k: 'p', render: (td, r) => { const s = el('span', 'gx-sw'); s.style.background = fuelColor(r.fuel); td.append(s, r.p); } },
      { k: 'perH', num: true, render: (td, r) => { const b = el('span', 'gx-inbar'); b.style.width = Math.max(2, (r.perH / mx) * 90) + 'px'; b.style.background = fuelColor(r.fuel); td.append(b, G.money(Math.round(r.perH))); } },
      { k: 'kwh', num: true, fmt: (v) => (v == null ? '—' : '$' + v.toFixed(3)) },
      { k: 'today', num: true, fmt: (v) => G.f0(v) + ' h' }, { k: 'h7', num: true, fmt: (v) => G.f0(v) + ' h' }, { k: 'h30', num: true, fmt: (v) => G.f0(v) + ' h' },
      { k: 'perDay', num: true, fmt: (v) => G.f1(v) + ' h' },
    ], { key: 'p', sortKey: 'perH', redraw: ranking });
    card('rank-note').textContent = 'Cost per hour while running and $/kWh use the last 7 days. An hour counts as run when the plant averaged at least 1 MW in it. Hours are counted only where readings exist: ' + R30.days + ' day(s) of data so far, so the 30-day columns fill in over time.';
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('#sh-period button'); if (a) { shPeriod = a.dataset.v; try { shares(); } catch (err) { console.error(err); } }
    const b = e.target.closest('#sh-fuel button'); if (b) { shFuel = b.dataset.v; try { shares(); } catch (err) { console.error(err); } }
  });

  dash.onData(() => { for (const f of [costDay, plantDay, shares, ranking, merit, carriers, redispatch, ldc]) { try { f(); } catch (e) { console.error(f.name, e); } } });
})();
