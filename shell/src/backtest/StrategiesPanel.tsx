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
  tables: Record<'trades' | 'orders' | 'positions' | 'signals' | 'equity', string>;
  symbols: string[];
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
      const active = runs.some(r => r.status === 'starting' || r.status === 'running');
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

      const openResults = (run: RunInfo) => {
        const t = run.tables;
        const syms = run.symbols ?? [];
        const label = `bt${run.run_id}`;
        // a large floating group of tabs, over the layout; the trader docks it where they like
        const first = openPanel('table', { table: t.trades, __link: null }, `${label} trades`, { floating: 0.8 });
        if (!first) return;
        const tab = (kind: string, p: Record<string, unknown>, title: string) => openPanel(kind, p, title, { referencePanel: first, direction: 'within' });
        tab('table', { table: t.orders, __link: null }, `${label} orders`);
        tab('table', { table: t.positions, __link: null }, `${label} positions`);
        tab('series', { table: t.signals, split: ['Sym', 'Name'], value: 'Value', where: { Kind: 'plot' }, panes: true }, `${label} signals`);
        for (const s of syms) tab('chart', { symbol: s, toolbar: { resolution: '1m', range: 'all', studies: [], scale: 'normal' }, compare: [], __link: null }, s);
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
            params: p,
          });
          setNote(`Run bt${result.run_id} started`);
          const info = { run_id: result.run_id, tables: result.tables, symbols: result.symbols } as RunInfo;
          openResults(info);
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
                      <td>
                        <button onClick={() => openResults(r)}>Open</button>
                        {(r.status === 'running' || r.status === 'starting') && (
                          <button onClick={() => void api.request('backtest_cancel', { run_id: r.run_id }).then(pollRuns)}>Cancel</button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {runs.length === 0 && (
                    <tr>
                      <td colSpan={8} className="acme-empty">
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
