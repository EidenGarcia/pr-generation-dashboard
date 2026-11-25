/* Reserve adequacy (N-1 / N-1-1) and frequency excursion statistics. */
(() => {
  const G = window.GX;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const $ = (id) => document.getElementById(id);
  const pr = (o) => { const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Puerto_Rico', ...o }); return (d) => f.format(d); };
  const dFmt = (k) => pr({ month: 'short', day: 'numeric' })(new Date(k + 'T12:00:00-04:00'));
  const hLabel = (h) => (h === 0 ? '12 AM' : h < 12 ? h + ' AM' : h === 12 ? '12 PM' : h - 12 + ' PM');
  const seg = (id, val) => document.querySelectorAll('#' + id + ' button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === val)));
  const kpi = (box, label, value, note, cls) => { const d = el('div', 'gx-kpi' + (cls ? ' ' + cls : '')); d.append(el('div', 'gx-kpi-l', label), el('div', 'gx-kpi-v', value), el('div', 'gx-kpi-n', note)); box.append(d); };
  const big = (box, value, unit, text, cls) => { const d = el('div', 'adq-big' + (cls ? ' ' + cls : '')); const v = el('div', 'adq-big-v'); v.append(value); if (unit) v.append(el('span', 'adq-big-u', unit)); d.append(v, el('div', 'adq-big-t', text)); box.append(d); };

  /* ---------- Reserve adequacy ---------- */
  let res = 'spin', rule = 'n1', aPeriod = 'all';
  function adequacy() {
    const card = $('adq-card'); if (!card) return;
    seg('adq-res', res); seg('adq-rule', rule); seg('adq-period', aPeriod);
    let D = G.rows('daily_summary').filter((d) => d.reserve_readings > 0).sort((a, b) => (a.day < b.day ? -1 : 1));
    if (aPeriod !== 'all') D = D.slice(-Number(aPeriod));
    const shortK = (res === 'spin' ? 'spin' : 'oper') + '_short_' + rule, reqK = 'req_' + rule + '_avg_mw', avgK = res === 'spin' ? 'spin_avg_mw' : 'oper_avg_mw', minK = (res === 'spin' ? 'spin' : 'oper') + '_margin_min_' + rule;
    const resName = res === 'spin' ? 'spinning reserve' : 'operating reserve', ruleName = rule === 'n1' ? 'the largest unit online (N-1)' : 'the two largest units online (N-1-1)';
    const top = $('adq-big'), kp = $('adq-kpis'); top.replaceChildren(); kp.replaceChildren();
    if (!D.length) { top.append(el('p', 'gx-note', 'Reserve records appear after the updater’s next run.')); return; }
    const daysShort = D.filter((d) => d[shortK] > 0).length, readings = d3.sum(D, (d) => d.reserve_readings), rShort = d3.sum(D, (d) => d[shortK] || 0);
    const reqAvg = d3.sum(D, (d) => d[reqK] * d.reserve_readings) / readings, resAvg = d3.sum(D, (d) => (d[avgK] || 0) * d.reserve_readings) / readings;
    big(top, G.pct((daysShort / D.length) * 100).replace('%', ''), '%', 'days with ' + resName + ' below the required level at least once (' + daysShort + ' of ' + D.length + ' days)', daysShort / D.length > 0.5 ? 'bad' : '');
    big(top, G.f0(Math.round(reqAvg)), 'MW', 'average required reserve: ' + ruleName);
    big(top, G.pct((rShort / readings) * 100).replace('%', ''), '%', 'of readings below the requirement (' + G.f0(rShort) + ' of ' + G.f0(readings) + ')', rShort / readings > 0.25 ? 'bad' : '');
    big(top, G.f0(Math.round(resAvg)), 'MW', 'average ' + resName + ' actually held');
    // right now, from the live units
    const k = G.rows('live_kpis')[0] || {}, us = G.rows('live_units').filter((u) => u.status === 'Generating').map((u) => Number(u.mw) || 0).sort((a, b) => b - a);
    if (us.length) {
      const reqNow = rule === 'n1' ? us[0] : us[0] + (us[1] || 0), m = G.rows('live_metrics')[0] || {};
      const have = res === 'spin' ? (k.spinning_reserve_mw ?? m.spinning_reserve_mw) : (k.operating_reserve_mw ?? m.operating_reserve_mw);
      if (have != null) kpi(kp, 'Right now: ' + resName, G.f0(Math.round(have)) + ' MW', 'required ' + G.f0(Math.round(reqNow)) + ' MW (' + (rule === 'n1' ? 'largest unit ' + G.f0(Math.round(us[0])) + ' MW' : G.f0(Math.round(us[0])) + ' + ' + G.f0(Math.round(us[1] || 0)) + ' MW') + ')', have < reqNow ? 'bad' : '');
    }
    const worst = D.filter((d) => d[minK] != null).reduce((a, d) => (!a || d[minK] < a[minK] ? d : a), null);
    if (worst) kpi(kp, 'Largest shortfall', (worst[minK] < 0 ? '−' : '+') + G.f0(Math.abs(worst[minK])) + ' MW', 'on ' + dFmt(worst.day) + ' (reserve minus requirement)', worst[minK] < 0 ? 'bad' : '');
    const est = d3.sum(D, (d) => d.reserve_estimated || 0);
    // daily chart: % of readings short (bars, right axis), average reserve and requirement (lines, left axis)
    const box = $('adq-chart'); box.replaceChildren(); box.classList.remove('dash-skeleton');
    const W = box.clientWidth || 900, Hh = 260, svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('width', '100%').attr('height', Hh);
    const y = d3.scaleLinear([0, d3.max(D, (d) => Math.max(d[reqK], d[avgK] || 0)) * 1.15], [Hh - 26, 12]).nice(), y2 = d3.scaleLinear([0, 100], [Hh - 26, 12]);
    const ml = G.measure(svg, y.ticks(5).map(G.f0)) + 14, mr = 40, x = d3.scaleBand(D.map((d) => d.day), [ml, W - mr]).padding(0.25), cx = (d) => x(d.day) + x.bandwidth() / 2;
    svg.append('g').selectAll('line').data(y.ticks(5)).join('line').attr('x1', ml).attr('x2', W - mr).attr('y1', y).attr('y2', y).attr('stroke', 'var(--cds-chart-grid)');
    svg.append('g').selectAll('text').data(y.ticks(5)).join('text').attr('x', ml - 6).attr('y', y).attr('dy', '0.35em').attr('text-anchor', 'end').text(G.f0);
    svg.append('text').attr('x', ml - 6).attr('y', 6).attr('text-anchor', 'end').text('MW');
    svg.append('g').selectAll('text').data([0, 50, 100]).join('text').attr('x', W - mr + 6).attr('y', y2).attr('dy', '0.35em').attr('fill', 'var(--alert)').text((v) => v + '%');
    const every = Math.ceil(D.length / Math.max(3, Math.floor((W - ml - mr) / 60)));
    svg.append('g').selectAll('text').data(D.filter((d, i) => i % every === 0)).join('text').attr('x', cx).attr('y', Hh - 6).attr('text-anchor', 'middle').text((d) => dFmt(d.day));
    svg.append('g').selectAll('rect').data(D).join('rect').attr('x', (d) => x(d.day)).attr('width', x.bandwidth()).attr('y', (d) => y2((100 * (d[shortK] || 0)) / d.reserve_readings)).attr('height', (d) => Math.max(0, y2(0) - y2((100 * (d[shortK] || 0)) / d.reserve_readings))).attr('rx', 2).attr('fill', 'var(--alert)').attr('opacity', 0.28);
    svg.append('path').datum(D).attr('fill', 'none').attr('stroke', 'var(--teal)').attr('stroke-width', 2.2).attr('d', d3.line().x(cx).y((d) => y(d[avgK] || 0)).curve(d3.curveMonotoneX));
    svg.append('path').datum(D).attr('fill', 'none').attr('stroke', 'var(--ink)').attr('stroke-width', 1.8).attr('stroke-dasharray', '6 4').attr('d', d3.line().x(cx).y((d) => y(d[reqK])).curve(d3.curveMonotoneX));
    const tip = G.tipFor(card);
    svg.append('g').selectAll('rect').data(D).join('rect').attr('x', (d) => x(d.day) - 2).attr('width', x.bandwidth() + 4).attr('y', 0).attr('height', Hh - 26).attr('fill', 'transparent')
      .on('mousemove', (ev, d) => tip.show(ev, dFmt(d.day) + (d.status === 'In progress' ? ' (so far)' : ''), [['var(--teal)', 'Average ' + resName, G.f0(d[avgK]) + ' MW'], ['var(--ink)', 'Average requirement', G.f0(d[reqK]) + ' MW'], ['var(--alert)', 'Readings below', (d[shortK] || 0) + ' of ' + d.reserve_readings], [null, 'Lowest margin', d[minK] == null ? '—' : (d[minK] < 0 ? '−' : '+') + G.f0(Math.abs(d[minK])) + ' MW']]))
      .on('mouseleave', () => tip.hide());
    const lg = $('adq-legend'); lg.replaceChildren();
    for (const [n, c, dash] of [['Average ' + resName, 'var(--teal)'], ['Average requirement', 'var(--ink)', 1], ['Share of readings below (right axis)', 'var(--alert)']]) { const s = el('span'); const sw = el('span', 'gx-sw'); sw.style.background = c; if (dash) { sw.style.height = '3px'; } s.append(sw, n); lg.append(s); }
    $('adq-note').textContent = 'Requirement: ' + ruleName + '. If that much generation tripped at once, the reserve would have to replace it. A day counts as short if any reading had ' + resName + ' below the requirement. Readings are every 15 minutes. ' +
      (est ? G.f0(est) + ' of these ' + G.f0(readings) + ' readings were saved before unit sizes were recorded, so their largest unit is estimated from each plant’s output and its unit sizes (this tends to understate the largest unit slightly). Readings from now on use the actual largest units. ' : '') +
      'These are this dashboard’s calculations from public data, not LUMA’s official reserve criteria.';
  }

  /* ---------- Frequency statistics ---------- */
  let fPeriod = 'all';
  function freqStats() {
    const card = $('fqs-card'); if (!card) return;
    seg('fqs-period', fPeriod);
    const S = G.rows('frequency_stats')[0], kp = $('fqs-kpis'); kp.replaceChildren();
    if (!S) { kp.append(el('p', 'gx-note', 'Frequency statistics appear after the updater’s next run.')); return; }
    let D = S.days.slice(); if (fPeriod !== 'all') D = D.slice(-Number(fPeriod));
    const tot = d3.sum(D, (d) => d.count), perDay = D.length ? tot / D.length : 0;
    const rate = (n, h) => (h > 0 ? (n / h) * 10 : null), fr = (v) => (v == null ? '—' : G.f1(v));
    const pk = S.peak, op = S.offpeak, pkShareTime = pk.exposure_h / (pk.exposure_h + op.exposure_h || 1), pkShareEv = pk.count / (pk.count + op.count || 1);
    const low = S.low_reserve, lowAll = S.reserve_bins.reduce((a, b) => ({ c: a.c + b.count, h: a.h + b.exposure_h }), { c: 0, h: 0 });
    kpi(kp, 'Excursions', G.f0(tot), D.length + ' days, ' + G.f1(perDay) + ' per day on average');
    kpi(kp, 'Days with at least one', G.pct((D.filter((d) => d.count > 0).length / (D.length || 1)) * 100), D.filter((d) => d.count > 0).length + ' of ' + D.length + ' days');
    kpi(kp, 'At the evening peak (' + hLabel(S.peak_hours[0]) + '–' + hLabel(S.peak_hours[1]) + ')', G.pct(pkShareEv * 100), 'of excursions, in ' + G.pct(pkShareTime * 100) + ' of the time', pkShareEv > pkShareTime * 1.5 ? 'bad' : '');
    kpi(kp, 'Rate at the peak vs. other hours', fr(rate(pk.count, pk.exposure_h)) + ' vs ' + fr(rate(op.count, op.exposure_h)), 'excursions per 10 hours');
    kpi(kp, 'With operating reserve under ' + S.low_reserve_mw + ' MW', G.f0(low.count), fr(rate(low.count, low.exposure_h)) + ' per 10 hours, vs ' + fr(rate(lowAll.c - low.count, lowAll.h - low.exposure_h)) + ' otherwise (' + G.f1(low.exposure_h) + ' h spent there)', rate(low.count, low.exposure_h) > 2 * (rate(lowAll.c - low.count, lowAll.h - low.exposure_h) || 0) ? 'bad' : '');
    dayChart(D); hourChart(S); reserveChart(S);
    $('fqs-note').textContent = 'An excursion is a period when the 5-minute frequency left the Normal range (59.8–60.2 Hz), counted once from start to end. Rates divide the number of excursions by the hours of readings spent in each condition, so busy and quiet periods compare fairly. Operating reserve is PREPA’s figure at the nearest 15-minute reading. Peak hours and the low-reserve threshold are set in data/settings.json.';
  }
  const LV = [['watch', 'Watch', 'var(--hl-watch, #dc6803)'], ['alert', 'Alert', 'var(--hl-alert, #e04f16)'], ['critical', 'Critical', 'var(--hl-critical, #d92d20)']];
  function frame(box, Hh) { box.replaceChildren(); box.classList.remove('dash-skeleton'); const W = box.clientWidth || 600; return { W, Hh, svg: d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('width', '100%').attr('height', Hh) }; }
  function yAxis(svg, y, ml, W, mr, fmt, unit) {
    svg.append('g').selectAll('line').data(y.ticks(4)).join('line').attr('x1', ml).attr('x2', W - mr).attr('y1', y).attr('y2', y).attr('stroke', 'var(--cds-chart-grid)');
    svg.append('g').selectAll('text').data(y.ticks(4)).join('text').attr('x', ml - 6).attr('y', y).attr('dy', '0.35em').attr('text-anchor', 'end').text(fmt);
    if (unit) svg.append('text').attr('x', ml - 6).attr('y', 6).attr('text-anchor', 'end').text(unit);
  }
  function dayChart(D) {
    const box = $('fqs-days'); if (!box) return; const { W, Hh, svg } = frame(box, 240);
    if (!D.length) return;
    const y = d3.scaleLinear([0, Math.max(3, d3.max(D, (d) => d.count)) * 1.15], [Hh - 24, 10]).nice(), ml = 34, mr = 8;
    const x = d3.scaleBand(D.map((d) => d.day), [ml, W - mr]).padding(0.2), cx = (d) => x(d.day) + x.bandwidth() / 2;
    yAxis(svg, y, ml, W, mr, G.f0);
    const every = Math.ceil(D.length / Math.max(3, Math.floor((W - ml) / 60)));
    svg.append('g').selectAll('text').data(D.filter((d, i) => i % every === 0)).join('text').attr('x', cx).attr('y', Hh - 6).attr('text-anchor', 'middle').text((d) => dFmt(d.day));
    for (const d of D) { let acc = 0; for (const [k, , c] of LV) { const v = d[k] || 0; if (!v) continue; svg.append('rect').attr('x', x(d.day)).attr('width', x.bandwidth()).attr('y', y(acc + v)).attr('height', y(acc) - y(acc + v)).attr('fill', c).attr('opacity', 0.85); acc += v; } }
    // 7-day moving average and a straight trend line
    const ma = D.map((d, i) => { const w = D.slice(Math.max(0, i - 6), i + 1); return { day: d.day, v: d3.mean(w, (q) => q.count) }; });
    svg.append('path').datum(ma).attr('fill', 'none').attr('stroke', 'var(--ink)').attr('stroke-width', 2).attr('d', d3.line().x(cx).y((d) => y(d.v)).curve(d3.curveMonotoneX));
    const n = D.length; let slope = null;
    if (n >= 5) { const mx = (n - 1) / 2, my = d3.mean(D, (d) => d.count); slope = d3.sum(D, (d, i) => (i - mx) * (d.count - my)) / d3.sum(D, (d, i) => (i - mx) ** 2); const b0 = my - slope * mx;
      svg.append('line').attr('x1', cx(D[0])).attr('x2', cx(D[n - 1])).attr('y1', y(Math.max(0, b0))).attr('y2', y(Math.max(0, b0 + slope * (n - 1)))).attr('stroke', 'var(--accent)').attr('stroke-width', 1.6).attr('stroke-dasharray', '6 4'); }
    const tip = G.tipFor(box.closest('.gx-card'));
    svg.append('g').selectAll('rect.hit').data(D).join('rect').attr('x', (d) => x(d.day)).attr('width', x.bandwidth()).attr('y', 0).attr('height', Hh - 24).attr('fill', 'transparent')
      .on('mousemove', (ev, d) => tip.show(ev, dFmt(d.day), [...LV.map(([k, n2, c]) => [c, n2, String(d[k] || 0)]), [null, 'Low / high frequency', (d.low_freq || 0) + ' / ' + (d.high_freq || 0)], [null, 'About', (d.minutes || 0) + ' minutes outside Normal']])).on('mouseleave', () => tip.hide());
    const lg = $('fqs-days-legend'); lg.replaceChildren();
    for (const [, n2, c] of LV) { const s = el('span'); const sw = el('span', 'gx-sw'); sw.style.background = c; s.append(sw, n2); lg.append(s); }
    for (const [n2, c] of [['7-day average', 'var(--ink)'], ['Trend', 'var(--accent)']]) { const s = el('span'); const sw = el('span', 'gx-sw'); sw.style.background = c; sw.style.height = '3px'; s.append(sw, n2); lg.append(s); }
    $('fqs-days-sum').textContent = slope == null ? '' : 'Trend: ' + (Math.abs(slope) < 0.02 ? 'about flat' : (slope > 0 ? 'rising' : 'falling') + ' by about ' + G.f1(Math.abs(slope * 7)) + ' excursions per day each week') + '.';
  }
  function hourChart(S) {
    const box = $('fqs-hours'); if (!box) return; const { W, Hh, svg } = frame(box, 240);
    const B = S.by_hour, rate = (b) => (b.exposure_h > 0 ? (b.count / b.exposure_h) * 10 : 0);
    const y = d3.scaleLinear([0, Math.max(0.5, d3.max(B, rate)) * 1.15], [Hh - 24, 10]).nice(), ml = 38, mr = 8, x = d3.scaleBand(d3.range(24), [ml, W - mr]).padding(0.15);
    svg.append('rect').attr('x', x(S.peak_hours[0])).attr('width', x(S.peak_hours[1] - 1) + x.bandwidth() - x(S.peak_hours[0])).attr('y', 10).attr('height', Hh - 34).attr('fill', 'var(--alert)').attr('opacity', 0.07);
    svg.append('text').attr('x', x(S.peak_hours[0]) + 4).attr('y', 22).attr('fill', 'var(--alert)').attr('class', 'lbl-strong').text('Evening peak');
    yAxis(svg, y, ml, W, mr, (v) => G.f1(v));
    svg.append('g').selectAll('text').data([0, 3, 6, 9, 12, 15, 18, 21]).join('text').attr('x', (h) => x(h) + x.bandwidth() / 2).attr('y', Hh - 6).attr('text-anchor', 'middle').text(hLabel);
    const inPk = (h) => h >= S.peak_hours[0] && h < S.peak_hours[1], tip = G.tipFor(box.closest('.gx-card'));
    svg.append('g').selectAll('rect.b').data(B).join('rect').attr('x', (b) => x(b.h)).attr('width', x.bandwidth()).attr('y', (b) => y(rate(b))).attr('height', (b) => y(0) - y(rate(b))).attr('rx', 2).attr('fill', (b) => (inPk(b.h) ? 'var(--alert)' : 'var(--accent)')).attr('opacity', 0.85)
      .on('mousemove', (ev, b) => tip.show(ev, hLabel(b.h) + ' to ' + hLabel((b.h + 1) % 24), [[null, 'Excursions', String(b.count)], [null, 'Hours of readings', G.f1(b.exposure_h)], [null, 'Per 10 hours', G.f1(rate(b))]])).on('mouseleave', () => tip.hide());
  }
  function reserveChart(S) {
    const box = $('fqs-reserve'); if (!box) return; const { W, Hh, svg } = frame(box, 240);
    const B = S.reserve_bins, rate = (b) => (b.exposure_h > 0 ? (b.count / b.exposure_h) * 10 : 0);
    const y = d3.scaleLinear([0, Math.max(0.5, d3.max(B, rate)) * 1.2], [Hh - 24, 10]).nice(), ml = 38, mr = 8, x = d3.scaleBand(B.map((b) => b.label), [ml, W - mr]).padding(0.3);
    yAxis(svg, y, ml, W, mr, (v) => G.f1(v));
    svg.append('g').selectAll('text').data(B).join('text').attr('x', (b) => x(b.label) + x.bandwidth() / 2).attr('y', Hh - 6).attr('text-anchor', 'middle').text((b) => b.label);
    const tip = G.tipFor(box.closest('.gx-card'));
    svg.append('g').selectAll('rect').data(B).join('rect').attr('x', (b) => x(b.label)).attr('width', x.bandwidth()).attr('y', (b) => y(rate(b))).attr('height', (b) => y(0) - y(rate(b))).attr('rx', 3)
      .attr('fill', (b) => (b.hi != null && b.hi <= S.low_reserve_mw ? 'var(--alert)' : 'var(--teal)')).attr('opacity', 0.85)
      .on('mousemove', (ev, b) => tip.show(ev, 'Operating reserve ' + b.label, [[null, 'Excursions', String(b.count)], [null, 'Hours spent at this reserve', G.f1(b.exposure_h)], [null, 'Per 10 hours', G.f1(rate(b))]])).on('mouseleave', () => tip.hide());
    svg.append('g').selectAll('text.v').data(B).join('text').attr('x', (b) => x(b.label) + x.bandwidth() / 2).attr('y', (b) => y(rate(b)) - 5).attr('text-anchor', 'middle').attr('class', 'lbl-strong').text((b) => b.count + ' in ' + G.f0(b.exposure_h) + ' h');
  }
  document.addEventListener('click', (e) => {
    for (const [id, set] of [['adq-res', (v) => { res = v; }], ['adq-rule', (v) => { rule = v; }], ['adq-period', (v) => { aPeriod = v; }]]) { const b = e.target.closest('#' + id + ' button'); if (b) { set(b.dataset.v); adequacy(); } }
    const f = e.target.closest('#fqs-period button'); if (f) { fPeriod = f.dataset.v; freqStats(); }
  });
  dash.onData(() => { for (const fn of [adequacy, freqStats]) { try { fn(); } catch (err) { console.error('adequacy', err); } } });
})();
