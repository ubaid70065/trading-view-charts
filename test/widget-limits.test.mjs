/**
 * The free embed widget's end-of-day restriction.
 *
 * Intraday intervals on an Indian EOD listing fail *inside* the cross-origin
 * iframe: it draws "Only D, W, M intervals are available for this symbol" and
 * the page has no way to see that, so the check has to happen before the pane
 * is built.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};

const { widgetIntradayProblem, INTERVALS } = await import(
    new URL('../src/config.js', import.meta.url).href
);

const problem = (symbol, interval, source = 'tv') =>
    widgetIntradayProblem({ source, symbol, interval });

test('an unprefixed symbol on an intraday interval is flagged', () => {
    // Exactly what the widget did with a bare RELIANCE: resolved it to the BSE
    // listing, which serves end-of-day only.
    const found = problem('RELIANCE', '3');
    assert.ok(found, 'a bare ticker must be flagged');
    assert.match(found.message, /no exchange prefix/);
    assert.match(found.message, /NSE:RELIANCE/, 'must name the fix');
    assert.match(found.message, /3m/, 'must name the interval that failed');
    assert.equal(found.ticker, 'RELIANCE');
});

test('an explicit BSE symbol on an intraday interval is flagged', () => {
    const found = problem('BSE:RELIANCE', '15');
    assert.ok(found);
    assert.match(found.message, /end-of-day/);
    assert.match(found.message, /NSE:RELIANCE/);
    assert.equal(found.ticker, 'RELIANCE', 'the ticker is offered to the NSE source unprefixed');
});

test('the guidance points at NSE, which is the better fix', () => {
    // Checked against TradingView's own scanner: NSE reports update_mode
    // "streaming" (real-time) while BSE reports "delayed_streaming_900". So
    // prefixing keeps real-time data *and* the widget's indicators and
    // drawings, where moving to Angel One trades those away.
    for (const symbol of ['RELIANCE', 'BSE:RELIANCE']) {
        const found = problem(symbol, '3');
        assert.match(found.message, /real-time/, symbol);
        assert.match(found.message, /NSE:RELIANCE/, symbol);
    }
});

test('daily and above are fine on any listing', () => {
    for (const interval of ['D', 'W', 'M']) {
        assert.equal(problem('RELIANCE', interval), null, interval);
        assert.equal(problem('BSE:RELIANCE', interval), null, interval);
    }
});

test('a properly prefixed symbol is left alone', () => {
    // NSE and the non-Indian exchanges serve intraday on the free widget.
    for (const symbol of ['NSE:RELIANCE', 'NASDAQ:AAPL', 'BINANCE:BTCUSDT', 'FX:EURUSD']) {
        assert.equal(problem(symbol, '3'), null, symbol);
    }
});

test('in-page sources are never flagged by the widget-specific check', () => {
    for (const interval of INTERVALS.map((item) => item.value)) {
        assert.equal(problem('RELIANCE', interval, 'tvfeed'), null, interval);
        assert.equal(problem('RELIANCE', interval, 'advanced'), null, interval);
    }
});

test('an empty symbol produces no warning', () => {
    assert.equal(problem('', '3'), null);
    assert.equal(problem('   ', '3'), null);
    assert.equal(problem(undefined, '3'), null);
});

test('case and stray spacing do not hide the problem', () => {
    assert.ok(problem('  reliance  ', '5'));
    assert.ok(problem('bse:reliance', '5'));
});

test('every intraday interval in the picker is covered', () => {
    for (const { value, label } of INTERVALS) {
        if (['D', 'W', 'M'].includes(value)) continue;
        const found = problem('RELIANCE', value);
        assert.ok(found, `${value} must be flagged`);
        assert.match(found.message, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
});
