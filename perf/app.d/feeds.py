"""
Synthetic exchange feeds for the chart benchmark: N instruments, each ticking RATE times a second,
with HISTORY seconds of backfill so every chart starts with a realistic amount of data.

One time_table drives every instrument. Its start time is in the past, so the first cycle
catches up and appends the whole backfill at once; after that, rows arrive live. Prices are a
random walk per instrument (update_by cum_sum), all in Java formulas: no Python per tick.

Published fields:
  ticks            every tick: Timestamp, Sym, Price, Size
  t_<SYM>          one instrument's ticks (Timestamp, Price): what each chart plots
  bars_<SYM>       one instrument's 1-minute OHLC bars (Timestamp, Open, High, Low, Close)
  perf_config      the settings this server was started with (one row)

Settings (environment variables, read at startup):
  PERF_SYMBOLS     instruments                      (default 16)
  PERF_RATE        ticks per second per instrument (default 10)
  PERF_HISTORY_S   seconds of backfill              (default 1800)
  PERF_FLATTEN     1 = flatten each instrument's table (contiguous row keys); 0 = plain where()
                   (default 0). A where() keeps the parent's row keys, so one instrument out of 16
                   holds every 16th key: a fragmented row set that every subscribed client tracks.
"""
import os

import jpy
from deephaven import agg, empty_table, time_table
from deephaven.time import dh_now
from deephaven.updateby import cum_sum

PERF_SYMBOLS = int(os.environ.get("PERF_SYMBOLS", "16"))
PERF_RATE = float(os.environ.get("PERF_RATE", "10"))
PERF_HISTORY_S = int(os.environ.get("PERF_HISTORY_S", "1800"))
PERF_FLATTEN = os.environ.get("PERF_FLATTEN", "0") == "1"

_NAMES = ["ES", "NQ", "RTY", "YM", "ZN", "ZB", "ZF", "ZT", "CL", "NG", "GC", "SI", "6E", "6J", "UST10", "BUND",
          "HG", "ZC", "ZS", "ZW", "6B", "6A", "6C", "VX"]
SYMS = [_NAMES[i] if i < len(_NAMES) else f"S{i}" for i in range(PERF_SYMBOLS)]
_SYM_ARR = jpy.array("java.lang.String", SYMS)
_N = PERF_SYMBOLS

_period_ns = int(round(1e9 / (PERF_SYMBOLS * PERF_RATE)))
_start = dh_now().minusSeconds(PERF_HISTORY_S)

ticks = (
    time_table(_period_ns, start_time=_start)
    .update(["Idx = ii", "Sym = _SYM_ARR[(int) (Idx % _N)]", "Step = (Math.random() - 0.5) * 0.02", "Size = 1 + (int) (Math.random() * 10)"])
    .update_by(cum_sum("Walk = Step"), by="Sym")
    .update("Price = 100.0 + 25.0 * (Idx % _N) + Walk")
    .view(["Timestamp", "Sym", "Price", "Size"])
)

TICKS = {}
BARS = {}
BARS1S = {}
for _s in SYMS:
    TICKS[_s] = ticks.where(f"Sym = `{_s}`").view(["Timestamp", "Price"])
    if PERF_FLATTEN:
        TICKS[_s] = TICKS[_s].flatten()
    BARS[_s] = (
        TICKS[_s]
        .update_view("Bar = lowerBin(Timestamp, MINUTE)")
        .agg_by(
            [
                agg.first("Open=Price"),
                agg.max_("High=Price"),
                agg.min_("Low=Price"),
                agg.last("Close=Price"),
                agg.last("Updated=Timestamp"),
            ],
            by="Bar",
        )
        .rename_columns("Timestamp=Bar")
    )
    # 1-second bars: tick-level freshness, but a tick mutates the last bar instead of adding a point
    BARS1S[_s] = (
        TICKS[_s]
        .update_view("Bar = lowerBin(Timestamp, SECOND)")
        .agg_by([agg.first("Open=Price"), agg.max_("High=Price"), agg.min_("Low=Price"), agg.last("Close=Price"), agg.last("Updated=Timestamp")], by="Bar")
        .rename_columns("Timestamp=Bar")
    )
    globals()[f"bars1s_{_s}"] = BARS1S[_s]
    globals()[f"t_{_s}"] = TICKS[_s]
    globals()[f"bars_{_s}"] = BARS[_s]

perf_config = empty_table(1).update(
    [
        f"Symbols = (int) {PERF_SYMBOLS}",
        f"RatePerSymbol = (double) {PERF_RATE}",
        f"HistorySeconds = (int) {PERF_HISTORY_S}",
        f"Flatten = {str(PERF_FLATTEN).lower()}",
        f"SymList = `{','.join(SYMS)}`",
    ]
)
