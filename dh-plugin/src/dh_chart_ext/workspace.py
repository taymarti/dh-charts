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
from .data import STANDARD_RESOLUTIONS, STUDIES, bars, for_symbol, in_range, standard_set
from .store import annotations_element

RANGES = {"5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "All": None}
CHART_TYPES = {"candle": "Candles", "bar": "Bars", "line": "Line", "area": "Area"}
SCALES = {"normal": "Lin", "log": "Log", "percent": "%"}


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


def _first(selection, default):
    """deephaven.ui selections arrive as a set of keys (or 'all'); take the one selected key."""
    if isinstance(selection, str):
        return selection if selection != "all" else default
    return next(iter(selection), default)


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
):
    """Toolbar + chart. The arguments are the initial selections.

    annotations: the app's annotation table (store.annotation_table); with it, price lines and later
    drawings persist per symbol, per `user` (None: a per-browser id), and survive toolbar changes.
    The chart key is the symbol (the price series' title), so a line drawn on ES shows on every ES chart."""
    symbols = [str(s) for s in ui.use_column_data(source.symbols_table)] if source.symbols_table is not None else []
    sym, set_sym = ui.use_state(symbol)
    res, set_res = ui.use_state(resolution)
    rng, set_rng = ui.use_state(range_)
    ctype, set_ctype = ui.use_state(chart_type)
    chosen, set_chosen = ui.use_state(tuple(studies))
    scl, set_scl = ui.use_state(scale)
    sym = sym or (sorted(symbols)[0] if symbols else None)

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

    def single(items: dict, value, setter, label):
        return ui.action_group(
            *[ui.item(text, key=key) for key, text in items.items()],
            selection_mode="single", disallow_empty_selection=True, selected_keys=[value],
            on_selection_change=lambda s: setter(_first(s, value)), density="compact", aria_label=label,
        )

    res_items = {"tick": "Tick", **{r: r for r in source.resolutions}}
    toolbar = ui.flex(
        ui.picker(*[ui.item(s, key=s) for s in sorted(symbols)], selected_key=sym, on_selection_change=set_sym,
                  aria_label="Symbol", width="size-1600", is_quiet=True),
        single(res_items, res, set_res, "Resolution"),
        single({k: k for k in RANGES}, rng, set_rng, "Range"),
        single(CHART_TYPES, ctype, set_ctype, "Chart type"),
        ui.action_group(
            *[ui.item(k, key=k) for k in STUDIES],
            selection_mode="multiple", selected_keys=list(chosen),
            on_selection_change=lambda s: set_chosen(tuple(STUDIES) if s == "all" else tuple(k for k in STUDIES if k in s)),
            density="compact", aria_label="Studies", is_disabled=res == "tick",
        ),
        single(SCALES, scl, set_scl, "Scale"),
        # a toolbar keeps its natural height: no growing, and wrapped rows packed at the top
        gap="size-150", wrap=True, align_items="center", align_content="start", flex_grow=0, flex_shrink=0,
    )
    parts = [toolbar, ui.view(chart, flex_grow=1, min_height="size-3000")]
    if annotations is not None:
        parts.append(annotations_element(annotations, user))  # draws nothing; feeds the chart extensions
    return ui.flex(*parts, direction="column", gap="size-100", flex_grow=1, height="100%")
