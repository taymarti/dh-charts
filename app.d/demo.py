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
  chart_annotations                    P: saved price lines, drawings, workspace settings; app.d/annotations.parquet
  chart_alerts, alerts_fired           alerts (app.d/alerts.parquet), evaluated by alert_engine; fired ones
  sessions                             trading hours per symbol (JSON spec), for JS clients
  history_ticks                        DEMO_HISTORY_DAYS (default 5) of synthetic ticks before the live feed,
                                       one per DEMO_HISTORY_STEP_S (5) per symbol, busier in regular hours

Run (dh-chart-ext installed in the server's environment):
  python run_server.py --port 10040 --app-dir app.d
"""
import os
import pathlib

import jpy
from deephaven import empty_table, merge, ui
from deephaven.updateby import cum_sum

# The synthetic feeds (ticks: Timestamp, Sym, Price, Size), run in this scope like an app file.
_app_dir = pathlib.Path(jpy.get_type("java.lang.System").getProperty("deephaven.application.dir"))
exec((_app_dir.parent / "perf" / "app.d" / "feeds.py").read_text(encoding="utf-8"))

from dh_chart_ext.alerts import AlertEngine, alert_table, alerts_log  # noqa: E402
from dh_chart_ext.charts import price_chart  # noqa: E402
from dh_chart_ext.data import EMA, RSI, Bollinger, Volume, for_symbol  # noqa: E402
from dh_chart_ext.store import annotation_table  # noqa: E402
from dh_chart_ext.workspace import ChartSource, chart_workspace  # noqa: E402

# History before the live feed, so charts can scroll back days: a random walk per symbol that ends
# where the live feed starts (feeds.py's base price at _start). Steps are larger in regular hours
# (08:30-15:00 Chicago), so sessions show in the data as they do in real markets.
_HIST_DAYS = float(os.environ.get("DEMO_HISTORY_DAYS", "5"))
_HIST_STEP_NS = int(float(os.environ.get("DEMO_HISTORY_STEP_S", "5")) * 1e9)
_HIST_N = int(_HIST_DAYS * 86400e9 / _HIST_STEP_NS)
_hist_end = _start  # noqa: F821 (feeds.py: the first live tick's time)
_hist = (
    empty_table(_HIST_N * _N)  # noqa: F821
    .update([
        "I = ii", "Sym = _SYM_ARR[(int) (I % _N)]", "K = (long) (I / _N)",
        "Timestamp = minus(_hist_end, (_HIST_N - K) * _HIST_STEP_NS)",
        "Mod = minuteOfDay(Timestamp, timeZone(`America/Chicago`), false)",
        "Act = Mod >= 510 && Mod < 900 ? 1.0 : 0.35",
        "Step = (Math.random() - 0.5) * 0.12 * Act", "Size = (int) (1 + Math.random() * 30 * Act)",
    ])
    .update_by(cum_sum("Walk = Step"), by="Sym")
)
history_ticks = (
    _hist.natural_join(_hist.last_by("Sym").view(["Sym", "Final = Walk"]), on="Sym")
    .update_view("Price = 100.0 + 25.0 * (I % _N) + Walk - Final")
    .view(["Timestamp", "Sym", "Price", "Size"])
)
all_ticks = merge([history_ticks, ticks])  # noqa: F821 (in time order: history, then live)

source = ChartSource(all_ticks)

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

# Alerts: stored like annotations, evaluated in the engine (fires with no browser open)
chart_alerts = alert_table(path=_app_dir / "alerts.parquet")
alert_engine = AlertEngine(chart_alerts, source.alert_values())
alerts_fired = alerts_log(chart_alerts)


# L2: workspaces (user=None: a per-browser id)
def _ws(symbol="ES", **kw):
    return chart_workspace(source, symbol=symbol, annotations=chart_annotations, alerts=chart_alerts, **kw)


ws = _ws(studies=("Volume", "EMA_20"), layout="ws", watchlist=True)
ws_alice = _ws(user="alice", layout="ws")
ws_bob = _ws(user="bob", layout="ws")
ws_grid = ui.dashboard(
    ui.column(
        ui.row(ui.panel(_ws("ES", layout="grid-1"), title="ES"), ui.panel(_ws("NQ", layout="grid-2"), title="NQ")),
        ui.row(ui.panel(_ws("ZN", layout="grid-3"), title="ZN"), ui.panel(_ws("CL", layout="grid-4"), title="CL")),
    )
)
