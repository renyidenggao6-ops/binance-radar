import express from "express";

const app = express();
app.set("json spaces", 2);

const PORT = Number(process.env.PORT || 3000);
const MARKET = (process.env.MARKET || "futures").toLowerCase();
const BASE = process.env.BINANCE_BASE_URL || (MARKET === "spot" ? "https://api.binance.com" : "https://fapi.binance.com");
const PREFIX = MARKET === "spot" ? "/api/v3" : "/fapi/v1";
const CACHE_MS = Number(process.env.CACHE_MS || 2500);
const PRICE_SAMPLE_MS = Number(process.env.PRICE_SAMPLE_MS || 1000);
const SCAN_TOP = Math.min(Number(process.env.SCAN_TOP || 80), 150);
const SCAN_CONCURRENCY = Math.min(Number(process.env.SCAN_CONCURRENCY || 8), 16);

const cache = new Map();
const priceHistory = new Map();
const MAX_HISTORY = 1800; // 30 minutes at 1 sample/sec
let scanCache = null;
let lastScanAt = 0;

const now = () => Date.now();
const n = (v, fallback = null) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
};
const round = (x, d = 6) => Number.isFinite(x) ? Number(x.toFixed(d)) : null;
const pct = (a, b) => (a && b) ? ((a - b) / b) * 100 : null;

async function fetchJSON(path, params = {}) {
  const url = new URL(BASE + PREFIX + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, { headers: { "accept": "application/json" } });
  if (!r.ok) throw new Error(`Binance HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && now() - hit.at < ttl) return hit.value;
  const value = await fn();
  cache.set(key, { at: now(), value });
  return value;
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a,b)=>a+b,0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1-k);
  return e;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i-1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i-1];
    avgGain = ((avgGain * (period - 1)) + Math.max(d, 0)) / period;
    avgLoss = ((avgLoss * (period - 1)) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (candles.length <= period) return null;
  const tr = [];
  for (let i=1;i<candles.length;i++) {
    const c = candles[i], p = candles[i-1];
    tr.push(Math.max(c.high-c.low, Math.abs(c.high-p.close), Math.abs(c.low-p.close)));
  }
  let a = tr.slice(0, period).reduce((x,y)=>x+y,0)/period;
  for (let i=period;i<tr.length;i++) a=((a*(period-1))+tr[i])/period;
  return a;
}

function bollinger(values, period = 20, mult = 2) {
  if (values.length < period) return null;
  const x = values.slice(-period);
  const mean = x.reduce((a,b)=>a+b,0)/period;
  const variance = x.reduce((a,b)=>a+(b-mean)**2,0)/period;
  const sd = Math.sqrt(variance);
  return { middle: mean, upper: mean+mult*sd, lower: mean-mult*sd };
}

function vwap(candles, period = 50) {
  const x = candles.slice(-period);
  let pv = 0, vol = 0;
  for (const c of x) {
    const typical = (c.high+c.low+c.close)/3;
    pv += typical*c.volume;
    vol += c.volume;
  }
  return vol ? pv/vol : null;
}

function candleStats(candles) {
  const closes = candles.map(x=>x.close);
  const volumes = candles.map(x=>x.volume);
  const last = candles.at(-1);
  const prev = candles.at(-2);
  const e9 = ema(closes,9), e21 = ema(closes,21), e50 = ema(closes,50);
  const rr = rsi(closes,14);
  const aa = atr(candles,14);
  const bb = bollinger(closes,20,2);
  const vw = vwap(candles,50);
  const avgVol = volumes.slice(-21,-1).reduce((a,b)=>a+b,0)/Math.max(1,Math.min(20,volumes.length-1));
  const volumeRatio = avgVol ? last.volume/avgVol : null;
  const change = prev ? pct(last.close, prev.close) : null;
  const lookback = candles.slice(-20);
  const support = Math.min(...lookback.map(x=>x.low));
  const resistance = Math.max(...lookback.map(x=>x.high));
  const trend =
    e9 && e21 && e50
      ? (last.close > e9 && e9 > e21 && e21 > e50 ? "strong_up"
        : last.close < e9 && e9 < e21 && e21 < e50 ? "strong_down"
        : last.close > e21 ? "up"
        : last.close < e21 ? "down" : "mixed")
      : "unknown";
  return {
    last_close: round(last.close),
    last_change_percent: round(change,4),
    ema9: round(e9), ema21: round(e21), ema50: round(e50),
    rsi14: round(rr,2),
    atr14: round(aa),
    atr_percent: aa ? round(aa/last.close*100,3) : null,
    vwap50: round(vw),
    bollinger: bb && { upper: round(bb.upper), middle: round(bb.middle), lower: round(bb.lower) },
    volume_ratio_to_20bar_average: round(volumeRatio,2),
    support_20bar: round(support),
    resistance_20bar: round(resistance),
    trend
  };
}

async function getKlines(symbol, interval, limit = 120) {
  const raw = await cached(`k:${symbol}:${interval}:${limit}`, CACHE_MS, async () => {
    return fetchJSON("/klines", { symbol, interval, limit });
  });
  return raw.map(x => ({
    open_time: x[0], open: n(x[1]), high: n(x[2]), low: n(x[3]), close: n(x[4]),
    volume: n(x[5]), close_time: x[6], quote_volume: n(x[7]),
    trades: n(x[8])
  }));
}

async function getTicker(symbol) {
  return cached(`t:${symbol}`, 1000, async () => {
    if (MARKET === "spot") return fetchJSON("/ticker/24hr", { symbol });
    return fetchJSON("/ticker/24hr", { symbol });
  });
}

async function getBook(symbol) {
  return cached(`b:${symbol}`, 1000, async () => fetchJSON("/ticker/bookTicker", { symbol }));
}

function recordPrice(symbol, price) {
  const arr = priceHistory.get(symbol) || [];
  arr.push({ t: now(), p: price });
  while (arr.length > MAX_HISTORY) arr.shift();
  priceHistory.set(symbol, arr);
}

function historyChange(symbol, seconds) {
  const arr = priceHistory.get(symbol) || [];
  if (arr.length < 2) return null;
  const target = now() - seconds*1000;
  let chosen = arr[0];
  for (const x of arr) { if (x.t <= target) chosen = x; else break; }
  const latest = arr.at(-1);
  return chosen?.p ? round((latest.p-chosen.p)/chosen.p*100, 4) : null;
}

async function marketSnapshot(symbol) {
  symbol = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g,"");
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) throw new Error("Invalid symbol");

  const intervals = ["1m","3m","5m","15m","1h","4h"];
  const [ticker, book, ...allK] = await Promise.all([
    getTicker(symbol), getBook(symbol),
    ...intervals.map(i=>getKlines(symbol,i,120))
  ]);
  const price = n(ticker.lastPrice);
  recordPrice(symbol, price);

  const byInterval = {};
  intervals.forEach((i,idx)=>{
    const candles = allK[idx];
    byInterval[i] = {
      stats: candleStats(candles),
      candles: candles.slice(-60)
    };
  });

  const bid = n(book.bidPrice), ask = n(book.askPrice);
  const spread = bid && ask ? (ask-bid)/((ask+bid)/2)*100 : null;
  return {
    meta: {
      symbol, market: MARKET, source: "Binance public market API",
      generated_at: new Date().toISOString(),
      generated_at_unix_ms: now(),
      cache_note: `Some REST components may be cached for up to ${CACHE_MS} ms to protect rate limits.`
    },
    live: {
      last_price: round(price),
      bid: round(bid), ask: round(ask),
      spread_percent: round(spread,5),
      price_change_percent_24h: round(n(ticker.priceChangePercent),4),
      high_24h: round(n(ticker.highPrice)),
      low_24h: round(n(ticker.lowPrice)),
      base_volume_24h: round(n(ticker.volume)),
      quote_volume_24h: round(n(ticker.quoteVolume)),
      trade_count_24h: n(ticker.count),
      server_sample_change_5s: historyChange(symbol,5),
      server_sample_change_30s: historyChange(symbol,30),
      server_sample_change_60s: historyChange(symbol,60),
      server_sample_change_300s: historyChange(symbol,300)
    },
    intervals: byInterval,
    interpretation: buildInterpretation(byInterval, price)
  };
}

function buildInterpretation(x, price) {
  const t = ["1m","5m","15m","1h","4h"].map(i=>x[i].stats);
  const score = t.reduce((s,a)=>s + (
    a.trend==="strong_up"?2:a.trend==="up"?1:a.trend==="strong_down"?-2:a.trend==="down"?-1:0
  ),0);
  const volatility = x["15m"].stats.atr_percent;
  const volume = x["15m"].stats.volume_ratio_to_20bar_average;
  const r = x["15m"].stats.rsi14;
  return {
    multi_timeframe_trend_score: score,
    multi_timeframe_state: score >= 6 ? "strong_bullish" : score >= 2 ? "bullish" : score <= -6 ? "strong_bearish" : score <= -2 ? "bearish" : "mixed",
    volatility_15m: volatility == null ? "unknown" : volatility > 2 ? "high" : volatility > 0.7 ? "medium" : "low",
    volume_state_15m: volume == null ? "unknown" : volume >= 2 ? "unusually_high" : volume >= 1.3 ? "above_average" : volume < 0.7 ? "below_average" : "normal",
    rsi_state_15m: r == null ? "unknown" : r >= 75 ? "overbought_zone" : r <= 25 ? "oversold_zone" : "neutral_zone",
    nearest_support_15m: x["15m"].stats.support_20bar,
    nearest_resistance_15m: x["15m"].stats.resistance_20bar,
    current_price: round(price),
    warning: "Machine-generated labels are descriptive, not trade instructions. Check timestamp and liquidity before acting."
  };
}

async function allTickers() {
  const key = MARKET === "spot" ? "/ticker/24hr" : "/ticker/24hr";
  return cached("all:tickers", 5000, async()=>fetchJSON(key));
}

function candidateScore(t) {
  const qv = Math.log10(Math.max(1,n(t.quoteVolume,0)));
  const move = Math.abs(n(t.priceChangePercent,0));
  const trades = Math.log10(Math.max(1,n(t.count,0)));
  return move*2 + qv*3 + trades;
}

async function scanMarket() {
  if (scanCache && now()-lastScanAt < 15000) return scanCache;
  const tickers = await allTickers();
  const candidates = tickers
    .filter(t => String(t.symbol).endsWith("USDT"))
    .filter(t => n(t.lastPrice) > 0 && n(t.quoteVolume) > 0)
    .sort((a,b)=>candidateScore(b)-candidateScore(a))
    .slice(0, SCAN_TOP);

  const out = [];
  for (let i=0;i<candidates.length;i+=SCAN_CONCURRENCY) {
    const batch = candidates.slice(i,i+SCAN_CONCURRENCY);
    const r = await Promise.all(batch.map(async t=>{
      try {
        const candles = await getKlines(t.symbol,"15m",80);
        const s = candleStats(candles);
        const move = Math.abs(n(t.priceChangePercent,0));
        const anomaly = move + Math.max(0,(s.volume_ratio_to_20bar_average||1)-1)*5 +
          (s.atr_percent||0)*2 +
          (s.trend==="strong_up"||s.trend==="strong_down"?4:0);
        return {
          symbol:t.symbol,
          last_price:round(n(t.lastPrice)),
          change_24h_percent:round(n(t.priceChangePercent),3),
          quote_volume_24h:round(n(t.quoteVolume),2),
          trend_15m:s.trend,
          rsi14_15m:s.rsi14,
          atr_percent_15m:s.atr_percent,
          volume_ratio_15m:s.volume_ratio_to_20bar_average,
          anomaly_score:round(anomaly,3)
        };
      } catch (e) { return null; }
    }));
    out.push(...r.filter(Boolean));
  }

  out.sort((a,b)=>b.anomaly_score-a.anomaly_score);
  scanCache = {
    meta:{
      generated_at:new Date().toISOString(),
      market:MARKET,
      scanned_candidates:out.length,
      methodology:"Ranks liquid USDT markets by 24h movement, 15m volatility, unusual volume and strong EMA alignment. This is a screening score, not a prediction."
    },
    hottest:out.slice(0,30),
    strongest_uptrend:out.filter(x=>x.trend_15m==="strong_up"||x.trend_15m==="up").slice(0,20),
    strongest_downtrend:out.filter(x=>x.trend_15m==="strong_down"||x.trend_15m==="down").slice(0,20)
  };
  lastScanAt=now();
  return scanCache;
}

function textReport(m) {
  const lines=[];
  lines.push(`MARKET SNAPSHOT: ${m.meta.symbol}`);
  lines.push(`Generated: ${m.meta.generated_at} (${m.meta.generated_at_unix_ms})`);
  lines.push(`Current price: ${m.live.last_price}`);
  lines.push(`Bid/Ask: ${m.live.bid} / ${m.live.ask}; spread=${m.live.spread_percent}%`);
  lines.push(`24h change: ${m.live.price_change_percent_24h}% | 24h high/low: ${m.live.high_24h} / ${m.live.low_24h}`);
  lines.push(`24h quote volume: ${m.live.quote_volume_24h}`);
  lines.push(`Server sampled change 5s/30s/60s/300s: ${m.live.server_sample_change_5s}% / ${m.live.server_sample_change_30s}% / ${m.live.server_sample_change_60s}% / ${m.live.server_sample_change_300s}%`);
  lines.push("");
  for (const [tf,v] of Object.entries(m.intervals)) {
    const s=v.stats;
    lines.push(`[${tf}] trend=${s.trend}; last=${s.last_close}; change=${s.last_change_percent}%`);
    lines.push(`EMA9/21/50=${s.ema9}/${s.ema21}/${s.ema50}; RSI14=${s.rsi14}; ATR%=${s.atr_percent}; VWAP50=${s.vwap50}`);
    lines.push(`Volume ratio=${s.volume_ratio_to_20bar_average}; Support20=${s.support_20bar}; Resistance20=${s.resistance_20bar}`);
  }
  lines.push("");
  lines.push(`MULTI-TIMEFRAME STATE: ${m.interpretation.multi_timeframe_state}; score=${m.interpretation.multi_timeframe_trend_score}`);
  lines.push(`15m volatility=${m.interpretation.volatility_15m}; volume=${m.interpretation.volume_state_15m}; RSI=${m.interpretation.rsi_state_15m}`);
  lines.push(`IMPORTANT: This is a timestamped market snapshot, not financial advice or a guaranteed prediction.`);
  return lines.join("\n");
}

app.get("/", (req,res)=>res.type("html").send(`
<!doctype html><html><head><meta charset="utf-8"><title>Binance AI Market Bridge</title>
<style>body{font-family:system-ui;max-width:900px;margin:40px auto;padding:0 16px;line-height:1.55}input,button{padding:10px;font-size:16px}pre{white-space:pre-wrap;background:#f5f5f5;padding:16px;border-radius:8px}</style></head>
<body><h1>Binance AI Market Bridge</h1>
<p>AI data transport layer. No API key required.</p>
<input id="s" value="BTCUSDT"><button onclick="go()">Open report</button>
<p><a href="/api/brief">/api/brief</a> — AI market overview</p>
<p><a href="/api/scan">/api/scan</a> — automatic market scan</p>
<pre id="out">Enter a symbol, e.g. BTCUSDT.</pre>
<script>
async function go(){let s=document.getElementById('s').value.toUpperCase();let r=await fetch('/api/report?symbol='+encodeURIComponent(s));document.getElementById('out').textContent=await r.text();}
</script></body></html>
`));

app.get("/health", (req,res)=>res.json({ok:true, now:new Date().toISOString(), market:MARKET, base:BASE}));

app.get("/api/market", async (req,res)=>{
  try { res.json(await marketSnapshot(req.query.symbol || "BTCUSDT")); }
  catch(e){ res.status(400).json({error:String(e.message)}); }
});

app.get("/api/report", async (req,res)=>{
  try {
    const m=await marketSnapshot(req.query.symbol || "BTCUSDT");
    res.type("text/plain; charset=utf-8").send(textReport(m));
  } catch(e){ res.status(400).type("text/plain").send("ERROR: "+e.message); }
});

app.get("/api/scan", async (req,res)=>{
  try { res.json(await scanMarket()); }
  catch(e){ res.status(502).json({error:String(e.message)}); }
});

app.get("/api/brief", async (req,res)=>{
  try {
    const scan=await scanMarket();
    const symbols=scan.hottest.slice(0,10).map(x=>x.symbol);
    const snapshots=await Promise.all(symbols.map(async symbol=>{
      try {
        const m=await marketSnapshot(symbol);
        return {
          symbol,
          generated_at:m.meta.generated_at,
          current_price:m.live.last_price,
          change_24h_percent:m.live.price_change_percent_24h,
          multi_timeframe_state:m.interpretation.multi_timeframe_state,
          trend_score:m.interpretation.multi_timeframe_trend_score,
          volatility_15m:m.interpretation.volatility_15m,
          volume_state_15m:m.interpretation.volume_state_15m,
          rsi_state_15m:m.interpretation.rsi_state_15m,
          support_15m:m.interpretation.nearest_support_15m,
          resistance_15m:m.interpretation.nearest_resistance_15m
        };
      } catch(e){return {symbol,error:e.message};}
    }));
    res.json({
      meta:{
        generated_at:new Date().toISOString(),
        purpose:"AI-readable current market overview. Verify generated_at before using. Individual detail is available at /api/report?symbol=SYMBOL."
      },
      scan,
      top_market_snapshots:snapshots
    });
  } catch(e){res.status(502).json({error:String(e.message)});}
});

app.listen(PORT, ()=>console.log(`Binance AI Market Bridge listening on ${PORT}; market=${MARKET}; base=${BASE}`));
