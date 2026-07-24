/**
 * Binance-backed Datafeed for the TradingView Charting Library.
 * ------------------------------------------------------------------
 * Implements the full REQUIRED Datafeed API surface:
 *   onReady, searchSymbols, resolveSymbol, getBars,
 *   subscribeBars, unsubscribeBars
 *
 * Uses only free, public Binance endpoints (no API key):
 *   - REST  https://api.binance.com/api/v3/klines        (historical bars)
 *   - REST  https://api.binance.com/api/v3/exchangeInfo  (symbol metadata / search)
 *   - WS    wss://stream.binance.com:9443/ws/<sym>@kline_<interval>  (real-time)
 *
 * Usage with the licensed Charting Library widget:
 *   new TradingView.widget({
 *     container: 'chart',
 *     library_path: 'charting_library/',
 *     datafeed: createBinanceDatafeed(),
 *     symbol: 'BTCUSDT',
 *     interval: '60',
 *     ...
 *   });
 *
 * NOTE: Charting Library Bar.time is in MILLISECONDS. Daily/weekly/monthly
 *       bars must be aligned to 00:00:00 UTC — Binance klines already are.
 */
(function (global) {
  'use strict';

  const REST = 'https://api.binance.com/api/v3';
  const WS_BASE = 'wss://stream.binance.com:9443/ws';
  const QUOTE_POLL_MS = 10000; // how often subscribeQuotes refreshes (ms)

  // Charting Library resolution  ->  Binance kline interval
  const RESOLUTION_MAP = {
    '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m',
    '60': '1h', '120': '2h', '240': '4h', '360': '6h', '480': '8h', '720': '12h',
    '1D': '1d', 'D': '1d', '1W': '1w', 'W': '1w', '1M': '1M', 'M': '1M',
  };

  const SUPPORTED_RESOLUTIONS = ['1', '5', '15', '30', '60', '240', '1D', '1W', '1M'];

  const SEARCH_PAGE_SIZE = 30; // results per page for searchSymbolsPaginated

  // Resolutions the datafeed serves NATIVELY (Binance klines exist for each).
  // Declaring these stops the library from trying to build, e.g., 4h bars by
  // aggregating thousands of 1m bars (which Binance's 1000-bar cap would break).
  const INTRADAY_MULTIPLIERS = ['1', '5', '15', '30', '60', '240']; // minutes
  const DAILY_MULTIPLIERS = ['1'];
  const WEEKLY_MULTIPLIERS = ['1'];
  const MONTHLY_MULTIPLIERS = ['1'];

  // Derive the library's decimal price format from a Binance tick size.
  // Per Symbology docs: pricescale = 10^(decimals), minmov = round(tick * pricescale).
  //   tick 0.01  -> { pricescale: 100,   minmov: 1 }
  //   tick 0.05  -> { pricescale: 100,   minmov: 5 }
  //   tick 0.0125-> { pricescale: 10000, minmov: 125 }
  function priceFormatFromTick(tickSizeStr) {
    const tick = parseFloat(tickSizeStr);
    if (!(tick > 0)) return { pricescale: 100, minmov: 1 };
    let s = String(tickSizeStr);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, ''); // trim trailing zeros
    const dot = s.indexOf('.');
    const decimals = dot >= 0 ? s.length - dot - 1 : 0;
    const pricescale = Math.pow(10, decimals);
    return { pricescale, minmov: Math.max(1, Math.round(tick * pricescale)) };
  }

  // Mark thresholds (tuned to be visible but not noisy).
  const VOLUME_SPIKE_FACTOR = 2.5;   // bar volume >= 2.5x the window average
  const BIG_MOVE_PCT = 5;            // |close-open|/open >= 5%

  // Compute chart marks (volume spikes) and time-scale marks (big moves) from
  // raw Binance kline rows: [openTime, o, h, l, c, volume, ...].
  function computeMarks(rows) {
    const chart = [];
    const timescale = [];
    if (!rows.length) return { chart, timescale };
    const vols = rows.map((r) => +r[5]);
    const avg = vols.reduce((a, b) => a + b, 0) / vols.length;
    for (const r of rows) {
      const time = Math.floor(r[0] / 1000); // marks use SECONDS
      const vol = +r[5];
      if (avg > 0 && vol >= VOLUME_SPIKE_FACTOR * avg) {
        chart.push({
          id: `vol-${r[0]}`,
          time,
          color: { border: '#f0a020', background: '#f0a020' },
          text: `Volume spike: ${vol.toFixed(2)} (${(vol / avg).toFixed(1)}x the ${rows.length}-bar average)`,
          label: 'V',
          labelFontColor: '#ffffff',
          minSize: 18,
        });
      }
      const open = +r[1];
      const close = +r[4];
      const pct = open > 0 ? ((close - open) / open) * 100 : 0;
      if (Math.abs(pct) >= BIG_MOVE_PCT) {
        timescale.push({
          id: `move-${r[0]}`,
          time,
          color: pct >= 0 ? '#089981' : '#f23645',
          label: pct >= 0 ? 'U' : 'D',
          tooltip: [`${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% bar`],
          shape: 'circle',
        });
      }
    }
    return { chart, timescale };
  }

  // Fetch kline rows for a [from, to) second-range at a given interval.
  function fetchKlineRange(ticker, interval, fromSec, toSec) {
    const params = new URLSearchParams({
      symbol: ticker,
      interval,
      startTime: String(fromSec * 1000),
      endTime: String(toSec * 1000),
      limit: '1000',
    });
    return fetch(`${REST}/klines?${params.toString()}`).then((r) => {
      if (!r.ok) throw new Error(`klines ${r.status}`);
      return r.json();
    });
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

  function createBinanceDatafeed(options) {
    options = options || {};
    // Restrict the symbol universe to a quote asset (default USDT) to keep search tidy.
    const quoteFilter = options.quoteAsset || 'USDT';

    let symbolsPromise = null;          // lazy-loaded exchangeInfo cache
    const subscriptions = new Map();      // listenerGuid -> WebSocket (bars)
    const quoteSubscriptions = new Map(); // listenerGuid -> setInterval id (quotes)

    // ---- exchangeInfo: symbol list + price/volume precision --------------
    function loadSymbols() {
      if (!symbolsPromise) {
        symbolsPromise = fetch(`${REST}/exchangeInfo`)
          .then((r) => {
            if (!r.ok) throw new Error(`exchangeInfo ${r.status}`);
            return r.json();
          })
          .then((data) =>
            data.symbols
              .filter((s) => s.status === 'TRADING' && (!quoteFilter || s.quoteAsset === quoteFilter))
              .map((s) => {
                const priceFilter = (s.filters || []).find((f) => f.filterType === 'PRICE_FILTER');
                const { pricescale, minmov } = priceFormatFromTick(priceFilter ? priceFilter.tickSize : '0.01');
                return {
                  symbol: s.symbol,                          // e.g. BTCUSDT
                  full_name: `BINANCE:${s.symbol}`,
                  description: `${s.baseAsset}/${s.quoteAsset}`,
                  exchange: 'BINANCE',
                  ticker: s.symbol,
                  type: 'crypto',
                  pricescale,
                  minmov,
                };
              })
          )
          .catch((err) => {
            symbolsPromise = null; // allow retry on next call
            throw err;
          });
      }
      return symbolsPromise;
    }

    function stripExchange(name) {
      // 'BINANCE:BTCUSDT' -> 'BTCUSDT'
      const i = name.indexOf(':');
      return (i >= 0 ? name.slice(i + 1) : name).toUpperCase();
    }

    // Shared matcher for searchSymbols + searchSymbolsPaginated. Returns the full
    // ordered match list (callers slice it); ordering is stable so pages don't
    // overlap or drop items between successive paginated requests.
    function matchSymbols(symbols, userInput, symbolType) {
      const q = (userInput || '').toUpperCase();
      return symbols
        .filter((s) =>
          (!q || s.symbol.includes(q) || s.description.toUpperCase().includes(q)) &&
          (!symbolType || s.type === symbolType)
        )
        .map((s) => ({
          symbol: s.symbol,
          full_name: s.full_name,
          description: s.description,
          exchange: s.exchange,
          ticker: s.ticker,
          type: s.type,
        }));
    }

    // ---------------------------------------------------------------------
    return {
      onReady(callback) {
        setTimeout(() => callback(CONFIG), 0);
      },

      searchSymbols(userInput, exchange, symbolType, onResult) {
        loadSymbols()
          .then((symbols) => onResult(matchSymbols(symbols, userInput, symbolType).slice(0, 50)))
          .catch(() => onResult([]));
      },

      // Offset-based pagination for large symbol universes (470 USDT pairs here).
      // CONFIRMED from SymbolSearchPaginatedOptions: params is an object carrying
      // { userInput, exchange, symbolType, start } and `start` is the offset (how
      // many results were already returned). The symbols go back through the same
      // result callback; the return value tells the library whether more pages
      // exist. NOTE: the exact result/return shape ({ hasMoreData } here) varies
      // by library version — verify against your installed charting_library.
      searchSymbolsPaginated(params, onResult) {
        const start = Math.max(0, params && Number(params.start) || 0);
        return loadSymbols()
          .then((symbols) => {
            const all = matchSymbols(symbols, params && params.userInput, params && params.symbolType);
            const page = all.slice(start, start + SEARCH_PAGE_SIZE);
            onResult(page);
            return { hasMoreData: start + SEARCH_PAGE_SIZE < all.length };
          })
          .catch(() => {
            onResult([]);
            return { hasMoreData: false };
          });
      },

      resolveSymbol(symbolName, onResolve, onError /*, extension */) {
        const ticker = stripExchange(symbolName);
        loadSymbols()
          .then((symbols) => {
            const match = symbols.find((s) => s.symbol === ticker);
            if (!match) {
              onError('unknown_symbol');
              return;
            }
            const symbolInfo = {
              ticker: match.symbol,
              name: match.symbol,
              description: match.description,
              type: 'crypto',
              session: '24x7',
              timezone: 'Etc/UTC',
              exchange: 'BINANCE',
              listed_exchange: 'BINANCE',
              format: 'price',
              minmov: match.minmov,
              pricescale: match.pricescale,
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
            setTimeout(() => onResolve(symbolInfo), 0);
          })
          .catch(() => onError('unknown_symbol'));
      },

      getBars(symbolInfo, resolution, periodParams, onHistory, onError) {
        const interval = RESOLUTION_MAP[resolution];
        if (!interval) {
          // Invoke callbacks asynchronously — a synchronous error here can trip
          // "Maximum call stack size exceeded" inside the library.
          setTimeout(() => onError(`Unsupported resolution: ${resolution}`), 0);
          return;
        }
        const { from, to, countBack, firstDataRequest } = periodParams;

        // Binance returns the last `limit` bars ending at endTime. Requesting
        // `countBack` bars up to `to` satisfies the library's countBack contract.
        const limit = Math.min(1000, Math.max(countBack || 0, 1) + 1);
        const params = new URLSearchParams({
          symbol: symbolInfo.ticker,
          interval,
          endTime: String(to * 1000),
          limit: String(limit),
        });

        fetch(`${REST}/klines?${params.toString()}`)
          .then((r) => {
            if (!r.ok) throw new Error(`klines ${r.status}`);
            return r.json();
          })
          .then((rows) => {
            // Binance row: [openTime, o, h, l, c, volume, closeTime, ...]
            const bars = rows
              .filter((r) => r[0] < to * 1000) // [from, to) — `to` exclusive
              .map((r) => ({
                time: r[0],           // MILLISECONDS (already 00:00 UTC for daily+)
                open: +r[1],
                high: +r[2],
                low: +r[3],
                close: +r[4],
                volume: +r[5],
              }));

            if (bars.length === 0) {
              onHistory([], { noData: true });
            } else {
              onHistory(bars, { noData: false });
            }
          })
          .catch((err) => onError(err.message));
      },

      subscribeBars(symbolInfo, resolution, onTick, listenerGuid, onResetCacheNeededCallback) {
        const interval = RESOLUTION_MAP[resolution];
        if (!interval) return;

        const stream = `${symbolInfo.ticker.toLowerCase()}@kline_${interval}`;
        const ws = new WebSocket(`${WS_BASE}/${stream}`);

        ws.onmessage = (ev) => {
          let msg;
          try { msg = JSON.parse(ev.data); } catch (_) { return; }
          const k = msg.k;
          if (!k) return;
          // Forward every update; the library replaces the last bar when the
          // time matches, or appends a new one when the interval rolls over.
          onTick({
            time: k.t,          // MILLISECONDS
            open: +k.o,
            high: +k.h,
            low: +k.l,
            close: +k.c,
            volume: +k.v,
          });
        };

        subscriptions.set(listenerGuid, ws);
      },

      unsubscribeBars(listenerGuid) {
        const ws = subscriptions.get(listenerGuid);
        if (ws) {
          try { ws.close(); } catch (_) { /* noop */ }
          subscriptions.delete(listenerGuid);
        }
      },

      // ---- Server time: required because CONFIG.supports_time is true. Powers
      //      the bar-close countdown and keeps the chart's clock in sync.
      //      Callback receives a Unix timestamp in SECONDS. ----
      getServerTime(callback) {
        fetch(`${REST}/time`)
          .then((r) => r.json())
          .then((d) => callback(Math.floor((d.serverTime || Date.now()) / 1000)))
          .catch(() => callback(Math.floor(Date.now() / 1000))); // fall back to local clock
      },

      // ---- Marks: chart marks = volume spikes; time-scale marks = big moves.
      //      Both computed from klines over the visible [from, to] range. ----
      getMarks(symbolInfo, from, to, onData, resolution) {
        const interval = RESOLUTION_MAP[resolution];
        if (!interval) { setTimeout(() => onData([]), 0); return; }
        fetchKlineRange(symbolInfo.ticker, interval, from, to)
          .then((rows) => onData(computeMarks(rows).chart))
          .catch(() => onData([]));
      },

      getTimescaleMarks(symbolInfo, from, to, onData, resolution) {
        const interval = RESOLUTION_MAP[resolution];
        if (!interval) { setTimeout(() => onData([]), 0); return; }
        fetchKlineRange(symbolInfo.ticker, interval, from, to)
          .then((rows) => onData(computeMarks(rows).timescale))
          .catch(() => onData([]));
      },

      // ---- Quotes (Trading Platform): powers legend last-day-change & fixes
      //      "NaN values in legend". Backed by Binance /ticker/24hr. ----
      getQuotes(symbolNames, onData, onError) {
        // The library may request 'BINANCE:BTCUSDT' or 'BTCUSDT'. We must echo the
        // ORIGINAL requested name back in `n`, but query Binance by bare ticker.
        const wanted = symbolNames.map((name) => ({ name, ticker: stripExchange(name) }));
        const params = new URLSearchParams({ symbols: JSON.stringify(wanted.map((w) => w.ticker)) });
        fetch(`${REST}/ticker/24hr?${params.toString()}`)
          .then((r) => {
            if (!r.ok) throw new Error(`ticker ${r.status}`);
            return r.json();
          })
          .then((rows) => {
            const byTicker = new Map((Array.isArray(rows) ? rows : [rows]).map((t) => [t.symbol, t]));
            const data = wanted.map(({ name, ticker }) => {
              const t = byTicker.get(ticker);
              if (!t) return { s: 'error', n: name, v: {} };
              return {
                s: 'ok',
                n: name, // echo the requested name exactly
                v: {
                  ch: +t.priceChange,
                  chp: +t.priceChangePercent,
                  lp: +t.lastPrice,
                  ask: +t.askPrice,
                  bid: +t.bidPrice,
                  open_price: +t.openPrice,
                  high_price: +t.highPrice,
                  low_price: +t.lowPrice,
                  prev_close_price: +t.prevClosePrice,
                  volume: +t.volume,
                  short_name: t.symbol,
                  exchange: 'BINANCE',
                  description: t.symbol,
                },
              };
            });
            onData(data);
          })
          .catch((err) => onError(err.message));
      },

      subscribeQuotes(symbolNames, fastSymbols, onRealtime, listenerGuid) {
        // Poll the union of symbols. (Binance also offers <symbol>@ticker WS streams;
        // polling keeps this simple and matches the UDF adapter's behaviour.)
        const all = Array.from(new Set([...(symbolNames || []), ...(fastSymbols || [])]));
        const tick = () => this.getQuotes(all, onRealtime, () => {});
        tick();
        quoteSubscriptions.set(listenerGuid, setInterval(tick, QUOTE_POLL_MS));
      },

      unsubscribeQuotes(listenerGuid) {
        const id = quoteSubscriptions.get(listenerGuid);
        if (id) { clearInterval(id); quoteSubscriptions.delete(listenerGuid); }
      },
    };
  }

  // Export for both module and script-tag usage.
  global.createBinanceDatafeed = createBinanceDatafeed;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createBinanceDatafeed };
  }
})(typeof window !== 'undefined' ? window : globalThis);
