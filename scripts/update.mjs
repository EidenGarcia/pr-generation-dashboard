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
const { buildForecast, parseFeed, processSource, processGraph, freqLevel, detectExcursions, mergeExcursions, buildHistoryRow, OFFLINE_MW } = globalThis.PREPA;

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

/* ---------------- Daily summary ---------------- */
const FUEL_KEYS = [['lng', 'LNG'], ['bunker_c', 'Bunker C'], ['ulsd', 'Diesel (ULSD)'], ['coal', 'Coal'], ['solar', 'Solar'], ['wind', 'Wind'], ['hydro', 'Hydro'], ['landfill_gas', 'Landfill gas']];
function summarizeDay(day, checks, trace, events, fev, L, complete) {
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
    day, status: complete ? (coverage >= 20 ? 'Complete' : 'Ended, partial data') : 'In progress', updated_at: isoAST(NOW), coverage_h: r1(coverage), checks: cs.length, trace_readings: tr.length,
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
  };
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
if (graph) for (const r of graph.rows) { const d = r.time.slice(0, 10); const D = getDay(d); if (!D._map) D._map = new Map(D.trace.map((x) => [x.time, x])); D._map.set(r.time, r); touched.add(d); }
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
  const sm = summarizeDay(d, D.checks, D.trace, allEvents, fev, LIM, d < todayAST);
  const i = summaries.findIndex((x) => x.day === d); if (i >= 0) summaries[i] = sm; else summaries.push(sm);
  fs.writeFileSync(path.join(LOGS, 'daily', d + '.txt'), dailyText(sm, allEvents));
}
summaries.sort((a, b) => (a.day < b.day ? -1 : 1));
writeJSON('daily_summary.json', summaries.slice(-400));
const CSV_COLS = ['day', 'status', 'coverage_h', 'checks', 'demand_max_mw', 'demand_max_at', 'demand_min_mw', 'demand_min_at', 'demand_avg_mw', 'prepa_peak_mw', 'gen_max_mw', 'gen_max_at', 'gen_min_mw', 'gen_min_at', 'gen_avg_mw', 'gen_energy_mwh', 'freq_max_hz', 'freq_min_hz', 'freq_avg_hz', 'freq_normal_pct', 'freq_excursions', 'majority_fuel', 'share_lng_pct', 'share_bunker_c_pct', 'share_ulsd_pct', 'share_coal_pct', 'share_renewable_pct', 'share_hydro_pct', 'total_cost_usd', 'cost_full_day_estimate_usd', 'avg_cost_usd_per_kwh', 'units_went_offline', 'units_came_back'];
fs.writeFileSync(path.join(LOGS, 'daily_summary.csv'), CSV_COLS.join(',') + '\n' + summaries.map((s) => CSV_COLS.map((c) => (s[c] == null ? '' : String(s[c]).includes(',') ? '"' + s[c] + '"' : s[c])).join(',')).join('\n') + '\n');

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
