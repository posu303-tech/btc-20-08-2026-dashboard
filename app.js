"use strict";

const GATE_WS = "wss://api.gateio.ws/ws/v4/";
const PAIR = "BTC_USDT";
const STATE_URL = "data/state.json";
const STATE_MAX_AGE = 8 * 60 * 1000;
const CG_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true";

const RELEASE_UTC = "18:00";
const WINDOW_OPEN_UTC = "18:05";
const WINDOW_CLOSE_UTC = "18:45";
const FORCE_FLAT_UTC = "20:00";

const PRIOR_CLOSE = 66910;
const LEVELS = [
  { name: "R2 (200% fib ext)", price: 71594, method: "fib ext" },
  { name: "R1 (161.8% fib ext)", price: 69804, method: "fib ext / today high 69,749" },
  { name: "Decision — 200D SMA", price: 69042, method: "200-day SMA" },
  { name: "S1 (127.2% fib ext)", price: 68184, method: "fib ext" },
  { name: "S2 (swing high)", price: 66910, method: "prior swing / squeeze trigger" },
  { name: "S3 (23.6% fib)", price: 65805, method: "retracement" },
  { name: "S4 (50% fib / pivot)", price: 64568, method: "fib / pivot" }
];

const FLAGS = [
  { id: "hawk", label: "Minutes: hawkish breadth confirmed", warn: true },
  { id: "dove", label: "Minutes: dovish lean", warn: false },
  { id: "dxy", label: "DXY up >0.3% post-print", warn: true }
];

const SETUPS = [
  {
    id: "A", name: "Bull continuation", dir: "LONG", longSide: true,
    stop: 68184, t1: 69804, t2: 71594, rr: "1.4 / 2.9",
    invalidate: "30-min close < 68,184 (S1) or DXY > +0.3%",
    conds: [
      { k: "time", label: "Trade window open (18:05–18:45 UTC)" },
      { k: "flag", f: "hawk", neg: true, label: "Minutes NOT hawkish (manual)" },
      { k: "above", v: 69042, label: "30-min close > $69,042 (200D SMA)" },
      { k: "vol", label: "Post-print 30m volume ≥ avg (ratio ≥ 1.0)" },
      { k: "above", v: 68184, label: "Not invalidated: 30-min close ≥ $68,184 (S1)" },
      { k: "flag", f: "dxy", neg: true, label: "DXY NOT up >0.3% (manual)" }
    ]
  },
  {
    id: "B", name: "Hawkish surprise short", dir: "SHORT", longSide: false,
    stop: 69300, t1: 66910, t2: 65805, rr: "1.3 / 2.5",
    invalidate: "5-min close ≥ 69,042 (decision line reclaimed)",
    conds: [
      { k: "time", label: "Trade window open (18:05–18:45 UTC)" },
      { k: "flag", f: "hawk", neg: false, label: "Minutes hawkish breadth (manual)" },
      { k: "below", v: 68184, label: "5-min close < $68,184 (S1 breakdown)" },
      { k: "below", v: 69042, label: "Not invalidated: 5-min close < $69,042" }
    ]
  },
  {
    id: "C", name: "Neutral range scalp (2 legs)", dir: "RANGE", longSide: null,
    stop: null, t1: null, t2: null, rr: "S 3.4 / L 2.2",
    invalidate: "30-min close > 70,150 or < 68,000",
    conds: [
      { k: "time", label: "Trade window open (18:05–18:45 UTC)" },
      { k: "flag", f: "hawk", neg: true, label: "Minutes neutral — no hawkish (manual)" },
      { k: "flag", f: "dove", neg: true, label: "Minutes neutral — no dovish (manual)" },
      { k: "band", lo: 68184, hi: 69804, label: "Price within $68,184–$69,804 band" },
      { k: "band", lo: 68000, hi: 70150, label: "Not invalidated: 30-min close in $68,000–$70,150" }
    ],
    legs: [
      { side: "SHORT", zone: "69,500–69,800", stop: 70150, tgt: 68400 },
      { side: "LONG", zone: "68,300–68,500", stop: 67900, tgt: 69500 }
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
  prevStatus: {}, fired: {}, flags: { hawk: false, dove: false, dxy: false },
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
  const tR = todayUTC(RELEASE_UTC), tW = todayUTC(WINDOW_OPEN_UTC), tC = todayUTC(WINDOW_CLOSE_UTC), tF = todayUTC(FORCE_FLAT_UTC);
  let phase, next;
  if (now < tR) { phase = "PRE-EVENT"; next = { ts: tR, label: "minutes release" }; }
  else if (now < tW) { phase = "RELEASE"; next = { ts: tW, label: "trade window" }; }
  else if (now < tC) { phase = "TRADE WINDOW"; next = { ts: tC, label: "stand down" }; }
  else if (now < tF) { phase = "STAND DOWN"; next = { ts: tF, label: "force-flat" }; }
  else { phase = "FORCE-FLAT"; next = null; }
  const windowOpen = now >= tW && now < tC;
  return { phase, next, windowOpen };
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

function condMet(cond) {
  const ph = getPhase();
  const p = state.last;
  switch (cond.k) {
    case "time": return ph.windowOpen;
    case "flag": {
      const v = state.flags[cond.f];
      return cond.neg ? !v : v;
    }
    case "above": return (state.close30m ?? p) > cond.v;
    case "below": return (state.close5m ?? p) < cond.v;
    case "vol": {
      const r = (state.vol30 ?? 0) / (state.avgVol30m || 1);
      return r >= 1.0;
    }
    case "band": {
      const v = cond.label.startsWith("Not invalidated") ? (state.close30m ?? p) : p;
      return v >= cond.lo && v <= cond.hi;
    }
  }
  return false;
}

function condNote(cond) {
  const p = state.last;
  const ph = getPhase();
  switch (cond.k) {
    case "time": {
      const tW = todayUTC(WINDOW_OPEN_UTC), tC = todayUTC(WINDOW_CLOSE_UTC);
      const n = Date.now();
      if (n < tW) return "window opens in " + fmt(Math.max(0, (tW - n) / 60000), 1) + "m";
      if (n < tC) return "window closes in " + fmt(Math.max(0, (tC - n) / 60000), 1) + "m";
      return "window closed";
    }
    case "flag": {
      const v = state.flags[cond.f];
      return cond.neg ? (v ? "set — BLOCKING" : "OK (toggle)") : (v ? "OK (toggle)" : "not set — BLOCKING");
    }
    case "above": {
      const v = state.close30m ?? p;
      const gap = cond.v - v;
      return gap > 0 ? "gap " + fmt(gap) + " (" + fmt(Math.abs(gap) / cond.v * 100, 2) + "%)" : "OK";
    }
    case "below": {
      const v = state.close5m ?? p;
      const gap = v - cond.v;
      return gap > 0 ? "gap " + fmt(gap) + " (" + fmt(Math.abs(gap) / cond.v * 100, 2) + "%)" : "OK";
    }
    case "vol": {
      const r = (state.vol30 ?? 0) / (state.avgVol30m || 1);
      return r >= 1.0 ? "OK " + fmt(r, 2) + "x" : "ratio " + fmt(r, 2) + "x (needs 1.0x)";
    }
    case "band": {
      const v = cond.label.startsWith("Not invalidated") ? (state.close30m ?? p) : p;
      if (v < cond.lo) return "gap " + fmt(cond.lo - v) + " below";
      if (v > cond.hi) return "gap " + fmt(v - cond.hi) + " above";
      return "in band";
    }
  }
  return "--";
}

function condProgress(cond) {
  const p = state.last;
  const met = condMet(cond);
  switch (cond.k) {
    case "time": {
      const ph = getPhase();
      if (!ph.next || met) return met ? 100 : 0;
      const w = todayUTC(WINDOW_OPEN_UTC), c = todayUTC(WINDOW_CLOSE_UTC);
      const total = c - w;
      const done = clamp(1 - (ph.next.ts - Date.now()) / total, 0, 1);
      return done * 100;
    }
    case "above": {
      const v = state.close30m ?? p;
      const span = Math.abs(cond.v - 68184) || 1000;
      return met ? 100 : clamp(100 - (cond.v - v) / span * 100, 0, 99);
    }
    case "below": {
      const v = state.close5m ?? p;
      const span = Math.abs(cond.v - 69042) || 1000;
      return met ? 100 : clamp(100 - (v - cond.v) / span * 100, 0, 99);
    }
    case "vol": {
      const r = (state.vol30 ?? 0) / (state.avgVol30m || 1);
      return met ? 100 : clamp(r * 100, 0, 99);
    }
    case "band": {
      const v = cond.label.startsWith("Not invalidated") ? (state.close30m ?? p) : p;
      if (met) return 100;
      const dlo = Math.max(0, cond.lo - v), dhi = Math.max(0, v - cond.hi);
      const d = Math.max(dlo, dhi);
      const span = (cond.hi - cond.lo) / 2;
      return clamp(100 - d / span * 100, 0, 99);
    }
    case "flag": return met ? 100 : 30;
  }
  return met ? 100 : 0;
}

function setupInvalid(setup) {
  const p = state.last;
  if (setup.id === "A") return (state.close30m ?? p) < 68184 || state.flags.dxy;
  if (setup.id === "B") return (state.close5m ?? p) >= 69042;
  if (setup.id === "C") {
    const v = state.close30m ?? p;
    return v > 70150 || v < 68000;
  }
  return false;
}

function evaluate() {
  if (state.last === null) return;
  const ph = getPhase();
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
    renderSetup(setup, results, status, pct, ph);
  }
}

function fireTrigger(setup) {
  const key = setup.id + "_" + new Date().toUTCString().slice(0, 16);
  if (state.fired[key]) return;
  state.fired[key] = true;
  const dirTxt = setup.dir === "LONG" ? "LONG" : (setup.dir === "SHORT" ? "SHORT" : "RANGE");
  log("TRIGGER FIRED — Setup " + setup.id + " " + setup.name + " (" + dirTxt + ") @ " + fmt(state.last), "ok");
  if (setup.stop) log("Levels — stop " + fmt(setup.stop) + " | T1 " + fmt(setup.t1) + " | T2 " + fmt(setup.t2), "ev");
  else if (setup.legs) log("Legs — " + setup.legs.map(l => l.side + " " + l.zone + " stop " + fmt(l.stop) + " tgt " + fmt(l.tgt)).join(" | "), "ev");
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
        body: setup.name + " validated @ " + fmt(state.last) + (setup.stop ? " | stop " + fmt(setup.stop) + " | T1 " + fmt(setup.t1) : "")
      });
    } catch (e) { }
  }
}

function renderSetup(setup, results, status, pct, ph) {
  const el = $("setup-" + setup.id);
  if (!el) return;
  el.querySelector(".pill").textContent = status.toUpperCase();
  el.querySelector(".pill").className = "pill " + status;
  const fill = el.querySelector(".prox-fill");
  fill.style.width = pct + "%";
  fill.classList.toggle("full", status === "valid");
  fill.classList.toggle("neg", status === "invalid");
  el.querySelector(".prox-pct").textContent = pct + "% met (" + results.filter(r => r.met).length + "/" + results.length + ")";
  const condsEl = el.querySelector(".conds");
  condsEl.innerHTML = "";
  for (const r of results) {
    const row = document.createElement("div");
    row.className = "cond";
    const ic = r.met ? "ok" : (r.c.k === "flag" ? "pen" : "no");
    const val = r.met ? "OK" : r.note;
    row.innerHTML =
      "<span class='icon " + ic + "'>" + (r.met ? "&#10003;" : (r.c.k === "flag" ? "&#9675;" : "&#10007;")) + "</span>" +
      "<span class='clabel'>" + r.c.label + "</span>" +
      "<span class='cval " + (r.met ? "ok" : "gap") + "'>" + val + "</span>";
    condsEl.appendChild(row);
  }
  if (setup.legs) {
    const legsEl = el.querySelector(".legs");
    legsEl.innerHTML = "";
    for (const l of setup.legs) {
      const leg = document.createElement("div");
      leg.className = "cond";
      leg.innerHTML =
        "<span class='icon " + (l.side === "LONG" ? "ok" : "no") + "'>" + (l.side === "LONG" ? "&#9650;" : "&#9660;") + "</span>" +
        "<span class='clabel'>" + l.side + " leg entry " + l.zone + "</span>" +
        "<span class='cval'>stop " + fmt(l.stop) + " / tgt " + fmt(l.tgt) + "</span>";
      legsEl.appendChild(leg);
    }
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
  phEl.className = ph.windowOpen ? "live" : (ph.phase === "FORCE-FLAT" || ph.phase === "STAND DOWN" ? "warn" : "");
  renderTimeline(ph);
  renderLevels();
  renderKillsw();
  drawSpark();
}

function renderTimeline(ph) {
  const rows = [
    ["< 18:00Z", "PRE-EVENT", "flat — no entries"],
    ["18:00Z", "RELEASE", "no market orders"],
    ["18:05Z", "TRADE WINDOW", "setups active"],
    ["18:45Z", "STAND DOWN", "no new entries"],
    ["20:00Z", "FORCE-FLAT", "session over"]
  ];
  const order = ["PRE-EVENT", "RELEASE", "TRADE WINDOW", "STAND DOWN", "FORCE-FLAT"];
  const idx = order.indexOf(ph.phase);
  const tl = $("timeline");
  tl.innerHTML = "";
  rows.forEach((r, i) => {
    const div = document.createElement("div");
    div.className = "tlrow" + (i === idx ? " now" : (i < idx ? " past" : ""));
    div.innerHTML = "<span class='tlt'>" + r[0] + "</span><span class='tlname'>" + r[1] + "</span><span class='tlnote'>" + r[2] + "</span>";
    tl.appendChild(div);
  });
  $("countdown").textContent = ph.next
    ? "Next: " + ph.next.label + " in " + fmt(Math.max(0, (ph.next.ts - Date.now()) / 60000), 1) + " min"
    : "Session complete — flat";
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
    trips.push({ n: "SSR rising +5% vs base", v: fmt(state.ssr, 2), a: "unfunded rally — fade into 70k" });

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
  const hLines = [69042, 69804, 68184, 66910];
  const min = Math.min(...prices, ...hLines) * 0.997;
  const max = Math.max(...prices, ...hLines) * 1.003;
  const X = (i) => (i / (cs.length - 1)) * W;
  const Y = (p) => H - ((p - min) / (max - min)) * H;
  ctx.strokeStyle = "#2ecc8f";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  cs.forEach((c, i) => i === 0 ? ctx.moveTo(X(i), Y(c[1])) : ctx.lineTo(X(i), Y(c[1])));
  ctx.stroke();
  const lineCols = [[69042, "#f5b83d"], [69804, "#42c6e8"], [68184, "#ff5c6c"], [66910, "#ff8a5c"]];
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
    let metrics = setup.stop
      ? "<span>Stop <b>" + fmt(setup.stop) + "</b></span><span>T1 <b>" + fmt(setup.t1) + "</b></span><span>T2 <b>" + fmt(setup.t2) + "</b></span><span>R:R <b>" + setup.rr + "</b></span>"
      : "<span>Legs (half size) <b>2</b></span><span>R:R <b>" + setup.rr + "</b></span>";
    div.innerHTML =
      "<div class='head'><span class='sid'>" + setup.id + "</span>" +
      "<span class='sname'>" + setup.name + "</span>" +
      "<span class='dir " + (setup.dir === "LONG" ? "long" : setup.dir === "SHORT" ? "short" : "range") + "'>" + setup.dir + "</span>" +
      "<span class='pill'>armed</span></div>" +
      "<div class='metrics'>" + metrics + "</div>" +
      "<div class='conds'></div>" +
      (setup.legs ? "<div class='legs'></div>" : "") +
      "<div class='prox-row'><div class='prox-bar'><div class='prox-fill'></div></div><div class='prox-pct'>--</div></div>" +
      "<div class='inval'>Invalidation: <b>" + setup.invalidate + "</b></div>";
    wrap.appendChild(div);
  }
}

function buildFlags() {
  const wrap = $("flags");
  wrap.innerHTML = "";
  for (const f of FLAGS) {
    const div = document.createElement("div");
    div.className = "flag";
    const btn = document.createElement("button");
    btn.className = "fbtn" + (state.flags[f.id] ? (f.warn ? " warnon" : " on") : "");
    btn.innerHTML = "<span>" + f.label + "</span><span class='fdot'></span>";
    btn.addEventListener("click", () => {
      state.flags[f.id] = !state.flags[f.id];
      btn.className = "fbtn" + (state.flags[f.id] ? (f.warn ? " warnon" : " on") : "");
      log("flag " + f.id + " -> " + state.flags[f.id], "ev");
      evaluate();
    });
    div.appendChild(btn);
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
  buildFlags();
  await fetchState();
  evaluate();
  renderPrice();
  connectWS();
  setInterval(fetchState, 60000);
  setInterval(() => { renderPrice(); setFeedUi(); }, 1000);
  setInterval(() => { $("utcClock").textContent = new Date().toISOString().slice(11, 19) + "Z"; }, 1000);
  setInterval(() => { if (state.last !== null) evaluate(); }, 2000);
  log("monitor started — feeds: Gate WS -> CoinGecko REST -> state.json", "ok");
  log("event gates: release 18:00Z | window 18:05–18:45Z | force-flat 20:00Z", "ev");
})();