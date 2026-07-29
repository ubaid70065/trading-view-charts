/**
 * Application wiring.
 *
 * State lives in state.js; every renderer reads from it and redraws on change.
 * The expensive part is the chart iframes, so `reason: 'chrome'` updates skip
 * the pane grid's embed diffing entirely.
 */

import {
    HEAVY_LAYOUT_THRESHOLD, layoutPanes, setLayout, symbolForPane, tickerSettings,
    widgetIntradayProblem,
} from './config.js';
import { createStatus, mountHeader } from './header.js';
import { createPaneGrid } from './panes.js';
import { mountSearch } from './search.js';
import { bindShortcuts } from './shortcuts.js';
import { getState, subscribe, update } from './state.js';
import { attributionElement, embedTicker } from './widget.js';

const tickerHost = document.getElementById('tickerHost');
const panesHost = document.getElementById('panesHost');
const attributionHost = document.getElementById('attributionHost');
const banner = document.getElementById('banner');

const status = createStatus();
let tickerHandle = null;
let tickerSignature = '';
let bannerTimer = null;

/** Transient message strip; chart errors are worth seeing but not sticky. */
function notify(message, { sticky = false } = {}) {
    clearTimeout(bannerTimer);
    banner.textContent = message || '';
    banner.hidden = !message;
    if (message && !sticky) {
        bannerTimer = setTimeout(() => { banner.hidden = true; }, 8000);
    }
}

// --- Renderers ---

const paneGrid = createPaneGrid(panesHost, {
    onActivate(index) {
        if (getState().activePane === index) return;
        update((draft) => { draft.activePane = index; }, { reason: 'chrome' });
    },
    onError: (message) => notify(message, { sticky: true }),
});

const search = mountSearch({
    onSubmit: applySymbol,
    onScope: (value) => setSync('symbol', value),
});

const header = mountHeader({
    onLayout: applyLayout,
    onSync: setSync,
    onTheme: toggleTheme,
});

// --- Actions ---

/**
 * The master search: one typed symbol applied to the layout.
 *
 * Scope follows the symbol sync switch — every pane when it is on, the active
 * pane alone when it is off — so the search box and the layout menu stay one
 * setting rather than two that can contradict each other.
 */
function applySymbol(typed) {
    const symbol = String(typed).trim().toUpperCase();
    if (!symbol) return;

    let skipped = 0;
    const changed = [];

    update((draft) => {
        const targets = draft.sync.symbol
            ? draft.panes
            : [draft.panes[draft.activePane] || draft.panes[0]];

        for (const pane of targets) {
            const next = symbolForPane(pane, symbol);
            // Angel One has no listing for a foreign symbol. Leaving that pane
            // on the symbol it was showing beats blanking it.
            if (next === null) {
                skipped += 1;
                continue;
            }
            pane.symbol = next;
            changed.push(pane);
        }
    }, { reason: 'panes' });

    const notes = [];
    // Catches the BSE / unprefixed intraday combination the widget refuses
    // silently inside the iframe, where there is nothing to click. Any affected
    // pane is worth reporting, not only the active one — with sync on, the
    // active pane can be the one source that is fine.
    const problem = changed.map(widgetIntradayProblem).find(Boolean);
    if (problem) notes.push(problem.message);
    if (skipped > 0) {
        notes.push(skipped === 1
            ? 'One Angel One pane kept its symbol — that source serves NSE listings only.'
            : `${skipped} Angel One panes kept their symbols — that source serves NSE listings only.`);
    }
    if (notes.length > 0) notify(notes.join(' '));
}

function applyLayout(layout) {
    update((draft) => setLayout(draft, layout), { reason: 'panes' });

    const panes = layoutPanes(getState().layout);
    if (panes > HEAVY_LAYOUT_THRESHOLD) {
        notify(`${panes} charts are loading as ${panes} separate frames — this is memory and bandwidth heavy.`);
    }
}

function setSync(key, value) {
    update((draft) => {
        draft.sync[key] = value;
        if (!value) return;
        // Turning sync on levels the panes immediately, rather than waiting for
        // the next edit to reveal that they disagree.
        const source = draft.panes[draft.activePane] || draft.panes[0];
        for (const pane of draft.panes) {
            if (key === 'symbol') pane.symbol = source.symbol;
            if (key === 'interval') pane.interval = source.interval;
        }
    }, { reason: 'panes' });
}

function toggleTheme() {
    update((draft) => {
        draft.theme = draft.theme === 'dark' ? 'light' : 'dark';
    }, { reason: 'panes' });
}

function movePane(delta) {
    update((draft) => {
        const count = layoutPanes(draft.layout);
        draft.activePane = (draft.activePane + delta + count) % count;
    }, { reason: 'chrome' });
}

bindShortcuts({
    onSearch: () => search.focus(),
    onLayout: applyLayout,
    onLayoutMenu: () => document.getElementById('layoutBtn').click(),
    onTheme: toggleTheme,
    onPane: movePane,
    onEscape: () => header.closeMenu(),
});

// --- Ticker tape ---

function renderTicker(state) {
    if (!state.ticker.enabled || state.ticker.symbols.length === 0) {
        if (tickerHandle) {
            tickerHandle.destroy();
            tickerHandle = null;
        }
        tickerSignature = '';
        tickerHost.hidden = true;
        return;
    }

    tickerHost.hidden = false;
    const settings = tickerSettings(state);
    const signature = JSON.stringify(settings);
    if (signature === tickerSignature) return;

    if (tickerHandle) tickerHandle.destroy();
    tickerSignature = signature;
    tickerHandle = embedTicker(tickerHost, settings, {
        onError: () => {
            // The tape is decoration; a failure there must not mask the charts.
            tickerHost.hidden = true;
        },
    });
}

/**
 * The tape is decoration, and it loads a second vendor script and iframe that
 * would otherwise compete with the charts for the connection pool. Holding it
 * until the browser is idle gets the first chart on screen sooner.
 */
const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
let tickerStarted = false;

function startTicker(state) {
    if (tickerStarted) return;
    tickerStarted = true;
    idle(() => renderTicker(state));
}

// --- Render loop ---

function render(state, meta = {}) {
    document.documentElement.dataset.theme = state.theme;
    header.sync(state);
    search.sync(state);

    const pane = state.panes[state.activePane] || state.panes[0];
    attributionHost.replaceChildren(attributionElement(pane.symbol));

    if (meta.reason !== 'chrome') {
        if (tickerStarted) renderTicker(state);
        else startTicker(state);
    }
    // The grid diffs internally, so it is safe to call on every render; a
    // 'chrome' reason still needs it for the active-pane outline.
    paneGrid.render(state);
}

subscribe((state, meta) => render(state, meta));

status.detecting();
render(getState(), { reason: 'panes' });

// The first pane to report in settles the status pill.
panesHost.addEventListener('load', () => status.live(), true);
setTimeout(() => {
    if (panesHost.querySelector('iframe')) status.live();
    else if (!navigator.onLine) status.offline();
}, 4000);
