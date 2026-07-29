/**
 * TradingView Datafeed API over this app's own `/udf/*` routes.
 *
 * This is the object TradingView's charting products ask for — `onReady`,
 * `resolveSymbol`, `getBars`, `subscribeBars` — implemented against the Angel
 * One feed. Hand it to a Charting Library / Advanced Charts widget as
 * `datafeed:` and NSE bars arrive with indicators and drawing tools on top,
 * which the free embed cannot do and Lightweight Charts has no concept of.
 *
 *   const datafeed = createDatafeed();
 *   new TradingView.widget({ symbol: 'NSE:RELIANCE', datafeed, ... });
 *
 * The library itself is not vendored here: unlike Lightweight Charts (Apache-2.0,
 * in `vendor/`), Advanced Charts is licensed per-user and cannot be redistributed,
 * so it is fetched by whoever has been granted access. Everything on this side of
 * the contract is finished and testable without it — `test/udf.test.mjs` drives
 * these functions directly.
 *
 * Time units are not uniform across this API, and mixing them up is the classic
 * way to get bars stacked on 1970:
 *
 *   getBars       periodParams.from / .to   unix **seconds**
 *   getBars       returned bar.time         unix **milliseconds**
 *   subscribeBars onTick bar.time           unix **milliseconds**
 *
 * All of them are true UTC. Unlike `chart.js`, nothing is shifted by +05:30 —
 * SymbolInfo carries `timezone: 'Asia/Kolkata'` and the library localises.
 */

import { periodArgs } from '../datafeed-compat.js';
import { ApiError, quotes as fetchQuotes } from './api.js';

/** Matches the server's SUPPORTED_RESOLUTIONS; Angel serves no W or M. */
const RESOLUTION_MS = {
    1: 60000, 3: 180000, 5: 300000, 10: 600000, 15: 900000, 30: 1800000, 60: 3600000,
};

const DAY_MS = 86400000;
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** How often the forming candle is refreshed from live quotes. */
const POLL_MS = 5000;

async function getJson(path) {
    const response = await fetch(path);
    if (!(response.headers.get('content-type') || '').includes('application/json')) {
        throw new ApiError(
            'The /udf routes are not mounted on this origin. Run “npm start” and open '
            + 'http://localhost:5500 rather than a plain file server.',
            response.status,
            { setup: true },
        );
    }
    const payload = await response.json();
    // UDF reports failure inside a 200 body, so the status code proves nothing.
    if (payload && payload.s === 'error') throw new ApiError(payload.errmsg, response.status);
    return payload;
}

/**
 * Start of the bar containing `epochMs`, in milliseconds.
 *
 * Intraday buckets divide evenly from the epoch. Daily cannot: the boundary is
 * the IST trading date, so the epoch is shifted into IST, floored, and shifted
 * back — flooring UTC directly would roll the day over at 05:30 IST, splitting
 * every session in two.
 */
export function barStart(epochMs, resolution) {
    const span = RESOLUTION_MS[String(resolution)];
    if (span) return Math.floor(epochMs / span) * span;
    return Math.floor((epochMs + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}

/**
 * Folds a live price into the bar being formed.
 *
 * A price inside the current bucket extends it; a price past the bucket opens
 * the next one at that price. Returns null when the quote is older than the bar
 * on screen, so a stale poll cannot rewrite history.
 *
 * @param {object|null} last  The newest known bar, or null.
 * @param {number} price
 * @param {number} atMs       When the price was observed.
 * @param {string} resolution
 */
export function foldQuote(last, price, atMs, resolution) {
    if (!Number.isFinite(price)) return null;
    const bucket = barStart(atMs, resolution);

    if (!last || bucket > last.time) {
        return { time: bucket, open: price, high: price, low: price, close: price, volume: 0 };
    }
    if (bucket < last.time) return null;

    return {
        ...last,
        high: Math.max(last.high, price),
        low: Math.min(last.low, price),
        close: price,
    };
}

/** Column arrays from /udf/history → the bar objects the library expects. */
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
 * @param {object} [options]
 * @param {string} [options.base]      Route prefix, for mounting elsewhere.
 * @param {number} [options.pollMs]    Live refresh cadence.
 * @returns {object} A TradingView Datafeed API implementation.
 */
export function createDatafeed({ base = '/udf', pollMs = POLL_MS } = {}) {
    let configPromise = null;
    /** @type {Map<string, {timer: number, last: object|null}>} */
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
                    supported_resolutions: Object.keys(RESOLUTION_MS).concat('1D'),
                    supports_search: true,
                    supports_time: true,
                }), 0));
        },

        async searchSymbols(userInput, exchange, symbolType, onResult) {
            const params = new URLSearchParams({ query: userInput || '', limit: '30' });
            if (exchange) params.set('exchange', exchange);
            if (symbolType) params.set('type', symbolType);
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

            const entry = { timer: 0, last: null };
            entry.timer = setInterval(async () => {
                if (document.hidden) return;
                try {
                    const [quote] = await fetchQuotes([symbolInfo.name], { mode: 'OHLC' });
                    if (!quote || quote.last === null) return;
                    const next = foldQuote(entry.last, quote.last, Date.now(), resolution);
                    if (!next) return;
                    entry.last = next;
                    onTick(next);
                } catch {
                    // One dropped poll is not worth tearing the chart down for.
                }
            }, pollMs);

            subscriptions.set(listenerGuid, entry);
        },

        unsubscribeBars(listenerGuid) {
            const entry = subscriptions.get(listenerGuid);
            if (!entry) return;
            clearInterval(entry.timer);
            subscriptions.delete(listenerGuid);
        },
    };
}
