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
| **L2 Workspace** | A deephaven.ui component: toolbar (symbol, resolution, range, type, studies, scale) plus an L1 chart | `dh_chart_ext.workspace` | ✓ | ? `WidgetView` of a deephaven.ui element, to be verified | ✗ |
| **C1 LWC plugins** | Drawing tools, shading, price lines, sync: plain LWC plugins with no Deephaven dependency | `@acme/chart-ext` (`ext/src/lwc-plugins`, `extensions.ts`) | ✓ (via C2) | ✓ (via C2) | ✓ attach to your own LWC chart directly |
| **C2 Hook** | Applies C1 to charts drawn by Deephaven's plugin | `@acme/chart-ext` (`hook.ts`) + `dh-chart-ext` | ✓ automatic | ✓ `attachTvlExtensions` | n/a |
| **C3 React kit** | Toolbar components and a table → LWC series adapter (append/last-bar updates), for group C's own charts | `@acme/chart-react` (later) | ✗ | optional | ✓ |
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
| `ext/` | **`@acme/chart-ext`**: our features as LWC plugins, the hook that applies them to Deephaven's charts, and the annotation store. In-repo hosts compile its source (a Vite alias); `npm pack` builds the distributable package (`dist/`), published as a tarball in [lwc-vendor](https://github.com/taymarti/lwc-vendor) `acme/` |
| `web/` | **React host** (pattern A): Deephaven's own chart component in a standalone React app, through `WidgetView`. The plugin's JS comes from the server, so there is nothing to vendor and no npm package |
| `dh-plugin/` | **`dh-chart-ext`**: a Python package that registers a JS plugin with the Deephaven server and brings `@acme/chart-ext` to every Deephaven web UI, deephaven.ui dashboards included |
| (fork) | Our changes to Deephaven's plugin live in [taymarti/deephaven-plugins](https://github.com/taymarti/deephaven-plugins/tree/acme/tradingview-lightweight), branch `acme/tradingview-lightweight` (see "The fork" below) |
| `dh-plugin/src/dh_chart_ext/` `data.py` `charts.py` `workspace.py` | The Python layers L0, L1 and L2 |
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
| Crosshair sync across every chart (same time, each chart's own price) | ours (`ext/src/extensions.ts`) | Works in both hosts |
| Persistent price lines ("+" at the right edge; Shift+click deletes, Ctrl+click shares) | official `@tradingview/lwc-plugin-user-price-lines` 1.0.0, bound to the annotations table (`ext/src/persistent-price-lines.ts`, `dh_chart_ext/store.py`) | Verified in all three groups: saved per user, survive chart rebuilds and server restarts (parquet), others' shared lines in blue with the owner's name, soft delete |
| Drawing tools: horizontal ray, trend line (palette at top left; click to select, drag line or handle, Delete removes, Ctrl+click shares, Esc cancels; weak magnet to OHLC) | ours (`ext/src/drawings.ts`), saved as kind `drawing` | Verified in all three groups: saved per user, carried across resolutions (points are time + price), handle and whole-line drags, soft delete |
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
npm --prefix ext install
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
- C, React with table data only: `http://localhost:4050/?raw=bars_1m&sym=ES&studies=EMA_20,BB_20_2_Upper,BB_20_2_Lower`

`--app-dir perf/app.d` runs the benchmark's app instead (`dash_tvl_1s`, `tvl1s_<SYM>`, 16 charts per
dashboard); `perf/README.md` has the benchmark.

## Next

1. Persistence (P) is done: price lines, drawings, workspace settings. Owner is client-supplied on Community; use authenticated users + row ACLs on Enterprise.
2. C3 for group C: a toolbar kit and a table-to-LWC adapter (added and modified rows, time-zone
   formatting), from `RawChart.tsx` and the benchmark client.
3. More drawing tools on the same framework: rectangle, Fibonacci retracement, vertical line, text note. Drawing points off the data (weekend gaps) drift, since off-data times use a linear axis.
4. Propose the fork's two changes upstream, along with the per-pane scale mode and null-as-gap
   issues.
5. Steady-state cost of `ws_grid` under the benchmark, and the plugin overhead still left at a 100 ms
   cadence (41 % vs. 25 % for a hand-written client).

## License

Apache-2.0 (`LICENSE`, `NOTICE`), including the `@acme/chart-ext` package and the `dh-chart-ext`
Python package. The fork of Deephaven's plugin is Apache-2.0 too (upstream's license).
