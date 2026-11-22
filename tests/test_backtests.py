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
    assert run["status"] == "done", run["message"]
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


@pytest.mark.skipif(not os.environ.get("DH_SLOW"), reason="starts a Deephaven engine for the run (30-60 s); set DH_SLOW=1")
def test_an_engine_run_serves_its_tables_then_its_archive(bt):
    from pydeephaven import Session

    ex = bt.result("strategy_example")[0]
    r = bt.result("backtest_submit", code=ex["code"], params={**ex["params"], "symbols": ["ES"], "speed": 50000, "engine": True})[0]
    assert r["tables"]["equity"] == "equity"  # the standard names, in the run's own engine
    run = wait_for(bt, r["run_id"], timeout=300)
    assert run["status"] == "done", run["message"]
    deadline = time.time() + 60
    while not bt.result("backtest_engine", run_id=r["run_id"])[0]["archive"] and time.time() < deadline:
        time.sleep(1)
    eng = bt.result("backtest_engine", run_id=r["run_id"])[0]
    assert eng["up"] and eng["archive"] and eng["url"].startswith("http://")
    host, port = eng["url"][len("http://"):].split(":")
    with pytest.raises(Exception):  # the engine wants its key
        Session(host=host, port=int(port)).open_table("trades")
    s = Session(host=host, port=int(port), auth_type="io.deephaven.authentication.psk.PskAuthenticationHandler",
                auth_token=eng["psk"])
    try:
        assert s.open_table("trades").to_arrow().num_rows == run["trades"]
        info = s.open_table("run_info").to_arrow().to_pydict()
        assert info["Status"] == ["done"] and info["Trades"] == [run["trades"]]
        assert s.open_table("prices").to_arrow().num_rows == run["bars"]
    finally:
        s.close()
    arc = bt.result("backtest_archive", run_id=r["run_id"])[0]["tables"]
    assert set(arc) >= {"trades", "equity", "positions", "prices", "run_info"}
    # stop the lingering engine; the archive stays
    bt.result("backtest_cancel", run_id=r["run_id"])
    deadline = time.time() + 30
    while bt.result("backtest_engine", run_id=r["run_id"])[0]["up"] and time.time() < deadline:
        time.sleep(1)
    assert not bt.result("backtest_engine", run_id=r["run_id"])[0]["up"]
    assert bt.result("backtest_archive", run_id=r["run_id"])[0]["tables"] == arc
