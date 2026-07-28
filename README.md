# Advanced Chart workspace

A multi-chart trading workspace with **two data sources per pane**:

- **TradingView widget** — their data and their full UI (indicators, drawings, toolbars),
  free and with no signup.
- **NSE via Angel One** — *your* SmartAPI feed, drawn in-page with Lightweight Charts.

Plus a ticker tape, a 55-layout picker (1–16 panes), watchlist and symbol details, layout
tabs, and Settings / Shortcuts / Snapshot from the header.

## Run

```bash
npm start            # http://localhost:5500
node server.js 8080  # or any other port
npm test             # contract + logic tests
```

Must be served over HTTP — ES modules do not load on `file://`, and the NSE pane needs the
`/api` routes. `npm start` runs both the static server and the API.

**Port 5500 is deliberate**: it is also VS Code Live Server's default, so the address you
already use keeps working. The two cannot run at the same time, and this one has to win —
Live Server serves the HTML happily but 404s every `/api` call, so NSE panes go dead under
it. If `npm start` reports the port is in use, stop Live Server from the VS Code status bar.
A pane that finds no API says so directly rather than reporting a bare HTTP 404.

## Features

| Feature | Notes |
| --- | --- |
| **Ticker tape** | Quote strip across the top. Symbols and labels are editable in Settings. |
| **Layouts** | Single, two columns, two rows, three, or a grid of four. Each pane is an independent chart. |
| **Panes** | Per-pane symbol, interval and style. Click a header to select; ⤢ maximises. |
| **Watchlist + details** | Attaches to the last pane — the only one with room. Toggle in Settings. |
| **Tabs** | Each tab is a saved workspace with its own layout and symbols. `+` adds, `×` closes. |
| **Theme** | Dark / light across page chrome, charts and ticker tape. |
| **Snapshot** | Saves a PNG of the whole workspace. |
| **Shortcuts** | Workspace keybindings, listed in the dialog. |
| **Status pill** | `detecting…` until the first chart loads, then `live`; tracks offline events. |

Everything persists to localStorage. **Settings → Reset everything** restores defaults.

## NSE data (Angel One SmartAPI)

Set a pane's **Data source** to *NSE — Angel One* in Settings and it renders your feed
instead of TradingView's.

### Why it needs a server

SmartAPI sends no CORS headers, so the browser cannot call it directly; login needs a
client code, PIN and TOTP secret that must never reach the page; and the instrument master
is a 33 MB file. All of that lives in `server/`, and the page talks only to same-origin
`/api/*`.

### Credentials

Copy `.env.example` to `.env` and fill in all four values — **the API key alone cannot log
in**. `.env` is gitignored and the server refuses to serve it (403).

| Variable | Notes |
| --- | --- |
| `SMARTAPI_KEY` | From SmartAPI → My Apps |
| `SMARTAPI_CLIENT_CODE` | Your Angel One login ID |
| `SMARTAPI_PASSWORD` | The numeric **MPIN**, not the web password |
| `SMARTAPI_TOTP_SECRET` | The base32 string behind the TOTP QR code, not the 6 digits |

The server generates TOTP codes itself (RFC 6238, verified against the spec's test vectors
in `test/totp.test.mjs`), so nothing is typed by hand. If login fails with `Invalid totp`,
check the machine clock — the codes are time-based.

### Endpoints

| Route | Auth | Notes |
| --- | --- | --- |
| `GET /api/health` | no | What is configured, session state, cache stats |
| `GET /api/search?q=reli` | no | Instrument search; `&all=1` to include debt |
| `GET /api/quote?symbols=RELIANCE,INFY` | yes | Live LTP, OHLC, % change; max 50 |
| `GET /api/candles?symbol=RELIANCE&interval=D` | yes | Historical bars, auto-paged |

## UDF datafeed

The same Angel One data is also served in **UDF**, the datafeed protocol TradingView's
charting products speak. UDF is a published contract, not a hosted service — implementing
it means any TradingView-compatible chart can read your feed while the data stays yours.

| Route | Notes |
| --- | --- |
| `GET /udf/config` | Capabilities and the served resolutions |
| `GET /udf/time` | Server clock, unix seconds, as plain text |
| `GET /udf/symbols?symbol=NSE:RELIANCE` | One SymbolInfo |
| `GET /udf/search?query=reli` | Symbol search |
| `GET /udf/history?symbol=RELIANCE&resolution=5&from=…&to=…` | OHLCV column arrays |

[src/nse/datafeed.js](src/nse/datafeed.js) is the browser client. `createDatafeed()` returns
a Datafeed API object — `onReady`, `resolveSymbol`, `getBars`, `subscribeBars` — to hand
straight to an Advanced Charts widget as `datafeed:`. Live bars come from `/api/quote`
polling folded into the forming candle, the same approach the Lightweight Charts pane uses.

Four things here are easy to get wrong, and each is pinned by `test/udf.test.mjs`:

- **UDF times are true UTC**, unlike the Lightweight Charts pane, which shifts by +05:30
  because it renders in UTC with no time-zone option. SymbolInfo carries
  `timezone: Asia/Kolkata` and the library localises, so shifting here would move every bar
  5½ hours.
- **`minmov / pricescale` must equal the tick size.** NSE ticks are whole paise, so
  pricescale is fixed at 100 and minmov carries the tick — ₹0.05 is `5/100`, not `0.05`.
- **Weekly and monthly are refused, not downgraded.** Angel serves no W/M candles;
  answering them with daily bars would draw a chart that looks right and is wrong.
- **Errors ride inside a 200 body** as `{s: "error", errmsg}`. The library reads the
  envelope and discards the status code, so a 4xx surfaces as an unexplained network error.

Unit units differ across the API on purpose — `getBars` receives seconds and returns
milliseconds. Both are UTC.

These routes send no CORS headers. Angel One data is licensed to whoever runs the server,
not to whoever finds the port.

The first `/api/search` downloads the 33 MB scrip master (~3 minutes), reduces it to
22,542 NSE+BSE rows, and caches 2.7 MB to `data/`. Later boots read the cache in ~60 ms and
refresh daily. Requests to SmartAPI are serialised with a minimum gap, because its
per-second limits answer with a rejection that costs more than the wait.

### What you can name

A symbol may be a plain ticker (`RELIANCE`), a full trading symbol (`RELIANCE-EQ`,
`NSE:RELIANCE-EQ`), an index (`NIFTY`, `BANKNIFTY`, `INDIA VIX`, `NIFTY IT`) or a raw token.
Matching is case-insensitive.

Three things about the master are worth knowing, because each one silently produces a wrong
or empty chart if ignored. All three are asserted in `test/instruments.test.mjs` against rows
copied verbatim from the published file:

- **Indices are listed twice.** `Nifty 50` (token 99926000) serves quotes *and* candles; a
  second `NIFTY` row (token 26000) serves quotes and returns **no candles at all**. Since
  `NIFTY` is the trading symbol of the second and the name of the first, lookups compare both
  candidates and keep the one that can be charted.
- **`-EQ` is not the only tradable series.** `-BE`, `-BZ`, `-SM`, `-ST` and `-IV` add ~900
  instruments, so a bare ticker is expanded across all of them — `GVKPIL` finds `GVKPIL-BE`.
- **Tick sizes are quoted in paise and vary by price band** — ₹0.01 up to ₹5.00. They are
  converted to rupees and used as the chart's `minMove`; a fixed value mislabels prices (at
  the old hardcoded ₹0.05, 108 of SUZLON's last 137 closes rendered wrong).

Search returns indices and tradable equities. The ~14,000 government securities, state
development loans, T-bills and mutual-fund units are hidden behind `&all=1`, as are exchange
test scrips. BSE publishes no series code, so its debt rows cannot be separated this way;
NSE, which is what the charts use, is unaffected.

### Limits of this source

- **Intervals**: 1, 3, 5, 10, 15, 30, 60 minute and daily. Anything else falls back to the
  nearest, and the pane header shows what actually loaded.
- **Live updates are polled**, not streamed: `/api/quote` every 5s folds the latest price
  into the forming candle. Angel One's WebSocket feed would replace this.
- **No indicators or drawing tools.** Lightweight Charts is a rendering library, not the
  TradingView UI. Panes needing those should stay on the widget source.
- **Indices carry no volume**, so the volume strip is omitted for them rather than drawn
  as a flat zero.
- Times are shifted by +05:30 before rendering, because Lightweight Charts draws in UTC
  and has no time-zone option — without it the 09:15 open would be labelled 03:45.

## Indian symbols on the TradingView source

**NSE is fully supported and real-time**, free, with no signup. Per TradingView's own
scanner (`scanner.tradingview.com/global/scan`, column `update_mode`):

| Symbol | Mode |
| --- | --- |
| `NSE:RELIANCE`, `NSE:TCS`, `NSE:NIFTY` | `streaming` — real-time |
| `BSE:RELIANCE` | `delayed_streaming_900` — 15 minutes |
| `NASDAQ:AAPL` | `delayed_streaming_900` — 15 minutes |

So Indian equities get *better* treatment than US ones here. **BSE** is the restricted one:
delayed quotes and end-of-day charts, so an intraday interval makes the pane draw *"Only D,
W, M intervals are available for this symbol"* — inside the iframe, where the page cannot
see it and there is nothing useful to click.

**Always prefix the exchange.** An unprefixed symbol lets TradingView resolve the listing,
and for a dual-listed Indian company it commonly picks BSE — so `RELIANCE` at 3m gives a
dead chart while `NSE:RELIANCE` gives a real-time one.

Settings catches the combination before the pane is built and offers both escapes,
`NSE:<ticker>` first: it keeps real-time data *and* the indicators and drawing tools, which
moving to the Angel One source gives up. Rules are in `widgetIntradayProblem()` in
[src/config.js](src/config.js), covered by `test/widget-limits.test.mjs`.

### So when is the Angel One source worth using?

When you want the data to be *yours*: no dependence on TradingView's entitlements, bars
straight from your SmartAPI subscription, and a chart object the page can actually drive.
For everyday charting with indicators and drawings, `NSE:` on the widget is the better pane.

## Three constraints the embed imposes

These are properties of the free widget, not gaps in the app. Worth knowing before you
extend it.

**1. No API on a loaded chart.** The iframe is cross-origin, so there is no way to set a
symbol, theme or interval after load. Every change re-embeds, which reloads that chart.
Panes are therefore diffed by a settings signature — changing one pane's symbol re-embeds
only that pane, while switching layout or tab rebuilds the grid. Each re-embed also re-runs
the vendor script, which registers `window` listeners it offers no way to remove, so avoid
driving a re-embed from anything high-frequency.

**2. Keyboard and mouse events inside a chart never reach the page.** Workspace shortcuts
fire only while focus is outside a chart; over a chart, keys go to TradingView's own
shortcuts. Clicks are the same, which is why pane selection also watches for focus moving
to an iframe (`window.blur` + `document.activeElement`) rather than relying on a click
handler that can never fire.

**3. Charts cannot be drawn to a canvas.** Snapshot uses the Screen Capture API, so the
browser asks which surface to share — pick this tab. For a single chart with no prompt,
use the camera button in that chart's own toolbar.

## Accepted settings

Both embed scripts filter your JSON against an internal whitelist and **silently drop
anything else**, which is why unfamiliar options appear to do nothing. Both lists in
[src/config.js](src/config.js) were read out of the shipped vendor scripts, and a test
asserts they still match (51 chart keys, 8 ticker keys).

Commonly copied from older snippets but **not** accepted by the chart widget:
`enable_publishing`, `calendar`, `toolbar_bg`. Options that *are* honoured include
`overrides`, `enabled_features` / `disabled_features`, `studies`, `compareSymbols`,
`watchlist`, `hide_legend`, `percentage` and `fundamental`. The ticker tape accepts only
`symbols, locale, showSymbolLogo, colorTheme, isTransparent, largeChartUrl, displayMode,
customer` — it has no width/height/autosize.

Symbols use `EXCHANGE:TICKER` — `NASDAQ:AAPL`, `BINANCE:BTCUSDT`, `FX:EURUSD`, `TVC:GOLD`.

Time zones are checked against the set TradingView supports, with aliases mapped (Windows
reports `Asia/Calcutta`, the widget wants `Asia/Kolkata`); anything unrecognised falls
back to UTC.

## Layout

```
index.html        App shell
server.js         Static server + /api routes (no dependencies)
css/app.css       Page chrome — widget charts are cross-origin iframes themed
                  through widget settings, not CSS
server/           Never served to the browser (403)
  env.js          .env loader, credential presence checks
  totp.js         RFC 6238 TOTP for SmartAPI login
  angel.js        Session, rate limiting, quotes, paged historical candles
  instruments.js  33 MB scrip master → slim cached NSE/BSE index; symbol,
                  name and token lookup, series and tick-size handling
  routes.js       JSON API surface
  udf.js          UDF datafeed protocol over the same Angel One data
src/
  main.js         Wiring, actions, render loop
  config.js       Vendor whitelists, layout catalogue, defaults, timezones
  state.js        Workspace state, persistence, corrupt-payload repair
  widget.js       Embed mechanics for chart and ticker, attribution element
  panes.js        Pane grid, signature diffing, source selection
  layout-picker.js  55-layout menu with generated icons, sync switches
  header.js       Header buttons, layout menu, status pill
  tabs.js         Tab strip
  dialogs.js      Settings and Shortcuts dialogs
  shortcuts.js    Key bindings (single source of truth with the dialog)
  snapshot.js     Screen Capture → PNG
  nse/
    api.js        Client for /api/*
    chart.js      Lightweight Charts pane, IST handling, live polling
    datafeed.js   TradingView Datafeed API over /udf/*
vendor/
  lightweight-charts…js   Pinned v4.2.3, Apache-2.0 (see LICENSE beside it)
test/             npm test — 72 assertions
data/             Cached instrument master (gitignored)
```

## Licence

The **embed widgets** are free to use, including commercially, as long as the TradingView
attribution stays visible. It sits in the footer next to the tabs and links to the active
symbol; the ticker tape carries TradingView's own logo. Do not remove either.

**Lightweight Charts** is Apache-2.0 and vendored into `vendor/` with its licence, so it is
redistributable — unlike the Advanced Charts library, which is not.

Angel One market data is licensed to you under your SmartAPI agreement, not by this project.

## If you outgrow this

Two things the NSE source cannot do, both because Lightweight Charts is a renderer rather
than a charting application: **indicators and drawing tools**. Getting those *on top of your
own data* needs the **Advanced Charts** library — a separate, self-hosted TradingView
product requiring approval at
[tradingview.com/advanced-charts](https://www.tradingview.com/advanced-charts/).

**The datafeed half of that is already built** — `/udf/*` and `createDatafeed()` above. What
is missing is only the library itself, which cannot be vendored here: unlike Lightweight
Charts (Apache-2.0, redistributable), Advanced Charts is licensed per-user. Once you have
been granted access, drop its files in and point a widget at the datafeed:

```js
import { createDatafeed } from './src/nse/datafeed.js';

new TradingView.widget({
    container: host,
    library_path: '/charting_library/',
    symbol: 'NSE:RELIANCE',
    interval: '5',
    datafeed: createDatafeed(),
    timezone: 'Asia/Kolkata',
});
```

That is the combination the free embed cannot give you at any price: **your** bars, with
indicators and drawing tools on top.

The other likely next step is replacing the 5-second quote polling with Angel One's
WebSocket feed (SmartWebSocketV2), using the `feedToken` the login already returns.
