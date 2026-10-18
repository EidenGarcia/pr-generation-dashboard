# Puerto Rico generation dashboards

Two static web pages, hosted free on GitHub Pages and refreshed every hour by a GitHub Action. No server, no database, no API keys.

| Page | What it shows |
|---|---|
| `index.html` — **Live operations** | Generation and frequency for the last 24 hours with actual capacity, today’s peak, and a 24-hour forecast of load and capacity · frequency against IEEE limits with an excursion log · outage alerts and the outage log · every plant and unit · energy mix and dispatch cost · portal health (uptime, response time, data freshness) |
| `analysis.html` — **Cost & trends** | What a kWh of fuel and purchased power costs customers (PREB FCA + PPCA) and a household calculator · live dispatch cost trend from the hourly history · Genera’s fuel cost by plant and fuel from its quarterly filings · generation statistics and data-quality checks |

## Set it up (about 10 minutes)

1. **Create a repository** on GitHub (public, so Pages and Actions are free), e.g. `pr-generation`.
2. **Upload everything in this folder** (keep the folder structure, including the hidden `.github` folder and `.nojekyll`).
   - Easiest: on the repo page choose *Add file → Upload files* and drag the whole unzipped folder in, or use `git push`.
3. **Let the Action write data:** *Settings → Actions → General → Workflow permissions →* **Read and write permissions** → Save.
4. **Turn on the website:** *Settings → Pages → Build and deployment → Source:* **Deploy from a branch**, Branch **main**, folder **/ (root)** → Save. Your site appears at `https://<your-user>.github.io/<repo>/` within a minute or two.
5. **Run the first update now:** *Actions → Hourly PREPA update → Run workflow.* After that it runs by itself every hour.

That’s it. Each run commits the new files in `data/`; GitHub Pages republishes them and any open page refreshes its data within five minutes.

## How it works

```
GitHub Action (hourly)                         GitHub Pages
 └─ scripts/update.mjs                          ├─ index.html     (live)
     ├─ GET dataSource.js  ─┐                   ├─ analysis.html  (cost & trends)
     ├─ GET dataGraph.js   ─┼─► data/*.json ──► └─ assets/*.js read data/*.json
     ├─ log portal health   │
     ├─ detect outages      │   (committed to the repo every hour)
     ├─ append history      │
     └─ build forecast     ─┘
```

* **Safe parsing.** The feeds are JavaScript files. The updater reads them with a small literal parser and never executes them.
* **dataGraph.js layout.** The updater recognises three common layouts (array of objects, labels + parallel arrays, time/value pairs) and classifies series by name and value range (≈60 → frequency in Hz, hundreds+ → MW). What it found is written to `data/graph_meta.json`; check it after the first run.
* **Outage log.** A unit counts as offline below 1 MW. Each run compares every unit with the previous run and logs “Went offline” / “Back online”.
* **Forecast.** Hour-of-day load profile from the 24-hour trace plus all hourly history (recent days weigh more), adjusted to the current level, blended with PREPA’s own next-hour figure for hour one. Capacity follows its own hour-of-day profile after two days of history; until then it is held at current available capacity. The band is roughly an 80% range. Accuracy is tracked: each history row stores what the previous run forecast for that hour, and the Cost & trends page reports the average error.
* **Frequency limits.** Each 5-minute frequency reading is placed in a level set in `data/frequency_limits.json`:

  | Level | Range | Basis | Time allowed |
  |---|---|---|---|
  | Normal | 59.8–60.2 Hz | Dashboard setting (adjustable) | — |
  | Watch | 59.4–59.8 / 60.2–60.6 Hz | Generator continuous-operation limits (WECC, AESO practice) | continuous |
  | Alert | 58.8–59.4 / 60.6–61.2 Hz | Inside IEEE 1547-2018 continuous operation | about 3 min |
  | Critical | below 58.8 / above 61.2 Hz | Outside IEEE 1547-2018 continuous operation | 299 s ride-through |

  Trip lines on the chart are the IEEE 1547-2018 defaults (UF1 58.5 Hz / OF1 61.2 Hz after 300 s, UF2 56.5 Hz / OF2 62.0 Hz in 0.16 s). Any reading outside Normal starts an excursion in `data/frequency_events.json` with start, end, extreme, estimated duration and whether it outlasted the time allowed (“Exceeded” when seen on consecutive readings, “Possibly exceeded” when a single reading could have lasted longer). With 5-minute readings, dips shorter than the interval can be missed.
* **Portal health.** Every request is logged to `data/feed_health.json` (HTTP status, response time, size, PREPA’s timestamp, data age). History keeps 90 days; the health log 30 days.

## Files you update by hand

| File | When |
|---|---|
| `data/customer_fuel_charges.json` | Each quarter, when PREB approves new FCA / PPCA factors (case NEPR-MI-2020-0001). Add a row. |
| `data/hist_*.json`, `data/fuel_prices.json` | When Genera files a new quarterly “Fuel Consumption, Generation & Heat Rates” exhibit (docket NEPR-MI-2019-0007). |

## Things to know

* **GitHub’s schedule is best-effort:** runs can start a few minutes late, and at very busy times an hour can be skipped. The portal-health heat map shows any gaps honestly.
* **If PREPA blocks GitHub’s servers** the health panel will show failures with the HTTP code. The fix is a [self-hosted runner](https://docs.github.com/actions/hosting-your-own-runners) on any computer in Puerto Rico: change `runs-on: ubuntu-latest` to `runs-on: self-hosted`.
* **Scheduled workflows pause after 60 days without repository activity.** The hourly data commits count as activity, so this only happens if the updater stops committing.
* **Test locally:** `node scripts/update.mjs data` (Node 18+), then `python3 -m http.server` and open `http://localhost:8000`.
* Estimates are labelled on the pages: dispatch cost uses each unit’s reported ¢/kWh; the historical fuel bill prices filed fuel volumes at current prices; the forecast is this project’s estimate, not PREPA’s.

## Sources

* PREPA operational data: https://operationdata.prepa.pr.gov/dataSource.js and https://operationdata.prepa.pr.gov/dataGraph.js
* Genera quarterly exhibits, PREB docket NEPR-MI-2019-0007: https://energia.pr.gov/
* PREB FCA/PPCA resolutions, case NEPR-MI-2020-0001
* LNG price formula: New Fortress Energy–Puerto Rico gas supply agreement (Sept 2025); Henry Hub: EIA Short-Term Energy Outlook
