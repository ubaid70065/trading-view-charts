/**
 * Widget contracts and default workspace configuration.
 *
 * Both embed scripts filter the JSON you give them against an internal
 * whitelist and silently drop everything else, which is why unfamiliar options
 * appear to do nothing. Both whitelists below were read out of the vendor
 * scripts themselves rather than from documentation.
 */

export const CHART_SCRIPT_URL =
    'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';

export const TICKER_SCRIPT_URL =
    'https://s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js';

/**
 * Keys accepted by embed-widget-advanced-chart.js.
 * `enable_publishing`, `calendar` and `toolbar_bg` — common in older snippets —
 * are deliberately absent: the widget does not accept them.
 */
export const CHART_KEYS = [
    'container_id', 'symbol', 'interval', 'timezone', 'theme', 'style', 'locale',
    'allow_symbol_change', 'backgroundColor', 'gridColor', 'autosize', 'width', 'height',
    'hide_volume', 'whitelabel', 'range', 'hide_top_toolbar', 'hide_side_toolbar',
    'hide_legend', 'save_image', 'watchlist', 'editablewatchlist', 'studies',
    'extended_hours', 'details', 'hotlist', 'hideideasbutton', 'widgetbar_width',
    'withdateranges', 'customer', 'venue', 'symbology', 'show_popup_button',
    'popup_height', 'popup_width', 'studies_overrides', 'overrides', 'enabled_features',
    'disabled_features', 'publish_source', 'whotrades', 'referral_id', 'no_referral_id',
    'fundamental', 'percentage', 'padding', 'greyText', 'horztouchdrag', 'verttouchdrag',
    'support_host', 'compareSymbols',
];

/** Keys accepted by embed-widget-ticker-tape.js. Note: no width/height/autosize. */
export const TICKER_KEYS = [
    'symbols', 'locale', 'showSymbolLogo', 'colorTheme', 'isTransparent',
    'largeChartUrl', 'displayMode', 'customer',
];

/** Time zones the widget understands; anything else falls back to the exchange zone. */
export const TIMEZONES = [
    'Etc/UTC',
    'Africa/Cairo', 'Africa/Casablanca', 'Africa/Johannesburg', 'Africa/Lagos', 'Africa/Nairobi',
    'Africa/Tunis', 'America/Anchorage', 'America/Argentina/Buenos_Aires', 'America/Bogota',
    'America/Caracas', 'America/Chicago', 'America/El_Salvador', 'America/Juneau', 'America/Lima',
    'America/Los_Angeles', 'America/Mexico_City', 'America/New_York', 'America/Phoenix',
    'America/Santiago', 'America/Sao_Paulo', 'America/Toronto', 'America/Vancouver', 'Asia/Almaty',
    'Asia/Ashkhabad', 'Asia/Bahrain', 'Asia/Bangkok', 'Asia/Chongqing', 'Asia/Colombo', 'Asia/Dubai',
    'Asia/Ho_Chi_Minh', 'Asia/Hong_Kong', 'Asia/Jakarta', 'Asia/Jerusalem', 'Asia/Karachi',
    'Asia/Kathmandu', 'Asia/Kolkata', 'Asia/Kuwait', 'Asia/Manila', 'Asia/Muscat', 'Asia/Nicosia',
    'Asia/Qatar', 'Asia/Riyadh', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Taipei',
    'Asia/Tehran', 'Asia/Tokyo', 'Asia/Yangon', 'Atlantic/Reykjavik', 'Australia/Adelaide',
    'Australia/Brisbane', 'Australia/Perth', 'Australia/Sydney', 'Europe/Amsterdam',
    'Europe/Athens', 'Europe/Belgrade', 'Europe/Berlin', 'Europe/Bratislava', 'Europe/Brussels',
    'Europe/Bucharest', 'Europe/Budapest', 'Europe/Copenhagen', 'Europe/Dublin', 'Europe/Helsinki',
    'Europe/Istanbul', 'Europe/Lisbon', 'Europe/London', 'Europe/Luxembourg', 'Europe/Madrid',
    'Europe/Malta', 'Europe/Moscow', 'Europe/Oslo', 'Europe/Paris', 'Europe/Riga', 'Europe/Rome',
    'Europe/Stockholm', 'Europe/Tallinn', 'Europe/Vilnius', 'Europe/Warsaw', 'Europe/Zurich',
    'Pacific/Auckland', 'Pacific/Chatham', 'Pacific/Fakaofo', 'Pacific/Honolulu', 'Pacific/Norfolk',
];

const TIMEZONE_SET = new Set(TIMEZONES);

/** Windows and older ICU builds still report deprecated zone names. */
const TIMEZONE_ALIASES = {
    'Asia/Calcutta': 'Asia/Kolkata',
    'Asia/Katmandu': 'Asia/Kathmandu',
    'Asia/Rangoon': 'Asia/Yangon',
    'Asia/Saigon': 'Asia/Ho_Chi_Minh',
    'Asia/Istanbul': 'Europe/Istanbul',
    'Asia/Ashgabat': 'Asia/Ashkhabad',
    'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
    'Europe/Kiev': 'Europe/Bucharest',
    'Europe/Kyiv': 'Europe/Bucharest',
    'US/Eastern': 'America/New_York',
    'US/Central': 'America/Chicago',
    'US/Pacific': 'America/Los_Angeles',
    'UTC': 'Etc/UTC',
    'Etc/GMT': 'Etc/UTC',
};

export function detectTimezone() {
    try {
        const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (!detected) return 'Etc/UTC';
        const normalised = TIMEZONE_ALIASES[detected] || detected;
        return TIMEZONE_SET.has(normalised) ? normalised : 'Etc/UTC';
    } catch {
        return 'Etc/UTC';
    }
}

/*
 * ---------------------------------------------------------------------------
 * Layout catalogue
 * ---------------------------------------------------------------------------
 * A layout is described by a split direction and a list of band sizes, not by a
 * hand-drawn icon:
 *
 *   kind 'rows', spec [2, 1]  →  two panes on the top row, one across the bottom
 *   kind 'cols', spec [1, 2]  →  one pane down the left, two stacked on the right
 *
 * The CSS grid and the menu icon are both generated from that spec, so an icon
 * cannot drift out of step with the layout it selects, and adding an
 * arrangement is one line.
 */

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
const lcm = (a, b) => (a * b) / gcd(a, b);

const ones = (n) => Array.from({ length: n }, () => 1);

/** `r:2-1`, `c:1-2` — stable across releases, so persisted state keeps working. */
function layoutId(kind, spec) {
    return `${kind === 'rows' ? 'r' : 'c'}:${spec.join('-')}`;
}

function makeLayout(kind, spec) {
    return { id: layoutId(kind, spec), kind, spec, panes: spec.reduce((a, b) => a + b, 0) };
}

/** Grouped exactly as the picker renders them: by pane count. */
export const LAYOUT_GROUPS = [
    { count: 1, layouts: [['rows', [1]]] },
    { count: 2, layouts: [['cols', [1, 1]], ['rows', [1, 1]]] },
    {
        count: 3,
        layouts: [
            ['cols', [1, 1, 1]], ['rows', [1, 1, 1]],
            ['cols', [1, 2]], ['cols', [2, 1]],
            ['rows', [2, 1]], ['rows', [1, 2]],
        ],
    },
    {
        count: 4,
        layouts: [
            ['rows', [2, 2]], ['rows', ones(4)], ['cols', ones(4)],
            ['cols', [1, 3]], ['cols', [3, 1]],
            ['rows', [1, 3]], ['rows', [3, 1]],
            ['cols', [1, 1, 2]], ['cols', [2, 1, 1]], ['rows', [1, 2, 1]],
        ],
    },
    {
        count: 5,
        layouts: [
            ['rows', [2, 3]], ['rows', [3, 2]],
            ['cols', ones(5)], ['rows', ones(5)],
            ['cols', [1, 4]], ['cols', [4, 1]],
            ['rows', [1, 4]], ['rows', [4, 1]],
            ['cols', [2, 3]], ['cols', [3, 2]],
        ],
    },
    {
        count: 6,
        layouts: [
            ['rows', [3, 3]], ['rows', [2, 2, 2]],
            ['cols', ones(6)], ['rows', ones(6)],
            ['cols', [1, 5]], ['rows', [1, 5]],
        ],
    },
    { count: 7, layouts: [['rows', [3, 4]], ['cols', ones(7)], ['cols', [1, 6]]] },
    {
        count: 8,
        layouts: [
            ['rows', [4, 4]], ['rows', [2, 2, 2, 2]],
            ['cols', ones(8)], ['rows', ones(8)],
        ],
    },
    {
        count: 9,
        layouts: [
            ['rows', [3, 3, 3]], ['rows', [4, 5]],
            ['cols', ones(9)], ['rows', ones(9)],
        ],
    },
    { count: 10, layouts: [['rows', [5, 5]], ['cols', ones(10)], ['rows', ones(10)]] },
    { count: 12, layouts: [['rows', [4, 4, 4]], ['rows', [3, 3, 3, 3]], ['cols', ones(12)]] },
    { count: 14, layouts: [['rows', [7, 7]]] },
    { count: 16, layouts: [['rows', [4, 4, 4, 4]], ['rows', [8, 8]]] },
].map((group) => ({
    count: group.count,
    layouts: group.layouts.map(([kind, spec]) => makeLayout(kind, spec)),
}));

export const LAYOUTS = LAYOUT_GROUPS.flatMap((group) => group.layouts);

const LAYOUT_BY_ID = new Map(LAYOUTS.map((layout) => [layout.id, layout]));

/** Pane counts above this load a lot of iframes at once; worth warning about. */
export const HEAVY_LAYOUT_THRESHOLD = 8;

/** Ids used before the catalogue existed. */
const LEGACY_LAYOUT_IDS = {
    '1': 'r:1',
    '2h': 'c:1-1',
    '2v': 'r:1-1',
    '3': 'c:1-2',
    '4': 'r:2-2',
};

export function layoutById(id) {
    return LAYOUT_BY_ID.get(LEGACY_LAYOUT_IDS[id] || id) || LAYOUT_BY_ID.get('r:1');
}

export function layoutPanes(id) {
    return layoutById(id).panes;
}

export function normaliseLayoutId(id) {
    return layoutById(id).id;
}

export function layoutLabel(layout) {
    const { kind, spec, panes } = layout;
    if (panes === 1) return 'Single chart';
    const uniform = spec.every((band) => band === 1);
    if (uniform) return kind === 'cols' ? `${panes} columns` : `${panes} rows`;
    const bands = spec.join(' + ');
    return kind === 'rows' ? `${panes} charts, rows of ${bands}` : `${panes} charts, columns of ${bands}`;
}

/**
 * Turns a spec into concrete grid placement.
 *
 * Bands are given a common denominator so uneven splits (a row of 2 above a row
 * of 3) still line up on one grid: 6 columns, spanned 3 and 2.
 *
 * @returns {{cols: number, rows: number, cells: Array<{col: number, row: number, colSpan: number, rowSpan: number}>}}
 */
export function layoutGeometry(layout) {
    const { kind, spec } = layout;
    const denominator = spec.reduce((acc, band) => lcm(acc, band), 1);
    const cells = [];

    if (kind === 'rows') {
        spec.forEach((band, rowIndex) => {
            const span = denominator / band;
            for (let i = 0; i < band; i += 1) {
                cells.push({ col: i * span + 1, row: rowIndex + 1, colSpan: span, rowSpan: 1 });
            }
        });
        return { cols: denominator, rows: spec.length, cells };
    }

    spec.forEach((band, colIndex) => {
        const span = denominator / band;
        for (let i = 0; i < band; i += 1) {
            cells.push({ col: colIndex + 1, row: i * span + 1, colSpan: 1, rowSpan: span });
        }
    });
    return { cols: spec.length, rows: denominator, cells };
}

/** Builds the menu icon from the same geometry the grid uses. */
export function layoutIconSvg(layout, size = 22) {
    const { cols, rows, cells } = layoutGeometry(layout);
    const gap = 1;
    const parts = cells.map((cell) => {
        const x = (cell.col - 1) / cols * size + gap / 2;
        const y = (cell.row - 1) / rows * size + gap / 2;
        const w = (cell.colSpan / cols) * size - gap;
        const h = (cell.rowSpan / rows) * size - gap;
        return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(w, 0.5).toFixed(2)}" height="${Math.max(h, 0.5).toFixed(2)}" rx="0.75"/>`;
    });
    return `<svg viewBox="-0.5 -0.5 ${size + 1} ${size + 1}" width="${size}" height="${size}" `
        + `fill="none" stroke="currentColor" stroke-width="1.1" aria-hidden="true">${parts.join('')}</svg>`;
}

export const INTERVALS = [
    { value: '1', label: '1m' },
    { value: '3', label: '3m' },
    { value: '5', label: '5m' },
    { value: '15', label: '15m' },
    { value: '30', label: '30m' },
    { value: '60', label: '1h' },
    { value: '120', label: '2h' },
    { value: '240', label: '4h' },
    { value: 'D', label: '1D' },
    { value: 'W', label: '1W' },
    { value: 'M', label: '1M' },
];

/** '3' → '3m'. Unknown values are shown as given rather than blanked. */
export function intervalLabel(value) {
    const found = INTERVALS.find((item) => item.value === value);
    return found ? found.label : value;
}

/** Intervals every TradingView symbol can serve; the rest are intraday. */
const CONTINUOUS_INTERVALS = ['D', 'W', 'M'];

/**
 * The free embed widget refuses intraday intervals for BSE end-of-day listings
 * inside the cross-origin iframe, so the app warns before rebuilding the pane.
 *
 * @returns {null | {ticker: string, message: string}} null when the combination is fine.
 */
export function widgetIntradayProblem({ source, symbol, interval }) {
    if (source !== 'tv') return null;
    if (CONTINUOUS_INTERVALS.includes(interval)) return null;

    const typed = String(symbol || '').trim().toUpperCase();
    if (!typed) return null;

    const colon = typed.indexOf(':');
    const prefix = colon === -1 ? '' : typed.slice(0, colon);
    const ticker = colon === -1 ? typed : typed.slice(colon + 1);
    const label = intervalLabel(interval);

    if (prefix === 'BSE') {
        return {
            ticker,
            message: `BSE charts are end-of-day on the free widget, so ${label} will not load `
                + '— the chart reports "Only D, W, M intervals are available". NSE is '
                + `real-time on the same free widget, so NSE:${ticker} fixes this and keeps `
                + 'the indicators and drawing tools.',
        };
    }

    if (prefix === '') {
        return {
            ticker,
            message: `"${typed}" has no exchange prefix, so TradingView picks the listing itself `
                + '— for a dual-listed Indian stock usually the BSE one, whose charts are '
                + `end-of-day and refuse ${label}. NSE:${typed} is real-time on the free `
                + 'widget and keeps the full toolbar.',
        };
    }

    return null;
}

export const STYLES = [
    { value: '1', label: 'Candles' },
    { value: '9', label: 'Hollow candles' },
    { value: '8', label: 'Heikin Ashi' },
    { value: '0', label: 'Bars' },
    { value: '2', label: 'Line' },
    { value: '3', label: 'Area' },
    { value: '10', label: 'Baseline' },
];

export const RANGES = [
    { value: '', label: 'Default' },
    { value: '1D', label: '1 day' },
    { value: '5D', label: '5 days' },
    { value: '1M', label: '1 month' },
    { value: '3M', label: '3 months' },
    { value: '6M', label: '6 months' },
    { value: 'YTD', label: 'Year to date' },
    { value: '12M', label: '12 months' },
    { value: '60M', label: '5 years' },
    { value: 'ALL', label: 'All time' },
];

export const STUDIES = [
    { value: 'STD;SMA', label: 'Moving Average' },
    { value: 'STD;EMA', label: 'Moving Average Exponential' },
    { value: 'STD;Bollinger_Bands', label: 'Bollinger Bands' },
    { value: 'STD;RSI', label: 'Relative Strength Index' },
    { value: 'STD;MACD', label: 'MACD' },
    { value: 'STD;Stochastic_RSI', label: 'Stochastic RSI' },
    { value: 'STD;Average%1True%1Range', label: 'Average True Range' },
    { value: 'STD;VWAP', label: 'VWAP' },
];

export const CHART_TOGGLES = [
    { key: 'withdateranges', label: 'Date range tabs' },
    { key: 'extended_hours', label: 'Extended hours' },
    { key: 'hide_volume', label: 'Hide volume' },
    { key: 'hide_side_toolbar', label: 'Hide drawing tools' },
    { key: 'hide_top_toolbar', label: 'Hide chart toolbar' },
    { key: 'hide_legend', label: 'Hide legend' },
];

export const PANEL_TOGGLES = [
    { key: 'watchlist', label: 'Watchlist' },
    { key: 'details', label: 'Symbol details' },
    { key: 'hotlist', label: 'Movers' },
];

export const LOCALES = [
    'en', 'ar', 'ca_ES', 'de', 'es', 'fa', 'fr', 'he_IL', 'hu_HU', 'id_ID', 'it', 'ja', 'ko',
    'ms_MY', 'nl_NL', 'pl', 'pt', 'ru', 'sv', 'th', 'tr', 'vi', 'zh_CN', 'zh_TW',
];

/**
 * Shipped defaults. Everything here is persisted.
 *
 * One flat workspace: the header search, the layout picker and the theme toggle
 * are the whole surface, so there is no tab list and nothing here is nested
 * behind one.
 */
/**
 * What a pane shows before anything is typed.
 *
 * Exchange-qualified on purpose. Bare `BTCUSD` resolves too, but TradingView
 * picks the listing — currently Bitstamp, whose tick size is 1, so prices
 * render rounded to whole dollars. Naming Coinbase pins a real BTC/USD pair
 * with cent precision and keeps the default stable if TradingView re-ranks.
 */
export const DEFAULT_SYMBOL = 'COINBASE:BTCUSD';

export function defaultState() {
    return {
        version: 2,
        theme: 'dark',
        // Propagate a symbol change to every pane in the layout. Symbol sync
        // ships on: it is what makes the header search a master control rather
        // than an edit box for whichever pane was clicked last.
        sync: { symbol: true, interval: false },
        layout: 'c:1-1',
        panes: createPanes('c:1-1', DEFAULT_SYMBOL, 'D'),
        activePane: 0,
        chart: {
            locale: 'en',
            timezone: detectTimezone(),
            range: '',
            studies: [],
            withdateranges: true,
            extended_hours: false,
            hide_volume: false,
            hide_side_toolbar: false,
            hide_top_toolbar: false,
            hide_legend: false,
        },
        panel: {
            watchlist: true,
            details: true,
            hotlist: false,
            symbols: ['NASDAQ:AAPL', 'NASDAQ:GOOGL', 'NASDAQ:MSFT', 'NASDAQ:AMZN'],
        },
        ticker: {
            enabled: false,
            symbols: [
                { proName: 'FOREXCOM:SPXUSD', title: 'S&P 500' },
                { proName: 'FOREXCOM:NSXUSD', title: 'US 100' },
                { proName: 'NASDAQ:AAPL', title: 'Apple' },
                { proName: 'FX_IDC:EURUSD', title: 'EUR/USD' },
                { proName: 'BITSTAMP:BTCUSD', title: 'Bitcoin' },
                { proName: 'BITSTAMP:ETHUSD', title: 'Ethereum' },
            ],
        },
    };
}

/**
 * Where a pane gets its data.
 *
 *  'tv'     — TradingView's embed widget. Their data, their full UI.
 *  'tvfeed' — TradingView's widget socket via this app's /tv routes, drawn with
 *             Lightweight Charts. Every exchange the embed carries, but on a
 *             canvas this app owns — so panes can be linked, themed and read.
 *             Undocumented upstream; see server/tvfeed.js.
 *  'advanced' — the Advanced Charts library over the same /tv routes. The full
 *             TradingView UI, in-page and driveable. Needs the licensed library
 *             to be installed; the pane says so when it is not.
 */
export const PANE_SOURCES = [
    { value: 'tv', label: 'TradingView widget' },
    { value: 'tvfeed', label: 'TradingView feed' },
    { value: 'advanced', label: 'Advanced Charts' },
];

/**
 * The form a typed symbol has to take for a pane.
 *
 * Every source now speaks the same dialect — EXCHANGE:TICKER, as TradingView
 * writes it — so this only normalises. It stays a function because the search
 * box needs one place to reject an empty entry, and because a source with its
 * own spelling can be added back here rather than at every call site.
 *
 * @param {{source?: string}} pane
 * @param {string} typed
 * @returns {string|null} null when there is nothing to show.
 */
export function symbolForPane(pane, typed) {
    const symbol = String(typed || '').trim().toUpperCase();
    return symbol || null;
}

export function createPanes(layout, symbol = DEFAULT_SYMBOL, interval = 'D') {
    const count = layoutPanes(layout);
    return Array.from({ length: count }, () => ({ symbol, interval, style: '1', source: 'tv' }));
}

/**
 * Grows or shrinks the pane list to match a new layout.
 *
 * @param {object} workspace The state draft — panes live directly on it.
 * @param {string} layout    Catalogue id.
 */
export function setLayout(workspace, layout) {
    const id = normaliseLayoutId(layout);
    const count = layoutPanes(id);
    // New panes inherit the active pane so a split does not blank the screen.
    const template = workspace.panes[workspace.activePane] || workspace.panes[0];
    while (workspace.panes.length < count) {
        workspace.panes.push({ ...template });
    }
    workspace.panes.length = count;
    workspace.layout = id;
    workspace.activePane = Math.min(workspace.activePane, count - 1);
}

/** Filters an object down to keys the target widget actually accepts. */
function pick(source, keys) {
    const result = {};
    for (const key of keys) {
        const value = source[key];
        if (value === undefined || value === null) continue;
        if (value === '' || (Array.isArray(value) && value.length === 0)) continue;
        result[key] = Array.isArray(value) ? [...value] : value;
    }
    return result;
}

/**
 * Builds the settings for one chart pane.
 *
 * @param {object} state       Whole app state.
 * @param {object} pane        { symbol, interval, style }
 * @param {boolean} withPanel  Whether this pane carries the watchlist/details bar.
 */
export function chartSettings(state, pane, withPanel) {
    const light = state.theme === 'light';
    const draft = {
        ...state.chart,
        symbol: pane.symbol,
        interval: pane.interval,
        style: pane.style,
        theme: state.theme,
        autosize: true,
        allow_symbol_change: true,
        save_image: true,
        support_host: 'https://www.tradingview.com',
        backgroundColor: light ? '#ffffff' : '#0f1116',
        gridColor: light ? 'rgba(42, 46, 57, 0.06)' : 'rgba(242, 242, 242, 0.06)',
    };

    if (withPanel) {
        if (state.panel.watchlist && state.panel.symbols.length > 0) {
            draft.watchlist = state.panel.symbols;
        }
        draft.details = Boolean(state.panel.details);
        draft.hotlist = Boolean(state.panel.hotlist);
    }

    const settings = pick(draft, CHART_KEYS);
    // Booleans that are meaningful when false must survive the empty-value filter.
    for (const key of ['details', 'hotlist', 'withdateranges', 'extended_hours',
        'hide_volume', 'hide_side_toolbar', 'hide_top_toolbar', 'hide_legend']) {
        if (draft[key] !== undefined) settings[key] = Boolean(draft[key]);
    }
    settings.autosize = true;
    return settings;
}

/** Builds the settings for the ticker tape. */
export function tickerSettings(state) {
    return pick({
        symbols: state.ticker.symbols,
        locale: state.chart.locale,
        showSymbolLogo: true,
        colorTheme: state.theme,
        isTransparent: true,
        displayMode: 'adaptive',
    }, TICKER_KEYS);
}
