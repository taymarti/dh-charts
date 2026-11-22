"""
A stand-in for the CEP's backtester: runs one strategy over historical bars and streams what it does into
Deephaven tables at the addresses it is given. The real CEP replaces this file; the contract stays:

  stdin   one JSON spec: {run_id, code, params, speed, dh: {host, port}, data: {table, symbols},
          tables: {trades, orders, positions, signals, equity}}  (the names of input tables to append to)
  stdout  JSON lines: {"event": "started"}, {"event": "progress", "bars": n, "of": total, "equity": x, "trades": n, "pnl": x},
          {"event": "log", "text": ...}, {"event": "done", "summary": {...}} or {"event": "error", "message": ...}

Run by dh_chart_ext.backtests (one process per run, `python -I`); the process is the sandbox, see there.

The strategy DSL (checked with dh_chart_ext.sandbox before it runs):

    def on_start(ctx):                    # optional
        ctx.state["fast"] = ctx.param("fast", 10)

    def on_bar(ctx, bar):                 # every bar of every symbol, in time order
        fast = ctx.ema(bar.sym + ":f", ctx.state["fast"], bar.close)
        slow = ctx.ema(bar.sym + ":s", 30, bar.close)
        ctx.plot("fast", fast, bar.sym)   # a series in the signals table
        if fast > slow and ctx.position(bar.sym) <= 0:
            ctx.target(bar.sym, 1)        # market order, filled at this bar's close
        elif fast < slow and ctx.position(bar.sym) >= 0:
            ctx.target(bar.sym, -1)

    def on_end(ctx):                      # optional
        ctx.log("done")
"""
from __future__ import annotations

import json
import math
import sys
import time
from dataclasses import dataclass, field
from typing import Callable


# ----------------------------------------------------------------------------- the simulation (no Deephaven)

@dataclass(frozen=True)
class Bar:
    sym: str
    time: int  # ns since the epoch, UTC
    open: float
    high: float
    low: float
    close: float
    volume: float


class Context:
    """What a strategy sees and does."""

    def __init__(self, symbols: list[str], params: dict, capital: float, commission: float, emit: Callable[[str, dict], None]):
        self.symbols = list(symbols)
        self.params = dict(params)
        self.state: dict = {}
        self.cash = float(capital)
        self.commission = float(commission)
        self._emit = emit
        self._pos: dict[str, float] = {}
        self._avg: dict[str, float] = {}
        self._last: dict[str, float] = {}
        self._ind: dict[str, list] = {}
        self._now = 0
        self._logs = 0
        self.trades = 0
        self.realized = 0.0

    # reading

    def param(self, name: str, default=None):
        return self.params.get(name, default)

    def position(self, sym: str) -> float:
        return self._pos.get(sym, 0.0)

    def avg_price(self, sym: str) -> float:
        return self._avg.get(sym, 0.0)

    @property
    def equity(self) -> float:
        return self.cash + sum(q * self._last.get(s, 0.0) for s, q in self._pos.items())

    # indicators: state by key, so a strategy can keep any number

    def ema(self, key: str, length: int, value: float) -> float:
        s = self._ind.setdefault(f"ema:{key}", [None])
        a = 2.0 / (int(length) + 1)
        s[0] = value if s[0] is None else s[0] + a * (value - s[0])
        return s[0]

    def sma(self, key: str, length: int, value: float) -> float:
        s = self._ind.setdefault(f"sma:{key}", [[], 0.0])
        s[0].append(value)
        s[1] += value
        if len(s[0]) > int(length):
            s[1] -= s[0].pop(0)
        return s[1] / len(s[0])

    # acting

    def buy(self, sym: str, qty: float = 1) -> None:
        self._order(sym, abs(qty))

    def sell(self, sym: str, qty: float = 1) -> None:
        self._order(sym, -abs(qty))

    def target(self, sym: str, qty: float) -> None:
        delta = qty - self.position(sym)
        if delta:
            self._order(sym, delta)

    def plot(self, name: str, value: float, sym: str = "") -> None:
        if value is not None and math.isfinite(value):
            self._emit("signals", {"Timestamp": self._now, "Sym": sym, "Kind": "plot", "Name": str(name)[:64], "Value": float(value)})

    def signal(self, sym: str, name: str, value: float = 1.0) -> None:
        self._emit("signals", {"Timestamp": self._now, "Sym": sym, "Kind": "signal", "Name": str(name)[:64], "Value": float(value)})

    def log(self, text) -> None:
        self._logs += 1
        if self._logs <= 200:
            self._emit("log", {"text": str(text)[:500]})

    # the fill model: market orders at the current bar's close, a commission per unit

    def _order(self, sym: str, qty: float) -> None:
        if sym not in self._last:
            raise ValueError(f"no price for {sym} yet (subscribed: {', '.join(self.symbols)})")
        price = self._last[sym]
        side = "BUY" if qty > 0 else "SELL"
        self._emit("orders", {"Timestamp": self._now, "Sym": sym, "Side": side, "Qty": abs(qty), "Type": "MKT",
                              "Price": price, "Status": "FILLED"})
        pos, avg = self.position(sym), self.avg_price(sym)
        realized = 0.0
        if pos and (pos > 0) != (qty > 0):  # closing some or all
            closed = min(abs(qty), abs(pos)) * (1 if pos > 0 else -1)
            realized = closed * (price - avg)
        new = pos + qty
        if new == 0:
            self._avg.pop(sym, None)
        elif pos == 0 or (pos > 0) != (new > 0):
            self._avg[sym] = price  # opened, or flipped through zero
        elif (pos > 0) == (qty > 0):
            self._avg[sym] = (avg * pos + price * qty) / new  # added
        self._pos[sym] = new
        fee = abs(qty) * self.commission
        self.cash -= qty * price + fee
        self.realized += realized - fee
        self.trades += 1
        self._emit("trades", {"Timestamp": self._now, "Sym": sym, "Side": side, "Qty": abs(qty), "Price": price,
                              "Commission": fee, "RealizedPnl": realized - fee})
        self._emit("positions", {"Sym": sym, "Qty": new, "AvgPrice": self._avg.get(sym, 0.0), "Updated": self._now})


@dataclass
class Summary:
    bars: int = 0
    trades: int = 0
    equity: float = 0.0
    pnl: float = 0.0
    max_drawdown: float = 0.0
    extra: dict = field(default_factory=dict)


def simulate(code: str, bars: list[Bar], params: dict, emit: Callable[[str, dict], None],
             on_step: Callable[[int, float, int], None] = lambda n, eq, trades: None) -> Summary:
    """Run `code` over `bars` (sorted by time); emit(kind, row) for each output row. Raises on strategy errors."""
    from dh_chart_ext.sandbox import require_valid, restricted_globals

    require_valid(code)
    env = restricted_globals()
    exec(compile(code, "<strategy>", "exec"), env)  # noqa: S102 (checked code, restricted builtins, own process)
    on_start, on_bar, on_end = env.get("on_start"), env["on_bar"], env.get("on_end")
    capital = float(params.get("capital", 100_000))
    symbols = sorted({b.sym for b in bars})
    ctx = Context(params.get("symbols", symbols), params, capital, float(params.get("commission", 0.0)), emit)
    if on_start:
        on_start(ctx)
    peak, max_dd, n = capital, 0.0, 0
    i = 0
    while i < len(bars):
        t = bars[i].time
        ctx._now = t
        while i < len(bars) and bars[i].time == t:  # every symbol's bar at this time, then equity once
            b = bars[i]
            ctx._last[b.sym] = b.close
            on_bar(ctx, b)
            i += 1
            n += 1
        eq = ctx.equity
        peak = max(peak, eq)
        dd = (peak - eq) / peak if peak else 0.0
        max_dd = max(max_dd, dd)
        emit("equity", {"Timestamp": t, "Equity": eq, "Cash": ctx.cash, "Drawdown": dd})
        for s, q in ctx._pos.items():
            if q:
                emit("positions", {"Sym": s, "Qty": q, "AvgPrice": ctx._avg.get(s, 0.0), "Updated": t,
                                   "Unrealized": q * (ctx._last[s] - ctx._avg.get(s, 0.0))})
        on_step(n, eq, ctx.trades)
    if on_end:
        on_end(ctx)
    return Summary(bars=n, trades=ctx.trades, equity=ctx.equity, pnl=ctx.equity - capital, max_drawdown=max_dd)


# ----------------------------------------------------------------------------- the Deephaven side

def say(event: str, **kw) -> None:
    sys.stdout.write(json.dumps({"event": event, **kw}, default=str) + "\n")
    sys.stdout.flush()


def main() -> int:
    spec = json.loads(sys.stdin.readline())
    import pyarrow as pa
    from pydeephaven import Session
    from pydeephaven.table import InputTable

    dh = spec["dh"]
    session = Session(host=dh.get("host", "localhost"), port=int(dh.get("port", 10040)))
    try:
        # the outputs: input tables the server provisioned (or the UI named), appended to in batches
        outs, schemas, opened = {}, {}, []
        for kind, name in spec["tables"].items():
            t = session.open_table(name)
            opened.append(t)  # keep it: a pydeephaven Table releases its export when collected, and the wrapper doesn't own it
            outs[kind] = InputTable(session, t.ticket, schema=t.schema)
            schemas[kind] = pa.schema([pa.field(f.name, f.type) for f in t.schema])
        pending: dict[str, list[dict]] = {k: [] for k in outs}
        positions: dict[str, dict] = {}

        def flush() -> None:
            if positions:
                pending["positions"] = list(positions.values())
                positions.clear()
            for kind, rows in pending.items():
                if not rows:
                    continue
                sch = schemas[kind]
                cols = {f.name: [r.get(f.name) for r in rows] for f in sch}
                outs[kind].add(session.import_table(pa.Table.from_pydict(cols, schema=sch)))
                rows.clear()

        def emit(kind: str, row: dict) -> None:
            if kind == "log":
                say("log", text=row["text"])
            elif kind == "positions":
                positions[row["Sym"]] = {**positions.get(row["Sym"], {}), **row}  # keyed: the last one wins
            elif kind in pending:
                pending[kind].append(row)

        # the history: the bars table, for the subscribed symbols
        data = spec.get("data", {})
        symbols = [str(s) for s in spec.get("params", {}).get("symbols", [])]
        if not symbols:
            raise ValueError("params.symbols is empty")
        quoted = ", ".join(f"`{s}`" for s in symbols if s.replace("_", "").replace("-", "").isalnum())
        src = session.open_table(data.get("table", "bars_1m")).where(f"Sym in {quoted}").sort(["Timestamp", "Sym"])
        arrow = src.select(["Timestamp", "Sym", "Open", "High", "Low", "Close", "Volume"]).to_arrow()
        ts = arrow.column("Timestamp").cast(pa.int64()).to_pylist()
        cols = {c: arrow.column(c).to_pylist() for c in ("Sym", "Open", "High", "Low", "Close", "Volume")}
        bars = [Bar(cols["Sym"][i], ts[i], cols["Open"][i], cols["High"][i], cols["Low"][i], cols["Close"][i],
                    float(cols["Volume"][i] or 0)) for i in range(len(ts)) if cols["Close"][i] is not None]
        say("started", bars=len(bars), symbols=symbols)

        speed = max(1.0, float(spec.get("speed", 1000)))  # bars per second: results stream in as a live run would
        t0 = time.monotonic()
        last = [t0]

        capital = float(spec.get("params", {}).get("capital", 100_000))

        def on_step(n: int, eq: float, trades: int) -> None:
            ahead = n / speed - (time.monotonic() - t0)
            if ahead > 0:
                time.sleep(ahead)
            now = time.monotonic()
            if now - last[0] >= 0.25:
                flush()
                say("progress", bars=n, of=len(bars), equity=round(eq, 2), trades=trades, pnl=round(eq - capital, 2))
                last[0] = now

        summary = simulate(spec["code"], bars, spec.get("params", {}), emit, on_step)
        flush()
        say("done", summary={"bars": summary.bars, "trades": summary.trades, "equity": round(summary.equity, 2),
                             "pnl": round(summary.pnl, 2), "max_drawdown": round(summary.max_drawdown, 4)})
        return 0
    except Exception as e:  # noqa: BLE001 (reported to the server, which shows it to the user)
        tb = e.__traceback__
        line = None
        while tb is not None:
            if tb.tb_frame.f_code.co_filename == "<strategy>":
                line = tb.tb_lineno
            tb = tb.tb_next
        root = e
        while root.__cause__ is not None:  # pydeephaven wraps the server's reason
            root = root.__cause__
        detail = f" ({type(root).__name__}: {str(root)[:300]})" if root is not e else ""
        say("error", message=f"{type(e).__name__}: {e}{detail}", line=line)
        return 1
    finally:
        session.close()


if __name__ == "__main__":
    sys.exit(main())
