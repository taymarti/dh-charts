/**
 * The AlertStore (@acme/chart-ext) over the server's alerts table (dh_chart_ext.alerts.alert_table).
 * Writes are input-table upserts; the server's AlertEngine evaluates the alerts and writes back the
 * ones that fire.
 */
import type { dh as Dh } from '@deephaven/jsapi-types';
import { safeClose } from './connection';
import { newAnnotationId, type Alert, type AlertKind, type AlertOp, type AlertStatus, type AlertStore } from '@acme/chart-ext';

const COLS = [
  'Id', 'Owner', 'Sym', 'Source', 'Kind', 'Op', 'Level', 'T0', 'P0', 'T1', 'P1', 'DrawingId', 'Message', 'Status',
  'CreatedMs', 'TriggeredMs', 'TriggerValue',
] as const;

const num = (x: unknown): number | null => {
  if (x == null) return null;
  const v = typeof x === 'object' && 'asNumber' in (x as object) ? (x as { asNumber(): number }).asNumber() : Number(x);
  return Number.isFinite(v) ? v : null;
};
const str = (x: unknown) => (x == null ? null : String(x));

export function tableAlertStore(dh: typeof Dh, table: Dh.Table, owner: string): AlertStore {
  const rows = new Map<string, Alert>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(l => l());
  const cols = COLS.map(c => table.findColumn(c));
  const sub = table.subscribe(cols);
  sub.addEventListener(dh.Table.EVENT_UPDATED, ev => {
    const data = (ev as CustomEvent).detail as Dh.SubscriptionTableData;
    rows.clear();
    for (const it = data.fullIndex.iterator(); it.hasNext(); ) {
      const k = it.next().value;
      const g = (i: number) => data.getData(k, cols[i]);
      const a: Alert = {
        id: String(g(0)), owner: String(g(1)), sym: String(g(2)), source: str(g(3)) ?? 'Last',
        kind: (str(g(4)) ?? 'price') as AlertKind, op: (str(g(5)) ?? 'cross') as AlertOp, level: num(g(6)),
        t0: num(g(7)), p0: num(g(8)), t1: num(g(9)), p1: num(g(10)), drawingId: str(g(11)), message: str(g(12)) ?? '',
        status: (str(g(13)) ?? 'active') as AlertStatus, createdMs: num(g(14)) ?? 0, triggeredMs: num(g(15)),
        triggerValue: num(g(16)),
      };
      rows.set(a.id, a);
    }
    notify();
  });
  const inputTable = table.inputTable();

  const write = async (a: Alert) => {
    rows.set(a.id, a); // optimistic; the server's echo replaces it
    notify();
    await (await inputTable).addRow({
      Id: a.id, Owner: a.owner, Sym: a.sym, Source: a.source, Kind: a.kind, Op: a.op, Level: a.level, T0: a.t0, P0: a.p0,
      T1: a.t1, P1: a.p1, DrawingId: a.drawingId, Message: a.message, Status: a.status, CreatedMs: a.createdMs,
      TriggeredMs: a.triggeredMs, TriggerValue: a.triggerValue,
    } as never);
  };

  return {
    owner,
    list: () =>
      [...rows.values()].filter(a => a.owner === owner && a.status !== 'cancelled').sort((x, y) => y.createdMs - x.createdMs),
    active: sym => [...rows.values()].filter(a => a.owner === owner && a.sym === sym && a.status === 'active'),
    subscribe: l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    put: async input => {
      const id = input.id ?? newAnnotationId();
      const prev = rows.get(id);
      if (prev && prev.owner !== owner) throw new Error(`alert ${id} belongs to ${prev.owner}`);
      await write({
        id, owner, sym: input.sym, source: input.source ?? 'Last', kind: input.kind, op: input.op ?? 'cross',
        level: input.level ?? null, t0: input.line?.t0 ?? null, p0: input.line?.p0 ?? null, t1: input.line?.t1 ?? null,
        p1: input.line?.p1 ?? null, drawingId: input.drawingId ?? null, message: input.message ?? '', status: 'active',
        createdMs: prev?.createdMs ?? Date.now(), triggeredMs: null, triggerValue: null,
      });
      return id;
    },
    cancel: async id => {
      const prev = rows.get(id);
      if (!prev || prev.owner !== owner || prev.status === 'cancelled') return;
      await write({ ...prev, status: 'cancelled' });
    },
    close: () => {
      safeClose(sub);
      listeners.clear();
    },
  };
}

