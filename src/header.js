/**
 * Top header: connection status, layout picker and the theme toggle.
 */

import { layoutById, layoutIconSvg } from './config.js';
import { createLayoutPicker } from './layout-picker.js';

/**
 * @param {object} handlers
 * @param {(layout: string) => void} handlers.onLayout
 * @param {(key: string, value: boolean) => void} handlers.onSync
 * @param {() => void} handlers.onTheme
 */
export function mountHeader(handlers) {
    const layoutBtn = document.getElementById('layoutBtn');
    const layoutMenu = document.getElementById('layoutMenu');
    const themeBtn = document.getElementById('themeBtn');

    const picker = createLayoutPicker(layoutMenu, {
        onPick(id) {
            closeMenu();
            handlers.onLayout(id);
        },
        onSync: handlers.onSync,
    });

    function openMenu() {
        layoutMenu.hidden = false;
        layoutBtn.setAttribute('aria-expanded', 'true');
        document.addEventListener('pointerdown', onOutside, true);
    }

    function closeMenu() {
        layoutMenu.hidden = true;
        layoutBtn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', onOutside, true);
    }

    function onOutside(event) {
        if (!layoutMenu.contains(event.target) && !layoutBtn.contains(event.target)) closeMenu();
    }

    layoutBtn.addEventListener('click', () => {
        if (layoutMenu.hidden) openMenu(); else closeMenu();
    });

    themeBtn.addEventListener('click', handlers.onTheme);

    return {
        /** Reflects theme and the active layout in the header. */
        sync(state) {
            const light = state.theme === 'light';
            themeBtn.querySelector('.btn__icon').textContent = light ? '☀' : '☾';
            themeBtn.querySelector('.btn__text').textContent = light ? 'Light' : 'Dark';

            // The button wears the current arrangement, as TradingView's does.
            layoutBtn.querySelector('.btn__icon').innerHTML = layoutIconSvg(layoutById(state.layout), 15);

            picker.sync(state);
        },
        closeMenu,
    };
}

/**
 * The status pill. Starts as "detecting…" and settles once the first chart
 * reports in, or immediately if the browser says it is offline.
 */
export function createStatus() {
    const pill = document.getElementById('status');

    function set(state, text) {
        pill.dataset.state = state;
        pill.textContent = text;
    }

    window.addEventListener('offline', () => set('offline', 'offline'));
    window.addEventListener('online', () => set('detecting', 'reconnecting…'));

    return {
        detecting: () => set('detecting', 'detecting…'),
        live: () => set('live', navigator.onLine ? 'live' : 'offline'),
        offline: () => set('offline', 'offline'),
    };
}
