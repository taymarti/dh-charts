/**
 * Generic panel kinds for the shell. Each is a factory taking the app's settings (who the user is, which
 * API), so an app picks the ones it wants and adds its own with definePanel.
 *
 *   chartPanel      a chart with the toolbar and legend (group C's RawWorkspace), symbol on the link bus
 *   watchlistPanel  last price and change per symbol; a click sets the linked symbol
 *   tablePanel      any published table in a DataGrid; a row click sets the linked symbol (its Sym column)
 *   requestPanel    a form for any method of a request API (from its `describe`), the reply and its tables
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { dh as Dh } from '@deephaven/jsapi-types';
import { safeClose, type ApiClient, type MethodSpec, type ParamSpec, type Row } from '@acme/dh-bindings';
import { Watchlist, useLink, type ToolbarValue, type WatchlistRow } from '@acme/chart-react';
import { definePanel, type PanelProps } from './registry';
import { message, useApiClient, useOwnTable, usePublished, useRows } from './deephaven';
import { DataGrid, type GridState } from './grid/DataGrid';
import { RawWorkspace } from './chart/RawChart';

// ----------------------------------------------------------------------------- chart

export interface ChartPanelParams {
  toolbar: ToolbarValue;
  symbol: string;
  compare: string[];
}

export interface ChartPanelOptions {
  symbols: string[];
  user: string;
  /** the chart API (null: charts from the published bars_<res> tables) */
  api?: string | null;
  annotations?: string;
  timeZone?: string;
}

export function chartPanel(o: ChartPanelOptions) {
  return definePanel<ChartPanelParams>({
    kind: 'chart',
    label: 'Chart',
    title: p => `${p.symbol} ${p.toolbar.resolution ?? ''}`.trim(),
    description: 'A chart with the toolbar and legend',
    defaultParams: { toolbar: { resolution: '1m', range: '4h', studies: ['EMA_20'], scale: 'normal' }, symbol: o.symbols[0] ?? 'ES', compare: [] },
    component: function ChartPanel({ params, setParams, setTitle, linkGroup }: PanelProps<ChartPanelParams>) {
      // the RawWorkspace keeps its own state; we only take a copy for the saved layout
      const initial = useMemo(() => ({ ...params.toolbar, symbol: params.symbol }), []); // eslint-disable-line react-hooks/exhaustive-deps
      return (
        <RawWorkspace
          symbols={o.symbols}
          annotations={o.annotations ?? 'chart_annotations'}
          user={o.user}
          initial={initial}
          initialCompare={params.compare}
          apiName={o.api === undefined ? 'chart_api' : o.api}
          timeZone={o.timeZone}
          linkGroup={linkGroup}
          sidePanel={false}
          onChange={({ value, symbol, compare }) => {
            const { addCompare: _a, addStudy: _s, ...toolbar } = value;
            setParams({ toolbar, symbol, compare });
            setTitle(`${symbol} ${toolbar.resolution ?? ''}`.trim());
          }}
        />
      );
    },
  });
}

// ----------------------------------------------------------------------------- watchlist

export function watchlistPanel(o: { table?: string } = {}) {
  return definePanel<{ table: string }>({
    kind: 'watchlist',
    title: 'Watchlist',
    description: 'Last price and change per symbol',
    defaultParams: { table: o.table ?? 'quotes' },
    component: function WatchlistPanel({ params, linkGroup }: PanelProps<{ table: string }>) {
      const { value: rows, error } = useRows(params.table, ['Sym', 'Last', 'Chg', 'ChgPct']);
      const [symbol, setSymbol] = useLink<string>('symbol', { group: linkGroup });
      if (error) return <div className="acme-error">{params.table}: {error}</div>;
      const items: WatchlistRow[] = (rows ?? []).map(r => ({ symbol: String(r.Sym), last: r.Last as number, chg: r.Chg as number, chgPct: r.ChgPct as number }));
      return <Watchlist rows={items} selected={symbol} onSelect={setSymbol} />;
    },
  });
}

// ----------------------------------------------------------------------------- table

export interface TablePanelParams extends Partial<GridState> {
  table: string | null;
  /** the column whose value a row click puts on the link bus as the symbol (default: Sym or Symbol, if any) */
  linkColumn?: string | null;
}

const TABLE_TYPES = new Set(['Table', 'TreeTable', 'HierarchicalTable', 'PartitionedTable']);

export function tablePanel() {
  return definePanel<TablePanelParams>({
    kind: 'table',
    label: 'Table',
    titlePrefix: 'T:',
    title: p => p.table ?? 'Table',
    description: 'Any published table',
    defaultParams: { table: null },
    component: function TablePanel(props: PanelProps<TablePanelParams>) {
      const { params, setParams, setTitle } = props;
      if (!params.table)
        return (
          <TablePicker
            onPick={name => {
              setParams({ table: name });
              setTitle(name);
            }}
          />
        );
      return <TableView {...props} table={params.table} />;
    },
  });
}

function TablePicker({ onPick }: { onPick: (name: string) => void }) {
  const items = usePublished().filter(i => i.type === 'Table');
  const others = usePublished().filter(i => !TABLE_TYPES.has(i.type));
  return (
    <div className="acme-picker">
      <h3>Published tables</h3>
      {items.map(i => (
        <button key={i.name} onClick={() => onPick(i.name)}>
          {i.name}
        </button>
      ))}
      {items.length === 0 && <div className="acme-empty">none yet</div>}
      {others.length > 0 && (
        <>
          <h3 style={{ marginTop: 12 }}>Other objects</h3>
          {others.map(i => (
            <div key={i.name} style={{ padding: '2px 6px', color: '#787b86' }}>
              {i.name}
              <small>{i.type}</small>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function TableView({ params, setParams, linkGroup, table }: PanelProps<TablePanelParams> & { table: string }) {
  const { value: t, error } = useOwnTable(table);
  const [symbol, setSymbol] = useLink<string | undefined>('symbol', { group: linkGroup });
  if (error) return <div className="acme-error">{table}: {error}</div>;
  if (!t) return <div className="acme-empty">loading {table}…</div>;
  const linkColumn = params.linkColumn === undefined ? t.columns.find(c => c.name === 'Sym' || c.name === 'Symbol')?.name ?? null : params.linkColumn;
  return (
    <DataGrid
      table={t}
      initial={params}
      onStateChange={s => setParams(s)}
      onRowClick={linkColumn && linkGroup ? row => row[linkColumn] != null && setSymbol(String(row[linkColumn])) : undefined}
      highlight={linkColumn && linkGroup && symbol ? row => String(row[linkColumn]) === symbol : undefined}
    />
  );
}

// ----------------------------------------------------------------------------- request form

export interface RequestPanelParams {
  method: string | null;
  values: Record<string, string>;
}

/** A form for a request API's methods, built from `describe`: types become inputs, defaults are filled in. */
export function requestPanel(o: { api?: string; user?: string } = {}) {
  const api = o.api ?? 'chart_api';
  return definePanel<RequestPanelParams>({
    kind: 'request',
    label: `Request (${api})`,
    title: p => (p.method ? `${api}.${p.method}` : api),
    description: `A form for any ${api} method`,
    defaultParams: { method: null, values: {} },
    linkable: false,
    component: function RequestPanel({ params, setParams, setTitle }: PanelProps<RequestPanelParams>) {
      const { value: client, error } = useApiClient(api, o.user ? `user:${o.user}` : undefined);
      const [methods, setMethods] = useState<MethodSpec[] | null>(null);
      useEffect(() => {
        client?.describe().then(setMethods, e => setMethods([{ name: '(describe failed)', doc: message(e), params: [], returns_tables: false }]));
      }, [client]);
      if (error) return <div className="acme-error">{api}: {error}</div>;
      if (!client || !methods) return <div className="acme-empty">connecting to {api}…</div>;
      const spec = methods.find(m => m.name === params.method) ?? null;
      return (
        <div className="acme-form-panel">
          <select
            value={params.method ?? ''}
            onChange={e => {
              setParams({ method: e.target.value || null, values: {} });
              setTitle(e.target.value ? `${api}.${e.target.value}` : api);
            }}
          >
            <option value="">Method…</option>
            {methods.map(m => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
          {spec && <RequestForm key={spec.name} client={client} spec={spec} values={params.values} onValues={values => setParams({ values })} />}
        </div>
      );
    },
  });
}

function fieldText(p: ParamSpec, v: unknown): string {
  if (v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** The form text of a parameter as the value to send (throws with a message the form shows). */
export function parseField(p: ParamSpec, text: string): unknown {
  const t = text.trim();
  if (t === '') return undefined;
  const types = p.type.split(' | ');
  if (types.includes('boolean') && /^(true|false)$/.test(t)) return t === 'true';
  if (types.includes('integer') || types.includes('number')) {
    const n = Number(t);
    if (!Number.isFinite(n)) throw new Error(`${p.name}: a number`);
    return n;
  }
  if (types.includes('array')) {
    if (t.startsWith('[')) return JSON.parse(t);
    return t.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (types.includes('object') || types.includes('any')) {
    try {
      return JSON.parse(t);
    } catch {
      if (types.includes('object')) throw new Error(`${p.name}: JSON`);
      return t;
    }
  }
  return t;
}

function RequestForm({ client, spec, values, onValues }: { client: ApiClient; spec: MethodSpec; values: Record<string, string>; onValues: (v: Record<string, string>) => void }) {
  const [reply, setReply] = useState<{ result?: unknown; error?: string; code?: string; ms?: number } | null>(null);
  const [tables, setTables] = useState<Dh.Table[]>([]);
  const [shown, setShown] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => () => tables.forEach(t => safeClose(t)), [tables]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const params: Record<string, unknown> = {};
    try {
      for (const p of spec.params) {
        const v = parseField(p, values[p.name] ?? '');
        if (v !== undefined) params[p.name] = v;
      }
    } catch (err) {
      setReply({ error: message(err), code: 'form' });
      return;
    }
    setBusy(true);
    const t0 = performance.now();
    try {
      const { result, refs } = await client.request(spec.name, params);
      const fetched = (await Promise.all(refs.map(r => r.fetch()))) as Dh.Table[];
      setTables(fetched);
      setShown(0);
      setReply({ result, ms: Math.round(performance.now() - t0) });
    } catch (err) {
      setTables([]);
      setReply({ error: message(err), code: (err as { code?: string }).code, ms: Math.round(performance.now() - t0) });
    } finally {
      setBusy(false);
    }
  };

  const key = (reply?.result as { key?: unknown } | undefined)?.key;
  return (
    <form className="acme-form" onSubmit={submit}>
      {spec.doc && <p className="acme-form-doc">{spec.doc}</p>}
      {spec.params.map(p => (
        <label key={p.name}>
          <span>
            {p.name}
            {p.required ? ' *' : ''} <small>{p.type}</small>
          </span>
          {p.type === 'boolean' ? (
            <input type="checkbox" checked={(values[p.name] ?? fieldText(p, p.default)) === 'true'} onChange={e => onValues({ ...values, [p.name]: String(e.target.checked) })} />
          ) : (
            <input
              value={values[p.name] ?? ''}
              placeholder={p.default !== undefined ? fieldText(p, p.default) : p.type === 'array' ? 'a, b, c or JSON' : ''}
              onChange={e => onValues({ ...values, [p.name]: e.target.value })}
              spellCheck={false}
            />
          )}
        </label>
      ))}
      <div className="acme-form-actions">
        <button type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Send'}
        </button>
        {key !== undefined && (
          <button type="button" onClick={() => void client.request('release', { key }).then(r => setReply(x => ({ ...x, result: { ...(x?.result as object), released: r.result } })))}>
            Release
          </button>
        )}
        {reply?.ms !== undefined && <small>{reply.ms} ms</small>}
      </div>
      {reply?.error && (
        <pre className="acme-form-error">
          {reply.code ? `[${reply.code}] ` : ''}
          {reply.error}
        </pre>
      )}
      {reply && !reply.error && <pre className="acme-form-result">{JSON.stringify(reply.result, null, 2)}</pre>}
      {tables.length > 0 && (
        <div className="acme-form-tables">
          {tables.length > 1 &&
            tables.map((_t, i) => (
              <button type="button" key={i} className={i === shown ? 'on' : ''} onClick={() => setShown(i)}>
                table {i + 1}
              </button>
            ))}
          <div className="acme-form-grid">
            <DataGrid key={shown} table={tables[shown]} />
          </div>
        </div>
      )}
    </form>
  );
}

export type { Row };
