"""
Demo of the charts layers on the benchmark's synthetic feeds (perf/app.d/feeds.py: 16 instruments).

Published fields, one per layer and front end (README.md):
  bars_1s, bars_5s, bars_1m, bars_5m   L0 standard set: every symbol, every standard study
                                       (React apps with their own charts filter these by Sym/Timestamp)
  chart_ES                             L1: one composed chart (React: WidgetView)
  ws                                   L2: one workspace (a deephaven.ui element): toolbar, legend rows, watchlist,
                                       multi-chart layouts (the toolbar's layout menu)
  quotes                               L0: last price and change per symbol (watchlists)
  ws_grid                              L2: a 2x2 dashboard of workspaces
  ws_alice, ws_bob                     L2: the workspace as two named users (sharing demo)
  chart_annotations                    P: saved price lines (and later drawings); app.d/annotations.parquet

Run (dh-chart-ext installed in the server's environment):
  python run_server.py --port 10040 --app-dir app.d
"""
import pathlib

import jpy
from deephaven import ui

# The synthetic feeds (ticks: Timestamp, Sym, Price, Size), run in this scope like an app file.
_app_dir = pathlib.Path(jpy.get_type("java.lang.System").getProperty("deephaven.application.dir"))
exec((_app_dir.parent / "perf" / "app.d" / "feeds.py").read_text(encoding="utf-8"))

from dh_chart_ext.charts import price_chart  # noqa: E402
from dh_chart_ext.data import EMA, RSI, Bollinger, Volume, for_symbol  # noqa: E402
from dh_chart_ext.store import annotation_table  # noqa: E402
from dh_chart_ext.workspace import ChartSource, chart_workspace  # noqa: E402

source = ChartSource(ticks)  # noqa: F821 (from feeds.py)

# L0: the standard set, for every front end (React apps that draw their own charts filter these)
globals().update(source.standard_tables())

# L1: one composed chart
chart_ES = price_chart(
    for_symbol(source.bars("5s"), "ES"),
    studies=[EMA(20), Bollinger(20, 2.0), Volume(), RSI(14)],
    title="ES",
)

# P: one annotations table for every front end, kept on disk across restarts
chart_annotations = annotation_table(path=_app_dir / "annotations.parquet")

# L2: workspaces (user=None: a per-browser id)
ws = chart_workspace(source, symbol="ES", studies=("Volume", "EMA_20"), annotations=chart_annotations, layout="ws", watchlist=True)
ws_alice = chart_workspace(source, symbol="ES", annotations=chart_annotations, user="alice", layout="ws")
ws_bob = chart_workspace(source, symbol="ES", annotations=chart_annotations, user="bob", layout="ws")
ws_grid = ui.dashboard(
    ui.column(
        ui.row(ui.panel(chart_workspace(source, symbol="ES", annotations=chart_annotations, layout="grid-1"), title="ES"), ui.panel(chart_workspace(source, symbol="NQ", annotations=chart_annotations, layout="grid-2"), title="NQ")),
        ui.row(ui.panel(chart_workspace(source, symbol="ZN", annotations=chart_annotations, layout="grid-3"), title="ZN"), ui.panel(chart_workspace(source, symbol="CL", annotations=chart_annotations, layout="grid-4"), title="CL")),
    )
)
