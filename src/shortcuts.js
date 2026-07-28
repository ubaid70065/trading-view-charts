/**
 * Workspace keyboard shortcuts.
 *
 * These only fire while focus is outside a chart. A cross-origin iframe receives
 * its own key events and the embedding page never sees them, so anything typed
 * over a chart reaches TradingView's shortcuts instead. That is a property of
 * the embed, not something the page can work around.
 */

/** Rendered in the Shortcuts dialog and bound below — one source of truth. */
export const SHORTCUTS = [
    { keys: ['Alt', '1'], description: 'Single chart' },
    { keys: ['Alt', '2'], description: 'Two columns' },
    { keys: ['Alt', '3'], description: 'Two rows' },
    { keys: ['Alt', '4'], description: 'Three columns' },
    { keys: ['Alt', '5'], description: 'Grid of four' },
    { keys: ['Alt', 'L'], description: 'Open the layout picker' },
    { keys: ['Alt', 'D'], description: 'Toggle dark / light theme' },
    { keys: ['Alt', 'S'], description: 'Snapshot the workspace' },
    { keys: ['Alt', 'M'], description: 'Maximise or restore the active pane' },
    { keys: ['Alt', 'N'], description: 'New tab' },
    { keys: ['Alt', 'W'], description: 'Close the current tab' },
    { keys: ['Alt', '→'], description: 'Next pane' },
    { keys: ['Alt', '←'], description: 'Previous pane' },
    { keys: ['Alt', ','], description: 'Open settings' },
    { keys: ['?'], description: 'Show this list' },
    { keys: ['Esc'], description: 'Close a dialog or menu' },
];

/**
 * @param {object} actions Callbacks for each bound key.
 */
export function bindShortcuts(actions) {
    window.addEventListener('keydown', (event) => {
        // Never hijack typing in the settings dialog.
        const tag = event.target && event.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

        if (event.key === 'Escape') {
            actions.onEscape();
            return;
        }

        if (event.key === '?' && !event.altKey && !event.ctrlKey) {
            event.preventDefault();
            actions.onShortcuts();
            return;
        }

        if (!event.altKey || event.ctrlKey || event.metaKey) return;

        // event.code is layout-independent for digits and letters.
        const layoutByCode = {
            Digit1: 'r:1',
            Digit2: 'c:1-1',
            Digit3: 'r:1-1',
            Digit4: 'c:1-1-1',
            Digit5: 'r:2-2',
        };
        if (layoutByCode[event.code]) {
            event.preventDefault();
            actions.onLayout(layoutByCode[event.code]);
            return;
        }

        switch (event.code) {
            case 'KeyL':
                event.preventDefault();
                actions.onLayoutMenu();
                break;
            case 'KeyD':
                event.preventDefault();
                actions.onTheme();
                break;
            case 'KeyS':
                event.preventDefault();
                actions.onSnapshot();
                break;
            case 'KeyM':
                event.preventDefault();
                actions.onMaximise();
                break;
            case 'KeyN':
                event.preventDefault();
                actions.onNewTab();
                break;
            case 'KeyW':
                event.preventDefault();
                actions.onCloseTab();
                break;
            case 'ArrowRight':
                event.preventDefault();
                actions.onPane(1);
                break;
            case 'ArrowLeft':
                event.preventDefault();
                actions.onPane(-1);
                break;
            case 'Comma':
                event.preventDefault();
                actions.onSettings();
                break;
            default:
                break;
        }
    });
}
