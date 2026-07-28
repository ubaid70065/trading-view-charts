/**
 * Same-origin JSON API over Angel One SmartAPI.
 *
 * The browser talks only to these routes, so credentials stay on the server and
 * CORS never comes into it.
 *
 *   GET /api/health                      credentials present, session, cache state
 *   GET /api/search?q=reli&limit=20      NSE instrument search
 *   GET /api/quote?symbols=RELIANCE,INFY live quotes (or ?tokens=2885,1594)
 *   GET /api/candles?symbol=RELIANCE&interval=D&from=…&to=…
 */

import { hasCredentials } from './env.js';
import * as angel from './angel.js';
import * as instruments from './instruments.js';
import { handleUdf } from './udf.js';

const MAX_QUOTE_SYMBOLS = 50;

function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store',
    });
    res.end(text);
}

function fail(res, status, message, extra = {}) {
    sendJson(res, status, { error: message, ...extra });
}

/** Splits a comma list into trimmed, upper-cased, de-duplicated entries. */
function list(value) {
    return [...new Set(
        String(value || '')
            .split(',')
            .map((part) => part.trim().toUpperCase())
            .filter(Boolean),
    )];
}

function parseDate(value, fallback) {
    if (!value) return fallback;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @param {string} root
 * @returns {Promise<boolean>} True when the request was an API route.
 */
export async function handleApi(req, res, url, root) {
    // The datafeed speaks a different dialect — its own envelope and its own
    // error convention — so it gets its own module rather than more cases here.
    if (await handleUdf(req, res, url, root)) return true;

    if (!url.pathname.startsWith('/api/')) return false;

    if (req.method !== 'GET') {
        fail(res, 405, 'Only GET is supported');
        return true;
    }

    try {
        switch (url.pathname) {
            case '/api/health':
                await health(res, root);
                break;

            case '/api/search':
                await searchRoute(res, url, root);
                break;

            case '/api/quote':
                await quoteRoute(res, url, root);
                break;

            case '/api/candles':
                await candlesRoute(res, url, root);
                break;

            default:
                fail(res, 404, `No such endpoint: ${url.pathname}`);
        }
        return true;
    } catch (error) {
        // Credential and rate-limit problems are the common ones; surface the
        // vendor's message rather than a generic 500.
        console.error('[api]', url.pathname, error.message);
        fail(res, 502, error.message);
        return true;
    }
}

function credentialsMissing(res) {
    fail(res, 503,
        'Angel One credentials are not configured. Copy .env.example to .env and set '
        + 'SMARTAPI_KEY, SMARTAPI_CLIENT_CODE, SMARTAPI_PASSWORD and SMARTAPI_TOTP_SECRET.');
}

/* ------------------------------------------------------------------ handlers */

/** Reports readiness without requiring credentials — safe to poll. */
async function health(res, root) {
    sendJson(res, 200, {
        ok: true,
        credentials: hasCredentials(),
        session: angel.sessionState(),
        instruments: instruments.stats(),
        intervals: Object.keys(angel.CANDLE_INTERVALS),
    });
}

async function searchRoute(res, url, root) {
    await instruments.loadInstruments(root);
    const query = url.searchParams.get('q') || '';
    sendJson(res, 200, {
        query,
        results: instruments.search(query, {
            limit: Math.min(Number(url.searchParams.get('limit')) || 30, 100),
            // ?all=1 lifts the filter that hides bonds, state loans and T-bills.
            tradableOnly: url.searchParams.get('all') !== '1',
            exchange: url.searchParams.get('exchange') || 'NSE',
        }),
    });
}

async function quoteRoute(res, url, root) {
    if (!hasCredentials()) return credentialsMissing(res);
    await instruments.loadInstruments(root);

    const exchange = url.searchParams.get('exchange') || 'NSE';
    const mode = (url.searchParams.get('mode') || 'FULL').toUpperCase();

    const tokens = list(url.searchParams.get('tokens'));
    const unknown = [];

    // Symbols are resolved through the instrument cache; tokens pass straight on.
    if (tokens.length === 0) {
        for (const symbol of list(url.searchParams.get('symbols'))) {
            const row = instruments.resolve(symbol, exchange);
            if (row) tokens.push(row.token);
            else unknown.push(symbol);
        }
    }

    if (tokens.length === 0) {
        return fail(res, 400, 'Pass ?symbols=RELIANCE,INFY or ?tokens=2885,1594', { unknown });
    }
    if (tokens.length > MAX_QUOTE_SYMBOLS) {
        return fail(res, 400, `At most ${MAX_QUOTE_SYMBOLS} symbols per request`);
    }

    sendJson(res, 200, { quotes: await angel.getQuotes(tokens, mode, exchange), unknown });
}

async function candlesRoute(res, url, root) {
    if (!hasCredentials()) return credentialsMissing(res);
    await instruments.loadInstruments(root);

    const exchange = url.searchParams.get('exchange') || 'NSE';
    const symbol = url.searchParams.get('symbol');
    const tokenParam = url.searchParams.get('token');
    const interval = url.searchParams.get('interval') || 'D';

    const row = tokenParam ? null : instruments.resolve(symbol, exchange);
    if (!tokenParam && !row) {
        return fail(res, 404, `Unknown instrument: ${symbol || '(none)'}`);
    }

    const to = parseDate(url.searchParams.get('to'), new Date());
    const from = parseDate(url.searchParams.get('from'), new Date(to.getTime() - 180 * 86400000));
    if (from >= to) return fail(res, 400, '`from` must be before `to`');

    const bars = await angel.getCandles({
        token: tokenParam || row.token,
        interval,
        from,
        to,
        exchange,
    });

    sendJson(res, 200, {
        symbol: row ? row.symbol : undefined,
        token: tokenParam || row.token,
        exchange,
        interval,
        // The chart needs the tick size to format prices, and the kind to know
        // whether a volume pane is meaningful.
        instrument: row && {
            symbol: row.symbol,
            name: row.name,
            kind: row.kind,
            series: row.series,
            tickSize: row.tickSize,
            lotSize: row.lotSize,
        },
        bars,
    });
}
