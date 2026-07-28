/**
 * Workspace state with localStorage persistence and a tiny subscription model.
 *
 * Consumers mutate through `update()` and re-render from the change event, so
 * persistence happens in exactly one place.
 */

import { createTab, defaultState, layoutPanes, normaliseLayoutId } from './config.js';

const KEY = 'tv:workspace:v1';

let state = load();
const listeners = new Set();

function load() {
    try {
        const stored = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (!stored || stored.version !== 1) return defaultState();
        return migrate(stored);
    } catch {
        return defaultState();
    }
}

/** Repairs anything missing so an older or hand-edited payload cannot break boot. */
function migrate(stored) {
    const base = defaultState();
    const next = {
        ...base,
        ...stored,
        chart: { ...base.chart, ...(stored.chart || {}) },
        panel: { ...base.panel, ...(stored.panel || {}) },
        ticker: { ...base.ticker, ...(stored.ticker || {}) },
        sync: { ...base.sync, ...(stored.sync || {}) },
    };

    if (!Array.isArray(next.tabs) || next.tabs.length === 0) {
        next.tabs = base.tabs;
    }

    next.tabs = next.tabs.map((entry, index) => {
        // A null or non-object entry must not take the rest down with it: this
        // runs inside load()'s try, so one bad tab would otherwise discard every
        // other tab, the watchlist and the ticker along with it.
        const tab = entry && typeof entry === 'object' ? entry : {};
        // Rewrites the pre-catalogue ids ('2h', '4', …) to catalogue ids.
        const layout = normaliseLayoutId(tab.layout || 'r:1');
        const count = layoutPanes(layout);
        const panes = Array.isArray(tab.panes) ? tab.panes.slice(0, count) : [];
        while (panes.length < count) {
            panes.push({ symbol: 'NASDAQ:AAPL', interval: 'D', style: '1', source: 'tv' });
        }
        // A non-integer activePane would poison Math.min/max with NaN.
        const active = Number(tab.activePane);
        return {
            id: tab.id || `t${index + 1}`,
            layout,
            panes: panes.map((slot) => {
                const pane = slot && typeof slot === 'object' ? slot : {};
                return {
                    symbol: pane.symbol || 'NASDAQ:AAPL',
                    interval: pane.interval || 'D',
                    style: pane.style || '1',
                    // Panes saved before the NSE source existed default to the widget.
                    source: pane.source === 'nse' ? 'nse' : 'tv',
                };
            }),
            activePane: Number.isFinite(active) ? Math.min(Math.max(0, Math.trunc(active)), count - 1) : 0,
            maximised: typeof tab.maximised === 'number' && tab.maximised < count ? tab.maximised : null,
        };
    });

    if (!next.tabs.some((tab) => tab.id === next.activeTabId)) {
        next.activeTabId = next.tabs[0].id;
    }
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

export function activeTab() {
    return state.tabs.find((tab) => tab.id === state.activeTabId) || state.tabs[0];
}

export function activePane() {
    const tab = activeTab();
    return tab.panes[tab.activePane] || tab.panes[0];
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

export function reset() {
    state = defaultState();
    persist();
    for (const listener of listeners) listener(state, { reason: 'panes' });
}

/** Returns the next unused tab id. */
export function nextTabId() {
    let n = state.tabs.length + 1;
    const taken = new Set(state.tabs.map((tab) => tab.id));
    while (taken.has(`t${n}`)) n += 1;
    return `t${n}`;
}

export { createTab };
