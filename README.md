# Advanced Chart workspace

A multi-chart trading workspace with **two data sources per pane**:

- **TradingView widget** — their data and their full UI (indicators, drawings, toolbars),
  free and with no signup.
- **NSE via Angel One** — *your* SmartAPI feed, drawn in-page with Lightweight Charts.

One master symbol search drives every pane at once. Plus a ticker tape, a 55-layout picker
(1–16 panes), and a watchlist — and nothing else in the chrome, by design.

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
| **Master search** | One box in the header drives the layout. Type a symbol, press Enter, every pane follows. `/` jumps to it; the pill beside it switches between *All charts* and *Active chart*. |
| **Layouts** | 55 arrangements, 1–16 panes, from the Layout menu. Each pane is an independent chart. |
| **Panes** | Click one to make it active. Interval, style and drawings come from the chart's own toolbar. |
| **Ticker tape** | Quote strip across the top, loaded once the browser is idle so it does not slow the charts. |
| **Watchlist + details** | Attaches to the last pane — the only one with room. |
| **Theme** | Dark / light across page chrome, charts and ticker tape. |
| **Status pill** | `detecting…` until the first chart loads, then `live`; tracks offline events. |

Everything persists to localStorage. The keys are listed at the foot of the Layout menu.

There is no settings dialog, no tab strip, no snapshot button: the header is the search box,
the Layout menu and the theme toggle. Per-chart controls — interval, indicators, drawings,
symbol search — live in each chart's own toolbar, which is where the widget puts them
anyway. To start over, clear `tv:workspace:v2` from the browser's local storage.

## NSE data (Angel One SmartAPI)

A pane whose `source` is `nse` renders your feed instead of TradingView's, drawn in-page
with Lightweight Charts.

> **No UI reaches this any more.** The settings dialog was the only place to switch a pane's
> data source, so with it gone the source can only be set by editing `tv:workspace:v2` in
> local storage. The code path is intact and still tested — and `src/nse/` now loads on
> demand, so it costs a workspace of widget panes nothing. Ask if you want a per-pane source
> toggle back in the pane header; it is a small addition.
>
> For everyday Indian charting this matters less than it sounds: `NSE:RELIANCE` on the
> TradingView source is real-time on the free widget *and* keeps indicators and drawings.
> The Angel One source earns its place when you specifically want your own feed.

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

## TradingView feed source (`/tv`)

A third pane source, picked from the dropdown in any pane's header. It reads TradingView's
own widget data socket — the one every free embed already uses — but from this server, so
the bars land on a Lightweight Charts canvas the page owns instead of inside an iframe it
cannot touch.

The point is the combination the other two sources cannot offer: every exchange TradingView
carries *and* a real chart object. No credentials, no signup.

|  | `tv` (embed) | `nse` (Angel One) | `tvfeed` |
| --- | --- | --- | --- |
| Symbols | all TradingView | NSE only | all TradingView |
| Credentials | none | SmartAPI | none |
| Live updates | streamed | polled, 5s | streamed |
| Indicators, drawings | yes | no | no |
| Page can read the chart | no | yes | yes |

```
browser ──/tv/history──▶ server ──wss──▶ widgetdata.tradingview.com
        ◀─/tv/stream───         (one socket, shared by every pane)
```

- [server/ws.js](server/ws.js) — RFC 6455 client. Node 22+ has a global `WebSocket`, but the
  spec forbids setting `Origin` from script and TradingView rejects any handshake without a
  recognised one, so the request line has to be ours. No dependency added.
- [server/tvfeed.js](server/tvfeed.js) — the `~m~`-framed protocol: sessions, symbol
  resolution, history, live bars.
- [server/tv-routes.js](server/tv-routes.js) — same UDF envelope `server/udf.js` serves.
  History is REST; live bars are Server-Sent Events, because this side only ever pushes.
- [src/tv/datafeed.js](src/tv/datafeed.js) — a Datafeed API object for Advanced Charts,
  the sibling of `src/nse/datafeed.js`.
- [src/tv/chart.js](src/tv/chart.js) — the pane, drawn with Lightweight Charts.

### Limits of this source

- **The protocol is undocumented and unversioned.** It is reconstructed from the widget
  bundle, and TradingView owes it no stability — a rename ships whenever they deploy, and
  nothing announces it. A pane that suddenly draws nothing usually means that, not a bug.
- **Their terms cover the widgets as embedded**, not a private client, and the exchange data
  underneath is licensed to them. This is for local use — do not put it behind a public URL
  or redistribute what it returns. Where Angel One has the symbol, it is the licensed path.
- **Symbols must be exchange-qualified** — `NSE:RELIANCE`, not `RELIANCE`. Switching a pane
  between sources rewrites the symbol both ways; where it cannot (a NASDAQ listing moving to
  Angel One) the pane keeps its symbol and says so.
- **No indicators or drawing tools** — same trade as the Angel One pane, for the same
  reason: Lightweight Charts is a renderer, not the TradingView UI.
- **History is paged from now backwards.** The protocol takes a bar *count*, not a range, so
  a window far in the past costs the whole span up to today and is capped at 5000 bars.
- `widgetdata.tradingview.com` is a large rotating pool and how much of it is reachable
  depends on your network. The client re-resolves on each attempt and remembers the node
  that last worked, which is what keeps a first connection from failing outright.

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

Searching such a symbol raises the warning banner and names the fix, `NSE:<ticker>`: it
keeps real-time data *and* the indicators and drawing tools, which moving to the Angel One
source gives up. Rules are in `widgetIntradayProblem()` in [src/config.js](src/config.js),
covered by `test/widget-limits.test.mjs`.

### So when is the Angel One source worth using?

When you want the data to be *yours*: no dependence on TradingView's entitlements, bars
straight from your SmartAPI subscription, and a chart object the page can actually drive.
For everyday charting with indicators and drawings, `NSE:` on the widget is the better pane.

## Load time

First load went from **114 kB across 16 files to 26 kB across 11**, and a repeat load now
fetches **no application code at all**. Five things get it there, in rough order of payoff:

**gzip on the static server.** `server.js` compresses text responses above 1 kB. CSS goes
13.3 kB → 3.4 kB; the Lightweight Charts bundle 164 kB → 51 kB.

**Conditional requests instead of `no-store`.** The server sends a weak `ETag` built from the
file's size and mtime — no hashing, no extra read — with `Cache-Control: no-cache`, which
means *revalidate*, not *do not cache*. Edits still appear on the next reload, exactly as
`no-store` gave us, but unchanged files come back as an empty `304`.

**`nse/` is imported on demand.** [src/panes.js](src/panes.js) reaches it through a dynamic
`import()`, so a workspace of widget panes never pays for the NSE client or the chart
library. `nearestNseInterval()` moved to config.js because the grid needs it synchronously
to label and diff a pane; that one function was the whole reason the module was eager.

**`preconnect` and `modulepreload` in the head.** ES modules are discovered a level at a
time — without the hints, the browser learns about `panes.js` only after `main.js` parses,
and about `widget.js` only after that. The preconnects overlap DNS and TLS for
`s3.tradingview.com` and `tradingview-widget.com` with parsing the document.

**The ticker tape waits for idle.** It is decoration that costs a second vendor script and a
second iframe, competing with the charts for the connection pool. `requestIdleCallback`
holds it until the browser has nothing better to do.

Removing the settings dialog, tab strip and snapshot module took ~26 kB of JS and ~4.5 kB of
CSS with them, which is a real part of the drop but not most of it.

What is *not* optimised is the dominant cost on a wide layout: each pane is a full
TradingView application in its own frame. Sixteen panes will be slow no matter what this
repo does — hence the warning above eight.

## Three constraints the embed imposes

These are properties of the free widget, not gaps in the app. Worth knowing before you
extend it.

**1. No API on a loaded chart.** The iframe is cross-origin, so there is no way to set a
symbol, theme or interval after load. Every change re-embeds, which reloads that chart.
Panes are therefore diffed by a settings signature — changing one pane's symbol re-embeds
only that pane, while switching layout rebuilds the grid. Each re-embed also re-runs
the vendor script, which registers `window` listeners it offers no way to remove, so avoid
driving a re-embed from anything high-frequency.

This is why the master search sets state and lets the diff re-embed, rather than reaching
into the widget. There is no `widget.setSymbol()` or `widget.reload()` on the free embed —
those belong to the paid Charting Library, which is same-origin and self-hosted. It is also
one-directional: a symbol changed *inside* a chart is never reported back, so the search box
shows the last symbol the app set, not necessarily what the chart is displaying.

**2. Keyboard and mouse events inside a chart never reach the page.** Workspace shortcuts
fire only while focus is outside a chart; over a chart, keys go to TradingView's own
shortcuts. Clicks are the same, which is why pane selection also watches for focus moving
to an iframe (`window.blur` + `document.activeElement`) rather than relying on a click
handler that can never fire.

**3. Charts cannot be drawn to a canvas.** Nothing on the page can screenshot a chart —
`html2canvas` and friends see an empty box where the iframe is. Use the camera button in the
chart's own toolbar, which runs inside the frame and can.

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
  search.js       Master symbol search and its scope switch
  state.js        Workspace state, persistence, corrupt-payload repair
  widget.js       Embed mechanics for chart and ticker, attribution element
  panes.js        Pane grid, signature diffing, source selection
  layout-picker.js  55-layout menu with generated icons, sync switch, key hints
  header.js       Layout menu, theme toggle, status pill
  shortcuts.js    Key bindings
  nse/            Loaded on demand — only when a pane is set to the NSE source
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
attribution stays visible. It sits in the footer and links to the active
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
