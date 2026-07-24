/**
 * Real-time streaming wrapper for the UDF adapter.
 * ------------------------------------------------------------------
 * The built-in Datafeeds.UDFCompatibleDatafeed has no native streaming — it
 * re-polls /history on a timer. This wrapper keeps ALL of its HTTP behaviour
 * (config, search, resolve, history, quotes, marks) and replaces only the
 * real-time path — subscribeBars / unsubscribeBars — with a live Binance
 * kline WebSocket.
 *
 * Usage (in place of `new Datafeeds.UDFCompatibleDatafeed(...)`):
 *
 *   <script src="datafeeds/udf/dist/bundle.js"></script>
 *   <script src="udf-streaming.js"></script>
 *   ...
 *   datafeed: createStreamingUDFDatafeed('http://localhost:8000'),
 *
 * Requires the UDF adapter bundle (Datafeeds global) to be loaded first.
 */
(function (global) {
  'use strict';

  const WS_BASE = 'wss://stream.binance.com:9443/ws';

  // Charting Library resolution -> Binance kline interval (mirrors udf-server.js).
  const RESOLUTION_MAP = {
    '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m',
    '60': '1h', '120': '2h', '240': '4h', '360': '6h', '480': '8h', '720': '12h',
    '1D': '1d', 'D': '1d', '1W': '1w', 'W': '1w', '1M': '1M', 'M': '1M',
  };

  function createStreamingUDFDatafeed(datafeedURL, updateFrequency, limitedServerResponse) {
    if (!global.Datafeeds || !global.Datafeeds.UDFCompatibleDatafeed) {
      throw new Error('Datafeeds.UDFCompatibleDatafeed not found — load the UDF adapter bundle first.');
    }

    const udf = new global.Datafeeds.UDFCompatibleDatafeed(datafeedURL, updateFrequency, limitedServerResponse);

    // One WebSocket per unique stream; many chart subscriptions can share it.
    // channel key: "btcusdt@kline_1h"
    const channels = new Map();       // key -> { ws, handlers: Map<guid, onTick>, closing }
    const guidToChannel = new Map();  // listenerGuid -> key

    function channelKey(symbolInfo, resolution) {
      const interval = RESOLUTION_MAP[resolution];
      if (!interval) return null;
      return `${symbolInfo.ticker.toLowerCase()}@kline_${interval}`;
    }

    function openSocket(key) {
      const channel = { ws: null, handlers: new Map(), closing: false, retry: 0 };

      const connect = () => {
        const ws = new WebSocket(`${WS_BASE}/${key}`);
        channel.ws = ws;

        ws.onmessage = (ev) => {
          let msg;
          try { msg = JSON.parse(ev.data); } catch (_) { return; }
          const k = msg.k;
          if (!k) return;
          // Binance kline delivers the full forming bar; the library replaces
          // the last bar when time matches, or appends when the interval rolls.
          const bar = {
            time: k.t,            // MILLISECONDS
            open: +k.o,
            high: +k.h,
            low: +k.l,
            close: +k.c,
            volume: +k.v,
          };
          channel.handlers.forEach((cb) => {
            try { cb(bar); } catch (e) { console.error('[streaming] onTick error', e); }
          });
        };

        ws.onclose = () => {
          if (channel.closing || channel.handlers.size === 0) return;
          // Unexpected drop — reconnect with capped exponential backoff.
          channel.retry = Math.min(channel.retry + 1, 6);
          const delay = Math.min(1000 * 2 ** channel.retry, 30000);
          setTimeout(() => { if (!channel.closing && channel.handlers.size > 0) connect(); }, delay);
        };

        ws.onopen = () => { channel.retry = 0; };
        ws.onerror = () => { try { ws.close(); } catch (_) {} };
      };

      connect();
      return channel;
    }

    return {
      // ---- delegate every non-streaming method to the real UDF adapter ----
      onReady: (cb) => udf.onReady(cb),
      searchSymbols: (...a) => udf.searchSymbols(...a),
      resolveSymbol: (...a) => udf.resolveSymbol(...a),
      getBars: (...a) => udf.getBars(...a),
      // optional methods — forward only if the adapter provides them
      getServerTime: udf.getServerTime ? (...a) => udf.getServerTime(...a) : undefined,
      getMarks: udf.getMarks ? (...a) => udf.getMarks(...a) : undefined,
      getTimescaleMarks: udf.getTimescaleMarks ? (...a) => udf.getTimescaleMarks(...a) : undefined,
      getQuotes: udf.getQuotes ? (...a) => udf.getQuotes(...a) : undefined,
      subscribeQuotes: udf.subscribeQuotes ? (...a) => udf.subscribeQuotes(...a) : undefined,
      unsubscribeQuotes: udf.unsubscribeQuotes ? (...a) => udf.unsubscribeQuotes(...a) : undefined,

      // ---- override the real-time path with a live WebSocket ----
      subscribeBars(symbolInfo, resolution, onTick, listenerGuid /*, onResetCacheNeededCallback */) {
        const key = channelKey(symbolInfo, resolution);
        if (!key) {
          console.error('[streaming] unsupported resolution:', resolution);
          return;
        }
        let channel = channels.get(key);
        if (!channel) {
          channel = openSocket(key);
          channels.set(key, channel);
        }
        channel.handlers.set(listenerGuid, onTick);
        guidToChannel.set(listenerGuid, key);
      },

      unsubscribeBars(listenerGuid) {
        const key = guidToChannel.get(listenerGuid);
        if (!key) return;
        guidToChannel.delete(listenerGuid);

        const channel = channels.get(key);
        if (!channel) return;
        channel.handlers.delete(listenerGuid);

        // Last listener gone — close the socket and drop the channel.
        if (channel.handlers.size === 0) {
          channel.closing = true;
          try { channel.ws && channel.ws.close(); } catch (_) {}
          channels.delete(key);
        }
      },
    };
  }

  global.createStreamingUDFDatafeed = createStreamingUDFDatafeed;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createStreamingUDFDatafeed };
  }
})(typeof window !== 'undefined' ? window : globalThis);
