/**
 * Instrument master handling.
 *
 * The fixture rows are copied verbatim from the published scrip master, because
 * the bugs these guard against are all *data* shape problems rather than logic
 * problems: an index listed twice under different tokens, trading symbols that
 * are mixed case only for indices, tradable series beyond -EQ, and a tick size
 * quoted in paise. Inventing tidy rows would test nothing.
 *
 * Each scenario gets a fresh module instance, since the index is cached at
 * module level once loaded.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MODULE = new URL('../server/instruments.js', import.meta.url).href;

/**
 * Rows as an older build wrote them: tick size still in paise, and an empty
 * `instrumenttype` already flattened to 'EQ'. Loading these exercises the
 * migration as well as the classification.
 */
const V1_ROWS = [
    // The chartable index and its quote-only twin. Same name, different token;
    // only 99926000 returns candles.
    { token: '99926000', symbol: 'Nifty 50', name: 'NIFTY', exchange: 'NSE', instrumentType: 'AMXIDX', lotSize: 1, tickSize: 0 },
    { token: '26000', symbol: 'NIFTY', name: 'NIFTY', exchange: 'NSE', instrumentType: 'EQ', lotSize: 1, tickSize: 0 },
    { token: '99926009', symbol: 'Nifty Bank', name: 'BANKNIFTY', exchange: 'NSE', instrumentType: 'AMXIDX', lotSize: 1, tickSize: 0 },
    { token: '26009', symbol: 'BANKNIFTY', name: 'BANKNIFTY', exchange: 'NSE', instrumentType: 'EQ', lotSize: 1, tickSize: 0 },
    { token: '99926017', symbol: 'India VIX', name: 'INDIA VIX', exchange: 'NSE', instrumentType: 'AMXIDX', lotSize: 1, tickSize: 0 },

    // Equities across the tick bands: 10 paise, 1 paisa, 100 paise.
    { token: '2885', symbol: 'RELIANCE-EQ', name: 'RELIANCE', exchange: 'NSE', instrumentType: 'EQ', lotSize: 1, tickSize: 10 },
    { token: '12018', symbol: 'SUZLON-EQ', name: 'SUZLON', exchange: 'NSE', instrumentType: 'EQ', lotSize: 1, tickSize: 1 },
    { token: '13332', symbol: 'SOLARINDS-EQ', name: 'SOLARINDS', exchange: 'NSE', instrumentType: 'EQ', lotSize: 1, tickSize: 100 },

    // Tradable, but not -EQ.
    { token: '13229', symbol: 'GVKPIL-BE', name: 'GVKPIL', exchange: 'NSE', instrumentType: 'EQ', lotSize: 1, tickSize: 1 },
    { token: '11903', symbol: 'IPSL-SM', name: 'IPSL', exchange: 'NSE', instrumentType: 'EQ', lotSize: 500, tickSize: 5 },
    { token: '11917', symbol: 'RITEZONE-ST', name: 'RITEZONE', exchange: 'NSE', instrumentType: 'EQ', lotSize: 1600, tickSize: 5 },
    { token: '11371', symbol: 'BGLOBAL-BZ', name: 'BGLOBAL', exchange: 'NSE', instrumentType: 'EQ', lotSize: 1, tickSize: 1 },

    // Not tradable equity: a state loan, a G-Sec, a sovereign gold bond.
    { token: '10331', symbol: '781HR32A-SG', name: '781HR32A', exchange: 'NSE', instrumentType: 'EQ', lotSize: 100, tickSize: 1 },
    { token: '10981', symbol: '74GS2062-GS', name: '74GS2062', exchange: 'NSE', instrumentType: 'EQ', lotSize: 1, tickSize: 1 },
    { token: '12904', symbol: 'SGBAUG27-GB', name: 'SGBAUG27', exchange: 'NSE', instrumentType: 'EQ', lotSize: 1, tickSize: 1 },

    // An exchange test scrip, which is real to the API and noise to a human.
    { token: '12848', symbol: 'N1NSETEST-EQ', name: 'N1NSETEST', exchange: 'NSE', instrumentType: 'EQ', lotSize: 1, tickSize: 5 },

    // BSE publishes no series code at all.
    { token: '500325', symbol: 'RELIANCE', name: 'RELIANCE', exchange: 'BSE', instrumentType: 'EQ', lotSize: 1, tickSize: 5 },
    { token: '99919000', symbol: 'SENSEX', name: 'SENSEX', exchange: 'BSE', instrumentType: 'AMXIDX', lotSize: 1, tickSize: 0 },
];

let scenario = 0;

/** Writes a fixture cache and loads a fresh module instance against it. */
async function withFixture(rows, version) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'instruments-test-'));
    await fs.mkdir(path.join(root, 'data'), { recursive: true });
    await fs.writeFile(
        path.join(root, 'data', 'instruments.nse.json'),
        JSON.stringify({ ...(version ? { version } : {}), builtAt: Date.now(), rows }),
    );

    scenario += 1;
    const module = await import(`${MODULE}?scenario=${scenario}`);
    await module.loadInstruments(root);
    return { module, root };
}

test('a bare index name resolves to the row that serves candles', async () => {
    const { module } = await withFixture(V1_ROWS);

    // Both rows answer to NIFTY — 'NIFTY' is the trading symbol of the twin and
    // the name of the real index. Picking the twin yields an empty chart.
    assert.equal(module.resolve('NIFTY').token, '99926000');
    assert.equal(module.resolve('BANKNIFTY').token, '99926009');
    assert.equal(module.resolve('NIFTY').kind, 'index');
    assert.equal(module.resolve('BANKNIFTY').kind, 'index');
});

test('index symbols resolve despite their mixed case and spaces', async () => {
    const { module } = await withFixture(V1_ROWS);

    for (const query of ['Nifty 50', 'NIFTY 50', 'nifty 50']) {
        assert.equal(module.resolve(query).token, '99926000', query);
    }
    assert.equal(module.resolve('INDIA VIX').token, '99926017');
    assert.equal(module.resolve('India VIX').token, '99926017');
});

test('a bare ticker expands across every tradable series, not just -EQ', async () => {
    const { module } = await withFixture(V1_ROWS);

    assert.equal(module.resolve('RELIANCE').symbol, 'RELIANCE-EQ');
    assert.equal(module.resolve('GVKPIL').symbol, 'GVKPIL-BE');
    assert.equal(module.resolve('IPSL').symbol, 'IPSL-SM');
    assert.equal(module.resolve('RITEZONE').symbol, 'RITEZONE-ST');
    assert.equal(module.resolve('BGLOBAL').symbol, 'BGLOBAL-BZ');
});

test('tokens, qualified symbols and case variants all resolve', async () => {
    const { module } = await withFixture(V1_ROWS);

    assert.equal(module.resolve('2885').symbol, 'RELIANCE-EQ');
    assert.equal(module.resolve('NSE:RELIANCE-EQ').token, '2885');
    assert.equal(module.resolve('reliance-eq').token, '2885');
    // The same name on another exchange must not leak across.
    assert.equal(module.resolve('RELIANCE', 'BSE').token, '500325');
    assert.equal(module.resolve('NOTAREALTICKER'), null);
    assert.equal(module.resolve(''), null);
});

test('tick sizes are converted from paise to rupees', async () => {
    const { module } = await withFixture(V1_ROWS);

    // A fixed minMove cannot serve these: NSE sets the tick by price band.
    assert.equal(module.resolve('RELIANCE').tickSize, 0.1);
    assert.equal(module.resolve('SUZLON').tickSize, 0.01);
    assert.equal(module.resolve('SOLARINDS').tickSize, 1);
    // Indices publish no tick; the chart falls back rather than using zero.
    assert.equal(module.resolve('NIFTY').tickSize, 0);
});

test('a cache already in the current shape is not converted twice', async () => {
    // The migration divides by 100. Re-running it on a migrated cache would
    // turn RELIANCE's ₹0.10 tick into ₹0.001.
    const v2Rows = V1_ROWS.map((row) => ({
        ...row,
        tickSize: row.tickSize / 100,
        series: /-([A-Z0-9]{2})$/.exec(row.symbol)?.[1] || '',
    }));
    const { module } = await withFixture(v2Rows, 2);

    assert.equal(module.resolve('RELIANCE').tickSize, 0.1);
    assert.equal(module.resolve('SUZLON').tickSize, 0.01);
});

test('rows are classified by what the master states', async () => {
    const { module } = await withFixture(V1_ROWS);
    const kind = (query, exchange) => module.resolve(query, exchange).kind;

    assert.equal(kind('99926000'), 'index');
    assert.equal(kind('26000'), 'alias');      // quote-only twin
    assert.equal(kind('RELIANCE'), 'equity');
    assert.equal(kind('GVKPIL'), 'equity');    // -BE is tradable
    assert.equal(kind('74GS2062'), 'other');   // G-Sec
    assert.equal(kind('781HR32A'), 'other');   // state development loan
    assert.equal(kind('SGBAUG27'), 'other');   // sovereign gold bond
    // BSE carries no series code, so its rows cannot be told apart here.
    assert.equal(kind('SENSEX', 'BSE'), 'index');
});

test('search surfaces indices and every tradable series', async () => {
    const { module } = await withFixture(V1_ROWS);
    const symbols = (query) => module.search(query, { limit: 10 }).map((row) => row.symbol);

    assert.equal(symbols('NIFTY')[0], 'Nifty 50', 'an exact name match comes first');
    assert.ok(symbols('VIX').includes('India VIX'));
    assert.deepEqual(symbols('GVKPIL'), ['GVKPIL-BE']);
    assert.deepEqual(symbols('IPSL'), ['IPSL-SM']);
    assert.deepEqual(symbols('RITEZONE'), ['RITEZONE-ST']);
});

test('search hides debt and test scrips unless asked for them', async () => {
    const { module } = await withFixture(V1_ROWS);

    for (const query of ['74GS2062', 'SGBAUG27', '781HR32A', 'NSETEST']) {
        assert.deepEqual(module.search(query, { limit: 5 }), [], `${query} should be hidden`);
    }

    // ?all=1 still reaches them.
    const all = module.search('74GS2062', { limit: 5, tradableOnly: false });
    assert.equal(all.length, 1);
    assert.equal(all[0].symbol, '74GS2062-GS');
    assert.equal(module.search('NSETEST', { limit: 5, tradableOnly: false }).length, 1);
});

test('search never leaks the quote-only index twins', async () => {
    const { module } = await withFixture(V1_ROWS);

    // Both would otherwise match, and the twin charts as an empty pane.
    const tokens = module.search('NIFTY', { limit: 20 }).map((row) => row.token);
    assert.ok(tokens.includes('99926000'));
    assert.ok(!tokens.includes('26000'), 'the candle-less duplicate must not be offered');
});

test('a corrupt cache is ignored rather than thrown from', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'instruments-bad-'));
    await fs.mkdir(path.join(root, 'data'), { recursive: true });
    await fs.writeFile(path.join(root, 'data', 'instruments.nse.json'), '{ not json');

    scenario += 1;
    const module = await import(`${MODULE}?scenario=${scenario}`);
    // Nothing loaded, so lookups answer empty instead of throwing. (A real boot
    // would fall through to the download; the test does not go to the network.)
    assert.equal(module.isLoaded(), false);
    assert.equal(module.resolve('RELIANCE'), null);
    assert.deepEqual(module.search('RELIANCE'), []);
});
