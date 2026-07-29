/**
 * Bridges the two `getBars` call conventions TradingView has shipped.
 *
 * The Datafeed API changed shape at Advanced Charts v18. Both spellings are
 * still in the wild — the library is licensed per user, so which one a given
 * install speaks depends on when that user was granted access, not on anything
 * this repo controls:
 *
 *   ≤ v17  getBars(symbolInfo, resolution, from, to, onResult, onError, isFirstCall)
 *   ≥ v18  getBars(symbolInfo, resolution, periodParams, onResult, onError)
 *
 * Writing to only the newer one fails in a way that reads as a datafeed bug
 * rather than a version mismatch: the callbacks land on the wrong arguments and
 * the chart dies on `onResult is not a function`, several frames from the
 * cause. Both bundled `.d.ts` files declare their own signature, so the version
 * in `public/charting_library/` is the authority on which arrives.
 *
 * @param {IArguments|Array} args  The arguments `getBars` was called with.
 * @returns {{from: number, to: number, firstDataRequest: boolean,
 *            onResult: Function, onError: Function}}
 */
export function periodArgs(args) {
    const [, , third, fourth, fifth, sixth, seventh] = args;

    // The newer form packs the range into one object; the older passes numbers.
    if (third && typeof third === 'object') {
        return {
            from: third.from,
            to: third.to,
            firstDataRequest: Boolean(third.firstDataRequest),
            onResult: fourth,
            onError: fifth,
        };
    }

    return {
        from: third,
        to: fourth,
        firstDataRequest: Boolean(seventh),
        onResult: fifth,
        onError: sixth,
    };
}
