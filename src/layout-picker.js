/**
 * The layout picker popover: every arrangement in the catalogue grouped by pane
 * count, plus the sync switches.
 *
 * Icons are generated from the same specs that drive the CSS grid, so what you
 * click is what you get.
 */

import {
    HEAVY_LAYOUT_THRESHOLD, LAYOUT_GROUPS, layoutIconSvg, layoutLabel,
} from './config.js';

const SYNC_ITEMS = [
    {
        key: 'symbol',
        label: 'Symbol',
        hint: 'A symbol from the header search goes to every pane. Changes made '
            + 'inside a chart cannot be detected — the chart is a cross-origin '
            + 'frame and reports nothing back.',
    },
];

/**
 * @param {HTMLElement} root  The popover container.
 * @param {object} handlers
 * @param {(id: string) => void} handlers.onPick
 * @param {(key: string, value: boolean) => void} handlers.onSync
 */
export function createLayoutPicker(root, handlers) {
    root.classList.add('picker');

    const grid = document.createElement('div');
    grid.className = 'picker__groups';

    /** @type {Map<string, HTMLButtonElement>} */
    const buttons = new Map();

    for (const group of LAYOUT_GROUPS) {
        const row = document.createElement('div');
        row.className = 'picker__row';

        const count = document.createElement('span');
        count.className = 'picker__count';
        count.textContent = String(group.count);

        const options = document.createElement('div');
        options.className = 'picker__options';

        for (const layout of group.layouts) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'picker__option';
            button.dataset.layout = layout.id;
            button.title = layoutLabel(layout);
            button.setAttribute('aria-label', layoutLabel(layout));
            button.innerHTML = layoutIconSvg(layout);
            button.addEventListener('click', () => handlers.onPick(layout.id));
            options.append(button);
            buttons.set(layout.id, button);
        }

        row.append(count, options);
        grid.append(row);
    }

    // --- Sync switches ---
    const syncSection = document.createElement('div');
    syncSection.className = 'picker__sync';
    syncSection.append(Object.assign(document.createElement('h3'), {
        className: 'picker__syncTitle',
        textContent: 'Sync in layout',
    }));

    /** @type {Map<string, HTMLInputElement>} */
    const syncBoxes = new Map();

    for (const item of SYNC_ITEMS) {
        const row = document.createElement('label');
        row.className = 'switchRow';

        const label = document.createElement('span');
        label.className = 'switchRow__label';
        label.textContent = item.label;

        const info = document.createElement('span');
        info.className = 'switchRow__info';
        info.textContent = 'i';
        info.title = item.hint;
        info.setAttribute('role', 'img');
        info.setAttribute('aria-label', item.hint);
        label.append(info);

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'switch';
        box.addEventListener('change', () => handlers.onSync(item.key, box.checked));
        syncBoxes.set(item.key, box);

        row.append(label, box);
        syncSection.append(row);
    }

    const note = document.createElement('p');
    note.className = 'picker__note';

    // The only place the key bindings are written down, now that the shortcuts
    // dialog is gone. Kept in step with shortcuts.js by hand — it is five lines.
    const keys = document.createElement('p');
    keys.className = 'picker__keys';
    keys.innerHTML = '<kbd>/</kbd> search · <kbd>Alt</kbd><kbd>L</kbd> this menu · '
        + '<kbd>Alt</kbd><kbd>D</kbd> theme · <kbd>Alt</kbd><kbd>←</kbd><kbd>→</kbd> pane · '
        + '<kbd>Alt</kbd><kbd>1</kbd>–<kbd>5</kbd> layout';

    root.append(grid, syncSection, note, keys);

    return {
        /** Marks the active layout and mirrors the stored sync flags. */
        sync(state) {
            for (const [id, button] of buttons) {
                button.classList.toggle('picker__option--active', id === state.layout);
            }
            for (const [key, box] of syncBoxes) {
                box.checked = Boolean(state.sync[key]);
            }
            const panes = state.panes.length;
            if (panes > HEAVY_LAYOUT_THRESHOLD) {
                note.textContent = `${panes} panes means ${panes} separate chart frames — `
                    + 'expect noticeable memory and network use.';
                note.hidden = false;
            } else {
                note.hidden = true;
            }
        },
    };
}
