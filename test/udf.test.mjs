/**
 * The UDF datafeed contract, both ends.
 *
 * The pure shape-and-arithmetic parts are asserted directly; the route layer is
 * driven through handleUdf with a fake response so no server or Angel One
 * session is needed. The two things most worth pinning are the ones a chart
 * cannot report back: bar times must be true UTC (not IST-shifted like the
 * Lightweight Charts pane), and minmov/pricescale must divide out to the exact
 * tick size.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as udf from '../server/udf.js';
import * as datafeed from '../src/nse/datafeed.js';

/* -------------------------------------------------------------- price format */

test('minmov over pricescale reproduces every NSE tick band', () => {
    // NSE quotes ticks in paise by price band; these are the published values.
    for (const tick of [0.01, 0.05, 0.1, 0.25, 0.5, 1, 5]) {
        const { minmov, pricescale } = udf.priceFormat(tick);
        assert.equal(
            minmov / pricescale,
            tick,
            `tick ${tick} must round-trip exactly, got ${minmov}/${pricescale}`,
        );
        assert.ok(Number.isInteger(minmov), 'minmov must be a whole number');
    }
});

test('a missing or nonsense tick size falls back rather than producing zero', () => {
    // A zero minmov makes the price axis collapse; it must never be emitted.
    for (const bad of [0, -1, null, undefined, 'abc']) {
        const { minmov } = udf.priceFormat(bad);
        assert.ok(minmov >= 1, `tick ${bad} produced minmov ${minmov}`);
    }
});

/* ---------------------------------------------------------------- resolutions */

test('resolutions map to what Angel One actually serves', () => {
    assert.equal(udf.toAngelInterval('1'), '1');
    assert.equal(udf.toAngelInterval('60'), '60');
    assert.equal(udf.toAngelInterval('1D'), 'D');
    assert.equal(udf.toAngelInterval('D'), 'D');
});

test('weekly and monthly are refused, not silently served as daily', () => {
    // Angel serves no W/M candles. Answering them with daily bars would draw a
    // chart that looks right and is wrong, so the resolution is rejected.
    assert.equal(udf.toAngelInterval('1W'), null);
    assert.equal(udf.toAngelInterval('1M'), null);
    assert.equal(udf.toAngelInterval('240'), null);
    assert.ok(!udf.SUPPORTED_RESOLUTIONS.includes('1W'));
    assert.ok(!udf.SUPPORTED_RESOLUTIONS.includes('1M'));
});

/* --------------------------------------------------------------- symbol info */

test('SymbolInfo describes an equity the way the library expects', () => {
    const info = udf.symbolInfo({
        token: '2885', symbol: 'RELIANCE-EQ', name: 'RELIANCE',
        exchange: 'NSE', kind: 'equity', series: 'EQ', tickSize: 0.1,
    });

    assert.equal(info.name, 'RELIANCE');
    assert.equal(info.ticker, 'NSE:RELIANCE-EQ');
    assert.equal(info.type, 'stock');
    assert.equal(info.timezone, 'Asia/Kolkata');
    assert.equal(info.session, '0915-1530');
    assert.equal(info.has_intraday, true);
    assert.equal(info.has_no_volume, false);
    assert.equal(info.minmov / info.pricescale, 0.1);
    // Claiming W/M here makes the library request bars that come back empty.
    assert.equal(info.has_weekly_and_monthly, false);
});

test('an index is marked volumeless so no flat zero strip is drawn', () => {
    const info = udf.symbolInfo({
        token: '99926000', symbol: 'Nifty 50', name: 'NIFTY',
        exchange: 'NSE', kind: 'index', series: '', tickSize: 0.05,
    });
    assert.equal(info.type, 'index');
    assert.equal(info.has_no_volume, true);
});

/* ---------------------------------------------------------------- bar columns */

test('bars become column arrays in whole UTC seconds', () => {
    const bars = [
        { time: 1769625000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
        { time: 1769711400000, open: 1.5, high: 3, low: 1, close: 2, volume: 200 },
    ];
    const out = udf.columns(bars);

    assert.equal(out.s, 'ok');
    assert.deepEqual(out.t, [1769625000, 1769711400]);
    assert.deepEqual(out.o, [1, 1.5]);
    assert.deepEqual(out.v, [100, 200]);
    assert.ok(out.t.every(Number.isInteger), 'times must be whole seconds');
});

test('UDF times are NOT IST-shifted the way the Lightweight Charts pane is', () => {
    // chart.js adds +05:30 because Lightweight Charts renders in UTC with no
    // time-zone option. UDF carries `timezone` instead, so the same shift here
    // would move every bar 5.5 hours. This is the regression that guards it.
    const open = Date.UTC(2026, 6, 27, 3, 45); // 09:15 IST
    const [seconds] = udf.columns([
        { time: open, open: 1, high: 1, low: 1, close: 1, volume: 0 },
    ]).t;

    assert.equal(seconds, open / 1000, 'the epoch must pass through untouched');
    assert.equal(new Date(seconds * 1000).toISOString(), '2026-07-27T03:45:00.000Z');
});

test('volume is omitted entirely for instruments that have none', () => {
    const out = udf.columns([{ time: 1e12, open: 1, high: 1, low: 1, close: 1, volume: 0 }], true);
    assert.equal(out.v, undefined, 'no volume column at all, not a column of zeros');
});

/* ------------------------------------------------------------------- routing */

/** Minimal ServerResponse stand-in. */
function fakeRes() {
    return {
        statusCode: null, headers: null, body: '',
        writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
        end(body) { this.body = body || ''; },
        json() { return JSON.parse(this.body); },
    };
}

const call = async (pathname, search = '') => {
    const res = fakeRes();
    const url = new URL(`http://localhost:5500${pathname}${search}`);
    const handled = await udf.handleUdf({ method: 'GET' }, res, url, process.cwd());
    return { handled, res };
};

test('non-UDF paths are declined so the file server still sees them', async () => {
    const { handled } = await call('/api/health');
    assert.equal(handled, false);
});

test('config advertises search and the served resolutions', async () => {
    const { handled, res } = await call('/udf/config');
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);

    const config = res.json();
    assert.equal(config.supports_search, true);
    assert.equal(config.supports_time, true);
    assert.deepEqual(config.supported_resolutions, udf.SUPPORTED_RESOLUTIONS);
});

test('time answers plain seconds, not JSON', async () => {
    const { res } = await call('/udf/time');
    assert.match(res.headers['Content-Type'], /text\/plain/);
    const seconds = Number(res.body);
    assert.ok(Number.isInteger(seconds), 'body must parse as a whole number');
    assert.ok(Math.abs(seconds - Date.now() / 1000) < 5, 'clock must be current');
});

test('a bad resolution reports through the UDF envelope, not an HTTP error', async () => {
    // The library reads the envelope and discards the status code, so a 4xx
    // would surface to the user as an unexplained network failure.
    const { res } = await call('/udf/history', '?symbol=RELIANCE&resolution=1W&from=1&to=2');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().s, 'error');
    assert.match(res.json().errmsg, /1W/);
});

test('a reversed or non-numeric range is rejected before any upstream call', async () => {
    for (const range of ['?from=200&to=100', '?from=abc&to=200', '']) {
        const { res } = await call('/udf/history', `?symbol=RELIANCE&resolution=1D${range}`);
        assert.equal(res.json().s, 'error', `range "${range}" should not reach Angel One`);
    }
});

test('POST is refused', async () => {
    const res = fakeRes();
    const url = new URL('http://localhost:5500/udf/config');
    assert.equal(await udf.handleUdf({ method: 'POST' }, res, url, process.cwd()), true);
    assert.equal(res.statusCode, 405);
});

/* ------------------------------------------------------- client-side datafeed */

test('history columns become bars in milliseconds', () => {
    const bars = datafeed.toBars({
        s: 'ok', t: [1769625000, 1769711400], o: [1, 2], h: [3, 4], l: [0, 1], c: [2, 3], v: [10, 20],
    });
    assert.equal(bars.length, 2);
    // Seconds on the wire, milliseconds in the callback.
    assert.equal(bars[0].time, 1769625000000);
    assert.equal(bars[1].close, 3);
});

test('a no_data or error payload yields no bars rather than throwing', () => {
    assert.deepEqual(datafeed.toBars({ s: 'no_data' }), []);
    assert.deepEqual(datafeed.toBars({ s: 'error', errmsg: 'nope' }), []);
    assert.deepEqual(datafeed.toBars(null), []);
});

test('intraday bars start on an even multiple of the resolution', () => {
    const t = Date.UTC(2026, 6, 27, 9, 47, 33);
    assert.equal(datafeed.barStart(t, '5'), Date.UTC(2026, 6, 27, 9, 45));
    assert.equal(datafeed.barStart(t, '15'), Date.UTC(2026, 6, 27, 9, 45));
    assert.equal(datafeed.barStart(t, '60'), Date.UTC(2026, 6, 27, 9, 0));
});

test('the daily bucket breaks on the IST date, not the UTC one', () => {
    // 04:00 UTC is 09:30 IST — the same trading day as 09:15 IST (03:45 UTC).
    // Flooring UTC directly would agree here but split the session at 05:30 IST.
    const open = Date.UTC(2026, 6, 27, 3, 45);
    const later = Date.UTC(2026, 6, 27, 9, 55);
    assert.equal(datafeed.barStart(open, '1D'), datafeed.barStart(later, '1D'));

    // 18:30 UTC is 00:00 IST the next day, so it must land on a new bar.
    const nextDay = Date.UTC(2026, 6, 27, 18, 30);
    assert.notEqual(datafeed.barStart(open, '1D'), datafeed.barStart(nextDay, '1D'));
});

test('a live price extends the forming bar without moving its open', () => {
    const at = Date.UTC(2026, 6, 27, 9, 47);
    const first = datafeed.foldQuote(null, 100, at, '5');
    assert.deepEqual(
        [first.open, first.high, first.low, first.close],
        [100, 100, 100, 100],
    );

    const up = datafeed.foldQuote(first, 105, at + 1000, '5');
    assert.equal(up.open, 100, 'the open is fixed once the bar exists');
    assert.equal(up.high, 105);
    assert.equal(up.close, 105);
    assert.equal(up.time, first.time, 'still the same bar');

    const down = datafeed.foldQuote(up, 95, at + 2000, '5');
    assert.equal(down.low, 95);
    assert.equal(down.high, 105, 'the running high survives a lower print');
});

test('crossing the bucket boundary opens a new bar at that price', () => {
    const at = Date.UTC(2026, 6, 27, 9, 47);
    const bar = datafeed.foldQuote(null, 100, at, '5');
    const next = datafeed.foldQuote(bar, 110, Date.UTC(2026, 6, 27, 9, 51), '5');

    assert.ok(next.time > bar.time, 'a later bucket must start a new bar');
    assert.equal(next.open, 110, 'the new bar opens at the price that made it');
    assert.equal(next.high, 110);
    assert.equal(next.low, 110);
});

test('a stale quote cannot rewrite a bar that has already closed', () => {
    const bar = datafeed.foldQuote(null, 100, Date.UTC(2026, 6, 27, 9, 51), '5');
    const stale = datafeed.foldQuote(bar, 999, Date.UTC(2026, 6, 27, 9, 47), '5');
    assert.equal(stale, null, 'an out-of-order poll must be dropped');
});

test('a missing price is dropped rather than drawn as a gap', () => {
    assert.equal(datafeed.foldQuote(null, null, Date.now(), '5'), null);
    assert.equal(datafeed.foldQuote(null, NaN, Date.now(), '5'), null);
});
