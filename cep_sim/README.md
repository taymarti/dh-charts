# cep_sim: a stand-in for the CEP's backtester

`runner.py` plays the CEP's part in the desk's backtest workbench, so the rest can be built and tested
before the real CEP is wired in. It runs one strategy over historical bars in its own process and appends
what it does to Deephaven tables at the addresses it is given.

The contract the real CEP has to keep:

| | |
|---|---|
| **in** (stdin, one JSON line) | `run_id`, `code`, `params` (`symbols` and the strategy's own), `speed`, `dh: {host, port}`, `data: {table}`, and either `tables: {trades, orders, positions, signals, equity}` (central mode: the names of input tables to append to) or `engine: {host, port, psk, heap, linger_s}` and `archive_dir` (engine mode) |
| **out** (stdout, JSON lines) | `started` (bars), `progress` (bars, of, equity, trades, pnl), `log` (text), then `done` (summary) or `error` (message, line); engine mode adds `engine` (host, port, startup_s) first and `archived` (path), `lingering` (seconds) last. Lines that are not JSON (the embedded engine's own startup output) are ignored |
| **tables** | append-only `trades`, `orders`, `signals` (Kind `plot` or `signal`), `equity`; `positions` keyed by `Sym`. Schemas in `dh_chart_ext/backtests.py` (`OUTPUTS`) |

Two modes:

- **Central**: the server (the PQ) creates the run's tables and publishes them as `bt<N>_<kind>`;
  `backtest_submit`'s `targets` lets the UI name existing input tables instead.
- **Engine** (`params.engine`): the run starts a Deephaven engine of its own, as a CEP deployment does
  (a local engine for a backtest, the PQ's own when deployed on Enterprise). It publishes the standard
  names in that engine (`trades`, `orders`, `positions`, `signals`, `equity`, plus `prices`, the bars it
  saw, and `run_info`, its own status), prints `{"event": "engine", "host", "port"}` once it is up, writes
  every table to Parquet under `archive_dir/<run_id>/` when it ends, and keeps serving for `linger_s`.
  The engine takes a pre-shared key: Deephaven answers any web origin's CORS requests (C29), so an
  anonymous engine could be read and written by any page in the trader's browser.

Measured here (Windows, Java 17, the central server also running): an engine took 17 to 37 s to start
with a 1 GB heap. A run's results are only as available as its engine: the archive is what outlives it.

One caution for viewers connecting straight to a strategy's engine: in 42.6 a websocket client that stops
reading can block an update-graph thread in a synchronous send, and with it the whole engine, for good
(C30). Viewers on HTTPS (fetch instead of websockets), or reading the archive or a replica, avoid putting
the strategy's own engine at a browser's mercy.

Strategy code is checked twice: by the server when saved or submitted, and by the runner before it runs
(`dh_chart_ext.sandbox`). That is sanitizing, not sandboxing: the process is the boundary. In production the
launcher runs it as its own OS user in a jail or container, with only the Deephaven address reachable and
memory, CPU and time limits (`backtests.CommandLauncher`); `LocalLauncher` is for development.

Its fill model is deliberately simple: market orders at the bar's close, a commission per unit, no
slippage, no shorting limits or margin.

A pydeephaven note: a `Table` releases its export when the Python object is collected, and an `InputTable`
built on the same ticket does not keep it alive. Keep the opened table referenced while appending.
