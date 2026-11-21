"""
L2, the workspace: a deephaven.ui component with a TradingView-style toolbar over one to four L1
charts (a multi-chart layout), each with a legend of its studies, and an optional watchlist. For
deephaven.ui front ends; React front ends render it as a deephaven.ui element (front-end group B), or
build their own on L0 (group C).

    source = ChartSource(ticks)                 # once, at app start: shared bar and quote tables
    globals().update(source.standard_tables())  # optional: publish L0's standard set for JS clients
    ws = chart_workspace(source)                # a deephaven.ui element; put it in a panel/dashboard

What runs where. Every setting (symbol, interval, studies and their parameters, layout, sync) is
Python state: a toolbar, legend or watchlist action is one call to a Python callback, which updates
the state; the panes whose settings changed rebuild their chart (filter the shared bars, add the
studies with update_by, compose a TvlChart), and Deephaven's plugin subscribes and draws it. Ticks
never go through Python: they stream to the browser over Barrage. Crosshair and time sync, drawings,
price lines and the legend's values are browser-only (the frame says which charts sync).

The state is saved per (`layout`, `user`) when an annotations table is given, and restored on open.
"""
from __future__ import annotations

import json
import uuid
from typing import Optional, Sequence

from deephaven import ui
from deephaven.table import Table
from deephaven.time import dh_now

from .charts import STUDY_COLORS, price_chart, tick_chart
from .data import (
    STANDARD_RESOLUTIONS, STUDY_TYPES, bars, for_symbol, in_range, quotes, resolution_seconds, standard_set, study_label,
)
from .store import annotations_element, load_settings, save_settings

RANGES = {"5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "All": None}
CHART_TYPES = {"candle": "Candles", "bar": "Bars", "line": "Line", "area": "Area"}
LAYOUTS = {"1": ("1 chart", 1), "2h": ("2 charts, side by side", 2), "2v": ("2 charts, stacked", 2),
           "3h": ("3 charts", 3), "4": ("4 charts", 4)}
DEFAULT_SYNC = {"symbol": False, "interval": False, "crosshair": True, "time": False}


class ChartSource:
    """A ticks table and what is built from it once and shared by every workspace and client:
    bars at the standard resolutions, the symbols seen so far, and a quotes table for watchlists.

    Build it in the app script (not inside a component), so its tables live as long as the app."""

    def __init__(self, ticks: Table, resolutions: Sequence[str] = STANDARD_RESOLUTIONS, *, by: str = "Sym"):
        self.ticks = ticks
        self.by = by
        self.resolutions = tuple(resolutions)
        self._bars = {r: bars(ticks, r, by=by) for r in self.resolutions}
        self._symbols = ticks.select_distinct(by)
        self.quotes = quotes(ticks, by=by)

    def bars(self, resolution: str) -> Table:
        return self._bars[resolution]

    @property
    def symbols_table(self) -> Table:
        """One row per symbol seen so far (ticking)."""
        return self._symbols

    def standard_tables(self) -> dict[str, Table]:
        """L0's standard set (bars_<res> with every standard study) for clients that only filter,
        and `quotes` for their watchlists."""
        return {**standard_set(self.ticks, self.resolutions, by=self.by), "quotes": self.quotes}


# ----------------------------------------------------------------------------- elements

def toolbar_element(value: dict, options: dict, on_change):
    """The TradingView-style toolbar (@acme/chart-react's ChartToolbar, rendered by the dh-chart-ext JS
    plugin as `acme.chart.Toolbar`). Controlled: `value` and `options` use the component's camelCase
    keys; `on_change(patch)` gets the changed keys."""
    from deephaven.ui.elements import BaseElement

    return BaseElement("acme.chart.Toolbar", value=value, options=options, on_change=on_change)


def frame_element(chart, *, title: str, studies: list, study_types: dict, on_study_change, multi: bool, active: bool,
                  on_activate, sync_crosshair: str, sync_time: str):
    """One chart with its legend (`acme.chart.Frame`): study rows report show/hide, settings and
    remove through `on_study_change(patch)`; in a multi-chart layout a click calls `on_activate()`."""
    from deephaven.ui.elements import BaseElement

    return BaseElement(
        "acme.chart.Frame", chart, title=title, studies=studies, study_types=study_types, on_study_change=on_study_change,
        multi=multi, active=active, on_activate=on_activate, sync_crosshair=sync_crosshair, sync_time=sync_time,
    )


def watchlist_element(table: Table, *, value: Optional[str], on_select, title: str = "Watchlist", symbol_column: str = "Sym"):
    """The watchlist (`acme.chart.Watchlist`) over a quotes table (data.quotes); a click calls on_select(symbol)."""
    from deephaven.ui.elements import BaseElement

    return BaseElement("acme.chart.Watchlist", table=table, value=value, on_select=on_select, title=title,
                       symbol_column=symbol_column)


# ----------------------------------------------------------------------------- state

def new_study(type_: str, params: Optional[dict] = None, color: Optional[str] = None, visible: bool = True) -> dict:
    """A study instance: {id, type, params, color, visible}. Several of one type can coexist."""
    st = STUDY_TYPES[type_]
    return {"id": uuid.uuid4().hex[:8], "type": type_, "params": {**st.params, **(params or {})}, "color": color,
            "visible": visible}


def _next_color(studies: list) -> str:
    used = {s.get("color") for s in studies}
    return next((c for c in STUDY_COLORS if c not in used), STUDY_COLORS[len(studies) % len(STUDY_COLORS)])


def add_study(studies: list, type_: str, params: Optional[dict] = None) -> list:
    # Volume keeps its own grey (None); lines get the next unused house color
    color = None if type_ == "Volume" else _next_color(studies)
    return [*studies, new_study(type_, params, color)]


def studies_from_keys(keys: Sequence[str]) -> list:
    """Instances from standard keys ("EMA_20", "BB_20_2", "Volume"): the arguments' and v1 settings' form."""
    out: list = []
    for k in keys:
        t, *vals = str(k).split("_")
        if t not in STUDY_TYPES:
            continue
        defaults = STUDY_TYPES[t].params
        params = {name: type(defaults[name])(float(v)) for name, v in zip(defaults, vals)}
        out = add_study(out, t, params)
    return out


def _cast_params(type_: str, params: dict) -> dict:
    defaults = STUDY_TYPES[type_].params
    out = {}
    for k, d in defaults.items():
        try:
            v = type(d)(float(params.get(k, d)))
        except (TypeError, ValueError):
            v = d
        out[k] = max(v, 1) if isinstance(d, int) else (v if v > 0 else d)
    return out


def new_pane(symbol, resolution, range_, chart_type, studies, scale) -> dict:
    return {"symbol": symbol, "resolution": resolution, "range": range_, "chartType": chart_type,
            "studies": studies, "scale": scale}


def restore_state(saved: dict, default_pane: dict, watchlist: bool) -> dict:
    """The workspace state from saved settings (v2; v1 was one pane with study keys), else defaults."""
    if saved.get("version") == 2 and saved.get("panes"):
        return {
            "version": 2,
            "layout": saved.get("layout") if saved.get("layout") in LAYOUTS else "1",
            "active": int(saved.get("active", 0)),
            "sync": {**DEFAULT_SYNC, **(saved.get("sync") or {})},
            "watchlist": bool(saved.get("watchlist", watchlist)),
            "panes": [{**default_pane, **p, "studies": [s for s in p.get("studies", []) if s.get("type") in STUDY_TYPES]}
                      for p in saved["panes"]],
        }
    pane = dict(default_pane)
    if saved:  # v1
        pane.update({k2: saved[k1] for k1, k2 in [("symbol", "symbol"), ("resolution", "resolution"), ("range", "range"),
                                                  ("chart_type", "chartType"), ("scale", "scale")] if k1 in saved})
        if "studies" in saved:
            pane["studies"] = studies_from_keys(saved["studies"])
    return {"version": 2, "layout": "1", "active": 0, "sync": dict(DEFAULT_SYNC), "watchlist": watchlist, "panes": [pane]}


def _pane_patch(pane: dict, patch: dict) -> dict:
    p = dict(pane)
    for k in ("symbol", "resolution", "range", "chartType", "scale"):
        if k in patch:
            p[k] = patch[k]
    if patch.get("addStudy") in STUDY_TYPES:
        p["studies"] = add_study(p["studies"], patch["addStudy"])
    return p


def apply_toolbar(state: dict, patch: dict, symbols: Sequence[str]) -> dict:
    """The state after a toolbar (or watchlist) change: pane settings go to the active pane, or to
    every pane for symbol/interval when synced; layout, sync and watchlist are workspace settings."""
    s = dict(state)
    panes = list(s["panes"])
    n = LAYOUTS[s["layout"]][1]
    active = min(s["active"], n - 1)
    sync = s["sync"]
    for i in range(len(panes)):
        mine = {k: v for k, v in patch.items() if i == active or (k == "symbol" and sync["symbol"]) or
                (k == "resolution" and sync["interval"])}
        if mine:
            panes[i] = _pane_patch(panes[i], mine)
    if "layout" in patch and patch["layout"] in LAYOUTS:
        s["layout"] = patch["layout"]
        want = LAYOUTS[s["layout"]][1]
        base = panes[active]
        while len(panes) < want:
            # a new pane copies the active one, on the next symbol not yet shown (unless symbols are synced)
            shown = {p["symbol"] for p in panes}
            sym = base["symbol"] if sync["symbol"] else next((x for x in symbols if x not in shown), base["symbol"])
            panes.append({**base, "symbol": sym, "studies": [{**st, "id": uuid.uuid4().hex[:8]} for st in base["studies"]]})
        s["active"] = min(active, want - 1)
    if "sync" in patch:
        s["sync"] = {**sync, **{k: bool(v) for k, v in patch["sync"].items() if k in DEFAULT_SYNC}}
        if s["sync"]["symbol"] and not sync["symbol"]:  # turning symbol sync on lines the panes up
            panes = [{**p, "symbol": panes[active]["symbol"]} for p in panes]
        if s["sync"]["interval"] and not sync["interval"]:
            panes = [{**p, "resolution": panes[active]["resolution"]} for p in panes]
    if "watchlist" in patch:
        s["watchlist"] = bool(patch["watchlist"])
    s["panes"] = panes
    return s


def apply_study_patch(pane: dict, patch: dict) -> dict:
    """The pane after a legend action: {id, visible} / {id, remove} / {id, params, color}."""
    out = []
    for st in pane["studies"]:
        if st["id"] != patch.get("id"):
            out.append(st)
            continue
        if patch.get("remove"):
            continue
        st = dict(st)
        if "visible" in patch:
            st["visible"] = bool(patch["visible"])
        if patch.get("params"):
            st["params"] = _cast_params(st["type"], patch["params"])
        if patch.get("color"):
            st["color"] = str(patch["color"])
        out.append(st)
    return {**pane, "studies": out}


def _interval_group(resolution: str) -> str:
    if resolution == "tick":
        return "Ticks"
    secs = resolution_seconds(resolution)
    return "Seconds" if secs < 60 else "Minutes" if secs < 3600 else "Hours" if secs < 86400 else "Days"


# ----------------------------------------------------------------------------- components

@ui.component
def chart_pane(source: ChartSource, pane: dict, index: int, active: bool, multi: bool, sync_crosshair: str,
               sync_time: str, on_activate, on_pane):
    """One chart of the workspace, with its legend. Rebuilds only when its own settings change."""
    sym, res, rng, ctype, scl = pane["symbol"], pane["resolution"], pane["range"], pane["chartType"], pane["scale"]
    studies_key = json.dumps(pane["studies"], sort_keys=True)

    # the range start is fixed when the selection is made (a rolling window would re-filter every cycle)
    since = ui.use_memo(lambda: None if RANGES.get(rng) is None else dh_now().minusSeconds(RANGES[rng]), [rng, sym, res])

    shown = [s for s in pane["studies"] if s.get("visible", True)] if res != "tick" else []

    def build():
        if sym is None:
            return ui.text("Waiting for data...")
        if res == "tick":
            return tick_chart(in_range(for_symbol(source.ticks, sym, by=source.by), since), title=sym, scale=scl)
        return price_chart(
            for_symbol(source.bars(res), sym, by=source.by), since=since, chart_type=ctype, scale=scl, title=sym,
            studies=[STUDY_TYPES[s["type"]].build(s["params"]) for s in shown], colors=[s.get("color") for s in shown],
        )

    chart = ui.use_memo(build, [sym, res, rng, ctype, studies_key, scl, since])

    legend = [] if res == "tick" else [
        {"id": s["id"], "type": s["type"], "params": s["params"], "label": study_label(s["type"], s["params"]),
         "columns": STUDY_TYPES[s["type"]].build(s["params"]).columns(), "color": s.get("color"),
         "visible": s.get("visible", True)}
        for s in pane["studies"]
    ]
    study_types = {k: {"label": t.label, "params": t.params} for k, t in STUDY_TYPES.items()}

    return frame_element(
        ui.view(chart, flex_grow=1, min_height=0, min_width=0),
        title=sym or "", studies=legend, study_types=study_types,
        on_study_change=lambda patch: on_pane(index, lambda p: apply_study_patch(p, patch)),
        multi=multi, active=active, on_activate=lambda: on_activate(index),
        sync_crosshair=sync_crosshair, sync_time=sync_time,
    )


def _grid(layout: str, cells: list):
    def row(*c):
        return ui.flex(*c, direction="row", gap="size-50", flex_grow=1, min_height=0, min_width=0)

    def col(*c):
        return ui.flex(*c, direction="column", gap="size-50", flex_grow=1, min_height=0, min_width=0)

    if layout == "2h":
        return row(*cells[:2])
    if layout == "2v":
        return col(*cells[:2])
    if layout == "3h":
        return row(cells[0], col(cells[1], cells[2]))
    if layout == "4":
        return col(row(cells[0], cells[1]), row(cells[2], cells[3]))
    return col(cells[0])


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
    watchlist: bool = False,
):
    """Toolbar + one to four charts + optional watchlist. The arguments are the first-time defaults
    (`studies` as standard keys: "EMA_20", "BB_20_2", "RSI_14", "Volume", ...).

    annotations: the app's annotation table (store.annotation_table); with it, price lines and
    drawings persist per symbol, per `user` (None: a per-browser id), and the workspace's state
    (layout, panes, studies, sync, watchlist) is saved per (`layout`, `user`) and restored on open.
    Give each panel of a dashboard its own `layout`. With user=None the state is saved under
    "default", shared by every anonymous viewer of that layout (Community has no user identity)."""
    owner = user or "default"
    symbols = sorted(str(s) for s in ui.use_column_data(source.symbols_table)) if source.symbols_table is not None else []

    def initial():
        saved = (load_settings(annotations, layout, owner) if annotations is not None else None) or {}
        return restore_state(saved, new_pane(symbol, resolution, range_, chart_type, studies_from_keys(studies), scale), watchlist)

    state, set_state = ui.use_state(initial)
    wid = ui.use_memo(lambda: uuid.uuid4().hex[:8], [])

    # save the state when it changes (not on the first render: nothing changed yet)
    state_key = json.dumps(state, sort_keys=True)
    mounted = ui.use_ref(False)

    def save():
        if not mounted.current:
            mounted.current = True
            return
        if annotations is not None:
            save_settings(annotations, layout, owner, state)

    ui.use_effect(save, [state_key])

    n = LAYOUTS.get(state["layout"], LAYOUTS["1"])[1]
    multi = n > 1
    active = min(state["active"], n - 1)
    # panes without a symbol yet (first open, no data) take the first symbols
    panes = [p if p["symbol"] else {**p, "symbol": symbols[i % len(symbols)] if symbols else None}
             for i, p in enumerate(state["panes"][:n])]
    cur = panes[active]

    def on_change(patch: dict):
        set_state(lambda s: apply_toolbar(s, patch, symbols))

    def on_pane(i: int, f):
        set_state(lambda s: {**s, "panes": [f(p) if j == i else p for j, p in enumerate(s["panes"])]})

    def on_activate(i: int):
        set_state(lambda s: s if s["active"] == i else {**s, "active": i})

    sync = state["sync"]
    cells = [
        chart_pane(source, p, i, i == active, multi, "page" if sync["crosshair"] else "none",
                   f"ws-{wid}" if sync["time"] else "none", on_activate, on_pane)
        for i, p in enumerate(panes)
    ]

    # the toolbar shows and edits the active pane
    options = {
        "symbols": [{"key": s, "label": s} for s in symbols],
        "resolutions": [{"key": r, "label": "Tick" if r == "tick" else r, "group": _interval_group(r)}
                        for r in ["tick", *source.resolutions]],
        "ranges": [{"key": k, "label": k} for k in RANGES],
        "chartTypes": [{"key": k, "label": v} for k, v in CHART_TYPES.items()],
        "studies": [] if cur["resolution"] == "tick" else [
            {"key": k, "label": t.label, "group": t.group} for k, t in STUDY_TYPES.items()
        ],
        "addStudies": True,
        "scales": True,
        "layouts": [{"key": k, "label": v[0]} for k, v in LAYOUTS.items()],
        "sync": True,
        "watchlist": True,
    }
    value = {
        "symbol": cur["symbol"], "resolution": cur["resolution"], "range": cur["range"], "chartType": cur["chartType"],
        "studies": [s["type"] for s in cur["studies"]], "scale": cur["scale"], "layout": state["layout"],
        "sync": sync, "watchlist": state["watchlist"],
    }

    main = ui.flex(toolbar_element(value, options, on_change), _grid(state["layout"], cells),
                   direction="column", gap="size-0", flex_grow=1, min_width=0, height="100%")
    body = [main]
    if state["watchlist"]:
        body.append(ui.view(watchlist_element(source.quotes, value=cur["symbol"], on_select=lambda s: on_change({"symbol": s})),
                            width="size-3400", flex_shrink=0, height="100%"))
    parts = [ui.flex(*body, direction="row", gap="size-0", flex_grow=1, height="100%", min_height=0)]
    if annotations is not None:
        parts.append(annotations_element(annotations, user))  # draws nothing; feeds the chart extensions
    return ui.flex(*parts, direction="column", gap="size-0", flex_grow=1, height="100%")
