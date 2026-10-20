# Automatic logs

Written by the GitHub Action every 15 minutes (Puerto Rico time, UTC-4).

| File | What it holds |
|---|---|
| `outages/YYYY-MM-DD.log` | One line each time a unit goes offline (below 1 MW) or comes back, with MW before and after. |
| `daily/YYYY-MM-DD.txt` | Daily summary: max / min / average demand, max / min generation, frequency max / min / average, fuel shares and majority fuel, total dispatch cost of the day and average $/kWh, outages. Updated through the day; marked *Complete* after midnight. |
| `daily_summary.csv` | The same summary, one row per day, for spreadsheets. |
