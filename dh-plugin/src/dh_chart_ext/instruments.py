"""
Instrument metadata: what front ends need to display an instrument correctly. For now the tick size
(the price increment), which sets a chart's decimals and price steps; later contract months, rolls,
multipliers and currencies.

    tick_for("ES")         0.25
    tick_for("ES-NQ")      0.25   (a spread or ratio: the finest leg tick; a ratio has none)
    instruments_table()    Sym, TickSize, Name: publish it for JS clients

The demo's symbols get their real exchange tick sizes (the synthetic prices are not on these grids,
so charts round them for display).
"""
from __future__ import annotations

import re
from typing import Optional

INSTRUMENTS = {
    "ES": (0.25, "E-mini S&P 500"),
    "NQ": (0.25, "E-mini Nasdaq-100"),
    "RTY": (0.1, "E-mini Russell 2000"),
    "YM": (1.0, "E-mini Dow"),
    "ZN": (1 / 64, "10-Year T-Note"),
    "ZB": (1 / 32, "30-Year T-Bond"),
    "ZF": (1 / 128, "5-Year T-Note"),
    "ZT": (1 / 256, "2-Year T-Note"),
    "CL": (0.01, "Crude Oil"),
    "NG": (0.001, "Natural Gas"),
    "GC": (0.1, "Gold"),
    "SI": (0.005, "Silver"),
    "6E": (0.00005, "Euro FX"),
    "6J": (0.0000005, "Japanese Yen"),
    "UST10": (1 / 128, "US 10-Year cash"),
    "BUND": (0.01, "Euro-Bund"),
}
"""Symbol -> (tick size, name)."""

_SYM = re.compile(r"\d+[A-Za-z][A-Za-z0-9_.]*|[A-Za-z_][A-Za-z0-9_.]*")


def tick_for(sym: str) -> Optional[float]:
    """The tick size of a symbol; for a spread (+, -) the finest leg tick; None for ratios and unknowns."""
    if sym in INSTRUMENTS:
        return INSTRUMENTS[sym][0]
    if any(c in sym for c in "*/()"):
        return None  # a ratio or scaled expression has no exchange tick
    legs = [s for s in _SYM.findall(sym) if s in INSTRUMENTS]
    return min(INSTRUMENTS[s][0] for s in legs) if legs else None


def instruments_table():
    """One row per known symbol: Sym, TickSize, Name."""
    from deephaven import new_table
    from deephaven.column import double_col, string_col

    syms = sorted(INSTRUMENTS)
    return new_table([string_col("Sym", syms), double_col("TickSize", [INSTRUMENTS[s][0] for s in syms]),
                      string_col("Name", [INSTRUMENTS[s][1] for s in syms])])
