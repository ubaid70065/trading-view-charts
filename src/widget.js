/**
 * Mounts TradingView's free embeddable widgets.
 *
 * Both embed scripts work by self-replacing: the script reads its own JSON body
 * for settings, finds its parent through `document.currentScript`, and swaps
 * itself for an iframe on tradingview-widget.com. The iframe is cross-origin, so
 * nothing about it can be changed afterwards — every settings change means
 * embedding again.
 */

import { CHART_SCRIPT_URL, TICKER_SCRIPT_URL } from './config.js';

const LOAD_TIMEOUT_MS = 15000;

/**
 * @param {object} options
 * @param {HTMLElement} options.host        Element to mount into (emptied first).
 * @param {string} options.scriptUrl        Vendor embed script.
 * @param {object} options.settings         Config object for that widget.
 * @param {boolean} [options.withCopyright] Render the attribution inside this
 *   container. The embed script reserves 32px for it when present, so panes that
 *   share one app-level attribution pass false to reclaim the space.
 * @param {(message: string) => void} [options.onError]
 * @param {() => void} [options.onReady]
 * @returns {{ destroy: () => void }}
 */
export function embedWidget({
    host,
    scriptUrl,
    settings,
    withCopyright = false,
    onReady = () => {},
    onError = () => {},
}) {
    host.replaceChildren();

    const container = document.createElement('div');
    container.className = 'tradingview-widget-container';

    const slot = document.createElement('div');
    slot.className = 'tradingview-widget-container__widget';
    container.append(slot);

    if (withCopyright) {
        container.append(attributionElement(settings.symbol));
    }

    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.src = scriptUrl;
    script.async = true;
    // Settings travel in the script body, not in attributes.
    script.text = JSON.stringify(settings);

    let settled = false;
    const settle = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        observer.disconnect();
        fn(arg);
    };

    // The script replaces itself asynchronously, so watch for the iframe.
    const observer = new MutationObserver(() => {
        if (container.querySelector('iframe')) settle(onReady);
    });
    observer.observe(container, { childList: true, subtree: true });

    const timer = setTimeout(() => {
        settle(onError, 'The chart did not load. Check the connection, and whether a content ' +
            'blocker is blocking s3.tradingview.com.');
    }, LOAD_TIMEOUT_MS);

    script.addEventListener('error', () => {
        settle(onError, `Could not load ${scriptUrl} — the request was blocked or the network is down.`);
    });

    container.append(script);
    host.append(container);

    // Covers the case where the iframe lands before the observer attaches.
    if (container.querySelector('iframe')) settle(onReady);

    return {
        destroy() {
            settle(() => {});
            host.replaceChildren();
        },
    };
}

/** Chart pane. */
export function embedChart(host, settings, handlers = {}) {
    return embedWidget({ host, scriptUrl: CHART_SCRIPT_URL, settings, ...handlers });
}

/** Ticker tape strip. */
export function embedTicker(host, settings, handlers = {}) {
    return embedWidget({ host, scriptUrl: TICKER_SCRIPT_URL, settings, ...handlers });
}

/**
 * The attribution link, required by the free widget licence.
 * TradingView symbol pages are /symbols/EXCHANGE-TICKER/, not "EXCHANGE:TICKER".
 */
export function attributionElement(symbol) {
    const wrapper = document.createElement('div');
    wrapper.className = 'tradingview-widget-copyright';

    const link = document.createElement('a');
    const path = String(symbol || '').replace(':', '-');
    link.href = path
        ? `https://www.tradingview.com/symbols/${encodeURIComponent(path)}/`
        : 'https://www.tradingview.com/';
    link.rel = 'noopener nofollow';
    link.target = '_blank';

    const label = document.createElement('span');
    label.className = 'blue-text';
    label.textContent = symbol ? `${symbol} chart by TradingView` : 'Charts by TradingView';

    link.append(label);
    wrapper.append(link);
    return wrapper;
}
