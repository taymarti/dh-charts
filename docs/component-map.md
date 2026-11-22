# Component map: reusable components and framework elements

Every piece of a Deephaven-backed trading app framework, built or plausible, sorted by layer, so we can
choose what comes first. Each piece has a status, where it lives today, and the variants or future states
it should allow for. Later sections say what each piece depends on and roughly what it costs, which kinds
of app need which pieces, what is still open, and what we know to be limited.

Two repositories hold the work so far:

- **dh-charts** (this repo): the chart component, its Deephaven bindings, the chart widgets, and the
  chart server code (nodes, chart API).
- **deephaven-compare**: the application framework (`dhapp`, `dhfw`), app introspection, a complete
  Python + Java + React app (`desk-app`), the Java-node study (`hybrid`), the two-UI comparison
  (`react-client`), and the evidence ledger `VERIFIED_FACTS.md` (ids like C5, X15 below).

Status: ✅ built and verified · ◐ partial or prototype · ○ not started (plausible need)

## The layers

```
 4  Server framework       engine integration, app roles, request API, node cache, stores, alerts, identity
        │ (Deephaven protocol: object streams, tickets, Barrage)
 2  Deephaven bindings     table → series, request client, store implementations, connection
        │
 3  App shell + widgets    link bus, layouts, workspaces, generic table and form widgets, chart panel
        │
 1  Chart component        Lightweight Charts + our plugins; no Deephaven inside
```

Rules that keep the pieces reusable:

- Layer 1 knows nothing of Deephaven. It reaches data and storage through interfaces (`AnnotationStore`,
  `AlertStore`, a session calendar, a series feed); layer 2 implements them over Deephaven.
- Layer 3 widgets know the link bus and layer 2's interfaces, not each other. A watchlist does not know a
  chart exists; it publishes `symbol` on its link group.
- Layer 4 serves requests and tables and never assumes which front end asks. deephaven.ui elements are one
  client of it, like the React app.

## 1. Chart component (Lightweight Charts, no Deephaven)

| Piece | What | Status | Lives in now | Variants and future states |
|---|---|---|---|---|
| Chart core | `createChart` with house theme, time scale, price scale modes (normal, log, %, indexed) | ◐ | `web/src/RawChart.tsx` (group C); Deephaven's plugin draws A/B's | a `Chart` React component independent of Deephaven; settings dialog; touch and mobile |
| Panes | studies in their own panes (RSI with levels, volume) | ✅ | `ext/src/price-chart.ts` (`bindFeed`, LWC 5 panes); Deephaven's plugin for A/B | resizable panes; moving a study between panes |
| Series types | candles, bars, line, area, histogram | ◐ A/B all four chart types; C candles only | `charts.py` (A/B), `RawChart.tsx` (C) | Heikin-Ashi, baseline, renko / range / point-and-figure (server-built bars), volume-colored candles |
| Price formatting | decimals and tick size per instrument | ✅ group C | `ext/src/format.ts` (`priceFormatFor`), tick from the chart API (`instruments.py`) | fractional bond prices (32nds); A/B through the plugin |
| Time display | time zone of the axis and crosshair | ✅ group C (`&tz=`; local by default, like A/B) | `ext/src/format.ts` (`timeZoneOptions`) | a user setting saved with the workspace; the exchange's zone per instrument; A/B through the plugin |
| Legend | OHLC, change, study rows with values at the crosshair; show/hide, settings, remove | ✅ | `ext/src/legend.ts`, `react/src/ChartLegend.tsx` | per-pane legends; compact mode; a data window (all values at the crosshair) |
| Drawings | horizontal line, trend line, context menu, undo, move, alert bell | ✅ | `ext/src/drawings.ts` | rectangle, Fibonacci, vertical line, ray, channel, text note, measure; templates; lock / hide all; snap to OHLC |
| Price lines | user price lines (TradingView's official plugin), persistent lines | ✅ | `ext/src/extensions.ts`, `ext/src/persistent-price-lines.ts` | position lines (entry, stop, target) from the trading layer |
| Navigation | view window, scroll-back paging request, jump to now, go to date | ✅ | `ext/src/nav.ts` | bar replay (step through history); linked time ranges via the link bus |
| Sync | crosshair and time sync by group | ✅ | `ext/src/sync.ts` | driven by the link bus instead of DOM attributes |
| Sessions | shading of closed and extended hours, market status | ✅ | `ext/src/sessions.ts`, `ext/src/lwc-plugins/time-range-shading.ts` | holidays and early closes; RTH-only view; session breaks on the axis |
| Countdown | bar-close countdown on the price axis | ✅ | `ext/src/countdown.ts` | |
| Alert lines | dashed lines for active price alerts; create from the chart (Alt+A, menu) | ✅ | `ext/src/alerts.ts` (`bindAlertLines`) | markers when fired; drag to edit |
| Compare overlay | other symbols on a % scale | ✅ | `ext/src/price-chart.ts` (`bindCompare`); Python (`charts.price_chart(compare=)`) for A/B | compare in its own pane; spreads of compared symbols |
| Markers | arrows and labels at bars | ○ | | fills and trades from a blotter; strategy signals; news and events |
| Overlays | | ○ | | volume profile, VWAP bands, order-book depth heatmap, server-sent annotations |
| Shortcuts and context menu | Alt+H, Alt+T, Alt+R, Alt+A, Alt+G, Ctrl+Z | ✅ | `ext/src/drawings.ts`, `ext/src/nav.ts` | a central shortcut registry (layer 3) so widgets don't collide |
| Screenshot and export | | ○ | | PNG via LWC `takeScreenshot`; CSV of the visible bars |
| Interfaces | `AnnotationStore`, `AlertStore`, session calendar, chart key, `SeriesFeed` (snapshot and updates; `memoryFeed` for tests and demos) | ✅ | `ext/src/annotations.ts`, `alerts.ts`, `sessions.ts`, `feed.ts` | history paging in `SeriesFeed`; feeds for non-Deephaven sources |
| Performance budget | 16 live charts at a 100 ms cadence | ✅ measured | `perf/` (C1–C8, C13) | keep a benchmark run per release; LWC's O(n) cost for a new time point with raw ticks (C2) rules out long tick histories |

## 2. Deephaven bindings (JS)

| Piece | What | Status | Lives in now | Variants and future states |
|---|---|---|---|---|
| Connection | connect to the server, session | ✅ twice | `web/` via `@deephaven/app-utils`; deephaven-compare `desk-app/web/src/deephaven.ts` (the JS API served by the server, no `@deephaven` React packages) | one connection module; reconnect after a session or network loss; several servers (sharding) |
| Table → series adapter | a `SeriesFeed` over a table: snapshot, added and modified rows, removals and older history as a new snapshot, null gaps | ✅ | `bindings/src/table-feed.ts` (`tableFeed`) | batching at high cadence; viewport subscriptions for long histories |
| Table hooks | a published table; its live rows in a viewport | ✅ | `bindings/src/table-rows.ts` (`subscribeRows`, full subscription); `desk-app/web/src/hooks.ts` (`useTable`, `useLiveRows`, viewport) | one set of hooks, viewport by default |
| Request client | generic `ApiClient` for any handler: ids, errors with codes, table references, lease pings, `hello`, `describe`; `requestChart` for charts | ✅ | `bindings/src/api-client.ts`, `chart-request.ts`; `web/src/chartApi.ts` (the React hook) | typed methods generated from `describe`; re-request held charts after a reconnect |
| Store implementations | annotations and alerts over input tables | ✅ | `bindings/src/annotation-store.ts`, `alert-store.ts` | a workspace store; offline cache |
| Deephaven chart hook | finds Deephaven's TradingView charts and applies our extensions | ✅ | `ext/src/hook.ts`, `dh-plugin/js` | needed only while A/B use Deephaven's plugin and our fork |
| Identity on the client | who the user is | ◐ `hello` with an unverified `user:<name>` | `web/src/chartApi.ts` | a signed token from the login service |
| Errors and states | loading, empty, error, stale data | ◐ ad hoc | | one convention for every widget |
| Other backends | | ○ | | an in-memory or mock feed for tests and demos; an adapter shaped like TradingView's Datafeed API, if the chart is ever used without Deephaven |

## 3. App shell and widgets

| Piece | What | Status | Lives in now | Variants and future states |
|---|---|---|---|---|
| Link bus | shared values (symbol, interval, time range, account) per link group | ✅ (group C: watchlist and chart share the symbol) | `react/src/link.ts` (`createLinkBus`, `LinkProvider`, `useLink`, `LINK_GROUPS`) | a group picker on each widget; saved with workspaces (`snapshot` / `restore`); links into Python as controls; compatible with Deephaven's dashboard linker |
| Layout manager | panels: split, tabs, resize, multi-chart grids | ◐ 1–4 chart layouts | `workspace.py`, the toolbar's layout menu | a docking library (dockview, FlexLayout, golden-layout); pop-out windows; several monitors |
| Workspaces | saved layouts with each panel's state | ◐ one saved state per layout and user | `store.save_settings` | named layouts, templates, sharing, a versioned schema with migrations |
| Deep links | state in the URL | ◐ query parameters (`?sym=`, `?workspace&api`) | `web/src/App.tsx` | a URL scheme for workspaces, panels and link-group values |
| Chart panel | chart, toolbar, legend and navigation as one widget | ✅ twice | `workspace.chart_pane` (deephaven.ui), `RawChart.tsx` / `RawWorkspace` (React) | one React chart panel on the request client |
| Toolbar | symbol search, interval, chart type, indicators, compare, range, scale, layouts, panels | ✅ | `react/src/ChartToolbar.tsx` | configurable items; a study dialog with parameters (exists in A/B's legend settings) |
| Symbol search | search, with expressions | ✅ | in the toolbar | universe search on the server (thousands of symbols); recent and favourites |
| Watchlist | live quotes, click to select | ✅ | `react/src/Watchlist.tsx`, `acme.chart.Watchlist` | a configuration of the generic table widget; per-user lists; user-chosen columns (server nodes) |
| Generic table widget | any streaming table: sort, filter, formats, row press | ◐ two prototypes | deephaven-compare `desk-app/web/src/components/LiveGrid.tsx` (our own, viewport), `react-client/src/LiveGrid.tsx` (Deephaven's IrisGrid embedded); `dhapp.ui.table_panel` (deephaven.ui) | pick one (decision 3); link-bus actions per row; column formats from the server |
| Forms and controls | widgets that write input tables (the app's parameters, tickets) | ◐ | `desk-app/web/src/components/Forms.tsx` (`LimitEditor`, `OrderTicket`); editable grids in `dhapp.ui` (X15) | generated from a control schema declared in Python (`@app.control`) |
| KPI and status widgets | one-row summaries, app health | ✅ deephaven.ui | `dhapp.ui` (`kpi_row`, `status_panel`) | React versions |
| Automatic dashboards | a dashboard from an app with no UI code | ✅ deephaven.ui | `dhapp.ui.dashboard(app)` (X15) | the same from the catalog in the React shell |
| Alerts panel | create, list, log | ✅ | `react/src/AlertsPanel.tsx` | more alert types; delivery (email, chat) |
| Notifications | toasts, browser notifications | ✅ for alerts | `ext/src/alerts.ts` (`showAlertToasts`) | a general notification centre |
| Trading widgets | order ticket | ◐ ticket only | `desk-app` `OrderTicket` | positions, orders, fills blotter, P&L; orders on the chart |
| DAG explorer | browse the app's tables and graph, open any as a grid or chart | ◐ data only | deephaven-compare `introspect/` (inventory of fields, graph, sources, listeners) | a widget over introspect's report or a live catalog table |
| Theming, shortcuts, command palette, settings, undo | | ○ (house theme constants) | `charts.py`, `react/src/styles.ts` | one token set for chart and widgets; light theme; undo across widgets |
| Permissions in the UI | hide or disable what the user may not do | ○ | | from identity and ACLs (layer 4) |
| Hosts | where the shell runs | ◐ | `web/` (standalone React), deephaven.ui, `desk-app` (static build behind its own proxy) | inside Deephaven's web UI as plugins; desktop (Electron); embedded by iframe |

## 4. Server framework (Python and the engine)

| Piece | What | Status | Lives in now | Variants and future states |
|---|---|---|---|---|
| App structure | an app as sources, stages, actions and surfaces; live, backtest and test modes | ✅ | deephaven-compare `dhapp.App` (X13, X14) | charts and the request API as dhapp parts (decision 6) |
| Runtime portability | one API for Community and Enterprise | ✅ Community; Enterprise untested | deephaven-compare `dhfw` (X12) | the first run on an Enterprise plant |
| Table catalog | logical table names resolved by where the app runs | ✅ | `dhapp.catalog` | a published catalog of the app's own nodes (for the DAG explorer and generated clients) |
| Engine hosting | where the engine runs | ✅ several | `app.d` scripts on a pip server; `desk-app` (one process, Python + Java + React in one wheel); `hybrid` (Java nodes: per-row functions 4.7–6.5× faster, stateful listeners 13–20× cheaper than Python) | embedded in your CEP process; a separate server fed by the CEP; several workers |
| Market data ingestion | feeds into ticking tables | ◐ synthetic feeds; `dhapp` sources with history | `perf/app.d/feeds.py`, `dhapp.App.source` | real feed connectors (Kafka, vendor SDKs), Java `StreamPublisher` sources (X10) |
| Request API | handler registry (`@api.method`), validation from type hints, `describe`, `hello`, holds with leases, limits per stream and user, error codes | ✅ | `dh_chart_ext/rpc.py` (charts: `api.py`) | `@app.control` for input-table controls; versioning; generated client types; inside `dhapp` (decision 6) |
| Node cache | shared nodes by canonical key, reference counts, grace period, parent cascade, a node limit, a live metrics table (`chart_nodes`) | ✅ | `dh_chart_ext/cache.py` | pinned nodes; shared prefixes of study chains; eviction by cost |
| Chart nodes | bars at any interval, studies, spreads | ✅ | `dh_chart_ext/nodes.py` | ticks as nodes; quotes and watchlist columns as nodes; history windows shared in steps |
| Data model | ticks, bars, studies, spreads, quotes; trading and risk recipes | ✅ | `dh_chart_ext/data.py`; `dhapp.recipes`, `dhapp.schemas` | instrument metadata (tick size, contract rolls, continuous futures); corporate actions; several feeds |
| History | lookback paging; demo history; replay | ◐ | `data.Lookback`, `app.d/demo.py`; `dhfw` replay mode, `TableReplayer` (X6) | Parquet or a historical store joined to live; base bars kept on disk |
| Study library | registry of study types with parameters | ✅ six studies | `data.STUDY_TYPES` | more studies; user-defined studies (formulas or Python), sandboxed |
| Stores | annotations, alerts, settings; snapshots, daily partitions, logs, editable state | ✅ | `dh_chart_ext/store.py`, `alerts.py`; `dhapp.store` (four kinds, Community and Enterprise) | one keyed-store helper for both repos; audit history of control writes |
| Alert engine | crossings evaluated in the engine, written back | ✅ | `dh_chart_ext/alerts.py` | finer than one cycle; more alert types; delivery channels |
| Supervised actions | Python side effects off the graph, with health | ✅ | `dhapp.App.action` (X14) | the alert engine as a dhapp action |
| Sessions | exchange calendars per instrument | ✅ | `dh_chart_ext/sessions.py` | holidays and early closes from a calendar source |
| Identity | who the caller is | ◐ `hello` verifies HMAC-signed tokens when `ACME_API_SECRET` is set; Community's auth context has no user id (C21) | `dh_chart_ext/rpc.py`, `tokens.py` | a login service that issues tokens; a custom Java authentication handler; Enterprise users |
| Authorization | what the caller may see and do | ◐ Enterprise only | `dhfw.acl` (row and column ACLs on Enterprise; a no-op on Community) | ACLs on API requests; exported tables run through the server's transform (the API declares it) |
| Introspection and observability | what the app runs and what it costs | ◐ | deephaven-compare `introspect/`; the chart API's `stats`; `chart_nodes` (the node cache, live) | a live catalog table; per-node cost from the update performance log; dashboards |
| Deployment and configuration | packaging, settings, security | ◐ | `desk-app` (one wheel, Pixi build, X29–X31); run scripts | console off in production; update-cycle and Barrage cadence settings (C8); heap; rate limits per client |
| Scaling | | ○ | `dhfw.remote` (tables from other workers, X12) | shard by symbol group; route requests; shared tickets between workers |

## Cross-cutting

| Piece | Status | Notes |
|---|---|---|
| Protocol spec | ◐ (docstrings in `rpc.py` and `api.py`; `describe` at runtime) | one document for client and server; versioning rules |
| Tests | ✅ | dh-charts: pytest protocol tests against a live server (`tests/`), vitest unit tests in `ext`, `bindings`, `react`; deephaven-compare: `tests/test_dhfw_community.py`, `examples/07_app_framework.py`; to add: Playwright for widgets |
| CI | ✅ | dh-charts `.github/workflows/ci.yml` (JS packages, then a live server and the protocol tests); deephaven-compare `pixi run ci` for desk-app |
| Versions | ✅ pinned | Lightweight Charts 5.2.0, Deephaven Community 42.6, `@deephaven/jsapi-types` ~41.11 (behind the server), the fork at 0.1.0+acme.1; track upgrades in one place |
| Packaging | ✅ | npm tarballs in lwc-vendor; editable wheel for dh-chart-ext; desk-app as one wheel; package boundaries should follow the layers (below) |
| Evidence | ✅ | `VERIFIED_FACTS.md` in deephaven-compare (C1–C24 charts and the chart API, X1–X32 framework) |
| The fork of Deephaven's plugin | ✅ | needed only for A/B; propose its changes upstream, or drop it with A/B |
| Licensing | ✅ Apache-2.0 | no TradingView attribution added (decided) |

## Planning: dependencies, size and risk

For the pieces not yet built or only partial. Size is rough: S about a day, M a few days, L a week or more.

| Piece | Depends on | Size | Risk or unknowns |
|---|---|---|---|
| ~~Split layer 1 from layer 2~~ | done: `@acme/dh-bindings`; the hook stays in layer 1 (it has no Deephaven import) | | |
| ~~`SeriesFeed` interface + table adapter~~ | done | | |
| One connection module and table hooks | decision 1 | S | reconnect behaviour of the JS API after session loss is unmeasured |
| ~~Generic request client + handler registry~~ | done (`rpc.Api`, `ApiClient`); generated client types still open | | |
| ~~Link bus~~ | done; groups across pop-out windows still open | | |
| Layout manager and workspaces | decisions 1 and 2, link bus | L | persistence schema and migrations |
| React chart panel as a reusable component | done as `RawChart`/`RawWorkspace` in `web/`; move into layer 3 with the shell decision | S | |
| ~~Display time zone~~ | done for group C | | |
| ~~Price formatting by tick size~~ | done for group C (demo tick sizes) | | |
| Generic table widget | decision 3, table hooks, link bus | M (own) or S (IrisGrid) | IrisGrid needs `@deephaven` React packages; our own needs viewport scrolling |
| Forms from control schemas | handler registry | M | which control types to support |
| DAG explorer | generic table, a live catalog | M | introspection cost on a large graph; ancestry needs the performance log opened at start (introspect docstring) |
| Identity: a token issuer | `tokens.sign_token` (done) | S–M | where users log in (single sign-on) |
| ~~Node cache limits and metrics~~ | done | | |
| Charts and API inside `dhapp` | decision 6 | M | two stores modules to merge |
| Instrument metadata | ingestion | M | contract rolls and continuous futures |
| Trading widgets | generic table, forms, broker integration | L | broker and order-routing model |
| ~~Tests and CI for dh-charts~~ | done | | |

Foundations, in an order that unblocks the most: the layer split, decision 1, the link bus and table hooks,
the request client and handler registry, then `SeriesFeed` and the React chart panel. All but decision 1
are done (2026-11-22); the rest of layer 3 waits on decisions 1–3.

## Scenarios (future states) and what each needs

| Scenario | Needs | Doesn't need |
|---|---|---|
| S1 Internal desk tool inside Deephaven's web UI | layer 1, the Deephaven chart hook and fork, deephaven.ui widgets (`dhapp.ui`, the workspace), server stores and nodes | own shell, request client |
| S2 Own React desk app, Deephaven as backend (group C grown up; `desk-app`'s pattern) | layers 1–4 except the Deephaven chart hook and fork | deephaven.ui |
| S3 Your framework's UI: views of an app's internals plus controls | S2 + generic table and form widgets, link bus, DAG explorer, handler registry, controls, `dhapp` integration | most trading-specific widgets at first |
| S4 Many users | S2/S3 + identity, node-cache limits, observability, scaling | |
| S5 Trading front end | S2 + trading widgets, markers, position lines, broker integration | |
| S6 Chart component reused without Deephaven | layer 1 + `SeriesFeed` and store interfaces, a non-Deephaven adapter | layers 2–4 |
| S7 Enterprise deployment | S2/S3 + `dhfw` on a plant, Enterprise identity and ACLs | Community emulations |

## Open decisions

1. **App shell:** our own React shell (S2, S3; `desk-app` already does this) or Deephaven's web UI (S1).
   Most of layer 3 depends on it.
2. **Layout library** (with our own shell): dockview, FlexLayout or golden-layout. Affects workspaces and
   pop-outs.
3. **Generic table:** Deephaven's IrisGrid embedded (`react-client`) or our own viewport grid (`desk-app`).
4. **Handler registry shape:** decorators and parameter schemas on the server; whether client types are
   generated.
5. **Identity:** tokens in the protocol now, or a Java authentication handler; Enterprise users later.
6. **Where the framework's server code lives:** `dhapp` (with charts and the request API as dhapp parts)
   or a new package; dh-charts' chart code becomes a module either way.
7. **Keep A/B:** keep deephaven.ui and the fork as a supported front end, or as a prototype and an
   operator view only (`dhapp.ui` dashboards).

## Target packages (current → proposed)

| Proposed | Holds | From |
|---|---|---|
| `@acme/chart` (layer 1) | chart core, series types, plugins, interfaces | `ext/` minus the Deephaven files; the chart parts of `RawChart.tsx` |
| `@acme/dh-bindings` (layer 2) | table stores, `subscribeRows`, `tableFeed`, `ApiClient`, `requestChart` (exists, `bindings/`); still to move in: a connection module and table hooks | `desk-app/web/src/deephaven.ts` and `hooks.ts` |
| `@acme/app-shell` (layer 3) | link bus, layouts, workspaces, generic widgets, chart panel | `react/`, `RawWorkspace`, `desk-app/web/src/components` |
| `dhapp` + `dhfw` (layer 4) | app structure, catalog, stores, runtime portability; add the request API and node cache | deephaven-compare; `dh_chart_ext/api.py`, `cache.py` |
| `dh-charts` (a layer-4 module) | chart data model, nodes, studies, sessions, alerts | `dh_chart_ext/data.py`, `nodes.py`, `sessions.py`, `alerts.py`, `charts.py` |
| `dh-chart-ext` (A/B only) | deephaven.ui workspace and elements, plugin JS | `workspace.py`, `dh-plugin/js` |

## Known limitations

| Limitation | Where | Consequence | Way out |
|---|---|---|---|
| Alerts are evaluated once per update cycle | `alerts.AlertEngine` | a move through the level and back within one cycle (1 s) is missed | evaluate on ticks, or a shorter cycle |
| No holidays or early closes | `sessions.py` | shading and status are wrong on holidays | a calendar source |
| The synthetic feed ticks on weekends | `perf/app.d/feeds.py` | demo only | |
| About 30 s before the first workspace opens after start | demo (5 days of history) | slow restarts | base bars on disk |
| A closed stream is not always reported to the plugin (a browser page that navigates away: never; a pydeephaven close on Linux: not within 10 s) | Deephaven object streams | its nodes would leak (no `on_close` after 11 minutes, C22) | the API's 90 s lease (verified, C22) |
| No user identity on Community | Deephaven auth | per-user state is keyed by a client-supplied owner | verified tokens, or Enterprise |
| Tick charts and each pane's history window are not shared nodes | `workspace.chart_pane` | one small filter chain per pane | ticks as nodes; lookback in shared steps |
| A/B's time zone is the browser's | Deephaven's plugin | group C can show the exchange's zone (`&tz=`); A/B cannot | a zone option in the fork |
| `@deephaven/jsapi-types` is ~41.11, the server 42.6 | `package.json` | types may lag the API | upgrade with the server |
| Deephaven's plugin is 0.1.0 alpha and we run a fork | A/B | upstream changes need merging | S2 drops both |
| LWC rebuilds the whole series when a new time point arrives (C2) | Lightweight Charts 5.2 | long raw-tick histories are slow | bars, not raw ticks, for long views |
| The server caches plugin JS until restart (C14) | Deephaven server | restart after every plugin build | |

## Non-goals

- Not a TradingView clone: build the widgets the desk uses; generic table and form widgets cover the long
  tail. No TradingView name, branding or look beyond the familiar layout.
- No TradingView attribution added anywhere (decided).
- No per-user Python on the hot path: Python runs to set things up (requests, controls, actions), not per
  tick or per row.
- The chart component does not depend on Deephaven; Deephaven-specific code stays in layer 2 and up.

## Glossary

| Term | Meaning |
|---|---|
| Groups A, B, C | the three kinds of front end: A deephaven.ui; B React rendering Deephaven UI objects (`WidgetView`); C React using only table data |
| Layer 1–4 | the chart component, the Deephaven bindings, the app shell, the server framework (above) |
| Node | a table in the server's graph; a shared node is one the node cache built for a request and shares between clients |
| Canonical key | the normalized form of a request (`2m` = `120s`; studies sorted), so equal requests share a node |
| Grace period | how long a node nobody holds is kept before it is released (60 s) |
| Lease | how long a client's stream may stay silent before the server releases what it holds (90 s; clients ping) |
| Link bus, link group | shared values (symbol, time range) that widgets publish and follow, scoped to a group |
| Request API, handler | the object-type plugin that answers JSON requests; a handler is the Python function for one method |
| Store | a persistent keyed input table holding user state (annotations, alerts, settings) |
| dhapp roles | source, stage, action, surface: the four kinds of part a `dhapp.App` is made of |
| The fork | our branch of Deephaven's TradingView plugin (`acme/tradingview-lightweight`) that announces chart lifecycle events |
