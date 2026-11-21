"""
L2, the workspace: a deephaven.ui component with a toolbar (symbol, resolution, range, chart type,
studies, scale) over an L1 chart. For deephaven.ui front ends; React front ends can render it with
WidgetView as a deephaven.ui element (to be verified), or build their own toolbar on L0/L1.

    source = ChartSource(ticks)                 # once, at app start: shared bar tables
    globals().update(source.standard_tables())  # optional: publish L0's standard set for JS clients
    ws = chart_workspace(source)                # a deephaven.ui element; put it in a panel/dashboard

Each toolbar change rebuilds the chart from the source's tables (a new TvlChart, so Deephaven's
plugin re-subscribes and redraws). Bars at the standard resolutions are built once per source and
shared by every workspace; filtering to one symbol and adding studies happen per chart.
"""
from __future__ import annotations

from typing import Optional, Sequence

from deephaven import ui
from deephaven.table import Table
from deephaven.time import dh_now

from .charts import price_chart, tick_chart
from .data import STANDARD_RESOLUTIONS, STUDIES, bars, for_symbol, in_range, resolution_seconds, standard_set
from .store import annotations_element, load_settings, save_settings

RANGES = {"5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "All": None}
CHART_TYPES = {"candle": "Candles", "bar": "Bars", "line": "Line", "area": "Area"}
# how the toolbar's indicators dialog lists the standard studies: label and category
STUDY_INFO = {
    "EMA_20": ("EMA 20", "Moving averages"), "EMA_50": ("EMA 50", "Moving averages"), "SMA_20": ("SMA 20", "Moving averages"),
    "BB_20_2": ("Bollinger Bands (20, 2)", "Bands and channels"), "VWAP": ("VWAP", "Volume"), "Volume": ("Volume", "Volume"),
    "RSI_14": ("RSI 14", "Oscillators"),
}


class ChartSource:
    """A ticks table and the bars built from it, shared by every workspace and client.

    Build it in the app script (not inside a component), so its tables live as long as the app."""

    def __init__(self, ticks: Table, resolutions: Sequence[str] = STANDARD_RESOLUTIONS, *, by: str = "Sym"):
        self.ticks = ticks
        self.by = by
        self.resolutions = tuple(resolutions)
        self._bars = {r: bars(ticks, r, by=by) for r in self.resolutions}
        self._symbols = ticks.select_distinct(by)

    def bars(self, resolution: str) -> Table:
        return self._bars[resolution]

    @property
    def symbols_table(self) -> Table:
        """One row per symbol seen so far (ticking)."""
        return self._symbols

    def standard_tables(self) -> dict[str, Table]:
        """L0's standard set (bars_<res> with every standard study) for clients that only filter."""
        return standard_set(self.ticks, self.resolutions, by=self.by)


def _interval_group(resolution: str) -> str:
    if resolution == "tick":
        return "Ticks"
    secs = resolution_seconds(resolution)
    return "Seconds" if secs < 60 else "Minutes" if secs < 3600 else "Hours" if secs < 86400 else "Days"


def toolbar_element(value: dict, options: dict, on_change):
    """The TradingView-style toolbar (@acme/chart-react's ChartToolbar, rendered by the dh-chart-ext JS
    plugin as `acme.chart.Toolbar`). Controlled: `value` and `options` use the component's camelCase
    keys (symbol, resolution, range, chartType, studies, scale); `on_change(patch)` gets the changed keys."""
    from deephaven.ui.elements import BaseElement

    return BaseElement("acme.chart.Toolbar", value=value, options=options, on_change=on_change)


@ui.component
def chart_workspace(
    source: ChartSource,
    symbol: Optional[str] = None,
    resolution: str = "1s",
    range_: str = "30m",
    chart_type: str = "candle",
    studies: Sequence[str] = ("Volume",),
    scale: str = "normal",
    annotations: Optional[Table] = None,
    user: Optional[str] = None,
    layout: str = "default",
):
    """Toolbar + chart. The arguments are the initial selections.

    annotations: the app's annotation table (store.annotation_table); with it, price lines and later
    drawings persist per symbol, per `user` (None: a per-browser id), and survive toolbar changes.
    The chart key is the symbol (the price series' title), so a line drawn on ES shows on every ES chart.

    With `annotations`, the toolbar's selections are saved too, per (`layout`, `user`), and restored
    when the workspace opens; the arguments are then only the first-time defaults. Give each panel of a
    dashboard its own `layout`. With user=None, settings are saved under "default", shared by every
    anonymous viewer of that layout (Community has no user identity; price lines still use a per-browser id)."""
    owner = user or "default"
    saved = ui.use_memo(lambda: (load_settings(annotations, layout, owner) if annotations is not None else None) or {}, [])
    symbols = [str(s) for s in ui.use_column_data(source.symbols_table)] if source.symbols_table is not None else []
    sym, set_sym = ui.use_state(saved.get("symbol", symbol))
    res, set_res = ui.use_state(saved.get("resolution", resolution))
    rng, set_rng = ui.use_state(saved.get("range", range_))
    ctype, set_ctype = ui.use_state(saved.get("chart_type", chart_type))
    chosen, set_chosen = ui.use_state(tuple(saved.get("studies", studies)))
    scl, set_scl = ui.use_state(saved.get("scale", scale))
    sym = sym or (sorted(symbols)[0] if symbols else None)

    # save the selections when they change (not on the first render: nothing changed yet)
    mounted = ui.use_ref(False)

    def save():
        if not mounted.current:
            mounted.current = True
            return
        if annotations is not None and sym is not None:
            save_settings(annotations, layout, owner, {
                "symbol": sym, "resolution": res, "range": rng, "chart_type": ctype, "studies": list(chosen), "scale": scl,
            })

    ui.use_effect(save, [sym, res, rng, ctype, chosen, scl])

    # The range start is fixed when the selection is made (a rolling window would re-filter every cycle).
    since = ui.use_memo(lambda: None if RANGES.get(rng) is None else dh_now().minusSeconds(RANGES[rng]), [rng, sym, res])

    def build():
        if sym is None:
            return ui.text("Waiting for data...")
        if res == "tick":
            return tick_chart(in_range(for_symbol(source.ticks, sym, by=source.by), since), title=sym, scale=scl)
        return price_chart(
            for_symbol(source.bars(res), sym, by=source.by), since=since,
            chart_type=ctype, studies=[STUDIES[k] for k in chosen if k in STUDIES], scale=scl, title=sym,
        )

    chart = ui.use_memo(build, [sym, res, rng, ctype, chosen, scl, since])

    # the toolbar: what it offers, what is selected, and how a change comes back (a server round trip)
    options = {
        "symbols": [{"key": s, "label": s} for s in sorted(symbols)],
        "resolutions": [{"key": r, "label": "Tick" if r == "tick" else r, "group": _interval_group(r)}
                        for r in ["tick", *source.resolutions]],
        "ranges": [{"key": k, "label": k} for k in RANGES],
        "chartTypes": [{"key": k, "label": v} for k, v in CHART_TYPES.items()],
        "studies": [] if res == "tick" else [
            {"key": k, "label": STUDY_INFO.get(k, (k, None))[0], "group": STUDY_INFO.get(k, (k, None))[1]} for k in STUDIES
        ],
        "scales": True,
    }
    value = {"symbol": sym, "resolution": res, "range": rng, "chartType": ctype, "studies": list(chosen), "scale": scl}
    setters = {"symbol": set_sym, "resolution": set_res, "range": set_rng, "chartType": set_ctype, "scale": set_scl}

    def on_change(patch: dict):
        for k, set_ in setters.items():
            if k in patch:
                set_(patch[k])
        if "studies" in patch:
            set_chosen(tuple(k for k in STUDIES if k in patch["studies"]))  # keep the standard order

    toolbar = toolbar_element(value, options, on_change)
    parts = [toolbar, ui.view(chart, flex_grow=1, min_height="size-3000")]
    if annotations is not None:
        parts.append(annotations_element(annotations, user))  # draws nothing; feeds the chart extensions
    return ui.flex(*parts, direction="column", gap="size-0", flex_grow=1, height="100%")
