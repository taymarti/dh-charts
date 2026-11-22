# cep_sim: a stand-in for the CEP's backtester

`runner.py` plays the CEP's part in the desk's backtest workbench, so the rest can be built and tested
before the real CEP is wired in. It runs one strategy over historical bars in its own process and appends
what it does to Deephaven tables at the addresses it is given.

The contract the real CEP has to keep:

| | |
|---|---|
| **in** (stdin, one JSON line) | `run_id`, `code`, `params` (`symbols` and the strategy's own), `speed`, `dh: {host, port}`, `data: {table}`, `tables: {trades, orders, positions, signals, equity}`: the names of input tables to append to |
| **out** (stdout, JSON lines) | `started` (bars), `progress` (bars, of, equity, trades, pnl), `log` (text), then `done` (summary) or `error` (message, line) |
| **tables** | append-only `trades`, `orders`, `signals` (Kind `plot` or `signal`), `equity`; `positions` keyed by `Sym`. Schemas in `dh_chart_ext/backtests.py` (`OUTPUTS`) |

The server (the PQ) creates the run's tables and publishes them as `bt<N>_<kind>`; `backtest_submit`'s
`targets` lets the UI name existing input tables instead. A CEP that creates its own tables and reports
their names back is the other variant; the runner would then print `{"event": "tables", ...}` first.

Strategy code is checked twice: by the server when saved or submitted, and by the runner before it runs
(`dh_chart_ext.sandbox`). That is sanitizing, not sandboxing: the process is the boundary. In production the
launcher runs it as its own OS user in a jail or container, with only the Deephaven address reachable and
memory, CPU and time limits (`backtests.CommandLauncher`); `LocalLauncher` is for development.

Its fill model is deliberately simple: market orders at the bar's close, a commission per unit, no
slippage, no shorting limits or margin.

A pydeephaven note: a `Table` releases its export when the Python object is collected, and an `InputTable`
built on the same ticket does not keep it alive. Keep the opened table referenced while appending.
