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
  /* Fuel check: does a unit's cost per kWh match the fuel it reports?
     Expected cost of each fuel at this kind of unit = fuel price ($/MMBtu, from PREPA's fuel prices in the feed) × a typical
     heat rate (MMBtu per MWh): steam 10.5, combined cycle 7.5, gas turbine 11.5. The estimated fuel is the candidate whose
     expected cost is closest to the unit's reported cost (compared as a ratio). Steam units can burn LNG or Bunker C;
     combined-cycle and gas turbines LNG or diesel. Low-output units are not classified. */
  const HEAT_RATE = { steam: 10.5, cc: 7.5, gt: 11.5 }, TECH_LABEL = { steam: 'steam', cc: 'combined cycle', gt: 'gas turbine' };
  const MMBTU_PER_BBL = { 'Bunker C': 6.287, ULSD: 5.825 };
  const techOf = (plant) => (/CC/.test(plant) || plant === 'EcoEléctrica' ? 'cc' : /Steam/.test(plant) || plant === 'AES' ? 'steam' : 'gt');
  function fuelPrices() { // $/MMBtu
    const fp = D('live_fuel_price'), avg = (f) => { const v = fp.filter((r) => window.GX.norm(r.fuel) === f && Number(r.price) > 0).map((r) => Number(r.price)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const bunker = avg('Bunker C'), diesel = avg('ULSD'), lng = avg('LNG');
    return { 'Bunker C': (bunker || 110) / MMBTU_PER_BBL['Bunker C'], ULSD: (diesel || 185) / MMBTU_PER_BBL.ULSD, LNG: lng || 9, Coal: 4.5 };
  }
  function expectedCosts(tech, reported) { // ¢/kWh by candidate fuel
    const p = fuelPrices(), hr = HEAT_RATE[tech], cand = reported === 'Coal' ? ['Coal', 'LNG', 'Bunker C'] : tech === 'steam' ? ['LNG', 'Bunker C'] : ['LNG', 'ULSD'];
    return Object.fromEntries(cand.map((f) => [f, (p[f] * hr) / 10]));
  }
  function fuelCheck(u) {
    const reported = window.GX.norm(u.fuel), cost = Number(u.cost_cents_kwh);
    if (RENEW.has(reported)) return { reported, estimated: null, flag: false, why: 'renewable' };
    if (u.status !== 'Generating' || !(cost > 0)) return { reported, estimated: null, flag: false, why: 'not generating or no cost reported' };
    if (lowLoad(u)) return { reported, estimated: null, flag: false, why: 'low output: cost not representative' };
    const tech = techOf(group(u.plant)), exp = expectedCosts(tech, reported);
    const estimated = Object.keys(exp).reduce((a, f) => (Math.abs(Math.log(cost / exp[f])) < Math.abs(Math.log(cost / exp[a])) ? f : a));
    return { reported, estimated, flag: estimated !== reported, tech, expected: exp, cost };
  }
  const FUEL_NAME = { LNG: 'Natural gas (LNG)', 'Bunker C': 'Bunker C', ULSD: 'Diesel', Coal: 'Coal' };
  function fuelMatrix() { return Object.keys(HEAT_RATE).map((t) => ({ tech: TECH_LABEL[t], expected: expectedCosts(t, null) })); }
  return { lowLoad, plantRated, normalPlantMW, typicalPrice, plantPrice, minPct, fuelCheck, fuelMatrix, fuelPrices, FUEL_NAME, TECH_LABEL };
})();
