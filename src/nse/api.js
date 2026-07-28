/**
 * Client for this app's own /api/* routes, which proxy Angel One SmartAPI.
 *
 * The browser never talks to SmartAPI directly: it sends no CORS headers, and
 * the credentials must not leave the server. Everything here is same-origin.
 */

/** Thrown with the server's message so panes can show something useful. */
export class ApiError extends Error {
    constructor(message, status, { setup = false } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        // 503 means "no credentials configured"; `setup` also covers the page
        // being served by something that does not mount /api at all. Neither is
        // a fault — both are told to the user as instructions.
        this.isSetupProblem = setup || status === 503;
    }
}

async function getJson(path, { timeout = 30000 } = {}) {
    let response;
    try {
        response = await fetch(path, { signal: AbortSignal.timeout(timeout) });
    } catch (error) {
        throw new ApiError(
            error.name === 'TimeoutError'
                ? 'The server did not respond in time.'
                : `Could not reach the server: ${error.message}`,
            0,
        );
    }

    // Every /api route answers with JSON, including its errors. Anything else
    // means these routes are not mounted on this origin at all — the usual
    // cause is opening the page through a static file server such as VS Code
    // Live Server, which serves the HTML happily and 404s the API as HTML.
    if (!(response.headers.get('content-type') || '').includes('application/json')) {
        throw new ApiError(
            'This page is being served by a plain file server, not the app’s own, so there '
            + 'are no /api routes and NSE data cannot load. Usually that means VS Code Live '
            + 'Server, which this project pins to port 5501. Run “npm start” and open '
            + 'http://localhost:5500 instead.',
            response.status,
            { setup: true },
        );
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload) {
        throw new ApiError(payload?.error || `Request failed (HTTP ${response.status})`, response.status);
    }
    return payload;
}

export function health() {
    return getJson('/api/health', { timeout: 10000 });
}

/**
 * @param {string} query
 * @returns {Promise<Array<{token: string, symbol: string, name: string, exchange: string}>>}
 */
export async function search(query, { limit = 20, exchange = 'NSE' } = {}) {
    const params = new URLSearchParams({ q: query, limit: String(limit), exchange });
    // The first call warms a 33 MB instrument master on the server; allow for it.
    const payload = await getJson(`/api/search?${params}`, { timeout: 300000 });
    return payload.results || [];
}

/**
 * @param {string[]} symbols
 * @returns {Promise<Array<object>>}
 */
export async function quotes(symbols, { mode = 'FULL', exchange = 'NSE' } = {}) {
    if (symbols.length === 0) return [];
    const params = new URLSearchParams({ symbols: symbols.join(','), mode, exchange });
    const payload = await getJson(`/api/quote?${params}`);
    return payload.quotes || [];
}

/**
 * @returns {Promise<{bars: Array<{time: number, open: number, high: number, low: number, close: number, volume: number}>, symbol: string}>}
 *   `time` is epoch milliseconds.
 */
export async function candles({ symbol, interval, from, to, exchange = 'NSE' }) {
    const params = new URLSearchParams({ symbol, interval, exchange });
    if (from) params.set('from', from.toISOString());
    if (to) params.set('to', to.toISOString());
    // Wide ranges page across several upstream calls, each rate-limited.
    return getJson(`/api/candles?${params}`, { timeout: 120000 });
}
