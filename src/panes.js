/**
 * The chart pane grid.
 *
 * Each pane is an independent widget iframe. Because re-embedding reloads a
 * chart, panes are diffed by a settings signature: switching layout or tab
 * rebuilds the grid, but editing one pane's symbol only re-embeds that pane.
 *
 * Placement comes from layoutGeometry(), so the grid always matches the icon
 * that selected it.
 */

import { chartSettings, intervalLabel, layoutById, layoutGeometry } from './config.js';
import { embedChart } from './widget.js';
import { mountNseChart, nearestNseInterval } from './nse/chart.js';

/**
 * @param {HTMLElement} host
 * @param {object} handlers
 * @param {(index: number) => void} handlers.onActivate
 * @param {(index: number) => void} handlers.onToggleMaximise
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

    function buildPane(index, isMaximised) {
        const wrapper = document.createElement('section');
        wrapper.className = 'pane';
        wrapper.dataset.index = String(index);

        const header = document.createElement('header');
        header.className = 'pane__header';

        const label = document.createElement('span');
        label.className = 'pane__label';

        const spacer = document.createElement('span');
        spacer.className = 'pane__spacer';

        const maximise = document.createElement('button');
        maximise.type = 'button';
        maximise.className = 'pane__btn';
        maximise.title = isMaximised ? 'Restore layout' : 'Maximise this chart';
        maximise.setAttribute('aria-label', maximise.title);
        maximise.textContent = isMaximised ? '⤡' : '⤢';
        maximise.addEventListener('click', (event) => {
            event.stopPropagation();
            handlers.onToggleMaximise(index);
        });

        header.append(label, spacer, maximise);

        const chartHost = document.createElement('div');
        chartHost.className = 'pane__chart';

        wrapper.append(header, chartHost);
        wrapper.addEventListener('pointerdown', () => handlers.onActivate(index), true);

        return { wrapper, chartHost, handle: null, signature: '', label };
    }

    function render(state, tab) {
        const maximised = typeof tab.maximised === 'number' ? tab.maximised : null;
        const layout = layoutById(tab.layout);
        const geometry = layoutGeometry(layout);

        const visible = maximised === null
            ? tab.panes.map((pane, index) => ({ pane, index }))
            : [{ pane: tab.panes[maximised], index: maximised }];

        // Rebuilding the grid destroys every iframe, so only do it when the
        // arrangement itself changed.
        const nextGridKey = `${tab.id}|${tab.layout}|${maximised}`;
        if (nextGridKey !== gridKey) {
            for (const entry of entries) {
                if (entry.handle) entry.handle.destroy();
            }
            entries = [];
            host.replaceChildren();

            if (maximised === null) {
                host.style.setProperty('--grid-cols', `repeat(${geometry.cols}, 1fr)`);
                host.style.setProperty('--grid-rows', `repeat(${geometry.rows}, 1fr)`);
            } else {
                host.style.setProperty('--grid-cols', '1fr');
                host.style.setProperty('--grid-rows', '1fr');
            }
            host.dataset.panes = String(visible.length);

            visible.forEach(({ index }, position) => {
                const entry = buildPane(index, maximised !== null);
                const cell = maximised === null
                    ? geometry.cells[position]
                    : { col: 1, row: 1, colSpan: 1, rowSpan: 1 };
                entry.wrapper.style.gridColumn = `${cell.col} / span ${cell.colSpan}`;
                entry.wrapper.style.gridRow = `${cell.row} / span ${cell.rowSpan}`;
                entries.push(entry);
                host.append(entry.wrapper);
            });
            gridKey = nextGridKey;
        }

        // The last pane carries the watchlist and details bar — there is only
        // room for one. A maximised pane takes it over.
        const panelIndex = visible.length - 1;

        visible.forEach(({ pane, index }, position) => {
            const entry = entries[position];
            if (!entry) return;

            entry.wrapper.classList.toggle('pane--active', index === tab.activePane);

            const isNse = pane.source === 'nse';
            // NSE symbols carry no exchange prefix, and Angel One serves only a
            // subset of intervals — show what the pane will actually load.
            const shownInterval = isNse ? nearestNseInterval(pane.interval) : pane.interval;
            entry.label.textContent = isNse
                ? `${pane.symbol}  ·  ${intervalLabel(shownInterval)}  ·  NSE`
                : `${pane.symbol}  ·  ${intervalLabel(shownInterval)}`;

            // Both sources are diffed the same way: rebuild only on real change.
            const settings = isNse
                ? { source: 'nse', symbol: pane.symbol, interval: shownInterval, theme: state.theme }
                : chartSettings(state, pane, position === panelIndex);

            const signature = JSON.stringify(settings);
            if (signature === entry.signature) return;

            if (entry.handle) entry.handle.destroy();
            entry.signature = signature;

            if (isNse) {
                entry.chartHost.classList.remove('is-loading');
                entry.handle = mountNseChart(entry.chartHost, {
                    symbol: pane.symbol,
                    interval: shownInterval,
                    theme: state.theme,
                    onError: handlers.onError,
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
