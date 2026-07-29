/**
 * UDF-shaped routes over the TradingView widget feed.
 *
 *   GET /tv/config                                        capabilities
 *   GET /tv/search?query=reli&limit=30                    symbol search
 *   GET /tv/symbols?symbol=NSE:RELIANCE                   one SymbolInfo
 *   GET /tv/history?symbol=…&resolution=5&from=…&to=…     OHLCV columns
 *   GET /tv/stream?symbol=…&resolution=5                  live bars (SSE)
 *
 * The same envelope `server/udf.js` serves, so one browser-side datafeed can
 * read either. What differs is the source: these come from TradingView's own
 * socket rather than an Angel One subscription, which buys every exchange
 * TradingView carries and costs the caveats in `server/tvfeed.js`.
 *
 * Live updates are Server-Sent Events, not a WebSocket. The upstream is already
 * a socket, but this side only ever pushes — the browser never sends — and SSE
 * needs no upgrade handshake, no framing, and no second server. It also
 * reconnects on its own, which matters more here than latency.
 *
 * Same-origin, no CORS headers: the notes in `server/tvfeed.js` about who this
 * data belongs to apply to whoever can reach the port.
 */

import https from 'node:https';

import { getFeed, toTvResolution } from './tvfeed.js';

const SEARCH_HOST = 'symbol-search.tradingview.com';
const SEARCH_ORIGIN = 'https://www.tradingview.com';

export const SUPPORTED_RESOLUTIONS = ['1', '3', '5', '10', '15', '30', '60', '120', '240', '1D', '1W', '1M'];

/** SSE comment sent periodically so proxies do not reap an idle stream. */
const KEEPALIVE_MS = 25000;

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
 * UDF reports failure in a 200 body — `s: 'error'` — because the charting
 * library reads the envelope, not the status line.
 */
function udfError(res, message) {
    sendJson(res, 200, { s: 'error', errmsg: message });
}

function getText(url, { timeout = 15000 } = {}) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, {
            headers: {
                Origin: SEARCH_ORIGIN,
                Referer: `${SEARCH_ORIGIN}/`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                    + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
                Accept: 'application/json',
            },
            timeout,
        }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                if (response.statusCode !== 200) {
                    reject(new Error(`Symbol search failed (HTTP ${response.statusCode})`));
                    return;
                }
                resolve(body);
            });
        });
        request.on('timeout', () => request.destroy(new Error('Symbol search timed out')));
        request.on('error', reject);
    });
}

/** Search results arrive with the matched span wrapped in <em>. */
const stripTags = (value) => String(value || '').replace(/<\/?[^>]+>/g, '');

/**
 * TradingView's `symbol_resolved` payload → a UDF SymbolInfo.
 *
 * Most fields carry across unchanged; the ones below are the ones that do not,
 * and getting them wrong is quiet rather than loud — the chart still draws.
 */
export function toSymbolInfo(resolved, requested) {
    const exchange = resolved.exchange || resolved.listed_exchange || '';
    const ticker = resolved.pro_name || (exchange ? `${exchange}:${resolved.name}` : resolved.name) || requested;

    return {
        name: resolved.name || requested,
        // What getBars is handed back; must round-trip to the same symbol.
        ticker,
        full_name: ticker,
        description: resolved.description || resolved.short_description || ticker,
        type: resolved.type || 'stock',
        // Bars carry true UTC, so the library needs the exchange's zone to
        // place them on the right trading day.
        timezone: resolved.timezone || 'Etc/UTC',
        exchange,
        listed_exchange: resolved.listed_exchange || exchange,
        session: resolved.session || '24x7',
        // minmov/pricescale is the tick size; TradingView already states both.
        minmov: resolved.minmov || 1,
        pricescale: resolved.pricescale || 100,
        minmove2: resolved.minmove2 || 0,
        fractional: Boolean(resolved.fractional),
        has_intraday: resolved.has_intraday !== false,
        has_daily: true,
        has_weekly_and_monthly: true,
        // Only advertise what this server can actually map to a series.
        supported_resolutions: SUPPORTED_RESOLUTIONS,
        volume_precision: resolved.volume_precision ?? 0,
        currency_code: resolved.currency_code || undefined,
        data_status: resolved.update_mode === 'delayed_streaming' ? 'delayed_streaming' : 'streaming',
    };
}

/** Bars → the parallel-array form UDF history returns. */
export function toUdfHistory(bars) {
    if (bars.length === 0) return { s: 'no_data' };
    return {
        s: 'ok',
        t: bars.map((bar) => bar.time),
        o: bars.map((bar) => bar.open),
        h: bars.map((bar) => bar.high),
        l: bars.map((bar) => bar.low),
        c: bars.map((bar) => bar.close),
        v: bars.map((bar) => bar.volume),
    };
}

/* ------------------------------------------------------------------ handler */

/**
 * @returns {Promise<boolean>} True when the request was a /tv route.
 */
export async function handleTv(req, res, url) {
    if (!url.pathname.startsWith('/tv/')) return false;

    if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'Only GET is supported' });
        return true;
    }

    try {
        switch (url.pathname) {
            case '/tv/config':
                configRoute(res);
                break;
            case '/tv/search':
                await searchRoute(res, url);
                break;
            case '/tv/symbols':
                await symbolsRoute(res, url);
                break;
            case '/tv/history':
                await historyRoute(res, url);
                break;
            case '/tv/stream':
                streamRoute(req, res, url);
                break;
            default:
                sendJson(res, 404, { error: `No such endpoint: ${url.pathname}` });
        }
    } catch (error) {
        console.error('[tv]', url.pathname, error.message);
        udfError(res, error.message);
    }
    return true;
}

function configRoute(res) {
    sendJson(res, 200, {
        supported_resolutions: SUPPORTED_RESOLUTIONS,
        supports_search: true,
        supports_group_request: false,
        supports_marks: false,
        supports_timescale_marks: false,
        supports_time: true,
        exchanges: [],
        symbols_types: [],
    });
}

async function searchRoute(res, url) {
    const query = url.searchParams.get('query') || url.searchParams.get('q') || '';
    const limit = Math.min(Number(url.searchParams.get('limit')) || 30, 50);
    const exchange = url.searchParams.get('exchange') || '';

    const target = new URL(`https://${SEARCH_HOST}/symbol_search/v3/`);
    target.searchParams.set('text', query);
    target.searchParams.set('hl', '1');
    target.searchParams.set('lang', 'en');
    target.searchParams.set('domain', 'production');
    if (exchange) target.searchParams.set('exchange', exchange);

    const payload = JSON.parse(await getText(target.href));
    const symbols = (payload.symbols || []).slice(0, limit).map((item) => {
        const symbol = stripTags(item.symbol);
        const source = item.source_id || item.exchange || '';
        return {
            symbol,
            full_name: source ? `${source}:${symbol}` : symbol,
            ticker: source ? `${source}:${symbol}` : symbol,
            description: stripTags(item.description),
            exchange: source,
            type: item.type || 'stock',
        };
    });

    sendJson(res, 200, symbols);
}

async function symbolsRoute(res, url) {
    const symbol = url.searchParams.get('symbol');
    if (!symbol) return udfError(res, 'Pass ?symbol=EXCHANGE:TICKER');

    const resolved = await getFeed().resolve(symbol);
    if (!resolved || !resolved.name) return udfError(res, `Unknown symbol: ${symbol}`);

    sendJson(res, 200, toSymbolInfo(resolved, symbol));
}

async function historyRoute(res, url) {
    const symbol = url.searchParams.get('symbol');
    const resolution = url.searchParams.get('resolution') || '1D';
    const from = Number(url.searchParams.get('from'));
    const to = Number(url.searchParams.get('to'));

    if (!symbol) return udfError(res, 'Pass ?symbol=EXCHANGE:TICKER');
    if (!toTvResolution(resolution)) return udfError(res, `Unsupported resolution: ${resolution}`);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return udfError(res, '`from` and `to` are unix seconds');

    const bars = await getFeed().history(symbol, resolution, { from, to });
    const payload = toUdfHistory(bars);

    // `nextTime` tells the library where data resumes, so it stops paging into
    // an empty past. Without it a chart with no history retries indefinitely.
    if (payload.s === 'no_data') payload.nextTime = undefined;

    sendJson(res, 200, payload);
}

function streamRoute(req, res, url) {
    const symbol = url.searchParams.get('symbol');
    const resolution = url.searchParams.get('resolution') || '1D';

    if (!symbol || !toTvResolution(resolution)) {
        sendJson(res, 400, { error: 'Pass ?symbol=EXCHANGE:TICKER&resolution=5' });
        return;
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Node's compression is off for this route anyway, but proxies buffer
        // event streams unless told not to.
        'X-Accel-Buffering': 'no',
    });
    res.write(': open\n\n');

    const feed = getFeed();
    const send = (event, data) => {
        if (res.writableEnded) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let unsubscribeBars = () => {};
    let unsubscribeQuote = () => {};
    try {
        unsubscribeBars = feed.subscribeBars(symbol, resolution, (bar) => send('bar', bar));
        unsubscribeQuote = feed.subscribeQuote(symbol, (values) => {
            if (values.lp === undefined) return;
            send('quote', { last: values.lp, change: values.ch, changePercent: values.chp, volume: values.volume });
        });
    } catch (error) {
        send('fail', { message: error.message });
        res.end();
        return;
    }

    const keepalive = setInterval(() => {
        if (!res.writableEnded) res.write(': keepalive\n\n');
    }, KEEPALIVE_MS);

    const stop = () => {
        clearInterval(keepalive);
        unsubscribeBars();
        unsubscribeQuote();
        if (!res.writableEnded) res.end();
    };

    // Both fire in practice; stop() is idempotent enough to take either.
    req.on('close', stop);
    req.on('error', stop);
}
