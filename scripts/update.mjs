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
const { processLevels, summarizeDay, FUEL_KEYS, buildForecast, parseFeed, processSource, processGraph, freqLevel, detectExcursions, mergeExcursions, buildHistoryRow, OFFLINE_MW } = globalThis.PREPA;

const DATA = path.resolve(process.argv[2] || 'data');
const SOURCES = {
  dataSource: 'https://operationdata.prepa.pr.gov/dataSource.js',
  dataGraph: 'https://operationdata.prepa.pr.gov/dataGraph.js',
  dataLevels: 'https://operationdata.prepa.pr.gov/dataLevels.js',
};
const LOCAL = { dataSource: process.env.LOCAL_DATASOURCE, dataGraph: process.env.LOCAL_DATAGRAPH, dataLevels: process.env.LOCAL_DATALEVELS };
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
  L.push('RAMPS (change in generation over 60 minutes, 5-minute readings)');
  L.push('  Max ramp up ... ' + (s.ramp_up_max_mw_h == null ? 'n/a' : '+' + n(s.ramp_up_max_mw_h, ' MW/h') + ' at ' + s.ramp_up_at));
  L.push('  Max ramp down . ' + (s.ramp_down_max_mw_h == null ? 'n/a' : n(s.ramp_down_max_mw_h, ' MW/h') + ' at ' + s.ramp_down_at));
  L.push('  Demand swing .. ' + (s.demand_max_mw != null && s.demand_min_mw != null ? n(s.demand_max_mw - s.demand_min_mw, ' MW') + ' (max minus min)' : 'n/a'));
  L.push('');
  L.push('UNIT EVENTS (units that went off or came on)');
  L.push('  Went off: ' + s.units_went_offline + '   Came on: ' + s.units_came_back);
  for (const e of events) L.push('  ' + e.detected_at.slice(11, 16) + '  ' + (e.event === 'Went offline' ? 'OFF' : 'ON ') + '  ' + e.plant + ' / ' + e.unit + '  ' + Number(e.mw_before).toFixed(1) + ' -> ' + Number(e.mw_after).toFixed(1) + ' MW');
  L.push('');
  L.push('Sources: PREPA operational data (dataSource.js, dataGraph.js). Generated automatically by the GitHub Action.');
  return L.join('\n') + '\n';
}

/* ---------------- Recovery: merge an uploaded copy of older data, then remove it ---------------- */
function mergeRecovered() {
  const REC = path.join(DATA, 'recovered'), RECLOG = path.resolve(DATA, '..', 'logs', 'recovered');
  const days = new Set();
  if (!fs.existsSync(REC) && !fs.existsSync(RECLOG)) return days;
  const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(REC, f), 'utf8')); } catch { return d; } };
  const unionBy = (file, key, recovered) => {
    const cur = readJSON(file, []), m = new Map();
    for (const r of [...recovered, ...cur]) { const k = typeof key === 'function' ? key(r) : r[key]; if (k != null) m.set(k, r); }
    writeJSON(file, [...m.values()].sort((a, b) => (String(a.at || a.time || a.day || a.detected_at || a.start) < String(b.at || b.time || b.day || b.detected_at || b.start) ? -1 : 1)));
  };
  if (fs.existsSync(REC)) {
    unionBy('history.json', 'at', rj('history.json', []));
    unionBy('unit_events.json', 'event_id', rj('unit_events.json', []));
    unionBy('feed_health.json', (r) => r.at + '|' + r.feed + '|' + (r.via || ''), rj('feed_health.json', []));
    unionBy('frequency_events.json', 'event_id', rj('frequency_events.json', []));
    unionBy('plant_hourly.json', 'at', rj('plant_hourly.json', []));
    unionBy('trace_recent.json', 'time', rj('trace_recent.json', []));
    const ranges = readJSON('unit_ranges.json', {});
    for (const [k, r] of Object.entries(rj('unit_ranges.json', {}))) { const c = ranges[k]; ranges[k] = c ? { min_on_mw: Math.min(c.min_on_mw, r.min_on_mw), max_on_mw: Math.max(c.max_on_mw, r.max_on_mw), since: r.since < c.since ? r.since : c.since } : r; }
    writeJSON('unit_ranges.json', ranges);
    const DAYS0 = path.join(DATA, 'days'); fs.mkdirSync(DAYS0, { recursive: true });
    const recDays = path.join(REC, 'days');
    if (fs.existsSync(recDays)) for (const f of fs.readdirSync(recDays).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x))) {
      const old = JSON.parse(fs.readFileSync(path.join(recDays, f), 'utf8'));
      let cur = { day: f.slice(0, 10), checks: [], trace: [] }; try { cur = JSON.parse(fs.readFileSync(path.join(DAYS0, f), 'utf8')); } catch { /* new */ }
      const ck = new Map(); for (const c of [...(old.checks || []), ...(cur.checks || [])]) ck.set(c.at, c);
      const tr = new Map(); for (const r of [...(old.trace || []), ...(cur.trace || [])]) tr.set(Math.floor(new Date(r.time).getTime() / 300000), r);
      fs.writeFileSync(path.join(DAYS0, f), JSON.stringify({ day: f.slice(0, 10), checks: [...ck.values()].sort((a, b) => (a.at < b.at ? -1 : 1)), trace: [...tr.values()].sort((a, b) => (a.time < b.time ? -1 : 1)) }));
      days.add(f.slice(0, 10));
    }
    fs.rmSync(REC, { recursive: true, force: true });
  }
  if (fs.existsSync(RECLOG)) {
    const recOut = path.join(RECLOG, 'outages'), OUT = path.resolve(DATA, '..', 'logs', 'unit-events'); fs.mkdirSync(OUT, { recursive: true });
    if (fs.existsSync(recOut)) for (const f of fs.readdirSync(recOut).filter((x) => x.endsWith('.log'))) {
      const a = fs.readFileSync(path.join(recOut, f), 'utf8').split('\n'), b = fs.existsSync(path.join(OUT, f)) ? fs.readFileSync(path.join(OUT, f), 'utf8').split('\n') : [];
      const head = a.filter((l) => l.startsWith('#')), seen = new Set(), body = [];
      for (const l of [...a, ...b]) if (l && !l.startsWith('#') && !seen.has(l)) { seen.add(l); body.push(l); }
      fs.writeFileSync(path.join(OUT, f), [...head, ...body.sort()].join('\n') + '\n');
    }
    fs.rmSync(RECLOG, { recursive: true, force: true });
  }
  console.log('merged recovered data for', days.size, 'days');
  return days;
}
const recoveredDays = mergeRecovered();
const SETTINGS = (readJSON('settings.json', [])[0]) || {};
const START = SETTINGS.start_date || null;

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
for (const name of ['dataSource', 'dataGraph', 'dataLevels']) {
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
// Reservoir levels: latest reading, plus every new reading (90 days).
if (results.dataLevels && results.dataLevels.ok) {
  try {
    const lv = processLevels(parseFeed(results.dataLevels.text));
    if (lv.length) {
      writeJSON('reservoir_levels.json', lv);
      const lh = readJSON('reservoir_history.json', []), seen = new Set(lh.map((r) => r.at + '|' + r.embalse));
      for (const r of lv) if (!seen.has(r.at + '|' + r.embalse)) lh.push(r);
      writeJSON('reservoir_history.json', lh.filter((r) => r.at && new Date(r.at).getTime() >= NOW.getTime() - 90 * DAY));
    }
  } catch (e) { console.error('dataLevels parse error:', e.message); markParseError('dataLevels', e); }
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
  events = events.filter((e) => new Date(e.detected_at).getTime() >= NOW.getTime() - 31 * DAY);
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
fs.mkdirSync(DAYS, { recursive: true }); fs.mkdirSync(path.join(LOGS, 'daily'), { recursive: true }); if (fs.existsSync(path.join(LOGS, 'outages')) && !fs.existsSync(path.join(LOGS, 'unit-events'))) fs.renameSync(path.join(LOGS, 'outages'), path.join(LOGS, 'unit-events'));
fs.mkdirSync(path.join(LOGS, 'unit-events'), { recursive: true });
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
  if (old.calc_version !== 3) { slotMapOf(getDay(d)); touched.add(d); }
}
for (const [d, D] of dayCache) { if (D._map) { D.trace = [...D._map.values()].sort((a, b) => (a.time < b.time ? -1 : 1)); delete D._map; } D.checks.sort((a, b) => (a.at < b.at ? -1 : 1)); fs.writeFileSync(dayFile(d), JSON.stringify(D)); }
// remove day files older than 35 days
for (const f of fs.readdirSync(DAYS)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < isoAST(new Date(NOW.getTime() - 35 * DAY)).slice(0, 10)) fs.unlinkSync(path.join(DAYS, f));

// Unit event text log: one line per unit going off or coming on, one file per day.
const pad2 = (n) => String(n).padStart(2, '0');
for (const e of newEvents) {
  const line = `${e.detected_at.slice(0, 10)} ${e.detected_at.slice(11, 16)} AST  ${e.event === 'Went offline' ? 'UNIT OFF' : 'UNIT ON '}  ${(e.plant + ' / ' + e.unit).padEnd(36)} ${String(Number(e.mw_before).toFixed(1)).padStart(7)} MW -> ${String(Number(e.mw_after).toFixed(1)).padStart(7)} MW  (${e.operator}, ${e.fuel}; previous check ${e.previous_snapshot ? e.previous_snapshot.slice(11, 16) : '-'})\n`;
  const f = path.join(LOGS, 'unit-events', e.detected_at.slice(0, 10) + '.log');
  if (!fs.existsSync(f)) fs.writeFileSync(f, `# Unit event log, ${e.detected_at.slice(0, 10)} (Puerto Rico time, UTC-4)\n# Units going off and coming on. A unit counts as off below ${OFFLINE_MW} MW. Times are when the change was first seen; it happened after the previous check.\n`);
  fs.appendFileSync(f, line);
}

// Daily summaries for every day touched by this run.
const LIM = (readJSON('frequency_limits.json', [])[0]) || null;
const summaries = readJSON('daily_summary.json', []);
const todayAST = isoAST(NOW).slice(0, 10);
for (const d of recoveredDays) touched.add(d);
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
if (START) for (let i = summaries.length - 1; i >= 0; i--) if (summaries[i].day < START) summaries.splice(i, 1);
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

// 15-minute generation trace for 35 days, from the day files (continuous 30-day view).
{
  const slots = new Map();
  for (const f of fs.readdirSync(DAYS).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort().slice(-36)) {
    const D = dayCache.get(f.slice(0, 10)) || JSON.parse(fs.readFileSync(path.join(DAYS, f), 'utf8'));
    for (const r of D.trace || []) { if (!Number.isFinite(r.generation_mw)) continue; if (START && r.time.slice(0, 10) < START) continue;
      const k = Math.floor(new Date(r.time).getTime() / 900000) * 900000; const o = slots.get(k) || { s: 0, n: 0, f: 0, fn: 0 };
      o.s += r.generation_mw; o.n++; if (Number.isFinite(r.frequency_hz)) { o.f += r.frequency_hz; o.fn++; } slots.set(k, o); }
  }
  writeJSON('trace_long.json', [...slots.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => t >= NOW.getTime() - 35 * DAY)
    .map(([t, o]) => ({ time: isoAST(new Date(t)), generation_mw: Math.round((o.s / o.n) * 10) / 10, frequency_hz: o.fn ? Math.round((o.f / o.fn) * 100) / 100 : null })));
}
// Per-plant ramp records from consecutive readings (5 to 25 minutes apart), in MW per hour.
{
  const rates = {}; // plant -> [{t, r}]
  for (const f of fs.readdirSync(DAYS).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort().slice(-36)) {
    const D = dayCache.get(f.slice(0, 10)) || JSON.parse(fs.readFileSync(path.join(DAYS, f), 'utf8'));
    const cs = (D.checks || []).filter((c) => c.plant_mw).sort((a, b) => (a.at < b.at ? -1 : 1));
    for (let i = 1; i < cs.length; i++) {
      const t0 = new Date(cs[i - 1].at).getTime(), t1 = new Date(cs[i].at).getTime(), dt = (t1 - t0) / 60000;
      if (dt < 5 || dt > 25) continue;
      // skip glitches: total generation cannot jump more than 10% between two readings
      const tot0 = Object.values(cs[i - 1].plant_mw).reduce((s, v) => s + (Number(v) || 0), 0), tot1 = Object.values(cs[i].plant_mw).reduce((s, v) => s + (Number(v) || 0), 0);
      if (!tot0 || !tot1 || Math.abs(tot1 - tot0) / tot0 > 0.1) continue;
      for (const p of new Set([...Object.keys(cs[i - 1].plant_mw), ...Object.keys(cs[i].plant_mw)])) {
        const a0 = Number(cs[i - 1].plant_mw[p]) || 0, b0 = Number(cs[i].plant_mw[p]) || 0;
        if (a0 < 1 || b0 < 1) continue; // ramping while online (starts and trips are logged as unit events instead)
        (rates[p] = rates[p] || []).push({ t: t1, r: ((b0 - a0) / dt) * 60 });
      }
    }
  }
  const prev = new Map(readJSON('plant_ramps.json', []).map((r) => [r.plant, r]));
  const out = [];
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
  for (const [p, list] of Object.entries(rates)) {
    const win = (d) => list.filter((x) => x.t >= NOW.getTime() - d * DAY);
    const best = (l, f) => l.reduce((a, x) => (!a || f(x.r, a.r) ? x : a), null);
    const at = (x) => (x ? isoAST(new Date(x.t)).slice(0, 16).replace('T', ' ') : null);
    const u7 = best(win(7), (a, b) => a > b), u30 = best(win(31), (a, b) => a > b), d7 = best(win(7), (a, b) => a < b), d30 = best(win(31), (a, b) => a < b);
    const uAll = best(list, (a, b) => a > b), dAll = best(list, (a, b) => a < b), pr = prev.get(p);
    const upAll = pr && pr.up_all != null && (!uAll || pr.up_all > uAll.r) ? { r: pr.up_all, at: pr.up_all_at } : uAll ? { r: uAll.r, at: at(uAll) } : null;
    const dnAll = pr && pr.down_all != null && (!dAll || pr.down_all < dAll.r) ? { r: pr.down_all, at: pr.down_all_at } : dAll ? { r: dAll.r, at: at(dAll) } : null;
    const days = new Map(); for (const x of win(7)) { const k = isoAST(new Date(x.t)).slice(0, 10); days.set(k, Math.max(days.get(k) ?? -Infinity, x.r)); }
    const pos = [...days.values()].filter((v) => v > 0);
    const R = (v) => (v == null ? null : Math.round(v));
    out.push({ plant: p, typical_up: R(med(win(31).filter((x) => x.r > 5).map((x) => x.r))), typical_down: R(med(win(31).filter((x) => x.r < -5).map((x) => x.r))),
      up_7d: u7 && u7.r > 0 ? R(u7.r) : null, up_7d_at: u7 && u7.r > 0 ? at(u7) : null, up_30d: u30 && u30.r > 0 ? R(u30.r) : null, up_30d_at: u30 && u30.r > 0 ? at(u30) : null,
      up_all: upAll && upAll.r > 0 ? R(upAll.r) : null, up_all_at: upAll && upAll.r > 0 ? upAll.at : null,
      down_7d: d7 && d7.r < 0 ? R(d7.r) : null, down_30d: d30 && d30.r < 0 ? R(d30.r) : null, down_all: dnAll && dnAll.r < 0 ? R(dnAll.r) : null, down_all_at: dnAll && dnAll.r < 0 ? dnAll.at : null,
      avg_daily_max_up_7d: pos.length ? R(pos.reduce((a, b) => a + b, 0) / pos.length) : null });
  }
  writeJSON('plant_ramps.json', out.sort((a, b) => (b.up_30d || 0) - (a.up_30d || 0)));
}

// Hourly cost profile (35 days) from every saved reading in the day files: total and per-fuel cost and output,
// and each plant's cost and output. Rebuilt each run, so it covers all days already saved.
{
  const hours = new Map();
  for (const f of fs.readdirSync(DAYS).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort().slice(-35)) {
    const D = dayCache.get(f.slice(0, 10)) || JSON.parse(fs.readFileSync(path.join(DAYS, f), 'utf8'));
    for (const c of D.checks || []) {
      if (START && c.at.slice(0, 10) < START) continue;
      const k = c.at.slice(0, 13); const h = hours.get(k) || { n: 0, sums: {}, plant_mw: {}, plant_cost: {}, plant_mvar: {}, nq: 0 };
      h.n++;
      for (const [key, v] of Object.entries(c)) if (/^(total_mw|gen_mw|mvar_total|dispatch_cost_usd_h|cost_[a-z_]+|mw_[a-z_]+)$/.test(key) && Number.isFinite(Number(v))) h.sums[key] = (h.sums[key] || 0) + Number(v);
      if (c.plant_mvar) { h.nq++; for (const [p, v] of Object.entries(c.plant_mvar)) h.plant_mvar[p] = (h.plant_mvar[p] || 0) + Number(v); }
      for (const [p, v] of Object.entries(c.plant_mw || {})) h.plant_mw[p] = (h.plant_mw[p] || 0) + Number(v);
      for (const [p, v] of Object.entries(c.plant_cost || {})) h.plant_cost[p] = (h.plant_cost[p] || 0) + Number(v);
      hours.set(k, h);
    }
  }
  const r1 = (x) => Math.round(x * 10) / 10;
  const rows = [...hours.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, h]) => {
    const row = { at: k + ':00:00-04:00', n: h.n };
    for (const [key, v] of Object.entries(h.sums)) row[key] = r1(v / (key === 'gen_mw' || key === 'mvar_total' ? (h.nq || h.n) : h.n));
    if (h.nq) row.plant_mvar = Object.fromEntries(Object.entries(h.plant_mvar).map(([p, v]) => [p, r1(v / h.nq)]));
    row.plant_mw = Object.fromEntries(Object.entries(h.plant_mw).map(([p, v]) => [p, r1(v / h.n)]));
    row.plant_cost = Object.fromEntries(Object.entries(h.plant_cost).map(([p, v]) => [p, Math.round(v / h.n)]));
    return row;
  });
  writeJSON('cost_hourly.json', rows);
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

// Remove everything before the start date (data/settings.json), so history begins where you chose.
if (START) {
  const before = (v) => v && String(v).slice(0, 10) < START;
  for (const [file, key] of [['history.json', 'at'], ['unit_events.json', 'detected_at'], ['feed_health.json', 'at'], ['frequency_events.json', 'start'], ['plant_hourly.json', 'at'], ['trace_recent.json', 'time'], ['live_graph.json', 'time']]) {
    const rows = readJSON(file, null); if (Array.isArray(rows)) { const kept = rows.filter((r) => !before(r[key])); if (kept.length !== rows.length) writeJSON(file, kept); }
  }
  const DAYS1 = path.join(DATA, 'days'), LOGS1 = path.resolve(DATA, '..', 'logs');
  for (const [dir, re] of [[DAYS1, /^(\d{4}-\d{2}-\d{2})\.json$/], [path.join(LOGS1, 'daily'), /^(\d{4}-\d{2}-\d{2})\.txt$/], [path.join(LOGS1, 'unit-events'), /^(\d{4}-\d{2}-\d{2})\.log$/]]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) { const m = re.exec(f); if (m && m[1] < START) fs.unlinkSync(path.join(dir, f)); }
  }
}
