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

dash.calc('customer_now', {
  inputs: ['customer_fuel_charges'],
  title: 'Customer charge this quarter',
  description: 'Latest approved quarter: FCA, PPCA, their sum in ¢/kWh, and the change from the quarter before.',
  fn: (customer_fuel_charges) => {
    const q = customer_fuel_charges.slice().sort((a, b) => (a.period_start < b.period_start ? -1 : 1));
    const t = (r) => Number(r.fca_cents_kwh) + Number(r.ppca_cents_kwh);
    const cur = q[q.length - 1], prev = q[q.length - 2];
    return cur ? [{ quarter: cur.quarter, period: cur.period, fca_cents_kwh: Number(cur.fca_cents_kwh), ppca_cents_kwh: Number(cur.ppca_cents_kwh),
      total_cents_kwh: Math.round(t(cur) * 10000) / 10000, change_cents_kwh: prev ? Math.round((t(cur) - t(prev)) * 10000) / 10000 : null }] : [];
  },
});

dash.calc('household_charges', {
  inputs: ['customer_fuel_charges'],
  title: 'Household fuel and power charges',
  description: 'For 300, 425, 600, 800 and 1,000 kWh a month: FCA and PPCA charges in $ for each quarter (kWh × ¢/kWh ÷ 100).',
  fn: (customer_fuel_charges) => {
    const out = [];
    for (const kwh of [300, 425, 600, 800, 1000]) for (const r of customer_fuel_charges) {
      const fca = (kwh * Number(r.fca_cents_kwh)) / 100, ppca = (kwh * Number(r.ppca_cents_kwh)) / 100;
      out.push({ key: kwh + '|' + r.quarter, kwh, quarter: r.quarter, period: r.period, period_start: r.period_start,
        fca_usd: Math.round(fca * 100) / 100, ppca_usd: Math.round(ppca * 100) / 100, total_usd: Math.round((fca + ppca) * 100) / 100 });
    }
    return out;
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

dash.calc('hist_cost', {
  inputs: ['hist_fuel', 'fuel_prices'],
  title: 'Estimated fuel cost by month',
  description: 'Each plant-fuel-month priced at its current price: oil = barrels × $/bbl, LNG = MMBtu × $/MMBtu.',
  fn: (hist_fuel, fuel_prices) => {
    const price = new Map(fuel_prices.map((p) => [p.plant + '|' + p.fuel, p]));
    return hist_fuel.map((r) => {
      const p = price.get(r.plant + '|' + r.fuel);
      const cost = !p ? null : (p.price_unit === '$/MMBtu' ? Number(r.mmbtu) * Number(p.price) : Number(r.barrels) * Number(p.price));
      return { key: r.key, month: r.month, fy: r.fy, plant: r.plant, fuel: r.fuel, barrels: Number(r.barrels), mmbtu: Number(r.mmbtu),
        price: p ? Number(p.price) : null, price_unit: p ? p.price_unit : null, cost_usd: cost == null ? null : Math.round(cost) };
    });
  },
});

dash.calc('fy_kpis', {
  inputs: ['hist_cost', 'hist_plant_month'],
  title: 'Period totals',
  description: 'For all months and each fiscal year: net GWh, estimated fuel cost, $/net MWh, net heat rate (MMBtu×1000 ÷ net MWh).',
  fn: (hist_cost, hist_plant_month) => {
    const fys = ['All', ...new Set(hist_plant_month.map((r) => r.fy))];
    return fys.map((fy) => {
      const pm = hist_plant_month.filter((r) => fy === 'All' || r.fy === fy);
      const hc = hist_cost.filter((r) => fy === 'All' || r.fy === fy);
      const net = pm.reduce((a, r) => a + Number(r.net_mwh), 0);
      const mm = pm.reduce((a, r) => a + Number(r.mmbtu), 0);
      const cost = hc.reduce((a, r) => a + (r.cost_usd || 0), 0);
      const months = [...new Set(pm.map((r) => r.month))].sort();
      return { fy, months: months.length, first_month: months[0], last_month: months[months.length - 1],
        net_gwh: Math.round(net / 100) / 10, est_fuel_cost_musd: Math.round(cost / 1e5) / 10,
        usd_per_mwh: net > 0 ? Math.round((cost / net) * 100) / 100 : null,
        net_heat_rate_btu_kwh: net > 0 ? Math.round((mm * 1000) / net) : null };
    });
  },
});

dash.calc('cost_by_month_fuel', {
  inputs: ['hist_cost'],
  title: 'Monthly cost by fuel',
  description: 'Estimated fuel cost summed by month and fuel.',
  fn: (hist_cost) => {
    const by = new Map();
    for (const r of hist_cost) {
      const k = r.month + '|' + r.fuel;
      if (!by.has(k)) by.set(k, { key: k, month: r.month, fy: r.fy, fuel: r.fuel, cost_usd: 0 });
      by.get(k).cost_usd += r.cost_usd || 0;
    }
    return [...by.values()];
  },
});

dash.calc('cost_by_fy_fuel', {
  inputs: ['hist_cost'],
  title: 'Cost by fuel and period',
  description: 'Estimated fuel cost by fuel for all months and each fiscal year, with share of the period total.',
  fn: (hist_cost) => {
    const out = [];
    for (const fy of ['All', ...new Set(hist_cost.map((r) => r.fy))]) {
      const rows = hist_cost.filter((r) => fy === 'All' || r.fy === fy);
      const total = rows.reduce((a, r) => a + (r.cost_usd || 0), 0);
      for (const fuel of [...new Set(rows.map((r) => r.fuel))]) {
        const fr = rows.filter((r) => r.fuel === fuel);
        const cost = fr.reduce((a, r) => a + (r.cost_usd || 0), 0);
        out.push({ key: fy + '|' + fuel, fy, fuel, cost_usd: cost, mmbtu: Math.round(fr.reduce((a, r) => a + r.mmbtu, 0)), share_pct: total > 0 ? Math.round((cost / total) * 1000) / 10 : 0 });
      }
    }
    return out;
  },
});

dash.calc('cost_by_fy_plant', {
  inputs: ['hist_cost', 'hist_plant_month'],
  title: 'Cost by plant and period',
  description: 'Estimated fuel cost by plant (split by fuel), net MWh and $/net MWh for all months and each fiscal year.',
  fn: (hist_cost, hist_plant_month) => {
    const out = [];
    for (const fy of ['All', ...new Set(hist_plant_month.map((r) => r.fy))]) {
      const pm = hist_plant_month.filter((r) => fy === 'All' || r.fy === fy);
      const hc = hist_cost.filter((r) => fy === 'All' || r.fy === fy);
      for (const plant of [...new Set(pm.map((r) => r.plant))]) {
        const c = hc.filter((r) => r.plant === plant);
        const sum = (fuel) => c.filter((r) => !fuel || r.fuel === fuel).reduce((a, r) => a + (r.cost_usd || 0), 0);
        const net = pm.filter((r) => r.plant === plant).reduce((a, r) => a + Number(r.net_mwh), 0);
        const cost = sum();
        out.push({ key: fy + '|' + plant, fy, plant, cost_usd: cost, cost_bunker_c: sum('Bunker C'), cost_ulsd: sum('ULSD'), cost_lng: sum('LNG'),
          net_mwh: Math.round(net), usd_per_mwh: net > 0 ? Math.round((cost / net) * 100) / 100 : null });
      }
    }
    return out;
  },
});

dash.calc('cost_table', {
  inputs: ['hist_cost'],
  title: 'Fuel use and cost by plant and fuel',
  description: 'Barrels, MMBtu, price applied and estimated cost by plant and fuel, for all months and each fiscal year.',
  fn: (hist_cost) => {
    const out = [];
    for (const fy of ['All', ...new Set(hist_cost.map((r) => r.fy))]) {
      const rows = hist_cost.filter((r) => fy === 'All' || r.fy === fy);
      const total = rows.reduce((a, r) => a + (r.cost_usd || 0), 0);
      const by = new Map();
      for (const r of rows) {
        const k = fy + '|' + r.plant + '|' + r.fuel;
        if (!by.has(k)) by.set(k, { key: k, fy, plant: r.plant, fuel: r.fuel, barrels: 0, mmbtu: 0, price: r.price, price_unit: r.price_unit, cost_usd: 0 });
        const t = by.get(k); t.barrels += r.barrels; t.mmbtu += r.mmbtu; t.cost_usd += r.cost_usd || 0;
      }
      for (const t of by.values()) out.push({ ...t, barrels: Math.round(t.barrels), mmbtu: Math.round(t.mmbtu), share_pct: total > 0 ? Math.round((t.cost_usd / total) * 1000) / 10 : 0 });
    }
    return out;
  },
});

dash.calc('fleet_month', {
  inputs: ['hist_plant_month', 'hist_cost'],
  title: 'Fleet totals by month',
  description: 'All plants summed per month: net and gross GWh, net heat rate, estimated fuel cost and $/net MWh.',
  fn: (hist_plant_month, hist_cost) => {
    const months = [...new Set(hist_plant_month.map((r) => r.month))].sort();
    return months.map((m) => {
      const pm = hist_plant_month.filter((r) => r.month === m);
      const net = pm.reduce((a, r) => a + Number(r.net_mwh), 0);
      const mm = pm.reduce((a, r) => a + Number(r.mmbtu), 0);
      const cost = hist_cost.filter((r) => r.month === m).reduce((a, r) => a + (r.cost_usd || 0), 0);
      return { month: m, fy: pm[0].fy, net_gwh: Math.round(net / 100) / 10, gross_gwh: Math.round(pm.reduce((a, r) => a + Number(r.gross_mwh), 0) / 100) / 10,
        net_heat_rate_btu_kwh: net > 0 ? Math.round((mm * 1000) / net) : null, est_fuel_cost_usd: cost, usd_per_mwh: net > 0 ? Math.round((cost / net) * 100) / 100 : null };
    });
  },
});

dash.calc('plant_stats', {
  inputs: ['hist_plant_month', 'hist_cost'],
  title: 'Descriptive statistics by plant',
  description: 'Per plant over all filed months: total, share, mean, sample std dev, CV, min, max of monthly net GWh; heat rate; $/net MWh. Last row: fleet.',
  fn: (hist_plant_month, hist_cost) => {
    const stats = (plant, rows, costRows, fleetTotal) => {
      const v = rows.map((r) => r.net / 1000);
      const n = v.length, mean = v.reduce((a, x) => a + x, 0) / n;
      const sd = n > 1 ? Math.sqrt(v.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
      const total = v.reduce((a, x) => a + x, 0), mm = rows.reduce((a, r) => a + r.mm, 0), cost = costRows.reduce((a, r) => a + (r.cost_usd || 0), 0);
      const r1 = (x) => Math.round(x * 10) / 10;
      return { plant, technology: rows.tech, months: n, total_net_gwh: r1(total), share_pct: r1((total / fleetTotal) * 100), mean_net_gwh: r1(mean), sd_net_gwh: r1(sd),
        cv_pct: mean > 0 ? r1((sd / mean) * 100) : null, min_net_gwh: r1(Math.min(...v)), max_net_gwh: r1(Math.max(...v)),
        net_heat_rate_btu_kwh: total > 0 ? Math.round(mm / total) : null, est_usd_per_mwh: total > 0 ? Math.round((cost / (total * 1000)) * 100) / 100 : null };
    };
    const fleetTotal = hist_plant_month.reduce((a, r) => a + Number(r.net_mwh), 0) / 1000;
    const out = [];
    for (const plant of [...new Set(hist_plant_month.map((r) => r.plant))]) {
      const pr = hist_plant_month.filter((r) => r.plant === plant);
      const rows = pr.map((r) => ({ net: Number(r.net_mwh), mm: Number(r.mmbtu) })); rows.tech = pr[0].technology;
      out.push(stats(plant, rows, hist_cost.filter((r) => r.plant === plant), fleetTotal));
    }
    const months = [...new Set(hist_plant_month.map((r) => r.month))];
    const fleet = months.map((m) => { const pr = hist_plant_month.filter((r) => r.month === m); return { net: pr.reduce((a, r) => a + Number(r.net_mwh), 0), mm: pr.reduce((a, r) => a + Number(r.mmbtu), 0) }; });
    fleet.tech = 'All technologies';
    out.push(stats('Fleet total', fleet, hist_cost, fleetTotal));
    return out;
  },
});

dash.calc('yoy_plant', {
  inputs: ['hist_plant_month'],
  title: 'Year-over-year net generation',
  description: 'Net GWh by plant for Jul–Dec 2024 vs Jul–Dec 2025 and Apr–Jun 2025 vs Apr–Jun 2026, with % change. Last row: fleet.',
  fn: (hist_plant_month) => {
    const sum = (rows, from, to) => Math.round(rows.filter((r) => r.month >= from && r.month <= to).reduce((a, r) => a + Number(r.net_mwh), 0) / 100) / 10;
    const pct = (a, b) => (a > 0 ? Math.round(((b - a) / a) * 1000) / 10 : null);
    const row = (plant, rows) => {
      const a = sum(rows, '2024-07', '2024-12'), b = sum(rows, '2025-07', '2025-12'), c = sum(rows, '2025-04', '2025-06'), d = sum(rows, '2026-04', '2026-06');
      return { plant, jul_dec_2024_gwh: a, jul_dec_2025_gwh: b, change_jul_dec_pct: pct(a, b), apr_jun_2025_gwh: c, apr_jun_2026_gwh: d, change_apr_jun_pct: pct(c, d) };
    };
    const out = [...new Set(hist_plant_month.map((r) => r.plant))].map((p) => row(p, hist_plant_month.filter((r) => r.plant === p)));
    out.push(row('Fleet total', hist_plant_month));
    return out;
  },
});

dash.calc('unit_totals', {
  inputs: ['hist_units'],
  title: 'Net generation by unit',
  description: 'Net and gross GWh per unit for all months and each fiscal year; months with net output > 0.',
  fn: (hist_units) => {
    const out = [];
    for (const fy of ['All', ...new Set(hist_units.map((r) => r.fy))]) {
      const by = new Map();
      for (const r of hist_units.filter((x) => fy === 'All' || x.fy === fy)) {
        const k = fy + '|' + r.unit;
        if (!by.has(k)) by.set(k, { key: k, fy, plant: r.plant, unit: r.unit, net: 0, gross: 0, months_running: 0, months: 0 });
        const t = by.get(k); t.net += Number(r.net_mwh); t.gross += Number(r.gross_mwh); t.months += 1; if (Number(r.net_mwh) > 0) t.months_running += 1;
      }
      for (const t of by.values()) out.push({ key: t.key, fy: t.fy, plant: t.plant, unit: t.unit, net_gwh: Math.round(t.net / 100) / 10, gross_gwh: Math.round(t.gross / 100) / 10, months_running: t.months_running, months: t.months });
    }
    return out;
  },
});
