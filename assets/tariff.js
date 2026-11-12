/* What a kWh costs the customer.
   FCA (fuel of Genera's plants) and PPCA (energy bought from private producers) are estimated from the dispatch cost
   the dashboard records: cost ÷ energy generated. Everything else (base rate, subsidies, CELI, energy efficiency) is
   fixed in data/tariff.json until the Energy Bureau revises it. */
(() => {
  const G = window.GX, H = 3600000;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const $ = (id) => document.getElementById(id);
  const pr = (o) => { const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Puerto_Rico', ...o }); return (d) => f.format(d); };
  const tFmt = pr({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }), hFmt = pr({ hour: 'numeric' }), dFmt = pr({ month: 'short', day: 'numeric' });
  const prDay = (d) => { const [m, dd, y] = pr({ year: 'numeric', month: '2-digit', day: '2-digit' })(d).split('/'); return y + '-' + m + '-' + dd; };
  const prHour = (d) => Number(pr({ hour: 'numeric', hourCycle: 'h23' })(d)) % 24;
  const cents = (v) => (v * 100).toFixed(2) + ' ¢';
  const usd = (v) => '$' + d3.format(',.2f')(v);
  const PPOA = new Set(['AES', 'EcoEléctrica', 'Solar', 'Wind', 'Landfill gas']); // energy bought from private producers
  let period = 'now', showFixed = true, perSold = false, kwh = 800;

  // hourly rows: energy generated and cost split into Genera fuel (FCA) and purchased power (PPCA)
  function hourly() {
    const split = (r) => { let gen = 0, fca = 0, ppca = 0; for (const [p, mw] of Object.entries(r.plant_mw || {})) gen += Math.max(0, mw);
      for (const [p, c] of Object.entries(r.plant_cost || {})) { if (PPOA.has(p)) ppca += c; else fca += c; } return { gen, fca, ppca }; };
    const m = new Map(G.rows('cost_hourly').filter((r) => r.plant_cost).map((r) => [r.at.slice(0, 13), { t: new Date(r.at), ...split(r) }]));
    const loc = new Map();
    for (const r of G.rows('history')) { if (!r.at || !r.plant_cost) continue; const k = r.at.slice(0, 13); if (m.has(k)) continue; (loc.get(k) || loc.set(k, []).get(k)).push(split(r)); }
    for (const [k, list] of loc) m.set(k, { t: new Date(k + ':00:00-04:00'), gen: d3.mean(list, (x) => x.gen), fca: d3.mean(list, (x) => x.fca), ppca: d3.mean(list, (x) => x.ppca) });
    return [...m.values()].filter((r) => r.gen >= 100).sort((a, b) => a.t - b.t);
  }
  function nowRow() {
    const us = G.rows('live_units'); if (!us.length) return null;
    let gen = 0, fca = 0, ppca = 0;
    for (const u of us) { gen += Math.max(0, Number(u.mw) || 0); const c = Number(u.cost_usd_per_hour) || 0; if (PPOA.has(window.PREPA.plantGroup(u.plant))) ppca += c; else fca += c; }
    return gen >= 100 ? { t: new Date(us[0].snapshot), gen, fca, ppca } : null;
  }
  function rowsFor(p) {
    const rows = hourly(); if (!rows.length) return rows;
    const last = rows[rows.length - 1].t, today = prDay(last), mid = new Date(today + 'T00:00:00-04:00');
    if (p === 'now' || p === 'today') return rows.filter((r) => prDay(r.t) === today);
    if (p === 'yday') return rows.filter((r) => r.t >= new Date(+mid - 864e5) && r.t < mid);
    return rows.filter((r) => last - r.t < (p === '7d' ? 7 : 30) * 864e5);
  }
  // share of generated energy that is billed: approved quarterly sales ÷ energy generated per day (from the daily summaries)
  function salesRatio(T) {
    const days = G.rows('daily_summary').filter((d) => d.status === 'Complete' && d.gen_energy_mwh > 0).slice(-30);
    if (!days.length) return null;
    const r = (T.approved.sales_kwh_quarter / T.approved.quarter_days) / (d3.mean(days, (d) => d.gen_energy_mwh) * 1000);
    return r > 0.5 && r < 1 ? r : null;
  }
  function estimate(T) {
    const adj = perSold ? salesRatio(T) || 1 : 1;
    if (period === 'now') { const n = nowRow(); if (!n) return null; return { fca: n.fca / (n.gen * 1000) / adj, ppca: n.ppca / (n.gen * 1000) / adj, at: n.t, n: 1, adj }; }
    const rows = rowsFor(period); if (!rows.length) return null;
    const gen = d3.sum(rows, (r) => r.gen) * 1000;
    return { fca: d3.sum(rows, (r) => r.fca) / gen / adj, ppca: d3.sum(rows, (r) => r.ppca) / gen / adj, n: rows.length, days: new Set(rows.map((r) => prDay(r.t))).size, adj };
  }
  function parts(T, fca, ppca, n) { // $/kWh for a customer using n kWh
    const F = T.fixed, baseVar = (F.base_total_usd_at_reference - F.base_fixed_usd_month) / T.reference_customer.kwh;
    return [
      { k: 'fca', label: 'Fuel (FCA)', what: 'Fuel burned in Genera’s plants. Changes every quarter on the bill; here it follows the live cost.', v: fca, color: 'var(--tf-fca)', variable: true },
      { k: 'ppca', label: 'Purchased power (PPCA)', what: 'Energy bought from private producers: AES, EcoEléctrica and renewables.', v: ppca, color: 'var(--tf-ppca)', variable: true },
      { k: 'base_var', label: 'Base rate, per-kWh charge', what: 'Operating and maintenance budgets of LUMA, Genera and PREPA, and pensions.', v: baseVar, color: 'var(--tf-basev)' },
      { k: 'subs', label: 'Subsidies, CELI and others', what: 'Social subsidies (SUBA-HH), municipalities (CELI), other subsidies (SUBA-NHH) and energy efficiency (EE).', v: F.suba_hh_usd_kwh + F.celi_usd_kwh + F.suba_nhh_usd_kwh + F.ee_usd_kwh, color: 'var(--tf-subs)' },
      { k: 'base_fix', label: 'Base rate, fixed monthly charge', what: 'About ' + usd(F.base_fixed_usd_month) + ' a month, spread over your consumption.', v: F.base_fixed_usd_month / n, color: 'var(--tf-basef)' },
    ];
  }
  const seg = (id, val) => document.querySelectorAll('#' + id + ' button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === val)));
  const PERIOD_LABEL = { now: 'right now', today: 'today so far', yday: 'the last full day', '7d': 'the last 7 days', '30d': 'the last 30 days' };

  function render() {
    const T = G.rows('tariff')[0], root = $('price-body'); if (!T || !root) return;
    seg('tf-period', period);
    for (const [id, v] of [['tf-fixed', showFixed], ['tf-sold', perSold]]) { const c = $(id); if (c) c.checked = v; }
    const E = estimate(T), A = T.approved;
    const kp = $('tf-kpis'); kp.replaceChildren();
    if (!E) { kp.append(el('p', 'gx-note', 'Waiting for cost readings.')); return; }
    const P = parts(T, E.fca, E.ppca, kwh), shown = P.filter((p) => showFixed || p.variable);
    const total = d3.sum(shown, (p) => p.v), genCost = E.fca + E.ppca;
    const apprP = parts(T, A.fca_usd_kwh, A.ppca_usd_kwh, kwh), apprTotal = d3.sum(apprP.filter((p) => showFixed || p.variable), (p) => p.v);
    const k = (label, value, note, cls) => { const d = el('div', 'gx-kpi' + (cls ? ' ' + cls : '')); d.append(el('div', 'gx-kpi-l', label), el('div', 'gx-kpi-v', value), el('div', 'gx-kpi-n', note)); kp.append(d); };
    k(showFixed ? 'Estimated price per kWh' : 'Estimated generation cost per kWh', cents(total), PERIOD_LABEL[period] + (period === 'now' ? ', ' + tFmt(E.at) : ''), 'tf-main');
    k('Fuel (FCA), estimated', cents(E.fca), 'approved on the bill: ' + cents(A.fca_usd_kwh));
    k('Purchased power (PPCA), estimated', cents(E.ppca), 'approved on the bill: ' + cents(A.ppca_usd_kwh));
    k('Approved for ' + T.period_label, cents(apprTotal), showFixed ? usd(apprTotal * kwh) + ' for ' + G.f0(kwh) + ' kWh' : 'FCA + PPCA on the bill');
    const diff = total - apprTotal;
    k('Estimate vs. approved', (diff >= 0 ? '+' : '−') + cents(Math.abs(diff)), diff >= 0 ? 'generation is costing more than the bill charges' : 'generation is costing less than the bill charges', diff > 0.005 ? 'bad' : '');

    donut(shown, total); bars(P, apprP); timeline(T); table(P, apprP); calc(T, E);
    $('tf-note').textContent = 'How the estimate works: FCA = cost of the fuel Genera’s plants are burning ÷ energy generated; PPCA = cost of energy from AES, EcoEléctrica and renewables ÷ energy generated, using the cost PREPA reports for each unit' + (period === 'now' ? ' at the latest reading.' : ', added up over ' + E.n + ' hour(s) of readings.') +
      (perSold && E.adj < 1 ? ' Adjusted to kWh billed: only about ' + G.pct(E.adj * 100) + ' of what is generated is sold (the rest is lost in the lines or not billed), so each billed kWh carries more cost.' : ' Per kWh generated. The bill divides by kWh sold, which is fewer than those generated, so the billed figure is higher; turn on “per kWh billed” to adjust.') +
      ' The bill’s FCA also includes ' + usd(A.fca_reconciliation_usd / 1e6) + ' million carried over from June to August (about ' + cents(A.fca_reconciliation_usd / A.sales_kwh_quarter) + '/kWh), and its PPCA includes capacity payments that the live feed does not show. Solar and wind report no cost in the feed.';
  }

  function donut(shown, total) {
    const box = $('tf-donut'); box.replaceChildren();
    const S = 240, R = 104, svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${S} ${S}`).attr('width', '100%').attr('height', S).style('max-width', S + 'px');
    const g = svg.append('g').attr('transform', `translate(${S / 2},${S / 2})`), arc = d3.arc().innerRadius(R - 38).outerRadius(R).padAngle(0.012);
    const tip = G.tipFor(box.closest('.gx-card'));
    g.selectAll('path').data(d3.pie().sort(null).value((p) => p.v)(shown)).join('path').attr('d', arc).attr('fill', (d) => d.data.color)
      .on('mousemove', (ev, d) => tip.show(ev, d.data.label, [[d.data.color, cents(d.data.v) + ' per kWh', G.pct((d.data.v / total) * 100)]])).on('mouseleave', () => tip.hide());
    g.append('text').attr('text-anchor', 'middle').attr('y', -2).attr('class', 'tf-c1').text((total * 100).toFixed(2) + ' ¢');
    g.append('text').attr('text-anchor', 'middle').attr('y', 18).attr('class', 'tf-c2').text('per kWh');
    const lg = $('tf-donut-legend'); lg.replaceChildren();
    for (const p of shown) { const r = el('div', 'tf-lg'); const sw = el('span', 'gx-sw'); sw.style.background = p.color; r.append(sw, el('span', 'tf-lg-n', p.label), el('span', 'tf-lg-v', G.pct((p.v / total) * 100)), el('span', 'tf-lg-c', cents(p.v))); lg.append(r); }
  }
  // approved vs estimated, as two stacked bars
  function bars(P, A) {
    const box = $('tf-bars'); box.replaceChildren();
    const rows = [['Estimated, ' + PERIOD_LABEL[period], P], ['Approved on the bill', A]].map(([n, list]) => [n, list.filter((p) => showFixed || p.variable)]);
    const W = box.clientWidth || 600, rowH = 46, Hh = rows.length * rowH + 24, lw = 4;
    const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('width', '100%').attr('height', Hh);
    const mx = d3.max(rows, ([, l]) => d3.sum(l, (p) => p.v)) || 0.1, x = d3.scaleLinear([0, mx * 1.14], [lw, W - 6]);
    rows.forEach(([name, list], i) => {
      const y0 = 18 + i * rowH; let acc = 0;
      svg.append('text').attr('x', lw).attr('y', y0 - 5).attr('class', 'lbl-strong').text(name);
      for (const p of list) { const w = x(acc + p.v) - x(acc); svg.append('rect').attr('x', x(acc)).attr('y', y0).attr('width', Math.max(1, w - 1)).attr('height', 20).attr('rx', 2).attr('fill', p.color);
        if (w > 44) svg.append('text').attr('x', x(acc) + w / 2).attr('y', y0 + 14).attr('text-anchor', 'middle').attr('class', 'tf-in').text((p.v * 100).toFixed(1)); acc += p.v; }
      svg.append('text').attr('x', x(acc) + 6).attr('y', y0 + 14).attr('class', 'lbl-strong').text((acc * 100).toFixed(2) + ' ¢');
    });
  }
  function timeline(T) {
    const box = $('tf-chart'); box.replaceChildren(); box.classList.remove('dash-skeleton');
    const adj = perSold ? salesRatio(T) || 1 : 1;
    const rows = rowsFor(period).map((r) => ({ t: r.t, fca: r.fca / (r.gen * 1000) / adj, ppca: r.ppca / (r.gen * 1000) / adj }));
    const W = box.clientWidth || 800, Hh = 280;
    const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('width', '100%').attr('height', Hh);
    if (rows.length < 2) { svg.append('text').attr('x', W / 2).attr('y', Hh / 2).attr('text-anchor', 'middle').attr('class', 'empty').text('The hourly chart fills in as readings are saved.'); return; }
    const fixed = showFixed ? d3.sum(parts(T, 0, 0, kwh).filter((p) => !p.variable), (p) => p.v) : 0;
    const appr = (showFixed ? fixed : 0) + T.approved.fca_usd_kwh + T.approved.ppca_usd_kwh;
    const y = d3.scaleLinear([0, Math.max(appr, d3.max(rows, (r) => fixed + r.fca + r.ppca)) * 100 * 1.1], [Hh - 26, 12]).nice();
    const ml = G.measure(svg, y.ticks(5).map((v) => v + ' ¢')) + 12, x = d3.scaleTime([rows[0].t, rows[rows.length - 1].t], [ml, W - 10]);
    svg.append('g').selectAll('line').data(y.ticks(5)).join('line').attr('x1', ml).attr('x2', W - 10).attr('y1', y).attr('y2', y).attr('stroke', 'var(--cds-chart-grid)');
    svg.append('g').selectAll('text').data(y.ticks(5)).join('text').attr('x', ml - 6).attr('y', y).attr('dy', '0.35em').attr('text-anchor', 'end').text((v) => v + ' ¢');
    const spanD = (rows[rows.length - 1].t - rows[0].t) / 864e5;
    if (spanD > 2) { const ticks = []; for (let t = Math.ceil((+rows[0].t - 4 * H) / 864e5) * 864e5 + 4 * H; t <= +rows[rows.length - 1].t; t += 864e5) ticks.push(new Date(t));
      const every = Math.ceil(ticks.length / Math.max(3, Math.floor((W - ml) / 70)));
      svg.append('g').selectAll('line').data(ticks).join('line').attr('x1', x).attr('x2', x).attr('y1', 12).attr('y2', Hh - 26).attr('stroke', 'var(--cds-chart-grid)');
      svg.append('g').selectAll('text').data(ticks.filter((t, i) => i % every === 0)).join('text').attr('x', x).attr('y', Hh - 6).attr('text-anchor', 'middle').text((t) => dFmt(new Date(+t + 12 * H)));
    } else svg.append('g').selectAll('text').data(x.ticks(Math.max(3, Math.floor((W - ml) / 80)))).join('text').attr('x', x).attr('y', Hh - 6).attr('text-anchor', 'middle').text((t) => (prHour(t) === 0 ? dFmt(t) : hFmt(t)));
    const seq = []; rows.forEach((r, i) => { if (i && r.t - rows[i - 1].t > 2.5 * H) seq.push({ t: new Date(+rows[i - 1].t + H), _gap: true }); seq.push(r); });
    const layers = [...(showFixed ? [['fixed', 'Fixed charges (not generation)', 'var(--tf-fixed)', () => fixed]] : []), ['ppca', 'Purchased power (PPCA)', 'var(--tf-ppca)', (r) => r.ppca], ['fca', 'Fuel (FCA)', 'var(--tf-fca)', (r) => r.fca]];
    const stack = d3.stack().keys(layers.map((l) => l[0])).value((r, key) => (r._gap ? 0 : layers.find((l) => l[0] === key)[3](r) * 100))(seq);
    svg.append('g').selectAll('path').data(stack).join('path').attr('fill', (s) => layers.find((l) => l[0] === s.key)[2]).attr('opacity', 0.92)
      .attr('d', d3.area().defined((p) => !p.data._gap).x((p) => x(p.data.t)).y0((p) => y(p[0])).y1((p) => y(p[1])).curve(d3.curveStepAfter));
    svg.append('line').attr('x1', ml).attr('x2', W - 10).attr('y1', y(appr * 100)).attr('y2', y(appr * 100)).attr('stroke', 'var(--ink)').attr('stroke-dasharray', '6 4').attr('stroke-width', 1.6);
    svg.append('text').attr('x', W - 12).attr('y', y(appr * 100) - 5).attr('text-anchor', 'end').attr('class', 'lbl-strong').text('Approved on the bill: ' + (appr * 100).toFixed(2) + ' ¢');
    const lg = $('tf-chart-legend'); lg.replaceChildren();
    for (const [, n, c] of layers.slice().reverse()) { const s = el('span'); const sw = el('span', 'gx-sw'); sw.style.background = c; s.append(sw, n); lg.append(s); }
    const tip = G.tipFor(box.closest('.gx-card')), rule = svg.append('line').attr('y1', 12).attr('y2', Hh - 26).attr('stroke', 'var(--cds-chart-reference)').attr('opacity', 0);
    svg.append('rect').attr('x', ml).attr('y', 0).attr('width', W - 10 - ml).attr('height', Hh - 26).attr('fill', 'transparent')
      .on('mousemove', (ev) => { const t = x.invert(d3.pointer(ev)[0]); const r = rows[d3.bisector((q) => q.t).center(rows, t)]; rule.attr('x1', x(r.t)).attr('x2', x(r.t)).attr('opacity', 1);
        tip.show(ev, tFmt(r.t), [['var(--tf-fca)', 'Fuel (FCA)', cents(r.fca)], ['var(--tf-ppca)', 'Purchased power (PPCA)', cents(r.ppca)], ...(showFixed ? [['var(--tf-fixed)', 'Fixed charges', cents(fixed)]] : []), [null, 'Total', cents(fixed + r.fca + r.ppca)]]); })
      .on('mouseleave', () => { rule.attr('opacity', 0); tip.hide(); });
    const hi = rows.reduce((a, r) => (r.fca + r.ppca > a.fca + a.ppca ? r : a), rows[0]), lo = rows.reduce((a, r) => (r.fca + r.ppca < a.fca + a.ppca ? r : a), rows[0]);
    $('tf-chart-sum').textContent = 'In this period, generation was most expensive at ' + tFmt(hi.t) + ' (' + cents(hi.fca + hi.ppca) + ' per kWh) and cheapest at ' + tFmt(lo.t) + ' (' + cents(lo.fca + lo.ppca) + '). Power usually costs more in the evening, when demand peaks and the diesel plants are needed.';
  }
  function table(P, A) {
    const tb = $('tf-table').tBodies[0]; tb.replaceChildren();
    const list = P.filter((p) => showFixed || p.variable), tot = d3.sum(list, (p) => p.v), totA = d3.sum(A.filter((p) => showFixed || p.variable), (p) => p.v);
    list.forEach((p) => { const a = A.find((q) => q.k === p.k), tr = el('tr');
      const n = el('td'); const sw = el('span', 'gx-sw'); sw.style.background = p.color; n.append(sw, el('span', 'pt-name', p.label), el('span', 'pt-sub', p.what)); 
      tr.append(n, el('td', null, p.variable ? 'Estimated live' : 'Fixed'), el('td', 'num', cents(p.v)), el('td', 'num', cents(a.v)), el('td', 'num', usd(p.v * kwh)), el('td', 'num', G.pct((p.v / tot) * 100))); tb.append(tr); });
    const tr = el('tr', 'pt-total'); tr.append(el('td', null, 'Total'), el('td', null, ''), el('td', 'num', cents(tot)), el('td', 'num', cents(totA)), el('td', 'num', usd(tot * kwh)), el('td', 'num', '100%')); tb.append(tr);
    $('tf-th-usd').textContent = 'At ' + G.f0(kwh) + ' kWh';
  }
  function calc(T, E) {
    const P = parts(T, E.fca, E.ppca, kwh), A = parts(T, T.approved.fca_usd_kwh, T.approved.ppca_usd_kwh, kwh);
    const est = d3.sum(P, (p) => p.v) * kwh, app = d3.sum(A, (p) => p.v) * kwh;
    const inp = $('tf-kwh'), rng = $('tf-kwh-range'); if (document.activeElement !== inp) inp.value = kwh; rng.value = Math.min(2000, kwh);
    const o = $('tf-calc-out'); o.replaceChildren();
    const c = (l, v, n) => { const d = el('div', 'tf-co'); d.append(el('div', 'gx-kpi-l', l), el('div', 'tf-co-v', v), el('div', 'gx-kpi-n', n)); o.append(d); };
    c('Bill at the approved rate', usd(app), cents(app / kwh) + ' per kWh on average');
    c('Bill if the rate followed the cost of ' + PERIOD_LABEL[period], usd(est), cents(est / kwh) + ' per kWh on average');
    c('Of which fixed monthly charge', usd(T.fixed.base_fixed_usd_month), 'the less you use, the more it weighs per kWh');
  }
  function docs() {
    const T = G.rows('tariff')[0], box = $('tf-docs'); if (!T || !box || box.childElementCount) return;
    for (const [group, list] of d3.groups(T.documents, (d) => d.group)) {
      box.append(el('h4', 'sub-h', group)); const ul = el('ul', 'tf-doclist');
      for (const d of list) { const li = el('li'); const a = el('a', null, d.title); a.href = d.url; a.target = '_blank'; a.rel = 'noopener'; li.append(a); ul.append(li); }
      box.append(ul);
    }
    $('tf-eff').textContent = 'Fixed charges in effect: ' + T.period_label + ' (Energy Bureau resolution of September 30, 2026). Next change: ' + T.next_change + '. ' + T.fixed.base_note;
  }
  document.addEventListener('click', (e) => { const b = e.target.closest('#tf-period button'); if (b) { period = b.dataset.v; render(); } });
  document.addEventListener('change', (e) => { if (e.target.id === 'tf-fixed') { showFixed = e.target.checked; render(); } if (e.target.id === 'tf-sold') { perSold = e.target.checked; render(); } });
  document.addEventListener('input', (e) => { if (e.target.id === 'tf-kwh' || e.target.id === 'tf-kwh-range') { const v = Math.max(50, Math.min(5000, Number(e.target.value) || 0)); if (v) { kwh = v; render(); } } });
  dash.onData(() => { try { render(); docs(); } catch (e) { console.error('tariff', e); } });
})();
