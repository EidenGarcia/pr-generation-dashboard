#!/usr/bin/env node
/*
 * Hourly updater for the Puerto Rico generation dashboards.
 * Fetches PREPA's public operational feeds, parses them WITHOUT executing them,
 * and writes JSON files into ./data for the static pages to read.
 *
 *   dataSource.js  -> every plant and unit (MW, MVAr, cost), metrics, fuel mix, fuel prices
 *   dataGraph.js   -> last 24 hours of generation (and frequency) at 5-minute steps
 *
 * Usage:      node scripts/update.mjs [dataDir]
 * Local test: LOCAL_DATASOURCE=file.js LOCAL_DATAGRAPH=file.js node scripts/update.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const DATA = path.resolve(process.argv[2] || 'data');
const SOURCES = {
  dataSource: 'https://operationdata.prepa.pr.gov/dataSource.js',
  dataGraph: 'https://operationdata.prepa.pr.gov/dataGraph.js',
};
const LOCAL = { dataSource: process.env.LOCAL_DATASOURCE, dataGraph: process.env.LOCAL_DATAGRAPH };
const NOW = process.env.NOW_OVERRIDE ? new Date(process.env.NOW_OVERRIDE) : new Date();
const DAY = 86400000;

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return d; } };
const writeJSON = (f, v) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(v));
const pad = (n) => String(n).padStart(2, '0');
// Puerto Rico is UTC-4 all year (no daylight saving).
const isoAST = (d) => new Date(d.getTime() - 4 * 3600000).toISOString().slice(0, 19) + '-04:00';
const astHour = (d) => new Date(d.getTime() - 4 * 3600000).getUTCHours();

/* ---------------- HTTP ---------------- */
function get(url, insecure = false) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: '*/*', Referer: 'https://operationdata.prepa.pr.gov/',
      },
      rejectUnauthorized: !insecure, timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ ok: res.statusCode === 200 && buf.length > 0, status: res.statusCode, ms: Date.now() - t0, bytes: buf.length, text: buf.toString('utf8') });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, status: 0, ms: Date.now() - t0, bytes: 0, error: e.code || e.message }));
  });
}
async function fetchFeed(name) {
  if (LOCAL[name]) return { ok: true, status: 200, ms: 0, bytes: fs.statSync(LOCAL[name]).size, text: fs.readFileSync(LOCAL[name], 'utf8'), local: true };
  let r;
  for (let i = 0; i < 3; i++) {
    r = await get(SOURCES[name]);
    // PREPA's certificate chain has been incomplete at times; retry without verification (read-only public data).
    if (!r.ok && /CERT|SELF_SIGNED|UNABLE_TO|certificate/i.test(r.error || '')) r = await get(SOURCES[name], true);
    if (r.ok) break;
    await new Promise((s) => setTimeout(s, 5000 * (i + 1)));
  }
  return r;
}

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
function buildForecast({ graphRows, history, nextHourMw, availableMw, demandNow }) {
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

/* ---------------- main ---------------- */
const health = readJSON('feed_health.json', []);
const status = (readJSON('status.json', [{}])[0]) || {};
const history = readJSON('history.json', []);
const prevUnits = readJSON('live_units.json', []);
let events = readJSON('unit_events.json', []);
const prevForecast = readJSON('forecast.json', []);
status.last_run = isoAST(NOW);
status.runner = process.env.GITHUB_ACTIONS ? 'GitHub Actions' : 'manual';

const results = {}, healthIdx = {};
for (const name of ['dataSource', 'dataGraph']) {
  const r = await fetchFeed(name);
  results[name] = r;
  if (!r.local) { health.push({ at: isoAST(NOW), feed: name, ok: !!r.ok, http_status: r.status, ms: r.ms, bytes: r.bytes, error: r.ok ? null : (r.error || `HTTP ${r.status}`) }); healthIdx[name] = health.length - 1; }
  console.log(name, r.ok ? 'OK' : 'FAILED', r.status, r.ms + 'ms', r.error || '');
}
const markParseError = (name, e) => { const h = health[healthIdx[name]]; if (h) { h.ok = false; h.error = 'parse: ' + e.message; } };

let src = null;
if (results.dataSource.ok) {
  try { src = processSource(parseFeed(results.dataSource.text)); }
  catch (e) { console.error('dataSource parse error:', e.message); markParseError('dataSource', e); }
}
let graph = null;
if (results.dataGraph.ok) {
  try { graph = processGraph(parseFeed(results.dataGraph.text), NOW); if (!graph.rows.length) throw new Error('no time series found'); }
  catch (e) { console.error('dataGraph parse error:', e.message); markParseError('dataGraph', e); graph = null; }
}

if (src) {
  const prevSnap = prevUnits[0] && prevUnits[0].snapshot;
  const h = health[healthIdx.dataSource];
  if (h) { h.feed_time = src.snap; h.feed_age_min = Math.round((NOW.getTime() - new Date(src.snap).getTime()) / 60000); h.feed_changed = src.snap !== prevSnap; }
  // Outage log: compare with the previous capture.
  if (!events.length) events.push({ event_id: 'baseline|' + src.snap, detected_at: src.snap, previous_snapshot: null, plant: 'All units', unit: '—', operator: '—', fuel: '—', event: 'Baseline captured', mw_before: null, mw_after: null });
  if (prevSnap && prevSnap !== src.snap) {
    const pm = new Map(prevUnits.map((u) => [u.unit_id, u]));
    for (const u of src.units) {
      const p = pm.get(u.unit_id); if (!p || p.status === u.status) continue;
      events.push({ event_id: `${src.snap}|${u.unit_id}`, detected_at: src.snap, previous_snapshot: prevSnap, plant: u.plant, unit: u.unit, operator: u.operator, fuel: u.fuel,
        event: u.status === 'Offline' ? 'Went offline' : 'Back online', mw_before: p.mw, mw_after: u.mw });
    }
  }
  events = events.slice(-5000);
  writeJSON('live_units.json', src.units); writeJSON('live_metrics.json', src.metrics);
  writeJSON('live_fuel_mix.json', src.mix); writeJSON('live_fuel_price.json', src.prices);
  writeJSON('unit_events.json', events);

  // One history row per feed snapshot.
  const met = (i) => { const m = src.metrics.find((x) => x.index === i); return m && m.value != null ? m.value : null; };
  const gen = src.units.filter((u) => u.status === 'Generating');
  const genera = src.units.filter((u) => u.operator === 'Genera PR');
  const sum = (a, f) => a.reduce((s, u) => s + f(u), 0);
  const costMW = (a) => sum(a.filter((u) => u.status === 'Generating' && u.cost_cents_kwh > 0), (u) => u.mw);
  const slug = (f) => f.toLowerCase().replace(/ \(diesel\)/, '').replace(/[^a-z]+/g, '_');
  const generaGen = genera.filter((u) => u.status === 'Generating');
  const row = { at: src.snap, fetched_at: isoAST(NOW), total_mw: met(0), available_mw: met(7), spinning_mw: met(5), operating_mw: met(6), next_hour_mw: met(8), peak_today_mw: met(9),
    fossil_pct: met(3), renewable_pct: met(4), prepa_pct: met(1), ppoa_pct: met(2),
    units_total: src.units.length, units_offline: src.units.filter((u) => u.status !== 'Generating').length,
    genera_mw: Math.round(sum(genera, (u) => u.mw) * 10) / 10, genera_units_total: genera.length, genera_units_offline: genera.filter((u) => u.status !== 'Generating').length,
    dispatch_cost_usd_h: Math.round(sum(gen, (u) => u.cost_usd_per_hour)),
    avg_cents_kwh: costMW(src.units) ? Math.round((sum(gen, (u) => u.cost_usd_per_hour) / (costMW(src.units) * 10)) * 100) / 100 : null,
    genera_avg_cents_kwh: costMW(genera) ? Math.round((sum(generaGen, (u) => u.cost_usd_per_hour) / (costMW(genera) * 10)) * 100) / 100 : null,
    frequency_hz: graph ? ((graph.rows.filter((r) => Number.isFinite(r.frequency_hz)).pop() || {}).frequency_hz ?? null) : null };
  for (const u of gen) { const k = slug(u.fuel); row['mw_' + k] = Math.round(((row['mw_' + k] || 0) + u.mw) * 10) / 10; row['cost_' + k] = Math.round((row['cost_' + k] || 0) + u.cost_usd_per_hour); }
  // What the previous run forecast for this hour, so forecast accuracy can be tracked.
  const pf = prevForecast.find((r) => r.time && r.time.slice(0, 13) === src.snap.slice(0, 13));
  row.forecast_load_mw = pf ? pf.load_forecast_mw : null;
  const i = history.findIndex((x) => x.at === row.at);
  if (i >= 0) history[i] = row; else history.push(row);
  status.feed_time = src.snap; status.last_ok_dataSource = isoAST(NOW);
}
if (graph) {
  const LIMITS = (readJSON('frequency_limits.json', [])[0]) || null;
  if (LIMITS) {
    const { episodes, step } = detectExcursions(graph.rows, LIMITS);
    const merged = mergeExcursions(readJSON('frequency_events.json', []), episodes, step)
      .filter((e) => new Date(e.start).getTime() >= NOW.getTime() - 90 * DAY);
    writeJSON('frequency_events.json', merged);
    const f1h = graph.rows.filter((r) => Number.isFinite(r.frequency_hz) && NOW.getTime() - new Date(r.time).getTime() <= 3600000);
    const last = history.find((x) => src && x.at === src.snap);
    if (last && f1h.length) { last.freq_min_1h = Math.min(...f1h.map((r) => r.frequency_hz)); last.freq_max_1h = Math.max(...f1h.map((r) => r.frequency_hz)); last.freq_level = freqLevel(f1h[f1h.length - 1].frequency_hz, LIMITS); }
    console.log('frequency excursions in trace:', episodes.length, 'logged total:', merged.length);
  }
  writeJSON('live_graph.json', graph.rows); writeJSON('graph_meta.json', [{ ...graph.meta, captured_at: isoAST(NOW) }]);
  status.last_ok_dataGraph = isoAST(NOW);
}

// Keep 90 days of history and 30 days of portal checks.
const cut = (d) => NOW.getTime() - d * DAY;
const hist = history.filter((x) => new Date(x.at).getTime() >= cut(90)).sort((a, b) => (a.at < b.at ? -1 : 1));
writeJSON('history.json', hist);
writeJSON('feed_health.json', health.filter((x) => new Date(x.at).getTime() >= cut(30)));

// Forecast for the next 24 hours.
const lastHist = hist[hist.length - 1] || {};
const graphRows = graph ? graph.rows : readJSON('live_graph.json', []).filter((r) => r.time);
const fc = buildForecast({ graphRows, history: hist, nextHourMw: lastHist.next_hour_mw, availableMw: lastHist.available_mw, demandNow: lastHist.total_mw });
if (fc.rows.length) writeJSON('forecast.json', fc.rows);
writeJSON('forecast_summary.json', [fc.summary]);

let streak = 0;
for (const h of health.slice().reverse()) { if (h.feed !== 'dataSource') continue; if (h.ok) break; streak++; }
status.consecutive_failures = streak;
writeJSON('status.json', [status]);
console.log('done', { snapshot: src && src.snap, graphRows: graph ? graph.rows.length : 0, events: events.length, history: hist.length, forecast: fc.rows.length });
