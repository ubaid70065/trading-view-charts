/**
 * A chart pane drawn with Lightweight Charts from the TradingView widget feed.
 *
 * The third pane type. `source: 'tv'` is the vendor's own embed — an iframe
 * this app cannot feed or read. `source: 'nse'` is Lightweight Charts over an
 * Angel One subscription, in-page and controllable but NSE-only. This is both:
 * an in-page canvas we own, over a feed that carries every exchange
 * TradingView lists.
 *
 * History arrives over `/tv/history`; live bars stream from `/tv/stream`, so
 * the forming candle updates from real bar pushes rather than the 5-second
 * quote poll `src/nse/chart.js` has to use.
 */

import { intervalLabel } from '../config.js';
import { openBarStream } from './datafeed.js';

const LIBRARY_SRC = '/vendor/lightweight-charts.standalone.production.js';

/** How far back to load by default, per resolution. */
const LOOKBACK_DAYS = {
    1: 5, 3: 10, 5: 20, 10: 30, 15: 45, 30: 90, 60: 180,
    120: 365, 240: 540, '1D': 1825, '1W': 3650, '1M': 7300,
};

/** App interval id → the resolution `/tv/*` speaks. */
const RESOLUTIONS = {
    1: '1', 3: '3', 5: '5', 10: '10', 15: '15', 30: '30', 60: '60',
    120: '120', 240: '240', D: '1D', W: '1W', M: '1M',
};

export function toTvResolution(interval) {
    return RESOLUTIONS[String(interval)] || '1D';
}

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

const formatters = new Map();

/**
 * How far the exchange's local time is from UTC at `epochMs`, in milliseconds.
 *
 * Lightweight Charts renders every timestamp as UTC and has no time-zone
 * option, so the epoch is shifted to make the axis read in exchange-local time.
 * `src/nse/chart.js` can hardcode +05:30 because it only ever shows NSE; this
 * pane may be showing Binance, NASDAQ or LSE, so the offset is looked up per
 * symbol — and per bar, since it changes across a DST boundary and a fixed
 * offset would bend the axis by an hour for half the year.
 */
export function zoneOffsetMs(timeZone, epochMs) {
    let formatter = formatters.get(timeZone);
    if (!formatter) {
        try {
            formatter = new Intl.DateTimeFormat('en-US', {
                timeZone,
                hour12: false,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
            });
        } catch {
            // An unknown zone should not stop the chart drawing; UTC is the
            // honest fallback and the axis simply reads as UTC.
            formatter = null;
        }
        formatters.set(timeZone, formatter);
    }
    if (!formatter) return 0;

    const parts = {};
    for (const part of formatter.formatToParts(new Date(epochMs))) parts[part.type] = part.value;

    const asUtc = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        // Some locales render midnight as 24; Date.UTC would roll the day.
        Number(parts.hour) % 24,
        Number(parts.minute),
        Number(parts.second),
    );
    return asUtc - epochMs;
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

async function getJson(path) {
    const response = await fetch(path);
    if (!(response.headers.get('content-type') || '').includes('application/json')) {
        const error = new Error(
            'This page is being served by a plain file server, not the app’s own, so '
            + 'there are no /tv routes and feed data cannot load. Run “npm start” and '
            + 'open http://localhost:5500 instead.',
        );
        error.isSetupProblem = true;
        throw error;
    }
    const payload = await response.json();
    if (payload && payload.s === 'error') throw new Error(payload.errmsg);
    if (payload && payload.error) throw new Error(payload.error);
    return payload;
}

/**
 * @param {HTMLElement} host
 * @param {object} options
 * @param {string} options.symbol     Exchange-qualified, e.g. 'BINANCE:BTCUSDT'.
 * @param {string} options.interval   App interval id.
 * @param {'light'|'dark'} options.theme
 * @param {(message: string) => void} [options.onError]
 * @returns {{ destroy: () => void }}
 */
export function mountTvChart(host, { symbol, interval, theme, onError = () => {} }) {
    host.replaceChildren();

    const canvasHost = document.createElement('div');
    canvasHost.className = 'nse-chart';

    const overlay = document.createElement('div');
    overlay.className = 'nse-chart__overlay';
    overlay.textContent = `Loading ${symbol}…`;

    host.append(canvasHost, overlay);

    const resolution = toTvResolution(interval);

    let disposed = false;
    let chart = null;
    let candleSeries = null;
    let volumeSeries = null;
    let resizeObserver = null;
    let closeStream = null;
    let timeZone = 'Etc/UTC';
    let hasVolume = false;
    let lastTime = 0;

    function showOverlay(message, tone = 'info') {
        overlay.textContent = message;
        overlay.dataset.tone = tone;
        overlay.hidden = false;
    }

    const chartTime = (epochMs) => Math.floor((epochMs + zoneOffsetMs(timeZone, epochMs)) / 1000);

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
                // Intraday needs the clock; daily and slower do not.
                timeVisible: !['1D', '1W', '1M'].includes(resolution),
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
        });

        volumeSeries = chart.addHistogramSeries({
            priceFormat: { type: 'volume' },
            priceScaleId: 'volume',
        });
        chart.priceScale('volume').applyOptions({
            scaleMargins: { top: 0.82, bottom: 0 },
            visible: false,
        });

        resizeObserver = new ResizeObserver(() => {
            if (chart) chart.applyOptions({});
        });
        resizeObserver.observe(canvasHost);

        await loadHistory();
    }

    async function loadHistory() {
        try {
            const info = await getJson(`/tv/symbols?${new URLSearchParams({ symbol })}`);
            if (disposed) return;
            timeZone = info.timezone || 'Etc/UTC';

            // TradingView states the tick size as minmov/pricescale; the axis
            // rounds to whatever it is told, so a fixed guess mislabels
            // anything that is not a two-decimal equity.
            const tick = (info.minmov || 1) / (info.pricescale || 100);
            candleSeries.applyOptions({
                priceFormat: {
                    type: 'price',
                    precision: Math.max(0, Math.round(Math.log10(info.pricescale || 100))),
                    minMove: tick,
                },
            });

            const to = Math.floor(Date.now() / 1000);
            const from = to - (LOOKBACK_DAYS[resolution] || 365) * 86400;
            const payload = await getJson(`/tv/history?${new URLSearchParams({
                symbol, resolution, from: String(from), to: String(to),
            })}`);
            if (disposed) return;

            if (payload.s === 'no_data') {
                showOverlay(`No data returned for ${symbol} at ${intervalLabel(interval)}.`, 'error');
                return;
            }

            const colours = palette(theme);
            const bars = payload.t.map((seconds, i) => ({
                time: chartTime(seconds * 1000),
                open: payload.o[i],
                high: payload.h[i],
                low: payload.l[i],
                close: payload.c[i],
                volume: payload.v ? payload.v[i] : 0,
            }));

            candleSeries.setData(bars.map(({ time, open, high, low, close }) => ({
                time, open, high, low, close,
            })));

            // Indices carry no traded volume; a flat zero strip along the
            // bottom would only take space from the candles.
            hasVolume = bars.some((bar) => bar.volume > 0);
            if (hasVolume) {
                volumeSeries.setData(bars.map((bar) => ({
                    time: bar.time,
                    value: bar.volume,
                    color: bar.close >= bar.open ? `${colours.up}66` : `${colours.down}66`,
                })));
            }

            lastTime = bars.length ? bars[bars.length - 1].time : 0;
            chart.timeScale().fitContent();
            overlay.hidden = true;
            startStream();
        } catch (error) {
            if (disposed) return;
            showOverlay(error.message, error.isSetupProblem ? 'setup' : 'error');
            onError(error.message);
        }
    }

    function startStream() {
        const colours = palette(theme);

        closeStream = openBarStream(symbol, resolution, (bar) => {
            if (disposed || !candleSeries) return;

            const time = chartTime(bar.time);
            // The stream replays its opening window on every reconnect, and
            // Lightweight Charts throws on an update older than the series.
            if (time < lastTime) return;
            lastTime = time;

            candleSeries.update({
                time,
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
            });

            if (hasVolume && bar.volume > 0) {
                volumeSeries.update({
                    time,
                    value: bar.volume,
                    color: bar.close >= bar.open ? `${colours.up}66` : `${colours.down}66`,
                });
            }
        });
    }

    build();

    return {
        destroy() {
            disposed = true;
            if (closeStream) closeStream();
            if (resizeObserver) resizeObserver.disconnect();
            if (chart) chart.remove();
            chart = null;
            host.replaceChildren();
        },
    };
}
