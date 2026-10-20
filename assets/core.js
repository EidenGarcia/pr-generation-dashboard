/* Data engine for the static dashboards: loads ./data/*.json, runs the shared calculations,
   redraws on resize and polls for the hourly update. Same interface as the original dashboard. */
window.dash = (() => {
  const raw = {}, st = {}, calcs = [], cbs = [], aug = {};
  let files = {}, timer = null;
  const colors = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)'];
  async function fetchAll() {
    await Promise.all(Object.entries(files).map(async ([id, p]) => {
      try {
        const r = await fetch(p + '?t=' + Math.floor(Date.now() / 60000), { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();
        raw[id] = { status: 'ok', data: Array.isArray(d) ? d : [d] };
      } catch (e) { raw[id] = { status: 'error', data: [], message: String(e.message || e) }; }
    }));
    apply();
  }
  // Augmenters let live browser readings replace or extend what the hourly files contain.
  function apply() {
    for (const id of Object.keys(files)) {
      const r = raw[id] || { status: 'loading', data: [] };
      if (aug[id]) {
        const out = aug[id](r.status === 'ok' ? r.data : []);
        st[id] = out && (r.status === 'ok' || out.length) ? { status: 'ok', data: out } : r;
      } else st[id] = r;
    }
    for (const c of calcs) delete st[c.id];
    for (let pass = 0; pass <= calcs.length; pass++) for (const c of calcs) {
      if (st[c.id]) continue;
      const ins = c.inputs.map((i) => st[i]);
      if (ins.some((x) => !x || x.status === 'loading')) continue;
      if (ins.some((x) => x.status !== 'ok')) { st[c.id] = { status: 'error', data: [] }; continue; }
      try { st[c.id] = { status: 'ok', data: c.fn(...ins.map((x) => x.data)) }; }
      catch (e) { console.error('calc ' + c.id, e); st[c.id] = { status: 'error', data: [], message: String(e) }; }
    }
    fire();
  }
  function fire() { for (const f of cbs) { try { f(); } catch (e) { console.error(e); } } }
  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(fire, 150); });
  return {
    colors,
    calc(id, def) { calcs.push({ id, ...def }); },
    data(id) { return st[id] || { status: 'loading', data: [] }; },
    raw(id) { return raw[id] || { status: 'loading', data: [] }; },
    onData(f) { cbs.push(f); },
    augment(id, fn) { aug[id] = fn; },
    rerun: () => apply(),
    setLink(id) { history.replaceState(null, '', '#' + id); },
    init(f, pollMinutes = 5) { files = f; fetchAll(); clearInterval(timer); timer = setInterval(fetchAll, pollMinutes * 60000); },
    refresh: () => fetchAll(),
  };
})();

/* ---------- Shared helpers ---------- */
window.GX = (() => {
  const FUELS = ['LNG', 'Bunker C', 'ULSD', 'Coal', 'Solar', 'Wind', 'Hydro', 'Landfill gas'];
  const norm = (f) => ({ 'ULSD (diesel)': 'ULSD', Diesel: 'ULSD', Bunker: 'Bunker C', Renewable: 'Solar' }[f] || f);
  const color = (f) => { const i = FUELS.indexOf(norm(f)); return i >= 0 ? dash.colors[i] : 'var(--cds-chart-muted)'; };
  const f0 = d3.format(','), f1 = d3.format(',.1f'), f2 = d3.format(',.2f');
  const money = (v) => (v == null ? '—' : '$' + d3.format(',.0f')(v));
  const moneyC = (v) => (v == null ? '—' : '$' + new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(v));
  const pct = (v) => (v == null ? '—' : d3.format('.1f')(v) + '%');
  const signed = (v) => (v == null ? '—' : (v > 0 ? '+' : '') + d3.format('.1f')(v) + '%');
  const mParse = d3.utcParse('%Y-%m');
  const mFmt = d3.utcFormat('%b %y');
  const st = (id) => dash.data(id);
  const ok = (id) => st(id).status === 'ok';
  const rows = (id) => (ok(id) ? st(id).data : []);

  function failOrSkeleton(el, ids) {
    const bad = ids.some((i) => st(i).status === 'error' || st(i).status === 'connect' || st(i).status === 'declined');
    el.replaceChildren();
    if (bad) { const d = document.createElement('div'); d.className = 'gx-fail'; d.append(document.createElement('i'), 'Failed to load'); el.append(d); el.classList.remove('dash-skeleton'); }
    else el.classList.add('dash-skeleton');
  }
  function tipFor(card) {
    let t = card.querySelector(':scope > .gx-tip');
    if (!t) { t = document.createElement('div'); t.className = 'gx-tip'; card.append(t); }
    return {
      show(ev, title, lines) {
        t.replaceChildren();
        const h = document.createElement('div'); h.className = 't'; h.textContent = title; t.append(h);
        for (const [c, label, val] of lines) {
          const l = document.createElement('div');
          if (c) { const s = document.createElement('span'); s.className = 'gx-sw'; s.style.background = c; l.append(s); }
          l.append(label + (val != null ? ': ' : ''));
          if (val != null) { const b = document.createElement('b'); b.textContent = val; b.style.fontWeight = '500'; l.append(b); }
          t.append(l);
        }
        const r = card.getBoundingClientRect();
        let x = ev.clientX - r.left + 12, y = ev.clientY - r.top + 12;
        t.style.opacity = '1';
        const w = t.offsetWidth, h2 = t.offsetHeight;
        if (x + w > r.width - 4) x = Math.max(4, ev.clientX - r.left - w - 12);
        if (y + h2 > r.height - 4) y = Math.max(4, ev.clientY - r.top - h2 - 12);
        t.style.left = x + 'px'; t.style.top = y + 'px';
      },
      hide() { t.style.opacity = '0'; },
    };
  }
  function measure(svg, texts) {
    const g = svg.append('g').attr('opacity', 0);
    let w = 0;
    for (const s of texts) { const n = g.append('text').text(s).node(); w = Math.max(w, n.getComputedTextLength()); }
    g.remove();
    return Math.ceil(w);
  }
  /* Horizontal bars, optional stacking (segments: [{key,label,color,value}]) */
  function hbars(el, data, o = {}) {
    el.replaceChildren(); el.classList.remove('dash-skeleton');
    const W = el.clientWidth || 400, barH = o.barH || 22, gap = 10;
    const svg = d3.select(el).append('svg').attr('width', '100%');
    const lw = measure(svg, data.map((d) => d.label)) + 10;
    const rw = measure(svg, data.map((d) => d.endLabel || '')) + 8;
    const H = data.length * (barH + gap) + 4;
    svg.attr('viewBox', `0 0 ${W} ${H}`).attr('height', H);
    const max = d3.max(data, (d) => d.total) || 1;
    const x = d3.scaleLinear([0, max], [lw, Math.max(lw + 40, W - rw)]);
    const card = el.closest('.gx-card'); const tip = tipFor(card);
    data.forEach((d, i) => {
      const y = i * (barH + gap);
      svg.append('text').attr('x', lw - 8).attr('y', y + barH / 2).attr('dy', '0.35em').attr('text-anchor', 'end').attr('class', 'lbl-strong').text(d.label);
      let acc = 0;
      const g = svg.append('g').attr('class', 'gx-anim');
      for (const s of d.segments) {
        if (!(s.value > 0)) continue;
        g.append('rect').attr('x', x(acc)).attr('y', y).attr('width', Math.max(1, x(acc + s.value) - x(acc))).attr('height', barH).attr('rx', d.segments.length > 1 ? 2 : 4).attr('fill', s.color);
        acc += s.value;
      }
      svg.append('text').attr('x', x(acc) + 6).attr('y', y + barH / 2).attr('dy', '0.35em').text(d.endLabel || '');
      svg.append('rect').attr('x', 0).attr('y', y - gap / 2).attr('width', W).attr('height', barH + gap).attr('fill', 'transparent')
        .on('mousemove', (ev) => tip.show(ev, d.label, d.tip)).on('mouseleave', () => tip.hide());
    });
  }
  function legend(el, fuels) {
    el.replaceChildren();
    for (const f of fuels) { const s = document.createElement('span'); const sw = document.createElement('span'); sw.className = 'gx-sw'; sw.style.background = color(f); s.append(sw, f); el.append(s); }
  }
  /* Sortable table */
  function table(tableEl, data, cols, o = {}) {
    const tb = tableEl.tBodies[0];
    const state = tableEl._sort || (tableEl._sort = { key: o.sortKey || null, dir: o.sortDir || 'desc' });
    const ths = [...tableEl.tHead.rows[0].cells];
    ths.forEach((th, i) => {
      const c = cols[i];
      if (!th.querySelector('button')) {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = th.textContent; th.replaceChildren(b);
        b.addEventListener('click', () => { state.dir = state.key === c.k && state.dir === 'desc' ? 'asc' : 'desc'; state.key = c.k; o.redraw && o.redraw(); });
      }
      th.setAttribute('aria-sort', state.key === c.k ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    });
    let d = data.slice();
    if (state.key) {
      const c = cols.find((x) => x.k === state.key);
      d.sort((a, b) => { const va = a[c.k], vb = b[c.k]; const r = typeof va === 'number' || typeof vb === 'number' ? (Number(va) || 0) - (Number(vb) || 0) : String(va).localeCompare(String(vb)); return state.dir === 'asc' ? r : -r; });
    }
    if (o.pinLast) { const i = d.findIndex(o.pinLast); if (i >= 0) d.push(d.splice(i, 1)[0]); }
    tb.replaceChildren(...d.map((r) => {
      const tr = document.createElement('tr'); tr.dataset.key = String(r[o.key]);
      for (const c of cols) {
        const td = document.createElement('td'); if (c.num) td.className = 'num';
        if (c.render) c.render(td, r); else td.textContent = c.fmt ? c.fmt(r[c.k], r) : (r[c.k] == null ? '—' : String(r[c.k]));
        tr.append(td);
      }
      if (o.rowStyle) o.rowStyle(tr, r);
      return tr;
    }));
  }
  return { FUELS, norm, color, f0, f1, f2, money, moneyC, pct, signed, mParse, mFmt, st, ok, rows, failOrSkeleton, tipFor, measure, hbars, legend, table };
})();

