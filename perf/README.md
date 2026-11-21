# Live chart performance: deephaven.ui vs. standalone React, plotly vs. Lightweight Charts

**Question.** A desk app draws 16 live futures/cash charts with deephaven.ui and plotly-express
(`dx`). Traders call it slow and ugly. Is the fix a different charting library, a standalone React
client instead of deephaven.ui, or something on the server?

**Answer (measured, 2026-11-21).**

1. **The chart library is the problem, not deephaven.ui.** Plotly collapses to about 1 FPS with
   16 live charts, through Deephaven's own `dx` wrapper and through plotly.js called directly.
   TradingView Lightweight Charts (LWC) stays smooth in both architectures.
2. **The status quo:** 1.3 FPS, frames up to 4 s, a pegged main thread, data 4–5 s old on screen,
   and 27 s to first draw.
3. **The recipe that works:** 1-second OHLC bars computed in Deephaven, drawn with LWC, with
   a 100 ms update-graph cycle and Barrage interval. Standalone React reached 40 FPS at 29 % of
   the main thread, with ticks on screen 168 ms after they happened (p95 259 ms). The same
   recipe in deephaven.ui with DH's TradingView plugin ran at 30 FPS and 55 % of the main thread.
4. **deephaven.ui vs. React matters only at the fast cadence,** where the DH plugin costs about
   2× the client CPU of a hand-written client. The profile puts the extra cost in client code (the
   plugin's per-point time-zone conversion, heavier JS API work), not the server or the
   architecture. At the default 1 s cadence the two are equivalent.
5. **The Deephaven server is never the bottleneck:** 5–47 % of one core across every run.

## Recommendations

| Horizon | Change | Evidence |
|---|---|---|
| This week | `dx.line(..., render_mode="svg")`: plotly's default `webgl` opens one WebGL context per chart | 1.3 → 14.6 FPS. Still poor (77 % main thread, 0.8 s frames when interacting): a stopgap |
| Next | Chart **bars, not ticks**: 1-second bars (`lowerBin(Timestamp, SECOND)` + `agg_by`); a tick then mutates the last bar instead of appending a point | DH plugin: 20 % → 11 % main thread at the default cadence |
| Next | **DH's TradingView plugin** (`deephaven-plugin-tradingview-lightweight`, alpha 0.1.0) in place of `dx`; keep deephaven.ui | 38 FPS, 11 % main thread, input p95 56 ms (1-s bars, default cadence) |
| Next | **Cadence:** `PeriodicUpdateGraph.targetCycleDurationMillis=100` and `barrage.minUpdateInterval=100` for the charting worker | Tick → screen p50 968 → 168 ms (React + LWC); server 30–47 % of one core |
| Later | If 16 charts at 100 ms still need headroom: raise the plugin's client overhead with Deephaven, or write a thin client (JS plugin or React) | Plugin 55 % vs. hand-written 29 % main thread at the same cadence and data |
| Don't | Plot raw ticks with long history at a fast cadence, in any library | LWC `series.update()` with a new time point rebuilds the whole series: an O(n) cost per tick |

## Method

- **Server** (`app.d/`): Deephaven Community 42.6 (pip server, native Windows, 4 GB heap) with 16
  synthetic instruments. One `time_table` drives all 16, with a random walk per instrument via
  `update_by(cum_sum)`, all in Java formulas. Each run starts with `PERF_HISTORY_S` of backfill.
  Each instrument has a ticks table (`t_<SYM>`), 1-minute bars (`bars_<SYM>`) and 1-second bars
  (`bars1s_<SYM>`); the bars carry `Updated` (time of their last tick).
- **deephaven.ui variants** (`app.d/dashboards.py`): a `ui.dashboard` of 4×4 `ui.panel`s, opened
  at `/iframe/widget/?name=...`. All client code on this path is Deephaven's.
- **React variants** (`web/`): React 19 plus the JS API loaded from the server, with no `@deephaven`
  UI packages. Each chart uses a full subscription and appends added/modified rows, coalesced
  to one draw per animation frame. LWC 5.2: `setData` once, then `update()`. plotly.js 3.1:
  `scattergl` + `extendTraces`; candles with `Plotly.react`.
- **Runner** (`bench/run.mjs`): Playwright driving headless Chrome at 1920×1080 on the real GPU
  (Intel Iris Xe, D3D11), on a laptop with an i7-1255U and 32 GB. For each variant: wait until
  all 16 charts have drawn, warm up 5 s, a **passive** 30 s window (data ticking), then an
  **interactive** 10 s window (crosshair sweeps at 60 Hz and wheel zooms over one chart).
  Metrics:
  - FPS and frame-time percentiles (rAF)
  - long tasks and blocking time
  - main-thread busy % (CDP `Performance`)
  - CPU per Chrome process (CDP `SystemInfo`) and for the Deephaven server process
  - bytes received and JS heap
  - **freshness**: now minus the newest tick time, measured after the frame that drew it.
    React variants only; for `dx` the newest x value in each plotly trace was used. The DH
    TradingView plugin gives no hook, so it shows "–".
- **Matrix** (`bench/matrix.mjs`): one fresh server per config. Profiles with
  `bench/profile.mjs` (CDP sampling profiler).

Configs (rate is ticks/s per instrument; points per chart in parentheses):

| Config | Rate | History | Other |
|---|---|---|---|
| base | 10 | 30 min (18k) | per-instrument tables from `where()` |
| flat | 10 | 30 min | `.flatten()` each instrument (contiguous row keys) |
| short | 10 | 2 min (1.2k) | flat |
| heavy | 50 | 20 min (60k) | flat |
| fast | 10 | 30 min | flat; 100 ms cycle + Barrage interval |
| candle | 10 | 30 min | 1-minute bars (~30 per chart) |
| svg | 10 | 30 min | `dx.line(render_mode="svg")` |
| bars1s | 10 | 30 min | 1-second bars (1,800 per chart) |
| bars1s-fast | 10 | 30 min | 1-second bars; 100 ms cycle + Barrage interval |

## Results

Passive window unless marked; "int" = interactive window. Main % = main-thread busy time as a
share of wall time (it can exceed 100 % when CDP also counts off-thread tasks). Server % = one
core.

| Config | Variant | Ready s | FPS | p95 frame ms | Main % | Server % | Heap MB | Fresh p50/p95 ms | Int FPS | Int p95 frame ms |
|---|---|---|---|---|---|---|---|---|---|---|
| base | **ui + plotly (status quo)** | 27.2 | **1.3** | **4075** | **103** | 12 | 303 | 4108 / 5374 | 1.5 | 3477 |
| base | ui + DH TradingView | 5.3 | 31.3 | 42 | 20 | 15 | 151 | – | 48.8 | 21 |
| base | React + plotly | 31.3 | 0.7 | 3809 | 180 | 16 | 378 | 49241 / 75903 (falling behind) | 1.2 | 2488 |
| base | React + LWC | 9.8 | 28.6 | 63 | 27 | 5 | 734 | 882 / 2874 | 35.8 | 62 |
| flat | ui + plotly | 31.3 | 0.8 | 4337 | 108 | 13 | 287 | 3846 / 5820 | 0.9 | 4013 |
| flat | ui + DH TradingView | 6.7 | 29.8 | 42 | 20 | 15 | 156 | – | 34.6 | 41 |
| flat | React + plotly | 13.1 | 0.5 | 3471 | 109 | 10 | 273 | 8180 / 11251 | 0.5 | 3660 |
| flat | React + LWC | 8.4 | 31.9 | 62 | 27 | 12 | 603 | 700 / 1276 | 34.2 | 83 |
| short | ui + plotly | 20.3 | 1.1 | 2913 | 108 | 13 | 513 | 3014 / 4041 | 1.2 | 3121 |
| short | ui + DH TradingView | 4.9 | 32.8 | 42 | 17 | 22 | 200 | – | 39.8 | 22 |
| short | React + plotly | 5.5 | 0.5 | 3074 | 107 | 13 | 153 | 7783 / 9210 | 0.8 | 2853 |
| short | React + LWC | 3.8 | 40.0 | 22 | 9 | 9 | 92 | 694 / 953 | 42.4 | 22 |
| heavy | ui + plotly | 18.6 | 1.1 | 2982 | 107 | 20 | 487 | 3712 / 4212 | 1.1 | 3715 |
| heavy | ui + DH TradingView | 6.4 | 33.1 | 42 | 16 | 16 | 153 | – | 38.8 | 41 |
| heavy | React + plotly | 29.9 | 0.3 | 5462 | 143 | 17 | 529 | 35717 / 48387 | 0.4 | 7000 |
| heavy | React + LWC | 52.6 | **0.3** | 7478 | 144 | 15 | 1093 | 37890 / 53339 | 0.3 | 6358 |
| fast | ui + plotly | 36.4 | 1.5 | 4632 | 113 | 35 | 269 | 21526 / 30090 | 2.2 | 2977 |
| fast | ui + DH TradingView | 7.0 | 6.2 | 562 | 89 | 69 | 280 | – | 14.1 | 105 |
| fast | React + plotly | 24.5 | 9.4 | 435 | 86 | 45 | 287 | 473 / 20229 | 18.3 | 124 |
| fast | React + LWC | 10.9 | 22.8 | 84 | 52 | 44 | 488 | 247 / 1004 | 41.2 | 41 |
| svg | ui + plotly, `render_mode="svg"` | 20.1 | 14.6 | 458 | 77 | 17 | 547 | 549 / 1079 | 6.0 | 807 |
| candle | ui + plotly candles | 15.3 | 36.3 | 22 | 29 | 11 | 145 | – | 38.0 | 22 |
| candle | ui + DH TradingView candles | 4.2 | 39.0 | 22 | 9 | 12 | 151 | – | 41.5 | 21 |
| candle | React + plotly candles | 2.5 | 32.0 | 63 | 23 | 8 | 65 | – | 36.5 | 63 |
| candle | React + LWC candles | 2.5 | 39.1 | 22 | 5 | 6 | 44 | – | 44.4 | 21 |
| bars1s | ui + plotly candles | 16.5 | 0.5 | 3477 | 107 | 22 | 203 | 2369 / 3487 | 0.7 | 3476 |
| bars1s | **ui + DH TradingView** | 5.1 | 38.4 | 22 | **11** | 16 | 110 | – | 46.2 | 21 |
| bars1s | React + plotly candles | 6.1 | 0.5 | 3642 | 56 | 12 | 209 | 4646 / 7269 | 0.7 | 2783 |
| bars1s | React + LWC | 4.8 | 39.0 | 21 | 9 | 9 | 92 | 968 / 1095 | 45.2 | 21 |
| bars1s-fast | ui + plotly candles | 19.8 | 1.0 | 2118 | 100 | 36 | 178 | 6889 / 10713 | 0.7 | 2763 |
| bars1s-fast | **ui + DH TradingView** | 6.1 | **30.2** | 61 | **55** | 47 | 177 | – | 48.4 | 21 |
| bars1s-fast | React + plotly candles | 7.6 | 0.6 | 2514 | 46 | 27 | 127 | 4017 / 8848 | 0.9 | 1658 |
| bars1s-fast | **React + LWC** | 4.3 | **40.3** | 21 | **29** | 30 | 90 | **168 / 259** | 48.2 | 21 |

Freshness for the 1-minute candle runs is omitted: those runs predate the `Updated` column and
measured from bar start time, which is not a lag. Bytes received were 9–92 KB/s in every run, so
the network is never a factor.

## What the profiles showed

- **LWC's `update()` is O(series length) per new time point.** In the 5.2 source, adding a time
  point calls `series.setData(all rows)` and `recalculateAllPanes()` synchronously. Updating the
  *last* point takes an incremental path. That is why raw ticks with long history get expensive
  (`heavy`: 0.3 FPS in the hand-written client) and bars stay cheap. The DH plugin escapes this
  for long *line* series by downsampling on the server and subscribing to the reduced table
  (`heavy`: 33 FPS).
- **Plotly's line collapse is mostly WebGL.** `scattergl` gives one WebGL context per chart, and
  Chrome keeps only about 16 active. With 1.2k points (`short`) it still ran at about 1 FPS,
  while SVG lines (`svg`) reached 14.6 FPS. Plotly candles are one SVG shape per bar: fine at
  30 bars (36 FPS), collapsed at 1,800 (0.5 FPS).
- **The DH plugin's extra cost at 100 ms** (same data, 1-second bars), main-thread time per
  second:
  - Deephaven JS API: 226 ms in the plugin vs. 97 ms in the hand-written client
  - native rendering: 610 ms vs. 224 ms
  - the plugin's `getTimezoneOffsetSeconds` (`Intl.DateTimeFormat.formatToParts` per point):
    53 ms
  - idle time left: 117 ms vs. 607 ms

  These look like fixable implementation costs in an alpha plugin, not limits of deephaven.ui.
- **Flattening the per-instrument tables** (`flat` vs. `base`) barely changed client CPU. It
  did cut React + LWC freshness p95 from 2.9 s to 1.3 s and plotly's script time.

## Caveats

- One laptop (i7-1255U, Iris Xe), headless Chrome. Even near-idle pages top out around
  40 FPS here, so compare variants with each other and don't read FPS as absolute.
- One 30 s run per cell, with no repeats; differences under about 20 % are noise.
- Input-latency p95 (Event Timing) came out near 500 ms in most LWC runs, even nearly idle
  ones: one or two slow synthetic wheel events per window. It is left out of the table as
  unreliable. The interactive frame time is the trustworthy interaction metric.
- The hand-written React clients are minimal: no axes customisation, legends or tooltips. A
  feature-complete client would cost more.
- Synthetic data. Real feeds are burstier, and bursts favour bars even more.

## Run it

```powershell
cd perf/web; npm install; npm run build; npm run preview      # serves :4040, proxies to :10040
cd perf/bench; npm install
node matrix.mjs                         # every config (~1 h); or --only bars1s,bars1s-fast
node summarize.mjs base bars1s-fast     # tables from results/*.json
node profile.mjs "http://localhost:10040/iframe/widget/?name=dash_tvl_1s" --ready tvl
```

`matrix.mjs` starts and stops the server itself (the repo's `.venv`, or `DH_PYTHON`; port 10040;
`JAVA_HOME` must be set). The DH TradingView plugin must be installed in that environment:
`pip install deephaven-plugin-tradingview-lightweight==0.1.0`.
