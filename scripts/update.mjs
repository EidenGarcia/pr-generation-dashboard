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
  events = events.slice(-5000);
  writeJSON('live_units.json', src.units); writeJSON('live_metrics.json', src.metrics);
  writeJSON('live_fuel_mix.json', src.mix); writeJSON('live_fuel_price.json', src.prices);
  writeJSON('unit_events.json', events);

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
const hist = history.filter((x) => new Date(x.at).getTime() >= cut(90)).sort((a, b) => (a.at < b.at ? -1 : 1));
writeJSON('history.json', hist);
writeJSON('feed_health.json', health.filter((x) => new Date(x.at).getTime() >= cut(30)));

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
