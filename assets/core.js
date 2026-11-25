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
  /* Excel-style column filters: a checklist of values for text columns, a min/max range for number columns.
     Filter state lives on the table element (tableEl._filt), keyed by column. */
  const fvOf = (c, r) => {
    if (c.fv) return c.fv(r);
    if (c.num) { const v = r[c.k]; return v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v); }
    const v = c.fmt && !c.render ? c.fmt(r[c.k], r) : r[c.k];
    return v == null || v === '' ? '—' : String(v);
  };
  function passes(f, v) {
    if (!f) return true;
    if (f.type === 'set') return f.allow.has(v == null ? '—' : String(v));
    if (v == null) return f.min == null && f.max == null;
    return (f.min == null || v >= f.min) && (f.max == null || v <= f.max);
  }
  function filterRows(tableEl, rows, cols, except) {
    const F = tableEl._filt || {};
    return rows.filter((r) => cols.every((c) => c.k === except || c.nofilter || passes(F[c.k], fvOf(c, r))));
  }
  let openPop = null;
  function closePop() { if (openPop) { openPop.remove(); openPop = null; document.removeEventListener('mousedown', outside, true); } }
  function outside(e) { if (openPop && !openPop.contains(e.target) && !e.target.closest('.th-filt')) closePop(); }
  function filterPopup(btn, tableEl, c, redraw) {
    if (openPop && openPop._key === c.k && openPop._tbl === tableEl) { closePop(); return; }
    closePop();
    const F = tableEl._filt || (tableEl._filt = {}), src = filterRows(tableEl, tableEl._src || [], tableEl._cols || [], c.k);
    const pop = document.createElement('div'); pop.className = 'filt-pop'; pop._key = c.k; pop._tbl = tableEl; pop.setAttribute('role', 'dialog');
    const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
    const isNum = c.num && !c.fv;
    if (isNum) {
      const vals = src.map((r) => fvOf(c, r)).filter((v) => v != null);
      const lo = vals.length ? Math.min(...vals) : 0, hi = vals.length ? Math.max(...vals) : 0, cur = F[c.k] || {};
      pop.append(mk('div', 'filt-h', 'Show values between'));
      const row = mk('div', 'filt-range');
      const iMin = mk('input'); iMin.type = 'number'; iMin.placeholder = 'min ' + (+lo.toFixed(2)); iMin.value = cur.min ?? ''; iMin.step = 'any';
      const iMax = mk('input'); iMax.type = 'number'; iMax.placeholder = 'max ' + (+hi.toFixed(2)); iMax.value = cur.max ?? ''; iMax.step = 'any';
      row.append(iMin, mk('span', null, 'and'), iMax); pop.append(row);
      const quick = mk('div', 'filt-quick');
      for (const [t, mn, mx] of [['> 0', 0.0001, null], ['= 0', 0, 0]]) { const b = mk('button', 'linkbtn', t); b.type = 'button'; b.addEventListener('click', () => { iMin.value = mn ?? ''; iMax.value = mx ?? ''; }); quick.append(b); }
      pop.append(quick);
      pop._apply = () => { const mn = iMin.value === '' ? null : Number(iMin.value), mx = iMax.value === '' ? null : Number(iMax.value); if (mn == null && mx == null) delete F[c.k]; else F[c.k] = { type: 'range', min: mn, max: mx }; };
    } else {
      const counts = new Map(); for (const r of src) { const v = String(fvOf(c, r) ?? '—'); counts.set(v, (counts.get(v) || 0) + 1); }
      const vals = [...counts.keys()].sort((a, b) => (a === '—') - (b === '—') || a.localeCompare(b, undefined, { numeric: true }));
      const cur = F[c.k];
      const search = mk('input', 'filt-search'); search.type = 'search'; search.placeholder = 'Search…'; pop.append(search);
      const all = mk('label', 'filt-item filt-all'); const allC = mk('input'); allC.type = 'checkbox'; all.append(allC, mk('span', null, '(Select all)')); pop.append(all);
      const list = mk('div', 'filt-list'); const boxes = [];
      for (const v of vals) { const l = mk('label', 'filt-item'); const cb = mk('input'); cb.type = 'checkbox'; cb.checked = !cur || cur.allow.has(v); cb.value = v; boxes.push(cb); l.append(cb, mk('span', 'filt-v', v), mk('span', 'filt-n', String(counts.get(v)))); list.append(l); }
      pop.append(list);
      const sync = () => { const vis = boxes.filter((b) => !b.parentElement.hidden); allC.checked = vis.length > 0 && vis.every((b) => b.checked); allC.indeterminate = !allC.checked && vis.some((b) => b.checked); };
      allC.addEventListener('change', () => { for (const b of boxes) if (!b.parentElement.hidden) b.checked = allC.checked; sync(); });
      boxes.forEach((b) => b.addEventListener('change', sync));
      search.addEventListener('input', () => { const q = search.value.trim().toLowerCase(); for (const b of boxes) b.parentElement.hidden = q && !b.value.toLowerCase().includes(q); sync(); });
      sync();
      pop._apply = () => { const on = boxes.filter((b) => b.checked).map((b) => b.value); if (on.length === boxes.length && (!cur || [...cur.allow].every((v) => counts.has(v)))) delete F[c.k]; else F[c.k] = { type: 'set', allow: new Set(on) }; };
    }
    const foot = mk('div', 'filt-foot');
    const clr = mk('button', 'btn ghost', 'Clear'); clr.type = 'button'; clr.addEventListener('click', () => { delete F[c.k]; closePop(); redraw && redraw(); });
    const ok = mk('button', 'btn', 'Apply'); ok.type = 'button'; ok.addEventListener('click', () => { pop._apply(); closePop(); redraw && redraw(); });
    foot.append(clr, ok); pop.append(foot);
    pop.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') ok.click(); if (e.key === 'Escape') closePop(); });
    document.body.append(pop);
    const r = btn.getBoundingClientRect(), pw = 260;
    pop.style.left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.right - pw + window.scrollX)) + 'px'; pop.style.top = r.bottom + 4 + window.scrollY + 'px';
    openPop = pop; setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
    const first = pop.querySelector('input'); if (first) first.focus();
  }
  function clearFilters(tableEl) { tableEl._filt = {}; }
  const filterCount = (tableEl) => Object.keys(tableEl._filt || {}).length;

  /* Sortable table */
  function table(tableEl, data, cols, o = {}) {
    const tb = tableEl.tBodies[0];
    if (o.filters) { // remember the unfiltered rows for the filter lists
      const pin = o.pinLast ? data.filter(o.pinLast) : [];
      tableEl._cols = cols;
      if (o.filters === 'header') { if (o.source) tableEl._src = o.source; }
      else { tableEl._src = data.filter((r) => !pin.includes(r)); data = [...filterRows(tableEl, tableEl._src, cols), ...pin]; }
    }
    const state = tableEl._sort || (tableEl._sort = { key: o.sortKey || null, dir: o.sortDir || 'desc' });
    const ths = [...tableEl.tHead.rows[0].cells];
    ths.forEach((th, i) => {
      const c = cols[i];
      if (!th.querySelector('button')) {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = th.textContent; th.replaceChildren(b);
        b.addEventListener('click', () => { state.dir = state.key === c.k && state.dir === 'desc' ? 'asc' : 'desc'; state.key = c.k; o.redraw && o.redraw(); });
      }
      th.setAttribute('aria-sort', state.key === c.k ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none');
      if (o.filters && !c.nofilter) {
        let fb = th.querySelector('.th-filt');
        if (!fb) { fb = document.createElement('button'); fb.type = 'button'; fb.className = 'th-filt'; fb.textContent = '▾'; fb.setAttribute('aria-label', 'Filter ' + th.textContent.replace('▾', '').trim()); th.classList.add('has-filt'); th.append(fb); }
        fb.onclick = (e) => { e.stopPropagation(); filterPopup(fb, tableEl, c, o.redraw); };
        const on = !!(tableEl._filt || {})[c.k]; fb.classList.toggle('on', on); th.classList.toggle('filt-on', on);
      }
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
  return { filterRows, clearFilters, filterCount, FUELS, norm, color, f0, f1, f2, money, moneyC, pct, signed, mParse, mFmt, st, ok, rows, failOrSkeleton, tipFor, measure, hbars, legend, table };
})();

