/**
 * Application wiring.
 *
 * State lives in state.js; every renderer reads from it and redraws on change.
 * The expensive part is the chart iframes, so `reason: 'chrome'` updates skip
 * the pane grid's embed diffing entirely.
 */

import { HEAVY_LAYOUT_THRESHOLD, layoutPanes, tickerSettings } from './config.js';
import { createSettingsDialog, createShortcutsDialog, setLayout } from './dialogs.js';
import { createStatus, mountHeader } from './header.js';
import { createPaneGrid } from './panes.js';
import { captureWorkspace } from './snapshot.js';
import { SHORTCUTS, bindShortcuts } from './shortcuts.js';
import { activeTab, createTab, getState, nextTabId, reset, subscribe, update } from './state.js';
import { createTabStrip } from './tabs.js';
import { attributionElement, embedTicker } from './widget.js';

const tickerHost = document.getElementById('tickerHost');
const panesHost = document.getElementById('panesHost');
const tabsHost = document.getElementById('tabsHost');
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
        const tab = activeTab();
        if (tab.activePane === index) return;
        update((draft) => {
            const target = draft.tabs.find((item) => item.id === draft.activeTabId);
            target.activePane = index;
        }, { reason: 'chrome' });
    },
    onToggleMaximise(index) {
        update((draft) => {
            const target = draft.tabs.find((item) => item.id === draft.activeTabId);
            target.maximised = target.maximised === index ? null : index;
            target.activePane = index;
        }, { reason: 'panes' });
    },
    onError: (message) => notify(message, { sticky: true }),
});

const tabStrip = createTabStrip(tabsHost, {
    onSelect(id) {
        if (getState().activeTabId === id) return;
        update((draft) => { draft.activeTabId = id; }, { reason: 'panes' });
    },
    onAdd() {
        update((draft) => {
            const current = draft.tabs.find((item) => item.id === draft.activeTabId);
            const pane = current.panes[current.activePane] || current.panes[0];
            const id = nextTabId();
            draft.tabs.push(createTab(id, pane.symbol, pane.interval, '1'));
            draft.activeTabId = id;
        }, { reason: 'panes' });
    },
    onClose(id) {
        update((draft) => {
            if (draft.tabs.length <= 1) return;
            const index = draft.tabs.findIndex((item) => item.id === id);
            draft.tabs.splice(index, 1);
            if (draft.activeTabId === id) {
                draft.activeTabId = draft.tabs[Math.max(0, index - 1)].id;
            }
        }, { reason: 'panes' });
    },
});

const settingsDialog = createSettingsDialog({
    getState,
    update,
    resetAll: reset,
});

const shortcutsDialog = createShortcutsDialog(SHORTCUTS);

const header = mountHeader({
    onLayout: applyLayout,
    onSync: setSync,
    onTheme: toggleTheme,
    onSnapshot: takeSnapshot,
    onShortcuts: () => shortcutsDialog.open(),
    onSettings: () => settingsDialog.open(),
});

// --- Actions ---

function applyLayout(layout) {
    update((draft) => {
        const tab = draft.tabs.find((item) => item.id === draft.activeTabId);
        setLayout(tab, layout);
    }, { reason: 'panes' });

    const panes = activeTab().panes.length;
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
        const tab = draft.tabs.find((item) => item.id === draft.activeTabId);
        const source = tab.panes[tab.activePane] || tab.panes[0];
        for (const pane of tab.panes) {
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

async function takeSnapshot() {
    const tab = activeTab();
    const pane = tab.panes[tab.activePane] || tab.panes[0];
    const name = `${pane.symbol.replace(/[^\w-]/g, '_')}_${pane.interval}`;
    notify('Choose this tab in the capture prompt…');
    const result = await captureWorkspace(name);
    if (result.ok) {
        notify('Snapshot saved.');
    } else {
        notify(result.reason || '');
    }
}

function movePane(delta) {
    update((draft) => {
        const tab = draft.tabs.find((item) => item.id === draft.activeTabId);
        const count = layoutPanes(tab.layout);
        tab.activePane = (tab.activePane + delta + count) % count;
    }, { reason: 'chrome' });
}

bindShortcuts({
    onLayout: applyLayout,
    onLayoutMenu: () => document.getElementById('layoutBtn').click(),
    onTheme: toggleTheme,
    onSnapshot: takeSnapshot,
    onMaximise() {
        const tab = activeTab();
        update((draft) => {
            const target = draft.tabs.find((item) => item.id === draft.activeTabId);
            target.maximised = target.maximised === null ? tab.activePane : null;
        }, { reason: 'panes' });
    },
    onNewTab: () => tabsHost.querySelector('.tab--add').click(),
    onCloseTab() {
        const state = getState();
        if (state.tabs.length > 1) {
            update((draft) => {
                const index = draft.tabs.findIndex((item) => item.id === draft.activeTabId);
                draft.tabs.splice(index, 1);
                draft.activeTabId = draft.tabs[Math.max(0, index - 1)].id;
            }, { reason: 'panes' });
        }
    },
    onPane: movePane,
    onSettings: () => settingsDialog.open(),
    onShortcuts: () => shortcutsDialog.open(),
    onEscape() {
        header.closeMenu();
        for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    },
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

// --- Render loop ---

function render(state, meta = {}) {
    const tab = activeTab();

    document.documentElement.dataset.theme = state.theme;
    header.sync(state, tab);
    tabStrip.render(state);

    const pane = tab.panes[tab.activePane] || tab.panes[0];
    attributionHost.replaceChildren(attributionElement(pane.symbol));

    if (meta.reason !== 'chrome') {
        renderTicker(state);
    }
    // The grid diffs internally, so it is safe to call on every render; a
    // 'chrome' reason still needs it for the active-pane outline.
    paneGrid.render(state, tab);
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
