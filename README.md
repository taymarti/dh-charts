# dh-charts: TradingView-style live charts on Deephaven

Live trading charts built on Deephaven's TradingView Lightweight Charts plugin
(`deephaven-plugin-tradingview-lightweight` 0.1.0, with two small changes in
[our fork](https://github.com/taymarti/deephaven-plugins/tree/acme/tradingview-lightweight)). The
charts work in deephaven.ui and in standalone React apps. Our own features are plain Lightweight
Charts (LWC) plugins that sit outside Deephaven's plugin, so a new Deephaven release means adapting
our code, not merging into theirs. Why these choices, with measurements: `perf/README.md`.

Tested on Deephaven Community 42.6 (pip `deephaven-server`, Windows, Java 17), deephaven.ui 0.42.2,
lightweight-charts 5.2.0.

## Who it is for: three kinds of front end

| | Front end | Uses from Deephaven |
|---|---|---|
| **A** | deephaven.ui (Python) | tables, chart objects, ui components |
| **B** | React that renders Deephaven's UI objects (`WidgetView`: charts, maybe deephaven.ui components) | tables and server-side UI objects |
| **C** | React with its own charts, using only table data (JS API) | tables only |

Every feature is built as one of the layers below. A layer is a supported entry point on its own,
and the higher layers are built from the lower ones, so no group is stuck behind a layer it doesn't
use.

| Layer | What it is | Where | A | B | C |
|---|---|---|---|---|---|
| **L0 Data** | Tables: bars at any resolution, studies as columns (EMA, VWAP, Bollinger bands, RSI...), symbol and range filters. Pure table functions, plus a published standard set | `dh_chart_ext.data` (Python) | ✓ | ✓ | ✓ via the published tables; JS API filters choose symbol and range |
| **L1 Chart objects** | `TvlChart`s composed from L0 tables in house style: chart type, studies placed on overlays or panes, scales | `dh_chart_ext.charts` | ✓ | ✓ `WidgetView` | ✗ (renders with Deephaven's plugin) |
| **L2 Workspace** | A deephaven.ui component: toolbar, one to four L1 charts (layouts with symbol/interval/crosshair/time sync), a legend per chart with study settings, a watchlist | `dh_chart_ext.workspace` | ✓ | ✓ as a deephaven.ui element (`?widget=ws`) | ✗ |
| **C1 LWC plugins** | Drawing tools, shading, price lines, sync: plain LWC plugins with no Deephaven dependency | `@acme/chart-ext` (`ext/src/lwc-plugins`, `extensions.ts`) | ✓ (via C2) | ✓ (via C2) | ✓ attach to your own LWC chart directly |
| **C2 Hook** | Applies C1 to charts drawn by Deephaven's plugin | `@acme/chart-ext` (`hook.ts`) + `dh-chart-ext` | ✓ automatic | ✓ `attachTvlExtensions` | n/a |
| **C3 React kit** | `ChartToolbar` (symbol search, interval, chart type, indicators dialog, range, scale, layout and sync menu, watchlist toggle), `ChartLegend` (OHLC and study rows with show/hide, settings, remove), `Watchlist`; all controlled | `@acme/chart-react` (`react/`) | ✓ via the `acme.chart.Toolbar`, `acme.chart.Frame` and `acme.chart.Watchlist` elements | ✓ | ✓ |
| **P Persistence** | Drawings, price lines and settings in a Deephaven input table (one schema) | L0 table + C1 | ✓ | ✓ | ✓ via JS API |

Boundaries to keep in mind:
- **Custom study parameters need the server.** The JS API has no `update_by`, so group C gets the
  studies in the published standard set (e.g. EMA 20/50, Bollinger 20/2, RSI 14) at the standard
  resolutions. Anything else is a Python change to L0, available to all three groups once it exists.
- **Group C gets the best performance and owns the most code.** The benchmark's hand-written client
  used about half the main thread of Deephaven's plugin at a 100 ms cadence (`perf/README.md`).
  C3 exists to take most of that code off their hands.
- **A and B lose client-side state when a data control changes,** because Deephaven's plugin
  rebuilds the chart. Drawings and lines therefore persist through P and are re-applied by C2.
- **Nothing in C1 may depend on Deephaven's plugin**, and nothing in L0 or L1 may depend on
  deephaven.ui. That keeps each layer usable without the ones above it.

### Verified so far (workspace v0, 2026-11-21)

| Group | How | Status |
|---|---|---|
| A | `ws` / `ws_grid` (`app.d/demo.py`) at `/iframe/widget/?name=ws` | ✓ toolbar (symbol, Tick/1s/5s/1m/5m, range, Candles/Bars/Line/Area, 7 studies, Lin/Log/%) and extensions; a change rebuilds the chart in **89–153 ms** (click to new series), then the snapshot streams in |
| B, chart object | `web/` grid or `?widget=chart_ES&type=deephaven.plot.tradingview_lightweight.TvlChart`, through `WidgetView` | ✓ |
| B, the whole deephaven.ui workspace | `web/?widget=ws`: the workspace inside the React app, controls working (99 ms per change) | ✓ with two requirements `WidgetView` doesn't meet: a `FiberProvider` above it (from `@deephaven/dashboard`'s internal `useFiber.js`, not exported) and the widget descriptor (`metadata: {type, name}`) passed to the plugin component. `PluginWidget` in `App.tsx` does both |
| C | `web/?raw=bars_1m&sym=ES&studies=EMA_20,...` (`RawChart.tsx`): JS API, server-side filter on the published `bars_1m`, our own LWC chart, `TimeRangeShading` attached directly | ✓ the time axis is UTC (Deephaven's plugin shows the server time zone); time-zone formatting belongs in C3 |

Findings from building it:
- **Compute studies before filtering to a range** (`in_range` after `with_studies`), or an EMA or RSI starts cold at the left edge.
- **The plugin applies a price scale mode (log, %) to every pane** unless each study series sets its own scale; `price_chart` gives study panes an explicit linear scale.
- **Nulls draw as 0** in the plugin (RSI's first bar with no history). Long histories hide this; a whitespace (gap) convention is still needed.
- **One copy of lightweight-charts per app.** `@acme/chart-ext` lists it as a peer dependency, and each consumer pins 5.2.0 and dedupes it (Vite `resolve.dedupe`, tsconfig `paths`).

## Layout

| Path | What it is |
|---|---|
| `ext/` | **`@acme/chart-ext`** (layer 1, the chart component): our features as LWC plugins, `SeriesFeed` and `bindFeed` (any data source drawn as price + studies in panes), time-zone and tick-size formats, the store interfaces, and the hook that applies the plugins to Deephaven's charts. No Deephaven dependency. In-repo hosts compile its source (a Vite alias); `npm pack` builds the distributable package (`dist/`), published as a tarball in [lwc-vendor](https://github.com/taymarti/lwc-vendor) `acme/` |
| `bindings/` | **`@acme/dh-bindings`** (layer 2): the chart component's interfaces over Deephaven: `tableAnnotationStore`, `tableAlertStore`, `subscribeRows`, `tableFeed` (a `SeriesFeed` over a table), `ApiClient` / `openApi` (the request API) and `requestChart`; and since 0.2.0 the connection itself: `connect` (JS API loaded from the server, connection state, shared table leases) or `adoptConnection` (over Deephaven's bootstrap), and `TableViewport` (a grid's server-side window: rows in view, size, sort, quick filters) |
| `shell/` | **`@acme/app-shell`** (layer 3): the app shell. `Shell` (dockable panels on dockview: tabs, splits, floating, pop-out, maximize; saved workspaces per user; a link group per panel), `DeephavenRoot` / `DeephavenProvider` and hooks (tables, rows, API clients, the published objects), `DataGrid` (any table, virtual scrolling, server-side sort and filters), and generic panels: chart (group C's `RawWorkspace`, moved here from `web/`), watchlist, table, request form (from an API's `describe`), update graph |
| `desk/` | **The desk app** (scenario S2/S3): the shell on our own connection, no `@deephaven` React packages. Reconnects by itself when the server restarts |
| `web/` | **React host** (pattern A): Deephaven's own chart component in a standalone React app, through `WidgetView`. The plugin's JS comes from the server, so there is nothing to vendor and no npm package |
| `react/` | **`@acme/chart-react`** (layer 3, the app shell): `ChartToolbar`, `ChartLegend`, `Watchlist`, `AlertsPanel`, and the link bus (`createLinkBus`, `LinkProvider`, `useLink`): values widgets share per link group. Styles are injected by the component (no CSS build). In-repo hosts compile its source; `npm pack` builds the distributable package |
| `dh-plugin/` | **`dh-chart-ext`**: a Python package that registers a JS plugin with the Deephaven server and brings `@acme/chart-ext` to every Deephaven web UI, deephaven.ui dashboards included |
| (fork) | Our changes to Deephaven's plugin live in [taymarti/deephaven-plugins](https://github.com/taymarti/deephaven-plugins/tree/acme/tradingview-lightweight), branch `acme/tradingview-lightweight` (see "The fork" below) |
| `dh-plugin/src/dh_chart_ext/` `data.py` `charts.py` `workspace.py` | The Python layers L0, L1 and L2 |
| `dh-plugin/src/dh_chart_ext/` `rpc.py` `tokens.py` | The request API framework: handlers registered on an `rpc.Api` (type `acme.Api`), JSON over one plugin stream per client, parameter validation from type hints, `describe`, identity (`hello` with signed tokens), holds with leases and limits |
| `dh-plugin/src/dh_chart_ext/` `cache.py` `nodes.py` `api.py` `instruments.py` | Charts on demand: shared, reference-counted DAG nodes (`NodeCache` with limits and a live metrics table, `ChartNodes`), the chart handlers (`api.ChartApi`, an `rpc.Api`), tick sizes per instrument |
| `dh-plugin/src/dh_chart_ext/` `workspaces.py` `introspection.py` | The shell's server side, as methods on any `rpc.Api`: saved workspaces per user (a keyed input table, on disk), and the update graph for the graph panel (deephaven-compare's `introspect`) |
| `tests/`, `*/test/`, `.github/workflows/ci.yml` | pytest protocol tests against a live server, vitest unit tests per package, and CI running both |
| `docs/component-map.md` | Every piece, built or plausible, by layer (chart component, Deephaven bindings, app shell, server framework), with scenarios and open decisions |
| `app.d/` | Demo app: the benchmark's 16 synthetic feeds, the L0 standard set, `chart_ES` (L1), `ws` and `ws_grid` (L2) |

How the pieces fit:

```
 Python: tvl.candlestick(bars) ──► TvlChart object ──► Deephaven web UI or React host (WidgetView)
                                                          │  Deephaven's TradingViewChart (their code)
                                                          │    └─ renderer fires "tvl-chart" DOM events (our fork)
                                                          ▼
                                      @acme/chart-ext: attachTvlExtensions(root, extensions)
                                         └─ plain LWC plugins on the real chart and series
```

## How toolbar selections work

Settings and UI actions are the control path; data is a separate path. Ticks and bars stream to the
browser over Barrage subscriptions (Deephaven's plugin, or the JS API in group C) and never go through
Python. Browser-only actions never reach the server either: crosshair and time sync, zoom and scroll,
the legend's values, the context menu's view actions. Drawings and price lines go straight from the
browser to the annotations input table (`addRow`), not through Python callbacks.

- **deephaven.ui workspace (A, and B when it hosts the workspace):** a toolbar change is a call to the
  workspace's Python `on_change`, over deephaven.ui's message channel. The component re-renders: it takes
  the chart's shared node (below) for the symbol, interval and shown studies, applies its own lookback,
  composes a new chart object, and saves the settings row. The browser gets a new chart, which Deephaven's
  plugin subscribes and draws (about 90–150 ms to the new chart, then the snapshot streams in).
- **React with table data only (C):** state lives in React. A change re-subscribes, either to a published
  `bars_<res>` table filtered on the server (JS API `applyFilter`; studies are its precomputed columns),
  or with `?workspace&api` to a shared node from the chart API: one request, then the same subscription.

**Shared nodes.** The expensive part of a chart (bars at a resolution, studies, a spread's ticks) is a
node in the server's DAG, built when a client first asks for it and shared by every client asking for the
same thing (`nodes.ChartNodes` over a `cache.NodeCache`). Requests are made canonical first (`2m` = `120s`
= `PT2M`; studies by key, sorted; expressions without spaces), so equal requests get one node. Nodes are
layered, each holding its parent: `ticks` (spreads) → `bars` (a standard resolution is the shared
all-symbol table filtered to the symbol; others roll up from the largest standard one that divides them,
2m from 1m) → `chart` (bars + studies). Each is reference-counted: a deephaven.ui pane holds its node while
it shows it, an API stream holds what it asked for until it releases it or closes. At zero a node is kept
for a grace period (60 s; a reload reuses it), then released with its idle parents, and the engine stops
updating it. Server cost then follows the number of distinct charts on screen, not users × charts, and
falls back when people leave. Per-client parts stay per client and cheap (a pane's lookback, zoom).

**The request API** (`rpc.Api`, type `acme.Api`) is a Deephaven object type with a message stream per
client. Handlers are Python functions registered with `@api.method`; their type hints validate the
request's parameters, and `describe` lists them for clients. Requests are JSON (`{id, method, params}`),
answered with JSON (`{id, result}` or `{id, error, code}`) and, for methods that return tables, table
references the client subscribes to over Barrage like any table. Built in: `hello` (who the user is),
`describe`, `ping`, `release`, `whoami`. A handler ties resources to the stream with `ctx.hold(key,
release)`, within limits per stream and per user. Requests run on Deephaven's concurrent executor, one at
a time per stream, under the stream's execution context. `@acme/dh-bindings`' `ApiClient` is the client.

**The chart API** (`api.ChartApi`, published as `chart_api`) is an `rpc.Api` with chart handlers:
`chart {sym, res, studies}` answers with the shared node and how to draw it (each study column's pane and
reference levels, the instrument's tick size); also `bars`, `symbols`, `resolutions`, `studies`, `stats`.
It is how front ends that draw their own charts get any resolution, studies and spreads without running
Python per user. `chart_nodes` is the node cache as a live table. Measured: a cold `NQ 2m EMA 20`
builds in 0.9 s, a second client's identical request returns the same node in about 10 ms, and the cold
`ES-NQ` spread takes about 4 s (its tick history).

Who is asking: the handlers can read the caller's auth context (`whoami`), but on Community it carries no
user: anonymous logins all show `AuthContext$Anonymous` (verified), and PSK logins share one context too
(per the source). So `hello` takes a token: with `ACME_API_SECRET` set on the server it must be signed
(`tokens.sign_token`, HMAC-SHA256 with an expiry, issued by whatever logs users in); without it, an
unverified `user:<name>` is accepted for attribution, as on Community today. A custom Java authentication
handler is the stronger alternative.

Leases: a browser tab that navigates away was never reported to the plugin (no `on_close` after 11
minutes, well past the session's expiry), so its nodes would leak. Every stream therefore has a lease
(90 s): any message renews it, the JS client pings every 30 s, and a silent stream is closed and its nodes
released. Verified: a live page kept its node for 2.5 minutes; an abandoned one was released 80–90 s after
it left.

What each group gets, feature by feature:

| Feature | A deephaven.ui | B React + `WidgetView` | C React, table data |
|---|---|---|---|
| Legend rows: show/hide, remove | ✓ (Python state) | ✓ (same element) | ✓ (React state) |
| Study settings (length, multiplier, color), several instances of one study | ✓ recomputed in Python (`update_by`) | ✓ | the standard set's fixed columns; with the chart API any parameters (`{type, params}`), settings UI not built yet |
| Studies in their own panes (RSI with 30/70 levels, volume) | ✓ | ✓ | ✓ with `?workspace&api` (`bindFeed` panes, from the API's column descriptions) |
| Watchlist | ✓ `acme.chart.Watchlist` over `source.quotes` | ✓ | ✓ `Watchlist` + `subscribeRows` over the published `quotes` |
| Multi-chart layouts (1, 2, 3, 4) with symbol / interval sync | ✓ Python state per pane | ✓ | not built yet: the parts exist (`RawChart`, `bindSync`, the toolbar's layout menu) |
| Crosshair and time sync | ✓ by `data-acme-sync-*` attributes the frame sets | ✓ | ✓ `bindSync` (page group) |
| Context menu, Alt+H / Alt+T / Alt+R, Ctrl+Z undo | ✓ (ext, on every chart with drawings) | ✓ | ✓ (`bindDrawings`) |
| History: initial view window, scroll back for more, jump to now, go to date | ✓ the pane's `Lookback` grows on the server as you scroll; the chart is not rebuilt | ✓ | ✓ the chart loads the symbol's whole published history up front (no paging needed at this size) |
| Alerts: price, drawn line, study value; lines, Alerts panel, toast when one fires | ✓ evaluated by `AlertEngine` on the server | ✓ | ✓ the same `chart_alerts` table and engine: one set of alerts across all front ends |
| Sessions: shading of closed / extended hours, market status, bar-close countdown | ✓ calendar passed by the workspace | ✓ | ✓ from the published `sessions` table |
| Compare (overlay on a % scale) | ✓ | ✓ | ✓ with `?workspace&api` (`bindCompare`, a second shared node per compared symbol) |
| Display time zone; prices by tick size | local time (Deephaven's plugin) | local time | ✓ `&tz=` (local by default, UTC or an IANA zone); tick size from the API (`instruments`) |
| Symbol linking (watchlist → chart) | ✓ Python state | ✓ | ✓ the link bus (`useLink('symbol', {group: 'red'})`) |
| Spreads and ratios (`ES-NQ`, `ZN/ZB`, `2*ZN-ZB`) | ✓ computed in Deephaven from the legs' ticks | ✓ | ✓ with `?workspace&api`: the chart API builds the spread's node |
| Any interval (2m, 15m, 30m, 1h, 15s) | ✓ shared nodes, rolled up from standard bars | ✓ | ✓ with `?workspace&api` (else the four published resolutions) |

How the server-side pieces work:

- **History.** Each chart's table is `bars.natural_join(lookback, on=[]).where("Timestamp >= Since")`,
  where `lookback` is a one-row input table (`data.Lookback`). The toolbar's range sets the initial
  view, not a filter. Scrolling into the oldest bar calls the pane's Python `on_history`, which
  doubles the lookback (or reaches a date for "go to date"). The table gains the older rows in place,
  and Deephaven's plugin draws them without a new chart, so the user's view stays put.
- **Alerts.** One input table (`alerts.alert_table`), written by browsers like annotations. The
  `AlertEngine` listens to the active alerts joined to a live values table (`ChartSource.alert_values()`:
  the last trade and each standard study's forming-bar value, per symbol). A crossing is a change of
  side between two update cycles, so a move through the level and back within one cycle (1 s) is missed.
  When an alert fires, the engine writes it back as triggered; the owner's browsers show a toast and
  the Alerts panel logs it. Alerts fire with no browser open; the server log records each one.
- **Sessions.** `sessions.SESSIONS` holds each instrument's exchange calendar: time zone, session
  hours and regular hours. Browsers compute closed and extended ranges, market status and time to the
  next change with `Intl`, so daylight saving is handled. Holidays are not modelled.
- **Spreads.** `data.spread_ticks` takes the legs' ticks in time order, forward-fills each leg's
  latest price, and prices every tick of any leg. Bars and studies are then built as for any symbol.
  The first build of a spread takes about a second per 200k ticks; after that it is a shared node.

## The hook

Deephaven's plugin keeps its LWC chart private. Our fork adds a small public API to its renderer
(exported as `TVL_CHART_EVENT`, `TVL_RENDERER_KEY`, `TvlChartEventDetail`): one bubbling DOM event,
`tvl-chart`, fired from the chart's container, with `detail = { kind, renderer, chart }` and
`kind` = `ready` | `series` | `destroy`. `ready` is synchronous, so it always precedes the first
`series`. The container also keeps `container.__tvlRenderer`. The renderer's public methods
(`getChart()`, `getDataSeriesList()`) give our code the LWC chart and series. `@acme/chart-ext` uses
the literal names, so it doesn't depend on the plugin's package.

`attachTvlExtensions(root, extensions)` listens on any ancestor element and re-applies each extension
whenever the plugin reconfigures its series. An extension is
`(ctx: { chart, series, renderer, element }) => cleanup`.

- **React host:** `App.tsx` attaches to its grid, with `?ext=` choosing the features. It sets
  `globalThis.__acmeChartExtHostManaged` so the server plugin below stays out.
- **deephaven.ui and the IDE:** `dh-chart-ext`'s JS module listens on the document as soon as the web
  UI loads it. Nothing changes in the Python that builds dashboards.

## Features so far

| Feature | Source | Status |
|---|---|---|
| Crosshair sync across every chart (same time, each chart's own price), and time-range sync, in groups set by `data-acme-sync-crosshair` / `data-acme-sync-time` on any ancestor | ours (`ext/src/sync.ts`) | Verified: 4-chart layout (crosshair, time range follows the chart being worked), all groups |
| Persistent price lines ("+" at the right edge; Shift+click deletes, Ctrl+click shares) | official `@tradingview/lwc-plugin-user-price-lines` 1.0.0, bound to the annotations table (`ext/src/persistent-price-lines.ts`, `dh_chart_ext/store.py`) | Verified in all three groups: saved per user, survive chart rebuilds and server restarts (parquet), others' shared lines in blue with the owner's name, soft delete |
| Drawing tools: horizontal ray, trend line (vertical palette on the left edge; click to select, drag line or handle, Delete removes, Ctrl+click shares, Esc cancels; weak magnet to OHLC) | ours (`ext/src/drawings.ts`), saved as kind `drawing` | Verified in all three groups: saved per user, carried across resolutions (points are time + price), handle and whole-line drags, soft delete |
| TradingView-style toolbar: symbol search, grouped interval menu, chart-type menu with icons, "ƒx Indicators" search dialog, range, % / log | ours (`react/src/ChartToolbar.tsx`); in deephaven.ui the `acme.chart.Toolbar` element, driven by Python state | Verified: deephaven.ui workspace and dashboard, and group C's `RawWorkspace` |
| OHLC legend (symbol, O H L C, change from the previous close) following the crosshair | ours (`ext/src/legend.ts`); workspaces use `ChartLegend` instead | Verified in all three groups |
| Legend study rows: value at the crosshair in the study's color; on hover, show/hide, settings (parameters and color), remove. Study instances `{id, type, params, color, visible}`: add EMA twice with different lengths | ours (`react/src/ChartLegend.tsx`, `acme.chart.Frame`; types in `dh_chart_ext.data.STUDY_TYPES`) | Verified: deephaven.ui workspace (EMA 20 → 50 and recolor recomputed in Python; hide RSI drops its pane), group C (hide/remove) |
| Watchlist: last, change, change % from the day's first trade, flash on tick, click to load the symbol in the active chart | ours (`react/src/Watchlist.tsx`; `dh_chart_ext.data.quotes`) | Verified: deephaven.ui workspace, group C |
| Multi-chart layouts: 1, 2 side by side, 2 stacked, 3, 4; click a chart to make it active (the toolbar and watchlist act on it); sync symbol, interval, crosshair, time | ours (`dh_chart_ext.workspace`, toolbar layout menu) | Verified: deephaven.ui workspace; the whole layout is saved and restored |
| Context menu (reset view, horizontal line at price, copy price, delete / share drawing, undo, remove my drawings); Alt+H horizontal line, Alt+T trend line, Alt+R reset view, Ctrl+Z undo; full-width horizontal line tool | ours (`ext/src/drawings.ts`) | Verified: deephaven.ui workspace |
| History: view window, scroll back to load more, » jump to now, go to date (calendar button, Alt+G); synced charts load history too | ours (`ext/src/nav.ts`, `dh_chart_ext.data.Lookback`) | Verified: deephaven.ui workspace (4h → 8h on scroll, back to Tuesday by date, view unchanged), group C (5 days) |
| Alerts: Alt+A or the context menu at a price, on a drawn line (it follows the line), on study values from the Alerts panel; dashed line with a bell; toast and log when fired | ours (`dh_chart_ext.alerts`, `ext/src/alerts.ts`, `react/src/AlertsPanel.tsx`) | Verified: deephaven.ui workspace and group C on one store; three alerts fired in the engine and were logged |
| Real sessions: closed and extended hours shaded per exchange calendar, market status dot (with time to the next change), bar-close countdown on the price axis | ours (`dh_chart_ext.sessions`, `ext/src/sessions.ts`, `ext/src/countdown.ts`) | Verified: deephaven.ui workspace, group C |
| Compare: overlay another symbol on a % scale, listed in the legend | ours (`charts.price_chart(compare=...)`, toolbar "Compare") | Verified: deephaven.ui workspace |
| Spreads and ratios typed into the symbol search (`ES-NQ`, `ZN/ZB`, `2*ZN-ZB`), with studies | ours (`dh_chart_ext.data.spread_ticks`) | Verified: deephaven.ui workspace (ES-NQ), group C through the chart API |
| Charts on demand as shared DAG nodes (reference-counted, released after a grace period), served to JS clients by the chart API (`acme.chart.Api`) | ours (`dh_chart_ext.cache`, `nodes`, `api`; `web/src/chartApi.ts`) | Verified: two pydeephaven clients share one node; deephaven.ui workspace and group C (`?workspace&api`: 2m, ES-NQ) |
| Workspace settings (symbol, resolution, range, type, studies, scale) | `dh_chart_ext.store.load_settings` / `save_settings`, per (`layout`, `user`) | Verified: restored after reload and server restart |
| Session/time-range shading | ours (`ext/src/lwc-plugins/time-range-shading.ts`) | Works in both hosts |

## Findings that shape the design

- **deephaven.ui does not apply widget middleware to charts inside ui components.** Its `ObjectView`
  (`@deephaven/js-plugin-ui` 0.42.2) picks the widget plugin and renders its component directly.
  Middleware is chained only by `@deephaven/plugin`'s `WidgetView` (used for panels and by our React
  host). Hence the document-level listener. 0.44.0 is out and untested here.
- **Deephaven's plugin draws candles on a 1-second scaffold.** Its `ContinuousBarsSeries` fills the
  time scale with hidden 1-s slots and auto-bins the candles across them, so `barSpacing` is about
  0.2 px. LWC plugins that paint per bar slot draw nothing visible. One is TradingView's official
  session-highlighting, which is why we wrote a time-range one. Plugins positioned by time or price
  (price lines, trend lines, markers, vertical lines) are fine. **Write our plugins against time
  coordinates, never bar slots.**
- **The server snapshots JS plugin files at startup.** After rebuilding `dh-plugin/js` or
  reinstalling the fork's wheel, restart the server.
- **Primitives work across LWC copies.** Deephaven's plugin bundles its own LWC 5.2. Our plugins and
  the official ones attach to its chart through interfaces and import only enums, so the second copy
  (pinned to 5.2.0 in `ext/`) does no harm.
- **The time-zone offset cache** cut the plugin's main-thread time at a 100 ms cadence from 73 % to
  63 % (deephaven.ui) and from 53 % to 41 % (React host); `perf/results/host-fast*.json`.

## The fork

[taymarti/deephaven-plugins](https://github.com/taymarti/deephaven-plugins/tree/acme/tradingview-lightweight)
(public, as every fork of a public repo is), branch `acme/tradingview-lightweight`, starting at
upstream's `tradingview-lightweight-v0.1.0` tag:

| Commit | For upstream |
|---|---|
| `perf(tradingview-lightweight): cache time-zone offsets per 15-minute bucket`, with tests | yes |
| `feat(tradingview-lightweight): announce chart lifecycle with a DOM event`, with tests | yes (the API is worth discussing with Deephaven first) |
| `chore(acme): mark our build with a local version (0.1.0+acme.1)` | no |

The plugin's Jest suite passes: 20 suites, 338 tests, including the two new ones.

**A new Deephaven release:** `git fetch upstream --tags`, then
`git rebase --onto tradingview-lightweight-v<new> tradingview-lightweight-v0.1.0 acme/tradingview-lightweight`
(the version commit may need its number adjusted), run the tests, build, push.

**Build (Windows, from the fork's root):**

```powershell
npm ci --ignore-scripts --engine-strict=false        # the repo pins Node 24.10/npm 11.6 strictly
npx jest --config jest.config.unit.cjs --testPathPattern="plugins/tradingview-lightweight"
npm --prefix plugins/tradingview-lightweight/src/js run build
# the wheel: deephaven-plugin-packaging runs shutil.which("npm"), which on Windows can pick the
# extension-less npm shell script; put a folder holding only an npm.cmd that calls the real one first on PATH
python -m build --wheel plugins/tradingview-lightweight
# then, in this repo:
.venv\Scripts\python -m pip install --force-reinstall --no-deps <path to the wheel>
```

## Run it

Environments whose package mirror lacks the Lightweight Charts packages: run
[lwc-vendor](https://github.com/taymarti/lwc-vendor)'s `prime-cache` script once, then install as
below; npm takes those packages from its cache.

```powershell
# a server environment (Python 3.12, JDK 17+ in JAVA_HOME), with the fork's wheel (above)
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements-server.txt
.venv\Scripts\python -m pip install -e dh-plugin
npm --prefix ext install; npm --prefix bindings install; npm --prefix react install
npm --prefix dh-plugin/js install; npm --prefix dh-plugin/js run build
# the workspace demo (app.d); restart the server after any plugin rebuild
$env:PERF_FLATTEN = "1"
.venv\Scripts\python run_server.py --port 10040 --heap 4g --app-dir app.d
npm --prefix web install; npm --prefix web run dev   # http://localhost:4050/?widget=ws
```

The demo (`app.d`), per front-end group:
- A, deephaven.ui: `http://localhost:10040/iframe/widget/?name=ws` (or `ws_grid`)
- B, React with Deephaven UI objects: `http://localhost:4050/?widget=ws`, or
  `?widget=chart_ES&type=deephaven.plot.tradingview_lightweight.TvlChart`
- C, React with table data only: `http://localhost:4050/?workspace&sym=NQ` (toolbar, legend, watchlist,
  alerts, sessions), `?workspace&api&sym=NQ` for charts from the chart API (any interval, spreads, RSI and
  volume panes, compare; `&tz=America/Chicago` for the exchange's time), or one
  bare chart: `?raw=bars_1m&sym=ES&studies=EMA_20,BB_20_2_Upper,BB_20_2_Lower`
- C, the desk app (own shell): `npm --prefix shell install; npm --prefix desk install; npm --prefix desk run dev`,
  then `http://localhost:4060/?user=alice`: chart, watchlist, `chart_nodes` and a request form, docked;
  "+ Panel" adds charts, tables (any published one), forms and the update graph; panels in the same link group
  (the chip in each header) follow one symbol; Save / Save as… keep workspaces on the server per user
- The chart API from Python: `pydeephaven` `Session.plugin_client(session.exportable_objects["chart_api"])`,
  then JSON requests on its `req_stream` (the browser console has `window.chartApi` on an `&api` page)

The demo puts 5 days of synthetic history (`DEMO_HISTORY_DAYS`) before the live feed. Expect about 30 s
after "Deephaven is up" before the first workspace opens; later opens take a few seconds.

`--app-dir perf/app.d` runs the benchmark's app instead (`dash_tvl_1s`, `tvl1s_<SYM>`, 16 charts per
dashboard); `perf/README.md` has the benchmark.

## Tests

```powershell
# unit tests, no server (each JS package; Python's token checks)
npm --prefix ext test; npm --prefix bindings test; npm --prefix react test; npm --prefix shell test
.venv\Scripts\python -m pytest tests/test_tokens.py
# protocol tests against the running demo server (DH_TEST_PORT, default 10040); DH_SLOW=1 adds the 2-minute lease test
.venv\Scripts\python -m pytest tests
```

CI (`.github/workflows/ci.yml`) typechecks, tests and builds every JS package, then starts the demo server
on a runner (with 1 day of history) and runs the protocol tests against it.

## Next

See `docs/component-map.md` for every piece by layer and the planning order. Done from it so far: the
layer split, `SeriesFeed`, panes, compare, time zone and tick size in group C, the request API framework
with identity and limits, the link bus, tests and CI; and with decisions 1–3 taken (our own shell,
dockview, our own grid): the connection module, the app shell with saved workspaces, the generic table,
forms from `describe`, and a first graph explorer. The component map's "Gaps found" lists what that showed.

1. Persistence (P) is done: price lines, drawings, workspace settings. Owner is client-supplied on Community; use authenticated users + row ACLs on Enterprise.
2. The gaps the shell showed (component map): the remaining decisions (handler registry shape, identity, where the framework lives) and the shell's own follow-ups.
3. More drawing tools on the same framework: rectangle, Fibonacci retracement, vertical line, text note. Drawing points off the data (weekend gaps) drift, since off-data times use a linear axis.
4. Propose the fork's two changes upstream, along with the per-pane scale mode and null-as-gap
   issues.
5. Steady-state cost of `ws_grid` under the benchmark, and the plugin overhead still left at a 100 ms
   cadence (41 % vs. 25 % for a hand-written client).

## License

Apache-2.0 (`LICENSE`, `NOTICE`), including the `@acme/chart-ext` package and the `dh-chart-ext`
Python package. The fork of Deephaven's plugin is Apache-2.0 too (upstream's license).
