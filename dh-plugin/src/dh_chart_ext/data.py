"""
L0, the data layer: tables for charts. Every front end can use it (deephaven.ui, React with Deephaven
UI objects, React with only table data), so nothing here depends on a UI or a chart plugin.

  bars(ticks, "PT1M")                     OHLCV bars per symbol at any resolution, live
  with_studies(bars_t, [EMA(20), RSI()])  the same table with study columns added (per symbol)
  standard_set(ticks)                     a fixed set of bar tables with the standard studies, for
                                          clients that cannot run Python (the JS API has no update_by)

Conventions (the input):
  a ticks table with  Timestamp (Instant), Sym (String), Price (double), and optionally Size (numeric)
  column names can be overridden; `by` may be None for single-instrument tables.

Conventions (the output, every bars table):
  Timestamp  bar start (Instant)        Open High Low Close (double)
  Volume     summed Size (0 without Size)  Updated  time of the bar's last tick (Instant)
  Sym        when `by` is set
Studies add columns named after the study and its parameters (EMA_20, BB_20_2_Upper, RSI_14, ...),
so several can coexist and clients can find them by name.

Everything is incremental: an appended tick updates one bar and the study values from that bar on.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Optional, Sequence

from deephaven import agg
from deephaven.table import Table
from deephaven.updateby import cum_sum, delta, ema_tick, rolling_avg_tick, rolling_std_tick

# ----------------------------------------------------------------------------- resolutions

RESOLUTIONS = {
    "1s": "PT1S", "5s": "PT5S", "15s": "PT15S", "1m": "PT1M", "5m": "PT5M", "15m": "PT15M", "1h": "PT1H", "1d": "P1D",
}
"""Short names used by toolbars and published tables, mapped to ISO-8601 durations."""

_ISO = re.compile(r"^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$")


def resolution_seconds(resolution: str) -> int:
    """'1m' or 'PT1M' -> 60."""
    iso = RESOLUTIONS.get(resolution, resolution)
    m = _ISO.match(iso)
    if not m or not any(m.groups()):
        raise ValueError(f"unsupported resolution {resolution!r}; use one of {list(RESOLUTIONS)} or an ISO duration like PT30S")
    d, h, mi, s = (int(x or 0) for x in m.groups())
    return ((d * 24 + h) * 60 + mi) * 60 + s


# ----------------------------------------------------------------------------- bars

def bars(
    ticks: Table,
    resolution: str,
    *,
    by: Optional[str] = "Sym",
    time_col: str = "Timestamp",
    price_col: str = "Price",
    size_col: Optional[str] = "Size",
) -> Table:
    """OHLCV bars at `resolution` ('1m', 'PT30S', ...) from a ticks table, per `by` value."""
    secs = resolution_seconds(resolution)
    cols = set(ticks.column_names)
    has_size = size_col is not None and size_col in cols
    keys = ([by] if by else []) + ["Bar"]
    aggs = [
        agg.first(f"Open={price_col}"),
        agg.max_(f"High={price_col}"),
        agg.min_(f"Low={price_col}"),
        agg.last(f"Close={price_col}"),
        agg.last(f"Updated={time_col}"),
    ]
    if has_size:
        aggs.append(agg.sum_(f"Volume={size_col}"))
    out = (
        ticks.update_view(f"Bar = lowerBin({time_col}, {secs}L * SECOND)")
        .agg_by(aggs, by=keys)
        .rename_columns(f"{time_col}=Bar")
    )
    if not has_size:
        out = out.update_view("Volume = 0.0")
    else:
        out = out.update_view("Volume = (double) Volume")
    front = (["Sym"] if by == "Sym" else [by] if by else []) + ["Timestamp", "Open", "High", "Low", "Close", "Volume", "Updated"]
    return out.view(front) if time_col == "Timestamp" else out


# ----------------------------------------------------------------------------- studies

@dataclass(frozen=True)
class Study:
    """A study adds columns to a bars table. `pane` says where a chart should draw it:
    "overlay" (on the price pane) or the name of a separate pane ("volume", "rsi", ...)."""

    def columns(self) -> list[str]:
        raise NotImplementedError

    def apply(self, t: Table, by: Optional[str]) -> Table:
        raise NotImplementedError

    @property
    def pane(self) -> str:
        return "overlay"

    @property
    def key(self) -> str:
        """Short name for toolbars and persistence, e.g. 'EMA_20'."""
        return self.columns()[0]


def _by(by: Optional[str]) -> list[str]:
    return [by] if by else []


@dataclass(frozen=True)
class EMA(Study):
    """Exponential moving average of Close over `n` bars (alpha = 2/(n+1), as most charting apps)."""
    n: int = 20

    def columns(self):
        return [f"EMA_{self.n}"]

    def apply(self, t, by):
        # ema_tick's decay is a time constant tau with alpha = 1 - exp(-1/tau)
        tau = -1.0 / math.log(1.0 - 2.0 / (self.n + 1.0))
        return t.update_by(ema_tick(tau, f"EMA_{self.n}=Close"), by=_by(by))


@dataclass(frozen=True)
class SMA(Study):
    """Simple moving average of Close over `n` bars."""
    n: int = 20

    def columns(self):
        return [f"SMA_{self.n}"]

    def apply(self, t, by):
        return t.update_by(rolling_avg_tick(f"SMA_{self.n}=Close", rev_ticks=self.n), by=_by(by))


@dataclass(frozen=True)
class Bollinger(Study):
    """Bollinger bands: SMA(n) +/- k standard deviations of Close."""
    n: int = 20
    k: float = 2.0

    def _p(self):
        return f"BB_{self.n}_{self.k:g}"

    def columns(self):
        p = self._p()
        return [f"{p}_Upper", f"{p}_Mid", f"{p}_Lower"]

    @property
    def key(self):
        return self._p()

    def apply(self, t, by):
        p = self._p()
        return t.update_by(
            [rolling_avg_tick(f"{p}_Mid=Close", rev_ticks=self.n), rolling_std_tick(f"{p}_Sd=Close", rev_ticks=self.n)],
            by=_by(by),
        ).update_view([f"{p}_Upper = {p}_Mid + {self.k} * {p}_Sd", f"{p}_Lower = {p}_Mid - {self.k} * {p}_Sd"]).drop_columns(f"{p}_Sd")


@dataclass(frozen=True)
class VWAP(Study):
    """Volume-weighted average price, reset each UTC day (typical price (H+L+C)/3). Needs Volume > 0."""

    def columns(self):
        return ["VWAP"]

    def apply(self, t, by):
        return (
            t.update_view(["VwapDay = lowerBin(Timestamp, DAY)", "VwapPV = (High + Low + Close) / 3.0 * Volume", "VwapV = Volume"])
            .update_by(cum_sum(["VwapCumPV=VwapPV", "VwapCumV=VwapV"]), by=_by(by) + ["VwapDay"])
            .update_view("VWAP = VwapCumV > 0 ? VwapCumPV / VwapCumV : NULL_DOUBLE")
            .drop_columns(["VwapDay", "VwapPV", "VwapV", "VwapCumPV", "VwapCumV"])
        )


@dataclass(frozen=True)
class RSI(Study):
    """Relative strength index with Wilder smoothing (alpha = 1/n), 0-100."""
    n: int = 14

    def columns(self):
        return [f"RSI_{self.n}"]

    @property
    def pane(self):
        return "rsi"

    def apply(self, t, by):
        c = f"RSI_{self.n}"
        tau = -1.0 / math.log(1.0 - 1.0 / self.n)
        return (
            t.update_by(delta(f"{c}_D=Close"), by=_by(by))
            .update_view([f"{c}_G = isNull({c}_D) ? 0.0 : Math.max({c}_D, 0.0)", f"{c}_L = isNull({c}_D) ? 0.0 : Math.max(-{c}_D, 0.0)"])
            .update_by(ema_tick(tau, [f"{c}_AG={c}_G", f"{c}_AL={c}_L"]), by=_by(by))
            .update_view(f"{c} = {c}_AL == 0 ? 100.0 : 100.0 - 100.0 / (1.0 + {c}_AG / {c}_AL)")
            .drop_columns([f"{c}_D", f"{c}_G", f"{c}_L", f"{c}_AG", f"{c}_AL"])
        )


@dataclass(frozen=True)
class Volume(Study):
    """Volume histogram (the column already exists); placed in its own pane."""

    def columns(self):
        return ["Volume"]

    @property
    def pane(self):
        return "volume"

    def apply(self, t, by):
        return t


STUDIES = {
    "EMA_20": EMA(20), "EMA_50": EMA(50), "SMA_20": SMA(20), "BB_20_2": Bollinger(20, 2.0),
    "VWAP": VWAP(), "RSI_14": RSI(14), "Volume": Volume(),
}
"""The standard studies, by key: what toolbars offer and what standard_set() precomputes."""


def with_studies(t: Table, studies: Sequence[Study], *, by: Optional[str] = "Sym") -> Table:
    """`t` (a bars table) with each study's columns added, computed per `by` value."""
    by = by if by and by in t.column_names else None
    for s in studies:
        if all(c in t.column_names for c in s.columns()):
            continue  # already there (e.g. a standard-set table)
        t = s.apply(t, by)
    return t


# ----------------------------------------------------------------------------- the standard set

STANDARD_RESOLUTIONS = ("1s", "5s", "1m", "5m")


def standard_set(ticks: Table, resolutions: Sequence[str] = STANDARD_RESOLUTIONS, *, by: str = "Sym") -> dict[str, Table]:
    """{'bars_1m': table, ...}: bars for every symbol at each resolution, with every standard study.
    Publish these for clients that can only filter (JS API): they choose symbol and range with
    filters, and read study columns by name."""
    return {f"bars_{r}": with_studies(bars(ticks, r, by=by), list(STUDIES.values()), by=by) for r in resolutions}


def for_symbol(t: Table, sym: str, *, by: str = "Sym") -> Table:
    """Rows of one symbol, without the symbol column."""
    return t.where(f"{by} = `{sym}`").drop_columns(by)


def in_range(t: Table, since=None) -> Table:
    """Rows from `since` (an Instant; None = all).

    Apply AFTER with_studies: studies need the history before the range to warm up (an EMA or RSI
    computed on the visible window alone starts cold)."""
    if since is None:
        return t
    from deephaven.time import to_j_instant

    return t.where(f"Timestamp >= '{to_j_instant(since)}'")  # an Instant literal


# ----------------------------------------------------------------------------- study types (for UIs)

@dataclass(frozen=True)
class StudyType:
    """A kind of study a UI can add, with editable parameters. `make(params)` builds the Study."""
    label: str
    group: str
    params: dict  # name -> default
    make: object  # Callable[[dict], Study]

    def build(self, params: Optional[dict] = None) -> Study:
        p = {**self.params, **(params or {})}
        return self.make(p)  # type: ignore[operator]


STUDY_TYPES = {
    "EMA": StudyType("Moving Average Exponential", "Moving averages", {"length": 20}, lambda p: EMA(int(p["length"]))),
    "SMA": StudyType("Moving Average", "Moving averages", {"length": 20}, lambda p: SMA(int(p["length"]))),
    "BB": StudyType("Bollinger Bands", "Bands and channels", {"length": 20, "mult": 2.0},
                    lambda p: Bollinger(int(p["length"]), float(p["mult"]))),
    "VWAP": StudyType("VWAP", "Volume", {}, lambda p: VWAP()),
    "RSI": StudyType("Relative Strength Index", "Oscillators", {"length": 14}, lambda p: RSI(int(p["length"]))),
    "Volume": StudyType("Volume", "Volume", {}, lambda p: Volume()),
}
"""What UIs offer in their indicators dialog. An instance is {id, type, params, color, visible}."""


def study_label(type_: str, params: Optional[dict] = None) -> str:
    """Short legend label: 'EMA 20', 'BB 20 2', 'RSI 14', 'VWAP'."""
    st = STUDY_TYPES[type_]
    p = {**st.params, **(params or {})}
    vals = " ".join(f"{v:g}" if isinstance(v, float) else str(v) for v in p.values())
    return f"{type_} {vals}".strip()


# ----------------------------------------------------------------------------- quotes (watchlists)

def quotes(ticks: Table, *, by: str = "Sym", time_col: str = "Timestamp", price_col: str = "Price") -> Table:
    """One row per symbol: Last, the day's first price (Open), Chg and ChgPct from it, Updated.
    Live and small: what a watchlist subscribes to."""
    return (
        ticks.update_view(f"Day = lowerBin({time_col}, DAY)")
        .agg_by([agg.last(f"Last={price_col}"), agg.first(f"Open={price_col}"), agg.last(f"Updated={time_col}")], by=[by, "Day"])
        .last_by(by)
        .update_view(["Chg = Last - Open", "ChgPct = Open == 0 ? NULL_DOUBLE : 100.0 * Chg / Open"])
        .view([by, "Last", "Chg", "ChgPct", "Updated"])
        .sort(by)
    )
