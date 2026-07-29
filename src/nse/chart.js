/**
 * An NSE chart pane drawn with Lightweight Charts from Angel One data.
 *
 * This is the pane type that shows *your* feed. The TradingView embed cannot —
 * it is a cross-origin iframe with no data input — so panes marked `source:
 * 'nse'` render here instead, in-page, on a canvas we control.
 *
 * Trade-off versus the embed: no indicator library, no drawing tools, no symbol
 * search UI from the vendor. In exchange, the data is yours and the chart is a
 * real object with a real API.
 */

import { NSE_INTERVALS, nearestNseInterval } from '../config.js';
import { ApiError, candles as fetchCandles, quotes as fetchQuotes } from './api.js';

// Both live in config.js so the pane grid can label and diff an NSE pane
// without pulling this module — and the chart library — onto the boot path.
export { NSE_INTERVALS, nearestNseInterval };

const LIBRARY_SRC = '/vendor/lightweight-charts.standalone.production.js';

/** How far back to load by default, per interval. Minute data is capped upstream. */
const LOOKBACK_DAYS = {
    1: 5, 3: 10, 5: 20, 10: 30, 15: 45, 30: 90, 60: 180, D: 1095,
};

/** Refresh cadence for the forming candle. */
const LIVE_POLL_MS = 5000;

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** Used until the instrument's own tick size is known; NSE's finest increment. */
const DEFAULT_TICK = 0.01;

let libraryPromise = null;

/** Loads the vendored library once, shared by every pane. */
function loadLibrary() {
    if (window.LightweightCharts) return Promise.resolve(window.LightweightCharts);
    if (libraryPromise) return libraryPromise;

    libraryPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = LIBRARY_SRC;
        script.async = true;
        script.onload = () => resolve(window.LightweightCharts);
        script.onerror = () => reject(new Error(`Could not load ${LIBRARY_SRC}`));
        document.head.append(script);
    });
    return libraryPromise;
}

/**
 * Lightweight Charts renders timestamps as UTC and has no time-zone setting, so
 * IST is baked in by shifting the epoch. Without this, the 09:15 NSE open would
 * be labelled 03:45. Exported so the shift is covered by tests.
 */
export function toChartTime(epochMs) {
    return Math.floor((epochMs + IST_OFFSET_MS) / 1000);
}

function palette(theme) {
    const light = theme === 'light';
    return {
        background: light ? '#ffffff' : '#0f1116',
        text: light ? '#4b5261' : '#8b93a3',
        grid: light ? '#eceff3' : '#1c212b',
        border: light ? '#dcdfe4' : '#262b36',
        up: light ? '#089981' : '#26a69a',
        down: light ? '#f23645' : '#ef5350',
    };
}

/**
 * @param {HTMLElement} host
 * @param {object} options
 * @param {string} options.symbol     e.g. 'RELIANCE'
 * @param {string} options.interval   App interval id.
 * @param {'light'|'dark'} options.theme
 * @param {(message: string) => void} [options.onError]
 * @returns {{ destroy: () => void }}
 */
export function mountNseChart(host, { symbol, interval, theme, onError = () => {} }) {
    host.replaceChildren();

    const canvasHost = document.createElement('div');
    canvasHost.className = 'nse-chart';

    const overlay = document.createElement('div');
    overlay.className = 'nse-chart__overlay';
    overlay.textContent = 'Loading NSE data…';

    host.append(canvasHost, overlay);

    let disposed = false;
    let chart = null;
    let candleSeries = null;
    let volumeSeries = null;
    let pollTimer = null;
    let resizeObserver = null;
    let lastBar = null;

    const effectiveInterval = nearestNseInterval(interval);

    function showOverlay(message, tone = 'info') {
        overlay.textContent = message;
        overlay.dataset.tone = tone;
        overlay.hidden = false;
    }

    function hideOverlay() {
        overlay.hidden = true;
    }

    async function build() {
        let library;
        try {
            library = await loadLibrary();
        } catch (error) {
            if (!disposed) showOverlay(error.message, 'error');
            return;
        }
        if (disposed) return;

        const colours = palette(theme);

        chart = library.createChart(canvasHost, {
            layout: {
                background: { type: library.ColorType.Solid, color: colours.background },
                textColor: colours.text,
                fontFamily: getComputedStyle(document.body).fontFamily,
            },
            grid: {
                vertLines: { color: colours.grid },
                horzLines: { color: colours.grid },
            },
            rightPriceScale: { borderColor: colours.border },
            timeScale: {
                borderColor: colours.border,
                // Minute data needs the clock; daily does not.
                timeVisible: effectiveInterval !== 'D',
                secondsVisible: false,
            },
            crosshair: { mode: library.CrosshairMode.Normal },
            autoSize: true,
        });

        candleSeries = chart.addCandlestickSeries({
            upColor: colours.up,
            downColor: colours.down,
            borderUpColor: colours.up,
            borderDownColor: colours.down,
            wickUpColor: colours.up,
            wickDownColor: colours.down,
            // Replaced once the instrument's real tick size arrives with the bars.
            priceFormat: { type: 'price', precision: 2, minMove: DEFAULT_TICK },
        });

        volumeSeries = chart.addHistogramSeries({
            priceFormat: { type: 'volume' },
            priceScaleId: 'volume',
        });
        // Pin volume to the bottom fifth rather than letting it share the scale.
        chart.priceScale('volume').applyOptions({
            scaleMargins: { top: 0.82, bottom: 0 },
            visible: false,
        });

        // autoSize handles most cases, but a pane can be resized while hidden.
        resizeObserver = new ResizeObserver(() => {
            if (chart) chart.applyOptions({});
        });
        resizeObserver.observe(canvasHost);

        await loadHistory();
    }

    async function loadHistory() {
        try {
            const to = new Date();
            const from = new Date(to.getTime() - (LOOKBACK_DAYS[effectiveInterval] || 180) * 86400000);

            const payload = await fetchCandles({ symbol, interval: effectiveInterval, from, to });
            if (disposed) return;

            const bars = payload.bars || [];
            if (bars.length === 0) {
                showOverlay(`No data returned for ${symbol}.`, 'error');
                return;
            }

            // NSE tick sizes run from ₹0.01 to ₹5.00 by price band, and the axis
            // rounds to whatever it is told — a fixed guess mislabels most
            // prices. The instrument master carries the real one.
            const tickSize = payload.instrument?.tickSize > 0
                ? payload.instrument.tickSize
                : DEFAULT_TICK;
            candleSeries.applyOptions({
                priceFormat: { type: 'price', precision: 2, minMove: tickSize },
            });

            const colours = palette(theme);
            candleSeries.setData(bars.map((bar) => ({
                time: toChartTime(bar.time),
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
            })));

            // Indices have no traded volume; drawing a flat zero strip along the
            // bottom would only take space away from the candles.
            if (bars.some((bar) => bar.volume > 0)) {
                volumeSeries.setData(bars.map((bar) => ({
                    time: toChartTime(bar.time),
                    value: bar.volume,
                    color: bar.close >= bar.open ? `${colours.up}66` : `${colours.down}66`,
                })));
            }

            lastBar = bars[bars.length - 1];
            chart.timeScale().fitContent();
            hideOverlay();
            startPolling();
        } catch (error) {
            if (disposed) return;
            // Both the server's 503 and the "no /api here" case already carry a
            // message that says what to do, so it is shown as written rather
            // than replaced with a generic one.
            const message = error.message;
            showOverlay(message, error instanceof ApiError && error.isSetupProblem ? 'setup' : 'error');
            onError(message);
        }
    }

    /**
     * Extends the newest candle from live quotes. This is polling, not a tick
     * stream — Angel One's WebSocket feed would replace it.
     */
    function startPolling() {
        if (pollTimer !== null) return;

        pollTimer = setInterval(async () => {
            if (disposed || document.hidden) return;
            try {
                const [quote] = await fetchQuotes([symbol], { mode: 'OHLC' });
                if (!quote || disposed || !lastBar || quote.last === null) return;

                // Fold the live price into the forming candle.
                const updated = {
                    time: toChartTime(lastBar.time),
                    open: lastBar.open,
                    high: Math.max(lastBar.high, quote.last),
                    low: Math.min(lastBar.low, quote.last),
                    close: quote.last,
                };
                candleSeries.update(updated);
                lastBar = { ...lastBar, high: updated.high, low: updated.low, close: updated.close };
            } catch {
                // A failed poll is not worth interrupting the chart for; the
                // next tick retries.
            }
        }, LIVE_POLL_MS);
    }

    build();

    return {
        destroy() {
            disposed = true;
            if (pollTimer !== null) clearInterval(pollTimer);
            if (resizeObserver) resizeObserver.disconnect();
            if (chart) chart.remove();
            chart = null;
            host.replaceChildren();
        },
    };
}
