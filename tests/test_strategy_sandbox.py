"""Strategy checks (dh_chart_ext.sandbox) and the CEP stand-in's simulation (cep_sim/runner.py): no server needed."""
import importlib.util
import pathlib
import sys

import pytest

from dh_chart_ext.sandbox import StrategyError, check_strategy, require_valid, restricted_globals

_spec = importlib.util.spec_from_file_location("cep_runner", pathlib.Path(__file__).parents[1] / "cep_sim" / "runner.py")
runner = importlib.util.module_from_spec(_spec)
sys.modules["cep_runner"] = runner  # dataclasses look the module up while it loads
_spec.loader.exec_module(runner)

OK = "def on_bar(ctx, bar):\n    pass\n"


def test_minimal_strategy_passes():
    assert check_strategy(OK) == []


@pytest.mark.parametrize("code, fragment", [
    ("import os\n" + OK, "import os is not allowed"),
    ("from subprocess import run\n" + OK, "from subprocess import is not allowed"),
    ("def on_bar(ctx, bar):\n    open('x')\n", "open is not allowed"),
    ("def on_bar(ctx, bar):\n    eval('1')\n", "eval is not allowed"),
    ("def on_bar(ctx, bar):\n    ().__class__\n", "attribute __class__ is not allowed"),
    ("def on_bar(ctx, bar):\n    ctx._emit('x', {})\n", "attribute _emit is not allowed"),
    ("def on_bar(ctx, bar):\n    getattr(ctx, 'x')\n", "getattr is not allowed"),
    ("class X:\n    pass\n" + OK, "classes are not allowed"),
    ("def on_start(ctx):\n    pass\n", "define on_bar(ctx, bar)"),
    ("def on_bar(ctx, bar)\n    pass\n", "line 1"),
])
def test_rejected(code, fragment):
    problems = check_strategy(code)
    assert any(fragment in p for p in problems), problems


def test_math_import_allowed():
    assert check_strategy("import math\nfrom statistics import mean\n" + OK) == []


def test_require_valid_raises_with_all_problems():
    with pytest.raises(StrategyError) as e:
        require_valid("import os\ndef on_start(ctx): eval('1')\n")
    assert len(e.value.problems) == 3


def test_restricted_builtins_have_no_open_and_limit_imports():
    g = restricted_globals()
    assert "open" not in g["__builtins__"] and "eval" not in g["__builtins__"]
    exec("import math\nx = math.sqrt(4)", g)  # noqa: S102
    assert g["x"] == 2.0
    with pytest.raises(ImportError):
        exec("import os", restricted_globals())  # noqa: S102


def _bars(closes, sym="ES", start=0):
    return [runner.Bar(sym, (start + i) * 60_000_000_000, c, c, c, c, 1.0) for i, c in enumerate(closes)]


def _run(code, bars, **params):
    out = {}
    summary = runner.simulate(code, bars, {"capital": 1000, **params}, lambda k, row: out.setdefault(k, []).append(row))
    return summary, out


def test_simulation_fills_at_the_close_and_tracks_pnl():
    code = """
def on_bar(ctx, bar):
    if bar.close == 10:
        ctx.buy(bar.sym, 2)
    if bar.close == 15:
        ctx.target(bar.sym, 0)
    ctx.plot("close", bar.close, bar.sym)
"""
    summary, out = _run(code, _bars([10, 12, 15, 14]), commission=0.5)
    assert [(t["Side"], t["Qty"], t["Price"]) for t in out["trades"]] == [("BUY", 2, 10), ("SELL", 2, 15)]
    assert out["trades"][1]["RealizedPnl"] == 2 * 5 - 1.0  # minus the closing commission
    assert summary.trades == 2 and summary.bars == 4
    assert summary.pnl == pytest.approx(10 - 2 * 2 * 0.5)  # commission on both legs
    assert [e["Equity"] for e in out["equity"]] == [999.0, 1003.0, 1008.0, 1008.0]
    assert len(out["signals"]) == 4 and out["signals"][0]["Kind"] == "plot"


def test_flip_through_zero_and_drawdown():
    code = """
def on_bar(ctx, bar):
    if bar.close == 10:
        ctx.target(bar.sym, 1)
    elif bar.close == 8:
        ctx.target(bar.sym, -1)
"""
    summary, out = _run(code, _bars([10, 8, 9]))
    assert [t["Qty"] for t in out["trades"]] == [1, 2]  # long 1, then sell 2: short 1
    assert out["trades"][1]["RealizedPnl"] == -2
    assert summary.max_drawdown == pytest.approx(3 / 1000)  # 1000, 998 after the flip, then 997 short


def test_bars_at_one_time_give_one_equity_row():
    code = "def on_bar(ctx, bar):\n    pass\n"
    bars = sorted(_bars([1, 2], "ES") + _bars([3, 4], "NQ"), key=lambda b: (b.time, b.sym))
    summary, out = _run(code, bars)
    assert summary.bars == 4 and len(out["equity"]) == 2


def test_strategy_errors_surface():
    with pytest.raises(ZeroDivisionError):
        _run("def on_bar(ctx, bar):\n    1 / 0\n", _bars([1]))
    with pytest.raises(StrategyError):
        _run("import os\n" + OK, _bars([1]))
    with pytest.raises(ValueError, match="no price for NQ"):
        _run("def on_bar(ctx, bar):\n    ctx.buy('NQ')\n", _bars([1]))
