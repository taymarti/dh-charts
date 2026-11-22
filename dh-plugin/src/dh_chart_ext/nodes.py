"""
Chart nodes on demand: the tables behind a chart, built when a client first asks for them and shared by
every client asking for the same thing (cache.NodeCache).

    nodes = ChartNodes(source)                              # once, in the app (ChartSource.nodes does it)
    key, t = nodes.chart("NQ", "2m", ["EMA_20", "RSI_14"])  # one symbol's bars with the studies' columns
    ...
    nodes.release(key)                                      # once per chart() / bars()

Requests are made canonical before they become keys, so equal requests share one node:
  resolutions by length in seconds ("2m" == "120s" == "PT2M"), studies by their key with the list sorted
  ("EMA(20)" given as "EMA_20" or {"type": "EMA", "params": {"length": 20}}), expressions without spaces.

The layers, each holding its parent:
  ("bars", sym, secs)            a standard resolution: the shared all-symbol bars, filtered to the symbol;
                                 any other: rolled up from the largest standard resolution that divides it
                                 (2m from 1m bars), or built from the symbol's ticks
  ("ticks", expr)                a spread's or ratio's ticks (data.spread_ticks)
  ("chart", sym, secs, studies)  the bars with the studies' columns (update_by on the bars node)

Columns of a bars or chart node: Timestamp Open High Low Close Volume Updated, then the study columns.
"""
from __future__ import annotations

import re
from typing import Iterable, Optional, Sequence, Union

from deephaven import agg
from deephaven.table import Table

from .cache import NodeCache
from .data import RESOLUTIONS, STUDY_TYPES, Study, bars, for_symbol, is_expression, parse_expression, resolution_seconds, \
    spread_ticks, with_studies

MAX_STUDIES = 8
MIN_SECONDS, MAX_SECONDS = 1, 86400
_SHORT = re.compile(r"^(\d+)\s*([smhd])$", re.I)
_UNIT = {"s": 1, "m": 60, "h": 3600, "d": 86400}

StudySpec = Union[str, dict, Study]


def resolution_secs(res: Union[str, int]) -> int:
    """'2m', '120s', 'PT2M', 120 -> 120. Raises ValueError outside 1 s .. 1 day."""
    if isinstance(res, int):
        secs = res
    elif (m := _SHORT.match(str(res).strip())) is not None:
        secs = int(m.group(1)) * _UNIT[m.group(2).lower()]
    else:
        secs = resolution_seconds(str(res))
    if not MIN_SECONDS <= secs <= MAX_SECONDS:
        raise ValueError(f"resolution {res!r} is outside 1s..1d")
    return secs


def resolution_name(secs: int) -> str:
    for unit, n in (("d", 86400), ("h", 3600), ("m", 60)):
        if secs % n == 0:
            return f"{secs // n}{unit}"
    return f"{secs}s"


def study_of(spec: StudySpec) -> Study:
    """A Study from 'EMA_20', 'BB_20_2', 'VWAP' or {'type': 'EMA', 'params': {'length': 20}} (a Study as is)."""
    if isinstance(spec, Study):
        return spec
    if isinstance(spec, dict):
        type_, params = str(spec.get("type")), dict(spec.get("params") or {})
    else:
        type_, *vals = str(spec).split("_")
        if type_ not in STUDY_TYPES:
            raise ValueError(f"unknown study {spec!r}")
        params = dict(zip(STUDY_TYPES[type_].params, vals))
    if type_ not in STUDY_TYPES:
        raise ValueError(f"unknown study type {type_!r}")
    defaults = STUDY_TYPES[type_].params
    clean = {}
    for name, d in defaults.items():
        try:
            v = type(d)(float(params.get(name, d)))
        except (TypeError, ValueError):
            raise ValueError(f"bad {name!r} for {type_}: {params.get(name)!r}") from None
        if isinstance(d, int) and not 1 <= v <= 1000:
            raise ValueError(f"{type_} {name} must be 1..1000")
        if isinstance(d, float) and not 0 < v <= 10:
            raise ValueError(f"{type_} {name} must be in (0, 10]")
        clean[name] = v
    return STUDY_TYPES[type_].build(clean)


def rollup_bars(t: Table, secs: int) -> Table:
    """Bars of a finer resolution rolled up to `secs` (one symbol, no Sym column)."""
    return (
        t.update_view(f"Bar = lowerBin(Timestamp, {secs}L * SECOND)")
        .agg_by([agg.first("Open"), agg.max_("High"), agg.min_("Low"), agg.last("Close"), agg.sum_("Volume"),
                 agg.last("Updated")], by="Bar")
        .rename_columns("Timestamp=Bar")
        .view(["Timestamp", "Open", "High", "Low", "Close", "Volume", "Updated"])
    )


class ChartNodes:
    """Builds and shares the tables behind charts, for one ChartSource (workspace.ChartSource)."""

    def __init__(self, source, cache: Optional[NodeCache] = None):
        self.source = source
        self.cache = cache or NodeCache()
        self._standard = {resolution_seconds(r): r for r in source.resolutions}

    # ----------------------------------------------------------------- requests

    def symbols(self) -> list[str]:
        from deephaven import numpy as dhnp

        snap = self.source.symbols_table.snapshot()
        return sorted(str(s) for s in dhnp.to_numpy(snap, cols=[self.source.by]).ravel())

    def instrument(self, sym: str, symbols: Optional[Sequence[str]] = None) -> str:
        """The canonical instrument: a known symbol, or an expression over known symbols without spaces."""
        sym = str(sym).strip()
        known = symbols if symbols is not None else self.symbols()
        if is_expression(sym):
            parse_expression(sym, known)  # raises ValueError when unreadable or with unknown symbols
            return re.sub(r"\s+", "", sym)
        if sym not in known:
            raise ValueError(f"unknown symbol {sym!r}")
        return sym

    def bars(self, sym: str, res: Union[str, int], *, symbols: Optional[Sequence[str]] = None) -> tuple[tuple, Table]:
        """(key, table): one instrument's bars at `res`, shared. Release the key when done."""
        sym = self.instrument(sym, symbols)
        secs = resolution_secs(res)
        key = ("bars", sym, secs)
        return key, self.cache.acquire(key, lambda deps: self._build_bars(sym, secs, deps, symbols))

    def chart(self, sym: str, res: Union[str, int], studies: Iterable[StudySpec] = (), *,
              symbols: Optional[Sequence[str]] = None) -> tuple[tuple, Table, list[str]]:
        """(key, table, study columns): one instrument's bars with the studies' columns, shared.
        Without studies it is the bars node itself. Release the key when done."""
        sym = self.instrument(sym, symbols)
        secs = resolution_secs(res)
        objs = self.canonical_studies(studies)
        keys = tuple(objs)
        columns = [c for k in keys for c in objs[k].columns()]
        if not keys:
            key, t = self.bars(sym, secs, symbols=symbols)
            return key, t, []
        key = ("chart", sym, secs, keys)

        def build(deps):
            pkey, parent = self.bars(sym, secs, symbols=symbols)
            deps.append(pkey)
            return with_studies(parent, [objs[k] for k in keys], by=None)

        return key, self.cache.acquire(key, build), columns

    @staticmethod
    def canonical_studies(studies: Iterable[StudySpec]) -> dict[str, Study]:
        """{key: Study} sorted by key, duplicates and Volume (bars carry it) left out."""
        objs = {}
        for spec in studies:
            s = study_of(spec)
            if s.key == "Volume" or s.columns() == ["Volume"]:
                continue
            objs[s.key] = s
        if len(objs) > MAX_STUDIES:
            raise ValueError(f"at most {MAX_STUDIES} studies per chart")
        return dict(sorted(objs.items()))

    def release(self, key: tuple) -> None:
        self.cache.release(key)

    # ----------------------------------------------------------------- builds

    def _build_bars(self, sym: str, secs: int, deps: list, symbols) -> Table:
        src = self.source
        if is_expression(sym):
            tkey = ("ticks", sym)
            ticks = self.cache.acquire(tkey, lambda _d: spread_ticks(src.ticks, sym, symbols or self.symbols(), by=src.by))
            deps.append(tkey)
            return bars(ticks, f"PT{secs}S", by=src.by, size_col=None).drop_columns(src.by)
        if secs in self._standard:
            return for_symbol(src.bars(self._standard[secs]), sym, by=src.by)
        finer = [s for s in self._standard if s < secs and secs % s == 0]
        if finer:
            pkey, parent = self.bars(sym, max(finer), symbols=symbols)
            deps.append(pkey)
            return rollup_bars(parent, secs)
        return bars(for_symbol(src.ticks, sym, by=src.by), f"PT{secs}S", by=None)


def resolution_options(extra: Sequence[str] = ("2m", "15m", "30m", "1h")) -> list[str]:
    """Resolutions a toolbar can offer when charts come from nodes: the standard ones plus `extra`."""
    std = list(RESOLUTIONS)
    return sorted({*std, *extra} - {"1d"}, key=resolution_secs)
