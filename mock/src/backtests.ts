/**
 * Backtests from the desk (dh_chart_ext.backtests, mock side): strategies per user, runs in a Web Worker of
 * their own (the CEP stand-in), results streamed into per-run tables bt<N>_trades, _orders, _positions,
 * _signals, _equity, and every run in `backtest_runs`. Strategies are JavaScript here (the real CEP takes
 * Python); the DSL is the same. "Own engine" runs need a second Deephaven engine, which the mock doesn't
 * have: they run in the page's engine and say so.
 */
import { Engine, RowSource, B, D, L, S, T, instant, type Row } from './engine';
import type { MockServer } from './dh';
import type { BarMarket as Market } from './market';
import { MarkerSource } from './markers';
import { Api, ApiError, Reply, p } from './rpc';
import { UserDocs } from './stores';
// the runner, inlined into this package's build: a Worker from a Blob, wherever the app serves files from
import BacktestWorker from './bt-worker?worker&inline';

export const EXAMPLE_STRATEGY = `// An EMA crossover: long when the fast EMA is above the slow one, short below.
// on_bar runs for every 1-minute bar of every symbol, in time order. P&L is in dollars (contract multipliers).
function on_start(ctx) {
  ctx.state.fast = ctx.param('fast', 10);
  ctx.state.slow = ctx.param('slow', 30);
  ctx.log('fast ' + ctx.state.fast + ', slow ' + ctx.state.slow);
}

function on_bar(ctx, bar) {
  const fast = ctx.ema(bar.sym + ':f', ctx.state.fast, bar.close);
  const slow = ctx.ema(bar.sym + ':s', ctx.state.slow, bar.close);
  ctx.plot('fast', fast, bar.sym);
  ctx.plot('slow', slow, bar.sym);
  const size = ctx.param('size', 10);
  if (fast > slow && ctx.position(bar.sym) <= 0) ctx.target(bar.sym, size);
  else if (fast < slow && ctx.position(bar.sym) >= 0) ctx.target(bar.sym, -size);
}

function on_end(ctx) {
  ctx.log('done: equity ' + ctx.equity().toFixed(0));
}
`;

const FORBIDDEN = /\b(fetch|XMLHttpRequest|importScripts|eval|Function|WebSocket|indexedDB|localStorage|sessionStorage|document|window|globalThis|self|postMessage|import|require)\b/;

export function checkStrategy(code: string): string[] {
  const problems: string[] = [];
  if (!/function\s+on_bar\s*\(|on_bar\s*=/.test(code)) problems.push('define on_bar(ctx, bar)');
  const bad = FORBIDDEN.exec(code);
  if (bad) problems.push(`"${bad[1]}" is not allowed in a strategy (it runs sandboxed)`);
  try {
    new Function('ctx', code);
  } catch (e) {
    problems.push(`syntax: ${(e as Error).message}`);
  }
  return problems;
}

interface Run {
  id: number;
  user: string;
  strategy: string;
  status: 'starting' | 'running' | 'done' | 'error' | 'cancelled';
  symbols: string[];
  tables: Record<string, string>;
  worker: Worker | null;
  bars: number;
  of: number;
  trades: number;
  equity: number;
  pnl: number;
  maxdd: number;
  message: string;
  started: number;
  ended: number | null;
}

/** The backtest methods on `api` (as dh_chart_ext.backtests); `exampleSymbols` are what the example strategy runs on. */
export function registerBacktests(api: Api, engine: Engine, server: MockServer, market: Market, exampleSymbols: string[]) {
  const code = new UserDocs<{ code: string; params: Record<string, unknown> }>('strategies');
  const runs = new Map<number, Run>();
  let next = 1;
  const runsTable = new RowSource(engine, 'backtest_runs', [
    L('RunId'), S('User'), S('Strategy'), S('Status'), T('Started'), T('Ended'), L('Bars'), L('Of'), L('Trades'), D('Equity'), D('Pnl'), D('MaxDrawdown'), S('Message'), S('Engine'), B('EngineUp'), S('Archive'),
  ], { keyCols: ['RunId'], kind: 'source', description: 'every backtest run' });
  server.publishTable('backtest_runs', runsTable);

  const write = (r: Run) =>
    runsTable.put([{
      RunId: r.id, User: r.user, Strategy: r.strategy, Status: r.status, Started: instant(r.started), Ended: instant(r.ended), Bars: r.bars, Of: r.of, Trades: r.trades,
      Equity: r.equity, Pnl: r.pnl, MaxDrawdown: r.maxdd, Message: r.message, Engine: null, EngineUp: false, Archive: null,
    }]);
  const info = (r: Run) => ({
    run_id: r.id, strategy: r.strategy, status: r.status, tables: r.tables, symbols: r.symbols, engine: null, archive: false, bars: r.bars, of: r.of,
    trades: r.trades, equity: r.equity, pnl: r.pnl, maxdrawdown: r.maxdd, message: r.message, started: r.started, ended: r.ended,
  });

  api.method('strategies', "This user's saved strategies, newest first.", [], ctx => code.list(ctx.user));
  api.method('strategy_save', 'Save a strategy (checked; saved even with problems).', [p('name', 'string'), p('code', 'string'), p('params', 'object', {})], (ctx, a) => {
    if (!String(a.name).trim()) throw new ApiError('a name, please', 'bad_params');
    const at = code.put(ctx.user, a.name, { code: a.code, params: a.params });
    return { name: a.name, saved_at: at, problems: checkStrategy(a.code) };
  });
  api.method('strategy_load', "A saved strategy's code and parameters.", [p('name', 'string')], (ctx, a) => {
    const hit = code.get(ctx.user, a.name);
    if (!hit) throw new ApiError(`no strategy ${a.name}`, 'not_found');
    return { name: a.name, code: hit.value.code, params: hit.value.params, saved_at: hit.saved_at };
  });
  api.method('strategy_delete', 'Delete a saved strategy.', [p('name', 'string')], (ctx, a) => ({ deleted: code.remove(ctx.user, a.name) }));
  api.method('strategy_check', 'Problems that would stop the code from running.', [p('code', 'string')], (_ctx, a) => ({ problems: checkStrategy(a.code) }));
  api.method('strategy_example', 'A starting point: an example strategy and its parameters.', [], () => ({
    code: EXAMPLE_STRATEGY, params: { symbols: exampleSymbols, capital: 1000000, speed: 3000, fast: 10, slow: 30, size: 10 },
  }));

  api.method(
    'backtest_submit',
    'Run a strategy (its code, or a saved one by name) over the 1-minute history; results stream into the run’s tables.',
    [p('code', 'string', ''), p('strategy', 'string', ''), p('params', 'object', {}), p('targets', 'object', {})],
    (ctx, a) => {
      let src: string = a.code;
      let params: Record<string, unknown> = a.params;
      if (!src) {
        const hit = code.get(ctx.user, a.strategy);
        if (!hit) throw new ApiError(`no strategy ${a.strategy}`, 'not_found');
        src = hit.value.code;
        params = { ...hit.value.params, ...params };
      }
      // an engine run starts a Deephaven engine of its own and the panel waits for it to come up; the mock has none,
      // so say so instead of leaving the panel waiting
      if (params.engine)
        throw new ApiError('"Own engine" needs a real Deephaven deployment (each run starts an engine of its own). Untick it to run in this page.', 'unsupported');
      const problems = checkStrategy(src);
      if (problems.length) throw new ApiError("the strategy can't run: " + problems.join('; '), 'bad_params');
      const symbols = params.symbols;
      if (!Array.isArray(symbols) || !symbols.length || !symbols.every(s => typeof s === 'string' && market.has(s)))
        throw new ApiError('params.symbols: a list of known symbols', 'bad_params');
      const active = [...runs.values()].filter(r => r.user === ctx.user && (r.status === 'starting' || r.status === 'running')).length;
      if (active >= 3) throw new ApiError(`${ctx.user} has ${active} backtests running (limit 3)`, 'limit');
      const id = next++;
      const mk = (kind: string, cols: ReturnType<typeof S>[], keyCols?: string[]) => {
        const t = new RowSource(engine, `bt${id}_${kind}`, cols, { keyCols, kind: 'op', description: `run ${id}: ${kind}` });
        server.publishTable(`bt${id}_${kind}`, t);
        return t;
      };
      const tables = {
        trades: mk('trades', [T('Timestamp'), S('Sym'), S('Side'), D('Qty'), D('Price'), D('Commission'), D('RealizedPnl')]),
        orders: mk('orders', [T('Timestamp'), S('Sym'), S('Side'), D('Qty'), S('Type'), D('Price'), S('Status')]),
        positions: mk('positions', [S('Sym'), D('Qty'), D('AvgPrice'), D('Unrealized'), T('Updated')], ['Sym']),
        signals: mk('signals', [T('Timestamp'), S('Sym'), S('Kind'), S('Name'), D('Value')]),
        equity: mk('equity', [T('Timestamp'), D('Equity'), D('Cash'), D('Drawdown')]),
      };
      const runner = new MarkerSource(engine, `backtest ${id} (worker)`, 'callback', `${a.strategy || '(unsaved)'} by ${ctx.user}, in a Web Worker`, []);
      for (const t of Object.values(tables)) t.parents = [runner];
      const capital = Number(params.capital ?? 1_000_000);
      const r: Run = {
        id, user: ctx.user, strategy: a.strategy || '(unsaved)', status: 'starting', symbols: symbols as string[],
        tables: Object.fromEntries(Object.keys(tables).map(k => [k, `bt${id}_${k}`])), worker: null, bars: 0, of: 0, trades: 0, equity: capital, pnl: 0,
        maxdd: 0, message: '', started: Date.now(), ended: null,
      };
      runs.set(id, r);
      write(r);
      // the bars it runs over: each symbol's 1-minute history
      const m1 = market.tiers.m1;
      const bars: Record<string, { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[] }> = {};
      const multipliers: Record<string, number> = {};
      for (const s of symbols as string[]) {
        const k = market.index.get(s)!;
        const a2 = m1.series[k];
        const b = { t: [] as number[], o: [] as number[], h: [] as number[], l: [] as number[], c: [] as number[], v: [] as number[] };
        for (let i = 0; i < m1.n - 1; i++) {
          if (!Number.isFinite(a2.c[i])) continue;
          b.t.push(m1.times[i]);
          b.o.push(a2.o[i]);
          b.h.push(a2.h[i]);
          b.l.push(a2.l[i]);
          b.c.push(a2.c[i]);
          b.v.push(a2.v[i]);
        }
        bars[s] = b;
        multipliers[s] = market.instrument(s)?.multiplier ?? 1;
      }
      const worker: Worker = new BacktestWorker();
      r.worker = worker;
      const finish = (status: Run['status'], message?: string) => {
        r.status = status;
        r.ended = Date.now();
        if (message) r.message = message;
        worker.terminate();
        r.worker = null;
        write(r);
      };
      const pending: Record<string, Row[]> = { trades: [], orders: [], positions: [], signals: [], equity: [] };
      const flush = () => {
        for (const [k, rows] of Object.entries(pending)) {
          if (!rows.length) continue;
          (tables as Record<string, RowSource>)[k].put(rows.map(x => ({ ...x, Timestamp: x.Timestamp != null ? instant(Number(x.Timestamp)) : undefined, Updated: x.Updated != null ? instant(Number(x.Updated)) : undefined })));
          pending[k] = [];
        }
      };
      const flusher = setInterval(flush, 200);
      worker.onmessage = (ev: MessageEvent<Row & { event: string }>) => {
        const m = ev.data;
        const { event, ...row } = m;
        switch (event) {
          case 'started':
            r.status = 'running';
            r.of = Number(m.of);
            write(r);
            break;
          case 'trade':
            pending.trades.push(row);
            break;
          case 'order':
            pending.orders.push(row);
            break;
          case 'position':
            pending.positions.push(row);
            break;
          case 'signal':
            pending.signals.push(row);
            break;
          case 'equity':
            pending.equity.push(row);
            break;
          case 'log':
            r.message = String(m.text);
            break;
          case 'progress':
            r.bars = Number(m.bars);
            r.of = Number(m.of);
            r.equity = Number(m.equity);
            r.trades = Number(m.trades);
            r.pnl = Number(m.pnl);
            r.maxdd = Number(m.maxdrawdown);
            write(r);
            break;
          case 'done':
            flush();
            clearInterval(flusher);
            finish('done');
            break;
          case 'error':
            flush();
            clearInterval(flusher);
            finish('error', String(m.message));
            break;
        }
      };
      worker.onerror = e => {
        clearInterval(flusher);
        finish('error', e.message || 'the worker failed');
      };
      worker.postMessage({ code: src, params, speed: Number(params.speed ?? 3000), bars, multipliers });
      (r as Run & { cancel?: () => void }).cancel = () => {
        flush();
        clearInterval(flusher);
        finish('cancelled', 'cancelled');
      };
      return new Reply({ run_id: id, tables: r.tables, symbols, status: r.status }, Object.values(tables));
    },
    { tables: true },
  );

  api.method('backtest_cancel', 'Stop a running backtest.', [p('run_id', 'integer')], (ctx, a) => {
    const r = runs.get(a.run_id);
    if (!r || r.user !== ctx.user) throw new ApiError(`no run ${a.run_id}`, 'not_found');
    if (r.status !== 'running' && r.status !== 'starting') return { cancelled: false };
    (r as Run & { cancel?: () => void }).cancel?.();
    return { cancelled: true };
  });
  api.method('backtest_runs', "This user's runs, newest first.", [], ctx => [...runs.values()].filter(r => r.user === ctx.user).sort((a, b) => b.id - a.id).map(info));
  api.method('backtest_engine', "Where a run's own engine is (none in the mock).", [p('run_id', 'integer')], () => {
    throw new ApiError('standalone mock: runs have no engine of their own', 'not_found');
  });
  api.method('backtest_archive', "Open a finished engine run's archive (none in the mock).", [p('run_id', 'integer')], () => {
    throw new ApiError('standalone mock: no archives', 'not_found');
  });
}
