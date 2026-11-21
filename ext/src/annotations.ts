/**
 * Annotation persistence (layer P) on the client: a store over the Deephaven annotations table
 * (dh_chart_ext.store.annotation_table), shared by every front end:
 *
 *   A  deephaven.ui         the `acme.chart.Annotations` element (dh-chart-ext) gets the table from the
 *                           workspace and calls setPageAnnotationStore(tableAnnotationStore(...))
 *   B  React + DH UI objects fetch the published table, then the same call
 *   C  React, table data    tableAnnotationStore(...) and bindPriceLines(series, store, key) directly
 *
 * The table is small (one row per annotation), so the store keeps a full subscription and serves
 * reads from memory. Writes are upserts; deletes set Deleted (soft delete), so a client needs only
 * addRow. Every change is applied locally first, then echoed back by the server.
 */
import type { dh as Dh } from '@deephaven/jsapi-types';

export interface Annotation {
  chartKey: string;
  id: string;
  kind: string;
  owner: string;
  shared: boolean;
  deleted: boolean;
  spec: Record<string, unknown>;
  updatedMs: number;
}

export interface AnnotationInput {
  chartKey: string;
  id?: string;
  kind: string;
  spec: Record<string, unknown>;
  shared?: boolean;
}

export interface AnnotationStore {
  /** Who this client writes as. */
  readonly owner: string;
  /** Visible annotations of a chart (not deleted; the owner's or shared). */
  list(chartKey: string): Annotation[];
  /** Called after any change, local or from the server. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Insert or update; returns the id. Only the owner's own annotations can be changed. */
  put(a: AnnotationInput): Promise<string>;
  remove(chartKey: string, id: string): Promise<void>;
  close(): void;
}

const COLS = ['ChartKey', 'Id', 'Kind', 'Owner', 'Shared', 'Deleted', 'Spec', 'UpdatedMs'] as const;

const num = (x: unknown) =>
  x != null && typeof x === 'object' && 'asNumber' in (x as object) ? (x as { asNumber(): number }).asNumber() : Number(x);

export function newAnnotationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A per-browser owner id, for Community servers that have no user identity (attribution only). */
export function browserOwner(): string {
  const k = 'acme.chart.owner';
  try {
    const v = localStorage.getItem(k);
    if (v) return v;
    const id = `user-${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(k, id);
    return id;
  } catch {
    return 'anonymous';
  }
}

/** A store over the annotations table (a dh.Table, already fetched). */
export function tableAnnotationStore(dh: typeof Dh, table: Dh.Table, owner: string): AnnotationStore {
  const rows = new Map<string, Annotation>(); // `${chartKey}\u0000${id}` -> row
  const listeners = new Set<() => void>();
  const k = (chartKey: string, id: string) => `${chartKey}\u0000${id}`;
  const notify = () => listeners.forEach(l => l());
  const cols = COLS.map(c => table.findColumn(c));
  const sub = table.subscribe(cols);
  sub.addEventListener(dh.Table.EVENT_UPDATED, ev => {
    const data = (ev as CustomEvent).detail as Dh.SubscriptionTableData;
    rows.clear();
    for (const it = data.fullIndex.iterator(); it.hasNext(); ) {
      const key = it.next().value;
      const g = (i: number) => data.getData(key, cols[i]);
      let spec: Record<string, unknown> = {};
      try {
        spec = JSON.parse(String(g(6) ?? '{}'));
      } catch {
        /* a malformed spec is shown as empty */
      }
      const a: Annotation = {
        chartKey: String(g(0)), id: String(g(1)), kind: String(g(2)), owner: String(g(3)),
        shared: g(4) === true, deleted: g(5) === true, spec, updatedMs: num(g(7)),
      };
      rows.set(k(a.chartKey, a.id), a);
    }
    notify();
  });
  const inputTable = table.inputTable();

  const write = async (a: Annotation) => {
    rows.set(k(a.chartKey, a.id), a); // optimistic; the server's echo replaces it
    notify();
    await (await inputTable).addRow({
      ChartKey: a.chartKey, Id: a.id, Kind: a.kind, Owner: a.owner, Shared: a.shared, Deleted: a.deleted,
      Spec: JSON.stringify(a.spec), UpdatedMs: a.updatedMs,
    });
  };

  return {
    owner,
    list: chartKey =>
      [...rows.values()].filter(a => a.chartKey === chartKey && !a.deleted && (a.shared || a.owner === owner)),
    subscribe: l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    put: async input => {
      const id = input.id ?? newAnnotationId();
      const prev = rows.get(k(input.chartKey, id));
      if (prev && prev.owner !== owner) throw new Error(`annotation ${id} belongs to ${prev.owner}`);
      await write({
        chartKey: input.chartKey, id, kind: input.kind, owner, shared: input.shared ?? prev?.shared ?? false,
        deleted: false, spec: input.spec, updatedMs: Date.now(),
      });
      return id;
    },
    remove: async (chartKey, id) => {
      const prev = rows.get(k(chartKey, id));
      if (!prev || prev.deleted) return;
      if (prev.owner !== owner) throw new Error(`annotation ${id} belongs to ${prev.owner}`);
      await write({ ...prev, deleted: true, updatedMs: Date.now() });
    },
    close: () => {
      sub.close();
      listeners.clear();
    },
  };
}

// ----------------------------------------------------------------------------- the page's store

// Several components can provide a store at once (a dashboard of workspaces each renders one); the
// most recent provider still mounted is the page's store.
const providers: AnnotationStore[] = [];
const pageWaiters = new Set<(s: AnnotationStore | undefined) => void>();
let current: AnnotationStore | undefined;

function publish() {
  const next = providers[providers.length - 1];
  if (next === current) return;
  current = next;
  pageWaiters.forEach(w => w(next));
}

/** Provide `store` as the page's annotation store until the returned release function is called. */
export function providePageAnnotationStore(store: AnnotationStore): () => void {
  providers.push(store);
  publish();
  return () => {
    const i = providers.lastIndexOf(store);
    if (i >= 0) providers.splice(i, 1);
    publish();
  };
}

/** Replace every provider with `store` (or clear the page's store): for hosts with one store. */
export function setPageAnnotationStore(store: AnnotationStore | undefined): void {
  providers.length = 0;
  if (store) providers.push(store);
  publish();
}

/** Call `cb` with the page's store now (if set) and whenever it changes. Returns an unsubscribe function. */
export function onPageAnnotationStore(cb: (s: AnnotationStore | undefined) => void): () => void {
  pageWaiters.add(cb);
  if (current) cb(current);
  return () => pageWaiters.delete(cb);
}
