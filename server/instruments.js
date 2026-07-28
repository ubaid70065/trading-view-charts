/**
 * The NSE instrument master: symbol → token lookup.
 *
 * The published file is ~33 MB and 164k rows across every segment, and takes a
 * few minutes to pull. The browser must never touch it. So it is fetched once,
 * reduced to the rows we care about, and written to disk; later boots read the
 * slim cache. Refresh is daily, because tokens change on corporate actions and
 * new listings appear.
 *
 * Three things about the vendor data drive the shape of this file:
 *
 *   1. Indices appear twice. `Nifty 50` (token 99926000, instrumenttype AMXIDX)
 *      serves both quotes and candles; a second bare `NIFTY` row (token 26000)
 *      serves quotes but returns *no candles at all*. Resolving to the wrong one
 *      gives a chart that loads and then says "no data". Verified against the
 *      live API, not assumed.
 *   2. Index trading symbols are mixed case and contain spaces (`India VIX`),
 *      while every other symbol is upper case. Lookups are therefore folded.
 *   3. `-EQ` is not the only tradable series: `-BE`, `-BZ`, `-SM`, `-ST` and
 *      `-IV` are ~900 more real instruments. The rest of the file is bonds,
 *      state loans and T-bills, which outnumber equities two to one.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const SOURCE_URL =
    'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** Bumped when the row shape changes. Older caches are migrated, not re-downloaded. */
const CACHE_VERSION = 2;

/** Segments kept in the slim cache. */
const KEEP_SEGMENTS = new Set(['NSE', 'BSE']);

/**
 * Series that are actually tradable equity-like instruments, best first. Used
 * both to rank results and to expand a bare ticker: `GVKPIL` → `GVKPIL-BE`.
 */
const TRADABLE_SERIES = ['EQ', 'BE', 'BZ', 'SM', 'ST', 'IV'];

/** Preference when two rows answer to the same name. Lower wins. */
const KIND_RANK = { index: 0, equity: 1, alias: 2, other: 3 };

/** Exchange test scrips. Real to the API, noise to a human searching. */
const TEST_SCRIP = /NSETEST|BSETEST/;

let index = null;         // { builtAt, rows, byToken, bySymbol, byName, haystack }
let loadInFlight = null;

function cacheFile(root) {
    return path.join(root, 'data', 'instruments.nse.json');
}

/** Trailing two-character series code, or '' for indices and every BSE row. */
function seriesOf(symbol) {
    const match = /-([A-Z0-9]{2})$/.exec(symbol);
    return match ? match[1] : '';
}

/** Lower wins when two rows answer to the same key. */
function better(a, b) {
    return (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9)
        || TRADABLE_SERIES.indexOf(a.series) - TRADABLE_SERIES.indexOf(b.series);
}

/**
 * Assigns each row a kind, in a pass of its own because spotting the quote-only
 * index duplicates needs the set of index names first.
 *
 * A note on BSE: it publishes no series code at all — 12,821 of its 12,824 rows
 * are bare — so its debt scrips cannot be told from its equities by any field
 * present here, and all of them land in `equity`. Attempted rules do not hold:
 * `20MICRONS` is a listed company and `GS19MAR2033` is a government bond. NSE,
 * which is what the app charts, is unaffected.
 */
function classify(rows) {
    const indexNames = new Set();
    for (const row of rows) {
        if (row.instrumentType === 'AMXIDX') {
            indexNames.add(`${row.exchange}:${row.name.toUpperCase()}`);
        }
    }

    for (const row of rows) {
        if (row.instrumentType === 'AMXIDX') row.kind = 'index';
        // A non-index row sharing an index's name is the quote-only twin: NSE
        // lists `NIFTY`/26000 beside `Nifty 50`/99926000, and only the latter
        // returns candles.
        else if (indexNames.has(`${row.exchange}:${row.name.toUpperCase()}`)) row.kind = 'alias';
        else if (!row.series) row.kind = 'equity';
        else row.kind = TRADABLE_SERIES.includes(row.series) ? 'equity' : 'other';
    }
    return rows;
}

/** Vendor `tick_size` is in paise (500 → ₹5.00). Charts need rupees. */
function tickToRupees(paise) {
    const value = Number(paise);
    return Number.isFinite(value) && value > 0 ? value / 100 : 0;
}

function canonical({ token, symbol, name, exchange, instrumentType, lotSize, tickSize }) {
    return {
        token: String(token),
        symbol,                      // trading symbol, e.g. RELIANCE-EQ or 'Nifty 50'
        name,                        // plain name, e.g. RELIANCE or NIFTY
        exchange,
        series: seriesOf(symbol),
        kind: '',                    // filled by classify(), which needs every row
        instrumentType: instrumentType || '',
        lotSize: lotSize > 0 ? lotSize : 1,
        tickSize,                    // rupees
    };
}

/** Reduces a vendor row to what lookups and display need. */
function fromVendor(row) {
    return canonical({
        token: row.token,
        symbol: row.symbol,
        name: row.name,
        exchange: row.exch_seg,
        instrumentType: row.instrumenttype,
        lotSize: Number(row.lotsize),
        tickSize: tickToRupees(row.tick_size),
    });
}

/**
 * Re-derives a canonical row from one written by an older build, so a schema
 * change costs a re-read rather than another three-minute download. Everything
 * needed survived: v1 coerced an empty `instrumenttype` to 'EQ', but 'AMXIDX'
 * came through intact and the series is recoverable from the symbol.
 */
function fromCache(row, version) {
    return canonical({
        token: row.token,
        symbol: row.symbol,
        name: row.name,
        exchange: row.exchange,
        // v1's 'EQ' was a default, not a fact; only the index marker is trusted.
        instrumentType: row.instrumentType === 'AMXIDX' ? 'AMXIDX' : '',
        lotSize: Number(row.lotSize),
        tickSize: version >= 2 ? Number(row.tickSize) || 0 : tickToRupees(row.tickSize),
    });
}

function buildIndex(unclassified, builtAt) {
    const rows = classify(unclassified);

    const byToken = new Map();
    const bySymbol = new Map();
    const byName = new Map();
    const haystack = [];

    // Names collide across the duplicate index rows ('NIFTY' is both 99926000
    // and 26000), so the better row wins rather than whichever came last.
    const claim = (map, key, row) => {
        const held = map.get(key);
        if (!held || better(row, held) < 0) map.set(key, row);
    };

    for (const row of rows) {
        const symbolUpper = row.symbol.toUpperCase();
        const nameUpper = row.name.toUpperCase();

        byToken.set(`${row.exchange}:${row.token}`, row);
        claim(bySymbol, `${row.exchange}:${symbolUpper}`, row);
        claim(byName, `${row.exchange}:${nameUpper}`, row);

        haystack.push({ row, symbolUpper, nameUpper });
    }

    return { builtAt, rows, byToken, bySymbol, byName, haystack };
}

async function readCache(root) {
    try {
        const raw = await fs.readFile(cacheFile(root), 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.rows)) return null;
        if (Date.now() - parsed.builtAt > CACHE_TTL_MS) return null;

        const version = Number(parsed.version) || 1;
        const rows = parsed.rows.map((row) => fromCache(row, version));
        const built = buildIndex(rows, parsed.builtAt);

        if (version !== CACHE_VERSION) {
            console.log(`[instruments] migrated cache v${version} → v${CACHE_VERSION}`);
            await writeCache(root, built);
        }
        return built;
    } catch {
        return null;
    }
}

async function writeCache(root, built) {
    try {
        await fs.mkdir(path.dirname(cacheFile(root)), { recursive: true });
        await fs.writeFile(
            cacheFile(root),
            JSON.stringify({ version: CACHE_VERSION, builtAt: built.builtAt, rows: built.rows }),
        );
    } catch (error) {
        console.warn('[instruments] could not write cache:', error.message);
    }
}

async function download(root) {
    console.log('[instruments] downloading scrip master (~33 MB, this takes a few minutes)…');
    const started = Date.now();

    const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`scrip master returned HTTP ${response.status}`);

    const all = await response.json();
    if (!Array.isArray(all)) throw new Error('scrip master was not an array');

    const rows = all.filter((row) => KEEP_SEGMENTS.has(row.exch_seg)).map(fromVendor);
    const built = buildIndex(rows, Date.now());

    console.log(`[instruments] ${all.length} rows → ${rows.length} kept in `
        + `${Math.round((Date.now() - started) / 1000)}s`);

    await writeCache(root, built);
    return built;
}

/**
 * Loads the index, preferring a fresh on-disk cache. Concurrent callers share
 * one download.
 */
export function loadInstruments(root) {
    if (index) return Promise.resolve(index);
    if (loadInFlight) return loadInFlight;

    loadInFlight = (async () => {
        try {
            index = (await readCache(root)) || (await download(root));
            return index;
        } finally {
            // Cleared either way, so a failed download can be retried.
            loadInFlight = null;
        }
    })();

    return loadInFlight;
}

export function isLoaded() {
    return index !== null;
}

export function stats() {
    if (!index) return { loaded: false };
    const bySegment = {};
    const byKind = {};
    for (const row of index.rows) {
        bySegment[row.exchange] = (bySegment[row.exchange] || 0) + 1;
        byKind[row.kind] = (byKind[row.kind] || 0) + 1;
    }
    return {
        loaded: true,
        builtAt: new Date(index.builtAt).toISOString(),
        total: index.rows.length,
        bySegment,
        byKind,
    };
}

/**
 * Exact lookup. Accepts a trading symbol (`NSE:RELIANCE-EQ`, `Nifty 50`), a
 * plain name (`RELIANCE`, `BANKNIFTY`, `INDIA VIX`) or a token.
 *
 * The symbol and name indexes are both consulted and the better row wins, which
 * is not the same as trying one then the other: `NIFTY` is the *trading symbol*
 * of the quote-only twin and the *name* of the chartable index, so a
 * first-match-wins order silently returns the row that yields no candles.
 */
export function resolve(query, exchange = 'NSE') {
    if (!index) return null;

    const raw = String(query || '').trim().toUpperCase();
    if (!raw) return null;

    const [seg, rest] = raw.includes(':')
        ? [raw.slice(0, raw.indexOf(':')), raw.slice(raw.indexOf(':') + 1)]
        : [exchange, raw];

    const bySymbol = index.bySymbol.get(`${seg}:${rest}`);
    const byName = index.byName.get(`${seg}:${rest}`);
    if (bySymbol && byName) return better(bySymbol, byName) <= 0 ? bySymbol : byName;
    if (bySymbol || byName) return bySymbol || byName;

    // Cash equities carry a series suffix that people leave off.
    for (const series of TRADABLE_SERIES) {
        const row = index.bySymbol.get(`${seg}:${rest}-${series}`);
        if (row) return row;
    }

    return index.byToken.get(`${seg}:${rest}`) || null;
}

/**
 * Substring search, ranked so an exact ticker beats a prefix, which beats a
 * mid-string hit; within a tie, indices and cash equities float above the
 * thinner series.
 *
 * `tradableOnly` (the default) hides the ~14k bonds, state development loans,
 * T-bills and mutual-fund units that would otherwise bury every real result.
 */
export function search(query, { exchange = 'NSE', limit = 30, tradableOnly = true } = {}) {
    if (!index) return [];

    const needle = String(query || '').trim().toUpperCase();

    const rank = ({ row, symbolUpper, nameUpper }) => {
        if (nameUpper === needle || symbolUpper === needle) return 0;
        if (nameUpper.startsWith(needle) || symbolUpper.startsWith(needle)) return 1;
        return 2;
    };

    const tiebreak = (row) => (KIND_RANK[row.kind] ?? 9) * 10
        + (row.series ? TRADABLE_SERIES.indexOf(row.series) + 1 : 0);

    return index.haystack
        .filter((entry) => {
            const { row, symbolUpper, nameUpper } = entry;
            if (exchange && row.exchange !== exchange) return false;
            if (tradableOnly) {
                if (row.kind !== 'index' && row.kind !== 'equity') return false;
                if (TEST_SCRIP.test(nameUpper)) return false;
            }
            if (!needle) return true;
            return nameUpper.includes(needle) || symbolUpper.includes(needle);
        })
        .sort((a, b) => rank(a) - rank(b)
            || tiebreak(a.row) - tiebreak(b.row)
            || a.row.name.localeCompare(b.row.name))
        .slice(0, limit)
        .map((entry) => entry.row);
}
