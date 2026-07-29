/**
 * A chart pane drawn with TradingView's Advanced Charts library.
 *
 * The fourth pane source, and the one the datafeeds were written for. The other
 * three each give up something:
 *
 *   'tv'     — the vendor's full UI, but inside a cross-origin iframe this app
 *              can neither feed nor read.
 *   'nse'    — our data on a canvas we own, but Lightweight Charts is a
 *              renderer: no indicators, no drawing tools.
 *   'tvfeed' — same renderer, wider feed, same missing UI.
 *
 * This one has all of it: the real TradingView UI — indicators, drawing tools,
 * symbol search — running in-page against `createTvDatafeed()`, so the chart is
 * a live object the workspace can drive.
 *
 * The library is licensed per user and is not in this repository. Whoever has
 * been granted access drops the `charting_library/` folder in and it appears;
 * until then this pane says so rather than failing blankly. See the README.
 */

import { createTvDatafeed } from './datafeed.js';

/** Where the loader and its bundles live. `server.js` aliases this to public/. */
const LIBRARY_PATH = '/charting_library/';
const LIBRARY_SRC = `${LIBRARY_PATH}charting_library.min.js`;

/** App interval id → the resolution Advanced Charts expects. */
const RESOLUTIONS = {
    1: '1', 3: '3', 5: '5', 10: '10', 15: '15', 30: '30', 60: '60',
    120: '120', 240: '240', D: '1D', W: '1W', M: '1M',
};

export function toLibraryResolution(interval) {
    return RESOLUTIONS[String(interval)] || '1D';
}

let libraryPromise = null;

/**
 * Loads the library once, shared by every pane.
 *
 * Resolves to null rather than rejecting when the folder is absent: that is a
 * setup state with a known remedy, not an error, and it reads better as a
 * message in the pane than as a thrown stack.
 */
function loadLibrary() {
    if (window.TradingView && window.TradingView.widget) {
        return Promise.resolve(window.TradingView);
    }
    if (libraryPromise) return libraryPromise;

    libraryPromise = new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = LIBRARY_SRC;
        script.async = true;
        script.onload = () => resolve(
            window.TradingView && window.TradingView.widget ? window.TradingView : null,
        );
        script.onerror = () => resolve(null);
        document.head.append(script);
    });
    return libraryPromise;
}

/** Shared across panes: one socket and one config fetch, not one per chart. */
let datafeed = null;
const getDatafeed = () => (datafeed ||= createTvDatafeed());

/**
 * The library takes `container_id` — a string it looks up itself — not an
 * element. Newer builds accept an element as `container`, and passing one to
 * this build fails with "There is no such element - #", which names the empty
 * id rather than the wrong option. So every pane needs a unique id on the page.
 */
let containerSeq = 0;

/**
 * @param {HTMLElement} host
 * @param {object} options
 * @param {string} options.symbol     Exchange-qualified, e.g. 'NSE:RELIANCE'.
 * @param {string} options.interval   App interval id.
 * @param {'light'|'dark'} options.theme
 * @param {(message: string) => void} [options.onError]
 * @returns {{ destroy: () => void }}
 */
export function mountAdvancedChart(host, { symbol, interval, theme, onError = () => {} }) {
    host.replaceChildren();

    const container = document.createElement('div');
    container.className = 'advanced-chart';
    container.id = `advanced-chart-${++containerSeq}`;

    const overlay = document.createElement('div');
    overlay.className = 'nse-chart__overlay';
    overlay.textContent = `Loading ${symbol}…`;

    host.append(container, overlay);

    let disposed = false;
    let widget = null;

    function showOverlay(message, tone = 'info') {
        overlay.textContent = message;
        overlay.dataset.tone = tone;
        overlay.hidden = false;
    }

    loadLibrary().then((library) => {
        if (disposed) return;

        if (!library) {
            const message = 'Advanced Charts is not installed. It is licensed per user and '
                + 'cannot be redistributed — request access from TradingView, then put the '
                + 'charting_library folder in public/.';
            showOverlay(message, 'setup');
            onError(message);
            return;
        }

        widget = new library.widget({
            container_id: container.id,
            library_path: LIBRARY_PATH,
            datafeed: getDatafeed(),
            symbol,
            interval: toLibraryResolution(interval),
            locale: 'en',
            theme: theme === 'light' ? 'Light' : 'Dark',
            autosize: true,
            // The pane header already names the symbol and interval, and the
            // workspace owns the layout — the library's own chrome for those
            // would be a second, disagreeing set of controls.
            disabled_features: [
                'header_saveload',
                'use_localstorage_for_settings',
                'save_chart_properties_to_local_storage',
                // Without a charts_storage_url this asks the *library folder*
                // for templates and 404s on every load.
                'study_templates',
            ],
            // Matches the app's surfaces so the pane does not sit on a
            // differently-coloured rectangle. `backgroundType` is deliberately
            // absent: v18+ has it, this build warns that the path is unknown.
            overrides: theme === 'light' ? {} : {
                'paneProperties.background': '#0f1116',
            },
        });

        // onChartReady fires once the library has drawn; until then its own
        // container is empty and the overlay is what the user sees.
        widget.onChartReady(() => {
            if (disposed) return;
            overlay.hidden = true;
        });
    }).catch((error) => {
        if (disposed) return;
        showOverlay(error.message, 'error');
        onError(error.message);
    });

    return {
        destroy() {
            disposed = true;
            // The library holds a websocket and a resize observer of its own;
            // dropping the node without this leaks both.
            if (widget) {
                try {
                    widget.remove();
                } catch {
                    // Already torn down by a failed construction.
                }
            }
            widget = null;
            host.replaceChildren();
        },
    };
}
