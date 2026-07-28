/**
 * Bottom tab strip. Each tab is a saved workspace: its own layout, panes and
 * per-pane symbols.
 */

import { intervalLabel, layoutPanes } from './config.js';

/** Strips the exchange prefix for a compact tab label. */
const shortSymbol = (symbol) => String(symbol).split(':').pop();

/**
 * @param {HTMLElement} host
 * @param {object} handlers
 * @param {(id: string) => void} handlers.onSelect
 * @param {() => void} handlers.onAdd
 * @param {(id: string) => void} handlers.onClose
 */
export function createTabStrip(host, handlers) {
    function render(state) {
        host.replaceChildren();

        for (const tab of state.tabs) {
            const pane = tab.panes[tab.activePane] || tab.panes[0];
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'tab';
            button.classList.toggle('tab--active', tab.id === state.activeTabId);
            button.title = tab.panes.map((item) => item.symbol).join(', ');

            button.append(Object.assign(document.createElement('span'), {
                className: 'tab__label',
                textContent: `${shortSymbol(pane.symbol)} ${intervalLabel(pane.interval)}`,
            }));

            // Badge only earns its space once a tab holds more than one chart.
            const count = layoutPanes(tab.layout);
            if (count > 1) {
                button.append(Object.assign(document.createElement('span'), {
                    className: 'tab__badge',
                    textContent: `⊞${count}`,
                }));
            }

            button.addEventListener('click', () => handlers.onSelect(tab.id));

            if (state.tabs.length > 1) {
                const close = document.createElement('span');
                close.className = 'tab__close';
                close.textContent = '×';
                close.title = 'Close this tab';
                close.setAttribute('role', 'button');
                close.addEventListener('click', (event) => {
                    event.stopPropagation();
                    handlers.onClose(tab.id);
                });
                button.append(close);
            }

            host.append(button);
        }

        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'tab tab--add';
        add.textContent = '+';
        add.title = 'New tab';
        add.setAttribute('aria-label', 'New tab');
        add.addEventListener('click', handlers.onAdd);
        host.append(add);
    }

    return { render };
}
