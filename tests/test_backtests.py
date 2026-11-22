"""Backtests through the chart API (dh_chart_ext.backtests + the CEP stand-in): submit, stream, finish."""
import os
import time
import uuid

import pytest


@pytest.fixture
def bt(make_client):
    if os.environ.get("ACME_API_SECRET"):
        pytest.skip("the server verifies tokens")
    c = make_client()
    if c.call("strategy_example")[0].get("code") == "unknown_method":
        pytest.skip("no backtest service on this server")
    c.result("hello", token=f"user:bt-{uuid.uuid4().hex[:8]}")
    return c


def wait_for(c, run_id, timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        run = next(r for r in c.result("backtest_runs")[0] if r["run_id"] == run_id)
        if run["status"] not in ("starting", "running"):
            return run
        time.sleep(0.5)
    raise AssertionError(f"run {run_id} did not finish: {run}")


def test_strategies_save_load_list_delete(bt):
    ex = bt.result("strategy_example")[0]
    saved = bt.result("strategy_save", name="cross", code=ex["code"], params=ex["params"])[0]
    assert saved["name"] == "cross" and saved["problems"] == []
    assert [s["name"] for s in bt.result("strategies")[0]] == ["cross"]
    assert bt.result("strategy_load", name="cross")[0]["params"]["symbols"] == ["ES", "NQ"]
    bad = bt.result("strategy_save", name="bad", code="import os\n")[0]
    assert any("import os" in p for p in bad["problems"])  # saved, with its problems reported
    assert bt.result("strategy_delete", name="bad")[0] == {"deleted": True}


def test_a_run_streams_into_its_tables(bt):
    ex = bt.result("strategy_example")[0]
    reply, refs = bt.call("backtest_submit", code=ex["code"], params={**ex["params"], "symbols": ["ES"], "speed": 50000})
    r = reply["result"]
    assert set(r["tables"]) == {"trades", "orders", "positions", "signals", "equity"} and len(refs) == 5
    assert r["symbols"] == ["ES"]
    assert r["tables"]["equity"] == f"bt{r['run_id']}_equity"
    run = wait_for(bt, r["run_id"])
    assert run["status"] == "done", run
    assert run["bars"] > 1000 and run["trades"] > 0
    tables = dict(zip(["trades", "orders", "positions", "signals", "equity"], [x.fetch() for x in refs]))
    equity = tables["equity"].to_arrow()
    assert equity.num_rows == run["bars"]  # one symbol: one equity row per bar
    assert tables["trades"].to_arrow().num_rows == run["trades"]
    pos = tables["positions"].to_arrow().to_pydict()
    assert pos["Sym"] == ["ES"] and pos["Qty"][0] in (1.0, -1.0)  # keyed: one row per symbol
    names = set(tables["signals"].to_arrow().column("Name").to_pylist())
    assert {"fast", "slow"} <= names


def test_rejected_code_never_starts(bt):
    reply, refs = bt.call("backtest_submit", code="import os\ndef on_bar(ctx, bar): pass\n", params={"symbols": ["ES"]})
    assert reply["code"] == "bad_params" and "import os" in reply["error"] and refs == []


def test_a_runtime_error_is_reported_with_its_line(bt):
    code = "def on_bar(ctx, bar):\n    x = 1\n    return x / 0\n"
    r = bt.result("backtest_submit", code=code, params={"symbols": ["ES"], "speed": 50000})[0]
    run = wait_for(bt, r["run_id"])
    assert run["status"] == "error" and "ZeroDivisionError" in run["message"] and "line 3" in run["message"]


def test_cancel(bt):
    ex = bt.result("strategy_example")[0]
    r = bt.result("backtest_submit", code=ex["code"], params={**ex["params"], "speed": 50})[0]  # slow
    time.sleep(3)
    assert bt.result("backtest_cancel", run_id=r["run_id"])[0] == {"cancelled": True}
    assert wait_for(bt, r["run_id"])["status"] == "cancelled"
