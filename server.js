import express from "express";

const app = express();
app.set("json spaces", 2);

const PORT = Number(process.env.PORT || 3000);

/*
  IMPORTANT

  This version uses Binance Spot public market data.

  The previous deployment used Binance Futures:
  https://fapi.binance.com

  Railway may receive HTTP 451 from that endpoint depending on
  the Railway server location.

  We use multiple Binance public spot endpoints as fallbacks.
*/

const BINANCE_BASES = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com"
];

const PREFIX = "/api/v3";

const CACHE_MS = Number(process.env.CACHE_MS || 3000);
const SCAN_TOP = Math.min(Number(process.env.SCAN_TOP || 60), 100);
const SCAN_CONCURRENCY = Math.min(
  Number(process.env.SCAN_CONCURRENCY || 6),
  10
);

const cache = new Map();

const now = () => Date.now();

function n(v, fallback = null) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function round(v, digits = 8) {
  if (!Number.isFinite(v)) return null;
  return Number(v.toFixed(digits));
}

function pct(a, b) {
  if (!a || !b) return null;
  return ((a - b) / b) * 100;
}

/* =========================
   BINANCE FETCH WITH FALLBACK
========================= */

async function fetchBinance(path, params = {}) {
  let lastError = null;

  for (const base of BINANCE_BASES) {
    try {
      const url = new URL(base + PREFIX + path);

      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }

      const controller = new AbortController();

      const timeout = setTimeout(() => {
        controller.abort();
      }, 8000);

      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "Binance-Market-Radar/1.0"
        },
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();

        lastError = new Error(
          `Binance endpoint failed: ${base} HTTP ${response.status}: ${text}`
        );

        console.log(
          "Binance endpoint failed:",
          base,
          response.status
        );

        continue;
      }

      const data = await response.json();

      return {
        data,
        source: base,
        fetched_at: new Date().toISOString()
      };

    } catch (error) {
      lastError = error;

      console.log(
        "Binance endpoint error:",
        base,
        error.message
      );
    }
  }

  throw new Error(
    `Unable to access Binance public market API. ${
      lastError ? lastError.message : ""
    }`
  );
}

async function cached(key, ttl, fn) {
  const hit = cache.get(key);

  if (hit && now() - hit.at < ttl) {
    return hit.value;
  }

  const value = await fn();

  cache.set(key, {
    at: now(),
    value
  });

  return value;
}

/* =========================
   INDICATORS
========================= */

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);

  let result =
    values
      .slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result =
      values[i] * k +
      result * (1 - k);
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];

    if (diff >= 0) {
      gains += diff;
    } else {
      losses -= diff;
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];

    avgGain =
      (
        avgGain * (period - 1) +
        Math.max(diff, 0)
      ) / period;

    avgLoss =
      (
        avgLoss * (period - 1) +
        Math.max(-diff, 0)
      ) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (candles.length <= period) return null;

  const ranges = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const trueRange = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    ranges.push(trueRange);
  }

  let result =
    ranges
      .slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < ranges.length; i++) {
    result =
      (
        result * (period - 1) +
        ranges[i]
      ) / period;
  }

  return result;
}

/* =========================
   MARKET DATA
========================= */

async function getTicker(symbol) {
  return cached(
    `ticker:${symbol}`,
    2000,
    async () => {
      return fetchBinance(
        "/ticker/24hr",
        { symbol }
      );
    }
  );
}

async function getBook(symbol) {
  return cached(
    `book:${symbol}`,
    2000,
    async () => {
      return fetchBinance(
        "/ticker/bookTicker",
        { symbol }
      );
    }
  );
}

async function getAllTickers() {
  return cached(
    "all-tickers",
    5000,
    async () => {
      return fetchBinance(
        "/ticker/24hr"
      );
    }
  );
}

async function getKlines(
  symbol,
  interval,
  limit = 120
) {
  const result = await cached(
    `klines:${symbol}:${interval}:${limit}`,
    CACHE_MS,
    async () => {
      return fetchBinance(
        "/klines",
        {
          symbol,
          interval,
          limit
        }
      );
    }
  );

  return {
    source: result.source,
    fetched_at: result.fetched_at,

    candles: result.data.map(x => ({
      open_time: x[0],
      open: n(x[1]),
      high: n(x[2]),
      low: n(x[3]),
      close: n(x[4]),
      volume: n(x[5]),
      close_time: x[6],
      quote_volume: n(x[7]),
      trades: n(x[8])
    }))
  };
}

/* =========================
   CANDLE ANALYSIS
========================= */

function candleStats(candles) {
  const closes =
    candles.map(x => x.close);

  const volumes =
    candles.map(x => x.volume);

  const last =
    candles.at(-1);

  const previous =
    candles.at(-2);

  const ema9 =
    ema(closes, 9);

  const ema21 =
    ema(closes, 21);

  const ema50 =
    ema(closes, 50);

  const rsi14 =
    rsi(closes, 14);

  const atr14 =
    atr(candles, 14);

  const recent =
    candles.slice(-20);

  const support =
    Math.min(
      ...recent.map(x => x.low)
    );

  const resistance =
    Math.max(
      ...recent.map(x => x.high)
    );

  const recentVolumes =
    volumes.slice(-21, -1);

  const averageVolume =
    recentVolumes.length
      ? recentVolumes.reduce(
          (a, b) => a + b,
          0
        ) / recentVolumes.length
      : null;

  const volumeRatio =
    averageVolume
      ? last.volume / averageVolume
      : null;

  let trend = "mixed";

  if (
    ema9 &&
    ema21 &&
    ema50
  ) {
    if (
      last.close > ema9 &&
      ema9 > ema21 &&
      ema21 > ema50
    ) {
      trend = "strong_up";
    }
    else if (
      last.close < ema9 &&
      ema9 < ema21 &&
      ema21 < ema50
    ) {
      trend = "strong_down";
    }
    else if (
      last.close > ema21
    ) {
      trend = "up";
    }
    else if (
      last.close < ema21
    ) {
      trend = "down";
    }
  }

  return {
    last_close:
      round(last.close),

    last_change_percent:
      previous
        ? round(
            pct(
              last.close,
              previous.close
            ),
            4
          )
        : null,

    ema9:
      round(ema9),

    ema21:
      round(ema21),

    ema50:
      round(ema50),

    rsi14:
      round(rsi14, 2),

    atr14:
      round(atr14),

    atr_percent:
      atr14
        ? round(
            atr14 /
              last.close *
              100,
            4
          )
        : null,

    volume_ratio_to_20bar_average:
      round(volumeRatio, 2),

    support_20bar:
      round(support),

    resistance_20bar:
      round(resistance),

    trend
  };
}

/* =========================
   SYMBOL SNAPSHOT
========================= */

async function marketSnapshot(symbol) {

  symbol =
    String(symbol || "BTCUSDT")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");

  if (
    !/^[A-Z0-9]{5,20}$/.test(symbol)
  ) {
    throw new Error(
      "Invalid symbol"
    );
  }

  const intervals = [
    "1m",
    "5m",
    "15m",
    "1h"
  ];

  const results =
    await Promise.all([
      getTicker(symbol),
      getBook(symbol),

      ...intervals.map(
        interval =>
          getKlines(
            symbol,
            interval,
            120
          )
      )
    ]);

  const tickerResult =
    results[0];

  const bookResult =
    results[1];

  const ticker =
    tickerResult.data;

  const book =
    bookResult.data;

  const intervalResults =
    results.slice(2);

  const price =
    n(ticker.lastPrice);

  const bid =
    n(book.bidPrice);

  const ask =
    n(book.askPrice);

  const spread =
    bid && ask
      ? (
          (ask - bid) /
          ((ask + bid) / 2)
        ) * 100
      : null;

  const intervalsData = {};

  intervals.forEach(
    (interval, index) => {

      const klineResult =
        intervalResults[index];

      intervalsData[interval] = {

        source:
          klineResult.source,

        fetched_at:
          klineResult.fetched_at,

        stats:
          candleStats(
            klineResult.candles
          )
      };
    }
  );

  const trendScore =
    ["1m", "5m", "15m", "1h"]
      .map(
        interval =>
          intervalsData[
            interval
          ].stats.trend
      )
      .reduce(
        (score, trend) => {

          if (
            trend === "strong_up"
          ) return score + 2;

          if (
            trend === "up"
          ) return score + 1;

          if (
            trend === "strong_down"
          ) return score - 2;

          if (
            trend === "down"
          ) return score - 1;

          return score;

        },
        0
      );

  return {

    meta: {

      symbol,

      market:
        "Binance Spot",

      generated_at:
        new Date().toISOString(),

      source:
        tickerResult.source,

      data_note:
        "Market data was fetched during this request. Short caches may be used to reduce API rate-limit pressure."

    },

    live: {

      last_price:
        round(price),

      bid:
        round(bid),

      ask:
        round(ask),

      spread_percent:
        round(
          spread,
          5
        ),

      price_change_percent_24h:
        round(
          n(
            ticker.priceChangePercent
          ),
          4
        ),

      high_24h:
        round(
          n(
            ticker.highPrice
          )
        ),

      low_24h:
        round(
          n(
            ticker.lowPrice
          )
        ),

      base_volume_24h:
        round(
          n(
            ticker.volume
          )
        ),

      quote_volume_24h:
        round(
          n(
            ticker.quoteVolume
          )
        ),

      trade_count_24h:
        n(
          ticker.count
        )
    },

    intervals:
      intervalsData,

    interpretation: {

      multi_timeframe_score:
        trendScore,

      state:

        trendScore >= 6
          ? "strong_bullish"

          : trendScore >= 2
          ? "bullish"

          : trendScore <= -6
          ? "strong_bearish"

          : trendScore <= -2
          ? "bearish"

          : "mixed",

      support_15m:
        intervalsData[
          "15m"
        ].stats
          .support_20bar,

      resistance_15m:
        intervalsData[
          "15m"
        ].stats
          .resistance_20bar,

      warning:
        "This is descriptive market analysis, not guaranteed trading advice."
    }
  };
}

/* =========================
   MARKET SCAN
========================= */

function isExcludedSymbol(symbol) {

  const excluded = [
    "USDCUSDT",
    "FDUSDUSDT",
    "TUSDUSDT",
    "USDPUSDT",
    "DAIUSDT",
    "BUSDUSDT"
  ];

  if (
    excluded.includes(symbol)
  ) return true;

  if (
    symbol.includes("UPUSDT") ||
    symbol.includes("DOWNUSDT")
  ) return true;

  return false;
}

function candidateScore(ticker) {

  const quoteVolume =
    Math.log10(
      Math.max(
        1,
        n(
          ticker.quoteVolume,
          0
        )
      )
    );

  const movement =
    Math.abs(
      n(
        ticker.priceChangePercent,
        0
      )
    );

  const trades =
    Math.log10(
      Math.max(
        1,
        n(
          ticker.count,
          0
        )
      )
    );

  return (
    movement * 2 +
    quoteVolume * 3 +
    trades
  );
}

async function scanMarket() {

  const tickerResult =
    await getAllTickers();

  const tickers =
    tickerResult.data;

  const candidates =
    tickers

      .filter(
        t =>
          String(
            t.symbol
          ).endsWith(
            "USDT"
          )
      )

      .filter(
        t =>
          !isExcludedSymbol(
            t.symbol
          )
      )

      .filter(
        t =>
          n(
            t.lastPrice
          ) > 0 &&
          n(
            t.quoteVolume
          ) > 100000
      )

      .sort(
        (a, b) =>
          candidateScore(b) -
          candidateScore(a)
      )

      .slice(
        0,
        SCAN_TOP
      );

  const output = [];

  for (
    let i = 0;
    i < candidates.length;
    i += SCAN_CONCURRENCY
  ) {

    const batch =
      candidates.slice(
        i,
        i +
          SCAN_CONCURRENCY
      );

    const batchResults =
      await Promise.all(

        batch.map(
          async ticker => {

            try {

              const kline =
                await getKlines(
                  ticker.symbol,
                  "15m",
                  80
                );

              const stats =
                candleStats(
                  kline.candles
                );

              const movement =
                Math.abs(
                  n(
                    ticker
                      .priceChangePercent,
                    0
                  )
                );

              const volumeBonus =
                Math.max(
                  0,
                  (
                    stats
                      .volume_ratio_to_20bar_average ||
                    1
                  ) - 1
                ) * 5;

              const trendBonus =
                (
                  stats.trend ===
                    "strong_up" ||
                  stats.trend ===
                    "strong_down"
                )
                  ? 4
                  : 0;

              const anomalyScore =
                movement +
                volumeBonus +
                (
                  stats
                    .atr_percent ||
                  0
                ) * 2 +
                trendBonus;

              return {

                symbol:
                  ticker.symbol,

                last_price:
                  round(
                    n(
                      ticker
                        .lastPrice
                    )
                  ),

                change_24h_percent:
                  round(
                    n(
                      ticker
                        .priceChangePercent
                    ),
                    3
                  ),

                quote_volume_24h:
                  round(
                    n(
                      ticker
                        .quoteVolume
                    ),
                    2
                  ),

                trend_15m:
                  stats.trend,

                rsi14_15m:
                  stats.rsi14,

                atr_percent_15m:
                  stats
                    .atr_percent,

                volume_ratio_15m:
                  stats
                    .volume_ratio_to_20bar_average,

                anomaly_score:
                  round(
                    anomalyScore,
                    3
                  )

              };

            } catch (
              error
            ) {

              console.log(
                "Scan error:",
                ticker.symbol,
                error.message
              );

              return null;
            }
          }
        )
      );

    output.push(
      ...batchResults.filter(
        Boolean
      )
    );
  }

  output.sort(
    (a, b) =>
      b.anomaly_score -
      a.anomaly_score
  );

  return {

    meta: {

      generated_at:
        new Date().toISOString(),

      market:
        "Binance Spot USDT",

      source:
        tickerResult.source,

      scanned_candidates:
        output.length,

      methodology:
        "Screening based on liquidity, 24h movement, 15m volatility, unusual volume and EMA trend alignment. Ranking is not a prediction."

    },

    hottest:
      output.slice(
        0,
        30
      ),

    strongest_uptrend:
      output
        .filter(
          x =>
            x.trend_15m ===
              "strong_up" ||
            x.trend_15m ===
              "up"
        )
        .slice(
          0,
          20
        ),

    strongest_downtrend:
      output
        .filter(
          x =>
            x.trend_15m ===
              "strong_down" ||
            x.trend_15m ===
              "down"
        )
        .slice(
          0,
          20
        )
  };
}

/* =========================
   TEXT REPORT
========================= */

function textReport(data) {

  const lines = [];

  lines.push(
    `MARKET: ${data.meta.symbol}`
  );

  lines.push(
    `GENERATED: ${data.meta.generated_at}`
  );

  lines.push(
    `SOURCE: ${data.meta.source}`
  );

  lines.push("");

  lines.push(
    `PRICE: ${data.live.last_price}`
  );

  lines.push(
    `24H CHANGE: ${data.live.price_change_percent_24h}%`
  );

  lines.push(
    `24H HIGH: ${data.live.high_24h}`
  );

  lines.push(
    `24H LOW: ${data.live.low_24h}`
  );

  lines.push(
    `24H QUOTE VOLUME: ${data.live.quote_volume_24h}`
  );

  lines.push("");

  for (
    const [
      interval,
      value
    ] of Object.entries(
      data.intervals
    )
  ) {

    const s =
      value.stats;

    lines.push(
      `[${interval}]`
    );

    lines.push(
      `TREND: ${s.trend}`
    );

    lines.push(
      `PRICE: ${s.last_close}`
    );

    lines.push(
      `EMA 9/21/50: ${s.ema9} / ${s.ema21} / ${s.ema50}`
    );

    lines.push(
      `RSI14: ${s.rsi14}`
    );

    lines.push(
      `ATR%: ${s.atr_percent}`
    );

    lines.push(
      `VOLUME RATIO: ${s.volume_ratio_to_20bar_average}`
    );

    lines.push(
      `SUPPORT: ${s.support_20bar}`
    );

    lines.push(
      `RESISTANCE: ${s.resistance_20bar}`
    );

    lines.push("");
  }

  lines.push(
    `MULTI TIMEFRAME: ${data.interpretation.state}`
  );

  lines.push(
    `SCORE: ${data.interpretation.multi_timeframe_score}`
  );

  lines.push(
    `IMPORTANT: This is market screening, not guaranteed profit.`
  );

  return lines.join(
    "\n"
  );
}

/* =========================
   WEB PAGE
========================= */

app.get(
  "/",
  (
    req,
    res
  ) => {

    res
      .type(
        "html"
      )
      .send(
`
<!doctype html>

<html>

<head>

<meta charset="utf-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1"
>

<title>
Binance AI Market Bridge
</title>

<style>

body{
font-family:system-ui;
max-width:900px;
margin:40px auto;
padding:0 16px;
line-height:1.55
}

input,
button{
padding:10px;
font-size:16px;
margin:4px
}

pre{
white-space:pre-wrap;
background:#f5f5f5;
padding:16px;
border-radius:8px;
overflow:auto
}

</style>

</head>

<body>

<h1>
Binance AI Market Bridge
</h1>

<p>
Binance public market data scanner.
</p>

<input
id="s"
value="BTCUSDT"
>

<button
onclick="go()"
>
Open report
</button>

<p>
<a href="/api/brief">
/api/brief
</a>

—
market overview
</p>

<p>
<a href="/api/scan">
/api/scan
</a>

—
scan active USDT markets
</p>

<pre
id="out"
>
Enter a symbol, e.g. BTCUSDT.
</pre>

<script>

async function go(){

const symbol =
document
.getElementById(
"s"
)
.value
.toUpperCase();

const response =
await fetch(
"/api/report?symbol=" +
encodeURIComponent(
symbol
)
);

document
.getElementById(
"out"
)
.textContent =
await response.text();

}

</script>

</body>

</html>
`
      );
  }
);

/* =========================
   API ENDPOINTS
========================= */

app.get(
  "/health",
  (
    req,
    res
  ) => {

    res.json({

      ok:
        true,

      now:
        new Date().toISOString(),

      market:
        "spot",

      endpoints:
        BINANCE_BASES

    });

  }
);

app.get(
  "/api/market",
  async (
    req,
    res
  ) => {

    try {

      const data =
        await marketSnapshot(
          req.query.symbol ||
          "BTCUSDT"
        );

      res.json(
        data
      );

    } catch (
      error
    ) {

      res
        .status(502)
        .json({

          error:
            error.message

        });

    }

  }
);

app.get(
  "/api/report",
  async (
    req,
    res
  ) => {

    try {

      const data =
        await marketSnapshot(
          req.query.symbol ||
          "BTCUSDT"
        );

      res
        .type(
          "text/plain; charset=utf-8"
        )
        .send(
          textReport(
            data
          )
        );

    } catch (
      error
    ) {

      res
        .status(502)
        .type(
          "text/plain"
        )
        .send(
          "ERROR: " +
          error.message
        );

    }

  }
);

app.get(
  "/api/scan",
  async (
    req,
    res
  ) => {

    try {

      const data =
        await scanMarket();

      res.json(
        data
      );

    } catch (
      error
    ) {

      res
        .status(502)
        .json({

          error:
            error.message

        });

    }

  }
);

app.get(
  "/api/brief",
  async (
    req,
    res
  ) => {

    try {

      const scan =
        await scanMarket();

      const symbols =
        scan
          .hottest
          .slice(
            0,
            10
          )
          .map(
            x =>
              x.symbol
          );

      const snapshots =
        await Promise.all(

          symbols.map(
            async symbol => {

              try {

                const data =
                  await marketSnapshot(
                    symbol
                  );

                return {

                  symbol,

                  generated_at:
                    data.meta.generated_at,

                  source:
                    data.meta.source,

                  current_price:
                    data.live.last_price,

                  change_24h_percent:
                    data.live
                      .price_change_percent_24h,

                  trend:
                    data.interpretation.state,

                  trend_score:
                    data.interpretation
                      .multi_timeframe_score,

                  support_15m:
                    data.interpretation
                      .support_15m,

                  resistance_15m:
                    data.interpretation
                      .resistance_15m

                };

              } catch (
                error
              ) {

                return {

                  symbol,

                  error:
                    error.message

                };

              }

            }
          )
        );

      res.json({

        meta: {

          generated_at:
            new Date().toISOString(),

          purpose:
            "Current market screening data."

        },

        scan,

        top_market_snapshots:
          snapshots

      });

    } catch (
      error
    ) {

      res
        .status(502)
        .json({

          error:
            error.message

        });

    }

  }
);

/* =========================
   START SERVER
========================= */

app.listen(
  PORT,
  () => {

    console.log(
      `Binance AI Market Bridge listening on ${PORT}`
    );

  }
);
