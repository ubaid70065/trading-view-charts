/**
 * Workspace keyboard shortcuts.
 *
 * These only fire while focus is outside a chart. A cross-origin iframe receives
 * its own key events and the embedding page never sees them, so anything typed
 * over a chart reaches TradingView's shortcuts instead. That is a property of
 * the embed, not something the page can work around.
 *
 * The bindings are listed in the layout menu's footnote — there is no separate
 * shortcuts dialog.
 */

/**
 * @param {object} actions Callbacks for each bound key.
 */
export function bindShortcuts(actions) {
    window.addEventListener('keydown', (event) => {
        // Never hijack typing in the search box.
        const tag = event.target && event.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

        if (event.key === 'Escape') {
            actions.onEscape();
            return;
        }

        if (event.key === '/' && !event.altKey && !event.ctrlKey && !event.metaKey) {
            // Without this the '/' lands in the box it just focused.
            event.preventDefault();
            actions.onSearch();
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
            case 'ArrowRight':
                event.preventDefault();
                actions.onPane(1);
                break;
            case 'ArrowLeft':
                event.preventDefault();
                actions.onPane(-1);
                break;
            default:
                break;
        }
    });
}
