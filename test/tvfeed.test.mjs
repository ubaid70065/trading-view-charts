/**
 * The pure parts of the TradingView widget feed: framing, shape mapping and the
 * time-zone offset the canvas pane draws with.
 *
 * Nothing here opens a socket. The protocol is undocumented and the upstream is
 * live, so a test that connected would fail for reasons that say nothing about
 * this code — and would fail differently at 03:00 than at noon.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    decodeFrames, encodeFrame, encodeMessage, toBar, toTvResolution,
} from '../server/tvfeed.js';
import { toSymbolInfo, toUdfHistory, SUPPORTED_RESOLUTIONS } from '../server/tv-routes.js';
import { toBars } from '../src/tv/datafeed.js';
import { zoneOffsetMs, toTvResolution as paneResolution } from '../src/tv/chart.js';
import { periodArgs } from '../src/datafeed-compat.js';

/* ----------------------------------------------------------------- framing */

test('a frame carries its own length so several can share one message', () => {
    assert.equal(encodeFrame('hello'), '~m~5~m~hello');
    assert.equal(encodeMessage('ping', [1]), '~m~20~m~{"m":"ping","p":[1]}');

    const { payloads, rest } = decodeFrames(`${encodeFrame('one')}${encodeFrame('two')}`);
    assert.deepEqual(payloads, ['one', 'two']);
    assert.equal(rest, '');
});

test('a frame split across two socket messages is held, not dropped', () => {
    const whole = encodeFrame('{"m":"qsd"}');
    const cut = Math.floor(whole.length / 2);

    // First half: nothing complete yet, and the bytes must survive.
    const first = decodeFrames(whole.slice(0, cut));
    assert.deepEqual(first.payloads, []);
    assert.equal(first.rest, whole.slice(0, cut));

    // Prepending the leftover is what the caller does; the frame then resolves.
    const second = decodeFrames(first.rest + whole.slice(cut));
    assert.deepEqual(second.payloads, ['{"m":"qsd"}']);
    assert.equal(second.rest, '');
});

test('a complete frame is kept even when the one behind it is truncated', () => {
    const input = `${encodeFrame('done')}~m~99~m~partial`;
    const { payloads, rest } = decodeFrames(input);
    assert.deepEqual(payloads, ['done']);
    assert.equal(rest, '~m~99~m~partial');
});

test('an unparseable length gives up rather than spinning on the same bytes', () => {
    const { payloads, rest } = decodeFrames('~m~abc~m~junk');
    assert.deepEqual(payloads, []);
    // Empty, not the input: returning it unchanged would loop forever.
    assert.equal(rest, '');
});

test('heartbeats survive decoding intact so they can be echoed verbatim', () => {
    const { payloads } = decodeFrames(encodeFrame('~h~42'));
    assert.deepEqual(payloads, ['~h~42']);
    assert.equal(encodeFrame(payloads[0]), '~m~5~m~~h~42');
});

/* -------------------------------------------------------------- resolutions */

test('resolutions map to the spelling create_series accepts', () => {
    assert.equal(toTvResolution('5'), '5');
    assert.equal(toTvResolution('D'), '1D');
    assert.equal(toTvResolution('W'), '1W');
    assert.equal(toTvResolution('M'), '1M');
    // Already-normalised input must not be mangled a second time.
    assert.equal(toTvResolution('1D'), '1D');
    assert.equal(toTvResolution('nonsense'), null);
});

test('every advertised resolution can actually be requested', () => {
    for (const resolution of SUPPORTED_RESOLUTIONS) {
        assert.ok(toTvResolution(resolution), `${resolution} is advertised but unmappable`);
    }
});

test('the pane falls back to daily rather than failing on an unknown interval', () => {
    assert.equal(paneResolution('60'), '60');
    assert.equal(paneResolution('D'), '1D');
    assert.equal(paneResolution('nonsense'), '1D');
});

/* -------------------------------------------------------------------- bars */

test('a bar tuple becomes named fields with volume defaulted', () => {
    assert.deepEqual(toBar([1785166200, 64658, 64700, 64546, 64578, 43.75]), {
        time: 1785166200, open: 64658, high: 64700, low: 64546, close: 64578, volume: 43.75,
    });
    // Indices publish no volume; undefined would poison the histogram.
    assert.equal(toBar([1785166200, 1, 2, 0.5, 1.5]).volume, 0);
});

test('history is emitted as parallel columns, and emptiness is said explicitly', () => {
    const payload = toUdfHistory([
        { time: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
        { time: 200, open: 1.5, high: 3, low: 1.4, close: 2.9, volume: 20 },
    ]);
    assert.equal(payload.s, 'ok');
    assert.deepEqual(payload.t, [100, 200]);
    assert.deepEqual(payload.c, [1.5, 2.9]);
    assert.deepEqual(payload.v, [10, 20]);

    // no_data, not an empty ok: the library pages forever on the latter.
    assert.deepEqual(toUdfHistory([]), { s: 'no_data' });
});

test('the browser converts history seconds to the milliseconds the library wants', () => {
    const bars = toBars({ s: 'ok', t: [100, 200], o: [1, 2], h: [2, 3], l: [0, 1], c: [1.5, 2.5], v: [7, 8] });
    assert.equal(bars[0].time, 100000);
    assert.equal(bars[1].time, 200000);
    assert.equal(bars[1].close, 2.5);

    // Anything that is not a populated ok payload draws nothing.
    assert.deepEqual(toBars({ s: 'no_data' }), []);
    assert.deepEqual(toBars(null), []);
});

/* -------------------------------------------------------------- SymbolInfo */

test('a resolved symbol carries the tick size and session the axis needs', () => {
    const info = toSymbolInfo({
        name: 'RELIANCE',
        description: 'Reliance Industries Limited',
        exchange: 'NSE',
        pro_name: 'NSE:RELIANCE',
        timezone: 'Asia/Kolkata',
        session: '0915-1530',
        pricescale: 10,
        minmov: 1,
        type: 'stock',
    }, 'NSE:RELIANCE');

    assert.equal(info.ticker, 'NSE:RELIANCE');
    assert.equal(info.timezone, 'Asia/Kolkata');
    assert.equal(info.session, '0915-1530');
    // minmov/pricescale is the tick — ₹0.10 here, not the ₹0.01 a default guesses.
    assert.equal(info.minmov / info.pricescale, 0.1);
    assert.deepEqual(info.supported_resolutions, SUPPORTED_RESOLUTIONS);
});

test('a symbol with no pro_name still round-trips through getBars', () => {
    const info = toSymbolInfo({ name: 'BTCUSDT', exchange: 'Binance', timezone: 'Etc/UTC' }, 'BINANCE:BTCUSDT');
    // getBars is handed `ticker`, so it has to name a symbol resolve accepts.
    assert.equal(info.ticker, 'Binance:BTCUSDT');
    assert.equal(info.full_name, info.ticker);
});

test('a sparse resolve does not produce a chart that cannot draw', () => {
    const info = toSymbolInfo({ name: 'X' }, 'X');
    assert.equal(info.timezone, 'Etc/UTC');
    assert.equal(info.session, '24x7');
    assert.ok(info.pricescale > 0, 'a zero pricescale would divide by zero');
    assert.ok(info.minmov > 0);
});

/* ------------------------------------------------- getBars call conventions */

test('getBars reads the v18+ periodParams object', () => {
    const onResult = () => {};
    const onError = () => {};
    const args = [{}, '5', { from: 100, to: 200, firstDataRequest: true }, onResult, onError];

    const parsed = periodArgs(args);
    assert.equal(parsed.from, 100);
    assert.equal(parsed.to, 200);
    assert.equal(parsed.firstDataRequest, true);
    assert.equal(parsed.onResult, onResult);
    assert.equal(parsed.onError, onError);
});

test('getBars reads the pre-v18 positional form the bundled library uses', () => {
    const onResult = () => {};
    const onError = () => {};
    // (symbolInfo, resolution, rangeStartDate, rangeEndDate, onResult, onError, isFirstCall)
    const args = [{}, '5', 100, 200, onResult, onError, true];

    const parsed = periodArgs(args);
    assert.equal(parsed.from, 100);
    assert.equal(parsed.to, 200);
    assert.equal(parsed.firstDataRequest, true);
    // The whole point: onResult must not land on rangeEndDate.
    assert.equal(parsed.onResult, onResult);
    assert.equal(parsed.onError, onError);
});

test('both conventions agree, so one datafeed serves either library', () => {
    const onResult = () => {};
    const onError = () => {};
    const modern = periodArgs([{}, '5', { from: 7, to: 9, firstDataRequest: false }, onResult, onError]);
    const legacy = periodArgs([{}, '5', 7, 9, onResult, onError, false]);
    assert.deepEqual(modern, legacy);
});

test('a missing firstDataRequest is false rather than undefined', () => {
    // getBars branches on it, and `undefined` would silently take the backfill
    // path on the very first request — blanking the chart instead of erroring.
    assert.equal(periodArgs([{}, '5', { from: 1, to: 2 }, () => {}, () => {}]).firstDataRequest, false);
    assert.equal(periodArgs([{}, '5', 1, 2, () => {}, () => {}]).firstDataRequest, false);
});

/* --------------------------------------------------------------- time zones */

test('the pane offset reproduces the fixed +05:30 the NSE pane hardcodes', () => {
    const IST = (5 * 60 + 30) * 60 * 1000;
    assert.equal(zoneOffsetMs('Asia/Kolkata', Date.UTC(2026, 0, 15, 12)), IST);
    // India has no DST, so July must match January exactly.
    assert.equal(zoneOffsetMs('Asia/Kolkata', Date.UTC(2026, 6, 15, 12)), IST);
});

test('the offset follows DST rather than bending the axis for half the year', () => {
    // EST in January, EDT in July — an hour apart.
    assert.equal(zoneOffsetMs('America/New_York', Date.UTC(2026, 0, 15, 12)), -5 * 3600 * 1000);
    assert.equal(zoneOffsetMs('America/New_York', Date.UTC(2026, 6, 15, 12)), -4 * 3600 * 1000);
});

test('an unknown time zone falls back to UTC instead of blanking the chart', () => {
    assert.equal(zoneOffsetMs('Not/AZone', Date.UTC(2026, 0, 15, 12)), 0);
    assert.equal(zoneOffsetMs('Etc/UTC', Date.UTC(2026, 0, 15, 12)), 0);
});

test('midnight in the exchange zone does not roll the date forward', () => {
    // Some locales render midnight as hour 24, which Date.UTC would carry into
    // the next day — a full day of skew for anything on an Asian session close.
    const midnightIst = Date.UTC(2026, 0, 15, 18, 30);
    assert.equal(zoneOffsetMs('Asia/Kolkata', midnightIst), (5 * 60 + 30) * 60 * 1000);
});
