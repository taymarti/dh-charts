"""
Tests against a running demo server (run_server.py --app-dir app.d). DH_TEST_PORT picks the port
(default 10040); without a server on it, the protocol tests are skipped, not failed, unless
DH_TEST_REQUIRE=1 (CI), which makes a missing server a failure.

    python run_server.py --port 10040 --app-dir app.d     # in one shell
    pytest tests                                          # in another
"""
from __future__ import annotations

import json
import os
import socket
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "dh-plugin" / "src"))

PORT = int(os.environ.get("DH_TEST_PORT", "10040"))


def _server_up() -> bool:
    try:
        with socket.create_connection(("localhost", PORT), timeout=1):
            return True
    except OSError:
        return False


class Client:
    """One stream to the published chart API, with blocking request/reply."""

    def __init__(self, name: str = "chart_api"):
        from pydeephaven import Session

        self.session = Session(port=PORT)
        self.plugin = self.session.plugin_client(self.session.exportable_objects[name])
        payload, _ = next(self.plugin.resp_stream)
        self.ready = json.loads(payload.decode())
        self._id = 0

    def call(self, method: str, **params):
        """(reply, references): reply is {"id", "result"} or {"id", "error", "code"}."""
        self._id += 1
        self.plugin.req_stream.write(json.dumps({"id": self._id, "method": method, "params": params}).encode(), [])
        payload, refs = next(self.plugin.resp_stream)
        reply = json.loads(payload.decode())
        assert reply["id"] == self._id
        return reply, refs

    def result(self, method: str, **params):
        reply, refs = self.call(method, **params)
        assert "error" not in reply, reply
        return reply["result"], refs

    def stats(self):
        return self.result("stats")[0]

    def node(self, key):
        return next((n for n in self.stats()["nodes"] if n["key"] == key), None)

    def close(self):
        self.plugin.close()
        self.session.close()


@pytest.fixture(scope="session")
def server():
    if not _server_up():
        if os.environ.get("DH_TEST_REQUIRE"):
            pytest.fail(f"no Deephaven server on port {PORT}")
        pytest.skip(f"no Deephaven server on port {PORT} (run_server.py --port {PORT} --app-dir app.d)")
    deadline = time.time() + 180
    while True:  # app.d may still be starting: wait for chart_api to be published
        try:
            c = Client()
            c.close()
            return PORT
        except Exception:  # noqa: BLE001
            if time.time() > deadline:
                raise
            time.sleep(3)


@pytest.fixture
def client(server):
    c = Client()
    yield c
    c.close()


@pytest.fixture
def make_client(server):
    made = []

    def make():
        c = Client()
        made.append(c)
        return c

    yield make
    for c in made:
        try:
            c.close()
        except Exception:  # noqa: BLE001 (closed by the test)
            pass
