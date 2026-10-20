/*
 * Shared PREPA feed logic, used by the hourly GitHub Action (Node) and by the live page (browser).
 * Pure functions only: no network, no file system.
 */
(function (root) {
const DAY = 86400000;
const pad = (n) => String(n).padStart(2, '0');
// Puerto Rico is UTC-4 all year (no daylight saving).
const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const astHour = (d) => new Date(d.getTime() - 4 * 3600000).getUTCHours();
const isoAST = (d) => new Date(d.getTime() - 4 * 3600000).toISOString().slice(0, 19) + '-04:00';

/* ------------- Safe parser for the feeds' JavaScript literals (never executes the code) ------------- */
class Lit {
  constructor(s, i) { this.s = s; this.i = i; }
  ws() {
    const s = this.s;
    for (;;) {
      while (this.i < s.length && /\s/.test(s[this.i])) this.i++;
      if (s.startsWith('//', this.i)) { const j = s.indexOf('\n', this.i); this.i = j < 0 ? s.length : j; }
      else if (s.startsWith('/*', this.i)) { const j = s.indexOf('*/', this.i); this.i = j < 0 ? s.length : j + 2; }
      else return;
    }
  }
  value() {
    this.ws();
    const c = this.s[this.i];
    if (c === '{') return this.obj();
    if (c === '[') return this.arr();
    if (c === '"' || c === "'" || c === '`') return this.str();
    const rest = this.s.slice(this.i, this.i + 40);
    const n = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (n) { this.i += n[0].length; return Number(n[0]); }
    const w = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (w) {
      this.i += w[0].length;
      if (w[0] === 'true') return true;
      if (w[0] === 'false') return false;
      if (w[0] === 'null' || w[0] === 'undefined' || w[0] === 'NaN') return null;
    }
    throw new Error('not a literal at ' + this.i);
  }
  str() {
    const q = this.s[this.i++]; let r = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i++];
      if (c === '\\') {
        const e = this.s[this.i++];
        if (e === 'u') { r += String.fromCharCode(parseInt(this.s.substr(this.i, 4), 16)); this.i += 4; }
        else r += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }[e] ?? e;
      } else if (c === q) return r;
      else r += c;
    }
    throw new Error('unterminated string');
  }
  arr() {
    this.i++; const a = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === ']') { this.i++; return a; }
      a.push(this.value()); this.ws();
      if (this.s[this.i] === ',') { this.i++; continue; }
      if (this.s[this.i] === ']') { this.i++; return a; }
      throw new Error('bad array at ' + this.i);
    }
  }
  obj() {
    this.i++; const o = {};
    for (;;) {
      this.ws();
      if (this.s[this.i] === '}') { this.i++; return o; }
      let k; const c = this.s[this.i];
      if (c === '"' || c === "'") k = this.str();
      else { const w = /^[\w$]+/.exec(this.s.slice(this.i, this.i + 200)); if (!w) throw new Error('bad key at ' + this.i); k = w[0]; this.i += k.length; }
      this.ws();
      if (this.s[this.i++] !== ':') throw new Error('expected : at ' + this.i);
      o[k] = this.value(); this.ws();
      if (this.s[this.i] === ',') { this.i++; continue; }
      if (this.s[this.i] === '}') { this.i++; return o; }
      throw new Error('bad object at ' + this.i);
    }
  }
}
function parseFeed(src) {
  src = String(src).replace(/^\uFEFF?\s*onst\s/, 'const '); // tolerate a copy that lost its first letter
  const vars = {}; const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g; let m;
  while ((m = re.exec(src))) {
    try { const p = new Lit(src, re.lastIndex); vars[m[1]] = p.value(); re.lastIndex = p.i; } catch { /* not a plain literal: skip */ }
  }
  return vars;
}
function parseStamp(s) { // "9/20/2026 7:22:21 AM" (Puerto Rico time)
  const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!m) return null;
  let h = +m[4]; if (m[7]) h = (h % 12) + (m[7].toUpperCase() === 'PM' ? 12 : 0);
  return `${m[3]}-${pad(m[1])}-${pad(m[2])}T${pad(h)}:${m[5]}:${m[6] || '00'}-04:00`;
}

/* ---------------- dataSource.js -> units, metrics, mix, prices ---------------- */
const TECH = { Hidroelectricas: 'Hydro', COGEN: 'Cogeneration', 'Turbina de Gas': 'Gas turbine', 'Ciclo Combinado': 'Combined cycle', Vapor: 'Steam', Renovable: 'Renewable' };
function plantLabel(s) {
  const t = s.Type, d = s.Desc;
  if (t === 'Ciclo Combinado') return d === 'San Juan' ? 'San Juan CC' : d.replace('Aguirre Stag', 'Aguirre CC');
  if (t === 'Vapor') return d + ' Steam';
  if (t === 'Turbina de Gas') return d === 'Estaciones GT' ? 'GT stations (peakers)' : d === 'Mayaguez' ? 'Mayagüez' : d === 'Cambalache' ? 'Cambalache' : d + ' GT/CT';
  if (t === 'COGEN') return d === 'AES' ? 'AES' : 'EcoEléctrica';
  if (t === 'Renovable') return d;
  return d + ' (hydro)';
}
const operatorOf = (s) => (s.Type === 'Hidroelectricas' ? 'PREPA (hydro)' : s.Type === 'COGEN' || s.Type === 'Renovable' ? 'Independent (PPOA)' : 'Genera PR');
function fuelOf(s, u) {
  if (s.Type === 'Hidroelectricas') return 'Hydro';
  if (s.Desc === 'AES') return 'Coal';
  if (s.Desc === 'Ecoelectrica') return 'LNG';
  if (s.Type === 'Renovable') return s.Desc === 'Landfill' ? 'Landfill gas' : s.Desc;
  if (String(u.Unit).startsWith('FEMA GT')) return 'LNG';
  if (s.Type === 'Ciclo Combinado' && s.Desc === 'San Juan') return 'LNG';
  if (s.Type === 'Vapor' && s.Desc === 'Costa Sur') return 'LNG';
  if (s.Type === 'Vapor') return 'Bunker C';
  return 'ULSD (diesel)';
}
function filingUnit(plant, unit) { // feed unit -> unit name in Genera's quarterly filings (unambiguous matches only)
  const n = (String(unit).match(/\d+/) || [''])[0];
  if (plant === 'San Juan CC') return 'San Juan ' + n;
  if (plant === 'San Juan Steam' && (n === '7' || n === '9')) return 'San Juan ' + n;
  if (plant === 'Palo Seco Steam' && (n === '3' || n === '4')) return 'Palo Seco ' + n;
  if (plant === 'Aguirre Steam') return 'Aguirre ' + n;
  if (plant === 'Costa Sur Steam' && (n === '5' || n === '6')) return 'Costa Sur ' + n;
  if (/^Aguirre CC [12]$/.test(plant)) { const b = plant.slice(-1); return String(unit).startsWith('STG') ? 'V-' + b : b + '-' + n; }
  if (plant === 'Cambalache' && (n === '2' || n === '3')) return 'Cambalache ' + n;
  if (plant === 'Mayagüez') return 'Mayaguez ' + n;
  if (plant === 'GT stations (peakers)') {
    const map = { Daguao: 'Daguao 1-1;Daguao 1-2', Jobos: 'Jobos 1-1;Jobos 1-2', Yabucoa: 'Yabucoa 1-1;Yabucoa 1-2', 'FEMA GT SJ': 'San Juan TMs', 'FEMA GT PS': 'Palo Seco TMs' };
    return map[unit] || '';
  }
  return '';
}
const METRIC_EN = { 0: 'Total generation (MW)', 1: 'PREPA-owned share (%)', 2: 'PPOA share (%)', 3: 'Fossil share (%)', 4: 'Renewable share (%)', 5: 'Spinning reserve (MW)', 6: 'Operating reserve (MW)', 7: 'Available capacity (MW)', 8: 'Next-hour forecast (MW)', 9: 'Peak today (MW)', 10: 'Monthly peak (MW)', 11: 'Annual peak (MW)', 12: 'Peak today time', 13: 'Monthly peak time', 14: 'Annual peak time' };
const PRICE_PLACE = { 'San Juan': ['Bunker C', '$/bbl'], 'San Juan CC': ['ULSD', '$/bbl'], 'Palo Seco': ['Bunker C', '$/bbl'], Aguirre: ['Bunker C', '$/bbl'], 'Aguirre CC': ['ULSD', '$/bbl'], 'Costa Sur': ['Bunker C', '$/bbl'], Cambalache: ['ULSD', '$/bbl'], Mayaguez: ['ULSD', '$/bbl'], 'Costa Sur LNG': ['LNG', '$/MMBtu'] };
const OFFLINE_MW = 1; // below this a unit counts as not generating (the feed shows telemetry noise on stopped units)

function processSource(v) {
  const snap = parseStamp(v.dataFechaAcualizado || v.dataFechaActualizado);
  if (!snap || !Array.isArray(v.dataLoadPerSite)) throw new Error('dataSource.js layout not recognised');
  const units = [];
  for (const s of v.dataLoadPerSite) for (const u of s.units || []) {
    const mw = Number(u.MW) || 0, cost = Number(u.Cost) || 0, plant = plantLabel(s);
    units.push({ unit_id: `${plant}|${u.Unit}`, plant, unit: u.Unit, technology: TECH[s.Type] || s.Type, operator: operatorOf(s), fuel: fuelOf(s, u),
      filing_unit: filingUnit(plant, u.Unit), mw, mvar: Number(u.MVar) || 0, cost_cents_kwh: cost,
      status: mw >= OFFLINE_MW ? 'Generating' : 'Offline', cost_usd_per_hour: mw >= OFFLINE_MW ? Math.round(mw * cost * 1000) / 100 : 0, snapshot: snap });
  }
  const metrics = (v.dataMetrics || []).map((x) => ({ index: Number(x.Index), metric: x.Desc, metric_en: METRIC_EN[Number(x.Index)] || x.Desc,
    value: typeof x.value === 'number' ? x.value : null, value_text: typeof x.value === 'string' ? x.value : null, snapshot: snap }));
  const mix = (v.dataByFuel || []).map((x) => ({ fuel: x.fuel === 'Renew' ? 'Renewable' : x.fuel, share_pct: Number(x.value), snapshot: snap }));
  const prices = (v.dataFuelCost || []).map((x) => ({ feed_place: x.place, fuel: (PRICE_PLACE[x.place] || ['Unknown'])[0], price: Number(x.value), price_unit: (PRICE_PLACE[x.place] || ['', '?'])[1], snapshot: snap }));
  return { snap, units, metrics, mix, prices };
}

/* ---------------- dataGraph.js -> time series (layout-agnostic) ---------------- */
const isTimeLike = (x) => typeof x === 'string' && (/\d{1,2}:\d{2}/.test(x) || /^\d{4}-\d{2}-\d{2}/.test(x));
function toISOFromLabel(labels, refDate) {
  // Full timestamps parse directly; bare "HH:MM" labels are dated by walking back from the newest one.
  const out = new Array(labels.length);
  let prev = null, dayShift = 0;
  const refAST = new Date(refDate.getTime() - 4 * 3600000);
  for (let i = labels.length - 1; i >= 0; i--) {
    const s = String(labels[i]);
    const full = parseStamp(s) || (/^\d{4}-\d{2}-\d{2}T/.test(s) ? s : null);
    if (full) { out[i] = new Date(full).toISOString(); continue; }
    const m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
    if (!m) { out[i] = null; continue; }
    let h = +m[1]; if (m[4]) h = (h % 12) + (m[4].toUpperCase() === 'PM' ? 12 : 0);
    let t = Date.UTC(refAST.getUTCFullYear(), refAST.getUTCMonth(), refAST.getUTCDate() - dayShift, h, +m[2], +(m[3] || 0)) + 4 * 3600000;
    if (prev === null && t > refDate.getTime() + 15 * 60000) { dayShift++; t -= DAY; }
    if (prev !== null && t > prev) { dayShift++; t -= DAY; }
    prev = t; out[i] = new Date(t).toISOString();
  }
  return out;
}
const median = (a) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : NaN; };
function classify(key, values) {
  const md = median(values);
  if (/freq|hz|frec/i.test(key) || (md > 55 && md < 65)) return 'frequency_hz';
  if (/gen|load|carga|demand/i.test(key) || md > 300) return 'generation_mw';
  return null;
}
function processGraph(v, refDate) {
  // PREPA's actual layout: const temperatura = "82"; const dataGraph = [{"Hour": "14:02", "Frequency": 59.9, "Generation": 1955.3}, ...]
  if (Array.isArray(v.dataGraph) && v.dataGraph.length && v.dataGraph[0] && 'Hour' in v.dataGraph[0]) {
    const arr = v.dataGraph;
    const iso = toISOFromLabel(arr.map((r) => r.Hour), refDate);
    const seen = new Map();
    arr.forEach((r, i) => { if (iso[i]) seen.set(iso[i], { time: isoAST(new Date(iso[i])), generation_mw: num(r.Generation), frequency_hz: num(r.Frequency) }); });
    const rows = [...seen.values()].sort((x, y) => (x.time < y.time ? -1 : 1));
    return { rows, temperature_f: num(v.temperatura), meta: { layout: 'dataGraph: Hour, Frequency, Generation', mapping: { generation_mw: 'Generation', frequency_hz: 'Frequency', time: 'Hour' }, variables: { temperatura: typeof v.temperatura, dataGraph: 'array(' + arr.length + ')' } } };
  }
  const meta = { variables: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Array.isArray(x) ? `array(${x.length})` : typeof x])), layout: null, mapping: {} };
  let rows = [];
  // Layout A: an array of objects with a time field and numeric fields.
  const objArrays = Object.entries(v).filter(([, x]) => Array.isArray(x) && x.length >= 20 && x[0] && typeof x[0] === 'object' && !Array.isArray(x[0]));
  if (objArrays.length) {
    const [name, arr] = objArrays.sort((a, b) => b[1].length - a[1].length)[0];
    const keys = Object.keys(arr[0]);
    const tKey = keys.find((k) => /fecha|time|hora|date|ts|label/i.test(k) && isTimeLike(arr[0][k])) || keys.find((k) => isTimeLike(arr[0][k]));
    if (tKey) {
      const iso = toISOFromLabel(arr.map((r) => r[tKey]), refDate);
      const series = {};
      for (const k of keys) if (k !== tKey) { const c = classify(k, arr.map((r) => Number(r[k]))); if (c && !series[c]) series[c] = k; }
      rows = arr.map((r, i) => { const o = { time: iso[i] }; for (const [c, k] of Object.entries(series)) o[c] = Number(r[k]); return o; });
      meta.layout = `objects in ${name}`; meta.mapping = series; meta.time_field = tKey;
    }
  }
  // Layout B: a labels array plus parallel numeric arrays (chart-library style).
  if (!rows.length) {
    const arrays = Object.entries(v).filter(([, x]) => Array.isArray(x) && x.length >= 20);
    const lab = arrays.find(([, x]) => x.filter(isTimeLike).length > x.length * 0.8);
    if (lab) {
      const L = lab[1].length, iso = toISOFromLabel(lab[1], refDate), series = {};
      for (const [k, x] of arrays) if (k !== lab[0] && x.length === L && x.every((y) => y === null || Number.isFinite(Number(y)))) { const c = classify(k, x.map(Number)); if (c && !series[c]) series[c] = k; }
      rows = iso.map((t, i) => { const o = { time: t }; for (const [c, k] of Object.entries(series)) o[c] = Number(v[k][i]); return o; });
      meta.layout = `labels in ${lab[0]}`; meta.mapping = series;
    }
  }
  // Layout C: arrays of [time, value] pairs, one per series.
  if (!rows.length) {
    const pairs = Object.entries(v).filter(([, x]) => Array.isArray(x) && x.length >= 20 && Array.isArray(x[0]) && x[0].length >= 2);
    const by = new Map(); const series = {};
    for (const [k, x] of pairs) {
      const c = classify(k, x.map((p) => Number(p[1]))); if (!c || series[c]) continue; series[c] = k;
      const iso = typeof x[0][0] === 'number' ? x.map((p) => new Date(p[0]).toISOString()) : toISOFromLabel(x.map((p) => p[0]), refDate);
      x.forEach((p, i) => { const t = iso[i]; if (!t) return; if (!by.has(t)) by.set(t, { time: t }); by.get(t)[c] = Number(p[1]); });
    }
    rows = [...by.values()].sort((a, b) => (a.time < b.time ? -1 : 1));
    if (rows.length) { meta.layout = 'time/value pairs'; meta.mapping = series; }
  }
  rows = rows.filter((r) => r.time).map((r) => ({ ...r, time: isoAST(new Date(r.time)) }));
  return { rows, meta };
}

/* ---------------- Frequency levels (IEEE 1547-2018 and generator limits; see data/frequency_limits.json) ---------------- */
const RANK = { Normal: 0, Watch: 1, Alert: 2, Critical: 3 };
function freqLevel(f, L) {
  for (const b of L.bands) if (b.low != null && b.high != null && f >= b.low && f <= b.high) return b.level;
  return 'Critical';
}
function detectExcursions(rows, L) {
  const pts = rows.filter((r) => Number.isFinite(r.frequency_hz)).map((r) => ({ t: new Date(r.time).getTime(), f: r.frequency_hz })).sort((a, b) => a.t - b.t);
  if (pts.length < 2) return { episodes: [], step: null };
  const diffs = pts.slice(1).map((p, i) => (p.t - pts[i].t) / 1000).filter((d) => d > 0);
  const step = median(diffs) || 300;
  const eps = []; let cur = null;
  for (const p of pts) {
    const lv = freqLevel(p.f, L);
    if (lv === 'Normal') { if (cur) { eps.push(cur); cur = null; } continue; }
    const dir = p.f < L.nominal_hz ? 'Low' : 'High';
    if (cur && cur.direction === dir && (p.t - cur.endT) / 1000 <= step * 1.5) {
      cur.endT = p.t; cur.samples++;
      if (dir === 'Low' ? p.f < cur.extreme_hz : p.f > cur.extreme_hz) { cur.extreme_hz = p.f; cur.extreme_at = p.t; }
      if (RANK[lv] > RANK[cur.worst_level]) cur.worst_level = lv;
    } else {
      if (cur) eps.push(cur);
      cur = { direction: dir, startT: p.t, endT: p.t, samples: 1, extreme_hz: p.f, extreme_at: p.t, worst_level: lv };
    }
  }
  if (cur) eps.push(cur);
  return { step, episodes: eps.map((e) => finishEpisode(e, step, L)) };
}
function finishEpisode(e, step, L) {
  const band = L.bands.find((b) => b.level === e.worst_level) || {};
  const duration_s = Math.round((e.endT - e.startT) / 1000 + step); // upper estimate: span of readings plus one interval
  return { event_id: `${e.direction}|${isoAST(new Date(e.startT))}`, start: isoAST(new Date(e.startT)), end: isoAST(new Date(e.endT)), direction: e.direction,
    worst_level: e.worst_level, extreme_hz: e.extreme_hz, extreme_at: isoAST(new Date(e.extreme_at)), samples: e.samples, sample_step_s: Math.round(step),
    approx_duration_s: duration_s, observed_span_s: Math.round((e.endT - e.startT) / 1000), allowance_s: band.allowance_s ?? null,
    allowance_status: allowanceStatus((e.endT - e.startT) / 1000, duration_s, band.allowance_s), startT: e.startT, endT: e.endT };
}
function allowanceStatus(minS, maxS, allow) {
  if (allow == null) return 'No time limit';
  if (minS > allow) return 'Exceeded';
  if (maxS > allow) return 'Possibly exceeded';
  return 'Within limit';
}
function mergeExcursions(old, fresh, step) {
  const out = old.map((e) => ({ ...e, startT: new Date(e.start).getTime(), endT: new Date(e.end).getTime() }));
  for (const n of fresh) {
    const tol = (step || 300) * 1500;
    const hit = out.find((o) => o.direction === n.direction && n.startT <= o.endT + tol && n.endT >= o.startT - tol);
    if (!hit) { out.push(n); continue; }
    const startT = Math.min(hit.startT, n.startT), endT = Math.max(hit.endT, n.endT);
    const more = n.direction === 'Low' ? n.extreme_hz < hit.extreme_hz : n.extreme_hz > hit.extreme_hz;
    Object.assign(hit, { startT, endT, start: isoAST(new Date(startT)), end: isoAST(new Date(endT)),
      worst_level: RANK[n.worst_level] > RANK[hit.worst_level] ? n.worst_level : hit.worst_level,
      extreme_hz: more ? n.extreme_hz : hit.extreme_hz, extreme_at: more ? n.extreme_at : hit.extreme_at,
      samples: Math.max(hit.samples, n.samples), approx_duration_s: Math.round((endT - startT) / 1000 + (n.sample_step_s || 300)), allowance_s: n.allowance_s ?? hit.allowance_s });
    hit.observed_span_s = Math.round((endT - startT) / 1000);
    const band = { allowance_s: hit.allowance_s };
    if (RANK[hit.worst_level] !== undefined) hit.allowance_status = allowanceStatus(hit.observed_span_s, hit.approx_duration_s, band.allowance_s);
  }
  return out.map(({ startT, endT, ...e }) => e).sort((a, b) => (a.start < b.start ? -1 : 1));
}


/* ---------------- Forecast: hour-of-day profile, level-adjusted, anchored to PREPA's next-hour figure ---------------- */
function buildForecast({ graphRows, history, nextHourMw, availableMw, demandNow, now: NOWD }) {
  const NOW = NOWD || new Date();
  const obs = [];
  for (const r of graphRows) if (Number.isFinite(r.generation_mw)) obs.push({ t: new Date(r.time).getTime(), mw: r.generation_mw });
  for (const h of history) if (Number.isFinite(h.total_mw)) obs.push({ t: new Date(h.at).getTime(), mw: h.total_mw });
  const now = NOW.getTime();
  if (obs.length < 3) return { rows: [], summary: { status: 'Not enough data yet', generated_at: isoAST(NOW) } };
  const prof = Array.from({ length: 24 }, () => ({ w: 0, s: 0, s2: 0, n: 0 }));
  for (const o of obs) { const age = (now - o.t) / DAY; const w = Math.pow(0.8, Math.max(0, age)); const p = prof[astHour(new Date(o.t))]; p.w += w; p.s += w * o.mw; p.s2 += w * o.mw * o.mw; p.n++; }
  const base = prof.map((p) => (p.w ? p.s / p.w : null));
  const sd = prof.map((p) => (p.w && p.n >= 3 ? Math.sqrt(Math.max(0, p.s2 / p.w - (p.s / p.w) ** 2)) : null));
  for (let k = 0; k < 24; k++) if (base[k] == null) {
    for (let d = 1; d < 12; d++) { const a = base[(k - d + 24) % 24], b = base[(k + d) % 24]; if (a != null || b != null) { base[k] = a != null && b != null ? (a + b) / 2 : a ?? b; break; } }
  }
  const nowH = astHour(NOW);
  const latest = obs.slice().sort((a, b) => b.t - a.t)[0].mw;
  const actualNow = Number.isFinite(demandNow) ? demandNow : latest;
  const ratio = base[nowH] ? actualNow / base[nowH] : 1;
  const capObs = history.filter((h) => Number.isFinite(h.available_mw));
  const capProf = Array.from({ length: 24 }, () => ({ w: 0, s: 0 }));
  for (const h of capObs) { const t = new Date(h.at).getTime(); const w = Math.pow(0.8, Math.max(0, (now - t) / DAY)); const p = capProf[astHour(new Date(t))]; p.w += w; p.s += w * h.available_mw; }
  const capSpanDays = capObs.length ? (now - Math.min(...capObs.map((h) => new Date(h.at).getTime()))) / DAY : 0;
  const rows = [];
  const start = Math.floor(now / 3600000) * 3600000;
  for (let k = 1; k <= 24; k++) {
    const t = new Date(start + k * 3600000), h = astHour(t);
    let load = base[h] * (1 + (ratio - 1) * Math.exp(-k / 6));
    if (k === 1 && Number.isFinite(nextHourMw)) load = 0.5 * load + 0.5 * nextHourMw;
    const spread = Math.max(sd[h] ?? 0, 0.03 * load) * (1 + k / 24);
    const capP = capProf[h];
    const cap = capSpanDays >= 2 && capP.w ? capP.s / capP.w : availableMw;
    rows.push({ time: isoAST(t), load_forecast_mw: Math.round(load), load_low_mw: Math.round(load - 1.28 * spread), load_high_mw: Math.round(load + 1.28 * spread),
      capacity_forecast_mw: Number.isFinite(cap) ? Math.round(cap) : null, reserve_forecast_mw: Number.isFinite(cap) ? Math.round(cap - load) : null });
  }
  const peak = rows.reduce((a, r) => (r.load_forecast_mw > a.load_forecast_mw ? r : a), rows[0]);
  const minRes = rows.filter((r) => r.reserve_forecast_mw != null).reduce((a, r) => (!a || r.reserve_forecast_mw < a.reserve_forecast_mw ? r : a), null);
  return { rows, summary: { status: 'ok', generated_at: isoAST(NOW),
    method: 'Hour-of-day load profile (recent days weighted more), adjusted to the current level and blended with PREPA’s next-hour figure. Capacity follows its own hour-of-day profile once two days of history exist; until then it is held at the current available capacity.',
    observations: obs.length, history_days: Math.round(capSpanDays * 10) / 10, peak_forecast_mw: peak.load_forecast_mw, peak_forecast_time: peak.time,
    min_reserve_mw: minRes ? minRes.reserve_forecast_mw : null, min_reserve_time: minRes ? minRes.time : null } };
}


/* ---------------- Daily summary ---------------- */
const FUEL_KEYS = [['lng', 'LNG'], ['bunker_c', 'Bunker C'], ['ulsd', 'Diesel (ULSD)'], ['coal', 'Coal'], ['solar', 'Solar'], ['wind', 'Wind'], ['hydro', 'Hydro'], ['landfill_gas', 'Landfill gas']];
function summarizeDay(day, checks, trace, events, fev, L, complete, now) {
  now = now || new Date();
  const t = (iso) => new Date(iso).getTime();
  const dayStart = t(day + 'T00:00:00-04:00'), dayEnd = dayStart + DAY;
  const cs = checks.filter((c) => Number.isFinite(c.total_mw)).sort((a, b) => t(a.at) - t(b.at));
  const gaps = cs.slice(1).map((c, i) => (t(c.at) - t(cs[i].at)) / 3600000).filter((x) => x > 0).sort((a, b) => a - b);
  const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0.25;
  const w = cs.map((c, i) => { const next = cs[i + 1] ? t(cs[i + 1].at) : Math.min(dayEnd, t(c.at) + typical * 3600000); return Math.max(0, Math.min((next - t(c.at)) / 3600000, 1)); });
  const coverage = w.reduce((a, b) => a + b, 0);
  const ext = (arr, k, f) => arr.reduce((a, r) => (a == null || f(r[k], a[k]) ? r : a), null);
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  const hhmm = (iso) => (iso ? iso.slice(11, 16) : null);
  const dmax = ext(cs, 'total_mw', (a, b) => a > b), dmin = ext(cs, 'total_mw', (a, b) => a < b);
  const tr = trace.filter((r) => Number.isFinite(r.generation_mw));
  const gmax = ext(tr, 'generation_mw', (a, b) => a > b), gmin = ext(tr, 'generation_mw', (a, b) => a < b);
  const fr = trace.filter((r) => Number.isFinite(r.frequency_hz));
  const inNormal = L ? fr.filter((r) => r.frequency_hz >= L.bands[0].low && r.frequency_hz <= L.bands[0].high).length : null;
  const energy = {}; let costSum = 0, energySum = 0;
  cs.forEach((c, i) => {
    for (const [k] of FUEL_KEYS) { const mw = Number(c['mw_' + k]) || 0; energy[k] = (energy[k] || 0) + mw * w[i]; energySum += mw * w[i]; }
    costSum += (Number(c.dispatch_cost_usd_h) || 0) * w[i];
  });
  const share = (k) => (energySum ? r1(((energy[k] || 0) / energySum) * 100) : null);
  const maj = FUEL_KEYS.reduce((a, [k, n]) => ((energy[k] || 0) > (a.e || 0) ? { k, n, e: energy[k] } : a), {});
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const tw = (k) => (coverage ? cs.reduce((a, c, i) => a + (Number(c[k]) || 0) * w[i], 0) / coverage : null);
  return {
    day, status: complete ? (coverage >= 20 ? 'Complete' : 'Ended, partial data') : 'In progress', updated_at: isoAST(now), coverage_h: r1(coverage), checks: cs.length, trace_readings: tr.length,
    demand_max_mw: dmax ? dmax.total_mw : null, demand_max_at: dmax ? hhmm(dmax.at) : null, demand_min_mw: dmin ? dmin.total_mw : null, demand_min_at: dmin ? hhmm(dmin.at) : null,
    demand_avg_mw: tw('total_mw') == null ? null : Math.round(tw('total_mw')), prepa_peak_mw: cs.reduce((a, c) => Math.max(a, Number(c.peak_today_mw) || 0), 0) || null,
    gen_max_mw: gmax ? gmax.generation_mw : null, gen_max_at: gmax ? hhmm(gmax.time) : null, gen_min_mw: gmin ? gmin.generation_mw : null, gen_min_at: gmin ? hhmm(gmin.time) : null,
    gen_avg_mw: tr.length ? Math.round(avg(tr.map((r) => r.generation_mw))) : null, gen_energy_mwh: tr.length ? Math.round(tr.reduce((a, r) => a + r.generation_mw * (5 / 60), 0)) : null,
    freq_max_hz: fr.length ? Math.max(...fr.map((r) => r.frequency_hz)) : null, freq_min_hz: fr.length ? Math.min(...fr.map((r) => r.frequency_hz)) : null,
    freq_avg_hz: fr.length ? Math.round(avg(fr.map((r) => r.frequency_hz)) * 1000) / 1000 : null, freq_normal_pct: fr.length && inNormal != null ? r1((inNormal / fr.length) * 100) : null,
    freq_excursions: fev.length, majority_fuel: maj.n || null,
    share_lng_pct: share('lng'), share_bunker_c_pct: share('bunker_c'), share_ulsd_pct: share('ulsd'), share_coal_pct: share('coal'),
    share_renewable_pct: energySum ? r1((((energy.solar || 0) + (energy.wind || 0) + (energy.landfill_gas || 0)) / energySum) * 100) : null, share_hydro_pct: share('hydro'),
    energy_by_fuel_mwh: Object.fromEntries(FUEL_KEYS.map(([k]) => [k, Math.round(energy[k] || 0)])),
    total_cost_usd: Math.round(costSum), cost_full_day_estimate_usd: coverage ? Math.round((costSum / coverage) * 24) : null,
    avg_cost_usd_per_kwh: energySum ? Math.round((costSum / (energySum * 1000)) * 10000) / 10000 : null,
    units_went_offline: events.filter((e) => e.event === 'Went offline').length, units_came_back: events.filter((e) => e.event === 'Back online').length,
    plant_energy_mwh: (() => { const o = {}; cs.forEach((c, i) => { for (const [p, mw] of Object.entries(c.plant_mw || {})) o[p] = (o[p] || 0) + mw * w[i]; }); for (const p in o) o[p] = Math.round(o[p]); return o; })(),
  };
}

/* ---------------- One summary row per feed snapshot (hourly log) ---------------- */
function buildHistoryRow(src, graph, now) {
  const met = (i) => { const m = src.metrics.find((x) => x.index === i); return m && m.value != null ? m.value : null; };
  const gen = src.units.filter((u) => u.status === 'Generating');
  const genera = src.units.filter((u) => u.operator === 'Genera PR');
  const sum = (a, f) => a.reduce((s, u) => s + f(u), 0);
  const costMW = (a) => sum(a.filter((u) => u.status === 'Generating' && u.cost_cents_kwh > 0), (u) => u.mw);
  const slug = (f) => f.toLowerCase().replace(/ \(diesel\)/, '').replace(/[^a-z]+/g, '_');
  const generaGen = genera.filter((u) => u.status === 'Generating');
  const row = { at: src.snap, fetched_at: isoAST(now), total_mw: met(0), available_mw: met(7), spinning_mw: met(5), operating_mw: met(6), next_hour_mw: met(8), peak_today_mw: met(9),
    fossil_pct: met(3), renewable_pct: met(4), prepa_pct: met(1), ppoa_pct: met(2),
    units_total: src.units.length, units_offline: src.units.filter((u) => u.status !== 'Generating').length,
    genera_mw: Math.round(sum(genera, (u) => u.mw) * 10) / 10, genera_units_total: genera.length, genera_units_offline: genera.filter((u) => u.status !== 'Generating').length,
    dispatch_cost_usd_h: Math.round(sum(gen, (u) => u.cost_usd_per_hour)),
    avg_cents_kwh: costMW(src.units) ? Math.round((sum(gen, (u) => u.cost_usd_per_hour) / (costMW(src.units) * 10)) * 100) / 100 : null,
    genera_avg_cents_kwh: costMW(genera) ? Math.round((sum(generaGen, (u) => u.cost_usd_per_hour) / (costMW(genera) * 10)) * 100) / 100 : null,
    frequency_hz: graph ? ((graph.rows.filter((r) => Number.isFinite(r.frequency_hz)).pop() || {}).frequency_hz ?? null) : null };
  for (const u of gen) { const k = slug(u.fuel); row['mw_' + k] = Math.round(((row['mw_' + k] || 0) + u.mw) * 10) / 10; row['cost_' + k] = Math.round((row['cost_' + k] || 0) + u.cost_usd_per_hour); }
  // per-plant output and cost (hydro, solar, wind and landfill grouped), for the plant chart and map
  row.plant_mw = {}; row.plant_cost = {};
  for (const u of src.units) {
    const g = plantGroup(u.plant);
    row.plant_mw[g] = Math.round(((row.plant_mw[g] || 0) + Math.max(0, u.mw)) * 10) / 10;
    if (u.status === 'Generating') row.plant_cost[g] = Math.round((row.plant_cost[g] || 0) + u.cost_usd_per_hour);
  }
  return row;
}
function plantGroup(plant) { return /\(hydro\)$/.test(plant) ? 'Hydro' : plant === 'Landfill' ? 'Landfill gas' : plant; }
/* ---------------- Compact unit snapshot for the hourly archive ---------------- */
function archiveSnapshot(src) {
  return { at: src.snap, units: src.units.map((u) => [u.unit_id, Math.round(u.mw * 100) / 100, Math.round(u.mvar * 100) / 100, u.cost_cents_kwh, u.status === 'Generating' ? 1 : 0]) };
}

root.PREPA = { summarizeDay, plantGroup, FUEL_KEYS, buildForecast, num, DAY, pad, isoAST, parseFeed, parseStamp, processSource, processGraph, freqLevel, detectExcursions, mergeExcursions, allowanceStatus, buildHistoryRow, archiveSnapshot, RANK, OFFLINE_MW };
})(typeof globalThis !== 'undefined' ? globalThis : window);
