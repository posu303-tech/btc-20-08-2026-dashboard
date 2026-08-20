"use strict";

const GATE_WS = "wss://api.gateio.ws/ws/v4/";
const PAIR = "BTC_USDT";
const STATE_URL = "data/state.json";
const STATE_MAX_AGE = 8 * 60 * 1000;
const CG_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true";

const EVENTS = [
  { hhmm: "16:00", label: "Funding reset (perp)" },
  { hhmm: "18:00", label: "FOMC minutes (Jul 28–29)" }
];

const PRIOR_CLOSE = 69264.9;
const LEVELS = [
  { name: "R3 — classic pivot", price: 76951, method: "P + 2×(H−L)" },
  { name: "2.618 fib ext", price: 74297, method: "fib ext (swing Jul21→Aug3)" },
  { name: "61.8% retr (crash)", price: 72562, method: "fib 82,800→56,000" },
  { name: "R2 — classic pivot", price: 73368, method: "P + (H−L)" },
  { name: "Decision — EMA200", price: 71652, method: "daily EMA200" },
  { name: "R1 — classic pivot", price: 71316, method: "2P − L" },
  { name: "2.0 fib ext", price: 71471, method: "fib ext (swing)" },
  { name: "1.618 fib ext", price: 69724, method: "fib ext (swing)" },
  { name: "50% retr (crash)", price: 69400, method: "fib 82,800→56,000" },
  { name: "SMA200", price: 68967, method: "daily SMA200" },
  { name: "1.272 fib ext", price: 68142, method: "fib ext (swing)" },
  { name: "0.786 fib", price: 65919, method: "retracement (swing)" }
];

const SETUPS = [
  {
    id: "A", name: "Pullback long (continuation)", dir: "LONG", side: 1,
    entry: { lo: 69400, hi: 69724, label: "69,400–69,724" },
    stop: 68100, t1: 71316, t2: 72562, rr: "1.3 / 2.2",
    invalidate: "4h/30m close < 68,142 (1.272 ext) — stop 68,100",
    vol: 1.0, volLabel: "4h vol ≥ 1.0× avg",
    conds: [
      { k: "band", lo: 69400, hi: 69724, use: "price", label: "Price in entry zone 69,400–69,724" },
      { k: "above", v: 68142, use: "close30m", label: "Not invalidated: 30m close ≥ 68,142 (1.272 ext)" },
      { k: "vol", min: 1.0, label: "Volume confirm: 30m vol ≥ 1.0× avg" }
    ]
  },
  {
    id: "B", name: "Breakout continuation (momentum)", dir: "LONG", side: 1,
    entry: { lo: 71350, hi: 71500, label: "71,350–71,500" },
    stop: 69600, t1: 72562, t2: 74297, rr: "1.7 / 2.5",
    invalidate: "4h/30m close back < 69,600 (session VWAP)",
    vol: 1.5, volLabel: "4h vol > 1.5× avg",
    conds: [
      { k: "above", v: 71316, use: "close30m", label: "4h/30m close > 71,316 (R1 breakout)" },
      { k: "band", lo: 71350, hi: 71500, use: "price", label: "Price in entry zone 71,350–71,500" },
      { k: "vol", min: 1.5, label: "Volume confirm: 30m vol ≥ 1.5× avg" }
    ]
  },
  {
    id: "C", name: "Mean-reversion short (small size)", dir: "SHORT", side: -1,
    entry: { lo: 71316, hi: 71652, label: "71,316–71,652" },
    stop: 71652, t1: 69600, t2: 68142, rr: "2.0 / 3.5",
    invalidate: "4h/30m close > 71,652 (EMA200)",
    vol: 1.0, volLabel: "rejection candle + taker-sell dom",
    conds: [
      { k: "band", lo: 71316, hi: 71652, use: "price", label: "Price in rejection zone 71,316–71,652" },
      { k: "below", v: 71652, use: "close30m", label: "Not invalidated: 30m close < 71,652 (EMA200)" },
      { k: "vol", min: 1.0, label: "Volume confirm: 30m vol ≥ 1.0× avg" }
    ]
  }
];

const state = {
  last: null, change24: null, feed: "none", wsFails: 0, cgActive: false,
  sesOpen: null, sesHigh: null, sesLow: null, vwap: null, sesVol: 0,
  priorClose: PRIOR_CLOSE, priorVwap: null, avgVol20: null,
  atrDaily: null, atr1h: null, last1hClose: null,
  close5m: null, close30m: null, vol30: null, avgVol30m: null,
  funding: null, oi: null, yield30y: null, ssr: null,
  prevOi: null, ssrBase: null,
  candles1m: [], stateTs: null, lastUpdated: null,
  prevStatus: {}, fired: {},
  lastTripKey: ""
};

const $ = (id) => document.getElementById(id);

function fmt(n, d = 2) {
  if (n === null || n === undefined || isNaN(n)) return "--";
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtBig(n) {
  if (n === null || n === undefined || isNaN(n)) return "--";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toFixed(0);
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function log(msg, cls) {
  const li = document.createElement("li");
  const t = document.createElement("span");
  t.className = "t";
  t.textContent = new Date().toISOString().slice(11, 19) + "Z  ";
  li.appendChild(t);
  const e = document.createElement("span");
  e.className = cls || "ev";
  e.textContent = msg;
  li.appendChild(e);
  $("log").prepend(li);
  while ($("log").children.length > 60) $("log").lastChild.remove();
}

function todayUTC(hm) {
  const [h, m] = hm.split(":").map(Number);
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m, 0);
}

function getPhase() {
  const now = Date.now();
  const upcoming = EVENTS.map(e => ({ ts: todayUTC(e.hhmm), label: e.label }))
    .filter(e => e.ts > now)
    .sort((a, b) => a.ts - b.ts);
  return { phase: "MONITORING", next: upcoming[0] || null };
}

async function fetchState() {
  try {
    const r = await fetch(STATE_URL + "?v=" + Date.now());
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    if (!d || !d.ts) throw new Error("bad payload");
    state.stateTs = d.ts * 1000;
    state.sesOpen = d.session && d.session.open;
    state.sesHigh = d.session && d.session.high;
    state.sesLow = d.session && d.session.low;
    state.vwap = d.session && d.session.vwap;
    state.sesVol = d.session ? d.session.vol : 0;
    if (d.prior) {
      state.priorClose = d.prior.close ?? state.priorClose;
      state.priorVwap = d.prior.vwap;
    }
    state.avgVol20 = d.avgVol20;
    state.atrDaily = d.atrDaily;
    state.atr1h = d.atr1h;
    state.last1hClose = d.last1hClose;
    state.close5m = d.close5m;
    state.close30m = d.close30m;
    state.vol30 = d.vol30;
    state.avgVol30m = d.avgVol30m;
    state.funding = d.funding;
    if (state.oi !== null && d.oi !== undefined && d.oi !== state.oi) state.prevOi = state.oi;
    state.oi = d.oi;
    state.yield30y = d.yield30y;
    state.ssr = d.ssr;
    if (state.ssrBase === null && d.ssr) state.ssrBase = d.ssr;
    if (state.prevOi === null && d.oi) state.prevOi = d.oi;
    if (Array.isArray(d.spark)) state.candles1m = d.spark;
    state.stateOk = true;
    if (state.last === null && d.spark && d.spark.length) {
      state.last = d.spark[d.spark.length - 1][1];
      if (state.feed === "none" || state.feed === "state") setFeed("state", "using state.json price");
    }
  } catch (e) {
    state.stateOk = false;
    log("context refresh failed: " + e.message, "ev");
  }
}

let cgTimer = null, cgBackoff = 10000;
async function pollCoinGecko() {
  try {
    const r = await fetch(CG_URL + "&x=" + Date.now());
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    if (!j.bitcoin || typeof j.bitcoin.usd !== "number") throw new Error("no bitcoin data");
    state.last = j.bitcoin.usd;
    if (typeof j.bitcoin.usd_24h_change === "number") state.change24 = j.bitcoin.usd_24h_change;
    cgBackoff = 10000;
    if (state.feed !== "gate-ws") setFeed("coingecko", "polling every 10s");
  } catch (e) {
    cgBackoff = Math.min(cgBackoff * 1.5, 60000);
    log("coingecko poll failed: " + e.message + " (retry in " + cgBackoff / 1000 + "s)", "ev");
    if (state.feed === "coingecko") setFeed("state", "coingecko failing — state.json price");
  }
  if (state.cgActive) cgTimer = setTimeout(pollCoinGecko, cgBackoff);
}
function startCoinGecko() {
  if (state.cgActive) return;
  state.cgActive = true;
  log("gate WS unavailable — switching to CoinGecko REST (10s)", "ev");
  pollCoinGecko();
}
function stopCoinGecko() {
  state.cgActive = false;
  if (cgTimer) { clearTimeout(cgTimer); cgTimer = null; }
}

function setFeed(feed, note) {
  state.feed = feed;
  log("feed: " + feed + (note ? " — " + note : ""), "ev");
}

function connectWS() {
  let ws = null, attempts = 0;
  const open = () => {
    attempts++;
    try { ws = new WebSocket(GATE_WS); } catch (e) {
      state.wsFails++;
      if (state.wsFails >= 3) startCoinGecko();
      return;
    }
    ws.onopen = () => {
      state.wsFails = 0;
      stopCoinGecko();
      setFeed("gate-ws", "tick stream live");
      ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: "spot.tickers", event: "subscribe", payload: [PAIR] }));
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.event === "update" && msg.channel === "spot.tickers") {
        const r = msg.result;
        if (r && r.last) {
          state.last = parseFloat(r.last);
          if (r.change_percentage !== undefined) state.change24 = parseFloat(r.change_percentage);
          evaluate();
        }
      }
    };
    ws.onclose = () => {
      if (!state.cgActive) state.wsFails++;
      if (state.wsFails >= 3) startCoinGecko();
      setTimeout(open, 3000);
    };
    ws.onerror = () => {
      try { ws.close(); } catch (e) { }
      if (state.wsFails >= 3) startCoinGecko();
    };
  };
  open();
  setInterval(() => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: "spot.ping" }));
  }, 30000);
}

function refVal(cond) {
  if (cond.use === "close5m") return state.close5m ?? state.last;
  if (cond.use === "close30m") return state.close30m ?? state.last;
  return state.last;
}

function condMet(cond) {
  const p = refVal(cond);
  switch (cond.k) {
    case "above": return p > cond.v;
    case "below": return p < cond.v;
    case "vol": {
      const r = (state.vol30 ?? 0) / (state.avgVol30m || 1);
      return r >= (cond.min ?? 1.0);
    }
    case "band": return p >= cond.lo && p <= cond.hi;
  }
  return false;
}

function condNote(cond) {
  const p = refVal(cond);
  switch (cond.k) {
    case "above": {
      const gap = cond.v - p;
      return gap > 0 ? "gap " + fmt(gap) + " (" + fmt(Math.abs(gap) / cond.v * 100, 2) + "%)" : "OK";
    }
    case "below": {
      const gap = p - cond.v;
      return gap > 0 ? "gap " + fmt(gap) + " (" + fmt(Math.abs(gap) / cond.v * 100, 2) + "%)" : "OK";
    }
    case "vol": {
      const r = (state.vol30 ?? 0) / (state.avgVol30m || 1);
      const min = cond.min ?? 1.0;
      return r >= min ? "OK " + fmt(r, 2) + "x" : "ratio " + fmt(r, 2) + "x (needs " + min + "x)";
    }
    case "band": {
      if (p < cond.lo) return "gap " + fmt(cond.lo - p) + " below";
      if (p > cond.hi) return "gap " + fmt(p - cond.hi) + " above";
      return "in zone";
    }
  }
  return "--";
}

function condProgress(cond) {
  const p = refVal(cond);
  const met = condMet(cond);
  switch (cond.k) {
    case "above": {
      const span = Math.abs(cond.v - 68142) || 1000;
      return met ? 100 : clamp(100 - (cond.v - p) / span * 100, 0, 99);
    }
    case "below": {
      const span = Math.abs(cond.v - 71652) || 1000;
      return met ? 100 : clamp(100 - (p - cond.v) / span * 100, 0, 99);
    }
    case "vol": {
      const r = (state.vol30 ?? 0) / (state.avgVol30m || 1);
      const min = cond.min ?? 1.0;
      return met ? 100 : clamp(r / min * 100, 0, 99);
    }
    case "band": {
      if (met) return 100;
      const dlo = Math.max(0, cond.lo - p), dhi = Math.max(0, p - cond.hi);
      const d = Math.max(dlo, dhi);
      const span = (cond.hi - cond.lo) / 2;
      return clamp(100 - d / span * 100, 0, 99);
    }
  }
  return met ? 100 : 0;
}

function setupInvalid(setup) {
  const c30 = state.close30m ?? state.last;
  if (setup.id === "A") return c30 < 68142;
  if (setup.id === "B") return c30 < 69600;
  if (setup.id === "C") return c30 > 71652;
  return false;
}

function evaluate() {
  if (state.last === null) return;
  for (const setup of SETUPS) {
    const results = setup.conds.map(c => ({ c, met: condMet(c), note: condNote(c), prog: condProgress(c) }));
    const metCount = results.filter(r => r.met).length;
    const total = results.length;
    const pct = Math.round(metCount / total * 100);
    const invalid = setupInvalid(setup);
    let status = "armed";
    if (invalid) status = "invalid";
    else if (metCount === total) status = "valid";
    else if (metCount >= total - 1 || pct >= 80) status = "near";

    const prev = state.prevStatus[setup.id];
    if (status === "valid" && prev !== "valid") fireTrigger(setup);
    state.prevStatus[setup.id] = status;
    renderSetup(setup, results, status, pct);
  }
}

function fireTrigger(setup) {
  const key = setup.id + "_" + new Date().toUTCString().slice(0, 16);
  if (state.fired[key]) return;
  state.fired[key] = true;
  log("TRIGGER FIRED — Setup " + setup.id + " " + setup.name + " (" + setup.dir + ") @ " + fmt(state.last), "ok");
  log("Levels — entry " + setup.entry.label + " | stop " + fmt(setup.stop) + " | T1 " + fmt(setup.t1) + " | T2 " + fmt(setup.t2), "ev");
  const banner = $("triggerBanner");
  banner.classList.remove("hidden");
  banner.classList.toggle("down", setup.dir === "SHORT");
  banner.textContent = "TRIGGER — Setup " + setup.id + ": " + setup.name + " VALIDATED @ " + fmt(state.last);
  setTimeout(() => banner.classList.add("hidden"), 10000);
  beep(setup.dir === "LONG" ? 880 : 660);
  setTimeout(() => beep(setup.dir === "LONG" ? 1320 : 440), 250);
  if (Notification.permission === "granted") {
    try {
      new Notification("BTC 20_08_2026 TRIGGER — Setup " + setup.id, {
        body: setup.name + " validated @ " + fmt(state.last) + " | stop " + fmt(setup.stop) + " | T1 " + fmt(setup.t1)
      });
    } catch (e) { }
  }
}

function distInfo(level, setup) {
  const p = state.last;
  if (p === null || level === null) return { txt: "--", cls: "neu" };
  const pct = (level - p) / p * 100;
  const above = level > p;
  const favorable = setup.side > 0 ? above : !above;
  return {
    txt: (above ? "+" : "") + fmt(pct, 2) + "% (" + fmt(Math.abs(level - p)) + ")",
    cls: favorable ? "ok" : "bad"
  };
}

function zoneDist(setup) {
  const p = state.last;
  if (p === null) return { txt: "--", cls: "neu" };
  if (p < setup.entry.lo) {
    const g = setup.entry.lo - p;
    return { txt: "below zone by " + fmt(g) + " (" + fmt(g / setup.entry.lo * 100, 2) + "%)", cls: "bad" };
  }
  if (p > setup.entry.hi) {
    const g = p - setup.entry.hi;
    return { txt: "above zone by " + fmt(g) + " (" + fmt(g / setup.entry.hi * 100, 2) + "%)", cls: "bad" };
  }
  return { txt: "IN ZONE", cls: "ok" };
}

function volInfo(setup) {
  const r = (state.vol30 ?? 0) / (state.avgVol30m || 1);
  const min = setup.vol ?? 1.0;
  if (r === null || isNaN(r)) return { txt: "--", cls: "neu" };
  return {
    txt: fmt(r, 2) + "x / need " + min + "x",
    cls: r >= min ? "ok" : "bad"
  };
}

function renderSetup(setup, results, status, pct) {
  const el = $("setup-" + setup.id);
  if (!el) return;
  el.querySelector(".pill").textContent = status.toUpperCase();
  el.querySelector(".pill").className = "pill " + status;
  const fill = el.querySelector(".prox-fill");
  fill.style.width = pct + "%";
  fill.classList.toggle("full", status === "valid");
  fill.classList.toggle("neg", status === "invalid");
  el.querySelector(".prox-pct").textContent = pct + "% met (" + results.filter(r => r.met).length + "/" + results.length + ")";

  const cell = (label, value, dist) =>
    "<div class='mcell'><span class='mlabel'>" + label + "</span><span class='mval'>" + value + "</span>" +
    "<span class='mdist " + dist.cls + "'>" + dist.txt + "</span></div>";

  const zone = zoneDist(setup);
  el.querySelector(".metrics").innerHTML =
    cell("Entry", setup.entry.label, zone) +
    cell("Stop", fmt(setup.stop), distInfo(setup.stop, setup)) +
    cell("T1", fmt(setup.t1), distInfo(setup.t1, setup)) +
    cell("T2", fmt(setup.t2), distInfo(setup.t2, setup)) +
    cell("R:R", setup.rr, { txt: "T1/T2 vs stop", cls: "neu" }) +
    cell("Vol", setup.volLabel, volInfo(setup));

  const condsEl = el.querySelector(".conds");
  condsEl.innerHTML = "";
  for (const r of results) {
    const row = document.createElement("div");
    row.className = "cond";
    const ic = r.met ? "ok" : "no";
    const val = r.met ? "OK" : r.note;
    row.innerHTML =
      "<span class='icon " + ic + "'>" + (r.met ? "&#10003;" : "&#10007;") + "</span>" +
      "<span class='clabel'>" + r.c.label + "</span>" +
      "<span class='cval " + (r.met ? "ok" : "gap") + "'>" + val + "</span>";
    condsEl.appendChild(row);
  }
}

function renderPrice() {
  const el = $("lastPrice");
  if (state.last === null) return;
  const up = state.last >= state.priorClose;
  el.textContent = fmt(state.last);
  el.className = "last-price " + (up ? "up" : "down");
  $("priceMeta").textContent =
    "24h " + (state.change24 !== null ? state.change24.toFixed(2) : "--") + "%" +
    "  ·  prior close " + fmt(state.priorClose);
  $("sOpen").textContent = fmt(state.sesOpen);
  $("sHighLow").textContent = fmt(state.sesHigh) + " / " + fmt(state.sesLow);
  $("sVwap").textContent = fmt(state.vwap);
  $("pClose").textContent = fmt(state.priorClose);
  $("cClose").textContent = fmt(state.close5m) + " / " + fmt(state.close30m);
  $("cVol").textContent = fmtBig(state.vol30) + " / " + fmtBig(state.avgVol30m);
  $("volRatio").textContent = state.avgVol30m ? (state.vol30 / state.avgVol30m).toFixed(2) + "x" : "--";
  $("cFunding").textContent = state.funding !== null ? fmt(state.funding, 4) + "%" : "--";
  $("cOi").textContent = fmtBig(state.oi);
  $("cYield").textContent = state.yield30y !== null ? fmt(state.yield30y, 2) + "%" : "--";
  $("cSsr").textContent = fmt(state.ssr, 2);
  $("atr").textContent = fmt(state.atrDaily) + " / " + fmt(state.atr1h);
  $("lastUpdate").textContent = state.lastUpdated ? state.lastUpdated.toISOString().slice(11, 19) + "Z (ctx " + (state.stateTs ? state.stateTs.toISOString().slice(11, 19) + "Z" : "--") + ")" : "--";
  $("utcClock").textContent = new Date().toISOString().slice(11, 19) + "Z";
  const ph = getPhase();
  const phEl = $("phaseName");
  phEl.textContent = ph.phase;
  phEl.className = "live";
  renderTimeline(ph);
  renderLevels();
  renderKillsw();
  drawSpark();
}

function renderTimeline(ph) {
  const rows = [
    ["Now", "MONITORING", "setups armed 24/7"],
    ["16:00Z", "Funding reset", "perp funding re-prices"],
    ["18:00Z", "FOMC minutes", "volatility window"],
    ["Aug 26", "US PCE", "macro input"],
    ["Late Aug", "Jackson Hole", "Fed Chair speech"]
  ];
  const tl = $("timeline");
  tl.innerHTML = "";
  rows.forEach(r => {
    const div = document.createElement("div");
    div.className = "tlrow" + (r[0] === "Now" ? " now" : "");
    div.innerHTML = "<span class='tlt'>" + r[0] + "</span><span class='tlname'>" + r[1] + "</span><span class='tlnote'>" + r[2] + "</span>";
    tl.appendChild(div);
  });
  $("countdown").textContent = ph.next
    ? "Next: " + ph.next.label + " in " + fmt(Math.max(0, (ph.next.ts - Date.now()) / 60000), 1) + " min"
    : "No scheduled event today";
}

function renderLevels() {
  const tb = $("levelRows");
  tb.innerHTML = "";
  for (const lv of LEVELS) {
    const tr = document.createElement("tr");
    const above = state.last !== null && state.last >= lv.price;
    tr.innerHTML =
      "<td>" + lv.name + "</td>" +
      "<td class='lv-price'>" + fmt(lv.price) + "</td>" +
      "<td class='" + (above ? "lv-above" : "lv-below") + "'>" +
      (state.last === null ? "--" : (above ? "+" : "-") + fmt(Math.abs(state.last - lv.price) / lv.price * 100, 2) + "%") + "</td>" +
      "<td class='lv-method'>" + lv.method + "</td>";
    tb.appendChild(tr);
  }
}

function renderKillsw() {
  const trips = [];
  if (state.funding !== null && state.funding >= 0.05) trips.push({ n: "Funding ≥ 0.05%", v: fmt(state.funding, 4) + "%", a: "tighten stops — no new longs" });
  if (state.yield30y !== null && state.yield30y >= 5.30) trips.push({ n: "US 30y ≥ 5.30%", v: fmt(state.yield30y, 2) + "%", a: "hawkish repricing — favor shorts" });
  if (state.oi !== null && state.prevOi !== null && state.oi > state.prevOi * 1.02 && (state.change24 ?? 0) < 0.5)
    trips.push({ n: "OI +2% vs price flat", v: fmtBig(state.oi), a: "new longs — squeeze exhaustion, suspect" });
  if (state.ssr !== null && state.ssrBase !== null && state.ssr > state.ssrBase * 1.05)
    trips.push({ n: "SSR rising +5% vs base", v: fmt(state.ssr, 2), a: "unfunded rally — fade strength" });

  const tripKey = trips.map(t => t.n).join("|");
  if (tripKey !== state.lastTripKey && trips.length) {
    trips.forEach(t => log("KILL-SWITCH TRIP: " + t.n + " (" + t.v + ") — " + t.a, "ev"));
  }
  state.lastTripKey = tripKey;

  const rows = [
    { n: "Funding (perp)", v: state.funding !== null ? fmt(state.funding, 4) + "%" : "--", trip: state.funding !== null && state.funding >= 0.05, a: "≥ 0.05% → tighten, no new longs" },
    { n: "US 30y yield", v: state.yield30y !== null ? fmt(state.yield30y, 2) + "%" : "--", trip: state.yield30y !== null && state.yield30y >= 5.30, a: "≥ 5.30% → hawkish repricing, favor shorts" },
    { n: "OI increase vs flat price", v: fmtBig(state.oi), trip: trips.some(t => t.n.startsWith("OI")), a: "OI +2% while price < +0.5% → squeeze exhaustion" },
    { n: "SSR trend", v: fmt(state.ssr, 2), trip: trips.some(t => t.n.startsWith("SSR")), a: "SSR +5% vs session base → unfunded rally" }
  ];
  const el = $("killsw");
  el.innerHTML = "";
  for (const r of rows) {
    const div = document.createElement("div");
    div.className = "ksrow" + (r.trip ? " trip" : "");
    div.innerHTML = "<span class='kdot'></span><span class='kname'>" + r.n + "</span><span class='kval'>" + r.v + "</span>";
    el.appendChild(div);
    if (r.trip) {
      const a = document.createElement("div");
      a.className = "ksact";
      a.textContent = "TRIP — " + r.a;
      el.appendChild(a);
    }
  }
}

function drawSpark() {
  const cv = $("spark");
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const cs = state.candles1m;
  if (cs.length < 2) return;
  const prices = cs.map(c => c[1]);
  const hLines = [69400, 69724, 71316, 71652, 68142];
  const min = Math.min(...prices, ...hLines) * 0.997;
  const max = Math.max(...prices, ...hLines) * 1.003;
  const X = (i) => (i / (cs.length - 1)) * W;
  const Y = (p) => H - ((p - min) / (max - min)) * H;
  ctx.strokeStyle = "#2ecc8f";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  cs.forEach((c, i) => i === 0 ? ctx.moveTo(X(i), Y(c[1])) : ctx.lineTo(X(i), Y(c[1])));
  ctx.stroke();
  const lineCols = [[69400, "#2ecc8f"], [69724, "#2ecc8f"], [71316, "#42c6e8"], [71652, "#f5b83d"], [68142, "#ff5c6c"]];
  for (const [p, col] of lineCols) {
    if (p === null) continue;
    ctx.strokeStyle = col;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, Y(p));
    ctx.lineTo(W, Y(p));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = col;
    ctx.font = "10px monospace";
    ctx.fillText(p.toLocaleString("en-US"), 4, Y(p) - 3);
  }
}

function beep(freq) {
  try {
    const ac = state.audioCtx;
    if (!ac) return;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.frequency.value = freq;
    o.type = "square";
    g.gain.setValueAtTime(0.12, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.5);
    o.connect(g); g.connect(ac.destination);
    o.start();
    o.stop(ac.currentTime + 0.55);
  } catch (e) { }
}

function buildSetups() {
  const wrap = $("setups");
  wrap.innerHTML = "";
  for (const setup of SETUPS) {
    const div = document.createElement("div");
    div.className = "setup";
    div.id = "setup-" + setup.id;
    div.innerHTML =
      "<div class='head'><span class='sid'>" + setup.id + "</span>" +
      "<span class='sname'>" + setup.name + "</span>" +
      "<span class='dir " + (setup.dir === "LONG" ? "long" : "short") + "'>" + setup.dir + "</span>" +
      "<span class='pill'>armed</span></div>" +
      "<div class='metrics'></div>" +
      "<div class='conds'></div>" +
      "<div class='prox-row'><div class='prox-bar'><div class='prox-fill'></div></div><div class='prox-pct'>--</div></div>" +
      "<div class='inval'>Invalidation: <b>" + setup.invalidate + "</b></div>";
    wrap.appendChild(div);
  }
}

$("notifBtn").addEventListener("click", () => {
  try {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    beep(880);
  } catch (e) { }
  if ("Notification" in window) {
    Notification.requestPermission().then((p) => {
      log("browser alerts: " + p, p === "granted" ? "ok" : "ev");
    });
  }
  log("audio armed", "ok");
});

function setFeedUi() {
  const FEED_LABEL = {
    "gate-ws": "Gate WS tick stream LIVE",
    "coingecko": "CoinGecko REST every 10s",
    "state": "state.json (5-min context)",
    "none": "no feed yet"
  };
  const wd = $("wsDot"), wl = $("wsLabel");
  const live = state.feed === "gate-ws";
  wd.className = "dot " + (state.feed === "none" ? "warn" : (live ? "ok" : "warn"));
  wl.textContent = FEED_LABEL[state.feed] || state.feed;
  const rd = $("restDot"), rl = $("restLabel");
  const stale = state.stateTs !== null && (Date.now() - state.stateTs) > STATE_MAX_AGE;
  rd.className = "dot " + (state.stateOk ? (stale ? "warn" : "ok") : "err");
  rl.textContent = state.stateOk ? "context " + (stale ? "STALE" : "OK") + " (5-min refresh)" : "context failing";
}

(async function init() {
  buildSetups();
  await fetchState();
  evaluate();
  renderPrice();
  connectWS();
  setInterval(fetchState, 60000);
  setInterval(() => { renderPrice(); setFeedUi(); }, 1000);
  setInterval(() => { $("utcClock").textContent = new Date().toISOString().slice(11, 19) + "Z"; }, 1000);
  setInterval(() => { if (state.last !== null) evaluate(); }, 2000);
  log("monitor started — feeds: Gate WS -> CoinGecko REST -> state.json", "ok");
  log("setups: A pullback long | B breakout long | C mean-reversion short", "ev");
})();