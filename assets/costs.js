/* Shared cost rules. A thermal unit producing less than min_load_pct of its rated capacity (default 10%) is at
   "low output": it is idling or warming up, so the cost per kWh PREPA reports for it (fuel burned ÷ a tiny output)
   is not representative. Its $/hour still counts, but plant prices use units at normal load, or the plant's typical
   price at normal load over the last 7 days. */
window.COSTS = (() => {
  const RENEW = new Set(['Hydro', 'Solar', 'Wind', 'Landfill gas']);
  const D = (id) => (dash.data(id).data || []);
  const minPct = () => { const s = D('settings')[0] || {}; return (s.min_load_pct ?? 10) / 100; };
  const group = (p) => (window.PREPA ? window.PREPA.plantGroup(p) : p);
  function ratedOf(u) {
    const cap = (D('unit_capacity')[0] || { units: {} }).units, rng = D('unit_ranges')[0] || {};
    return (cap[u.unit_id] || {}).rated_mw || (rng[u.unit_id] || {}).max_on_mw || null;
  }
  function lowLoad(u) {
    if (u.status !== 'Generating' || !(Number(u.cost_cents_kwh) > 0) || RENEW.has(window.GX.norm(u.fuel))) return false;
    const r = ratedOf(u), mw = Number(u.mw);
    return r ? mw < minPct() * r : mw < 3;
  }
  function plantRated(p) {
    const plants = (D('unit_capacity')[0] || {}).plants || {};
    if (plants[p] && plants[p].rated_mw) return plants[p].rated_mw;
    let s = 0, n = 0; for (const u of D('live_units')) if (group(u.plant) === p) { const r = ratedOf(u); if (r) { s += r; n++; } }
    return n ? s : null;
  }
  // a plant-level reading is "normal" when the plant produces at least min_load_pct of its rated capacity
  function normalPlantMW(p, mw) { const r = plantRated(p); return r ? mw >= minPct() * r : mw >= 3; }
  const typicalCache = new Map();
  function typicalPrice(p) { // median $/MWh over the last 7 days of readings at normal load (at least 25% of rated)
    const key = p + '|' + D('cost_hourly').length + '|' + D('history').length;
    if (typicalCache.has(key)) return typicalCache.get(key);
    const r = plantRated(p), rows = [...D('cost_hourly'), ...D('history')].filter((x) => x.at && x.plant_mw);
    const last = rows.reduce((a, x) => (x.at > a ? x.at : a), ''), cut = last ? new Date(new Date(last) - 7 * 864e5).toISOString() : '';
    const vals = rows.filter((x) => new Date(x.at).toISOString() >= cut).map((x) => ({ mw: x.plant_mw[p] || 0, c: (x.plant_cost || {})[p] || 0 }))
      .filter((v) => v.c > 0 && (r ? v.mw >= 0.25 * r : v.mw >= 10)).map((v) => v.c / v.mw).sort((a, b) => a - b);
    const out = vals.length ? vals[Math.floor(vals.length / 2)] : null;
    typicalCache.set(key, out); return out;
  }
  // price of a plant from its generating units now: { price ($/MWh), basis: 'now' | 'typical' | 'low' }
  function plantPrice(plant, units) {
    const gen = units.filter((u) => u.status === 'Generating' && Number(u.cost_cents_kwh) > 0);
    const normal = gen.filter((u) => !lowLoad(u));
    if (normal.length) { const mw = normal.reduce((a, u) => a + Number(u.mw), 0); return { price: normal.reduce((a, u) => a + Number(u.cost_usd_per_hour), 0) / mw, basis: 'now' }; }
    if (gen.length) { const t = typicalPrice(plant); if (t != null) return { price: t, basis: 'typical' };
      const mw = gen.reduce((a, u) => a + Number(u.mw), 0); return { price: gen.reduce((a, u) => a + Number(u.cost_usd_per_hour), 0) / mw, basis: 'low' }; }
    return { price: null, basis: null };
  }
  return { lowLoad, plantRated, normalPlantMW, typicalPrice, plantPrice, minPct };
})();
