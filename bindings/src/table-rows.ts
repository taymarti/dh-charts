/**
 * subscribeRows: every row of a small live table (a watchlist's quotes), as plain objects, on each
 * update. Numbers come back as numbers (Deephaven's long and date wrappers are unwrapped), so React
 * components can render them directly. Meant for tables of tens to hundreds of rows.
 */
import type { dh as Dh } from '@deephaven/jsapi-types';
import { safeClose } from './connection';

export type Row = Record<string, unknown>;

const plain = (x: unknown) =>
  x != null && typeof x === 'object' && 'asNumber' in (x as object) ? (x as { asNumber(): number }).asNumber() : x;

export function subscribeRows(dh: typeof Dh, table: Dh.Table, columns: string[], onRows: (rows: Row[]) => void): () => void {
  const cols = columns.map(c => table.findColumn(c));
  const sub = table.subscribe(cols);
  sub.addEventListener(dh.Table.EVENT_UPDATED, ev => {
    const data = (ev as CustomEvent).detail as Dh.SubscriptionTableData;
    const rows: Row[] = [];
    for (const it = data.fullIndex.iterator(); it.hasNext(); ) {
      const k = it.next().value;
      const r: Row = {};
      cols.forEach((c, i) => (r[columns[i]] = plain(data.getData(k, c))));
      rows.push(r);
    }
    onRows(rows);
  });
  return () => safeClose(sub);
}
