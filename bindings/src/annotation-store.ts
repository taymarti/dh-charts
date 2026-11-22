/**
 * The AnnotationStore (@acme/chart-ext) over the Deephaven annotations table
 * (dh_chart_ext.store.annotation_table).
 *
 * The table is small (one row per annotation), so the store keeps a full subscription and serves
 * reads from memory. Writes are upserts; deletes set Deleted (soft delete), so a client needs only
 * addRow. Every change is applied locally first, then echoed back by the server.
 */
import type { dh as Dh } from '@deephaven/jsapi-types';
import { newAnnotationId, type Annotation, type AnnotationStore } from '@acme/chart-ext';

const COLS = ['ChartKey', 'Id', 'Kind', 'Owner', 'Shared', 'Deleted', 'Spec', 'UpdatedMs'] as const;

const num = (x: unknown) =>
  x != null && typeof x === 'object' && 'asNumber' in (x as object) ? (x as { asNumber(): number }).asNumber() : Number(x);

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

