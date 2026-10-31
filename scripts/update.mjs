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
import { fileURLToPath } from 'node:url';
await import(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'prepa-core.js'));
const { summarizeDay, FUEL_KEYS, buildForecast, parseFeed, processSource, processGraph, freqLevel, detectExcursions, mergeExcursions, buildHistoryRow, OFFLINE_MW } = globalThis.PREPA;

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

function dailyText(s, events) {
  const n = (v, u = '', d = 0) => (v == null ? 'n/a' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) + u);
  const usd = (v) => (v == null ? 'n/a' : '$' + Number(v).toLocaleString('en-US'));
  const dt = new Date(s.day + 'T12:00:00-04:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Puerto_Rico' });
  const L = [];
  L.push('PUERTO RICO GENERATION - DAILY SUMMARY');
  L.push('Date ............ ' + dt + ' (Puerto Rico time, UTC-4)');
  L.push('Status .......... ' + s.status + ' (updated ' + s.updated_at.replace('T', ' ').slice(0, 16) + ' AST)');
  L.push('Coverage ........ ' + n(s.coverage_h, ' h', 1) + ' of feed checks (' + s.checks + ' checks), ' + s.trace_readings + ' five-minute readings');
  L.push('');
  L.push('DEMAND (PREPA total generation at each check)');
  L.push('  Maximum ....... ' + n(s.demand_max_mw, ' MW') + (s.demand_max_at ? ' at ' + s.demand_max_at : ''));
  L.push('  Minimum ....... ' + n(s.demand_min_mw, ' MW') + (s.demand_min_at ? ' at ' + s.demand_min_at : ''));
  L.push('  Average ....... ' + n(s.demand_avg_mw, ' MW'));
  L.push('  PREPA peak .... ' + n(s.prepa_peak_mw, ' MW') + ' (as reported by PREPA)');
  L.push('');
  L.push('GENERATION (5-minute readings, dataGraph.js)');
  L.push('  Maximum ....... ' + n(s.gen_max_mw, ' MW', 1) + (s.gen_max_at ? ' at ' + s.gen_max_at : ''));
  L.push('  Minimum ....... ' + n(s.gen_min_mw, ' MW', 1) + (s.gen_min_at ? ' at ' + s.gen_min_at : ''));
  L.push('  Average ....... ' + n(s.gen_avg_mw, ' MW'));
  L.push('  Energy ........ ' + n(s.gen_energy_mwh, ' MWh'));
  L.push('');
  L.push('FREQUENCY (5-minute readings)');
  L.push('  Maximum ....... ' + n(s.freq_max_hz, ' Hz', 2));
  L.push('  Minimum ....... ' + n(s.freq_min_hz, ' Hz', 2));
  L.push('  Average ....... ' + n(s.freq_avg_hz, ' Hz', 3));
  L.push('  In Normal band  ' + n(s.freq_normal_pct, ' %', 1) + '   Excursions: ' + s.freq_excursions);
  L.push('');
  L.push('FUEL USE (share of energy, time-weighted from unit outputs)');
  for (const [k, name] of FUEL_KEYS) { const e = s.energy_by_fuel_mwh[k]; if (!e) continue; L.push('  ' + (name + ' ').padEnd(16, '.') + ' ' + n(s.energy_by_fuel_mwh[k], ' MWh').padStart(12) + '   ' + n((e / Object.values(s.energy_by_fuel_mwh).reduce((a, b) => a + b, 0)) * 100, ' %', 1)); }
  L.push('  Majority fuel . ' + (s.majority_fuel || 'n/a'));
  L.push('');
  L.push('COST (dispatch cost: MW x each unit\'s reported cost)');
  L.push('  Total cost of the day ... ' + usd(s.total_cost_usd) + ' over ' + n(s.coverage_h, ' h', 1) + (s.coverage_h < 23.5 ? '  (full-day estimate ' + usd(s.cost_full_day_estimate_usd) + ')' : ''));
  L.push('  Average cost ............ ' + (s.avg_cost_usd_per_kwh == null ? 'n/a' : '$' + s.avg_cost_usd_per_kwh.toFixed(4) + ' per kWh'));
  L.push('');
  L.push('OUTAGES (units that stopped or restarted)');
  L.push('  Went offline: ' + s.units_went_offline + '   Came back: ' + s.units_came_back);
  for (const e of events) L.push('  ' + e.detected_at.slice(11, 16) + '  ' + (e.event === 'Went offline' ? 'OFFLINE' : 'ONLINE ') + '  ' + e.plant + ' / ' + e.unit + '  ' + Number(e.mw_before).toFixed(1) + ' -> ' + Number(e.mw_after).toFixed(1) + ' MW');
  L.push('');
  L.push('Sources: PREPA operational data (dataSource.js, dataGraph.js). Generated automatically by the GitHub Action.');
  return L.join('\n') + '\n';
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

let src = null, newEvents = [];
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
  const eventsBefore = events.length;
  const gapH = prevSnap ? (new Date(src.snap) - new Date(prevSnap)) / 3600000 : 0;
  if (prevSnap && gapH > 3) {
    // Too long since the last reading to say when a unit changed: start a fresh baseline instead of logging stale changes.
    events.push({ event_id: 'baseline|' + src.snap, detected_at: src.snap, previous_snapshot: prevSnap, plant: 'All units', unit: '—', operator: '—', fuel: '—', event: 'Monitoring resumed after ' + Math.round(gapH) + ' h gap', mw_before: null, mw_after: null });
  } else if (prevSnap && prevSnap !== src.snap) {
    const pm = new Map(prevUnits.map((u) => [u.unit_id, u]));
    for (const u of src.units) {
      const p = pm.get(u.unit_id); if (!p || p.status === u.status) continue;
      events.push({ event_id: `${src.snap}|${u.unit_id}`, detected_at: src.snap, previous_snapshot: prevSnap, plant: u.plant, unit: u.unit, operator: u.operator, fuel: u.fuel,
        event: u.status === 'Offline' ? 'Went offline' : 'Back online', mw_before: p.mw, mw_after: u.mw });
    }
  }
  newEvents = events.slice(eventsBefore).filter((e) => e.event === 'Went offline' || e.event === 'Back online');
  // keep 7 days in the page data; the text logs keep everything
  events = events.filter((e) => new Date(e.detected_at).getTime() >= NOW.getTime() - 7 * DAY);
  writeJSON('live_units.json', src.units); writeJSON('live_metrics.json', src.metrics);
  writeJSON('live_fuel_mix.json', src.mix); writeJSON('live_fuel_price.json', src.prices);
  writeJSON('unit_events.json', events);
  // Observed operating range of each unit while generating (for the gauges).
  const ranges = readJSON('unit_ranges.json', {});
  for (const u of src.units) if (u.status === 'Generating') {
    const r = ranges[u.unit_id] || { min_on_mw: u.mw, max_on_mw: u.mw, since: src.snap };
    r.min_on_mw = Math.min(r.min_on_mw, u.mw); r.max_on_mw = Math.max(r.max_on_mw, u.mw); ranges[u.unit_id] = r;
  }
  writeJSON('unit_ranges.json', ranges);

  // One history row per feed snapshot.
  const row = buildHistoryRow(src, graph, NOW);
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
  if (graph.temperature_f != null) { status.temperature_f = graph.temperature_f; status.temperature_at = isoAST(NOW); }
}

// Keep 90 days of history and 30 days of portal checks.
const cut = (d) => NOW.getTime() - d * DAY;
const hist = history.filter((x) => new Date(x.at).getTime() >= cut(2)).sort((a, b) => (a.at < b.at ? -1 : 1));
writeJSON('history.json', hist);
writeJSON('feed_health.json', health.filter((x) => new Date(x.at).getTime() >= cut(30)));

/* ---------- Daily files, summaries and text logs ---------- */
const DAYS = path.join(DATA, 'days'), LOGS = path.resolve(DATA, '..', 'logs');
fs.mkdirSync(DAYS, { recursive: true }); fs.mkdirSync(path.join(LOGS, 'daily'), { recursive: true }); fs.mkdirSync(path.join(LOGS, 'outages'), { recursive: true });
const touched = new Set();
const dayFile = (d) => path.join(DAYS, d + '.json');
const readDay = (d) => { try { return JSON.parse(fs.readFileSync(dayFile(d), 'utf8')); } catch { return { day: d, checks: [], trace: [] }; } };
const dayCache = new Map(); const getDay = (d) => { if (!dayCache.has(d)) dayCache.set(d, readDay(d)); return dayCache.get(d); };
if (src) { const row = history.find((x) => x.at === src.snap); if (row) { const D = getDay(row.at.slice(0, 10)); if (!D.checks.some((c) => c.at === row.at)) D.checks.push(row); else D.checks = D.checks.map((c) => (c.at === row.at ? row : c)); touched.add(row.at.slice(0, 10)); } }
const slotOf = (iso) => Math.floor(new Date(iso).getTime() / 300000);
const slotMapOf = (D) => { if (!D._map) { D._map = new Map(); for (const x of D.trace) D._map.set(slotOf(x.time), x); } return D._map; };
if (graph) for (const r of graph.rows) { const d = r.time.slice(0, 10); const D = getDay(d); slotMapOf(D).set(slotOf(r.time), r); touched.add(d); }
// one-time clean-up: days saved before traces were stored by slot, and summaries from before the energy fix
for (const f of fs.readdirSync(DAYS).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x))) {
  const d = f.slice(0, 10), old = (readJSON('daily_summary.json', []).find((x) => x.day === d) || {});
  if (old.calc_version !== 2) { slotMapOf(getDay(d)); touched.add(d); }
}
for (const [d, D] of dayCache) { if (D._map) { D.trace = [...D._map.values()].sort((a, b) => (a.time < b.time ? -1 : 1)); delete D._map; } D.checks.sort((a, b) => (a.at < b.at ? -1 : 1)); fs.writeFileSync(dayFile(d), JSON.stringify(D)); }
// remove day files older than 35 days
for (const f of fs.readdirSync(DAYS)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < isoAST(new Date(NOW.getTime() - 35 * DAY)).slice(0, 10)) fs.unlinkSync(path.join(DAYS, f));

// Outage text log: one line per change, one file per day.
const pad2 = (n) => String(n).padStart(2, '0');
for (const e of newEvents) {
  const line = `${e.detected_at.slice(0, 10)} ${e.detected_at.slice(11, 16)} AST  ${e.event === 'Went offline' ? 'OFFLINE ' : 'ONLINE  '}  ${(e.plant + ' / ' + e.unit).padEnd(36)} ${String(Number(e.mw_before).toFixed(1)).padStart(7)} MW -> ${String(Number(e.mw_after).toFixed(1)).padStart(7)} MW  (${e.operator}, ${e.fuel}; previous check ${e.previous_snapshot ? e.previous_snapshot.slice(11, 16) : '-'})\n`;
  const f = path.join(LOGS, 'outages', e.detected_at.slice(0, 10) + '.log');
  if (!fs.existsSync(f)) fs.writeFileSync(f, `# Unit outage log, ${e.detected_at.slice(0, 10)} (Puerto Rico time, UTC-4)\n# A unit counts as offline below ${OFFLINE_MW} MW. Times are when the change was first seen; it happened after the previous check.\n`);
  fs.appendFileSync(f, line);
}

// Daily summaries for every day touched by this run.
const LIM = (readJSON('frequency_limits.json', [])[0]) || null;
const summaries = readJSON('daily_summary.json', []);
const todayAST = isoAST(NOW).slice(0, 10);
// close off days that ended since the last run
for (const sm of summaries) if (sm.status === 'In progress' && sm.day < todayAST && fs.existsSync(dayFile(sm.day))) touched.add(sm.day);
for (const d of touched) {
  const D = getDay(d);
  const allEvents = readJSON('unit_events.json', []).filter((e) => e.detected_at.slice(0, 10) === d && (e.event === 'Went offline' || e.event === 'Back online'));
  const fev = readJSON('frequency_events.json', []).filter((e) => e.start.slice(0, 10) === d);
  const sm = summarizeDay(d, D.checks, D.trace, allEvents, fev, LIM, d < todayAST, NOW);
  const i = summaries.findIndex((x) => x.day === d); if (i >= 0) summaries[i] = sm; else summaries.push(sm);
  fs.writeFileSync(path.join(LOGS, 'daily', d + '.txt'), dailyText(sm, allEvents));
}
summaries.sort((a, b) => (a.day < b.day ? -1 : 1));
writeJSON('daily_summary.json', summaries.slice(-400));
const CSV_COLS = ['day', 'status', 'coverage_h', 'checks', 'demand_max_mw', 'demand_max_at', 'demand_min_mw', 'demand_min_at', 'demand_avg_mw', 'prepa_peak_mw', 'gen_max_mw', 'gen_max_at', 'gen_min_mw', 'gen_min_at', 'gen_avg_mw', 'gen_energy_mwh', 'freq_max_hz', 'freq_min_hz', 'freq_avg_hz', 'freq_normal_pct', 'freq_excursions', 'majority_fuel', 'share_lng_pct', 'share_bunker_c_pct', 'share_ulsd_pct', 'share_coal_pct', 'share_renewable_pct', 'share_hydro_pct', 'total_cost_usd', 'cost_full_day_estimate_usd', 'avg_cost_usd_per_kwh', 'units_went_offline', 'units_came_back'];
fs.writeFileSync(path.join(LOGS, 'daily_summary.csv'), CSV_COLS.join(',') + '\n' + summaries.map((s) => CSV_COLS.map((c) => (s[c] == null ? '' : String(s[c]).includes(',') ? '"' + s[c] + '"' : s[c])).join(',')).join('\n') + '\n');

// Continuous 5-minute trace for the last 8 days (each run saves PREPA's full 24-hour trace, so this has no gaps
// even when runs are hours apart). Overlapping traces are averaged into 5-minute slots.
{
  const slots = new Map();
  const from = isoAST(new Date(NOW.getTime() - 8 * DAY)).slice(0, 10);
  for (const f of fs.readdirSync(DAYS).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x) && x.slice(0, 10) >= from)) {
    const D = dayCache.get(f.slice(0, 10)) || JSON.parse(fs.readFileSync(path.join(DAYS, f), 'utf8'));
    for (const r of D.trace || []) {
      const t = Math.floor(new Date(r.time).getTime() / 300000) * 300000;
      const o = slots.get(t) || { g: 0, gn: 0, f: 0, fn: 0 };
      if (Number.isFinite(r.generation_mw)) { o.g += r.generation_mw; o.gn++; }
      if (Number.isFinite(r.frequency_hz)) { o.f += r.frequency_hz; o.fn++; }
      slots.set(t, o);
    }
  }
  const rows = [...slots.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => t >= NOW.getTime() - 8 * DAY)
    .map(([t, o]) => ({ time: isoAST(new Date(t)), generation_mw: o.gn ? Math.round((o.g / o.gn) * 10) / 10 : null, frequency_hz: o.fn ? Math.round((o.f / o.fn) * 100) / 100 : null }));
  writeJSON('trace_recent.json', rows);
}

// Hourly average output per plant, 35 days, for the long-range plant chart.
{
  const ph = readJSON('plant_hourly.json', []);
  const byHour = new Map(ph.map((r) => [r.at, r]));
  for (const d of touched) {
    const D = getDay(d);
    for (const [hr, list] of Object.entries(D.checks.reduce((m, c) => { (m[c.at.slice(0, 13)] = m[c.at.slice(0, 13)] || []).push(c); return m; }, {}))) {
      const plants = {}, fuels = {}; let total = 0;
      for (const c of list) { for (const [p, mw] of Object.entries(c.plant_mw || {})) plants[p] = (plants[p] || 0) + mw / list.length; for (const [k] of FUEL_KEYS) fuels[k] = (fuels[k] || 0) + (Number(c['mw_' + k]) || 0) / list.length; total += (Number(c.total_mw) || 0) / list.length; }
      for (const p in plants) plants[p] = Math.round(plants[p] * 10) / 10;
      const avgOf = (k) => { const v = list.map((c) => Number(c[k])).filter(Number.isFinite); return v.length ? Math.round((v.reduce((x, y) => x + y, 0) / v.length) * 10) / 10 : null; };
      const row = { at: hr + ':00:00-04:00', hourly: true, n: list.length, total_mw: Math.round(total), plant_mw: plants,
        genera_units_offline: avgOf('genera_units_offline'), genera_units_total: avgOf('genera_units_total'), spinning_mw: avgOf('spinning_mw'), available_mw: avgOf('available_mw') };
      for (const k in fuels) row['mw_' + k] = Math.round(fuels[k] * 10) / 10;
      byHour.set(row.at, row);
    }
  }
  writeJSON('plant_hourly.json', [...byHour.values()].filter((r) => new Date(r.at).getTime() >= NOW.getTime() - 35 * DAY).sort((a, b) => (a.at < b.at ? -1 : 1)));
}

// Forecast for the next 24 hours.
const lastHist = hist[hist.length - 1] || {};
const graphRows = graph ? graph.rows : readJSON('live_graph.json', []).filter((r) => r.time);
const fc = buildForecast({ graphRows, history: hist, nextHourMw: lastHist.next_hour_mw, availableMw: lastHist.available_mw, demandNow: lastHist.total_mw, now: NOW });
if (fc.rows.length) writeJSON('forecast.json', fc.rows);
writeJSON('forecast_summary.json', [fc.summary]);

let streak = 0;
for (const h of health.slice().reverse()) { if (h.feed !== 'dataSource') continue; if (h.ok) break; streak++; }
status.consecutive_failures = streak;
writeJSON('status.json', [status]);
console.log('done', { snapshot: src && src.snap, graphRows: graph ? graph.rows.length : 0, events: events.length, history: hist.length, forecast: fc.rows.length });
