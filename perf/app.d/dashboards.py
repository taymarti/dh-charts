"""
The deephaven.ui side of the benchmark: the same 16 charts, drawn by each server-side charting plugin.

  dash_plotly         ui.dashboard, 4x4 panels of dx.line            (plotly-express, the status quo)
  dash_tvl            ui.dashboard, 4x4 panels of tvl.line           (TradingView Lightweight plugin)
  dash_plotly_candle  ui.dashboard, 4x4 panels of dx.candlestick     (1-minute bars)
  dash_tvl_candle     ui.dashboard, 4x4 panels of tvl.candlestick    (1-minute bars)
  dash_plotly_svg     dx.line with render_mode="svg"                (no WebGL)
  dash_plotly_1s      dx.candlestick of 1-second bars
  dash_tvl_1s         tvl.candlestick of 1-second bars

Open one at http://localhost:<port>/iframe/widget/?name=<field>, or from the IDE's Panels menu.
"""
import deephaven.plot.express as dx
import deephaven.plot.tradingview_lightweight as tvl
from deephaven import ui

_COLS = 4


def _dashboard(make):
    panels = [ui.panel(make(s), title=s) for s in SYMS]  # noqa: F821  (SYMS comes from feeds.py)
    rows = [ui.row(*panels[i:i + _COLS]) for i in range(0, len(panels), _COLS)]
    return ui.dashboard(ui.column(*rows))


dash_plotly = _dashboard(lambda s: dx.line(TICKS[s], x="Timestamp", y="Price"))  # noqa: F821
dash_tvl = _dashboard(lambda s: tvl.line(TICKS[s], timestamp="Timestamp", value="Price"))  # noqa: F821
dash_plotly_candle = _dashboard(lambda s: dx.candlestick(
    BARS[s], x="Timestamp", open="Open", high="High", low="Low", close="Close"))  # noqa: F821
dash_tvl_candle = _dashboard(lambda s: tvl.candlestick(BARS[s]))  # noqa: F821

# dx.line's default render_mode is "webgl": one WebGL context per chart
dash_plotly_svg = _dashboard(lambda s: dx.line(TICKS[s], x="Timestamp", y="Price", render_mode="svg"))  # noqa: F821
# 1-second bars
dash_plotly_1s = _dashboard(lambda s: dx.candlestick(
    BARS1S[s], x="Timestamp", open="Open", high="High", low="Low", close="Close"))  # noqa: F821
dash_tvl_1s = _dashboard(lambda s: tvl.candlestick(BARS1S[s]))  # noqa: F821

# Standalone chart objects (not inside a dashboard), for other clients to fetch by name and draw with
# the plugin's own component: tvl1s_<SYM> (1-second candles) and tvlt_<SYM> (tick lines).
for _s in SYMS:  # noqa: F821
    globals()[f"tvl1s_{_s}"] = tvl.candlestick(BARS1S[_s])  # noqa: F821
    globals()[f"tvlt_{_s}"] = tvl.line(TICKS[_s], timestamp="Timestamp", value="Price")  # noqa: F821
