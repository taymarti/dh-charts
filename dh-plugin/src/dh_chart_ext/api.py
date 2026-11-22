"""
The chart API: a request/response protocol over a Deephaven plugin message stream, for front ends that
draw their own charts (group C). A client asks for a chart; the server answers with a reference to a
shared node (nodes.ChartNodes), which the client subscribes to over Barrage like any table.

    chart_api = ChartApi(source)        # in the app script; publish it like a table

Client side (JS API):
    const api = await connection.getObject({ type: 'acme.chart.Api', name: 'chart_api' });
    api.addEventListener(dh.Widget.EVENT_MESSAGE, ...); api.sendMessage(JSON.stringify(request), []);

Messages are JSON. The server sends {"event": "ready", "version": 1, "lease_s": 90} when the stream opens. Requests are
{"id", "method", "params"}; replies {"id", "result"} or {"id", "error"}, and a reply that returns a table
carries it as its first reference. Methods:

  chart    {sym, res, studies?}  -> {key, columns}  + the table   (studies: ["EMA_20", {"type", "params"}, ...])
  bars     {sym, res}            -> {key}           + the table
  release  {key}                 -> {released}      (a chart closed; on_close releases everything left)
  symbols  {}                    -> [sym, ...]
  stats    {}                    -> one row per cached node (key, refs, hits, built_s, idle_s, deps)
  whoami   {}                    -> what the server knows of the caller (the session's auth context)
  ping     {}                    -> {lease_s}       (keeps the stream's lease)

Each stream holds what it acquired; closing it releases them. A client that vanishes without closing
(a browser tab that navigates away) is not always reported to the plugin, so every stream has a lease:
any message renews it, and a stream silent for `lease_s` is closed and its nodes released. Clients ping
every lease_s / 3 while open. Requests run on Deephaven's concurrent executor, under the stream's execution context,
in the order they arrive (one at a time per stream).
"""
from __future__ import annotations

import json
import logging
import threading
import time
import traceback
from queue import SimpleQueue
from typing import Any, Literal

from deephaven.execution_context import get_exec_ctx
from deephaven.plugin.object_type import BidirectionalObjectType, MessageStream

from .nodes import ChartNodes, resolution_name, resolution_options

log = logging.getLogger(__name__)

TYPE_NAME = "acme.chart.Api"
VERSION = 1


class ChartApi:
    """The server object a client opens: wraps the ChartNodes that serve its requests."""

    def __init__(self, source, nodes: ChartNodes | None = None, *, lease_s: float = 90.0):
        self.nodes = nodes or source.nodes
        self.lease_s = lease_s
        self.sessions = 0
        self._streams: set = set()
        self._lock = threading.Lock()
        threading.Thread(target=self._reap_loop, name="chart-api-leases", daemon=True).start()

    def _add(self, stream) -> None:
        with self._lock:
            self._streams.add(stream)
            self.sessions = len(self._streams)

    def _remove(self, stream) -> None:
        with self._lock:
            self._streams.discard(stream)
            self.sessions = len(self._streams)

    def _reap_loop(self) -> None:
        import time

        while True:
            time.sleep(max(1.0, self.lease_s / 6))
            now = time.monotonic()
            with self._lock:
                stale = [s for s in self._streams if now - s.last_seen > self.lease_s]
            for s in stale:
                print(f"[chart-api] lease expired: releasing {len(s.held)} node(s)", flush=True)
                s.expire()


def _auth_info() -> dict:
    """The caller's auth context, as Deephaven Community has it (the thread's ExecutionContext)."""
    try:
        ctx = get_exec_ctx().j_exec_ctx.getAuthContext()
        if ctx is None:
            return {"auth": None}
        return {"auth": str(ctx.toString()), "class": str(ctx.getClass().getName())}
    except Exception as e:  # noqa: BLE001
        return {"auth": None, "error": repr(e)}


class _Session(MessageStream):
    def __init__(self, api: ChartApi, client: MessageStream):
        super().__init__()
        self.api = api
        self.client = client
        self.held: list[tuple] = []
        self.closed = False
        self.lock = threading.Lock()
        self.ctx = get_exec_ctx()  # the session's context (and its auth context), for the worker
        self.auth_at_connect = _auth_info()
        self.queue: SimpleQueue = SimpleQueue()
        self.running = False
        self.last_seen = time.monotonic()
        api._add(self)

    # MessageStream: called by the server

    def on_data(self, payload: bytes, references: list[Any]) -> None:
        self.last_seen = time.monotonic()
        self.queue.put(bytes(payload))
        with self.lock:
            if self.running:
                return
            self.running = True
        from deephaven.server.executors import submit_task

        submit_task("concurrent", self._drain)

    def on_close(self) -> None:
        with self.lock:
            if self.closed:
                return
            self.closed = True
            held, self.held = self.held, []
        for key in held:
            self.api.nodes.release(key)
        self.api._remove(self)

    def expire(self) -> None:
        """The lease ran out: release everything and close the stream (if the client is still there)."""
        self.on_close()
        try:
            self.client.on_close()
        except Exception:  # noqa: BLE001 (already gone)
            pass

    # the worker: one request at a time, in order

    def _drain(self) -> None:
        with self.ctx:
            while True:
                with self.lock:
                    if self.queue.empty():
                        self.running = False
                        return
                self._handle(self.queue.get())

    def _handle(self, payload: bytes) -> None:
        rid = None
        try:
            req = json.loads(payload.decode() or "{}")
            rid = req.get("id")
            method = req.get("method")
            params = req.get("params") or {}
            fn = getattr(self, f"rpc_{method}", None)
            if fn is None:
                raise ValueError(f"unknown method {method!r}")
            result, refs = fn(**params)
            self._send({"id": rid, "result": result}, refs)
        except Exception as e:  # noqa: BLE001
            log.debug("chart api error: %s", traceback.format_exc())
            self._send({"id": rid, "error": str(e)}, [])

    def _send(self, msg: dict, refs: list) -> None:
        if not self.closed:
            self.client.on_data(json.dumps(msg).encode(), refs)

    def _hold(self, key: tuple) -> bool:
        """Record an acquired key; False (and released) if the stream closed meanwhile."""
        with self.lock:
            if not self.closed:
                self.held.append(key)
                return True
        self.api.nodes.release(key)
        return False

    # methods

    def rpc_chart(self, sym, res, studies=()):
        key, table, columns = self.api.nodes.chart(sym, res, studies)
        if not self._hold(key):
            return None, []
        return {"key": list(key), "columns": columns, "res": resolution_name(key[2])}, [table]

    def rpc_bars(self, sym, res):
        key, table = self.api.nodes.bars(sym, res)
        if not self._hold(key):
            return None, []
        return {"key": list(key), "res": resolution_name(key[2])}, [table]

    def rpc_release(self, key):
        k = _key(key)
        with self.lock:
            mine = k in self.held
            if mine:
                self.held.remove(k)
        if mine:
            self.api.nodes.release(k)
        return {"released": mine}, []

    def rpc_symbols(self):
        return self.api.nodes.symbols(), []

    def rpc_resolutions(self):
        return resolution_options(), []

    def rpc_stats(self):
        return {"sessions": self.api.sessions, "held": [list(k) for k in self.held], "nodes": self.api.nodes.cache.stats()}, []

    def rpc_ping(self):
        return {"lease_s": self.api.lease_s}, []

    def rpc_whoami(self):
        return {"at_connect": self.auth_at_connect, "in_request": _auth_info()}, []


def _key(key) -> tuple:
    """A key back from JSON (lists) as the tuple the cache uses."""
    return tuple(tuple(x) if isinstance(x, list) else x for x in key)


class ChartApiType(BidirectionalObjectType):
    """Registers ChartApi with the server (dh_chart_ext._register)."""

    @property
    def name(self) -> str:
        return TYPE_NAME

    @property
    def authorization_export_behavior(self) -> Literal["transform", "manual", "unset"]:
        return "transform"  # exported tables get the viewer's ACLs (identity in Community)

    def is_type(self, obj: Any) -> bool:
        return isinstance(obj, ChartApi)

    def create_client_connection(self, obj: object, connection: MessageStream) -> MessageStream:
        assert isinstance(obj, ChartApi)
        session = _Session(obj, connection)
        connection.on_data(json.dumps({"event": "ready", "version": VERSION, "lease_s": obj.lease_s}).encode(), [])
        return session
