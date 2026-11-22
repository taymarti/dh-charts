/**
 * A trader's strategies and backtests (dh_chart_ext.backtests on a request API):
 *   - the strategies they own, to flip through; an editor with the problems the server's checks find
 *   - Run: the code runs in its own process (the CEP); its results stream into the run's tables
 *   - their runs with progress and P&L; Open lays out a run's results as tabs: equity, trades, orders,
 *     positions, the strategy's plots, and a price chart per symbol
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { definePanel, type PanelProps } from '../registry';
import { message, useApiClient } from '../deephaven';

export interface RunInfo {
  run_id: number;
  strategy: string;
  status: 'starting' | 'running' | 'done' | 'error' | 'cancelled';
  tables: Partial<Record<'trades' | 'orders' | 'positions' | 'signals' | 'equity' | 'prices' | 'run_info', string>>;
  symbols: string[];
  /** a run in an engine of its own: where it is (its key comes from backtest_engine), and whether it is up */
  engine?: { url: string | null; up: boolean } | null;
  /** its Parquet archive exists (backtest_archive opens it) */
  archive?: boolean;
  bars: number;
  of: number;
  trades: number;
  equity: number;
  pnl: number;
  maxdrawdown: number;
  message: string;
  started: number;
  ended: number | null;
}

interface StrategiesParams {
  /** the strategy open in the editor */
  name: string | null;
}

const money = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });

export function strategiesPanel(o: { api?: string; user?: string } = {}) {
  const apiName = o.api ?? 'chart_api';
  return definePanel<StrategiesParams>({
    kind: 'strategies',
    label: 'Strategies',
    title: 'Strategies',
    description: 'Write, save and backtest strategies; open their results',
    defaultParams: { name: null },
    linkable: false,
    component: function StrategiesPanel({ params, setParams, openPanel }: PanelProps<StrategiesParams>) {
      const { value: api, error } = useApiClient(apiName, o.user ? `user:${o.user}` : undefined);
      const [list, setList] = useState<Array<{ name: string; saved_at: number }>>([]);
      const [name, setName] = useState(params.name ?? '');
      const [code, setCode] = useState('');
      const [paramsText, setParamsText] = useState('');
      const [problems, setProblems] = useState<string[]>([]);
      const [runs, setRuns] = useState<RunInfo[]>([]);
      const [note, setNote] = useState<string | null>(null);
      const [busy, setBusy] = useState(false);
      const dirty = useRef(false);
      const [ownEngine, setOwnEngine] = useState(false);
      const waitFor = useRef<number | null>(null); // an engine run to open as soon as its engine is up

      const refresh = useCallback(() => {
        api?.request<Array<{ name: string; saved_at: number }>>('strategies').then(r => setList(r.result), () => {});
      }, [api]);

      const load = useCallback(
        async (n: string | null) => {
          if (!api) return;
          try {
            const r = n
              ? (await api.request<{ name: string; code: string; params: object }>('strategy_load', { name: n })).result
              : { name: '', ...(await api.request<{ code: string; params: object }>('strategy_example')).result };
            setName(r.name);
            setCode(r.code);
            setParamsText(JSON.stringify(r.params, null, 2));
            setParams({ name: r.name || null });
            dirty.current = false;
          } catch (e) {
            setNote(message(e));
          }
        },
        [api, setParams],
      );

      useEffect(() => {
        if (!api) return;
        refresh();
        void load(params.name);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [api]);

      // the server's checks, as the trader types
      useEffect(() => {
        if (!api || !code) return undefined;
        const t = setTimeout(() => {
          api.request<{ problems: string[] }>('strategy_check', { code }).then(r => setProblems(r.result.problems), () => {});
        }, 500);
        return () => clearTimeout(t);
      }, [api, code]);

      // runs: poll while any is active (a few rows; the backtest_runs table has every user's)
      const pollRuns = useCallback(() => {
        api?.request<RunInfo[]>('backtest_runs').then(r => setRuns(r.result), () => {});
      }, [api]);
      // lingering engines stop on their own: refresh now and then so Open picks the archive
      useEffect(() => {
        const t = setInterval(pollRuns, 15_000);
        return () => clearInterval(t);
      }, [pollRuns]);
      const active = runs.some(r => r.status === 'starting' || r.status === 'running');
      useEffect(() => {
        const r = runs.find(x => x.run_id === waitFor.current);
        if (r?.engine?.up) {
          waitFor.current = null;
          void openResults(r);
        } else if (r && r.status !== 'starting' && r.status !== 'running') waitFor.current = null;
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [runs]);
      useEffect(() => {
        pollRuns();
        if (!active) return undefined;
        const t = setInterval(pollRuns, 1000);
        return () => clearInterval(t);
      }, [pollRuns, active]);

      const parsedParams = (): Record<string, unknown> | null => {
        try {
          const p = JSON.parse(paramsText || '{}');
          if (p && typeof p === 'object' && !Array.isArray(p)) return p;
        } catch {
          /* below */
        }
        setNote('Parameters must be a JSON object, e.g. {"symbols": ["ES"]}');
        return null;
      };

      const save = async () => {
        const p = parsedParams();
        if (!api || !p) return;
        if (!name.trim()) return setNote('Name the strategy to save it');
        try {
          const r = await api.request<{ problems: string[] }>('strategy_save', { name: name.trim(), code, params: p });
          setParams({ name: name.trim() });
          dirty.current = false;
          setNote(r.result.problems.length ? 'Saved, with problems: it will not run until they are fixed' : `Saved "${name.trim()}"`);
          refresh();
        } catch (e) {
          setNote(message(e));
        }
      };

      const remove = async () => {
        if (!api || !params.name) return;
        await api.request('strategy_delete', { name: params.name }).catch(e => setNote(message(e)));
        refresh();
        void load(null);
      };

      /**
       * A run's results as a floating group of tabs. Where they are read from:
       *   central mode         the run's tables on this server (bt<N>_*)
       *   engine, running      the run's own engine (panels carry __engine; the shell connects with its key)
       *   engine, stopped      its Parquet archive, opened on this server (arc<N>_*)
       */
      const openResults = async (run: RunInfo) => {
        let t = run.tables;
        let engine: { run: number } | null = null;
        let where = '';
        if (run.engine) {
          const live = run.engine.up || !run.archive;
          if (live) {
            engine = { run: run.run_id };
            where = ' (engine)';
          } else {
            try {
              t = (await api!.request<{ tables: RunInfo['tables'] }>('backtest_archive', { run_id: run.run_id })).result.tables;
              where = ' (archive)';
            } catch (e) {
              return setNote(message(e));
            }
          }
        }
        const syms = run.symbols ?? [];
        const label = `bt${run.run_id}`;
        const on = (p: Record<string, unknown>) => ({ ...p, __link: null, __engine: engine });
        // a large floating group of tabs, over the layout; the trader docks it where they like
        const first = openPanel('table', on({ table: t.trades }), `${label} trades${where}`, { floating: 0.8 });
        if (!first) return;
        const tab = (kind: string, p: Record<string, unknown>, title: string) => openPanel(kind, on(p), title, { referencePanel: first, direction: 'within' });
        tab('table', { table: t.orders }, `${label} orders`);
        tab('table', { table: t.positions }, `${label} positions`);
        tab('series', { table: t.signals, split: ['Sym', 'Name'], value: 'Value', where: { Kind: 'plot' }, panes: true }, `${label} signals`);
        if (t.prices) {
          // engine runs publish the bars they saw; a chart of them works without the central chart API
          tab('series', { table: t.prices, split: ['Sym'], value: 'Close', panes: true }, `${label} prices`);
        } else {
          for (const s of syms) tab('chart', { symbol: s, toolbar: { resolution: '1m', range: 'all', studies: [], scale: 'normal' }, compare: [] }, s);
        }
        if (t.run_info) tab('table', { table: t.run_info }, `${label} run`);
        tab('series', { table: t.equity, columns: ['Equity'] }, `${label} equity`); // last: the active tab
      };

      const run = async () => {
        const p = parsedParams();
        if (!api || !p) return;
        if (problems.length) return setNote('Fix the problems first');
        setBusy(true);
        try {
          const { result } = await api.request<{ run_id: number; tables: RunInfo['tables']; symbols: string[] }>('backtest_submit', {
            code,
            strategy: params.name && !dirty.current ? params.name : name.trim() || '',
            params: ownEngine ? { ...p, engine: true } : p,
          });
          setNote(ownEngine ? `Run bt${result.run_id}: starting its engine (30-60 s)` : `Run bt${result.run_id} started`);
          const info = { run_id: result.run_id, tables: result.tables, symbols: result.symbols } as RunInfo;
          if (ownEngine) {
            // open the results once the engine is up (the runs list shows the progress meanwhile)
            waitFor.current = result.run_id;
            pollRuns();
            return;
          }
          void openResults(info);
          pollRuns();
        } catch (e) {
          setNote(message(e));
        } finally {
          setBusy(false);
        }
      };

      const tabKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key !== 'Tab') return;
        e.preventDefault();
        const ta = e.currentTarget;
        const { selectionStart: a, selectionEnd: b } = ta;
        const next = code.slice(0, a) + '    ' + code.slice(b);
        setCode(next);
        dirty.current = true;
        requestAnimationFrame(() => (ta.selectionStart = ta.selectionEnd = a + 4));
      };

      if (error) return <div className="acme-error">{apiName}: {error}</div>;
      if (!api) return <div className="acme-empty">connecting to {apiName}…</div>;
      return (
        <div className="acme-strategies">
          <aside>
            <button className="acme-strat-new" onClick={() => void load(null)}>
              + New from example
            </button>
            {list.map(s => (
              <button key={s.name} className={s.name === params.name ? 'on' : ''} onClick={() => void load(s.name)}>
                {s.name}
              </button>
            ))}
            {list.length === 0 && <div className="acme-empty">no saved strategies</div>}
          </aside>
          <section>
            <div className="acme-strat-bar">
              <input value={name} placeholder="Strategy name" onChange={e => setName(e.target.value)} maxLength={64} />
              <button onClick={() => void save()}>Save</button>
              {params.name && <button onClick={() => void remove()}>Delete</button>}
              <label className="acme-strat-engine" title="Run in an engine of its own, as a CEP deployment does; results are archived when it ends">
                <input type="checkbox" checked={ownEngine} onChange={e => setOwnEngine(e.target.checked)} /> Own engine
              </label>
              <button className="acme-strat-run" onClick={() => void run()} disabled={busy || problems.length > 0}>
                {busy ? 'Starting…' : 'Run backtest'}
              </button>
              <span className="acme-strat-note">{note}</span>
            </div>
            <div className="acme-strat-edit">
              <textarea
                className="acme-strat-code"
                value={code}
                spellCheck={false}
                onKeyDown={tabKey}
                onChange={e => {
                  setCode(e.target.value);
                  dirty.current = true;
                }}
              />
              <div className="acme-strat-side">
                <label>Parameters (JSON)</label>
                <textarea className="acme-strat-params" value={paramsText} spellCheck={false} onChange={e => setParamsText(e.target.value)} />
                <div className={problems.length ? 'acme-strat-problems bad' : 'acme-strat-problems'}>
                  {problems.length ? problems.map(p => <div key={p}>{p}</div>) : 'No problems found'}
                </div>
                <details className="acme-strat-help">
                  <summary>The strategy API</summary>
                  <pre>{HELP}</pre>
                </details>
              </div>
            </div>
            <div className="acme-strat-runs">
              <table>
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Strategy</th>
                    <th>Status</th>
                    <th>Progress</th>
                    <th>Trades</th>
                    <th>P&amp;L</th>
                    <th>Max DD</th>
                    <th>Where</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {runs.map(r => (
                    <tr key={r.run_id} title={r.message || undefined}>
                      <td>bt{r.run_id}</td>
                      <td>{r.strategy}</td>
                      <td className={`st-${r.status}`}>{r.status}</td>
                      <td>
                        <span className="acme-strat-progress">
                          <span style={{ width: `${r.of ? Math.min(100, (100 * r.bars) / r.of) : 0}%` }} />
                        </span>
                      </td>
                      <td>{r.trades}</td>
                      <td className={r.pnl >= 0 ? 'up' : 'down'}>{money.format(r.pnl)}</td>
                      <td>{(r.maxdrawdown * 100).toFixed(2)}%</td>
                      <td title={r.engine?.url ?? undefined}>
                        {r.engine
                          ? r.engine.up
                            ? <span className="up">● engine</span>
                            : r.archive
                              ? 'archive'
                              : r.status === 'starting'
                                ? 'engine starting'
                                : 'engine stopped'
                          : 'central'}
                      </td>
                      <td>
                        <button onClick={() => void openResults(r)}>Open</button>
                        {r.engine?.up && r.status === 'done' && (
                          <button onClick={() => void api.request('backtest_cancel', { run_id: r.run_id }).then(pollRuns)} title="Stop its engine; the archive stays">
                            Stop engine
                          </button>
                        )}
                        {(r.status === 'running' || r.status === 'starting') && (
                          <button onClick={() => void api.request('backtest_cancel', { run_id: r.run_id }).then(pollRuns)}>Cancel</button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {runs.length === 0 && (
                    <tr>
                      <td colSpan={9} className="acme-empty">
                        no runs yet
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              {runs.find(r => r.status === 'error') && <div className="acme-grid-err">{runs.find(r => r.status === 'error')!.message}</div>}
            </div>
          </section>
        </div>
      );
    },
  });
}

const HELP = `on_start(ctx)          optional, once
on_bar(ctx, bar)       every bar of every symbol, in time order
on_end(ctx)            optional, once

bar.sym  bar.time (ns)  bar.open  bar.high  bar.low  bar.close  bar.volume

ctx.param(name, default)    from Parameters
ctx.state                   a dict for your own state
ctx.ema(key, length, value) ctx.sma(key, length, value)
ctx.buy(sym, qty)  ctx.sell(sym, qty)  ctx.target(sym, qty)
                            market orders, filled at the bar's close
ctx.position(sym)  ctx.avg_price(sym)  ctx.cash  ctx.equity
ctx.plot(name, value, sym)  a line on the signals tab
ctx.signal(sym, name, value)
ctx.log(text)

Parameters: symbols (required), capital, commission (per unit),
speed (bars per second the results stream at), and your own.
Imports: math, statistics. No files, network, or names starting with _.`;
