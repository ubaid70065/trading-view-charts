/**
 * Client for TradingView's widget data socket (`widgetdata.tradingview.com`).
 *
 * This speaks the same protocol the free embeddable widgets use. Each widget on
 * a page loads a hidden iframe from `tradingview-widget.com` whose only job is
 * to hold one socket and fan messages back out; this module is the Node
 * equivalent, so charts in *this* app can read the same feed without an iframe
 * in the way.
 *
 * ── Standing on ── the protocol is undocumented and unversioned. It is
 * reconstructed from the widget bundle, and TradingView owes it no stability:
 * a message rename ships whenever they deploy, and nothing announces it. Treat
 * a sudden empty chart as "they changed something", not as a bug in the caller.
 * Their terms cover the widgets as embedded, not a private client, and the
 * underlying exchange data is licensed to them — so this is for local use, not
 * something to redistribute or put behind a public URL. `server/udf.js` is the
 * licensed path for NSE and stays the better source where it has the symbol.
 *
 * ── The wire format ── messages are length-prefixed inside one WebSocket
 * frame, and several arrive together:
 *
 *     ~m~<length>~m~<payload>~m~<length>~m~<payload>…
 *
 * The length counts JavaScript string units, not bytes — the sender writes
 * `String.length` — so the payload is sliced by index after decoding UTF-8.
 *
 * A payload is either JSON (`{"m": "<method>", "p": [<args>]}`), a heartbeat
 * (`~h~<n>`, echoed back verbatim or the server hangs up), or — for the very
 * first message only — the session descriptor.
 *
 * ── Sessions ── one socket carries many. A *quote* session streams last-price
 * updates for a symbol set; a *chart* session resolves a symbol and serves bars
 * for one resolution. History opens a chart session, drains it and closes it;
 * a live subscription keeps one open and forwards `du` updates.
 */

import { WebSocketClient } from './ws.js';

const WS_HOST = 'widgetdata.tradingview.com';

/** The upgrade is refused outright unless Origin matches a known widget host. */
const ORIGIN = 'https://www.tradingview-widget.com';

/** Guests get this literal string; there is no token to obtain. */
const GUEST_TOKEN = 'unauthorized_user_token';

/** Quote fields worth asking for. Requesting fewer means smaller updates. */
const QUOTE_FIELDS = [
    'lp', 'ch', 'chp', 'volume', 'bid', 'ask', 'description', 'short_name',
    'exchange', 'type', 'pricescale', 'minmov', 'fractional', 'minmove2',
    'currency_code', 'original_name', 'timezone', 'session_display',
];

/** How long a single request may wait before it is abandoned. */
const REQUEST_TIMEOUT_MS = 20000;

/** Never ask for more than this many bars in one series. */
const MAX_BARS = 5000;

/** Reconnect backoff, milliseconds; the last value repeats. */
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

/**
 * Fresh DNS per try, so this is how many edge nodes one request will sample.
 *
 * A reachable node completes in well under a second, and an unreachable one
 * costs the whole connect timeout — so the budget below is spent almost
 * entirely on networks that cannot see most of the pool, and barely at all on
 * ones that can. Sampling more nodes is what gets those networks connected.
 */
const CONNECT_ATTEMPTS = 5;

/** Generous against a measured ~300 ms, tight enough to abandon a dead node. */
const CONNECT_TIMEOUT_MS = 5000;

/** App resolution → the spelling `create_series` expects. */
const RESOLUTIONS = {
    1: '1', 3: '3', 5: '5', 10: '10', 15: '15', 30: '30', 60: '60',
    120: '120', 240: '240', D: '1D', '1D': '1D', W: '1W', '1W': '1W', M: '1M', '1M': '1M',
};

/** Seconds per bar, for turning a time window into a bar count. */
const RESOLUTION_SECONDS = {
    1: 60, 3: 180, 5: 300, 10: 600, 15: 900, 30: 1800, 60: 3600,
    120: 7200, 240: 14400, '1D': 86400, '1W': 604800, '1M': 2592000,
};

export function toTvResolution(resolution) {
    return RESOLUTIONS[String(resolution)] || null;
}

/* ------------------------------------------------------------------ framing */

/** Wraps one payload in the `~m~<length>~m~` envelope. */
export function encodeFrame(payload) {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return `~m~${text.length}~m~${text}`;
}

/** Builds a `{m, p}` call, already framed. */
export function encodeMessage(method, params) {
    return encodeFrame({ m: method, p: params });
}

/**
 * Splits a socket message into payloads.
 *
 * Returns the leftover too: a frame can be cut in half by the transport, and
 * dropping the tail loses a bar. Callers keep `rest` and prepend it next time.
 *
 * @param {string} input
 * @returns {{payloads: string[], rest: string}}
 */
export function decodeFrames(input) {
    const payloads = [];
    let rest = input;

    for (;;) {
        if (!rest.startsWith('~m~')) break;

        const close = rest.indexOf('~m~', 3);
        if (close === -1) break;

        const length = Number(rest.slice(3, close));
        if (!Number.isInteger(length) || length < 0) {
            // Unparseable header: the stream is desynchronised and no amount of
            // buffering recovers it. Drop what we have rather than spin.
            return { payloads, rest: '' };
        }

        const start = close + 3;
        if (rest.length < start + length) break;

        payloads.push(rest.slice(start, start + length));
        rest = rest.slice(start + length);
    }

    return { payloads, rest };
}

const randomId = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 14)}`;

/* --------------------------------------------------------------- connection */

class TradingViewFeed {
    constructor() {
        this._socket = null;
        this._buffer = '';
        this._ready = null;
        this._attempt = 0;
        this._closedByUs = false;
        /** Pool member that last completed a handshake; preferred on reconnect. */
        this._lastGoodAddress = null;

        /** Chart sessions awaiting bars: id → {resolve, reject, bars, timer}. */
        this._charts = new Map();
        /** Live subscriptions: id → {symbol, resolution, onBar, chartId}. */
        this._subs = new Map();
        /** Symbol resolution promises, keyed by chart session. */
        this._resolves = new Map();

        this._quoteSession = null;
        /** Symbol → Set of quote listeners. */
        this._quoteListeners = new Map();
    }

    /**
     * Resolves once the socket is up and authenticated. Shared by all callers.
     *
     * `widgetdata.tradingview.com` is a large rotating pool, and how much of it
     * is reachable depends on where you are: from some networks most addresses
     * accept the TCP connection and then never answer, while one or two work
     * perfectly. So two things happen here — each attempt re-resolves the name
     * to sample a different node, and the address that last completed a
     * handshake is tried first, because a pool member that worked a minute ago
     * is a far better bet than whatever DNS offers next.
     */
    async connect() {
        let lastError;
        for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
            // First try only: the remembered node. After that, fresh DNS.
            const address = attempt === 0 ? this._lastGoodAddress : undefined;
            try {
                return await this._openSocket(address);
            } catch (error) {
                lastError = error;
                // It stopped answering; stop preferring it.
                if (address) this._lastGoodAddress = null;
            }
        }
        throw new Error(`Could not reach the TradingView feed: ${lastError.message}`);
    }

    _openSocket(address) {
        if (this._ready) return this._ready;

        this._ready = new Promise((resolve, reject) => {
            const url = new URL(`wss://${WS_HOST}/socket.io/websocket`);
            url.searchParams.set('from', 'widgetembed/');
            url.searchParams.set('date', new Date().toISOString().slice(0, 10).replace(/-/g, '_'));
            url.searchParams.set('type', 'chart');

            const socket = new WebSocketClient(url.href, {
                origin: ORIGIN,
                address,
                connectTimeout: CONNECT_TIMEOUT_MS,
            });
            this._socket = socket;
            this._buffer = '';

            let settled = false;

            socket.on('message', (text) => {
                this._buffer += text;
                const { payloads, rest } = decodeFrames(this._buffer);
                this._buffer = rest;

                for (const payload of payloads) {
                    // The session descriptor arrives once, before anything else.
                    if (!settled) {
                        settled = true;
                        this._attempt = 0;
                        // Proven good: a full handshake plus a session.
                        this._lastGoodAddress = socket.remoteAddress;
                        this._onSessionStart();
                        resolve();
                        continue;
                    }
                    this._onPayload(payload);
                }
            });

            socket.on('error', (error) => {
                if (!settled) {
                    settled = true;
                    reject(error);
                }
            });

            socket.on('close', () => {
                this._onClose();
                if (!settled) {
                    settled = true;
                    reject(new Error('The TradingView feed closed before it was ready.'));
                }
            });

            socket.connect();
        }).catch((error) => {
            // A failed attempt must not be cached, or every later call inherits it.
            this._ready = null;
            throw error;
        });

        return this._ready;
    }

    _send(method, params) {
        this._socket?.send(encodeMessage(method, params));
    }

    _onSessionStart() {
        this._send('set_auth_token', [GUEST_TOKEN]);

        // One quote session per connection, recreated on reconnect.
        this._quoteSession = randomId('qs');
        this._send('quote_create_session', [this._quoteSession]);
        this._send('quote_set_fields', [this._quoteSession, ...QUOTE_FIELDS]);

        for (const symbol of this._quoteListeners.keys()) {
            this._send('quote_add_symbols', [this._quoteSession, symbol]);
        }
        // Live bar subscriptions lost their chart sessions with the socket.
        for (const [id, sub] of this._subs) this._openSubscription(id, sub);
    }

    _onClose() {
        this._socket = null;
        this._ready = null;

        // Anything still waiting will never be answered on this socket. Both
        // maps are failed now rather than left to time out — the answer is
        // already known, and the caller can retry twenty seconds sooner.
        const disconnected = () => new Error('The TradingView feed disconnected mid-request.');
        for (const [, pending] of this._charts) {
            clearTimeout(pending.timer);
            pending.reject(disconnected());
        }
        this._charts.clear();
        for (const [, waiter] of this._resolves) {
            clearTimeout(waiter.timer);
            waiter.reject(disconnected());
        }
        this._resolves.clear();

        if (this._closedByUs) return;
        // Only reconnect for work that outlives the socket. One-shot history
        // requests have already been rejected and their callers will retry.
        if (this._subs.size === 0 && this._quoteListeners.size === 0) return;

        const delay = BACKOFF_MS[Math.min(this._attempt++, BACKOFF_MS.length - 1)];
        setTimeout(() => {
            if (this._closedByUs) return;
            this.connect().catch(() => {
                // The next close schedules the following attempt.
            });
        }, delay);
    }

    _onPayload(payload) {
        // Heartbeats are echoed unchanged; missing one drops the connection.
        if (payload.startsWith('~h~')) {
            this._socket?.send(encodeFrame(payload));
            return;
        }

        let message;
        try {
            message = JSON.parse(payload);
        } catch {
            return;
        }
        if (!message || typeof message.m !== 'string') return;

        const params = message.p || [];
        const sessionId = params[0];

        switch (message.m) {
            case 'symbol_resolved': {
                const waiter = this._resolves.get(sessionId);
                if (waiter) {
                    clearTimeout(waiter.timer);
                    this._resolves.delete(sessionId);
                    waiter.resolve(params[2]);
                }
                break;
            }

            case 'timescale_update':
            case 'du': {
                const series = params[1] || {};
                const bars = (series.sds_1 && series.sds_1.s) || [];
                if (bars.length === 0) break;

                const pending = this._charts.get(sessionId);
                if (pending) {
                    for (const bar of bars) pending.bars.set(bar.v[0], bar.v);
                    break;
                }

                const sub = this._subs.get(sessionId);
                // A subscription's series is created with a small window of
                // recent bars, and that window arrives as `timescale_update` —
                // history, not news. Forwarding it hands the chart bars older
                // than the ones it has already drawn, which the charting
                // library treats as corruption ("time order violation") and
                // stops updating on, rather than as a rewind. `du` is the only
                // message that means something actually changed.
                if (sub && message.m === 'du') {
                    for (const bar of bars) sub.onBar(toBar(bar.v));
                }
                break;
            }

            case 'series_completed': {
                const pending = this._charts.get(sessionId);
                if (pending) {
                    clearTimeout(pending.timer);
                    this._charts.delete(sessionId);
                    this._send('chart_delete_session', [sessionId]);
                    pending.resolve([...pending.bars.values()].map(toBar));
                }
                break;
            }

            case 'qsd': {
                const symbol = params[1]?.n;
                const values = params[1]?.v || {};
                const listeners = this._quoteListeners.get(symbol);
                if (listeners) for (const listener of listeners) listener(values);
                break;
            }

            case 'symbol_error':
            case 'series_error':
            case 'critical_error':
            case 'protocol_error': {
                const reason = describeError(message.m, params);

                const waiter = this._resolves.get(sessionId);
                if (waiter) {
                    clearTimeout(waiter.timer);
                    this._resolves.delete(sessionId);
                    waiter.reject(new Error(reason));
                }
                const pending = this._charts.get(sessionId);
                if (pending) {
                    clearTimeout(pending.timer);
                    this._charts.delete(sessionId);
                    pending.reject(new Error(reason));
                }
                break;
            }

            default:
                break;
        }
    }

    /* --------------------------------------------------------------- public */

    /**
     * SymbolInfo as TradingView itself describes the symbol — name, timezone,
     * session hours, price scale.
     *
     * @param {string} symbol  Exchange-qualified, e.g. 'NSE:RELIANCE'.
     */
    async resolve(symbol) {
        await this.connect();

        const chartId = randomId('cs');
        this._send('chart_create_session', [chartId, '']);

        const info = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._resolves.delete(chartId);
                reject(new Error(`Timed out resolving ${symbol}.`));
            }, REQUEST_TIMEOUT_MS);

            this._resolves.set(chartId, { resolve, reject, timer });
            this._send('resolve_symbol', [chartId, 'sds_sym_1', seriesSpec(symbol)]);
        }).finally(() => {
            this._send('chart_delete_session', [chartId]);
        });

        return info;
    }

    /**
     * Historical bars covering [from, to].
     *
     * The protocol has no from/to — a series is created with a bar *count* and
     * pages backwards from now. So the count is derived from the window and the
     * result trimmed, which is why a request far in the past costs as much as
     * the whole span up to today.
     *
     * @param {string} symbol
     * @param {string|number} resolution
     * @param {{from: number, to: number}} range  Unix seconds.
     * @returns {Promise<Array<{time: number, open: number, high: number, low: number, close: number, volume: number}>>}
     */
    async history(symbol, resolution, { from, to }) {
        const tvResolution = toTvResolution(resolution);
        if (!tvResolution) throw new Error(`Unsupported resolution: ${resolution}`);

        await this.connect();

        const span = RESOLUTION_SECONDS[tvResolution] || 86400;
        const nowSeconds = Math.floor(Date.now() / 1000);
        // Counting from now, not from `to`, because that is where paging starts.
        const wanted = Math.ceil((nowSeconds - Math.min(from, to)) / span) + 10;
        const count = Math.max(10, Math.min(wanted, MAX_BARS));

        const chartId = randomId('cs');
        this._send('chart_create_session', [chartId, '']);
        this._send('resolve_symbol', [chartId, 'sds_sym_1', seriesSpec(symbol)]);

        const bars = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const pending = this._charts.get(chartId);
                this._charts.delete(chartId);
                this._send('chart_delete_session', [chartId]);
                // Bars without series_completed still beat failing outright.
                if (pending && pending.bars.size > 0) {
                    resolve([...pending.bars.values()].map(toBar));
                } else {
                    reject(new Error(`Timed out loading ${symbol} history.`));
                }
            }, REQUEST_TIMEOUT_MS);

            this._charts.set(chartId, { resolve, reject, bars: new Map(), timer });
            this._send('create_series', [chartId, 'sds_1', 's1', 'sds_sym_1', tvResolution, count, '']);
        });

        return bars
            .filter((bar) => bar.time >= from && bar.time <= to)
            .sort((a, b) => a.time - b.time);
    }

    /**
     * Streams bar updates for one symbol and resolution.
     *
     * @returns {() => void} Unsubscribe.
     */
    subscribeBars(symbol, resolution, onBar) {
        const tvResolution = toTvResolution(resolution);
        if (!tvResolution) throw new Error(`Unsupported resolution: ${resolution}`);

        const chartId = randomId('cs');
        const sub = { symbol, resolution: tvResolution, onBar };
        this._subs.set(chartId, sub);

        this.connect()
            .then(() => this._openSubscription(chartId, sub))
            .catch(() => {
                // _onClose schedules the retry; the entry stays registered so
                // the reconnect picks it up.
            });

        return () => {
            this._subs.delete(chartId);
            this._send('chart_delete_session', [chartId]);
            this._maybeIdle();
        };
    }

    _openSubscription(chartId, sub) {
        if (!this._subs.has(chartId)) return;
        this._send('chart_create_session', [chartId, '']);
        this._send('resolve_symbol', [chartId, 'sds_sym_1', seriesSpec(sub.symbol)]);
        // A short window: this series exists for its updates, not its history.
        this._send('create_series', [chartId, 'sds_1', 's1', 'sds_sym_1', sub.resolution, 10, '']);
    }

    /**
     * Streams quote updates (last price, change, volume) for one symbol.
     *
     * @returns {() => void} Unsubscribe.
     */
    subscribeQuote(symbol, onQuote) {
        let listeners = this._quoteListeners.get(symbol);
        if (!listeners) {
            listeners = new Set();
            this._quoteListeners.set(symbol, listeners);
            this.connect()
                .then(() => this._send('quote_add_symbols', [this._quoteSession, symbol]))
                .catch(() => {});
        }
        listeners.add(onQuote);

        return () => {
            listeners.delete(onQuote);
            if (listeners.size > 0) return;
            this._quoteListeners.delete(symbol);
            this._send('quote_remove_symbols', [this._quoteSession, symbol]);
            this._maybeIdle();
        };
    }

    /** Drops the socket once nothing is listening, so an idle app holds none. */
    _maybeIdle() {
        if (this._subs.size > 0 || this._quoteListeners.size > 0) return;
        if (this._charts.size > 0) return;
        this._closedByUs = true;
        this._socket?.close();
        this._socket = null;
        this._ready = null;
        // Cleared so the next caller reconnects rather than finding it shut.
        queueMicrotask(() => { this._closedByUs = false; });
    }

    /** For tests and shutdown. */
    disconnect() {
        this._closedByUs = true;
        this._socket?.close();
        this._socket = null;
        this._ready = null;
        this._subs.clear();
        this._quoteListeners.clear();
    }
}

/** `[time, open, high, low, close, volume]` → a named bar. Times stay seconds. */
export function toBar(values) {
    const v = Array.isArray(values) ? values : [];
    return {
        time: v[0],
        open: v[1],
        high: v[2],
        low: v[3],
        close: v[4],
        volume: v[5] === undefined ? 0 : v[5],
    };
}

/** The `={...}` form `resolve_symbol` wants. */
function seriesSpec(symbol) {
    return `=${JSON.stringify({ symbol, adjustment: 'splits' })}`;
}

function describeError(kind, params) {
    const detail = params.slice(1).map((part) => (typeof part === 'string' ? part : JSON.stringify(part)));
    const text = detail.filter(Boolean).join(' ').trim();
    if (kind === 'symbol_error') return `TradingView does not know that symbol${text ? `: ${text}` : '.'}`;
    return text || `TradingView reported ${kind}.`;
}

/** One socket for the whole process, as the widget iframe is one per page. */
let shared = null;

export function getFeed() {
    if (!shared) shared = new TradingViewFeed();
    return shared;
}

export { TradingViewFeed };
