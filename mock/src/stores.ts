/**
 * The server's persistent state, with this browser's localStorage standing in for the server's disk:
 * annotations (price lines, drawings), alerts with the engine that evaluates them, and workspaces and
 * strategies per user. Same schemas as dh_chart_ext.store / alerts / workspaces, so the shell's stores
 * (tableAnnotationStore, tableAlertStore, apiWorkspaceStore) work unchanged.
 */
import { makeStudy } from '@acme/chart-ext';
import { Engine, RowSource, B, D, L, S, type Row } from './engine';
import type { MockServer } from './dh';
import type { BarMarket as Market } from './market';
import { MarkerSource } from './markers';
import type { NodeCache } from './nodes';

let PREFIX = 'acme.mock.';

/** Where this page keeps the mock server's state in localStorage: one prefix per app (default "acme.mock."). */
export function setStoragePrefix(prefix: string) {
  PREFIX = prefix;
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: kept for this session only */
  }
}

function persisted(engine: Engine, server: MockServer, name: string, cols: ReturnType<typeof S>[], keyCols: string[], description: string, seed: Row[] = []) {
  const t = new RowSource(engine, name, cols, { keyCols, input: true, kind: 'source', description });
  const stored = load<Row[] | null>(name, null);
  t.put(stored ?? seed);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => save(name, t.all());
  t.onWrite = () => {
    clearTimeout(timer);
    timer = setTimeout(flush, 300);
  };
  server.publishTable(name, t);
  return { table: t, flush };
}

// ----------------------------------------------------------------------------- annotations

/** An annotation someone else saved and shared, as a seed row for annotationTable. */
export function sharedAnnotation(chartKey: string, id: string, kind: 'price_line' | 'drawing', spec: object, owner = 'desk-strategist'): Row {
  return { ChartKey: chartKey, Id: id, Kind: kind, Owner: owner, Shared: true, Deleted: false, Spec: JSON.stringify(spec), UpdatedMs: Date.now() };
}

/** `chart_annotations` (dh_chart_ext.store's schema), kept in this browser; `seed` fills it the first time. */
export function annotationTable(engine: Engine, server: MockServer, seed: Row[] = []) {
  return persisted(
    engine, server, 'chart_annotations',
    [S('ChartKey'), S('Id'), S('Kind'), S('Owner'), B('Shared'), B('Deleted'), S('Spec'), L('UpdatedMs')],
    ['ChartKey', 'Id'], 'price lines and drawings per chart, per user (input table)', seed,
  );
}

// ----------------------------------------------------------------------------- alerts

export function alertTable(engine: Engine, server: MockServer, market: Market, nodes: NodeCache, parents: { quotes: RowSource }) {
  const { table } = persisted(
    engine, server, 'chart_alerts',
    [S('Id'), S('Owner'), S('Sym'), S('Source'), S('Kind'), S('Op'), D('Level'), D('T0'), D('P0'), D('T1'), D('P1'), S('DrawingId'), S('Message'), S('Status'), L('CreatedMs'), L('TriggeredMs'), D('TriggerValue')],
    ['Id'], 'alerts (input table); the engine writes back the ones that fire',
  );
  const engineNode = new MarkerSource(engine, 'alert engine', 'callback', 'evaluates every active alert each cycle against the last price, a drawn line or a study value', [table, parents.quotes]);
  const prevSide = new Map<string, number>();
  // a study source "EMA_20@1m" holds a chart node for as long as some alert needs it
  const held = new Map<string, { release: () => void; node: ReturnType<NodeCache['acquire']>['node'] }>();

  const studyValue = (sym: string, source: string): number => {
    const [col, res = '1m'] = source.split('@');
    const study = col.replace(/_(Upper|Mid|Lower|Signal|Hist|K|D)$/, '');
    const key = `${sym}|${study}|${res}`;
    let h = held.get(key);
    if (!h) {
      try {
        makeStudy(study);
        const a = nodes.acquire(sym, res, [study]);
        h = { release: a.release, node: a.node };
        held.set(key, h);
      } catch {
        return NaN;
      }
    }
    const v = h.node.data[col];
    return v && h.node.n ? v[h.node.n - 1] : NaN;
  };

  engine.addTicker('alert engine', now => {
    const t0 = performance.now();
    const want = new Set<string>();
    let n = 0;
    for (const k of table.keys()) {
      const r = table.row(k)!;
      if (r.Status !== 'active') continue;
      n++;
      const sym = String(r.Sym);
      const source = String(r.Source ?? 'Last');
      let value = source === 'Last' ? market.value(sym) : studyValue(sym, source);
      if (source !== 'Last') want.add(`${sym}|${source.split('@')[0].replace(/_(Upper|Mid|Lower|Signal|Hist|K|D)$/, '')}|${source.split('@')[1] ?? '1m'}`);
      let level = Number(r.Level);
      if (r.Kind === 'line' && r.T0 != null && r.T1 != null && Number(r.T1) !== Number(r.T0)) {
        const t = now / 1000;
        level = Number(r.P0) + ((Number(r.P1) - Number(r.P0)) * (t - Number(r.T0))) / (Number(r.T1) - Number(r.T0));
      }
      if (!Number.isFinite(value) || !Number.isFinite(level)) continue;
      const side = Math.sign(value - level) || 0;
      const id = String(r.Id);
      const before = prevSide.get(id);
      prevSide.set(id, side);
      if (before == null || before === side || side === 0) continue;
      const up = side > 0;
      const op = String(r.Op);
      if (op === 'cross' || (op === 'above' && up) || (op === 'below' && !up)) {
        table.put([{ ...r, Status: 'triggered', TriggeredMs: now, TriggerValue: value }]);
        table.onWrite?.([]);
        console.info(`alert ${id} fired: ${sym} ${source} ${up ? 'up' : 'down'} through ${level}`);
      }
    }
    for (const [k, h] of held)
      if (!want.has(k)) {
        h.release();
        held.delete(k);
      }
    engineNode.tick(performance.now() - t0, n);
  });
  return table;
}

// ----------------------------------------------------------------------------- per-user documents (workspaces, strategies)

export class UserDocs<T> {
  constructor(private kind: string) {}
  private all(): Record<string, Record<string, { value: T; saved_at: number }>> {
    return load(this.kind, {});
  }
  list(user: string) {
    return Object.entries(this.all()[user] ?? {})
      .map(([name, d]) => ({ name, saved_at: d.saved_at }))
      .sort((a, b) => b.saved_at - a.saved_at);
  }
  get(user: string, name: string): { value: T; saved_at: number } | undefined {
    return this.all()[user]?.[name];
  }
  put(user: string, name: string, value: T) {
    const all = this.all();
    (all[user] ??= {})[name] = { value, saved_at: Date.now() };
    save(this.kind, all);
    return all[user][name].saved_at;
  }
  remove(user: string, name: string) {
    const all = this.all();
    const had = !!all[user]?.[name];
    if (had) delete all[user][name];
    save(this.kind, all);
    return had;
  }
}
