/**
 * Contract and logic tests.  Run with: npm test
 *
 * The vendor tests fetch the live embed scripts and assert that the key
 * whitelists in src/config.js still match what TradingView ships. If those
 * drift, settings start being silently ignored — the failure mode this guards
 * against. They skip when offline rather than failing the suite.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

// import.meta.url is already a file URL, so relative resolution is enough —
// and it survives the spaces in the project path.
const moduleUrl = (name) => new URL(`../src/${name}`, import.meta.url).href;

// state.js touches localStorage at import time.
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};

const cfg = await import(moduleUrl('config.js'));

/** Finds `const NAME=[...]` (or `,NAME=[...]`) and parses it. */
function resolveArrayVariable(source, name) {
    const pattern = new RegExp(
        `(?:\\b(?:const|let|var)\\s+|[,;])\\s*${name}\\s*=\\s*(\\[[^\\]]*\\])`,
    );
    const match = pattern.exec(source);
    if (!match) return null;
    try {
        const parsed = JSON.parse(match[1]);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Reads the accepted-key list out of a minified bundle.
 *
 * Both declare it as `propertiesToWorkWith(){return[...]}`, but not in the same
 * shape: the ticker inlines the array, while the chart hoists it into a variable
 * and spreads it (`return[...g,"customer"]`). So the contents are parsed token by
 * token, resolving any spread back to its declaration.
 *
 * The base class returns an empty array and the widget subclass returns the real
 * one, hence taking the longest match.
 */
function extractWhitelist(source) {
    const marker = 'propertiesToWorkWith(){return';
    let best = null;
    let at = -1;

    while ((at = source.indexOf(marker, at + 1)) !== -1) {
        const start = source.indexOf('[', at);
        const end = source.indexOf(']', start);
        if (start === -1 || end === -1) continue;

        const tokens = source.slice(start + 1, end).split(',').map((t) => t.trim()).filter(Boolean);
        const keys = [];
        let usable = true;

        for (const token of tokens) {
            if (/^"[^"]*"$/.test(token)) {
                keys.push(JSON.parse(token));
            } else if (token.startsWith('...')) {
                const resolved = resolveArrayVariable(source, token.slice(3).trim());
                if (!resolved) { usable = false; break; }
                keys.push(...resolved);
            } else {
                usable = false;
                break;
            }
        }

        // The chart list repeats "customer" via the spread, so dedupe.
        const unique = [...new Set(keys)];
        if (usable && unique.length > 0 && (!best || unique.length > best.length)) best = unique;
    }

    return best;
}

async function fetchScript(url) {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!response.ok) return null;
        return await response.text();
    } catch {
        return null;
    }
}

test('chart widget whitelist matches the shipped script', async (t) => {
    const source = await fetchScript(cfg.CHART_SCRIPT_URL);
    if (!source) return t.skip('embed script unreachable (offline?)');

    const vendor = extractWhitelist(source);
    assert.ok(vendor, 'could not locate the whitelist in the vendor bundle');
    // Sentinel: proves we read the chart list and not some other array.
    assert.ok(vendor.includes('allow_symbol_change'), 'extracted the wrong array');
    assert.deepEqual(
        [...cfg.CHART_KEYS].sort(),
        [...vendor].sort(),
        'CHART_KEYS has drifted from the vendor whitelist',
    );
});

test('ticker widget whitelist matches the shipped script', async (t) => {
    const source = await fetchScript(cfg.TICKER_SCRIPT_URL);
    if (!source) return t.skip('embed script unreachable (offline?)');

    const vendor = extractWhitelist(source);
    assert.ok(vendor, 'could not locate the whitelist in the vendor bundle');
    assert.ok(vendor.includes('showSymbolLogo'), 'extracted the wrong array');
    assert.deepEqual(
        [...cfg.TICKER_KEYS].sort(),
        [...vendor].sort(),
        'TICKER_KEYS has drifted from the vendor whitelist',
    );
});

test('emitted settings only use accepted keys', () => {
    const state = cfg.defaultState();
    const pane = state.tabs[0].panes[0];

    for (const withPanel of [true, false]) {
        const settings = cfg.chartSettings(state, pane, withPanel);
        for (const key of Object.keys(settings)) {
            assert.ok(cfg.CHART_KEYS.includes(key), `chart setting "${key}" is not accepted`);
        }
        assert.equal(settings.autosize, true);
        JSON.stringify(settings); // must survive being embedded in a script body
    }

    const ticker = cfg.tickerSettings(state);
    for (const key of Object.keys(ticker)) {
        assert.ok(cfg.TICKER_KEYS.includes(key), `ticker setting "${key}" is not accepted`);
    }
});

test('booleans that are meaningful when false are not dropped', () => {
    const state = cfg.defaultState();
    state.chart.hide_volume = false;
    state.chart.withdateranges = false;
    const settings = cfg.chartSettings(state, state.tabs[0].panes[0], true);
    assert.equal(settings.hide_volume, false);
    assert.equal(settings.withdateranges, false);
});

test('layout catalogue tiles every grid exactly', () => {
    assert.equal(cfg.LAYOUTS.length, 55);

    for (const group of cfg.LAYOUT_GROUPS) {
        for (const layout of group.layouts) {
            const { cols, rows, cells } = cfg.layoutGeometry(layout);
            assert.equal(cells.length, layout.panes, `${layout.id} cell count`);
            assert.equal(layout.panes, group.count, `${layout.id} group membership`);

            const covered = Array.from({ length: rows }, () => new Array(cols).fill(0));
            for (const cell of cells) {
                for (let r = cell.row - 1; r < cell.row - 1 + cell.rowSpan; r += 1) {
                    for (let c = cell.col - 1; c < cell.col - 1 + cell.colSpan; c += 1) {
                        assert.ok(r >= 0 && r < rows && c >= 0 && c < cols, `${layout.id} in bounds`);
                        covered[r][c] += 1;
                    }
                }
            }
            for (const count of covered.flat()) {
                assert.equal(count, 1, `${layout.id} must tile without gaps or overlap`);
            }
        }
    }
});

test('layout ids are unique and no two layouts look the same', () => {
    const ids = cfg.LAYOUTS.map((layout) => layout.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate layout id');

    const shapes = new Set();
    for (const layout of cfg.LAYOUTS) {
        const geometry = cfg.layoutGeometry(layout);
        const key = `${geometry.cols}x${geometry.rows}:` + geometry.cells
            .map((c) => `${c.col},${c.row},${c.colSpan},${c.rowSpan}`).sort().join('|');
        assert.ok(!shapes.has(key), `${layout.id} renders identically to another layout`);
        shapes.add(key);
    }
});

test('layout icons draw one rect per pane', () => {
    for (const layout of cfg.LAYOUTS) {
        const svg = cfg.layoutIconSvg(layout);
        assert.equal((svg.match(/<rect /g) || []).length, layout.panes, `${layout.id} icon`);
        assert.doesNotMatch(svg, /NaN|undefined/, `${layout.id} icon numbers`);
    }
});

test('uneven splits share one grid via a common denominator', () => {
    const geometry = cfg.layoutGeometry(cfg.layoutById('r:2-3'));
    assert.equal(geometry.cols, 6, 'lcm(2,3)');
    assert.equal(geometry.rows, 2);
    assert.deepEqual(geometry.cells.map((c) => c.colSpan), [3, 3, 2, 2, 2]);
});

test('layout ids from the previous build still resolve', () => {
    assert.equal(cfg.layoutPanes('1'), 1);
    assert.equal(cfg.layoutPanes('2h'), 2);
    assert.equal(cfg.layoutPanes('2v'), 2);
    assert.equal(cfg.layoutPanes('3'), 3);
    assert.equal(cfg.layoutPanes('4'), 4);
    // Anything unrecognised must degrade to a single chart, not throw.
    assert.equal(cfg.layoutById('nonsense').id, 'r:1');
});

test('time zones are normalised to the set the widget accepts', () => {
    assert.ok(cfg.TIMEZONES.includes(cfg.detectTimezone()));
});

test('state repairs a corrupt or truncated payload', async () => {
    store.clear();
    store.set('tv:workspace:v1', JSON.stringify({
        version: 1,
        activeTabId: 'missing',
        // Legacy layout id, too few panes, and junk fields.
        tabs: [{ id: 'a', layout: '4', panes: [{ symbol: 'NASDAQ:AAPL' }], activePane: 99 }],
        chart: null,
        panel: { symbols: 'not-an-array' },
    }));

    const state = await import(moduleUrl('state.js') + '?fresh=1');
    const loaded = state.getState();

    assert.equal(loaded.tabs[0].layout, 'r:2-2', 'legacy id migrated');
    assert.equal(loaded.tabs[0].panes.length, 4, 'pane list padded to the layout');
    assert.equal(loaded.tabs[0].activePane, 3, 'out-of-range active pane clamped');
    assert.equal(loaded.activeTabId, 'a', 'dangling active tab repaired');
    assert.ok(Array.isArray(loaded.panel.symbols), 'watchlist coerced to an array');
    // Panes saved before the NSE source existed must default to the widget.
    assert.ok(loaded.tabs[0].panes.every((pane) => pane.source === 'tv'), 'pane source defaulted');
    assert.ok(loaded.chart && typeof loaded.chart.timezone === 'string', 'chart defaults restored');
    assert.ok(loaded.sync && typeof loaded.sync.symbol === 'boolean', 'sync defaults added');
});

test('one broken tab does not discard the whole workspace', async () => {
    store.clear();
    store.set('tv:workspace:v1', JSON.stringify({
        version: 1,
        activeTabId: 'good',
        // A null tab, a null pane and a non-numeric activePane. migrate() runs
        // inside load()'s try, so any throw here silently resets everything.
        tabs: [
            null,
            { id: 'good', layout: 'c:1-1', panes: [null, { symbol: 'NSE:RELIANCE' }], activePane: 'x' },
        ],
        panel: { symbols: ['NSE:TCS'] },
    }));

    const state = await import(moduleUrl('state.js') + '?fresh=3');
    const loaded = state.getState();

    assert.equal(loaded.tabs.length, 2, 'the good tab survived the broken one');
    const good = loaded.tabs.find((tab) => tab.id === 'good');
    assert.ok(good, 'the named tab was kept');
    assert.equal(good.panes[1].symbol, 'NSE:RELIANCE', 'the real symbol was not lost');
    assert.equal(good.panes[0].symbol, 'NASDAQ:AAPL', 'the null pane was replaced, not fatal');
    assert.equal(good.activePane, 0, 'a non-numeric activePane clamps to 0 rather than NaN');
    assert.deepEqual(loaded.panel.symbols, ['NSE:TCS'], 'the watchlist was not reset');
});

test('unreadable storage falls back to defaults instead of throwing', async () => {
    store.clear();
    store.set('tv:workspace:v1', '{ this is not json');
    const state = await import(moduleUrl('state.js') + '?fresh=2');
    assert.equal(state.getState().tabs.length, 1);
});
