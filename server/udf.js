/**
 * UDF (Universal Data Feed) — the datafeed protocol TradingView's charting
 * products speak, served here over *your* Angel One subscription.
 *
 *   GET /udf/config                                   capabilities
 *   GET /udf/time                                     server clock, unix seconds
 *   GET /udf/symbols?symbol=NSE:RELIANCE              one SymbolInfo
 *   GET /udf/search?query=reli&limit=30               symbol search
 *   GET /udf/history?symbol=…&resolution=…&from=…&to=…  OHLCV columns
 *
 * UDF is a published *contract*, not a hosted service — the point of
 * implementing it is that the data stays yours while any TradingView-compatible
 * chart can read it. `src/nse/datafeed.js` is the browser client for these
 * routes; the Advanced Charts library consumes the same shapes unmodified.
 *
 * Two things here differ from the Lightweight Charts pane and are easy to get
 * wrong:
 *
 *   - **Times are true UTC seconds.** `src/nse/chart.js` shifts epochs by +05:30
 *     because Lightweight Charts renders in UTC with no time-zone option. UDF
 *     must not do that: it carries a `timezone` field, and the library does the
 *     conversion itself. Shifting here would move every bar 5½ hours.
 *   - **Price scale is a fraction, not a decimal.** UDF wants
 *     `minmov / pricescale === tickSize`. NSE ticks are whole paise, so
 *     pricescale is fixed at 100 and minmov carries the tick.
 *
 * These routes are same-origin on purpose — no CORS headers. Angel One data is
 * licensed to the operator, not to whoever finds the port.
 */

import { hasCredentials } from './env.js';
import * as angel from './angel.js';
import * as instruments from './instruments.js';

/** NSE cash session in exchange-local time, as UDF spells it. */
const SESSION = '0915-1530';
const TIMEZONE = 'Asia/Kolkata';

/**
 * TradingView resolution → Angel One interval id.
 * Angel serves no weekly or monthly candles, so those are deliberately absent
 * from SUPPORTED_RESOLUTIONS rather than silently answered with daily bars.
 */
const RESOLUTIONS = {
    1: '1', 3: '3', 5: '5', 10: '10', 15: '15', 30: '30', 60: '60',
    '1D': 'D', D: 'D',
};

export const SUPPORTED_RESOLUTIONS = ['1', '3', '5', '10', '15', '30', '60', '1D'];

/** NSE ticks are whole paise, so a fixed hundredths scale is exact. */
const PRICE_SCALE = 100;

export function toAngelInterval(resolution) {
    return RESOLUTIONS[String(resolution)] || null;
}

/**
 * UDF wants minmov/pricescale to equal the tick size. Rounding keeps the
 * division exact for every band NSE publishes (₹0.01 … ₹5.00).
 */
export function priceFormat(tickSize) {
    const tick = Number(tickSize) > 0 ? Number(tickSize) : 0.01;
    return { pricescale: PRICE_SCALE, minmov: Math.max(1, Math.round(tick * PRICE_SCALE)) };
}

/** Instrument row → UDF SymbolInfo. */
export function symbolInfo(row) {
    const { pricescale, minmov } = priceFormat(row.tickSize);
    const isIndex = row.kind === 'index';
    return {
        name: row.name,
        ticker: `${row.exchange}:${row.symbol}`,
        full_name: `${row.exchange}:${row.name}`,
        description: row.name,
        type: isIndex ? 'index' : 'stock',
        exchange: row.exchange,
        listed_exchange: row.exchange,
        session: SESSION,
        timezone: TIMEZONE,
        minmov,
        pricescale,
        has_intraday: true,
        has_daily: true,
        // Angel One serves neither, and claiming otherwise makes the library
        // request bars that come back empty.
        has_weekly_and_monthly: false,
        supported_resolutions: SUPPORTED_RESOLUTIONS,
        // Indices carry no traded volume; the library hides the pane when told.
        has_no_volume: isIndex,
        volume_precision: 0,
        data_status: 'streaming',
        currency_code: 'INR',
    };
}

function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store',
    });
    res.end(text);
}

/**
 * UDF signals failure in the body with `s: "error"` and HTTP 200 — the library
 * reads the envelope, not the status code, and a 4xx surfaces as a generic
 * network error with the reason thrown away.
 */
function udfError(res, message) {
    sendJson(res, 200, { s: 'error', errmsg: message });
}

/**
 * @returns {Promise<boolean>} True when the request was a UDF route.
 */
export async function handleUdf(req, res, url, root) {
    if (!url.pathname.startsWith('/udf/')) return false;

    if (req.method !== 'GET') {
        sendJson(res, 405, { s: 'error', errmsg: 'Only GET is supported' });
        return true;
    }

    try {
        switch (url.pathname) {
            case '/udf/config':
                configRoute(res);
                break;
            case '/udf/time':
                timeRoute(res);
                break;
            case '/udf/symbols':
                await symbolsRoute(res, url, root);
                break;
            case '/udf/search':
                await searchRoute(res, url, root);
                break;
            case '/udf/history':
                await historyRoute(res, url, root);
                break;
            default:
                sendJson(res, 404, { s: 'error', errmsg: `No such endpoint: ${url.pathname}` });
        }
        return true;
    } catch (error) {
        console.error('[udf]', url.pathname, error.message);
        udfError(res, error.message);
        return true;
    }
}

/* ------------------------------------------------------------------ handlers */

function configRoute(res) {
    sendJson(res, 200, {
        supported_resolutions: SUPPORTED_RESOLUTIONS,
        supports_search: true,
        supports_group_request: false,
        supports_marks: false,
        supports_timescale_marks: false,
        supports_time: true,
        exchanges: [
            { value: '', name: 'All', desc: 'All exchanges' },
            { value: 'NSE', name: 'NSE', desc: 'National Stock Exchange of India' },
            { value: 'BSE', name: 'BSE', desc: 'Bombay Stock Exchange' },
        ],
        symbols_types: [
            { name: 'All', value: '' },
            { name: 'Stock', value: 'stock' },
            { name: 'Index', value: 'index' },
        ],
    });
}

/** Plain unix seconds, not JSON — the library parses this as text. */
function timeRoute(res) {
    const body = String(Math.floor(Date.now() / 1000));
    res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

async function symbolsRoute(res, url, root) {
    await instruments.loadInstruments(root);
    const symbol = url.searchParams.get('symbol') || '';
    const row = instruments.resolve(symbol, url.searchParams.get('exchange') || 'NSE');
    if (!row) return udfError(res, `Unknown symbol: ${symbol || '(none)'}`);
    sendJson(res, 200, symbolInfo(row));
}

async function searchRoute(res, url, root) {
    await instruments.loadInstruments(root);
    const type = url.searchParams.get('type') || '';
    const limit = Math.min(Number(url.searchParams.get('limit')) || 30, 100);

    const rows = instruments.search(url.searchParams.get('query') || '', {
        exchange: url.searchParams.get('exchange') || 'NSE',
        // Over-fetch so a type filter cannot empty an otherwise full page.
        limit: type ? limit * 4 : limit,
    });

    const results = rows
        .map((row) => ({
            symbol: row.name,
            full_name: `${row.exchange}:${row.name}`,
            description: row.symbol,
            exchange: row.exchange,
            ticker: `${row.exchange}:${row.symbol}`,
            type: row.kind === 'index' ? 'index' : 'stock',
        }))
        .filter((item) => !type || item.type === type)
        .slice(0, limit);

    sendJson(res, 200, results);
}

async function historyRoute(res, url, root) {
    const exchange = url.searchParams.get('exchange') || 'NSE';
    const symbol = url.searchParams.get('symbol') || '';
    const resolution = url.searchParams.get('resolution') || '1D';

    // The request is validated before anything expensive or stateful happens.
    // Checking credentials first would answer a resolution typo with "no
    // credentials", pointing whoever is debugging at the wrong problem — and
    // would page in the 33 MB instrument master for a request that cannot work.
    const interval = toAngelInterval(resolution);
    if (!interval) {
        return udfError(res, `Unsupported resolution "${resolution}". `
            + `Angel One serves: ${SUPPORTED_RESOLUTIONS.join(', ')}.`);
    }

    // UDF sends unix seconds.
    const toSec = Number(url.searchParams.get('to'));
    const fromSec = Number(url.searchParams.get('from'));
    if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || fromSec >= toSec) {
        return udfError(res, '`from` and `to` must be unix seconds with from < to');
    }

    if (!hasCredentials()) {
        return udfError(res, 'Angel One credentials are not configured on the server.');
    }

    await instruments.loadInstruments(root);
    const row = instruments.resolve(symbol, exchange);
    if (!row) return udfError(res, `Unknown symbol: ${symbol || '(none)'}`);

    const bars = await angel.getCandles({
        token: row.token,
        interval,
        from: new Date(fromSec * 1000),
        to: new Date(toSec * 1000),
        exchange,
    });

    if (bars.length === 0) {
        // `no_data` is not an error: it tells the library to stop paging left
        // rather than retry the same empty window forever.
        return sendJson(res, 200, { s: 'no_data' });
    }

    sendJson(res, 200, columns(bars, row.kind === 'index'));
}

/**
 * Row-per-bar → the column arrays UDF transports.
 * Times are whole UTC seconds; see the file header on why they are not shifted.
 */
export function columns(bars, omitVolume = false) {
    const out = { s: 'ok', t: [], o: [], h: [], l: [], c: [] };
    if (!omitVolume) out.v = [];
    for (const bar of bars) {
        out.t.push(Math.floor(bar.time / 1000));
        out.o.push(bar.open);
        out.h.push(bar.high);
        out.l.push(bar.low);
        out.c.push(bar.close);
        if (!omitVolume) out.v.push(bar.volume);
    }
    return out;
}
