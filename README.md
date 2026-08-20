# BTC 20_08_2026 · Setup Monitor

Live monitoring dashboard for the BTC-USD trade setups from the pre-market brief of 2026-08-20 (08:26 UTC). Fetches live market data, validates each setup condition tick-by-tick, shows whether each condition is fulfilled, how far price is from every trigger level (entry zone, stop, T1, T2, volume threshold), and fires a browser alert (banner + sound + notification) the moment a setup validates.

## Data sources (public, no API key)

- **Primary tick stream:** Gate.io WebSocket `spot.tickers` (BTC_USDT) — updates on every trade, direct browser → exchange (WebSockets are not subject to CORS)
- **Fallback price feed:** CoinGecko `simple/price` (id `bitcoin`) polled every 10s when the WebSocket is unreachable
- **Context (5-min cadence):** GitHub Actions workflow (`update-data.yml`, cron `*/5 * * * *`) runs `scripts/update-data.mjs` and commits `data/state.json` on the same origin as the page
  - Gate.io candlesticks (BTC_USDT): session open/high/low/VWAP, ATR14, prior close, 5m/30m closes, 30-min volume vs 30-min average
  - Binance Futures (`premiumIndex`, `openInterest`): perp funding rate (8h, %), open interest (USD)
  - Yahoo Finance `^TYX`: US 30-year Treasury yield (kill-switch input)
  - CoinGecko: BTC / (USDT+USDC) market-cap SSR (liquidity input)

## Setups monitored (from the 2026-08-20 pre-market brief)

Each setup card shows the entry zone, stop, T1, T2, R:R and volume threshold, each with a live distance readout (how far above/below the current price that level sits, green when on the favourable side, red when not), plus every trigger condition with its numeric gap to fulfilment.

| Setup | Direction | Entry zone | Stop | T1 | T2 | R:R | Volume confirm |
|---|---|---|---|---|---|---|---|
| A | LONG | 69,400–69,724 (50% retr / session VWAP / 1.618 ext) | 68,100 (invalidation: 30m close < 68,142) | 71,316 (R1) | 72,562 (61.8% retr) | 1.3 / 2.2 | 30m vol ≥ 1.0× avg + taker-buy > 50% on dip |
| B | LONG | 71,350–71,500 (after 30m close > 71,316) | 69,600 (session VWAP) | 72,562 | 74,297 (2.618 ext) | 1.7 / 2.5 | 30m vol ≥ 1.5× avg |
| C | SHORT | 71,316–71,652 (R1 / EMA200 / 2.0 ext rejection) | 71,652 (EMA200) | 69,600 | 68,142 (1.272 ext) | 2.0 / 3.5 | Rejection candle + taker-sell dominance, vol ≥ 1.0× avg |

Note: the 30-min volume ratio (state.json `vol30/avgVol30m`) is the live proxy for the volume-confirmation thresholds; taker buy/sell dominance is a qualitative tape check from the brief.

## Key levels panel

Classic pivots (prior day H/L/C), fib extensions/retracements (recent swing Jul 21→Aug 3 and macro crash 82,800→56,000), daily SMA/EMA (9/20/50/120/200), volume-profile POC/VAH/VAL, session VWAP, ATR14 — each with a live % distance from current price.

## Event timeline

Informational only (setups are armed 24/7): funding reset 16:00 UTC, FOMC minutes 18:00 UTC today, US PCE Aug 26, Jackson Hole late August.

## Trigger behaviour

When a setup transitions to VALIDATED (all conditions met, not invalidated):
- Full-width flashing banner (direction-coded)
- Sound alert (Web Audio, enabled via "Enable browser alerts")
- Browser notification (if permission granted)
- Timestamped entry in the trigger log

Trigger state is edge-detected (fires once per setup per 15-min window).

## Kill-switches (risk panel)

- Funding (perp) ≥ 0.05% → tighten stops, no new longs
- US 30y yield ≥ 5.30% → hawkish repricing, favor shorts
- OI +2% while price < +0.5% → squeeze exhaustion, suspect new longs
- SSR +5% vs session base → unfunded rally, fade strength

## Deploy

Static site — GitHub Pages (main branch root). The context pipeline is a scheduled GitHub Actions workflow (`update-data.yml`, cron `*/5 * * * *`); the first `data/state.json` is committed so the page works immediately.

```sh
git add -A && git commit -m "setups: refresh to 2026-08-20 pre-market brief (A/B/C)"
git push origin main
gh api -X POST repos/{owner}/btc-20-08-2026-dashboard/pages -f "source[branch]=main" -f "source[path]=/"   # if not already enabled
```

## Disclaimer

Levels and setup parameters originate from the 2026-08-20 BTC-USD pre-market brief (08:26 UTC, Binance data); live-computed values are re-derived from exchange feeds and may differ. Options data (Deribit), CME gaps and CoinLobster funding/liquidation feeds were unavailable for this pair and are not used. Monitoring tool for planning purposes only — not financial advice.