/**
 * Workspace state with localStorage persistence and a tiny subscription model.
 *
 * Consumers mutate through `update()` and re-render from the change event, so
 * persistence happens in exactly one place.
 *
 * The workspace is flat — one layout, one pane list. v1 stored an array of tabs;
 * the tab strip is gone, so a v1 payload is lifted to the tab that was active.
 */

import { createPanes, defaultState, layoutPanes, normaliseLayoutId } from './config.js';

const KEY = 'tv:workspace:v2';
const LEGACY_KEY = 'tv:workspace:v1';

let state = load();
const listeners = new Set();

function load() {
    try {
        const stored = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (stored && stored.version === 2) return repair(stored);

        const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
        if (legacy && legacy.version === 1) return repair(fromTabs(legacy));

        return defaultState();
    } catch {
        return defaultState();
    }
}

/** Lifts the active tab of a v1 payload onto the flat workspace. */
function fromTabs(stored) {
    const tabs = Array.isArray(stored.tabs) ? stored.tabs : [];
    const found = tabs.find((item) => item && item.id === stored.activeTabId) || tabs[0];
    const tab = found && typeof found === 'object' ? found : {};
    const { tabs: _tabs, activeTabId: _active, ...rest } = stored;
    return {
        ...rest,
        version: 2,
        layout: tab.layout,
        panes: tab.panes,
        activePane: tab.activePane,
    };
}

/** Repairs anything missing so an older or hand-edited payload cannot break boot. */
function repair(stored) {
    const base = defaultState();
    const next = {
        ...base,
        ...stored,
        version: 2,
        chart: { ...base.chart, ...(stored.chart || {}) },
        panel: { ...base.panel, ...(stored.panel || {}) },
        ticker: { ...base.ticker, ...(stored.ticker || {}) },
        sync: { ...base.sync, ...(stored.sync || {}) },
    };

    // Rewrites the pre-catalogue ids ('2h', '4', …) to catalogue ids.
    next.layout = normaliseLayoutId(next.layout || 'r:1');
    const count = layoutPanes(next.layout);

    const panes = Array.isArray(next.panes) ? next.panes.slice(0, count) : [];
    while (panes.length < count) panes.push(createPanes('r:1')[0]);
    next.panes = panes.map((slot) => {
        // A null or non-object pane must not take the workspace down with it:
        // this runs inside load()'s try, so one bad entry would otherwise
        // discard the layout, the watchlist and the ticker along with it.
        const pane = slot && typeof slot === 'object' ? slot : {};
        return {
            symbol: pane.symbol || 'NASDAQ:AAPL',
            interval: pane.interval || 'D',
            style: pane.style || '1',
            // Panes saved before a source existed default to the widget.
            source: ['nse', 'tvfeed', 'advanced'].includes(pane.source) ? pane.source : 'tv',
        };
    });

    // A non-integer activePane would poison Math.min/max with NaN.
    const active = Number(next.activePane);
    next.activePane = Number.isFinite(active)
        ? Math.min(Math.max(0, Math.trunc(active)), count - 1)
        : 0;
    // Dropped with the maximise button. A workspace saved while a pane was
    // maximised would otherwise still be showing that one pane, with nothing
    // left in the UI to restore the layout.
    delete next.maximised;

    if (!Array.isArray(next.panel.symbols)) next.panel.symbols = base.panel.symbols;
    if (!Array.isArray(next.ticker.symbols)) next.ticker.symbols = base.ticker.symbols;
    if (!Array.isArray(next.chart.studies)) next.chart.studies = [];

    return next;
}

function persist() {
    try {
        localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
        // Losing persistence is acceptable; losing the session is not.
    }
}

export function getState() {
    return state;
}

export function activePane() {
    return state.panes[state.activePane] || state.panes[0];
}

/**
 * Applies a mutation and notifies listeners.
 *
 * @param {(draft: object) => void} mutator
 * @param {{ reason?: string }} [meta] Lets renderers decide how much to redraw;
 *   'panes' means the embeds must be rebuilt, 'chrome' means only UI around them.
 */
export function update(mutator, meta = {}) {
    mutator(state);
    persist();
    for (const listener of listeners) listener(state, meta);
}

export function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
