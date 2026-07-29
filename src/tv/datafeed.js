/**
 * TradingView Datafeed API over this app's own `/tv/*` routes.
 *
 * The sibling of `src/nse/datafeed.js`: same interface, same shapes, different
 * feed underneath. That one serves NSE from an Angel One subscription; this one
 * serves every exchange TradingView carries, from TradingView's widget socket,
 * with the caveats set out in `server/tvfeed.js`.
 *
 *   const datafeed = createTvDatafeed();
 *   new TradingView.widget({ symbol: 'BINANCE:BTCUSDT', datafeed, ... });
 *
 * Symbols are exchange-qualified — 'NSE:RELIANCE', not 'RELIANCE'. Unprefixed
 * names resolve to whichever listing TradingView prefers, which for a
 * dual-listed Indian company is often BSE rather than NSE.
 *
 * Time units, which differ by callback and are the usual source of bars stacked
 * on 1970:
 *
 *   getBars       periodParams.from / .to   unix **seconds**
 *   getBars       returned bar.time         unix **milliseconds**
 *   subscribeBars onTick bar.time           unix **milliseconds**
 *
 * All true UTC. SymbolInfo carries the exchange's `timezone` and the library
 * localises — nothing is shifted here, unlike `src/nse/chart.js`.
 */

import { periodArgs } from '../datafeed-compat.js';

/** Live bars arrive over SSE; this is how long to wait before retrying. */
const RETRY_MS = 3000;

class TvFeedError extends Error {
    constructor(message, { setup = false } = {}) {
        super(message);
        this.name = 'TvFeedError';
        this.isSetupProblem = setup;
    }
}

async function getJson(path) {
    let response;
    try {
        response = await fetch(path);
    } catch (error) {
        throw new TvFeedError(`Could not reach the server: ${error.message}`);
    }

    // Every /tv route answers JSON, errors included. Anything else means these
    // routes are not mounted here — usually a plain static file server.
    if (!(response.headers.get('content-type') || '').includes('application/json')) {
        throw new TvFeedError(
            'The /tv routes are not mounted on this origin, so TradingView feed data '
            + 'cannot load. Run “npm start” and open http://localhost:5500 rather than '
            + 'a plain file server.',
            { setup: true },
        );
    }

    const payload = await response.json();
    // UDF reports failure inside a 200 body, so the status code proves nothing.
    if (payload && payload.s === 'error') throw new TvFeedError(payload.errmsg);
    if (payload && payload.error) throw new TvFeedError(payload.error);
    return payload;
}

/** Column arrays from /tv/history → the bar objects the library expects. */
export function toBars(payload) {
    if (!payload || payload.s !== 'ok' || !Array.isArray(payload.t)) return [];
    return payload.t.map((seconds, i) => ({
        // Seconds on the wire, milliseconds in the callback.
        time: seconds * 1000,
        open: payload.o[i],
        high: payload.h[i],
        low: payload.l[i],
        close: payload.c[i],
        volume: payload.v ? payload.v[i] : undefined,
    }));
}

/**
 * Opens the live bar stream for one symbol.
 *
 * Split out because both the datafeed and the Lightweight Charts pane want it,
 * and neither should own the reconnect logic.
 *
 * @param {string} symbol      Exchange-qualified.
 * @param {string} resolution
 * @param {(bar: {time: number, open: number, high: number, low: number, close: number, volume: number}) => void} onBar
 *   `time` is milliseconds.
 * @param {object} [options]
 * @param {(quote: object) => void} [options.onQuote]
 * @param {string} [options.base]
 * @returns {() => void} Close the stream.
 */
export function openBarStream(symbol, resolution, onBar, { onQuote, base = '/tv' } = {}) {
    let source = null;
    let retry = null;
    let stopped = false;

    function open() {
        if (stopped) return;
        const params = new URLSearchParams({ symbol, resolution: String(resolution) });
        source = new EventSource(`${base}/stream?${params}`);

        source.addEventListener('bar', (event) => {
            try {
                const bar = JSON.parse(event.data);
                // Seconds upstream, milliseconds everywhere the library looks.
                onBar({ ...bar, time: bar.time * 1000 });
            } catch {
                // A malformed frame is not worth tearing the stream down for.
            }
        });

        if (onQuote) {
            source.addEventListener('quote', (event) => {
                try {
                    onQuote(JSON.parse(event.data));
                } catch { /* as above */ }
            });
        }

        // EventSource retries on its own, but not after the server closes the
        // response cleanly — which is what happens when the upstream drops.
        source.addEventListener('error', () => {
            if (stopped || source.readyState !== EventSource.CLOSED) return;
            source.close();
            retry = setTimeout(open, RETRY_MS);
        });
    }

    open();

    return () => {
        stopped = true;
        if (retry !== null) clearTimeout(retry);
        source?.close();
    };
}

/**
 * @param {object} [options]
 * @param {string} [options.base]  Route prefix, for mounting elsewhere.
 * @returns {object} A TradingView Datafeed API implementation.
 */
export function createTvDatafeed({ base = '/tv' } = {}) {
    let configPromise = null;
    /** @type {Map<string, () => void>} */
    const subscriptions = new Map();

    return {
        /**
         * The library requires this callback to be asynchronous — calling it
         * inline leaves the widget half-constructed when it fires.
         */
        onReady(callback) {
            configPromise = configPromise || getJson(`${base}/config`);
            configPromise
                .then((config) => setTimeout(() => callback(config), 0))
                .catch(() => setTimeout(() => callback({
                    supported_resolutions: ['1', '5', '15', '30', '60', '1D', '1W', '1M'],
                    supports_search: true,
                    supports_time: true,
                }), 0));
        },

        async searchSymbols(userInput, exchange, symbolType, onResult) {
            const params = new URLSearchParams({ query: userInput || '', limit: '30' });
            if (exchange) params.set('exchange', exchange);
            try {
                onResult(await getJson(`${base}/search?${params}`));
            } catch {
                // The library has no error channel here; an empty list is the
                // documented way to say "nothing matched".
                onResult([]);
            }
        },

        async resolveSymbol(symbolName, onResolve, onError) {
            try {
                const params = new URLSearchParams({ symbol: symbolName });
                onResolve(await getJson(`${base}/symbols?${params}`));
            } catch (error) {
                onError(error.message);
            }
        },

        // Arguments are taken positionally rather than named: which shape they
        // arrive in depends on the library version. See datafeed-compat.js.
        async getBars(symbolInfo, resolution) {
            const { from, to, firstDataRequest, onResult, onError } = periodArgs(arguments);
            const params = new URLSearchParams({
                symbol: symbolInfo.ticker || symbolInfo.name,
                resolution: String(resolution),
                from: String(Math.floor(from)),
                to: String(Math.floor(to)),
            });

            try {
                const payload = await getJson(`${base}/history?${params}`);
                if (payload.s === 'no_data') {
                    // noData stops the library paging further into the past.
                    onResult([], { noData: true, nextTime: payload.nextTime });
                    return;
                }
                onResult(toBars(payload), { noData: false });
            } catch (error) {
                if (firstDataRequest) onError(error.message);
                // A failed backfill must not blank a chart that already drew.
                else onResult([], { noData: true });
            }
        },

        subscribeBars(symbolInfo, resolution, onTick, listenerGuid) {
            this.unsubscribeBars(listenerGuid);
            const symbol = symbolInfo.ticker || symbolInfo.name;

            // The stream opens with a short window of recent bars, and repeats
            // it on every reconnect — so the first ticks are usually *older*
            // than the history already drawn. The library treats a backwards
            // bar as corruption ("time order violation") and stops updating, so
            // the rewind is dropped here. Equal times still pass: that is the
            // forming bar being updated in place, which is the point.
            let newest = 0;
            const forward = (bar) => {
                if (bar.time < newest) return;
                newest = bar.time;
                onTick(bar);
            };

            subscriptions.set(listenerGuid, openBarStream(symbol, resolution, forward, { base }));
        },

        unsubscribeBars(listenerGuid) {
            const close = subscriptions.get(listenerGuid);
            if (!close) return;
            close();
            subscriptions.delete(listenerGuid);
        },
    };
}
