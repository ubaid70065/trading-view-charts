/**
 * The chart pane grid.
 *
 * Each pane is an independent widget iframe. Because re-embedding reloads a
 * chart, panes are diffed by a settings signature: switching layout rebuilds the
 * grid, but editing one pane's symbol only re-embeds that pane.
 *
 * Placement comes from layoutGeometry(), so the grid always matches the icon
 * that selected it.
 */

import {
    chartSettings, intervalLabel, layoutById, layoutGeometry, nearestNseInterval,
} from './config.js';
import { embedChart } from './widget.js';

/**
 * The in-page sources, loaded on demand.
 *
 * Each pulls in a chart bundle — Lightweight Charts for two of them, the 5 MB
 * Advanced Charts library for the third. That is dead weight on a workspace
 * made of widget panes, which is every workspace until one is switched over, so
 * each module stays off the boot path until a pane actually asks for it.
 *
 * Everything not in this table is the embed: an iframe, handled by widget.js.
 *
 * @type {Record<string, {label: string, load: () => Promise<Function>}>}
 */
const IN_PAGE_SOURCES = {
    nse: {
        label: 'NSE',
        load: () => import('./nse/chart.js').then((module) => module.mountNseChart),
    },
    tvfeed: {
        label: 'feed',
        load: () => import('./tv/chart.js').then((module) => module.mountTvChart),
    },
    advanced: {
        label: 'advanced',
        load: () => import('./tv/advanced.js').then((module) => module.mountAdvancedChart),
    },
};

/** Dynamic import caches the module, but not the property lookup after it. */
const mounters = new Map();
const loadMounter = (source) => {
    if (!mounters.has(source)) mounters.set(source, IN_PAGE_SOURCES[source].load());
    return mounters.get(source);
};

/**
 * @param {HTMLElement} host
 * @param {object} handlers
 * @param {(index: number) => void} handlers.onActivate
 * @param {(message: string) => void} handlers.onError
 */
export function createPaneGrid(host, handlers) {
    /** @type {Array<{wrapper: HTMLElement, chartHost: HTMLElement, handle: object|null, signature: string, label: HTMLElement}>} */
    let entries = [];
    let gridKey = '';

    // A click inside a chart never reaches this page — the iframe is
    // cross-origin and swallows the event. Focus does move to the iframe
    // element though, and that is observable, so it stands in for the click.
    window.addEventListener('blur', () => {
        setTimeout(() => {
            const focused = document.activeElement;
            if (!focused || focused.tagName !== 'IFRAME') return;
            const wrapper = focused.closest('.pane');
            if (!wrapper) return;
            const index = Number(wrapper.dataset.index);
            if (Number.isInteger(index)) handlers.onActivate(index);
        }, 0);
    });

    function buildPane(index) {
        const wrapper = document.createElement('section');
        wrapper.className = 'pane';
        wrapper.dataset.index = String(index);

        const header = document.createElement('header');
        header.className = 'pane__header';

        const label = document.createElement('span');
        label.className = 'pane__label';
        header.append(label);

        const chartHost = document.createElement('div');
        chartHost.className = 'pane__chart';

        wrapper.append(header, chartHost);
        wrapper.addEventListener('pointerdown', () => handlers.onActivate(index), true);

        return { wrapper, chartHost, handle: null, signature: '', label };
    }

    function render(state) {
        const geometry = layoutGeometry(layoutById(state.layout));

        // Rebuilding the grid destroys every iframe, so only do it when the
        // arrangement itself changed.
        if (state.layout !== gridKey) {
            for (const entry of entries) {
                if (entry.handle) entry.handle.destroy();
            }
            entries = [];
            host.replaceChildren();

            host.style.setProperty('--grid-cols', `repeat(${geometry.cols}, 1fr)`);
            host.style.setProperty('--grid-rows', `repeat(${geometry.rows}, 1fr)`);
            host.dataset.panes = String(state.panes.length);

            state.panes.forEach((pane, index) => {
                const entry = buildPane(index);
                const cell = geometry.cells[index];
                entry.wrapper.style.gridColumn = `${cell.col} / span ${cell.colSpan}`;
                entry.wrapper.style.gridRow = `${cell.row} / span ${cell.rowSpan}`;
                entries.push(entry);
                host.append(entry.wrapper);
            });
            gridKey = state.layout;
        }

        // The last pane carries the watchlist and details bar — there is only
        // room for one.
        const panelIndex = state.panes.length - 1;

        state.panes.forEach((pane, index) => {
            const entry = entries[index];
            if (!entry) return;

            entry.wrapper.classList.toggle('pane--active', index === state.activePane);

            const inPage = IN_PAGE_SOURCES[pane.source];
            // NSE symbols carry no exchange prefix, and Angel One serves only a
            // subset of intervals — show what the pane will actually load. The
            // TradingView sources serve every interval the widget does.
            const shownInterval = pane.source === 'nse'
                ? nearestNseInterval(pane.interval)
                : pane.interval;
            const suffix = inPage ? `  ·  ${inPage.label}` : '';
            entry.label.textContent = `${pane.symbol}  ·  ${intervalLabel(shownInterval)}${suffix}`;

            // Every source is diffed the same way: rebuild only on real change.
            const settings = inPage
                ? { source: pane.source, symbol: pane.symbol, interval: shownInterval, theme: state.theme }
                : chartSettings(state, pane, index === panelIndex);

            const signature = JSON.stringify(settings);
            if (signature === entry.signature) return;

            if (entry.handle) entry.handle.destroy();
            entry.signature = signature;

            if (inPage) {
                entry.chartHost.classList.add('is-loading');
                // A handle has to exist synchronously — the next render may
                // destroy this pane before the module resolves, and that must
                // cancel the mount rather than leave an orphan chart behind.
                let live = true;
                entry.handle = {
                    destroy() {
                        live = false;
                        entry.chartHost.replaceChildren();
                    },
                };

                loadMounter(pane.source).then((mount) => {
                    if (!live) return;
                    entry.chartHost.classList.remove('is-loading');
                    entry.handle = mount(entry.chartHost, {
                        symbol: pane.symbol,
                        interval: shownInterval,
                        theme: state.theme,
                        onError: handlers.onError,
                    });
                }).catch(() => {
                    if (!live) return;
                    entry.chartHost.classList.remove('is-loading');
                    handlers.onError(`Could not load the ${inPage.label} chart module.`);
                });
                return;
            }

            entry.chartHost.classList.add('is-loading');
            entry.handle = embedChart(entry.chartHost, settings, {
                onReady: () => entry.chartHost.classList.remove('is-loading'),
                onError: (message) => {
                    entry.chartHost.classList.remove('is-loading');
                    handlers.onError(message);
                },
            });
        });
    }

    return { render };
}
