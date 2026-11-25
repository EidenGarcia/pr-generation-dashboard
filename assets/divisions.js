/* Divisions router: shows the introduction or one division at a time, driven by the URL hash.
   Only toggles visibility; every element, data file and the saved browser history stay as they are. */
(function () {
  const divs = Array.from(document.querySelectorAll('.division'));
  const tabs = Array.from(document.querySelectorAll('#div-tabs a'));
  const ids = divs.map((d) => d.dataset.div);
  let current = null;

  // Find which division a hash belongs to: a division name (#reliability) or any element inside one (#frequency, old links).
  function resolve(hash) {
    const h = decodeURIComponent((hash || '').replace(/^#/, ''));
    if (!h || h === 'home') return { div: 'home', target: null };
    if (ids.includes(h)) return { div: h, target: null };
    const el = document.getElementById(h);
    const box = el && el.closest('.division');
    if (box) return { div: box.dataset.div, target: el };
    return { div: 'home', target: null };
  }

  function show(name, target) {
    const changed = name !== current;
    current = name;
    for (const d of divs) d.hidden = d.dataset.div !== name;
    for (const t of tabs) {
      if (t.dataset.tab === name) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    }
    // Keep the active tab visible in the horizontally scrolling bar (without moving the page).
    const bar = document.getElementById('div-tabs'), tab = tabs.find((t) => t.dataset.tab === name);
    if (bar && tab) {
      const l = tab.offsetLeft - bar.offsetLeft, r = l + tab.offsetWidth;
      if (l < bar.scrollLeft) bar.scrollLeft = l - 8;
      else if (r > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = r - bar.clientWidth + 8;
    }
    // Charts size themselves from their box when drawn; redraw now that this division has real width.
    if (changed) window.dispatchEvent(new Event('resize'));
    const place = () => {
      if (target) target.scrollIntoView({ block: 'start' });
      else if (changed) window.scrollTo({ top: 0 });
    };
    place();
    // The redraw is debounced (150 ms) and can change heights; place again once it has run.
    clearTimeout(show.t);
    show.t = setTimeout(place, 260);
  }
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  function route() { const r = resolve(location.hash); show(r.div, r.target); }
  window.addEventListener('hashchange', route);
  route();
})();

/* Glossary search: hides terms (and empty groups) that do not match. */
(function () {
  const q = document.getElementById('gl-q');
  if (!q) return;
  const items = Array.from(document.querySelectorAll('.gl-item'));
  const groups = Array.from(document.querySelectorAll('.gl-group'));
  const count = document.getElementById('gl-count'), empty = document.getElementById('gl-empty');
  function run() {
    const s = q.value.trim().toLowerCase();
    let n = 0;
    for (const it of items) { const hit = !s || it.textContent.toLowerCase().includes(s); it.hidden = !hit; if (hit) n++; }
    for (const g of groups) g.hidden = !g.querySelector('.gl-item:not([hidden])');
    count.textContent = s ? `${n} of ${items.length} terms` : `${items.length} terms`;
    empty.hidden = n > 0;
  }
  q.addEventListener('input', run);
  run();
})();
