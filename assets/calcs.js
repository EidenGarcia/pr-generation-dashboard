/* Shared calculations: each turns loaded data files into the rows a chart or table shows. */
/* ---------- Calculations (readers can see each formula in Sources) ---------- */
dash.calc('live_plants', {
  inputs: ['live_units'],
  title: 'Live status by plant',
  description: 'Units grouped by plant: MW now, units generating vs offline (<1 MW), and $/hour (MW × ¢/kWh × 10).',
  fn: (live_units) => {
    const by = new Map();
    for (const u of live_units) {
      if (!by.has(u.plant)) by.set(u.plant, { plant: u.plant, operator: u.operator, technology: u.technology, fuel: u.fuel, units_total: 0, units_generating: 0, units_offline: 0, mw: 0, cost_usd_per_hour: 0 });
      const p = by.get(u.plant);
      p.units_total += 1;
      p.mw += Number(u.mw);
      if (u.status === 'Generating') { p.units_generating += 1; p.cost_usd_per_hour += Number(u.cost_usd_per_hour); } else { p.units_offline += 1; }
    }
    return [...by.values()].map((p) => ({ ...p, mw: Math.round(p.mw * 100) / 100, cost_usd_per_hour: Math.round(p.cost_usd_per_hour),
      status: p.units_generating === 0 ? 'Out of service' : (p.units_offline > 0 ? 'Partially offline' : 'All units generating') }));
  },
});

dash.calc('live_kpis', {
  inputs: ['live_units', 'live_metrics'],
  title: 'Live system KPIs',
  description: 'Operator metrics (total MW, capacity, reserves) plus unit counts, Genera MW and $/hour summed from units.',
  fn: (live_units, live_metrics) => {
    const metric = (i) => { const r = live_metrics.find((x) => Number(x.index) === i); return r && r.value != null ? Number(r.value) : null; };
    const text = (i) => { const r = live_metrics.find((x) => Number(x.index) === i); return r && r.value_text ? r.value_text : null; };
    const gen = live_units.filter((u) => u.status === 'Generating');
    const cost = gen.reduce((a, u) => a + Number(u.cost_usd_per_hour), 0);
    const costMW = gen.filter((u) => Number(u.cost_cents_kwh) > 0).reduce((a, u) => a + Number(u.mw), 0);
    const genera = live_units.filter((u) => u.operator === 'Genera PR');
    return [{
      snapshot: live_units.length ? live_units[0].snapshot : null,
      total_generation_mw: metric(0), available_capacity_mw: metric(7), spinning_reserve_mw: metric(5), operating_reserve_mw: metric(6),
      genera_mw: Math.round(genera.reduce((a, u) => a + Number(u.mw), 0) * 10) / 10,
      genera_units_total: genera.length,
      genera_units_offline: genera.filter((u) => u.status !== 'Generating').length,
      units_total: live_units.length,
      units_offline: live_units.filter((u) => u.status !== 'Generating').length,
      genera_avg_cents_kwh: (() => { const g = genera.filter((u) => u.status === 'Generating' && Number(u.cost_cents_kwh) > 0); const mw = g.reduce((a, u) => a + Number(u.mw), 0); return mw > 0 ? Math.round((g.reduce((a, u) => a + Number(u.cost_usd_per_hour), 0) / (mw * 10)) * 100) / 100 : null; })(),
      prepa_pct: metric(1), ppoa_pct: metric(2), fossil_pct: metric(3), renewable_pct: metric(4),
      next_hour_mw: metric(8), peak_today_mw: metric(9), monthly_peak_mw: metric(10), annual_peak_mw: metric(11),
      peak_today_time: text(12), monthly_peak_time: text(13), annual_peak_time: text(14),
      cost_usd_per_hour: Math.round(cost),
      avg_cost_cents_kwh: costMW > 0 ? Math.round((cost / (costMW * 10)) * 100) / 100 : null,
    }];
  },
});

dash.calc('outage_alerts', {
  inputs: ['live_units', 'hist_units'],
  title: 'Unit outage alerts',
  description: 'Genera units offline now, with each unit’s net MWh in the latest filed month; baseload units that ran last month rank first.',
  fn: (live_units, hist_units) => {
    const last = hist_units.reduce((a, r) => (r.month > a ? r.month : a), '');
    const net = new Map();
    for (const r of hist_units) if (r.month === last) net.set(r.unit, (net.get(r.unit) || 0) + Number(r.net_mwh));
    return live_units.filter((u) => u.operator === 'Genera PR' && u.status !== 'Generating' && u.filing_unit).map((u) => {
      const mwh = u.filing_unit.split(';').reduce((a, x) => a + (net.get(x) || 0), 0);
      const peaking = /^(Aguirre CC|Cambalache|Mayagüez|GT stations)/.test(u.plant);
      const rank = mwh <= 0 ? 3 : peaking ? 2 : 1;
      return { unit_id: u.unit_id, plant: u.plant, unit: u.unit, filing_unit: u.filing_unit.split(';').join(' + '), last_month: last,
        last_month_net_mwh: Math.round(mwh), mw_now: Number(u.mw), rank,
        severity: rank === 1 ? 'Baseload unit down' : rank === 2 ? 'Peaker idle (ran last month)' : 'Also idle last month' };
    }).sort((a, b) => a.rank - b.rank || b.last_month_net_mwh - a.last_month_net_mwh);
  },
});

dash.calc('alerts_summary', {
  inputs: ['outage_alerts', 'unit_events'],
  title: 'Alert summary',
  description: 'Counts of alert levels now, and units that went offline or came back at the most recent refresh (the baseline row is not counted).',
  fn: (outage_alerts, unit_events) => {
    const real = unit_events.filter((e) => e.event === 'Went offline' || e.event === 'Back online');
    const latest = real.reduce((a, e) => (e.detected_at > a ? e.detected_at : a), '');
    const le = real.filter((e) => e.detected_at === latest);
    return [{ baseload_down: outage_alerts.filter((a) => a.rank === 1).length, peakers_idle: outage_alerts.filter((a) => a.rank === 2).length,
      went_offline_latest: le.filter((e) => e.event === 'Went offline').length, back_online_latest: le.filter((e) => e.event === 'Back online').length,
      latest_change: latest || null, events_logged: real.length }];
  },
});

dash.calc('live_cost_by_fuel', {
  inputs: ['live_units'],
  title: 'Live cost by fuel',
  description: 'Generating units grouped by fuel: MW, $/hour, share of $/hour, and MW-weighted ¢/kWh of units with a reported cost.',
  fn: (live_units) => {
    const by = new Map();
    for (const u of live_units.filter((x) => x.status === 'Generating')) {
      if (!by.has(u.fuel)) by.set(u.fuel, { fuel: u.fuel, mw: 0, cost_usd_per_hour: 0, cost_mw: 0 });
      const f = by.get(u.fuel);
      f.mw += Number(u.mw); f.cost_usd_per_hour += Number(u.cost_usd_per_hour);
      if (Number(u.cost_cents_kwh) > 0) f.cost_mw += Number(u.mw);
    }
    const total = [...by.values()].reduce((a, f) => a + f.cost_usd_per_hour, 0);
    return [...by.values()].map((f) => ({ fuel: f.fuel, mw: Math.round(f.mw * 10) / 10, cost_usd_per_hour: Math.round(f.cost_usd_per_hour),
      share_pct: total > 0 ? Math.round((f.cost_usd_per_hour / total) * 1000) / 10 : 0,
      avg_cents_kwh: f.cost_mw > 0 ? Math.round((f.cost_usd_per_hour / (f.cost_mw * 10)) * 100) / 100 : null }))
      .sort((a, b) => b.cost_usd_per_hour - a.cost_usd_per_hour);
  },
});
