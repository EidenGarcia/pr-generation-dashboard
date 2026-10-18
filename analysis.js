/* Cost and trends page */
(() => {
  const G = window.GX;
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  // All times are shown in Puerto Rico time (UTC-4, no daylight saving), whatever the viewer's time zone.
  const pr = (o) => { const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Puerto_Rico', ...o }); return (d) => f.format(d); };
  const tFmt = pr({ month: 'short', day: 'numeric', hour: 'numeric' });
  const dayKey = pr({ year: 'numeric', month: '2-digit', day: '2-digit' });
  let fy = 'All';
  const fySeg = document.getElementById('fy-seg');
  fySeg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; fy = b.dataset.v; render(); });
  document.getElementById('hu-q').addEventListener('input', () => render());
  let kwh = 600;
  document.getElementById('kwh-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; kwh = Number(b.dataset.v); render(); });

  function customer() {
    const now = G.rows('customer_now')[0], lk = G.rows('live_kpis')[0], fk = G.rows('fy_kpis').find((r) => r.fy === 'All');
    const q = (f, src) => document.querySelectorAll(`#cust-kpis [data-source="${src || 'customer_now'}"][data-field="${f}"]`);
    if (now) {
      q('fca_cents_kwh').forEach((e) => { e.textContent = G.f2(now.fca_cents_kwh); e.classList.remove('dash-skeleton'); });
      q('ppca_cents_kwh').forEach((e) => { e.textContent = G.f2(now.ppca_cents_kwh); e.classList.remove('dash-skeleton'); });
      q('total_cents_kwh').forEach((e) => { e.textContent = G.f2(now.total_cents_kwh); e.classList.remove('dash-skeleton'); });
      q('change_cents_kwh').forEach((e) => { e.textContent = now.change_cents_kwh == null ? '—' : (now.change_cents_kwh > 0 ? '+' : '') + G.f2(now.change_cents_kwh); });
      q('period').forEach((e) => { e.textContent = now.period; });
    }
    if (lk) q('genera_avg_cents_kwh', 'live_kpis').forEach((e) => { e.textContent = G.f2(lk.genera_avg_cents_kwh); e.classList.remove('dash-skeleton'); });
    // rate chart
    const el = document.getElementById('custrate-chart');
    if (!G.ok('customer_fuel_charges')) G.failOrSkeleton(el, ['customer_fuel_charges']);
    else {
      el.replaceChildren(); el.classList.remove('dash-skeleton');
      const rows = G.rows('customer_fuel_charges').map((r) => ({ ...r, fca: Number(r.fca_cents_kwh), ppca: Number(r.ppca_cents_kwh) })).sort((a, b) => (a.period_start < b.period_start ? -1 : 1));
      const refs = [];
      if (lk && lk.genera_avg_cents_kwh) refs.push(['Genera latest check', lk.genera_avg_cents_kwh, dash.colors[1]]);
      const h7 = G.rows('history').filter((r) => r.genera_avg_cents_kwh != null && Date.parse(r.at) >= Date.parse((G.rows('history').slice(-1)[0] || {}).at) - 7 * 864e5);
      if (h7.length > 1) refs.push(['Genera 7-day avg', d3.mean(h7, (r) => Number(r.genera_avg_cents_kwh)), dash.colors[5]]);
      if (fk && fk.usd_per_mwh) refs.push(['Genera filed-months avg', fk.usd_per_mwh / 10, dash.colors[3]]);
      const leg = document.getElementById('custrate-legend'); leg.replaceChildren();
      for (const [n, c, dash2] of [['Fuel charge (FCA)', dash.colors[0]], ['Purchased power (PPCA)', dash.colors[4]], ...refs.map((r) => [r[0], r[2], true])]) {
        const s = document.createElement('span'); const sw = document.createElement('span'); sw.className = 'gx-sw'; sw.style.background = c; if (dash2) { sw.style.height = '3px'; sw.style.verticalAlign = '3px'; } s.append(sw, n); leg.append(s);
      }
      const W = el.clientWidth || 420, H = 270;
      const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('height', H);
      const max = Math.max(d3.max(rows, (r) => r.fca + r.ppca), d3.max(refs, (r) => r[1]) || 0) * 1.12;
      const y = d3.scaleLinear([0, max], [H - 28, 10]).nice();
      const ticks = y.ticks(5), ml = G.measure(svg, ticks.map((t) => t + '¢')) + 10;
      const x = d3.scaleBand(rows.map((r) => r.quarter), [ml, W - 8]).padding(0.35);
      svg.append('g').selectAll('line').data(ticks).join('line').attr('x1', ml).attr('x2', W - 8).attr('y1', (t) => y(t)).attr('y2', (t) => y(t)).attr('stroke', 'var(--cds-chart-grid)');
      svg.append('g').selectAll('text').data(ticks).join('text').attr('x', ml - 6).attr('y', (t) => y(t)).attr('dy', '0.35em').attr('text-anchor', 'end').text((t) => t + '¢');
      const tip = G.tipFor(el.closest('.gx-card'));
      for (const r of rows) {
        const bw = Math.min(64, x.bandwidth()), bx = x(r.quarter) + (x.bandwidth() - bw) / 2;
        const g = svg.append('g').attr('class', 'gx-anim');
        g.append('rect').attr('x', bx).attr('y', y(r.fca)).attr('width', bw).attr('height', y(0) - y(r.fca)).attr('fill', dash.colors[0]);
        g.append('rect').attr('x', bx).attr('y', y(r.fca + r.ppca)).attr('width', bw).attr('height', y(r.fca) - y(r.fca + r.ppca)).attr('rx', 3).attr('fill', dash.colors[4]);
        svg.append('text').attr('x', bx + bw / 2).attr('y', y(r.fca + r.ppca) - 6).attr('text-anchor', 'middle').attr('class', 'lbl-strong').text(G.f2(r.fca + r.ppca) + '¢');
        svg.append('text').attr('x', bx + bw / 2).attr('y', H - 8).attr('text-anchor', 'middle').text(r.period);
        svg.append('rect').attr('x', x(r.quarter)).attr('y', 0).attr('width', x.bandwidth()).attr('height', H - 28).attr('fill', 'transparent')
          .on('mousemove', (ev) => tip.show(ev, r.period, [[dash.colors[0], 'Fuel charge (FCA)', G.f2(r.fca) + '¢/kWh'], [dash.colors[4], 'Purchased power (PPCA)', G.f2(r.ppca) + '¢/kWh'], [null, 'Total', G.f2(r.fca + r.ppca) + '¢/kWh'], [null, 'Source', r.source]]))
          .on('mouseleave', () => tip.hide());
      }
      for (const [n, v, c] of refs) {
        svg.append('line').attr('x1', ml).attr('x2', W - 8).attr('y1', y(v)).attr('y2', y(v)).attr('stroke', c).attr('stroke-width', 2).attr('stroke-dasharray', '6 4');
        svg.append('text').attr('x', W - 10).attr('y', y(v) - 5).attr('text-anchor', 'end').attr('class', 'lbl-strong').text(n + ' ' + G.f1(v) + '¢');
      }
      svg.append('line').attr('x1', ml).attr('x2', W - 8).attr('y1', y(0)).attr('y2', y(0)).attr('stroke', 'var(--cds-chart-axis)');
    }
    // household chart
    document.querySelectorAll('#kwh-seg button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.v) === kwh)));
    const hb = document.getElementById('custbill-chart');
    if (!G.ok('household_charges')) G.failOrSkeleton(hb, ['customer_fuel_charges']);
    else {
      const rows = G.rows('household_charges').filter((r) => r.kwh === kwh).sort((a, b) => (a.period_start < b.period_start ? -1 : 1));
      G.hbars(hb, rows.map((r) => ({ label: r.period, total: r.total_usd,
        segments: [{ value: r.fca_usd, color: dash.colors[0] }, { value: r.ppca_usd, color: dash.colors[4] }],
        endLabel: G.money(Math.round(r.total_usd)) + ' /month',
        tip: [[null, G.f0(r.kwh) + ' kWh a month', null], [dash.colors[0], 'Fuel charge', '$' + G.f2(r.fca_usd)], [dash.colors[4], 'Purchased power', '$' + G.f2(r.ppca_usd)], [null, 'Total', '$' + G.f2(r.total_usd)]] })), { barH: 28 });
    }
  }

  function renderCost() {
    customer();
    fySeg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === fy)));
    // KPIs
    const k = G.rows('fy_kpis').find((r) => r.fy === fy);
    document.querySelectorAll('#cost-kpis [data-kpi]').forEach((el) => {
      el.setAttribute('data-where', 'fy=' + fy);
      if (!k) { if (!G.ok('fy_kpis')) el.classList.add('dash-skeleton'); return; }
      const f = el.dataset.kpi, v = k[f];
      el.textContent = f === 'est_fuel_cost_musd' ? '$' + G.f1(v) : f === 'usd_per_mwh' ? '$' + G.f2(v) : G.f0(v);
      el.classList.remove('dash-skeleton');
    });
    // Monthly stacked
    const mEl = document.getElementById('monthcost-chart');
    if (!G.ok('cost_by_month_fuel')) G.failOrSkeleton(mEl, ['hist_fuel', 'fuel_prices']);
    else {
      mEl.replaceChildren(); mEl.classList.remove('dash-skeleton');
      const all = G.rows('cost_by_month_fuel');
      const sel = all.filter((r) => fy === 'All' || r.fy === fy);
      const fuels = G.FUELS.filter((f) => sel.some((r) => r.fuel === f));
      G.legend(document.getElementById('monthcost-legend'), fuels);
      const have = new Set(sel.map((r) => r.month));
      const ms = [...have].sort();
      const months = d3.utcMonth.range(G.mParse(ms[0]), d3.utcMonth.offset(G.mParse(ms[ms.length - 1]), 1)).map(d3.utcFormat('%Y-%m'));
      const by = d3.rollup(sel, (v) => d3.sum(v, (r) => r.cost_usd), (r) => r.month, (r) => r.fuel);
      const W = mEl.clientWidth || 600, H = 280;
      const svg = d3.select(mEl).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('height', H);
      const max = d3.max(months, (m) => d3.sum(fuels, (f) => (by.get(m)?.get(f)) || 0)) || 1;
      const y = d3.scaleLinear([0, max], [H - 28, 8]).nice();
      const ticks = y.ticks(5);
      const ml = G.measure(svg, ticks.map((t) => G.moneyC(t))) + 10;
      const x = d3.scaleBand(months, [ml, W - 4]).padding(0.22);
      svg.append('g').selectAll('line').data(ticks).join('line').attr('x1', ml).attr('x2', W - 4).attr('y1', (t) => y(t)).attr('y2', (t) => y(t)).attr('stroke', 'var(--cds-chart-grid)');
      svg.append('g').selectAll('text').data(ticks).join('text').attr('x', ml - 6).attr('y', (t) => y(t)).attr('dy', '0.35em').attr('text-anchor', 'end').text((t) => G.moneyC(t));
      const every = Math.max(1, Math.ceil(months.length / Math.max(1, Math.floor((W - ml) / 52))));
      svg.append('g').selectAll('text').data(months.filter((m, i) => i % every === 0)).join('text').attr('x', (m) => x(m) + x.bandwidth() / 2).attr('y', H - 8).attr('text-anchor', 'middle').text((m) => G.mFmt(G.mParse(m)));
      const defs = svg.append('defs');
      const pat = defs.append('pattern').attr('id', 'gx-hatch').attr('width', 6).attr('height', 6).attr('patternUnits', 'userSpaceOnUse').attr('patternTransform', 'rotate(45)');
      pat.append('line').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 6).attr('stroke', 'var(--cds-chart-muted)').attr('stroke-width', 2);
      const tip = G.tipFor(mEl.closest('.gx-card'));
      for (const m of months) {
        if (!have.has(m)) {
          svg.append('rect').attr('x', x(m)).attr('y', y(max * 0.35)).attr('width', x.bandwidth()).attr('height', y(0) - y(max * 0.35)).attr('fill', 'url(#gx-hatch)').attr('opacity', 0.6)
            .on('mousemove', (ev) => tip.show(ev, G.mFmt(G.mParse(m)), [[null, 'No filing in the uploaded set', null]])).on('mouseleave', () => tip.hide());
          continue;
        }
        let acc = 0;
        const g = svg.append('g').attr('class', 'gx-anim');
        for (const f of fuels) {
          const v = by.get(m)?.get(f) || 0; if (!v) continue;
          g.append('rect').attr('x', x(m)).attr('y', y(acc + v)).attr('width', x.bandwidth()).attr('height', Math.max(0, y(acc) - y(acc + v))).attr('fill', G.color(f));
          acc += v;
        }
        svg.append('rect').attr('x', x(m)).attr('y', 0).attr('width', x.bandwidth()).attr('height', H - 28).attr('fill', 'transparent')
          .on('mousemove', (ev) => tip.show(ev, d3.utcFormat('%B %Y')(G.mParse(m)), [...fuels.filter((f) => by.get(m)?.get(f)).map((f) => [G.color(f), f, G.moneyC(by.get(m).get(f))]), [null, 'Total', G.moneyC(acc)]]))
          .on('mouseleave', () => tip.hide());
      }
      svg.append('line').attr('x1', ml).attr('x2', W - 4).attr('y1', y(0)).attr('y2', y(0)).attr('stroke', 'var(--cds-chart-axis)');
    }
    // Cost by fuel
    const fEl = document.getElementById('fuelcost-chart');
    if (!G.ok('cost_by_fy_fuel')) G.failOrSkeleton(fEl, ['hist_fuel', 'fuel_prices']);
    else {
      const fr = G.rows('cost_by_fy_fuel').filter((r) => r.fy === fy).sort((a, b) => b.cost_usd - a.cost_usd);
      G.hbars(fEl, fr.map((r) => ({ label: r.fuel, total: r.cost_usd, segments: [{ value: r.cost_usd, color: G.color(r.fuel) }], endLabel: G.moneyC(r.cost_usd) + ' · ' + G.pct(r.share_pct),
        tip: [[G.color(r.fuel), r.fuel, null], [null, 'Est. cost', G.money(r.cost_usd)], [null, 'Share', G.pct(r.share_pct)], [null, 'Heat input', G.f0(r.mmbtu) + ' MMBtu']] })), { barH: 26 });
    }
    // Cost by plant (stacked)
    const pEl = document.getElementById('plantcost-chart');
    if (!G.ok('cost_by_fy_plant')) G.failOrSkeleton(pEl, ['hist_fuel', 'fuel_prices', 'hist_plant_month']);
    else {
      const pr = G.rows('cost_by_fy_plant').filter((r) => r.fy === fy && r.cost_usd > 0).sort((a, b) => b.cost_usd - a.cost_usd);
      G.hbars(pEl, pr.map((r) => ({ label: r.plant, total: r.cost_usd,
        segments: [{ value: r.cost_lng, color: G.color('LNG') }, { value: r.cost_bunker_c, color: G.color('Bunker C') }, { value: r.cost_ulsd, color: G.color('ULSD') }],
        endLabel: G.moneyC(r.cost_usd) + ' · $' + G.f0(Math.round(r.usd_per_mwh)) + '/MWh',
        tip: [[null, 'Total', G.money(r.cost_usd)], ...[['LNG', r.cost_lng], ['Bunker C', r.cost_bunker_c], ['ULSD', r.cost_ulsd]].filter((x) => x[1] > 0).map((x) => [G.color(x[0]), x[0], G.moneyC(x[1])]), [null, 'Net generation', G.f0(r.net_mwh) + ' MWh'], [null, 'Fuel cost', '$' + G.f2(r.usd_per_mwh) + '/MWh']] })));
    }
    // Cost table
    const ct = document.getElementById('cost-table');
    if (G.ok('cost_table')) {
      G.table(ct, G.rows('cost_table').filter((r) => r.fy === fy), [
        { k: 'plant' }, { k: 'fuel', render: (td, r) => { const s = document.createElement('span'); s.className = 'gx-sw'; s.style.background = G.color(r.fuel); td.append(s, r.fuel); } },
        { k: 'barrels', num: true, fmt: (v) => G.f0(v) }, { k: 'mmbtu', num: true, fmt: (v) => G.f0(v) }, { k: 'price', num: true, fmt: (v) => G.f2(v) }, { k: 'price_unit' },
        { k: 'cost_usd', num: true, fmt: (v) => G.money(v) },
        { k: 'share_pct', num: true, render: (td, r) => { const b = document.createElement('span'); b.className = 'gx-inbar'; b.style.width = Math.max(2, r.share_pct * 1.2) + 'px'; b.style.background = G.color(r.fuel); td.append(b, G.pct(r.share_pct)); } },
      ], { key: 'key', sortKey: 'cost_usd', redraw: render });
    }
  }

  function lineChart(el, rows, o) {
    el.replaceChildren(); el.classList.remove('dash-skeleton');
    const W = el.clientWidth || 400, H = o.H || 240;
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('height', H);
    const months = d3.utcMonth.range(G.mParse(rows[0].month), d3.utcMonth.offset(G.mParse(rows[rows.length - 1].month), 1));
    const map = new Map(rows.map((r) => [r.month, r]));
    const full = months.map((d) => ({ d, r: map.get(d3.utcFormat('%Y-%m')(d)) }));
    const y = d3.scaleLinear([o.min != null ? o.min : 0, d3.max(rows, (r) => r[o.k]) * 1.08], [H - 26, 8]).nice();
    const ticks = y.ticks(4);
    const ml = G.measure(svg, ticks.map(o.fmtTick)) + 10;
    let mr = 6, y2 = null, ticks2 = [];
    if (o.k2) { y2 = d3.scaleLinear([d3.min(rows, (r) => r[o.k2]) * 0.97, d3.max(rows, (r) => r[o.k2]) * 1.03], [H - 26, 8]).nice(); ticks2 = y2.ticks(4); mr = G.measure(svg, ticks2.map(G.f0)) + 10; }
    const x = d3.scaleUtc([months[0], months[months.length - 1]], [ml + 6, W - mr - 6]);
    svg.append('g').selectAll('line').data(ticks).join('line').attr('x1', ml).attr('x2', W - mr).attr('y1', (t) => y(t)).attr('y2', (t) => y(t)).attr('stroke', 'var(--cds-chart-grid)');
    svg.append('g').selectAll('text').data(ticks).join('text').attr('x', ml - 6).attr('y', (t) => y(t)).attr('dy', '0.35em').attr('text-anchor', 'end').text(o.fmtTick);
    if (y2) svg.append('g').selectAll('text').data(ticks2).join('text').attr('x', W - mr + 6).attr('y', (t) => y2(t)).attr('dy', '0.35em').text(G.f0);
    const xt = x.ticks(Math.max(2, Math.floor((W - ml - mr) / 70)));
    svg.append('g').selectAll('text').data(xt).join('text').attr('x', (d) => x(d)).attr('y', H - 6).attr('text-anchor', 'middle').text(G.mFmt);
    if (o.bars) {
      const bw = Math.max(3, Math.min(28, ((W - ml - mr) / months.length) * 0.7));
      svg.append('g').attr('class', 'gx-anim').selectAll('rect').data(full.filter((p) => p.r)).join('rect').attr('x', (p) => x(p.d) - bw / 2).attr('y', (p) => y(p.r[o.k])).attr('width', bw).attr('height', (p) => y(0) - y(p.r[o.k])).attr('rx', 3).attr('fill', dash.colors[0]);
    } else {
      svg.append('path').attr('class', 'gx-anim').datum(full).attr('fill', 'none').attr('stroke', dash.colors[0]).attr('stroke-width', 2).attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round')
        .attr('d', d3.line().defined((p) => p.r && p.r[o.k] != null).x((p) => x(p.d)).y((p) => y(p.r[o.k])));
      svg.append('g').selectAll('circle').data(full.filter((p) => p.r)).join('circle').attr('cx', (p) => x(p.d)).attr('cy', (p) => y(p.r[o.k])).attr('r', 2.5).attr('fill', dash.colors[0]);
    }
    if (y2) svg.append('path').datum(full).attr('fill', 'none').attr('stroke', dash.colors[1]).attr('stroke-width', 2).attr('stroke-dasharray', '5 4')
      .attr('d', d3.line().defined((p) => p.r && p.r[o.k2] != null).x((p) => x(p.d)).y((p) => y2(p.r[o.k2])));
    svg.append('line').attr('x1', ml).attr('x2', W - mr).attr('y1', y.range()[0]).attr('y2', y.range()[0]).attr('stroke', 'var(--cds-chart-axis)');
    const tip = G.tipFor(el.closest('.gx-card'));
    const rule = svg.append('line').attr('y1', 8).attr('y2', H - 26).attr('stroke', 'var(--cds-chart-reference)').attr('opacity', 0);
    svg.append('rect').attr('x', ml).attr('y', 0).attr('width', W - ml - mr).attr('height', H - 26).attr('fill', 'transparent')
      .on('mousemove', (ev) => {
        const [mx] = d3.pointer(ev); const d = d3.utcMonth.round(x.invert(mx)); const r = map.get(d3.utcFormat('%Y-%m')(d));
        rule.attr('x1', x(d)).attr('x2', x(d)).attr('opacity', 1);
        tip.show(ev, d3.utcFormat('%B %Y')(d), r ? o.tip(r) : [[null, 'No filing', null]]);
      })
      .on('mouseleave', () => { rule.attr('opacity', 0); tip.hide(); });
  }

  function renderStats() {
    const fm = G.rows('fleet_month');
    const fgEl = document.getElementById('fleetgen-chart'), fuEl = document.getElementById('fleetusd-chart');
    if (!G.ok('fleet_month')) { G.failOrSkeleton(fgEl, ['hist_plant_month']); G.failOrSkeleton(fuEl, ['hist_plant_month']); }
    else {
      lineChart(fgEl, fm, { k: 'net_gwh', bars: true, fmtTick: G.f0, tip: (r) => [[dash.colors[0], 'Net', G.f1(r.net_gwh) + ' GWh'], [null, 'Gross', G.f1(r.gross_gwh) + ' GWh']] });
      lineChart(fuEl, fm, { k: 'usd_per_mwh', k2: 'net_heat_rate_btu_kwh', min: 0, fmtTick: (t) => '$' + G.f0(t), tip: (r) => [[dash.colors[0], 'Fuel cost', '$' + G.f2(r.usd_per_mwh) + '/MWh'], [dash.colors[1], 'Heat rate', G.f0(r.net_heat_rate_btu_kwh) + ' Btu/kWh'], [null, 'Est. cost', G.moneyC(r.est_fuel_cost_usd)]] });
    }
    // Small multiples
    const sm = document.getElementById('sm-grid');
    if (!G.ok('hist_plant_month')) G.failOrSkeleton(sm, ['hist_plant_month']);
    else {
      sm.replaceChildren(); sm.classList.remove('dash-skeleton');
      const hp = G.rows('hist_plant_month').map((r) => ({ ...r, gwh: Number(r.net_mwh) / 1000 }));
      const allM = [...new Set(hp.map((r) => r.month))].sort();
      const months = d3.utcMonth.range(G.mParse(allM[0]), d3.utcMonth.offset(G.mParse(allM[allM.length - 1]), 1));
      const ymax = d3.max(hp, (r) => r.gwh) || 1;
      for (const plant of [...new Set(hp.map((r) => r.plant))]) {
        const item = document.createElement('div'); item.className = 'gx-sm-item gx-card'; item.style.padding = 'var(--cds-pad-sm)';
        const h = document.createElement('h4'); h.textContent = plant; item.append(h);
        const box = document.createElement('div'); box.className = 'gx-chart'; box.style.minHeight = '110px'; item.append(box); sm.append(item);
        const W = box.clientWidth || 220, H = 110;
        const svg = d3.select(box).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('height', H);
        const y = d3.scaleLinear([0, ymax], [H - 18, 6]).nice();
        const ml = G.measure(svg, y.ticks(2).map(G.f0)) + 6;
        const x = d3.scaleUtc([months[0], months[months.length - 1]], [ml + 2, W - 4]);
        svg.append('g').selectAll('line').data(y.ticks(2)).join('line').attr('x1', ml).attr('x2', W - 4).attr('y1', (t) => y(t)).attr('y2', (t) => y(t)).attr('stroke', 'var(--cds-chart-grid)');
        svg.append('g').selectAll('text').data(y.ticks(2)).join('text').attr('x', ml - 4).attr('y', (t) => y(t)).attr('dy', '0.35em').attr('text-anchor', 'end').text(G.f0);
        svg.append('g').selectAll('text').data([months[0], months[months.length - 1]]).join('text').attr('x', (d, i) => (i ? W - 4 : ml + 2)).attr('y', H - 3).attr('text-anchor', (d, i) => (i ? 'end' : 'start')).text(G.mFmt);
        const map = new Map(hp.filter((r) => r.plant === plant).map((r) => [r.month, r]));
        const full = months.map((d) => ({ d, r: map.get(d3.utcFormat('%Y-%m')(d)) }));
        svg.append('path').datum(full).attr('fill', 'none').attr('stroke', dash.colors[0]).attr('stroke-width', 2).attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round')
          .attr('d', d3.line().defined((p) => p.r).x((p) => x(p.d)).y((p) => y(p.r.gwh)));
        const tip = G.tipFor(item);
        svg.append('rect').attr('x', ml).attr('y', 0).attr('width', W - ml).attr('height', H - 18).attr('fill', 'transparent')
          .on('mousemove', (ev) => { const [mx] = d3.pointer(ev); const d = d3.utcMonth.round(x.invert(mx)); const r = map.get(d3.utcFormat('%Y-%m')(d));
            tip.show(ev, plant + ' · ' + d3.utcFormat('%b %Y')(d), r ? [[null, 'Net', G.f1(r.gwh) + ' GWh'], [null, 'Heat rate', r.net_heat_rate_btu_kwh ? G.f0(r.net_heat_rate_btu_kwh) + ' Btu/kWh' : '—']] : [[null, 'No filing', null]]); })
          .on('mouseleave', () => tip.hide());
      }
    }
    const isFleet = (r) => r.plant === 'Fleet total';
    const bold = (tr, r) => { if (isFleet(r)) tr.style.fontWeight = '600'; };
    if (G.ok('plant_stats')) G.table(document.getElementById('stats-table'), G.rows('plant_stats'), [
      { k: 'plant' }, { k: 'technology' }, { k: 'months', num: true }, { k: 'total_net_gwh', num: true, fmt: G.f1 }, { k: 'share_pct', num: true, fmt: G.pct },
      { k: 'mean_net_gwh', num: true, fmt: G.f1 }, { k: 'sd_net_gwh', num: true, fmt: G.f1 }, { k: 'cv_pct', num: true, fmt: G.pct }, { k: 'min_net_gwh', num: true, fmt: G.f1 }, { k: 'max_net_gwh', num: true, fmt: G.f1 },
      { k: 'net_heat_rate_btu_kwh', num: true, fmt: (v) => (v ? G.f0(v) : '—') }, { k: 'est_usd_per_mwh', num: true, fmt: (v) => (v ? '$' + G.f2(v) : '—') },
    ], { key: 'plant', sortKey: 'total_net_gwh', pinLast: isFleet, rowStyle: bold, redraw: render });
    const chg = (k) => ({ k, num: true, render: (td, r) => { const v = r[k]; td.textContent = G.signed(v); if (v != null) td.className = 'num ' + (v >= 0 ? 'gx-t-ok' : 'gx-t-bad'); } });
    if (G.ok('yoy_plant')) G.table(document.getElementById('yoy-table'), G.rows('yoy_plant'), [
      { k: 'plant' }, { k: 'jul_dec_2024_gwh', num: true, fmt: G.f1 }, { k: 'jul_dec_2025_gwh', num: true, fmt: G.f1 }, chg('change_jul_dec_pct'),
      { k: 'apr_jun_2025_gwh', num: true, fmt: G.f1 }, { k: 'apr_jun_2026_gwh', num: true, fmt: G.f1 }, chg('change_apr_jun_pct'),
    ], { key: 'plant', sortKey: 'jul_dec_2025_gwh', pinLast: isFleet, rowStyle: bold, redraw: render });
    document.getElementById('hu-fy').textContent = fy === 'All' ? 'All filed months' : fy.replace('FY', 'FY 20').replace('-', '-');
    if (G.ok('unit_totals')) {
      const qv = document.getElementById('hu-q').value.trim().toLowerCase();
      G.table(document.getElementById('hu-table'), G.rows('unit_totals').filter((r) => r.fy === fy && (!qv || (r.unit + ' ' + r.plant).toLowerCase().includes(qv))), [
        { k: 'plant' }, { k: 'unit' }, { k: 'net_gwh', num: true, fmt: G.f1 }, { k: 'gross_gwh', num: true, fmt: G.f1 }, { k: 'months_running', num: true }, { k: 'months', num: true },
      ], { key: 'key', sortKey: 'net_gwh', redraw: render });
    }
    if (G.ok('hist_reconciliation')) G.table(document.getElementById('dq-table'), G.rows('hist_reconciliation'), [
      { k: 'month' }, { k: 'fy' }, { k: 'unit_sheets_net_mwh', num: true, fmt: (v) => G.f0(Math.round(v)) }, { k: 'system_sheet_net_mwh', num: true, fmt: (v) => G.f0(Math.round(v)) },
      { k: 'difference_mwh', num: true, render: (td, r) => { td.textContent = G.f0(Math.round(r.difference_mwh)); if (r.status !== 'Matches') td.className = 'num gx-t-bad'; } },
      { k: 'status', render: (td, r) => { const s = document.createElement('span'); s.className = 'gx-pill'; const d = document.createElement('i'); d.className = 'gx-dot ' + (r.status === 'Matches' ? 'ok' : 'bad'); s.append(d, r.status); td.append(s); } },
      { k: 'plants_affected', fmt: (v) => v || '—' },
    ], { key: 'month', redraw: render });
  }

  function renderSources() {
    if (G.ok('fuel_prices')) G.table(document.getElementById('prices-table'), G.rows('fuel_prices'), [
      { k: 'plant' }, { k: 'fuel' }, { k: 'price', num: true, fmt: (v) => G.f2(Number(v)) }, { k: 'price_unit' }, { k: 'basis' }, { k: 'source', render: (td, r) => { td.textContent = r.source; td.style.whiteSpace = 'normal'; td.style.minWidth = '22rem'; } },
    ], { key: 'key', redraw: render });
  }


  const FUELS = [['lng', 'LNG'], ['bunker_c', 'Bunker C'], ['ulsd', 'ULSD'], ['coal', 'Coal'], ['solar', 'Solar'], ['wind', 'Wind'], ['hydro', 'Hydro'], ['landfill_gas', 'Landfill gas']];

  function intro() {
    const t = document.getElementById('takeaway');
    const now = G.rows('customer_now')[0], lk = G.rows('live_kpis')[0], fk = G.rows('fy_kpis').find((r) => r.fy === 'All');
    if (!now) return;
    t.replaceChildren();
    const b = (s) => { const e = document.createElement('b'); e.textContent = s; return e; };
    t.append('Customers pay ', b(G.f2(now.total_cents_kwh) + '¢ per kWh'), ' for fuel and purchased power in ' + now.period + ' (FCA ' + G.f2(now.fca_cents_kwh) + '¢ + PPCA ' + G.f2(now.ppca_cents_kwh) + '¢), ',
      b((now.change_cents_kwh > 0 ? 'up ' : 'down ') + G.f2(Math.abs(now.change_cents_kwh)) + '¢'), ' from the quarter before.');
    if (lk && lk.genera_avg_cents_kwh) t.append(' At the latest check Genera’s units were burning fuel at ', b(G.f1(lk.genera_avg_cents_kwh) + '¢ per kWh generated'), '.');
    if (fk) t.append(' Over the filed months, Genera’s fuel is worth about ', b('$' + G.f1(fk.est_fuel_cost_musd) + ' million'), ' at today’s prices.');
  }

  function liveTrend() {
    const h = G.rows('history').map((r) => ({ ...r, t: new Date(r.at) }));
    const kp = document.getElementById('lt-kpis'); kp.replaceChildren();
    const kpi = (l, v, n) => { const d = document.createElement('div'); d.className = 'gx-kpi'; const a = document.createElement('div'); a.className = 'gx-kpi-l'; a.textContent = l; const c = document.createElement('div'); c.className = 'gx-kpi-v'; c.textContent = v; const e = document.createElement('div'); e.className = 'gx-kpi-n'; e.textContent = n; d.append(a, c, e); kp.append(d); };
    if (!h.length) { kp.append(Object.assign(document.createElement('p'), { className: 'gx-note', textContent: G.st('history').status === 'error' ? 'Could not load data/history.json.' : 'No hourly checks yet.' })); return; }
    const last = h[h.length - 1].t;
    const d24 = h.filter((r) => last - r.t <= 864e5), d7 = h.filter((r) => last - r.t <= 7 * 864e5);
    const avg = (a, k) => { const v = a.map((r) => num(r[k])).filter((x) => x != null); return v.length ? d3.mean(v) : null; };
    const errs = h.filter((r) => num(r.forecast_load_mw) != null && num(r.total_mw)).map((r) => Math.abs(r.forecast_load_mw - r.total_mw) / r.total_mw * 100);
    kpi('Dispatch cost, last 24 h', avg(d24, 'dispatch_cost_usd_h') == null ? '—' : G.money(avg(d24, 'dispatch_cost_usd_h')), '$ per hour, average of ' + d24.length + ' checks');
    kpi('Estimated cost per day', avg(d24, 'dispatch_cost_usd_h') == null ? '—' : G.moneyC(avg(d24, 'dispatch_cost_usd_h') * 24), 'if the last 24 h average holds');
    kpi('All producers, 7 days', avg(d7, 'avg_cents_kwh') == null ? '—' : G.f2(avg(d7, 'avg_cents_kwh')) + '¢', 'average cost per kWh generated');
    kpi('Genera, 7 days', avg(d7, 'genera_avg_cents_kwh') == null ? '—' : G.f2(avg(d7, 'genera_avg_cents_kwh')) + '¢', 'average cost per kWh generated');
    kpi('Forecast error', errs.length ? G.f1(d3.mean(errs)) + '%' : '—', errs.length ? 'mean absolute error, ' + errs.length + ' hours' : 'measured once forecasts can be checked');
    // stacked cost bars
    const fuels = FUELS.filter(([k]) => h.some((r) => num(r['cost_' + k]) > 0));
    const lg = document.getElementById('lt-cost-legend'); lg.replaceChildren();
    for (const [, n] of fuels) { const s = document.createElement('span'); const sw = document.createElement('span'); sw.className = 'gx-sw'; sw.style.background = G.color(n); s.append(sw, n); lg.append(s); }
    const timeChart = (box, draw) => {
      box.replaceChildren(); box.classList.remove('dash-skeleton');
      const W = box.clientWidth || 500, Hh = 240;
      const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('width', '100%').attr('height', Hh);
      const t0 = d3.min(h, (r) => r.t), t1 = d3.max(h, (r) => r.t), pad = Math.max(36e5, (t1 - t0) * 0.03);
      draw(svg, W, Hh, [new Date(+t0 - pad), new Date(+t1 + pad)]);
    };
    timeChart(document.getElementById('lt-cost'), (svg, W, Hh, dom) => {
      const tot = (r) => d3.sum(fuels, ([k]) => num(r['cost_' + k]) || 0);
      const y = d3.scaleLinear([0, d3.max(h, tot) || 1], [Hh - 26, 8]).nice();
      const ml = G.measure(svg, y.ticks(4).map(G.moneyC)) + 10;
      const x = d3.scaleTime(dom, [ml, W - 8]);
      svg.append('g').selectAll('line').data(y.ticks(4)).join('line').attr('x1', ml).attr('x2', W - 8).attr('y1', y).attr('y2', y).attr('stroke', 'var(--cds-chart-grid)');
      svg.append('g').selectAll('text').data(y.ticks(4)).join('text').attr('x', ml - 6).attr('y', y).attr('dy', '0.35em').attr('text-anchor', 'end').text(G.moneyC);
      svg.append('g').selectAll('text').data(x.ticks(Math.max(2, Math.floor((W - ml) / 90)))).join('text').attr('x', x).attr('y', Hh - 6).attr('text-anchor', 'middle').text(tFmt);
      const bw = Math.max(2, Math.min(16, ((W - ml) / Math.max(1, (dom[1] - dom[0]) / 36e5)) * 0.7));
      const tip = G.tipFor(svg.node().closest('.gx-card'));
      for (const r of h) {
        let acc = 0;
        for (const [k, n] of fuels) { const v = num(r['cost_' + k]) || 0; if (!v) continue; svg.append('rect').attr('x', x(r.t) - bw / 2).attr('y', y(acc + v)).attr('width', bw).attr('height', y(acc) - y(acc + v)).attr('fill', G.color(n)); acc += v; }
        svg.append('rect').attr('x', x(r.t) - Math.max(bw, 8) / 2).attr('y', 0).attr('width', Math.max(bw, 8)).attr('height', Hh - 26).attr('fill', 'transparent')
          .on('mousemove', (ev) => tip.show(ev, tFmt(r.t), [...fuels.filter(([k]) => num(r['cost_' + k]) > 0).map(([k, n]) => [G.color(n), n, G.money(num(r['cost_' + k])) + '/h']), [null, 'Total', G.money(acc) + '/h']]))
          .on('mouseleave', () => tip.hide());
      }
    });
    const cust = G.rows('customer_now')[0];
    const lg2 = document.getElementById('lt-ckwh-legend'); lg2.replaceChildren();
    for (const [n, c] of [['All producers', 'var(--c1)'], ['Genera', 'var(--c3)'], ['Customer FCA + PPCA', 'var(--alert)']]) { const s = document.createElement('span'); const sw = document.createElement('span'); sw.className = 'gx-sw'; sw.style.background = c; s.append(sw, n); lg2.append(s); }
    timeChart(document.getElementById('lt-ckwh'), (svg, W, Hh, dom) => {
      const vals = h.flatMap((r) => [num(r.avg_cents_kwh), num(r.genera_avg_cents_kwh)]).filter((v) => v != null);
      if (cust) vals.push(cust.total_cents_kwh);
      const y = d3.scaleLinear([0, (d3.max(vals) || 1) * 1.12], [Hh - 26, 8]).nice();
      const ml = G.measure(svg, y.ticks(4).map((v) => v + '¢')) + 10;
      const x = d3.scaleTime(dom, [ml, W - 8]);
      svg.append('g').selectAll('line').data(y.ticks(4)).join('line').attr('x1', ml).attr('x2', W - 8).attr('y1', y).attr('y2', y).attr('stroke', 'var(--cds-chart-grid)');
      svg.append('g').selectAll('text').data(y.ticks(4)).join('text').attr('x', ml - 6).attr('y', y).attr('dy', '0.35em').attr('text-anchor', 'end').text((v) => v + '¢');
      svg.append('g').selectAll('text').data(x.ticks(Math.max(2, Math.floor((W - ml) / 90)))).join('text').attr('x', x).attr('y', Hh - 6).attr('text-anchor', 'middle').text(tFmt);
      if (cust) { svg.append('line').attr('x1', ml).attr('x2', W - 8).attr('y1', y(cust.total_cents_kwh)).attr('y2', y(cust.total_cents_kwh)).attr('stroke', 'var(--alert)').attr('stroke-width', 2).attr('stroke-dasharray', '6 4');
        svg.append('text').attr('x', W - 10).attr('y', y(cust.total_cents_kwh) - 6).attr('text-anchor', 'end').attr('class', 'lbl-strong').text('Customers pay ' + G.f2(cust.total_cents_kwh) + '¢'); }
      for (const [k, c] of [['avg_cents_kwh', 'var(--c1)'], ['genera_avg_cents_kwh', 'var(--c3)']]) {
        const d = h.filter((r) => num(r[k]) != null);
        svg.append('path').datum(d).attr('fill', 'none').attr('stroke', c).attr('stroke-width', 2).attr('d', d3.line().x((r) => x(r.t)).y((r) => y(num(r[k]))));
        svg.append('g').selectAll('circle').data(d).join('circle').attr('cx', (r) => x(r.t)).attr('cy', (r) => y(num(r[k]))).attr('r', 2.5).attr('fill', c);
      }
      const tip = G.tipFor(svg.node().closest('.gx-card'));
      svg.append('rect').attr('x', ml).attr('y', 0).attr('width', W - ml - 8).attr('height', Hh - 26).attr('fill', 'transparent')
        .on('mousemove', (ev) => { const t = x.invert(d3.pointer(ev)[0]); const r = h[d3.bisector((q) => q.t).center(h, t)];
          tip.show(ev, tFmt(r.t), [['var(--c1)', 'All producers', r.avg_cents_kwh == null ? '—' : G.f2(r.avg_cents_kwh) + '¢/kWh'], ['var(--c3)', 'Genera', r.genera_avg_cents_kwh == null ? '—' : G.f2(r.genera_avg_cents_kwh) + '¢/kWh']]); })
        .on('mouseleave', () => tip.hide());
    });
    // daily table
    const days = d3.groups(h, (r) => { const [m, d, y] = dayKey(r.t).split('/'); return `${y}-${m}-${d}`; }).map(([day, rs]) => {
      const e = rs.filter((r) => num(r.forecast_load_mw) != null && num(r.total_mw)).map((r) => Math.abs(r.forecast_load_mw - r.total_mw) / r.total_mw * 100);
      const c = avg(rs, 'dispatch_cost_usd_h');
      return { day, checks: rs.length, avg_mw: avg(rs, 'total_mw'), peak_mw: d3.max(rs, (r) => num(r.total_mw)), avg_cost: c, day_cost: c == null ? null : c * 24, ckwh: avg(rs, 'avg_cents_kwh'), off: avg(rs, 'genera_units_offline'), err: e.length ? d3.mean(e) : null };
    });
    G.table(document.getElementById('lt-daily'), days, [
      { k: 'day', fmt: (v) => d3.timeFormat('%a %b %-d, %Y')(d3.timeParse('%Y-%m-%d')(v)) }, { k: 'checks', num: true },
      { k: 'avg_mw', num: true, fmt: (v) => (v == null ? '—' : G.f0(Math.round(v)) + ' MW') }, { k: 'peak_mw', num: true, fmt: (v) => (v == null ? '—' : G.f0(v) + ' MW') },
      { k: 'avg_cost', num: true, fmt: (v) => (v == null ? '—' : G.money(v)) }, { k: 'day_cost', num: true, fmt: (v) => (v == null ? '—' : G.moneyC(v)) },
      { k: 'ckwh', num: true, fmt: (v) => (v == null ? '—' : G.f2(v) + '¢') }, { k: 'off', num: true, fmt: (v) => (v == null ? '—' : G.f1(v)) },
      { k: 'err', num: true, fmt: (v) => (v == null ? '—' : G.f1(v) + '%') },
    ], { key: 'day', sortKey: 'day', redraw: render });
  }

  function render() { intro(); renderCost(); liveTrend(); renderStats(); renderSources(); }
  dash.onData(render);
  dash.init({
    live_units: 'data/live_units.json', live_metrics: 'data/live_metrics.json', live_fuel_price: 'data/live_fuel_price.json', history: 'data/history.json',
    hist_plant_month: 'data/hist_plant_month.json', hist_fuel: 'data/hist_fuel.json', hist_units: 'data/hist_units.json', hist_reconciliation: 'data/hist_reconciliation.json',
    fuel_prices: 'data/fuel_prices.json', customer_fuel_charges: 'data/customer_fuel_charges.json',
  }, 15);
})();
