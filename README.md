# BTC 20_08_2026 · FOMC Setup Monitor

Live monitoring dashboard for the FOMC-minutes day-trading setup (brief dated 2026-08-19). Fetches live market data, validates each setup condition tick-by-tick, shows whether each condition is fulfilled and how far it is from being satisfied, and fires a browser alert (banner + sound + notification) the moment a setup validates.

## Data sources (public, no API key)

- **Primary tick stream:** Gate.io WebSocket `spot.tickers` (BTC_USDT) — updates on every trade, direct browser → exchange (WebSockets are not subject to CORS)
- **Fallback price feed:** CoinGecko `simple/price` (id `bitcoin`) polled every 10s when the WebSocket is unreachable
- **Context (5-min cadence):** GitHub Actions workflow (`update-data.yml`, cron `*/5 * * * *`) runs `scripts/update-data.mjs` and commits `data/state.json` on the same origin as the page
  - Gate.io candlesticks (BTC_USDT): session open/high/low/VWAP, ATR14, prior close, 5m/30m closes, 30-min volume vs 30-min average
  - Binance Futures (`premiumIndex`, `openInterest`): perp funding rate (8h, %), open interest (USD)
  - Yahoo Finance `^TYX`: US 30-year Treasury yield (kill-switch input)
  - CoinGecko: BTC / (USDT+USDC) market-cap SSR (liquidity input)

## Event gates (UTC, FOMC minutes day)

| Phase | Window | Rule |
|---|---|---|
| PRE-EVENT | < 18:00 | Flat, no entries |
| RELEASE | 18:00–18:05 | No market orders |
| TRADE WINDOW | 18:05–18:45 | Setups active |
| STAND DOWN | 18:45–20:00 | No new entries |
| FORCE-FLAT | ≥ 20:00 | Session over |

## Setups monitored (from the brief)

| Setup | Direction | Trigger conditions | Stop | T1 | T2 |
|---|---|---|---|---|---|
| A | LONG | Window open + minutes NOT hawkish + 30m close > 69,042 (200D SMA) + post-print vol ≥ avg + 30m close ≥ 68,184 + DXY NOT up >0.3% | 68,184 | 69,804 | 71,594 |
| B | SHORT | Window open + minutes hawkish breadth + 5m close < 68,184 (S1 breakdown) + 5m close < 69,042 | 69,300 | 66,910 | 65,805 |
| C | RANGE (2 legs, half size) | Window open + minutes neutral + price in 68,184–69,804 band + 30m close in 68,000–70,150 | leg: 70,150 / 67,900 | 68,400 / 69,500 | — |

Each setup card lists every condition with a green tick (fulfilled), red cross (not fulfilled), or amber circle (manual flag pending), plus the numeric gap to satisfying it (e.g. "gap 1,036 (1.50%)", "opens in 12m", "ratio 0.85x"). A progress bar shows % of conditions met.

## Manual flags

The minutes text is not machine-readable — after reading the release, toggle the buttons that feed the setups:
- **Minutes: hawkish breadth confirmed** (enables B, blocks A/C)
- **Minutes: dovish lean** (blocks C)
- **DXY up >0.3% post-print** (invalidates A)

## Trigger behaviour

When a setup transitions to VALIDATED:
- Full-width flashing banner (direction-coded)
- Sound alert (Web Audio, enabled via "Enable browser alerts")
- Browser notification (if permission granted)
- Timestamped entry in the trigger log

Trigger state is edge-detected (fires once per setup per 15-min window).

## Kill-switches (risk panel)

- Funding (perp) ≥ 0.05% → tighten stops, no new longs
- US 30y yield ≥ 5.30% → hawkish repricing, favor shorts
- OI +2% while price < +0.5% → squeeze exhaustion, suspect new longs
- SSR +5% vs session base → unfunded rally, fade into 70k

## Deploy

Static site — deploy to GitHub Pages (main branch root). The context pipeline is a scheduled GitHub Actions workflow (`update-data.yml`, cron `*/5 * * * *`); the first `data/state.json` is committed so the page works immediately.

```sh
git init && git add -A && git commit -m "init"
gh repo create btc-20-08-2026-dashboard --public --source=. --remote=origin --push
gh api -X POST repos/{owner}/btc-20-08-2026-dashboard/pages -f "source[branch]=main" -f "source[path]=/"
```

## Disclaimer

Levels and setup parameters originate from the 2026-08-19 FOMC pre-market brief; live-computed values are re-derived from exchange feeds and may differ. Monitoring tool for planning purposes only — not financial advice.
