/**
 * UDF-compatible datafeed backend for the TradingView Charting Library.
 * ---------------------------------------------------------------------
 * Implements the Universal Datafeed (UDF) HTTP protocol, backed by the
 * free public Binance API. Pair it with the library's built-in adapter:
 *
 *   const datafeed = new Datafeeds.UDFCompatibleDatafeed("http://localhost:8000");
 *
 * Endpoints (per the UDF spec):
 *   GET /config    -> DatafeedConfiguration (+ supports_search)
 *   GET /symbols   -> LibrarySymbolInfo for one symbol   (?symbol=BTCUSDT)
 *   GET /search    -> SearchSymbolResultItem[]           (?query=&type=&exchange=&limit=)
 *   GET /history   -> { s, t, o, h, l, c, v }            (?symbol=&resolution=&from=&to=&countback=)
 *   GET /time      -> server time, unix seconds
 *   GET /quotes    -> { s, d:[QuoteData] }               (?symbols=A,B,C)  [Trading Platform]
 *
 * Zero dependencies. Node 18+ (uses global fetch). Run:  node udf-server.js
 */
'use strict';

const http = require('node:http');
const { URL } = require('node:url');

const PORT = process.env.PORT || 8000;
const REST = 'https://api.binance.com/api/v3';
const QUOTE_ASSET = process.env.QUOTE_ASSET || 'USDT';

// UDF resolution -> Binance kline interval, plus seconds-per-bar for range math.
const RESOLUTION_MAP = {
  '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m',
  '60': '1h', '120': '2h', '240': '4h', '360': '6h', '480': '8h', '720': '12h',
  '1D': '1d', 'D': '1d', '1W': '1w', 'W': '1w', '1M': '1M', 'M': '1M',
};

const SUPPORTED_RESOLUTIONS = ['1', '5', '15', '30', '60', '240', '1D', '1W', '1M'];

// Resolutions the datafeed serves NATIVELY (a Binance kline interval exists for
// each). Declaring these stops the library building larger intraday bars from
// 1m data — which Binance's 1000-bar-per-request cap would truncate.
const INTRADAY_MULTIPLIERS = ['1', '5', '15', '30', '60', '240']; // minutes
const DAILY_MULTIPLIERS = ['1'];
const WEEKLY_MULTIPLIERS = ['1'];
const MONTHLY_MULTIPLIERS = ['1'];

// Derive the library's decimal price format from a Binance tick size.
// Per Symbology docs: pricescale = 10^(decimals), minmov = round(tick * pricescale).
function priceFormatFromTick(tickSizeStr) {
  const tick = parseFloat(tickSizeStr);
  if (!(tick > 0)) return { pricescale: 100, minmov: 1 };
  let s = String(tickSizeStr);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  const dot = s.indexOf('.');
  const decimals = dot >= 0 ? s.length - dot - 1 : 0;
  const pricescale = Math.pow(10, decimals);
  return { pricescale, minmov: Math.max(1, Math.round(tick * pricescale)) };
}

const CONFIG = {
  supported_resolutions: SUPPORTED_RESOLUTIONS,
  supports_search: true,
  supports_group_request: false,
  supports_marks: true,
  supports_timescale_marks: true,
  supports_time: true,
  exchanges: [
    { value: '', name: 'All Exchanges', desc: '' },
    { value: 'BINANCE', name: 'Binance', desc: 'Binance' },
  ],
  symbols_types: [
    { name: 'All types', value: '' },
    { name: 'Crypto', value: 'crypto' },
  ],
};

// --------------------------------------------------------------------------
// Symbol universe cache (from Binance exchangeInfo)
// --------------------------------------------------------------------------
let symbolCache = null;
let symbolCacheAt = 0;
const SYMBOL_TTL = 60 * 60 * 1000; // 1 hour

async function getSymbols() {
  if (symbolCache && Date.now() - symbolCacheAt < SYMBOL_TTL) return symbolCache;

  const res = await fetch(`${REST}/exchangeInfo`);
  if (!res.ok) throw new Error(`exchangeInfo ${res.status}`);
  const data = await res.json();

  symbolCache = data.symbols
    .filter((s) => s.status === 'TRADING' && (!QUOTE_ASSET || s.quoteAsset === QUOTE_ASSET))
    .map((s) => {
      const pf = (s.filters || []).find((f) => f.filterType === 'PRICE_FILTER');
      const { pricescale, minmov } = priceFormatFromTick(pf ? pf.tickSize : '0.01');
      return {
        symbol: s.symbol,
        base: s.baseAsset,
        quote: s.quoteAsset,
        description: `${s.baseAsset}/${s.quoteAsset}`,
        pricescale,
        minmov,
      };
    });
  symbolCacheAt = Date.now();
  return symbolCache;
}

function stripExchange(name) {
  const i = String(name).indexOf(':');
  return (i >= 0 ? name.slice(i + 1) : name).toUpperCase();
}

function librarySymbolInfo(s) {
  return {
    ticker: s.symbol,
    name: s.symbol,
    full_name: `BINANCE:${s.symbol}`,
    description: s.description,
    type: 'crypto',
    session: '24x7',
    timezone: 'Etc/UTC',
    exchange: 'BINANCE',
    listed_exchange: 'BINANCE',
    format: 'price',
    minmov: s.minmov,
    pricescale: s.pricescale,
    has_intraday: true,
    intraday_multipliers: INTRADAY_MULTIPLIERS,
    has_daily: true,
    daily_multipliers: DAILY_MULTIPLIERS,
    has_weekly_and_monthly: true,
    weekly_multipliers: WEEKLY_MULTIPLIERS,
    monthly_multipliers: MONTHLY_MULTIPLIERS,
    has_seconds: false,
    has_ticks: false,
    supported_resolutions: SUPPORTED_RESOLUTIONS,
    volume_precision: 2,
    data_status: 'streaming',
    visible_plots_set: 'ohlcv',
  };
}

// --------------------------------------------------------------------------
// Endpoint handlers
// --------------------------------------------------------------------------
async function handleSearch(q) {
  const query = (q.get('query') || '').toUpperCase();
  const type = q.get('type') || '';
  const limit = Math.min(parseInt(q.get('limit'), 10) || 30, 50);
  const symbols = await getSymbols();

  return symbols
    .filter((s) =>
      (!query || s.symbol.includes(query) || s.description.toUpperCase().includes(query)) &&
      (!type || type === 'crypto')
    )
    .slice(0, limit)
    .map((s) => ({
      symbol: s.symbol,
      full_name: `BINANCE:${s.symbol}`,
      description: s.description,
      exchange: 'BINANCE',
      ticker: s.symbol,
      type: 'crypto',
    }));
}

async function handleSymbols(q) {
  const ticker = stripExchange(q.get('symbol') || '');
  const symbols = await getSymbols();
  const match = symbols.find((s) => s.symbol === ticker);
  if (!match) return { s: 'error', errmsg: 'unknown_symbol' };
  return librarySymbolInfo(match);
}

async function handleHistory(q) {
  const symbol = stripExchange(q.get('symbol') || '');
  const resolution = q.get('resolution') || '1D';
  const interval = RESOLUTION_MAP[resolution];
  if (!interval) return { s: 'error', errmsg: `unsupported resolution ${resolution}` };

  const to = parseInt(q.get('to'), 10);
  const from = parseInt(q.get('from'), 10);
  const countback = parseInt(q.get('countback'), 10);

  // countback has priority over `from` (per UDF spec). Binance caps limit at 1000.
  const limit = Math.min(1000, (Number.isFinite(countback) ? countback : 500) + 1);

  const params = new URLSearchParams({
    symbol,
    interval,
    endTime: String(to * 1000),
    limit: String(limit),
  });
  if (!Number.isFinite(countback) && Number.isFinite(from)) {
    params.set('startTime', String(from * 1000));
  }

  const res = await fetch(`${REST}/klines?${params.toString()}`);
  if (!res.ok) return { s: 'error', errmsg: `klines ${res.status}` };
  const rows = await res.json();

  // Keep bars strictly before `to` ([from, to) — `to` is exclusive).
  const bars = rows.filter((r) => r[0] < to * 1000);

  if (bars.length === 0) {
    // nextTime: the closest available bar in the past, if any older bar exists.
    if (rows.length > 0) {
      return { s: 'no_data', nextTime: Math.floor(rows[rows.length - 1][0] / 1000) };
    }
    return { s: 'no_data' };
  }

  // Response-as-a-table: parallel arrays. Times in SECONDS (00:00 UTC for daily+).
  return {
    s: 'ok',
    t: bars.map((r) => Math.floor(r[0] / 1000)),
    o: bars.map((r) => +r[1]),
    h: bars.map((r) => +r[2]),
    l: bars.map((r) => +r[3]),
    c: bars.map((r) => +r[4]),
    v: bars.map((r) => +r[5]),
  };
}

// --------------------------------------------------------------------------
// Marks: chart marks (volume spikes) + time-scale marks (big moves).
// --------------------------------------------------------------------------
const VOLUME_SPIKE_FACTOR = 2.5; // bar volume >= 2.5x the window average
const BIG_MOVE_PCT = 5;          // |close-open|/open >= 5%

async function fetchMarkRows(q) {
  const symbol = stripExchange(q.get('symbol') || '');
  const interval = RESOLUTION_MAP[q.get('resolution') || '1D'];
  if (!interval) return [];
  const from = parseInt(q.get('from'), 10);
  const to = parseInt(q.get('to'), 10);
  const params = new URLSearchParams({
    symbol, interval,
    startTime: String(from * 1000),
    endTime: String(to * 1000),
    limit: '1000',
  });
  const res = await fetch(`${REST}/klines?${params.toString()}`);
  if (!res.ok) return [];
  return res.json();
}

async function handleMarks(q) {
  const rows = await fetchMarkRows(q);
  if (!rows.length) return { id: [], time: [], color: [], text: [], label: [], labelFontColor: [] };
  const avg = rows.reduce((a, r) => a + (+r[5]), 0) / rows.length;
  // Response-as-a-table: parallel arrays, one entry per mark.
  const marks = { id: [], time: [], color: [], text: [], label: [], labelFontColor: [], minSize: [] };
  for (const r of rows) {
    const vol = +r[5];
    if (avg > 0 && vol >= VOLUME_SPIKE_FACTOR * avg) {
      marks.id.push(`vol-${r[0]}`);
      marks.time.push(Math.floor(r[0] / 1000)); // SECONDS
      marks.color.push('#f0a020');
      marks.text.push(`Volume spike: ${vol.toFixed(2)} (${(vol / avg).toFixed(1)}x the ${rows.length}-bar average)`);
      marks.label.push('V');
      marks.labelFontColor.push('#ffffff');
      marks.minSize.push(18);
    }
  }
  return marks;
}

async function handleTimescaleMarks(q) {
  const rows = await fetchMarkRows(q);
  // Time-scale marks response: a JSON array of objects.
  const marks = [];
  for (const r of rows) {
    const open = +r[1];
    const close = +r[4];
    const pct = open > 0 ? ((close - open) / open) * 100 : 0;
    if (Math.abs(pct) >= BIG_MOVE_PCT) {
      marks.push({
        id: `move-${r[0]}`,
        time: Math.floor(r[0] / 1000), // SECONDS
        color: pct >= 0 ? '#089981' : '#f23645',
        label: pct >= 0 ? 'U' : 'D',
        tooltip: `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% bar`,
        shape: 'circle',
      });
    }
  }
  return marks;
}

async function handleQuotes(q) {
  const requested = (q.get('symbols') || '')
    .split(',')
    .map((s) => stripExchange(s.trim()))
    .filter(Boolean);
  if (requested.length === 0) return { s: 'ok', d: [] };

  const params = new URLSearchParams({ symbols: JSON.stringify(requested) });
  const res = await fetch(`${REST}/ticker/24hr?${params.toString()}`);
  if (!res.ok) return { s: 'error', errmsg: `ticker ${res.status}` };
  const rows = await res.json();
  const list = Array.isArray(rows) ? rows : [rows];

  return {
    s: 'ok',
    d: list.map((t) => ({
      s: 'ok',
      n: `BINANCE:${t.symbol}`,
      v: {
        ch: +t.priceChange,
        chp: +t.priceChangePercent,
        short_name: t.symbol,
        exchange: 'BINANCE',
        description: t.symbol,
        lp: +t.lastPrice,
        ask: +t.askPrice,
        bid: +t.bidPrice,
        open_price: +t.openPrice,
        high_price: +t.highPrice,
        low_price: +t.lowPrice,
        prev_close_price: +t.prevClosePrice,
        volume: +t.volume,
      },
    })),
  };
}

// --------------------------------------------------------------------------
// Router
// --------------------------------------------------------------------------
function send(res, status, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',            // the library runs in the browser
    'Access-Control-Allow-Headers': '*',
  });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    return send(res, 400, { s: 'error', errmsg: 'bad url' });
  }
  const q = url.searchParams;

  try {
    switch (url.pathname) {
      case '/config':
        return send(res, 200, CONFIG);
      case '/time':
        return send(res, 200, String(Math.floor(Date.now() / 1000)));
      case '/search':
        return send(res, 200, await handleSearch(q));
      case '/symbols':
        return send(res, 200, await handleSymbols(q));
      case '/history':
        return send(res, 200, await handleHistory(q));
      case '/marks':
        return send(res, 200, await handleMarks(q));
      case '/timescale_marks':
        return send(res, 200, await handleTimescaleMarks(q));
      case '/quotes':
        return send(res, 200, await handleQuotes(q));
      case '/':
        return send(res, 200, { ok: true, service: 'UDF datafeed (Binance)', endpoints: ['/config', '/symbols', '/search', '/history', '/time', '/marks', '/timescale_marks', '/quotes'] });
      default:
        return send(res, 404, { s: 'error', errmsg: 'not found' });
    }
  } catch (err) {
    return send(res, 500, { s: 'error', errmsg: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`UDF datafeed listening on http://localhost:${PORT}  (quote asset: ${QUOTE_ASSET})`);
});
