/**
 * NSE pane logic: interval mapping and the IST time shift.
 *
 * Both are places where a silent off-by-one is invisible in code review but
 * obvious on screen — a chart labelled 03:45 for the 09:15 open, or an interval
 * the upstream API rejects.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

const { NSE_INTERVALS, nearestNseInterval, toChartTime } = await import(
    new URL('../src/nse/chart.js', import.meta.url).href
);

test('supported intervals are exactly what Angel One serves', () => {
    assert.deepEqual(NSE_INTERVALS, ['1', '3', '5', '10', '15', '30', '60', 'D']);
});

test('supported intervals pass through untouched', () => {
    for (const interval of NSE_INTERVALS) {
        assert.equal(nearestNseInterval(interval), interval);
    }
});

test('unsupported intervals fall back to the nearest available', () => {
    // The widget offers these; Angel One does not.
    assert.equal(nearestNseInterval('120'), '60');
    assert.equal(nearestNseInterval('240'), '60');
    assert.equal(nearestNseInterval('W'), 'D');
    assert.equal(nearestNseInterval('M'), 'D');
});

test('anything unrecognised degrades to daily rather than throwing', () => {
    assert.equal(nearestNseInterval('nonsense'), 'D');
    assert.equal(nearestNseInterval(undefined), 'D');
});

test('every fallback lands on a supported interval', () => {
    for (const interval of ['1', '3', '5', '15', '30', '60', '120', '240', 'D', 'W', 'M', 'junk']) {
        assert.ok(
            NSE_INTERVALS.includes(nearestNseInterval(interval)),
            `${interval} mapped outside the supported set`,
        );
    }
});

test('IST shift makes the 09:15 NSE open render as 09:15', () => {
    // 2024-01-01 09:15 IST is 03:45 UTC.
    const openIst = Date.UTC(2024, 0, 1, 3, 45) ;
    const shifted = toChartTime(openIst);

    // The library formats in UTC, so the shifted value must read back as 09:15.
    const rendered = new Date(shifted * 1000);
    assert.equal(rendered.getUTCHours(), 9);
    assert.equal(rendered.getUTCMinutes(), 15);
    assert.equal(rendered.getUTCFullYear(), 2024);
    assert.equal(rendered.getUTCMonth(), 0);
    assert.equal(rendered.getUTCDate(), 1);
});

test('IST shift keeps a late-evening bar on the correct date', () => {
    // 2024-03-15 23:30 IST is 18:00 UTC — naive rendering would still say the
    // 15th, but the shift must not roll it forward to the 16th either.
    const lateIst = Date.UTC(2024, 2, 15, 18, 0);
    const rendered = new Date(toChartTime(lateIst) * 1000);
    assert.equal(rendered.getUTCDate(), 15);
    assert.equal(rendered.getUTCHours(), 23);
    assert.equal(rendered.getUTCMinutes(), 30);
});

test('IST shift returns whole seconds, as the library requires', () => {
    const value = toChartTime(1704086100123);
    assert.equal(Number.isInteger(value), true);
    assert.equal(value, Math.floor(value));
});
