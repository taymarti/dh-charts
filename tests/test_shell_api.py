"""The app-shell methods on the chart API: saved workspaces per user (dh_chart_ext.workspaces), the graph explorer."""
import os
import uuid

import pytest


@pytest.fixture
def user():
    if os.environ.get("ACME_API_SECRET"):
        pytest.skip("the server verifies tokens")
    return f"test-{uuid.uuid4().hex[:8]}"


def test_save_list_load_delete(make_client, user):
    c = make_client()
    c.result("hello", token=f"user:{user}")
    layout = {"version": 1, "dock": {"panels": {"chart-1": {"params": {"symbol": "NQ"}}}}, "links": {"red": {"symbol": "NQ"}}}
    saved = c.result("workspace_save", name="Morning", layout=layout)[0]
    assert saved["name"] == "Morning" and saved["saved_at"] > 0
    c.result("workspace_save", name="Evening", layout={"version": 1, "dock": {}, "links": {}})
    assert [w["name"] for w in c.result("workspaces")[0]] == ["Evening", "Morning"]  # newest first
    assert c.result("workspace_load", name="Morning")[0]["layout"] == layout
    assert c.result("workspace_delete", name="Morning")[0] == {"deleted": True}
    assert c.result("workspace_delete", name="Morning")[0] == {"deleted": False}
    assert c.call("workspace_load", name="Morning")[0]["code"] == "not_found"


def test_workspaces_are_per_user(make_client, user):
    a, b = make_client(), make_client()
    a.result("hello", token=f"user:{user}")
    b.result("hello", token=f"user:{user}-other")
    a.result("workspace_save", name="Mine", layout={"version": 1, "dock": {}, "links": {}})
    assert b.result("workspaces")[0] == []
    assert b.call("workspace_load", name="Mine")[0]["code"] == "not_found"
    # the same user on another stream (another browser) sees it
    c = make_client()
    c.result("hello", token=f"user:{user}")
    assert [w["name"] for w in c.result("workspaces")[0]] == ["Mine"]


@pytest.mark.parametrize("params, code", [
    ({"name": "", "layout": {}}, "bad_params"),
    ({"name": "x" * 65, "layout": {}}, "bad_params"),
    ({"name": "big", "layout": {"blob": "x" * (300 * 1024)}}, "limit"),
    ({"name": "notobj", "layout": [1, 2]}, "bad_params"),
])
def test_bad_saves(make_client, user, params, code):
    c = make_client()
    c.result("hello", token=f"user:{user}")
    assert c.call("workspace_save", **params)[0]["code"] == code


def test_graph_explorer(client):
    reply, _ = client.call("graph")
    if reply.get("code") == "unknown_method":
        pytest.skip("introspect is not loaded on this server (deephaven-compare is not checked out beside it)")
    g = reply["result"]
    assert g["nodes"] and all(n["kind"] != "internal" for n in g["nodes"])
    ids = {n["id"] for n in g["nodes"]}
    assert all(p in ids and c in ids for p, c in g["edges"])
    named = {v for n in g["nodes"] for v in n["variables"]}
    assert "quotes" in named
    again, _ = client.call("graph")
    assert again["result"]["cached"] is True
