/* Plant history tab: when each plant and unit entered service, its age, capacity, ownership and funding.
   Reads data/unit_history.json (public record) and data/live_units.json (current output). */
(function () {
  const root = document.getElementById('div-history');
  if (!root) return;
  const $ = (id) => document.getElementById(id);
  const NOW = new Date().getFullYear();
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
  const state = { sector: 'all', type: 'all', q: '', order: 'old', miles: true };
  let H = null, live = {};

  const typeGroup = (u) => (u.type === 'Hydro' ? 'Hydro' : u.type.startsWith('Steam') ? 'Steam' : u.type.startsWith('Cogeneration') ? 'Steam'
    : u.type === 'Combined cycle' ? 'Combined cycle' : u.type === 'Gas turbine' ? 'Gas turbine' : 'Renewable');
  const retired = (u) => /^Retired/.test(u.status);
  const liveMW = (u) => {
    if (!u.live || !u.live.length) return null;
    const v = u.live.map((id) => live[id]).filter((x) => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) : null;
  };
  const yearLabel = (u) => u.year_note || (u.date && u.date.length > 7 ? new Date(u.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : u.year ?? 'Year not found');
  const srcLinks = (keys) => keys.map((k) => { const s = H.sources[k]; return s ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>` : ''; }).join('; ');

  function matches(u) {
    if (state.sector !== 'all' && u.sector !== state.sector) return false;
    if (state.type !== 'all' && typeGroup(u) !== state.type) return false;
    if (state.q) { const t = `${u.plant} ${u.unit} ${u.place} ${u.type} ${u.fuel} ${u.owner} ${u.story}`.toLowerCase(); if (!t.includes(state.q)) return false; }
    return true;
  }
  const sortKey = (x) => (x.year == null ? 9999 : x.year) + (x.date ? Number(x.date.slice(5, 7) || 0) / 100 : 0);

  function kpis() {
    const withYear = H.units.filter((u) => u.year && !retired(u));
    const oldest = withYear.reduce((a, b) => (b.year < a.year ? b : a));
    const pub = H.units.filter((u) => u.sector === 'public' && !retired(u)), pri = H.units.filter((u) => u.sector === 'private');
    const mw = (a) => a.reduce((s, u) => s + (u.mw || 0), 0);
    const thermal = withYear.filter((u) => u.sector === 'public' && u.type !== 'Hydro');
    const wAge = thermal.reduce((s, u) => s + (NOW - u.year) * u.mw, 0) / mw(thermal);
    const old50 = withYear.filter((u) => NOW - u.year >= 50), totalYear = mw(withYear);
    const k = [
      ['Oldest still on the grid', `${oldest.year}`, `${oldest.plant}, ${NOW - oldest.year} years old`],
      ['Average age, public fossil fleet', `${Math.round(wAge)} years`, 'Weighted by capacity (MW)'],
      ['Capacity 50+ years old', `${Math.round(100 * mw(old50) / totalYear)}%`, `${fmt(mw(old50))} of ${fmt(totalYear)} MW listed`],
      ['Public vs. private capacity', `${Math.round(100 * mw(pub) / (mw(pub) + mw(pri)))}% public`, `${fmt(mw(pub))} MW public · ${fmt(mw(pri))} MW private`],
    ];
    $('hi-kpis').innerHTML = k.map(([l, v, s]) => `<div class="gx-kpi"><div class="gx-kpi-l">${l}</div><div class="gx-kpi-v">${v}</div><div class="gx-kpi-s">${s}</div></div>`).join('');
  }

  function decades() {
    const d = {};
    for (const u of H.units) {
      if (!u.year || retired(u)) continue;
      const k = Math.floor(u.year / 10) * 10; d[k] = d[k] || { public: 0, private: 0 }; d[k][u.sector] += u.mw || 0;
    }
    const keys = Object.keys(d).map(Number).sort((a, b) => a - b);
    const max = Math.max(...keys.map((k) => d[k].public + d[k].private));
    $('hi-decades').innerHTML = keys.map((k) => {
      const p = d[k].public, r = d[k].private, t = p + r;
      return `<div class="hi-dec"><span class="hi-dec-l">${k}s</span><span class="hi-dec-bar"><span class="pub" style="width:${100 * p / max}%" title="Public ${fmt(p)} MW"></span><span class="pri" style="width:${100 * r / max}%" title="Private ${fmt(r)} MW"></span></span><span class="hi-dec-v">${fmt(t)} MW</span></div>`;
    }).join('');
  }

  function timeline() {
    const items = H.units.filter(matches).map((u) => ({ ...u, k: 'unit' }));
    if (state.miles && state.sector === 'all' && state.type === 'all' && !state.q) items.push(...H.milestones.map((m) => ({ ...m, k: 'mile' })));
    items.sort((a, b) => sortKey(a) - sortKey(b) || (a.k === 'mile' ? -1 : 1));
    if (state.order === 'new') { const nul = items.filter((x) => x.year == null); const rest = items.filter((x) => x.year != null).reverse(); items.length = 0; items.push(...rest, ...nul); }
    let dec = null, html = '';
    for (const x of items) {
      const dk = x.year == null ? 'Year not found' : `${Math.floor(x.year / 10) * 10}s`;
      if (dk !== dec) { html += `<li class="hi-decade" aria-hidden="false"><span>${dk}</span></li>`; dec = dk; }
      if (x.k === 'mile') {
        html += `<li class="hi-item mile"><div class="hi-year">${x.year}</div><div class="hi-body"><h4>${esc(x.title)}</h4><p>${esc(x.text)}</p><p class="hi-src">Source: ${srcLinks(x.src)}</p></div></li>`;
        continue;
      }
      const lm = liveMW(x), age = x.year ? NOW - x.year : null;
      const now = lm == null ? '' : lm >= 1 ? `<span class="hi-now on">Generating ${fmt(lm)} MW now</span>` : '<span class="hi-now off">Off now</span>';
      html += `<li class="hi-item ${x.sector}${retired(x) ? ' retired' : ''}">
        <div class="hi-year">${esc(yearLabel(x))}${age != null ? `<small>${age} years old</small>` : ''}</div>
        <div class="hi-body">
          <div class="hi-tags"><span class="hi-tag ${x.sector}">${x.sector === 'public' ? 'Public' : 'Private'}</span><span class="hi-tag">${esc(x.type)}</span><span class="hi-tag">${esc(x.fuel)}</span>${now}</div>
          <h4>${esc(x.plant)} <span>· ${esc(x.unit)}</span></h4>
          <p class="hi-meta"><b>${fmt(x.mw)} MW</b>${x.mw_note ? ` (${esc(x.mw_note)})` : ''} · ${esc(x.place)} · ${esc(x.status)}</p>
          <p>${esc(x.story)}</p>
          <dl class="hi-dl"><div><dt>Owner</dt><dd>${esc(x.owner)}</dd></div><div><dt>Operator</dt><dd>${esc(x.operator)}</dd></div><div><dt>Where the money came from</dt><dd>${esc(x.funding)}</dd></div></dl>
          <p class="hi-src">Source: ${srcLinks(x.src)}${x.live_note ? ` · <i>${esc(x.live_note)}</i>` : ''}</p>
        </div></li>`;
    }
    $('hi-timeline').innerHTML = html || '<li class="gx-note">No plants match these filters.</li>';
    $('hi-count').textContent = `${items.filter((x) => x.k === 'unit').length} of ${H.units.length} plants and units`;
  }

  function table() {
    const rows = H.units.filter(matches).slice().sort((a, b) => sortKey(a) - sortKey(b));
    if (state.order === 'new') rows.reverse();
    $('hi-table').querySelector('tbody').innerHTML = rows.map((u) => {
      const lm = liveMW(u);
      return `<tr class="${retired(u) ? 'hi-ret' : ''}"><td>${esc(yearLabel(u))}</td><td class="num">${u.year ? NOW - u.year : '—'}</td><td>${esc(u.plant)}</td><td>${esc(u.unit)}</td><td class="num">${fmt(u.mw)}</td><td>${esc(u.type)}</td><td>${esc(u.fuel)}</td><td><span class="hi-tag ${u.sector}">${u.sector === 'public' ? 'Public' : 'Private'}</span></td><td>${esc(u.status)}</td><td class="num">${lm == null ? '—' : fmt(lm)}</td></tr>`;
    }).join('');
  }

  function sources() {
    $('hi-sources').innerHTML = Object.values(H.sources).map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`).join('');
  }

  function render() { timeline(); table(); }

  function seg(id, key) {
    const el = $(id);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      el.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      state[key] = b.dataset.v; render();
    });
  }

  async function load() {
    try {
      const [h, lu] = await Promise.all([
        fetch('data/unit_history.json', { cache: 'no-cache' }).then((r) => r.json()),
        fetch('data/live_units.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => []),
      ]);
      H = h; live = {}; for (const u of lu) live[u.unit_id] = u.mw;
      kpis(); decades(); sources(); render();
    } catch (e) {
      console.error('history', e);
      $('hi-timeline').innerHTML = '<li class="gx-note">Could not load the plant history file.</li>';
    }
  }

  seg('hi-sector', 'sector'); seg('hi-type', 'type'); seg('hi-order', 'order');
  $('hi-q').addEventListener('input', (e) => { state.q = e.target.value.trim().toLowerCase(); render(); });
  $('hi-miles').addEventListener('change', (e) => { state.miles = e.target.checked; render(); });
  load();
  setInterval(() => fetch('data/live_units.json', { cache: 'no-cache' }).then((r) => r.json()).then((lu) => { for (const u of lu) live[u.unit_id] = u.mw; if (H) render(); }).catch(() => {}), 5 * 60 * 1000);
})();
