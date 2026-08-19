"use strict";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATE_CANDLES = "https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=BTC_USDT";
const DAY = 86400;

async function jfetch(url, opts) {
  const r = await fetch(url, opts || {});
  if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
  return r.json();
}

function candles(interval, from, to, limit) {
  let u = GATE_CANDLES + "&interval=" + interval;
  if (from) u += "&from=" + from;
  if (to) u += "&to=" + to;
  if (limit) u += "&limit=" + limit;
  return jfetch(u);
}

async function candlesAll(interval, from, to) {
  const all = [];
  let t = to;
  while (t > from) {
    const batch = await candles(interval, null, t, 1000);
    if (!batch.length) break;
    all.unshift(...batch);
    t = batch[0][0] - 60;
  }
  return all;
}

const STATE_FILE = path.join(__dirname, "..", "data", "state.json");
let prev = {};
try { prev = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) { }

const now = Math.floor(Date.now() / 1000);
const dayStart = Math.floor(now / DAY) * DAY;
const prevStart = dayStart - DAY;

const [m1, h48, d22] = await Promise.all([
  candlesAll("1m", dayStart, now),
  candles("1h", prevStart, now, 60),
  candles("1d", null, null, 22)
]);

const m1s = (m1 || []).map(c => ({ ts: +c[0], c: +c[2], h: +c[3], l: +c[4], o: +c[5], v: +c[6] }))
  .filter(c => c.ts >= dayStart).sort((a, b) => a.ts - b.ts);
const h1s = (h48 || []).map(c => ({ ts: +c[0], c: +c[2], h: +c[3], l: +c[4], o: +c[5], v: +c[6] }))
  .sort((a, b) => a.ts - b.ts);
const d1s = (d22 || []).map(c => ({ ts: +c[0], c: +c[2], h: +c[3], l: +c[4], o: +c[5], v: +c[6] }))
  .sort((a, b) => a.ts - b.ts);

const out = {
  ts: now, dayStart, source: "gate.io", session: null, prior: null,
  avgVol20: null, atrDaily: null, atr1h: null, last1hClose: null,
  close5m: null, close30m: null, vol30: null, avgVol30m: null,
  funding: null, oi: null, yield30y: null, ssr: null,
  spark: []
};

if (m1s.length) {
  let pv = 0, tv = 0;
  for (const c of m1s) { pv += ((c.h + c.l + c.c) / 3) * c.v; tv += c.v; }
  out.session = {
    open: m1s[0].o,
    high: Math.max(...m1s.map(c => c.h)),
    low: Math.min(...m1s.map(c => c.l)),
    vwap: tv > 0 ? pv / tv : null,
    vol: m1s.reduce((a, c) => a + c.v, 0)
  };
  out.spark = m1s.slice(-180).map(c => [c.ts, c.c]);

  const last = m1s[m1s.length - 1].ts;
  const bucketClose = (sec) => {
    const boundary = Math.floor(last / sec) * sec;
    const endTs = boundary - 60;
    const c = m1s.find(x => x.ts === endTs);
    return c ? c.c : null;
  };
  out.close5m = bucketClose(300);
  out.close30m = bucketClose(1800);

  const last30 = m1s.filter(c => c.ts > now - 1800);
  out.vol30 = last30.reduce((a, c) => a + c.v, 0);
  const elapsedMin = Math.max(1, (now - dayStart) / 60);
  out.avgVol30m = (m1s.reduce((a, c) => a + c.v, 0) / elapsedMin) * 30;
}

const yestH = h1s.filter(c => c.ts >= prevStart && c.ts < dayStart);
if (yestH.length) {
  let pv = 0, tv = 0;
  for (const c of yestH) { pv += ((c.h + c.l + c.c) / 3) * c.v; tv += c.v; }
  out.prior = { vwap: tv > 0 ? pv / tv : null, close: d1s.filter(c => c.ts < dayStart).slice(-1)[0]?.c ?? null };
}
const closedH = h1s.filter(c => c.ts < now - 3600);
if (closedH.length) out.last1hClose = closedH[closedH.length - 1].c;

const prevDays = d1s.filter(c => c.ts < dayStart);
const last20 = prevDays.slice(-20);
if (last20.length === 20) out.avgVol20 = last20.reduce((a, c) => a + c.v, 0) / 20;

function atr14(list) {
  if (list.length < 15) return null;
  const last15 = list.slice(-15);
  let trs = [];
  for (let i = 0; i < last15.length; i++) {
    const pc = i === 0 ? last15[0].o : last15[i - 1].c;
    trs.push(Math.max(last15[i].h - last15[i].l, Math.abs(last15[i].h - pc), Math.abs(last15[i].l - pc)));
  }
  return trs.reduce((a, b) => a + b, 0) / 14;
}
out.atrDaily = atr14(d1s);
out.atr1h = atr14(h1s);

async function withPrev(key, fn) {
  try {
    const v = await fn();
    if (v !== null && v !== undefined) { out[key] = v; return v; }
  } catch (e) {
    out[key] = prev[key] ?? null;
    return prev[key] ?? null;
  }
  return null;
}

await withPrev("funding", async () => {
  const d = await jfetch("https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT");
  return parseFloat(d.lastFundingRate) * 100;
});

await withPrev("oi", async () => {
  const [o, p] = await Promise.all([
    jfetch("https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT"),
    jfetch("https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT")
  ]);
  return parseFloat(o.openInterest) * parseFloat(p.markPrice);
});

await withPrev("yield30y", async () => {
  const d = await jfetch("https://query1.finance.yahoo.com/v8/finance/chart/%5ETYX?interval=1d&range=1d", {
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  const m = d.chart?.result?.[0]?.meta;
  return m ? parseFloat(m.regularMarketPrice) : null;
});

await withPrev("ssr", async () => {
  const d = await jfetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,tether,usd-coin&vs_currencies=usd&include_market_cap=true");
  const btc = d.bitcoin?.usd_market_cap;
  const st = (d.tether?.usd_market_cap || 0) + (d["usd-coin"]?.usd_market_cap || 0);
  return btc && st > 0 ? btc / st : null;
});

fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
fs.writeFileSync(STATE_FILE, JSON.stringify(out));
console.log("state.json written:", JSON.stringify(out).length, "bytes");