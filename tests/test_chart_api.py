"""The chart API (dh_chart_ext.api over rpc.Api) against a running demo server."""
import os
import time

import pytest


def test_ready_message(client):
    r = client.ready
    assert r["event"] == "ready" and r["version"] == 2 and r["lease_s"] > 0
    assert {"chart", "bars", "hello", "describe", "ping", "release", "stats"} <= set(r["methods"])


def test_describe_reports_parameters(client):
    methods = {m["name"]: m for m in client.result("describe")[0]}
    chart = methods["chart"]
    assert chart["returns_tables"] is True
    params = {p["name"]: p for p in chart["params"]}
    assert params["sym"] == {"name": "sym", "type": "string", "required": True}
    assert params["studies"]["type"] == "array" and params["studies"]["required"] is False


def test_hello_unverified_without_a_secret(client):
    if os.environ.get("ACME_API_SECRET"):
        pytest.skip("the server verifies tokens")
    assert client.result("hello", token="user:alice")[0] == {"user": "alice", "verified": False}
    who = client.result("whoami")[0]
    assert who["user"] == "alice" and who["verified"] is False
    # Community's auth context carries no user (C21)
    assert who["auth_in_request"]["class"].startswith("io.deephaven.auth.AuthContext")


def test_hello_rejects_a_bare_name(client):
    if os.environ.get("ACME_API_SECRET"):
        pytest.skip("the server verifies tokens")
    reply, _ = client.call("hello", token="alice")
    assert reply["code"] == "unauthorized"


def test_equal_requests_share_one_node(make_client):
    a, b = make_client(), make_client()
    ra, refs_a = a.result("chart", sym="NQ", res="2m", studies=["EMA_20"])
    rb, refs_b = b.result("chart", sym="NQ", res="120s", studies=[{"type": "EMA", "params": {"length": 20}}])
    assert ra["key"] == rb["key"] == ["chart", "NQ", 120, ["EMA_20"]]
    ta, tb = refs_a[0].fetch().to_arrow(), refs_b[0].fetch().to_arrow()
    assert ta.column_names == ["Timestamp", "Open", "High", "Low", "Close", "Volume", "Updated", "EMA_20"]
    assert abs(ta.num_rows - tb.num_rows) <= 1  # the same node (a bar may close between the snapshots)
    ts = ta.column("Timestamp").to_pylist()[-20:]
    assert {(y - x).total_seconds() for x, y in zip(ts, ts[1:])} == {120.0}  # 2m bars, rolled up from 1m
    node = a.node(ra["key"])
    assert node["refs"] >= 2 and node["deps"] == [["bars", "NQ", 120]]


def test_chart_reply_describes_columns_and_panes(client):
    r, _ = client.result("chart", sym="ES", res="5m", studies=["RSI_14", "BB_20_2", "EMA_20", "Volume"])
    cols = {c["column"]: c for c in r["columns"]}
    assert set(cols) == {"BB_20_2_Upper", "BB_20_2_Mid", "BB_20_2_Lower", "EMA_20", "RSI_14"}  # Volume: in the bars
    assert cols["RSI_14"]["pane"] == "rsi" and cols["RSI_14"]["levels"] == [30.0, 70.0]
    assert cols["EMA_20"]["pane"] == "overlay" and cols["BB_20_2_Mid"]["study"] == "BB_20_2"
    assert r["tick"] == 0.25 and r["sym"] == "ES" and r["res"] == "5m"
    assert r["key"][3] == ["BB_20_2", "EMA_20", "RSI_14"]  # sorted: order does not make a new node


def test_spread_is_canonical_and_has_a_tick(client):
    r, refs = client.result("chart", sym="ES - NQ", res="5m")
    assert r["key"] == ["bars", "ES-NQ", 300] and r["tick"] == 0.25
    t = refs[0].fetch().to_arrow()
    assert t.num_rows > 0 and t.column("Close").to_pylist()[-1] < 0  # ES is below NQ in the demo


@pytest.mark.parametrize("params, code", [
    ({"sym": "XX", "res": "1m"}, "bad_params"),
    ({"sym": "ES", "res": "0s"}, "bad_params"),
    ({"sym": "ES", "res": "1m", "studies": ["EMA_5000"]}, "bad_params"),
    ({"sym": "ES", "res": "1m", "studies": ["NOPE_1"]}, "bad_params"),
    ({"sym": "ES"}, "bad_params"),                               # missing res
    ({"sym": "ES", "res": "1m", "colour": "red"}, "bad_params"),  # unknown parameter
    ({"sym": "ES", "res": "1m", "studies": "EMA_20"}, "bad_params"),  # not an array
])
def test_bad_requests(client, params, code):
    reply, refs = client.call("chart", **params)
    assert reply.get("code") == code, reply
    assert refs == []


def test_unknown_method(client):
    assert client.call("nope")[0]["code"] == "unknown_method"


def test_release_then_reuse_within_grace(client):
    r, _ = client.result("chart", sym="ZN", res="5m", studies=["SMA_20"])
    assert client.node(r["key"])["refs"] >= 1
    assert client.result("release", key=r["key"])[0] == {"released": True}
    assert client.result("release", key=r["key"])[0] == {"released": False}  # not held twice
    node = client.node(r["key"])
    assert node is None or node["refs"] == 0 or node["idle_s"] is None  # idle, unless another client holds it
    again, _ = client.result("chart", sym="ZN", res="5m", studies=["SMA_20"])
    assert again["key"] == r["key"] and client.node(r["key"])["hits"] >= 1


def test_closing_a_stream_releases_its_nodes(make_client):
    # Released when the server sees the stream close (promptly with pydeephaven on Windows), or at the
    # latest when its lease runs out (on a Linux CI runner the close was not seen within 10 s)
    a, watcher = make_client(), make_client()
    r, _ = a.result("chart", sym="GC", res="15m", studies=["EMA_50"])
    before = watcher.node(r["key"])["refs"]
    a.close()
    deadline = time.time() + watcher.ready["lease_s"] + 20
    while time.time() < deadline and (watcher.node(r["key"]) or {"refs": 0})["refs"] >= before:
        watcher.result("ping")  # the watcher keeps its own lease
        time.sleep(0.5)
    assert (watcher.node(r["key"]) or {"refs": 0})["refs"] == before - 1


def test_repeated_request_holds_once(client):
    r1, _ = client.result("chart", sym="CL", res="1m")
    refs1 = client.node(r1["key"])["refs"]
    client.result("chart", sym="CL", res="1m")
    assert client.node(r1["key"])["refs"] == refs1
    assert client.stats()["held"].count(r1["key"]) == 1


@pytest.mark.skipif(not os.environ.get("DH_SLOW"), reason="takes the lease plus up to 40 s (2 minutes at 90 s); set DH_SLOW=1")
def test_a_silent_stream_loses_its_lease(make_client):
    a, watcher = make_client(), make_client()
    r, _ = a.result("chart", sym="SI", res="15m", studies=["SMA_20"])
    before = watcher.node(r["key"])["refs"]
    deadline = time.time() + a.ready["lease_s"] + 40
    while time.time() < deadline:
        watcher.result("ping")
        if (watcher.node(r["key"]) or {"refs": 0})["refs"] < before:
            break
        time.sleep(5)
    assert (watcher.node(r["key"]) or {"refs": 0})["refs"] == before - 1
