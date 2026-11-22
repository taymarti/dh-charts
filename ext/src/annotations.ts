/**
 * Annotation persistence (layer P) on the client: the AnnotationStore interface and the page's store.
 * The implementation over the Deephaven annotations table (dh_chart_ext.store.annotation_table) is
 * @acme/dh-bindings' tableAnnotationStore; every front end uses it:
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
