/**
 * The master symbol search in the header.
 *
 * One box drives the whole layout: submitting applies the symbol to every pane
 * when symbol sync is on, and to the active pane alone when it is off. The scope
 * button writes the same `sync.symbol` flag the layout menu switch does, so the
 * two controls can never disagree about what "sync" means.
 *
 * The box can only ever show the symbol *this app* last set. Reading one back
 * out of a chart is impossible — the panes are cross-origin iframes, and a
 * symbol changed inside one is never reported to the page.
 */

/**
 * @param {object} handlers
 * @param {(symbol: string) => void} handlers.onSubmit
 * @param {(value: boolean) => void} handlers.onScope
 */
export function mountSearch(handlers) {
    const form = document.getElementById('searchForm');
    const input = document.getElementById('symbolSearch');
    const scope = document.getElementById('searchScope');

    // What the active pane is on, so Escape can put it back.
    let shown = '';
    let syncOn = false;

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        const typed = input.value.trim();
        if (!typed) return;
        // Blur first, for two reasons: it hands the keyboard back to the
        // workspace shortcuts, which stand down while a text field has focus,
        // and it lets the render that follows write the symbol the panes
        // actually took — 'nse:reliance' comes back as 'RELIANCE'.
        input.blur();
        handlers.onSubmit(typed);
    });

    input.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        // Abandon the edit here rather than letting it close a dialog or menu.
        event.stopPropagation();
        input.value = shown;
        input.blur();
    });

    scope.addEventListener('click', () => handlers.onScope(!syncOn));

    return {
        focus() {
            input.focus();
            input.select();
        },

        /** Mirrors the active pane's symbol and the stored sync flag. */
        sync(state) {
            syncOn = Boolean(state.sync.symbol);
            scope.setAttribute('aria-pressed', String(syncOn));
            scope.textContent = syncOn ? 'All charts' : 'Active chart';
            scope.title = syncOn
                ? 'A searched symbol goes to every pane in this layout. Click for the active pane only.'
                : 'A searched symbol goes to the active pane only. Click to apply it to every pane.';

            const pane = state.panes[state.activePane] || state.panes[0];
            shown = pane.symbol;
            // Never overwrite a half-typed symbol.
            if (document.activeElement !== input) input.value = shown;
        },
    };
}
