/* Live operations page */
(() => {
  const G = window.GX;
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const H = 3600000;
  // All times are shown in Puerto Rico time (UTC-4, no daylight saving), whatever the viewer's time zone.
  const pr = (o) => { const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Puerto_Rico', ...o }); return (d) => f.format(d); };
  const tFmt = pr({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const hFmt = pr({ hour: 'numeric' });
  const dFmt = pr({ month: 'short', day: 'numeric' });
  const dhFmt = pr({ month: 'short', day: 'numeric', hour: 'numeric' });
  const prHour = (d) => Number(pr({ hour: 'numeric', hourCycle: 'h23' })(d)) % 24;
  const S = (d) => new Date(+d - 4 * H); // Puerto Rico clock expressed as UTC fields
  const ago = (d) => { const m = Math.round((Date.now() - d.getTime()) / 60000); if (m < 1) return 'just now'; if (m < 90) return m + ' min ago'; const h = Math.round(m / 60); if (h < 48) return h + ' h ago'; return Math.round(h / 24) + ' days ago'; };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  let boardOp = 'Genera PR';
  const LV = { Normal: 'var(--lv-normal)', Watch: 'var(--lv-watch)', Alert: 'var(--lv-alert)', Critical: 'var(--lv-critical)' };
  const HLV = { Normal: 'var(--h-gen)', Watch: 'var(--hl-watch)', Alert: 'var(--hl-alert)', Critical: 'var(--hl-critical)' };
  const RANK = { Normal: 0, Watch: 1, Alert: 2, Critical: 3 };
  const limits = () => G.rows('freq_limits')[0] || null;
  const level = (f) => { const L = limits(); if (!L || f == null) return null; for (const b of L.bands) if (b.low != null && b.high != null && f >= b.low && f <= b.high) return b.level; return 'Critical'; };
  const dur = (s) => (s == null ? '—' : s < 90 ? Math.round(s) + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(1) + ' h');
  const vis = { gen: true, freq: true, cap: true, demand: true, fload: true, fcap: true, peak: true };

  /* ---------- Portal health status (shared by pill and panel) ---------- */
  function portalState() {
    const hs = G.rows('feed_health').filter((h) => h.feed === 'dataSource').sort((a, b) => (a.at < b.at ? -1 : 1));
    const last = hs[hs.length - 1];
    if (!last) return { cls: '', text: 'Connecting…', detail: 'Waiting for the first read of PREPA’s feed.' };
    if (!last.ok) return { cls: 'down', text: 'Portal not responding', detail: 'Last check failed: ' + (last.error || 'no answer'), last };
    if (last.feed_age_min != null && last.feed_age_min > 120) return { cls: 'stale', text: 'Portal up, data not updating', detail: 'PREPA’s timestamp is ' + Math.round(last.feed_age_min / 60) + ' h behind the check.', last };
    return { cls: 'ok', text: 'Portal online', detail: 'Answered the last check and data is current.', last };
  }

  function topbar() {
    const ps = portalState();
    const pill = document.getElementById('portal-pill');
    pill.className = 'portal ' + ps.cls; pill.title = ps.detail;
    document.getElementById('portal-text').textContent = ps.text;
    const k = G.rows('live_kpis')[0], s = G.rows('status')[0];
    const line = document.getElementById('feed-line');
    if (k && k.snapshot) {
      const snap = new Date(k.snapshot);
      line.textContent = 'PREPA data as of ' + tFmt(snap) + ' (' + ago(snap) + '). ' + (s && s.last_run && s.runner === 'GitHub Actions' ? 'Hourly updater last ran ' + ago(new Date(s.last_run)) + '.' : 'Hourly updater has not run yet.');
    } else if (G.st('live_units').status === 'error') line.textContent = 'Could not load data/live_units.json.';
  }

  /* ---------- Alert banner ---------- */
  function alertBanner() {
    const box = document.getElementById('alert-banner'), body = document.getElementById('alert-body');
    const s = G.rows('alerts_summary')[0], al = G.rows('outage_alerts'), k = G.rows('live_kpis')[0];
    if (!s) return;
    body.classList.remove('dash-skeleton'); body.replaceChildren();
    const snap = k && k.snapshot ? new Date(k.snapshot) : null;
    const ageH = snap ? (Date.now() - snap.getTime()) / H : null;
    document.getElementById('alert-age').textContent = ageH != null && ageH > 2 ? 'Data is ' + (ageH < 48 ? Math.round(ageH) + ' hours' : Math.floor(ageH / 24) + ' days') + ' old' : '';
    const line = (t) => { const p = el('div', null, t); body.append(p); return p; };
    const gr = G.rows('live_graph').filter((r) => num(r.frequency_hz) != null);
    const fNow = gr.length ? num(gr[gr.length - 1].frequency_hz) : null, flNow = level(fNow);
    const recent = G.rows('frequency_events').filter((e) => RANK[e.worst_level] >= 2 && gr.length && new Date(gr[gr.length - 1].time) - new Date(e.start) <= 864e5);
    let freqBad = false;
    if (fNow != null && flNow && flNow !== 'Normal') { freqBad = true; const p = line('Frequency is ' + fNow.toFixed(2) + ' Hz: '); p.append(el('span', 'chip bad', flNow + (fNow < 60 ? ' (low)' : ' (high)'))); }
    if (recent.length) { freqBad = true; const p = line(recent.length + ' frequency excursion(s) at Alert level or worse in the last 24 hours: ');
      for (const e of recent.slice(-4)) p.append(el('span', 'chip bad', tFmt(new Date(e.start)) + ', ' + e.extreme_hz.toFixed(2) + ' Hz, ' + e.worst_level + (e.allowance_status === 'Exceeded' ? ', time limit exceeded' : ''))); }
    box.classList.toggle('calm', s.baseload_down === 0 && s.went_offline_latest === 0 && !freqBad);
    if (s.events_logged > 0) line((s.went_offline_latest ? s.went_offline_latest + ' unit(s) went offline' : 'No unit went offline') + (s.back_online_latest ? ' and ' + s.back_online_latest + ' came back' : '') + ' at the latest check (' + tFmt(new Date(s.latest_change)) + ').');
    else line('Monitoring has started; units that stop or restart will be listed here after the next hourly check.');
    const base = al.filter((a) => a.rank === 1);
    const p = line(base.length ? base.length + ' baseload unit(s) down that ran last month: ' : 'No baseload unit that ran last month is down. ');
    for (const a of base) p.append(el('span', 'chip bad', a.plant + ', ' + a.unit));
    if (s.peakers_idle) p.append(el('span', 'chip', s.peakers_idle + ' peakers idle (normal cycling)'));
  }

  /* ---------- Hero chart ---------- */
  const SER = [
    ['gen', 'Actual generation', 'var(--h-gen)', 'solid'],
    ['demand', 'Demand at hourly checks', 'var(--h-gen)', 'dot'],
    ['cap', 'Actual capacity', 'var(--h-cap)', 'solid'],
    ['fload', 'Load forecast', 'var(--h-gen)', 'dash'],
    ['fcap', 'Capacity forecast', 'var(--h-cap)', 'dash'],
    ['peak', 'Peak today', 'var(--h-peak)', 'dash'],
    ['freq', 'Frequency (Hz)', 'var(--h-freq)', 'solid'],
  ];
  function heroLegend() {
    const lg = document.getElementById('hero-legend');
    if (lg.childElementCount) { lg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(vis[b.dataset.k]))); return; }
    for (const [k, n, c, style] of SER) {
      const b = el('button'); b.type = 'button'; b.dataset.k = k; b.setAttribute('aria-pressed', 'true');
      const sw = el('span', 'sw ' + style); sw.style.setProperty('--sw', c); b.append(sw, n);
      b.addEventListener('click', () => { vis[k] = !vis[k]; render(); });
      lg.append(b);
    }
  }
  function hero() {
    heroLegend();
    const box = document.getElementById('hero-chart'), note = document.getElementById('hero-note');
    const graph = G.rows('live_graph').filter((r) => r.time).map((r) => ({ t: new Date(r.time), g: num(r.generation_mw), f: num(r.frequency_hz) }));
    const hist = G.rows('history').map((r) => ({ t: new Date(r.at), cap: num(r.available_mw), d: num(r.total_mw) }));
    const fc = G.rows('forecast').filter((r) => r.time).map((r) => ({ t: new Date(r.time), l: num(r.load_forecast_mw), lo: num(r.load_low_mw), hi: num(r.load_high_mw), cap: num(r.capacity_forecast_mw) }));
    const k = G.rows('live_kpis')[0], fs = G.rows('forecast_summary')[0];
    if (!graph.length && !hist.length) { box.replaceChildren(el('div', 'hero-empty', G.st('history').status === 'loading' ? 'Loading…' : 'No data yet: the first hourly check will fill this chart.')); return; }
    const anchor = new Date(Math.max(graph.length ? +graph[graph.length - 1].t : 0, hist.length ? +hist[hist.length - 1].t : 0));
    const x0 = new Date(+anchor - 24 * H), x1 = new Date(Math.max(+anchor + 3 * H, fc.length ? +fc[fc.length - 1].t : 0));
    const inW = (d) => d.t >= x0 && d.t <= x1;
    const gw = graph.filter(inW), hw = hist.filter(inW), fw = fc.filter(inW);
    const notes = [];
    if (!graph.length) notes.push('The 5-minute generation and frequency trace appears after the first successful read of dataGraph.js.');
    if (!fc.length) notes.push(fs && fs.status && fs.status !== 'ok' ? 'Forecast: ' + fs.status.toLowerCase() + ' (it needs the 24-hour trace or a few hourly checks).' : '');
    if (fs && fs.status === 'ok' && fs.history_days < 2) notes.push('Capacity forecast is held at the current available capacity until two days of hourly checks build its daily pattern.');
    note.textContent = notes.filter(Boolean).join(' ');

    box.replaceChildren();
    const W = Math.max(320, box.clientWidth), Hh = Math.max(300, Math.min(440, W * 0.45));
    const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('width', '100%').attr('height', Hh);
    const mw = [];
    if (vis.gen) gw.forEach((d) => d.g != null && mw.push(d.g));
    if (vis.demand) hw.forEach((d) => d.d != null && mw.push(d.d));
    if (vis.cap) hw.forEach((d) => d.cap != null && mw.push(d.cap));
    if (vis.fload) fw.forEach((d) => { if (d.lo != null) mw.push(d.lo); if (d.hi != null) mw.push(d.hi); });
    if (vis.fcap) fw.forEach((d) => d.cap != null && mw.push(d.cap));
    if (vis.peak && k && k.peak_today_mw) mw.push(k.peak_today_mw);
    if (!mw.length) mw.push(0, 1000);
    const y = d3.scaleLinear([d3.min(mw) * 0.92, d3.max(mw) * 1.04], [Hh - 30, 14]).nice();
    const fv = gw.map((d) => d.f).filter((v) => v != null);
    const L = limits(); const nb = L ? L.bands[0] : { low: 59.8, high: 60.2 };
    const y2 = d3.scaleLinear([Math.min(nb.low - 0.05, (d3.min(fv) ?? 60) - 0.05), Math.max(nb.high + 0.05, (d3.max(fv) ?? 60) + 0.05)], [Hh - 30, 14]).nice();
    const yt = y.ticks(6), y2t = y2.ticks(5);
    const ml = G.measure(svg, yt.map(G.f0)) + 14, mr = vis.freq && fv.length ? G.measure(svg, y2t.map((t) => t.toFixed(1))) + 14 : 12;
    const x = d3.scaleTime([x0, x1], [ml, W - mr]);
    const g = svg.append('g');
    g.selectAll('line.grid').data(yt).join('line').attr('class', 'grid').attr('x1', ml).attr('x2', W - mr).attr('y1', y).attr('y2', y);
    g.selectAll('text.yl').data(yt).join('text').attr('class', 'ax').attr('x', ml - 8).attr('y', y).attr('dy', '0.35em').attr('text-anchor', 'end').text(G.f0);
    g.append('text').attr('class', 'ax').attr('x', ml - 8).attr('y', 4).attr('text-anchor', 'end').text('MW');
    if (vis.freq && fv.length) {
      g.selectAll('text.y2').data(y2t).join('text').attr('class', 'ax').attr('x', W - mr + 8).attr('y', y2).attr('dy', '0.35em').text((t) => t.toFixed(1));
      g.append('text').attr('class', 'ax').attr('x', W - mr + 8).attr('y', 4).text('Hz');
    }
    const xt = x.ticks(Math.max(3, Math.floor((W - ml - mr) / 90)));
    g.selectAll('text.xl').data(xt).join('text').attr('class', 'ax').attr('x', x).attr('y', Hh - 8).attr('text-anchor', 'middle').text((d) => (prHour(d) === 0 ? dFmt(d) : hFmt(d)));
    // forecast zone
    if (fw.length) g.append('rect').attr('class', 'fzone').attr('x', x(anchor)).attr('y', 14).attr('width', Math.max(0, x(x1) - x(anchor))).attr('height', Hh - 44);
    // band
    if (vis.fload && fw.length) g.append('path').datum(fw.filter((d) => d.lo != null && d.hi != null)).attr('class', 'band').attr('d', d3.area().x((d) => x(d.t)).y0((d) => y(d.lo)).y1((d) => y(d.hi)).curve(d3.curveMonotoneX));
    const line = (data, acc, yS, cls, curve = d3.curveMonotoneX) => g.append('path').datum(data).attr('class', cls).attr('d', d3.line().defined((d) => acc(d) != null).x((d) => x(d.t)).y((d) => yS(acc(d))).curve(curve));
    if (vis.cap && hw.length) line(hw, (d) => d.cap, y, 's-cap', d3.curveStepAfter);
    if (vis.fcap && fw.length) line([...(hw.length && hw[hw.length - 1].cap != null ? [{ t: hw[hw.length - 1].t, cap: hw[hw.length - 1].cap }] : []), ...fw], (d) => d.cap, y, 's-fcap', d3.curveStepAfter);
    if (vis.gen && gw.length) {
      g.append('path').datum(gw).attr('class', 's-gen-area').attr('d', d3.area().defined((d) => d.g != null).x((d) => x(d.t)).y0(Hh - 30).y1((d) => y(d.g)).curve(d3.curveMonotoneX));
      line(gw, (d) => d.g, y, 's-gen');
    }
    if (vis.fload && fw.length) {
      const startPt = gw.length ? { t: gw[gw.length - 1].t, l: gw[gw.length - 1].g } : hw.length ? { t: hw[hw.length - 1].t, l: hw[hw.length - 1].d } : null;
      line([...(startPt ? [startPt] : []), ...fw], (d) => d.l, y, 's-fload');
    }
    if (vis.demand && hw.length) g.selectAll('circle.dm').data(hw.filter((d) => d.d != null)).join('circle').attr('class', 's-demand').attr('cx', (d) => x(d.t)).attr('cy', (d) => y(d.d)).attr('r', 3);
    if (vis.peak && k && k.peak_today_mw) {
      g.append('line').attr('class', 's-peak').attr('x1', ml).attr('x2', W - mr).attr('y1', y(k.peak_today_mw)).attr('y2', y(k.peak_today_mw));
      g.append('text').attr('class', 'lbl peak').attr('x', ml + 6).attr('y', y(k.peak_today_mw) - 6).text('Peak today ' + G.f0(k.peak_today_mw) + ' MW');
    }
    if (vis.fload && fs && fs.status === 'ok' && fs.peak_forecast_mw) {
      const pt = new Date(fs.peak_forecast_time);
      if (pt >= x0 && pt <= x1) {
        g.append('circle').attr('class', 'pk').attr('cx', x(pt)).attr('cy', y(fs.peak_forecast_mw)).attr('r', 4.5);
        g.append('text').attr('class', 'lbl').attr('x', x(pt)).attr('y', y(fs.peak_forecast_mw) - 10).attr('text-anchor', x(pt) > W - 140 ? 'end' : 'middle').text('Forecast peak ' + G.f0(fs.peak_forecast_mw) + ' MW, ' + hFmt(pt));
      }
    }
    if (vis.freq && gw.length && L) {
      // excursion periods, shaded by worst level
      const step = gw.length > 1 ? (gw[gw.length - 1].t - gw[0].t) / (gw.length - 1) : 300000;
      for (const e of G.rows('frequency_events')) {
        const a = new Date(e.start), b = new Date(+new Date(e.end) + step);
        if (b < x0 || a > x1) continue;
        g.append('rect').attr('class', 'exc').attr('x', x(a < x0 ? x0 : a)).attr('y', 14).attr('width', Math.max(3, x(b > x1 ? x1 : b) - x(a < x0 ? x0 : a))).attr('height', Hh - 44).attr('fill', HLV[e.worst_level] || HLV.Alert);
      }
      // level boundaries that fall inside the frequency scale
      const [lo, hi] = y2.domain();
      L.bands.forEach((b, i) => { const next = L.bands[i + 1] ? L.bands[i + 1].level : 'Critical';
        for (const v of [b.low, b.high]) if (v != null && v > lo && v < hi) {
          g.append('line').attr('class', 'lim').attr('x1', ml).attr('x2', W - mr).attr('y1', y2(v)).attr('y2', y2(v)).attr('stroke', HLV[next]);
          g.append('text').attr('class', 'lim-l').attr('x', W - mr - 4).attr('y', y2(v) + (v < 60 ? 12 : -4)).attr('text-anchor', 'end').attr('fill', HLV[next]).text(next + ' ' + (v < 60 ? 'below ' : 'above ') + v.toFixed(1) + ' Hz');
        } });
    }
    if (vis.freq && gw.length) {
      g.append('line').attr('class', 'hz60').attr('x1', ml).attr('x2', W - mr).attr('y1', y2(60)).attr('y2', y2(60));
      line(gw, (d) => d.f, y2, 's-freq', d3.curveLinear);
    }
    g.append('line').attr('class', 'nowline').attr('x1', x(anchor)).attr('x2', x(anchor)).attr('y1', 14).attr('y2', Hh - 30);
    g.append('text').attr('class', 'lbl').attr('x', x(anchor) + 6).attr('y', 26).text(fw.length ? 'Latest data · forecast →' : 'Latest data');
    // hover
    const tip = G.tipFor(box.closest('.hero-main'));
    const rule = g.append('line').attr('class', 'rule').attr('y1', 14).attr('y2', Hh - 30).attr('opacity', 0);
    const near = (arr, t, maxMs) => { if (!arr.length) return null; const i = d3.bisector((d) => d.t).center(arr, t); const d = arr[i]; return d && Math.abs(d.t - t) <= maxMs ? d : null; };
    svg.append('rect').attr('x', ml).attr('y', 0).attr('width', W - ml - mr).attr('height', Hh - 30).attr('fill', 'transparent')
      .on('mousemove', (ev) => {
        const t = x.invert(d3.pointer(ev)[0]); rule.attr('x1', x(t)).attr('x2', x(t)).attr('opacity', 1);
        const a = near(gw, t, 8 * 60000), b = near(hw, t, 40 * 60000), c = near(fw, t, 40 * 60000), lines = [];
        if (a && a.g != null && vis.gen) lines.push(['var(--h-gen)', 'Generation', G.f0(a.g) + ' MW']);
        if (a && a.f != null && vis.freq) lines.push([HLV[level(a.f)] || 'var(--h-freq)', 'Frequency', a.f.toFixed(2) + ' Hz' + (level(a.f) ? ' (' + level(a.f) + ')' : '')]);
        if (b && b.d != null && vis.demand) lines.push(['var(--h-gen)', 'Demand (check)', G.f0(b.d) + ' MW']);
        if (b && b.cap != null && vis.cap) lines.push(['var(--h-cap)', 'Available capacity', G.f0(b.cap) + ' MW']);
        if (c && vis.fload) lines.push(['var(--h-gen)', 'Load forecast', G.f0(c.l) + ' MW (' + G.f0(c.lo) + '–' + G.f0(c.hi) + ')']);
        if (c && c.cap != null && vis.fcap) lines.push(['var(--h-cap)', 'Capacity forecast', G.f0(c.cap) + ' MW']);
        if (c && c.cap != null && c.l != null) lines.push([null, 'Projected reserve', G.f0(c.cap - c.l) + ' MW']);
        tip.show(ev, tFmt(t), lines.length ? lines : [[null, 'No reading at this time', null]]);
      })
      .on('mouseleave', () => { rule.attr('opacity', 0); tip.hide(); });
  }

  /* ---------- Readout rail ---------- */
  function rail() {
    const r = document.getElementById('rail'); r.replaceChildren();
    const k = G.rows('live_kpis')[0], fs = G.rows('forecast_summary')[0];
    if (!k) { r.append(el('div', 'dash-skeleton', '—')); return; }
    const graph = G.rows('live_graph').filter((x) => num(x.frequency_hz) != null);
    const f = graph.length ? num(graph[graph.length - 1].frequency_hz) : null;
    const largest = d3.max(G.rows('live_units'), (u) => Number(u.mw)) || 0;
    const item = (label, value, unit, sub, state) => {
      const d = el('div', 'ro'); const l = el('div', 'ro-l'); if (state) l.append(el('i', 'ro-dot ' + state)); l.append(label);
      const v = el('div', 'ro-v', value); if (unit) v.append(el('small', null, unit));
      d.append(l, v); if (sub) d.append(el('div', 'ro-s', sub)); r.append(d);
    };
    item('Demand now', G.f0(k.total_generation_mw), 'MW', 'Next hour (PREPA): ' + G.f0(k.next_hour_mw) + ' MW');
    const fl = level(f);
    item('Frequency', f == null ? '—' : f.toFixed(2), f == null ? '' : 'Hz', f == null ? 'Waiting for dataGraph.js' : (fl || '') + (fl ? ' level, ' : '') + (f >= 60 ? '+' : '−') + Math.abs(f - 60).toFixed(2) + ' Hz from 60', f == null ? '' : fl === 'Normal' ? 'ok' : fl === 'Watch' ? 'warn' : 'bad');
    item('Available capacity', G.f0(k.available_capacity_mw), 'MW', 'Margin over demand: ' + G.f0(k.available_capacity_mw - k.total_generation_mw) + ' MW');
    item('Spinning reserve', G.f0(k.spinning_reserve_mw), 'MW', (k.spinning_reserve_mw >= largest ? 'Covers' : 'Below') + ' the largest unit online (' + G.f0(Math.round(largest)) + ' MW)', k.spinning_reserve_mw >= largest ? 'ok' : 'bad');
    item('Operating reserve', G.f0(k.operating_reserve_mw), 'MW', 'Can start within the hour');
    if (fs && fs.status === 'ok') {
      item('Forecast peak, next 24 h', G.f0(fs.peak_forecast_mw), 'MW', 'Around ' + hFmt(new Date(fs.peak_forecast_time)));
      if (fs.min_reserve_mw != null) item('Lowest projected reserve', G.f0(fs.min_reserve_mw), 'MW', 'Around ' + hFmt(new Date(fs.min_reserve_time)), fs.min_reserve_mw < largest ? 'bad' : fs.min_reserve_mw < 2 * largest ? 'warn' : 'ok');
    }
    const st = G.rows('status')[0] || {};
    if (st.temperature_f != null) item('Temperature', G.f0(st.temperature_f), '°F', 'As published with PREPA’s 24-hour trace');
    item('Peaks: today, month, year', G.f0(k.peak_today_mw), 'MW', 'Month ' + G.f0(k.monthly_peak_mw) + ' MW, year ' + G.f0(k.annual_peak_mw) + ' MW');
  }

  /* ---------- Frequency section ---------- */
  function frequency() {
    const L = limits(); const kp = document.getElementById('fq-kpis'); kp.replaceChildren();
    const kpi = (label, value, note, color) => { const d = el('div', 'gx-kpi'); const v = el('div', 'gx-kpi-v', value); if (color) v.style.color = color; d.append(el('div', 'gx-kpi-l', label), v, el('div', 'gx-kpi-n', note)); kp.append(d); };
    const pts = G.rows('live_graph').filter((r) => num(r.frequency_hz) != null).map((r) => ({ t: new Date(r.time), f: num(r.frequency_hz) }));
    const evs = G.rows('frequency_events').map((e) => ({ ...e, t: new Date(e.start) }));
    // level legend
    const lv = document.getElementById('fq-levels'); lv.replaceChildren();
    if (L) {
      const prev = { Normal: null, Watch: L.bands[0], Alert: L.bands[1], Critical: L.bands[2] };
      for (const b of L.bands) {
        const li = el('li'); const sw = el('i'); sw.style.background = LV[b.level];
        const p = prev[b.level];
        const rg = b.level === 'Normal' ? b.low + '–' + b.high + ' Hz' : b.level === 'Critical' ? 'Below ' + p.low + ' or above ' + p.high + ' Hz' : b.low + '–' + p.low + ' or ' + p.high + '–' + b.high + ' Hz';
        const txt = el('div'); txt.append(el('b', null, b.level + ' '), el('span', 'rg', rg + (b.allowance_s ? ', allowed about ' + dur(b.allowance_s) : '')), el('span', 'src', b.source));
        li.append(sw, txt); lv.append(li);
      }
      const li = el('li'); const sw = el('i'); sw.style.background = 'transparent'; sw.style.border = '1.5px dashed var(--lv-critical)';
      const txt = el('div'); txt.append(el('b', null, 'Trip settings '), el('span', 'rg', L.trip_lines.map((t) => t.label).join('; ')), el('span', 'src', 'IEEE 1547-2018 default trip settings for distributed energy resources (Categories I–III).'));
      li.append(sw, txt); lv.append(li);
    }
    if (!pts.length) {
      kpi('Frequency now', '—', 'Waiting for the first read of dataGraph.js');
      kpi('Excursions logged', G.f0(evs.length), 'since monitoring began');
    } else {
      const fNow = pts[pts.length - 1].f, lvNow = level(fNow);
      const counts = d3.rollup(pts, (v) => v.length, (p) => level(p.f));
      const mn = d3.least(pts, (p) => p.f), mx = d3.greatest(pts, (p) => p.f);
      const lastT = pts[pts.length - 1].t;
      const e24 = evs.filter((e) => lastT - e.t <= 864e5), e7 = evs.filter((e) => lastT - e.t <= 7 * 864e5);
      const longest = d3.greatest(e7, (e) => e.approx_duration_s);
      kpi('Frequency now', fNow.toFixed(2) + ' Hz', (lvNow || '') + ' level at ' + tFmt(lastT), LV[lvNow]);
      kpi('Time in Normal, 24 h', G.pct(((counts.get('Normal') || 0) / pts.length) * 100), pts.length + ' readings');
      kpi('Lowest, 24 h', mn.f.toFixed(2) + ' Hz', tFmt(mn.t), LV[level(mn.f)]);
      kpi('Highest, 24 h', mx.f.toFixed(2) + ' Hz', tFmt(mx.t), LV[level(mx.f)]);
      kpi('Excursions', G.f0(e24.length) + ' / ' + G.f0(e7.length), 'last 24 h / 7 days');
      kpi('Time limit exceeded', G.f0(e7.filter((e) => e.allowance_status === 'Exceeded').length), (longest ? 'Longest excursion ' + dur(longest.approx_duration_s) : 'No excursions') + ', 7 days', e7.some((e) => e.allowance_status === 'Exceeded') ? 'var(--lv-critical)' : null);
    }
    // limit-scale chart
    const box = document.getElementById('fq-chart');
    if (!L) { G.failOrSkeleton(box, ['freq_limits']); }
    else {
      box.replaceChildren(); box.classList.remove('dash-skeleton');
      const W = box.clientWidth || 600, Hh = 340;
      const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('width', '100%').attr('height', Hh);
      const vals = new Set([L.nominal_hz]); L.bands.forEach((b) => { if (b.low != null) vals.add(b.low); if (b.high != null) vals.add(b.high); }); L.trip_lines.forEach((t) => vals.add(t.hz));
      const stops = [...vals].sort((a, b) => a - b); stops.unshift(stops[0] - 0.5); stops.push(stops[stops.length - 1] + 0.5);
      const nb = L.bands[0];
      const wts = stops.slice(1).map((v, i) => (stops[i] >= nb.low && v <= nb.high ? 2.5 : 1));
      const tot = d3.sum(wts); let acc = 0; const top = 12, bot = Hh - 26;
      const rng = [bot, ...wts.map((w) => { acc += w; return bot - (acc / tot) * (bot - top); })];
      const y = d3.scaleLinear(stops, rng).clamp(true);
      const lab = Math.max(G.measure(svg, ['Critical', 'Normal']) + 14, 64), ml = lab + G.measure(svg, stops.map((v) => v.toFixed(1))) + 12;
      const t0 = pts.length ? pts[0].t : null, t1 = pts.length ? pts[pts.length - 1].t : null;
      const x = d3.scaleTime(pts.length ? [t0, t1] : [new Date(Date.now() - 864e5), new Date()], [ml, W - 8]);
      // band rectangles
      const zones = [];
      const [n, w, a] = L.bands;
      zones.push(['Critical', stops[stops.length - 1], a.high], ['Alert', a.high, w.high], ['Watch', w.high, n.high], ['Normal', n.high, n.low], ['Watch', n.low, w.low], ['Alert', w.low, a.low], ['Critical', a.low, stops[0]]);
      for (const [lvName, hiV, loV] of zones) {
        svg.append('rect').attr('x', ml).attr('y', y(hiV)).attr('width', W - 8 - ml).attr('height', Math.max(0, y(loV) - y(hiV))).attr('fill', LV[lvName]).attr('opacity', lvName === 'Normal' ? 0.10 : 0.16);
        svg.append('text').attr('class', 'bandlab').attr('x', 2).attr('y', (y(hiV) + y(loV)) / 2).attr('dy', '0.35em').attr('fill', LV[lvName]).text(lvName);
      }
      svg.append('g').selectAll('text').data(stops.slice(1, -1)).join('text').attr('class', 'ax').attr('x', ml - 6).attr('y', y).attr('dy', '0.35em').attr('text-anchor', 'end').text((v) => v.toFixed(1));
      svg.append('line').attr('x1', ml).attr('x2', W - 8).attr('y1', y(L.nominal_hz)).attr('y2', y(L.nominal_hz)).attr('stroke', 'var(--lv-normal)').attr('stroke-opacity', 0.5);
      for (const tl of L.trip_lines) {
        svg.append('line').attr('class', 'trip').attr('x1', ml).attr('x2', W - 8).attr('y1', y(tl.hz)).attr('y2', y(tl.hz)).attr('stroke', 'var(--lv-critical)');
        svg.append('text').attr('class', 'triplab').attr('x', W - 10).attr('y', y(tl.hz) + (tl.hz < 60 ? 13 : -5)).attr('text-anchor', 'end').text(tl.label);
      }
      if (pts.length) {
        svg.append('g').selectAll('text').data(x.ticks(Math.max(3, Math.floor((W - ml) / 90)))).join('text').attr('class', 'ax').attr('x', x).attr('y', Hh - 6).attr('text-anchor', 'middle').text(hFmt);
        svg.append('path').datum(pts).attr('fill', 'none').attr('stroke', 'var(--ink)').attr('stroke-width', 1.6).attr('d', d3.line().x((p) => x(p.t)).y((p) => y(p.f)));
        const off = pts.filter((p) => level(p.f) !== 'Normal');
        svg.append('g').selectAll('circle').data(off).join('circle').attr('cx', (p) => x(p.t)).attr('cy', (p) => y(p.f)).attr('r', 3.5).attr('fill', (p) => LV[level(p.f)]).attr('stroke', 'var(--panel)').attr('stroke-width', 1.5);
        const tip = G.tipFor(box.closest('.gx-card'));
        svg.append('rect').attr('x', ml).attr('y', 0).attr('width', W - 8 - ml).attr('height', Hh - 26).attr('fill', 'transparent')
          .on('mousemove', (ev) => { const t = x.invert(d3.pointer(ev)[0]); const p = pts[d3.bisector((q) => q.t).center(pts, t)]; const l = level(p.f);
            tip.show(ev, tFmt(p.t), [[LV[l], 'Frequency', p.f.toFixed(2) + ' Hz'], [null, 'Level', l], [null, 'From 60 Hz', (p.f >= 60 ? '+' : '−') + Math.abs(p.f - 60).toFixed(2) + ' Hz']]); })
          .on('mouseleave', () => tip.hide());
      } else svg.append('text').attr('class', 'ax').attr('x', (ml + W) / 2).attr('y', y(60) - 10).attr('text-anchor', 'middle').text('The 24-hour frequency trace appears after the first read of dataGraph.js');
    }
    // excursion table
    document.getElementById('fq-empty').hidden = !(G.ok('frequency_events') && !evs.length);
    if (G.ok('frequency_events')) G.table(document.getElementById('fq-table'), evs, [
      { k: 'start', fmt: (v) => tFmt(new Date(v)) }, { k: 'direction', fmt: (v) => (v === 'Low' ? 'Under-frequency' : 'Over-frequency') },
      { k: 'worst_level', render: (td, r) => { const s = el('span', 'lvl'); const d = el('i'); d.style.background = LV[r.worst_level]; s.append(d, r.worst_level); s.style.color = LV[r.worst_level]; td.append(s); } },
      { k: 'extreme_hz', num: true, fmt: (v) => Number(v).toFixed(2) + ' Hz' }, { k: 'approx_duration_s', num: true, fmt: (v, r) => (r.samples > 1 ? '≈ ' : 'up to ') + dur(v) },
      { k: 'allowance_s', num: true, fmt: (v) => (v == null ? '—' : dur(v)) },
      { k: 'allowance_status', render: (td, r) => { const st = r.allowance_status; const s = el('span', 'gx-pill ' + (st === 'Exceeded' ? 'gx-t-bad' : st === 'Possibly exceeded' ? 'gx-t-warn' : '')); const d = el('i', 'gx-dot ' + (st === 'Exceeded' ? 'bad' : st === 'Possibly exceeded' ? 'warn' : 'ok')); s.append(d, st || '—'); td.append(s); } },
    ], { key: 'event_id', sortKey: 'start', redraw: render });
  }

  /* ---------- Outage tables ---------- */
  function outages() {
    if (G.ok('outage_alerts')) G.table(document.getElementById('alerts-table'), G.rows('outage_alerts'), [
      { k: 'severity', render: (td, r) => { const s = el('span', 'gx-sev ' + (r.rank === 1 ? 'gx-t-bad' : r.rank === 2 ? 'gx-t-warn' : '')); const d = el('i', 'gx-dot ' + (r.rank === 1 ? 'bad' : r.rank === 2 ? 'warn' : '')); if (r.rank === 3) d.style.background = 'var(--cds-chart-muted)'; s.append(d, r.severity); td.append(s); } },
      { k: 'plant' }, { k: 'unit' }, { k: 'last_month_net_mwh', num: true, fmt: G.f0 }, { k: 'mw_now', num: true, fmt: G.f2 },
    ], { key: 'unit_id', redraw: render });
    const ev = G.rows('unit_events');
    const real = ev.filter((e) => e.event === 'Went offline' || e.event === 'Back online');
    document.getElementById('events-empty').hidden = !(G.ok('unit_events') && !real.length);
    if (G.ok('unit_events')) G.table(document.getElementById('events-table'), ev.map((e) => ({ ...e, mw_before: num(e.mw_before), mw_after: num(e.mw_after) })), [
      { k: 'detected_at', fmt: (v) => tFmt(new Date(v)) },
      { k: 'event', render: (td, r) => { const off = r.event === 'Went offline', on = r.event === 'Back online'; const s = el('span', 'gx-pill ' + (off ? 'gx-t-bad' : on ? 'gx-t-ok' : '')); const d = el('i', 'gx-dot ' + (off ? 'bad' : on ? 'ok' : '')); if (!off && !on) d.style.background = 'var(--cds-chart-muted)'; s.append(d, r.event); td.append(s); } },
      { k: 'plant' }, { k: 'unit' }, { k: 'mw_before', num: true, fmt: (v) => (v == null ? '—' : G.f1(v)) }, { k: 'mw_after', num: true, fmt: (v) => (v == null ? '—' : G.f1(v)) },
    ], { key: 'event_id', sortKey: 'detected_at', redraw: render });
  }

  function offlineTrend() {
    const box = document.getElementById('offline-trend');
    const h = G.rows('history').map((r) => ({ t: new Date(r.at), off: num(r.genera_units_offline), tot: num(r.genera_units_total), sp: num(r.spinning_mw) })).filter((r) => r.off != null);
    if (!h.length) { G.failOrSkeleton(box, ['history']); return; }
    box.replaceChildren(); box.classList.remove('dash-skeleton');
    const W = box.clientWidth || 600, Hh = 200;
    const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('width', '100%').attr('height', Hh);
    const t0 = d3.min(h, (d) => d.t), t1 = d3.max(h, (d) => d.t);
    const pad = Math.max(H, (t1 - t0) * 0.03);
    const y = d3.scaleLinear([0, d3.max(h, (d) => d.tot) || 1], [Hh - 26, 10]).nice();
    const sp = h.map((d) => d.sp).filter((v) => v != null);
    const y2 = d3.scaleLinear([0, (d3.max(sp) || 1) * 1.1], [Hh - 26, 10]).nice();
    const ml = G.measure(svg, y.ticks(4).map(G.f0)) + 10, mr = G.measure(svg, y2.ticks(4).map(G.f0)) + 12;
    const x = d3.scaleTime([new Date(+t0 - pad), new Date(+t1 + pad)], [ml, W - mr]);
    svg.append('g').selectAll('line').data(y.ticks(4)).join('line').attr('x1', ml).attr('x2', W - mr).attr('y1', y).attr('y2', y).attr('stroke', 'var(--cds-chart-grid)');
    svg.append('g').selectAll('text').data(y.ticks(4)).join('text').attr('x', ml - 6).attr('y', y).attr('dy', '0.35em').attr('text-anchor', 'end').text(G.f0);
    svg.append('g').selectAll('text').data(y2.ticks(4)).join('text').attr('x', W - mr + 6).attr('y', y2).attr('dy', '0.35em').text(G.f0);
    svg.append('g').selectAll('text').data(x.ticks(Math.max(2, Math.floor((W - ml - mr) / 90)))).join('text').attr('x', x).attr('y', Hh - 6).attr('text-anchor', 'middle').text(dhFmt);
    const bw = Math.max(2, Math.min(14, ((W - ml - mr) / Math.max(1, (t1 - t0) / H + 2)) * 0.7));
    svg.append('g').selectAll('rect').data(h).join('rect').attr('x', (d) => x(d.t) - bw / 2).attr('y', (d) => y(d.off)).attr('width', bw).attr('height', (d) => y(0) - y(d.off)).attr('rx', 2).attr('fill', 'var(--alert)').attr('opacity', 0.75);
    if (sp.length) {
      svg.append('path').datum(h.filter((d) => d.sp != null)).attr('fill', 'none').attr('stroke', 'var(--teal)').attr('stroke-width', 2).attr('d', d3.line().x((d) => x(d.t)).y((d) => y2(d.sp)));
      svg.append('g').selectAll('circle').data(h.filter((d) => d.sp != null)).join('circle').attr('cx', (d) => x(d.t)).attr('cy', (d) => y2(d.sp)).attr('r', 2.5).attr('fill', 'var(--teal)');
    }
    const tip = G.tipFor(box.closest('.gx-card'));
    svg.append('rect').attr('x', ml).attr('y', 0).attr('width', W - ml - mr).attr('height', Hh - 26).attr('fill', 'transparent')
      .on('mousemove', (ev) => { const t = x.invert(d3.pointer(ev)[0]); const d = h[d3.bisector((r) => r.t).center(h, t)];
        tip.show(ev, tFmt(d.t), [['var(--alert)', 'Genera units offline', d.off + ' of ' + d.tot], ['var(--teal)', 'Spinning reserve', d.sp == null ? '—' : G.f0(d.sp) + ' MW']]); })
      .on('mouseleave', () => tip.hide());
  }

  /* ---------- Plant board ---------- */
  function board() {
    const b = document.getElementById('board');
    document.querySelectorAll('#board-filter button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === boardOp)));
    if (!G.ok('live_units')) { G.failOrSkeleton(b, ['live_units']); return; }
    b.replaceChildren(); b.classList.remove('dash-skeleton');
    const units = G.rows('live_units').filter((u) => boardOp === 'all' || u.operator === boardOp);
    const maxMW = d3.max(units, (u) => Number(u.mw)) || 1;
    const plants = d3.groups(units, (u) => u.plant).map(([p, us]) => ({ p, us, mw: d3.sum(us, (u) => Number(u.mw)), on: us.filter((u) => u.status === 'Generating').length }))
      .sort((a, c) => c.mw - a.mw || a.p.localeCompare(c.p));
    for (const pl of plants) {
      const blk = el('div', 'plant' + (pl.on === 0 ? ' out' : pl.on < pl.us.length ? ' partial' : ''));
      const hd = el('div', 'plant-h'); const nm = el('div', 'plant-n', pl.p);
      const meta = el('div', 'plant-m', G.f0(Math.round(pl.mw)) + ' MW, ' + pl.on + ' of ' + pl.us.length + ' on');
      hd.append(nm, meta); blk.append(hd);
      const fuelTag = el('div', 'plant-f'); const sw = el('span', 'gx-sw'); sw.style.background = G.color(pl.us[0].fuel); fuelTag.append(sw, pl.us[0].fuel + ', ' + pl.us[0].operator); blk.append(fuelTag);
      for (const u of pl.us) {
        const row = el('div', 'unit' + (u.status === 'Generating' ? '' : ' off'));
        row.append(el('i', 'gx-dot ' + (u.status === 'Generating' ? 'ok' : 'bad')), el('span', 'unit-n', u.unit));
        const bar = el('span', 'unit-b'); const fill = el('span'); fill.style.width = Math.max(0, (Number(u.mw) / maxMW) * 100) + '%'; fill.style.background = G.color(u.fuel); bar.append(fill);
        row.append(bar, el('span', 'unit-v', u.status === 'Generating' ? G.f1(Number(u.mw)) : 'off'));
        row.title = u.unit + ': ' + G.f2(Number(u.mw)) + ' MW' + (Number(u.cost_cents_kwh) > 0 ? ', ' + G.f2(Number(u.cost_cents_kwh)) + ' ¢/kWh' : '');
        blk.append(row);
      }
      b.append(blk);
    }
  }

  /* ---------- Mix and cost ---------- */
  function ring(parent, value, label, color) {
    const d = el('div', 'gx-ring'); parent.append(d);
    const S = 112, r = 44;
    const svg = d3.select(d).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${S} ${S}`).attr('height', S);
    const arc = d3.arc().innerRadius(r - 9).outerRadius(r).cornerRadius(4);
    const g = svg.append('g').attr('transform', `translate(${S / 2},${S / 2})`);
    g.append('path').attr('d', arc({ startAngle: 0, endAngle: 2 * Math.PI })).attr('fill', 'var(--cds-chart-grid)');
    g.append('path').attr('d', arc({ startAngle: 0, endAngle: 2 * Math.PI * Math.min(1, (value || 0) / 100) })).attr('fill', color);
    g.append('text').attr('class', 'rv').attr('text-anchor', 'middle').attr('dy', '0.3em').attr('font-size', 26).text(value == null ? '—' : G.f0(value));
    g.append('text').attr('class', 'ru').attr('text-anchor', 'middle').attr('y', 20).text('%');
    d.append(el('div', 'rl', label));
  }
  function mix() {
    const k = G.rows('live_kpis')[0];
    const rg = document.getElementById('rings');
    if (k) { rg.replaceChildren(); ring(rg, k.fossil_pct, 'Fossil', 'var(--c2)'); ring(rg, k.renewable_pct, 'Renewable', 'var(--teal)'); ring(rg, k.prepa_pct, 'PREPA-owned (Genera)', 'var(--c1)'); ring(rg, k.ppoa_pct, 'Independent (PPOA)', 'var(--c4)'); }
    const mb = document.getElementById('mixbar');
    if (G.ok('live_fuel_mix')) {
      mb.replaceChildren();
      const m = G.rows('live_fuel_mix'); const tot = d3.sum(m, (r) => Number(r.share_pct)) || 1;
      const bar = el('div', 'mix-track');
      for (const r of m) { const s = el('span'); s.style.flex = String(Number(r.share_pct) / tot); s.style.background = G.color(r.fuel); s.title = r.fuel + ' ' + r.share_pct + '%'; bar.append(s); }
      const leg = el('div', 'gx-legend');
      for (const r of m) { const s = el('span'); const sw = el('span', 'gx-sw'); sw.style.background = G.color(r.fuel); s.append(sw, r.fuel + ' ' + r.share_pct + '%'); leg.append(s); }
      mb.append(bar, leg);
    }
    const lc = document.getElementById('livecost-chart');
    if (!G.ok('live_cost_by_fuel')) G.failOrSkeleton(lc, ['live_units']);
    else G.hbars(lc, G.rows('live_cost_by_fuel').filter((f) => f.mw > 0).map((f) => ({ label: G.norm(f.fuel), total: f.cost_usd_per_hour, segments: [{ value: f.cost_usd_per_hour, color: G.color(f.fuel) }],
      endLabel: G.moneyC(f.cost_usd_per_hour) + '/h, ' + G.pct(f.share_pct) + (f.avg_cents_kwh != null ? ', ' + G.f1(f.avg_cents_kwh) + '¢' : ''),
      tip: [[G.color(f.fuel), G.norm(f.fuel), null], [null, 'Cost', G.money(f.cost_usd_per_hour) + '/h'], [null, 'Output', G.f1(f.mw) + ' MW'], [null, 'Average', f.avg_cents_kwh == null ? 'not reported' : G.f2(f.avg_cents_kwh) + ' ¢/kWh']] })));
  }

  /* ---------- Portal health ---------- */
  function health() {
    const all = G.rows('feed_health').map((h) => ({ ...h, t: new Date(h.at) }));
    const hs = all.filter((h) => h.via !== 'browser');
    const kp = document.getElementById('health-kpis'); kp.replaceChildren();
    const ps = portalState();
    const kpi = (label, value, note, cls) => { const d = el('div', 'gx-kpi' + (cls ? ' ' + cls : '')); d.append(el('div', 'gx-kpi-l', label), el('div', 'gx-kpi-v', value), el('div', 'gx-kpi-n', note)); kp.append(d); };
    const within = (ms) => hs.filter((h) => Date.now() - h.t <= ms);
    const up = (arr) => (arr.length ? (arr.filter((h) => h.ok).length / arr.length) * 100 : null);
    const ds24 = within(24 * H).filter((h) => h.feed === 'dataSource');
    const med = d3.median(ds24.filter((h) => h.ok), (h) => h.ms);
    const last = hs.filter((h) => h.feed === 'dataSource').pop();
    const s = G.rows('status')[0] || {};
    kpi('Status', ps.text, ps.detail, ps.cls === 'down' ? 'bad' : '');
    kpi('Uptime, 24 h', up(within(24 * H)) == null ? '—' : G.pct(up(within(24 * H))), within(24 * H).length + ' checks, both feeds');
    kpi('Uptime, 7 days', up(within(7 * 24 * H)) == null ? '—' : G.pct(up(within(7 * 24 * H))), within(7 * 24 * H).length + ' checks');
    kpi('Median response', med == null ? '—' : (med / 1000).toFixed(1) + ' s', 'dataSource.js, last 24 h');
    kpi('Data age at check', last && last.feed_age_min != null ? G.f0(last.feed_age_min) + ' min' : '—', 'PREPA timestamp vs. check time');
    kpi('Data updates, 24 h', G.f0(ds24.filter((h) => h.feed_changed).length), 'Checks that found new PREPA data');
    kpi('Failures in a row', G.f0(s.consecutive_failures || 0), s.last_run ? 'Last check ' + ago(new Date(s.last_run)) : 'No check yet', (s.consecutive_failures || 0) > 2 ? 'bad' : '');
    // heat strip
    const heat = document.getElementById('heat'); heat.replaceChildren();
    const W = heat.clientWidth || 420, cols = 24, rows = 7, lw = 46, cw = Math.max(8, Math.floor((W - lw) / cols)), ch = 16, gap = 2;
    const svg = d3.select(heat).append('svg').attr('viewBox', `0 0 ${lw + cols * cw} ${rows * (ch + gap) + 22}`).attr('width', '100%').attr('height', rows * (ch + gap) + 22);
    const byHour = d3.group(hs, (h) => d3.utcHour.floor(S(h.t)).getTime());
    const end = d3.utcHour.floor(S(new Date()));
    const tip = G.tipFor(heat.closest('.gx-card'));
    for (let r = 0; r < rows; r++) {
      const day = d3.utcDay.offset(d3.utcDay.floor(end), -(rows - 1 - r));
      svg.append('text').attr('x', 0).attr('y', r * (ch + gap) + ch - 4).attr('class', 'ax').text(d3.utcFormat('%a %-d')(day));
      for (let c = 0; c < cols; c++) {
        const t = d3.utcHour.offset(day, c); const list = byHour.get(t.getTime()) || [];
        const okN = list.filter((h) => h.ok).length;
        const fill = !list.length ? 'var(--cds-chart-grid)' : okN === list.length ? 'var(--teal)' : okN === 0 ? 'var(--alert)' : 'var(--amber)';
        svg.append('rect').attr('x', lw + c * cw).attr('y', r * (ch + gap)).attr('width', cw - gap).attr('height', ch).attr('rx', 2).attr('fill', fill)
          .on('mousemove', (ev) => tip.show(ev, d3.utcFormat('%a %b %-d, %-I %p')(t), list.length ? list.map((h) => [h.ok ? 'var(--teal)' : 'var(--alert)', h.feed, h.ok ? (h.ms / 1000).toFixed(1) + ' s' : h.error || 'failed']) : [[null, 'No check this hour', null]]))
          .on('mouseleave', () => tip.hide());
      }
    }
    [[0, '12 AM'], [6, '6 AM'], [12, '12 PM'], [18, '6 PM']].forEach(([hr, lab]) => svg.append('text').attr('class', 'ax').attr('x', lw + hr * cw).attr('y', rows * (ch + gap) + 14).text(lab));
    // response chart
    const rc = document.getElementById('resp-chart');
    const pts = within(7 * 24 * H).filter((h) => h.ok && h.ms != null);
    if (!pts.length) rc.replaceChildren(el('div', 'gx-fail', hs.length ? 'No successful checks in the last 7 days.' : 'No checks yet — the first hourly run will appear here.'));
    else {
      rc.replaceChildren();
      const W2 = rc.clientWidth || 420, H2 = 180;
      const s2 = d3.select(rc).append('svg').attr('viewBox', `0 0 ${W2} ${H2}`).attr('width', '100%').attr('height', H2);
      const y = d3.scaleLinear([0, d3.max(pts, (h) => h.ms / 1000) * 1.15], [H2 - 24, 8]).nice();
      const ml = G.measure(s2, y.ticks(4).map((v) => v + ' s')) + 10;
      const x = d3.scaleTime(d3.extent(pts, (h) => h.t), [ml, W2 - 8]);
      s2.append('g').selectAll('line').data(y.ticks(4)).join('line').attr('x1', ml).attr('x2', W2 - 8).attr('y1', y).attr('y2', y).attr('stroke', 'var(--cds-chart-grid)');
      s2.append('g').selectAll('text').data(y.ticks(4)).join('text').attr('x', ml - 6).attr('y', y).attr('dy', '0.35em').attr('text-anchor', 'end').text((v) => v + ' s');
      s2.append('g').selectAll('text').data(x.ticks(4)).join('text').attr('x', x).attr('y', H2 - 6).attr('text-anchor', 'middle').text(dFmt);
      for (const [feed, c] of [['dataSource', 'var(--c1)'], ['dataGraph', 'var(--amber)']]) {
        const d = pts.filter((h) => h.feed === feed); if (!d.length) continue;
        s2.append('path').datum(d).attr('fill', 'none').attr('stroke', c).attr('stroke-width', 1.8).attr('d', d3.line().x((h) => x(h.t)).y((h) => y(h.ms / 1000)));
        s2.append('text').attr('x', W2 - 10).attr('y', y(d[d.length - 1].ms / 1000) - 6).attr('text-anchor', 'end').attr('class', 'lbl-strong').text(feed + '.js');
      }
    }
    G.table(document.getElementById('checks-table'), all.slice().sort((a, b) => b.t - a.t).slice(0, 60), [
      { k: 'at', fmt: (v) => tFmt(new Date(v)) }, { k: 'via', fmt: (v) => (v === 'browser' ? 'This browser' : 'Hourly updater') }, { k: 'feed', fmt: (v) => v + '.js' },
      { k: 'ok', render: (td, r) => { const s = el('span', 'gx-pill ' + (r.ok ? 'gx-t-ok' : 'gx-t-bad')); s.append(el('i', 'gx-dot ' + (r.ok ? 'ok' : 'bad')), r.ok ? 'Answered' : r.error || 'Failed'); td.append(s); } },
      { k: 'ms', num: true, fmt: (v) => (v == null ? '—' : (v / 1000).toFixed(1) + ' s') }, { k: 'bytes', num: true, fmt: (v) => (v ? G.f0(Math.round(v / 1024)) + ' KB' : '—') },
      { k: 'feed_time', fmt: (v) => (v ? tFmt(new Date(v)) : '—') }, { k: 'feed_age_min', num: true, fmt: (v) => (v == null ? '—' : G.f0(v) + ' min') },
    ], { key: 'at', redraw: render });
    if (window.LIVE) { /* keep the connection bar text current */ }
  }

  document.getElementById('board-filter').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; boardOp = b.dataset.v; render(); });

  function render() { topbar(); alertBanner(); hero(); rail(); frequency(); outages(); offlineTrend(); board(); mix(); health(); }
  dash.onData(render);
  dash.init({
    live_units: 'data/live_units.json', live_metrics: 'data/live_metrics.json', live_fuel_mix: 'data/live_fuel_mix.json',
    live_graph: 'data/live_graph.json', unit_events: 'data/unit_events.json', history: 'data/history.json',
    forecast: 'data/forecast.json', forecast_summary: 'data/forecast_summary.json', feed_health: 'data/feed_health.json',
    status: 'data/status.json', hist_units: 'data/hist_units.json',
    freq_limits: 'data/frequency_limits.json', frequency_events: 'data/frequency_events.json',
  });
})();
