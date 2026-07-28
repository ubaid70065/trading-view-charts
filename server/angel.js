/**
 * Angel One SmartAPI client: session handling and market data.
 *
 * Why this lives on the server and not in the page:
 *   - SmartAPI does not send CORS headers, so a browser request is blocked.
 *   - Login needs the client code, PIN and TOTP secret. Shipping those to the
 *     browser would hand out the trading account.
 *   - The session JWT must be reused, not minted per request.
 *
 * Endpoint shapes follow SmartAPI's published contract. Responses are normalised
 * here so route handlers and the front end never see vendor field names.
 */

import { optional, required } from './env.js';
import { secondsRemaining, totp } from './totp.js';

const BASE_URL = optional('SMARTAPI_BASE_URL', 'https://apiconnect.angelone.in');

/** SmartAPI requires these client headers; the values are not verified. */
function baseHeaders() {
    return {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': optional('SMARTAPI_LOCAL_IP', '127.0.0.1'),
        'X-ClientPublicIP': optional('SMARTAPI_PUBLIC_IP', '127.0.0.1'),
        'X-MACAddress': optional('SMARTAPI_MAC', '00:00:00:00:00:00'),
        'X-PrivateKey': required('SMARTAPI_KEY'),
    };
}

/** Interval names accepted by the historical endpoint, keyed by our own ids. */
export const CANDLE_INTERVALS = {
    '1': 'ONE_MINUTE',
    '3': 'THREE_MINUTE',
    '5': 'FIVE_MINUTE',
    '10': 'TEN_MINUTE',
    '15': 'FIFTEEN_MINUTE',
    '30': 'THIRTY_MINUTE',
    '60': 'ONE_HOUR',
    D: 'ONE_DAY',
};

/** Largest span the historical endpoint will return per call, in days. */
const MAX_DAYS_PER_CALL = {
    ONE_MINUTE: 30,
    THREE_MINUTE: 60,
    FIVE_MINUTE: 100,
    TEN_MINUTE: 100,
    FIFTEEN_MINUTE: 200,
    THIRTY_MINUTE: 200,
    ONE_HOUR: 400,
    ONE_DAY: 2000,
};

/* ------------------------------------------------------------------ session */

let session = null;      // { jwt, refreshToken, feedToken, createdAt }
let loginInFlight = null;

/**
 * Logs in and caches the JWT. Concurrent callers share one login, so a burst of
 * requests on a cold server does not fire several logins (and trip rate limits).
 */
async function login() {
    if (loginInFlight) return loginInFlight;

    loginInFlight = (async () => {
        const secret = required('SMARTAPI_TOTP_SECRET');

        // A code about to expire will be rejected by the time it lands; wait it out.
        if (secondsRemaining() < 2) {
            await new Promise((resolve) => setTimeout(resolve, 2200));
        }

        const response = await fetch(`${BASE_URL}/rest/auth/angelbroking/user/v1/loginByPassword`, {
            method: 'POST',
            headers: baseHeaders(),
            body: JSON.stringify({
                clientcode: required('SMARTAPI_CLIENT_CODE'),
                password: required('SMARTAPI_PASSWORD'),
                totp: totp(secret),
            }),
            signal: AbortSignal.timeout(20000),
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload || payload.status !== true || !payload.data?.jwtToken) {
            const detail = payload?.message || payload?.errorcode || `HTTP ${response.status}`;
            throw new Error(`SmartAPI login failed: ${detail}`);
        }

        session = {
            jwt: payload.data.jwtToken,
            refreshToken: payload.data.refreshToken,
            feedToken: payload.data.feedToken,
            createdAt: Date.now(),
        };
        return session;
    })();

    try {
        return await loginInFlight;
    } finally {
        loginInFlight = null;
    }
}

async function getSession() {
    if (session) return session;
    return login();
}

export function sessionState() {
    return session
        ? { authenticated: true, since: new Date(session.createdAt).toISOString() }
        : { authenticated: false };
}

/** Drops the cached session so the next call logs in again. */
export function clearSession() {
    session = null;
}

/* ------------------------------------------------------------ request plumbing */

/**
 * Calls an authenticated endpoint, logging in once more if the token was
 * rejected — SmartAPI tokens expire daily, so a long-running server will hit it.
 */
async function authedPost(path, body, { retryOnAuthFailure = true } = {}) {
    const current = await getSession();

    const response = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: { ...baseHeaders(), Authorization: `Bearer ${current.jwt}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25000),
    });

    const payload = await response.json().catch(() => null);

    const tokenRejected = response.status === 401
        || payload?.errorcode === 'AG8001'   // invalid token
        || payload?.errorcode === 'AG8002';  // token expired
    if (tokenRejected && retryOnAuthFailure) {
        clearSession();
        return authedPost(path, body, { retryOnAuthFailure: false });
    }

    if (!response.ok || !payload || payload.status !== true) {
        const detail = payload?.message || payload?.errorcode || `HTTP ${response.status}`;
        throw new Error(`SmartAPI ${path} failed: ${detail}`);
    }

    return payload.data;
}

/* ------------------------------------------------------------------ throttle */

/**
 * SmartAPI publishes per-second limits and answers 403 "exceeding access rate"
 * when crossed. Calls are serialised with a minimum gap rather than fired in
 * parallel, because a rate-limit rejection costs more than the wait.
 */
function createThrottle(minIntervalMs) {
    let last = 0;
    let chain = Promise.resolve();

    return (task) => {
        chain = chain.then(async () => {
            const wait = last + minIntervalMs - Date.now();
            if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
            last = Date.now();
            return task();
        });
        return chain;
    };
}

const throttleQuote = createThrottle(120);      // well inside the quote limit
const throttleHistory = createThrottle(350);    // historical is the strictest

/* -------------------------------------------------------------------- quotes */

/**
 * Live quotes for up to 50 tokens in one call.
 *
 * @param {string[]} tokens  Instrument tokens, e.g. ['2885', '1594'].
 * @param {'FULL'|'OHLC'|'LTP'} mode
 * @param {string} exchange
 * @returns {Promise<Array<object>>} Normalised quotes.
 */
export async function getQuotes(tokens, mode = 'FULL', exchange = 'NSE') {
    if (tokens.length === 0) return [];
    if (tokens.length > 50) throw new Error('SmartAPI accepts at most 50 tokens per quote call');

    const data = await throttleQuote(() => authedPost(
        '/rest/secure/angelbroking/market/v1/quote/',
        { mode, exchangeTokens: { [exchange]: tokens.map(String) } },
    ));

    const fetched = Array.isArray(data?.fetched) ? data.fetched : [];
    return fetched.map((row) => ({
        token: String(row.symbolToken ?? row.symboltoken ?? ''),
        symbol: row.tradingSymbol ?? row.tradingsymbol ?? '',
        exchange: row.exchange ?? exchange,
        last: num(row.ltp),
        open: num(row.open),
        high: num(row.high),
        low: num(row.low),
        close: num(row.close),
        change: num(row.netChange ?? row.netchange),
        changePercent: num(row.percentChange ?? row.percentchange),
        volume: num(row.tradeVolume ?? row.tradevolume),
        // Present only in FULL mode.
        upperCircuit: num(row.upperCircuit),
        lowerCircuit: num(row.lowerCircuit),
        yearHigh: num(row['52WeekHigh'] ?? row.weekHigh52),
        yearLow: num(row['52WeekLow'] ?? row.weekLow52),
        updatedAt: row.exchFeedTime ?? row.exchTradeTime ?? null,
    }));
}

function num(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/* ---------------------------------------------------------------- historical */

/** SmartAPI expects local exchange time as 'YYYY-MM-DD HH:mm' (IST). */
function formatIst(date) {
    const ist = new Date(date.getTime() + (5 * 60 + 30) * 60000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`
        + ` ${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}`;
}

/**
 * Historical candles, paged around the per-call span limit.
 *
 * @param {object} params
 * @param {string} params.token
 * @param {string} params.interval  Key of CANDLE_INTERVALS.
 * @param {Date} params.from
 * @param {Date} params.to
 * @param {string} [params.exchange]
 * @returns {Promise<Array<{time: number, open: number, high: number, low: number, close: number, volume: number}>>}
 *   `time` is epoch milliseconds.
 */
export async function getCandles({ token, interval, from, to, exchange = 'NSE' }) {
    const vendorInterval = CANDLE_INTERVALS[interval];
    if (!vendorInterval) {
        throw new Error(`Unsupported interval "${interval}". Use one of: ${Object.keys(CANDLE_INTERVALS).join(', ')}`);
    }

    const spanMs = MAX_DAYS_PER_CALL[vendorInterval] * 86400000;
    const bars = [];
    let cursor = new Date(from);
    let calls = 0;

    while (cursor < to && calls < 20) {
        const windowEnd = new Date(Math.min(cursor.getTime() + spanMs, to.getTime()));
        calls += 1;

        const data = await throttleHistory(() => authedPost(
            '/rest/secure/angelbroking/historical/v1/getCandleData',
            {
                exchange,
                symboltoken: String(token),
                interval: vendorInterval,
                fromdate: formatIst(cursor),
                todate: formatIst(windowEnd),
            },
        ));

        // Rows are [timestamp, open, high, low, close, volume].
        for (const row of Array.isArray(data) ? data : []) {
            bars.push({
                time: new Date(row[0]).getTime(),
                open: Number(row[1]),
                high: Number(row[2]),
                low: Number(row[3]),
                close: Number(row[4]),
                volume: Number(row[5]),
            });
        }

        if (windowEnd.getTime() >= to.getTime()) break;
        cursor = new Date(windowEnd.getTime() + 60000);
    }

    // Page boundaries can repeat a bar; keep ascending and unique.
    const seen = new Set();
    return bars
        .filter((bar) => {
            if (!Number.isFinite(bar.time) || seen.has(bar.time)) return false;
            seen.add(bar.time);
            return true;
        })
        .sort((a, b) => a.time - b.time);
}

/** Verifies credentials end to end without touching market data. */
export async function getProfile() {
    const current = await getSession();
    const response = await fetch(`${BASE_URL}/rest/secure/angelbroking/user/v1/getProfile`, {
        method: 'GET',
        headers: { ...baseHeaders(), Authorization: `Bearer ${current.jwt}` },
        signal: AbortSignal.timeout(20000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.status !== true) {
        const detail = payload?.message || payload?.errorcode || `HTTP ${response.status}`;
        throw new Error(`SmartAPI profile failed: ${detail}`);
    }
    return { clientCode: payload.data?.clientcode, name: payload.data?.name };
}
