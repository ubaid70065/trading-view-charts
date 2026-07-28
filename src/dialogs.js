/**
 * Modal dialogs: Settings and Shortcuts.
 *
 * Built on <dialog> so focus trapping, Escape handling and the backdrop come
 * from the platform rather than from hand-rolled code.
 */

import {
    CHART_TOGGLES, INTERVALS, LAYOUT_GROUPS, LOCALES, PANEL_TOGGLES, PANE_SOURCES, RANGES,
    STUDIES, STYLES, TIMEZONES, layoutLabel, layoutPanes, normaliseLayoutId,
    widgetIntradayProblem,
} from './config.js';
import { search as searchNse } from './nse/api.js';

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function field(labelText, control) {
    const wrapper = element('label', 'field');
    wrapper.append(element('span', 'field__label', labelText), control);
    return wrapper;
}

function select(options, value) {
    const node = element('select', 'select');
    for (const option of options) {
        const item = document.createElement('option');
        if (typeof option === 'string') {
            item.value = option;
            item.textContent = option;
        } else {
            item.value = option.value;
            item.textContent = option.label;
        }
        if (item.value === String(value)) item.selected = true;
        node.append(item);
    }
    return node;
}

function checkbox(labelText, checked) {
    const wrapper = element('label', 'toggle');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = Boolean(checked);
    wrapper.append(box, element('span', null, labelText));
    return { wrapper, box };
}

/** Creates the shell every dialog shares. */
function createDialog(title) {
    const dialog = document.createElement('dialog');
    dialog.className = 'modal';

    const head = element('header', 'modal__head');
    head.append(element('h2', 'modal__title', title));

    const close = element('button', 'modal__close', '×');
    close.type = 'button';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => dialog.close());
    head.append(close);

    const body = element('div', 'modal__body');
    const foot = element('footer', 'modal__foot');

    dialog.append(head, body, foot);
    document.body.append(dialog);

    // Clicking the backdrop (outside the panel) closes it.
    dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
    });

    return { dialog, body, foot };
}

/**
 * Settings dialog. Edits are collected and applied on Save so a half-finished
 * form never triggers a chart reload.
 *
 * @param {object} api
 * @param {() => object} api.getState
 * @param {(mutator: (draft: object) => void, meta?: object) => void} api.update
 * @param {() => void} api.resetAll
 */
export function createSettingsDialog(api) {
    const { dialog, body, foot } = createDialog('Settings');

    const save = element('button', 'btn btn--primary', 'Save');
    save.type = 'button';
    const cancel = element('button', 'btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => dialog.close());

    const reset = element('button', 'btn btn--danger', 'Reset everything');
    reset.type = 'button';
    reset.addEventListener('click', () => {
        if (confirm('Discard all tabs, layouts and settings, and start from defaults?')) {
            dialog.close();
            api.resetAll();
        }
    });

    foot.append(reset, element('span', 'modal__spacer'), cancel, save);

    let apply = () => {};
    save.addEventListener('click', () => {
        apply();
        dialog.close();
    });

    function open() {
        const state = api.getState();
        const tab = state.tabs.find((item) => item.id === state.activeTabId) || state.tabs[0];
        const pane = tab.panes[tab.activePane] || tab.panes[0];

        body.replaceChildren();

        // --- Active chart ---
        const chartSection = element('section', 'modal__section');
        chartSection.append(element('h3', 'modal__heading', `Active chart — pane ${tab.activePane + 1}`));

        const sourceSelect = select(PANE_SOURCES, pane.source || 'tv');

        const symbolInput = element('input', 'input');
        symbolInput.type = 'text';
        symbolInput.value = pane.symbol;
        symbolInput.spellcheck = false;
        symbolInput.setAttribute('list', 'nseSymbolList');

        // Datalist is populated from live NSE search when the source is NSE.
        const symbolList = element('datalist');
        symbolList.id = 'nseSymbolList';

        const intervalSelect = select(INTERVALS, pane.interval);
        const styleSelect = select(STYLES, pane.style);
        const applyAll = checkbox('Apply symbol, interval and style to every pane now', false);

        const sourceHint = element('p', 'modal__hint');

        // The widget refuses this combination *inside* the iframe — the pane
        // just says "Only D, W, M intervals are available" with nothing to
        // click. Both escapes are offered, prefixing first: NSE is real-time on
        // the free widget and keeps the indicators and drawing tools, which the
        // Angel One source does not have.
        const warning = element('div', 'modal__warning');
        const warningText = element('p', 'modal__warning-text');
        const warningActions = element('div', 'modal__warning-actions');
        const useNse = element('button', 'btn btn--primary');
        useNse.type = 'button';
        const warningAction = element('button', 'btn');
        warningAction.type = 'button';
        warningAction.textContent = 'Use Angel One instead';
        warningActions.append(useNse, warningAction);
        warning.append(warningText, warningActions);

        /** The two sources take different symbol formats and offer different options. */
        function reflectSource() {
            const isNse = sourceSelect.value === 'nse';
            symbolInput.placeholder = isNse ? 'RELIANCE' : 'EXCHANGE:TICKER';
            styleSelect.disabled = isNse;
            sourceHint.textContent = isNse
                ? 'Angel One data drawn in-page. Plain NSE tickers (RELIANCE, INFY) or an '
                    + 'index (NIFTY, BANKNIFTY). Serves 1, 3, 5, 10, 15, 30, 60 minute and '
                    + 'daily bars — other intervals fall back to the nearest. No indicators '
                    + 'or drawing tools on this source.'
                : 'TradingView’s widget and data. Prefixed symbols (NSE:RELIANCE, NASDAQ:AAPL). '
                    + 'Full toolbar, indicators and drawings — but it cannot show your Angel One feed.';
            reflectWarning();
        }

        /** Flags the widget/interval/exchange combination that cannot load. */
        function reflectWarning() {
            const problem = widgetIntradayProblem({
                source: sourceSelect.value,
                symbol: symbolInput.value,
                interval: intervalSelect.value,
            });
            warning.hidden = !problem;
            if (problem) {
                warningText.textContent = problem.message;
                useNse.textContent = `Use NSE:${problem.ticker}`;
            }
        }

        useNse.addEventListener('click', () => {
            const problem = widgetIntradayProblem({
                source: sourceSelect.value,
                symbol: symbolInput.value,
                interval: intervalSelect.value,
            });
            if (problem) symbolInput.value = `NSE:${problem.ticker}`;
            reflectWarning();
        });

        warningAction.addEventListener('click', () => {
            const problem = widgetIntradayProblem({
                source: sourceSelect.value,
                symbol: symbolInput.value,
                interval: intervalSelect.value,
            });
            sourceSelect.value = 'nse';
            // Angel One takes a plain ticker; the widget's prefix would not resolve.
            if (problem) symbolInput.value = problem.ticker;
            reflectSource();
        });

        sourceSelect.addEventListener('change', () => {
            reflectSource();
            symbolList.replaceChildren();
        });
        intervalSelect.addEventListener('change', reflectWarning);
        reflectSource();

        // Debounced lookup against the server's instrument cache.
        let searchTimer = null;
        symbolInput.addEventListener('input', () => {
            reflectWarning();
            if (sourceSelect.value !== 'nse') return;
            clearTimeout(searchTimer);
            const query = symbolInput.value.trim();
            if (query.length < 2) return;
            searchTimer = setTimeout(async () => {
                try {
                    const results = await searchNse(query, { limit: 12 });
                    symbolList.replaceChildren();
                    for (const row of results) {
                        const option = document.createElement('option');
                        option.value = row.name;
                        option.label = `${row.symbol} · ${row.exchange}`;
                        symbolList.append(option);
                    }
                } catch {
                    // Search is a convenience; typing the ticker still works.
                }
            }, 250);
        });

        const grid = element('div', 'modal__grid');
        grid.append(
            field('Data source', sourceSelect),
            field('Symbol', symbolInput),
            field('Interval', intervalSelect),
            field('Style', styleSelect),
        );
        chartSection.append(grid, symbolList, warning, sourceHint, applyAll.wrapper);

        // --- Layout ---
        const layoutSection = element('section', 'modal__section');
        layoutSection.append(element('h3', 'modal__heading', 'Layout'));
        // The header picker is the visual route; this is the keyboard route.
        const layoutSelect = element('select', 'select');
        for (const group of LAYOUT_GROUPS) {
            const optgroup = document.createElement('optgroup');
            optgroup.label = `${group.count} chart${group.count > 1 ? 's' : ''}`;
            for (const layout of group.layouts) {
                const option = document.createElement('option');
                option.value = layout.id;
                option.textContent = layoutLabel(layout);
                if (layout.id === tab.layout) option.selected = true;
                optgroup.append(option);
            }
            layoutSelect.append(optgroup);
        }
        const layoutGrid = element('div', 'modal__grid');
        layoutGrid.append(field('Arrangement', layoutSelect));
        layoutSection.append(layoutGrid, element('p', 'modal__hint',
            'Sync switches for symbol and interval live in the Layout menu.'));

        // --- Chart options ---
        const optionsSection = element('section', 'modal__section');
        optionsSection.append(element('h3', 'modal__heading', 'Chart options'));

        const rangeSelect = select(RANGES, state.chart.range);
        const timezoneSelect = select(TIMEZONES, state.chart.timezone);
        const localeSelect = select(LOCALES, state.chart.locale);

        const optionsGrid = element('div', 'modal__grid');
        optionsGrid.append(
            field('Visible range', rangeSelect),
            field('Time zone', timezoneSelect),
            field('Language', localeSelect),
        );

        const chartBoxes = new Map();
        const chartToggleRow = element('div', 'toggles');
        for (const { key, label } of CHART_TOGGLES) {
            const item = checkbox(label, state.chart[key]);
            chartBoxes.set(key, item.box);
            chartToggleRow.append(item.wrapper);
        }
        optionsSection.append(optionsGrid, chartToggleRow);

        // --- Indicators ---
        const studySection = element('section', 'modal__section');
        studySection.append(element('h3', 'modal__heading', 'Indicators'));
        const studySelect = element('select', 'select select--multi');
        studySelect.multiple = true;
        studySelect.size = Math.min(STUDIES.length, 6);
        for (const study of STUDIES) {
            const option = document.createElement('option');
            option.value = study.value;
            option.textContent = study.label;
            option.selected = state.chart.studies.includes(study.value);
            studySelect.append(option);
        }
        studySection.append(studySelect, element('p', 'modal__hint',
            'Ctrl-click to choose more than one. Applies to every pane.'));

        // --- Side panel ---
        const panelSection = element('section', 'modal__section');
        panelSection.append(element('h3', 'modal__heading', 'Side panel'));
        const panelBoxes = new Map();
        const panelToggleRow = element('div', 'toggles');
        for (const { key, label } of PANEL_TOGGLES) {
            const item = checkbox(label, state.panel[key]);
            panelBoxes.set(key, item.box);
            panelToggleRow.append(item.wrapper);
        }
        const watchlistArea = element('textarea', 'textarea');
        watchlistArea.rows = 4;
        watchlistArea.spellcheck = false;
        watchlistArea.value = state.panel.symbols.join('\n');
        panelSection.append(
            panelToggleRow,
            field('Watchlist symbols, one per line', watchlistArea),
            element('p', 'modal__hint', 'The panel attaches to the last pane — the only one with room for it.'),
        );

        // --- Ticker tape ---
        const tickerSection = element('section', 'modal__section');
        tickerSection.append(element('h3', 'modal__heading', 'Ticker tape'));
        const tickerOn = checkbox('Show the ticker tape', state.ticker.enabled);
        const tickerArea = element('textarea', 'textarea');
        tickerArea.rows = 6;
        tickerArea.spellcheck = false;
        tickerArea.value = state.ticker.symbols
            .map((item) => (item.title ? `${item.proName} | ${item.title}` : item.proName))
            .join('\n');
        tickerSection.append(
            tickerOn.wrapper,
            field('Symbols, one per line as SYMBOL | Label', tickerArea),
        );

        body.append(chartSection, layoutSection, optionsSection, studySection, panelSection, tickerSection);

        apply = () => {
            // NSE tickers must not carry an exchange prefix; the widget requires one.
            const typed = symbolInput.value.trim().toUpperCase();
            const symbol = (sourceSelect.value === 'nse' && typed.includes(':')
                ? typed.slice(typed.indexOf(':') + 1)
                : typed) || pane.symbol;
            const interval = intervalSelect.value;
            const style = styleSelect.value;
            const everyPane = applyAll.box.checked;
            const layout = layoutSelect.value;

            api.update((draft) => {
                const target = draft.tabs.find((item) => item.id === draft.activeTabId) || draft.tabs[0];

                if (layout !== target.layout) {
                    setLayout(target, layout);
                }

                // The sync switches in the Layout menu make propagation the
                // standing behaviour; the checkbox is a one-off override.
                const current = target.panes[target.activePane] || target.panes[0];
                current.symbol = symbol;
                current.interval = interval;
                current.style = style;
                current.source = sourceSelect.value;

                for (const item of target.panes) {
                    if (item === current) continue;
                    // Symbol formats differ per source, so only propagate between
                    // panes that read the same feed.
                    const sameSource = item.source === current.source;
                    if ((everyPane || draft.sync.symbol) && sameSource) item.symbol = symbol;
                    if (everyPane || draft.sync.interval) item.interval = interval;
                    if (everyPane) item.style = style;
                }

                draft.chart.range = rangeSelect.value;
                draft.chart.timezone = timezoneSelect.value;
                draft.chart.locale = localeSelect.value;
                draft.chart.studies = [...studySelect.selectedOptions].map((option) => option.value);
                for (const [key, box] of chartBoxes) draft.chart[key] = box.checked;
                for (const [key, box] of panelBoxes) draft.panel[key] = box.checked;

                draft.panel.symbols = watchlistArea.value
                    .split('\n')
                    .map((line) => line.trim().toUpperCase())
                    .filter(Boolean);

                draft.ticker.enabled = tickerOn.box.checked;
                draft.ticker.symbols = tickerArea.value
                    .split('\n')
                    .map((line) => {
                        const [proName, title] = line.split('|').map((part) => part.trim());
                        if (!proName) return null;
                        return title ? { proName: proName.toUpperCase(), title } : { proName: proName.toUpperCase() };
                    })
                    .filter(Boolean);
            }, { reason: 'panes' });
        };

        dialog.showModal();
    }

    return { open };
}

/** Grows or shrinks a tab's pane list to match a new layout. */
export function setLayout(tab, layout) {
    const id = normaliseLayoutId(layout);
    const count = layoutPanes(id);
    // New panes inherit the active pane so a split does not blank the screen.
    const template = tab.panes[tab.activePane] || tab.panes[0];
    while (tab.panes.length < count) {
        tab.panes.push({ ...template });
    }
    tab.panes.length = count;
    tab.layout = id;
    tab.activePane = Math.min(tab.activePane, count - 1);
    tab.maximised = null;
}

/** Shortcuts reference. */
export function createShortcutsDialog(shortcuts) {
    const { dialog, body, foot } = createDialog('Keyboard shortcuts');

    const done = element('button', 'btn btn--primary', 'Close');
    done.type = 'button';
    done.addEventListener('click', () => dialog.close());
    foot.append(element('span', 'modal__spacer'), done);

    const table = element('table', 'shortcuts');
    for (const { keys, description } of shortcuts) {
        const row = document.createElement('tr');
        const keyCell = document.createElement('td');
        keyCell.className = 'shortcuts__keys';
        for (const key of keys) {
            keyCell.append(element('kbd', null, key));
        }
        const descCell = document.createElement('td');
        descCell.textContent = description;
        row.append(keyCell, descCell);
        table.append(row);
    }

    body.append(table, element('p', 'modal__hint',
        'These act on the workspace. While the pointer or focus is inside a chart, ' +
        'keystrokes go to TradingView’s own shortcuts instead — the chart is a ' +
        'cross-origin frame, so the page cannot intercept them. Click outside a ' +
        'chart first, or use the header buttons.'));

    return { open: () => dialog.showModal() };
}
