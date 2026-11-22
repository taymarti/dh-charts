/**
 * tableFeed: a SeriesFeed (@acme/chart-ext) over a Deephaven table with a time column, from a full
 * Barrage subscription. The first update is a snapshot; later ones are added and modified rows. A
 * removal (a lookback window moving forward), or a change before the last row (older history arriving),
 * becomes a new snapshot, since Lightweight Charts only updates at or after its last bar.
 *
 *   const feed = tableFeed(dh, table, ['Open', 'High', 'Low', 'Close', 'EMA_20']);
 *   bindFeed(chart, feed, layout);
 *
 * Times are read from `timeColumn` (an Instant: nanoseconds) and delivered as UTC seconds. Long and
 * date wrappers are unwrapped to numbers; nulls stay null (gaps).
 */
import type { dh as Dh } from '@deephaven/jsapi-types';
import { applyChanges, type FeedListener, type FeedRow, type SeriesFeed } from '@acme/chart-ext';

const num = (x: unknown): number | null => {
  if (x == null) return null;
  const v = typeof x === 'object' && 'asNumber' in (x as object) ? (x as { asNumber(): number }).asNumber() : Number(x);
  return Number.isFinite(v) ? v : null;
};

type RangeSet = { size: number; iterator(): { hasNext(): boolean; next(): { value: unknown } } };

function keys(rs: RangeSet | undefined): unknown[] {
  const out: unknown[] = [];
  if (!rs) return out;
  for (const it = rs.iterator(); it.hasNext(); ) out.push(it.next().value);
  return out;
}

export function tableFeed(dh: typeof Dh, table: Dh.Table, columns: string[], timeColumn = 'Timestamp'): SeriesFeed {
  return {
    columns,
    subscribe(listener: FeedListener) {
      const tcol = table.findColumn(timeColumn);
      const vcols = columns.map(c => table.findColumn(c));
      const sub = table.subscribe([tcol, ...vcols]);
      const current = new Map<number, FeedRow>();
      let first = true;
      const read = (data: Dh.SubscriptionTableData, k: unknown): FeedRow | null => {
        const t = num(data.getData(k as never, tcol));
        if (t == null) return null;
        const row: FeedRow = { time: Math.floor(t / 1e9) } as FeedRow;
        vcols.forEach((c, i) => ((row as Record<string, number | null>)[columns[i]] = num(data.getData(k as never, c))));
        return row;
      };
      const all = (data: Dh.SubscriptionTableData) => {
        current.clear();
        for (const k of keys(data.fullIndex as unknown as RangeSet)) {
          const r = read(data, k);
          if (r) current.set(r.time, r);
        }
        return [...current.values()].sort((a, b) => a.time - b.time);
      };
      sub.addEventListener(dh.Table.EVENT_UPDATED, ev => {
        try {
          const data = (ev as CustomEvent).detail as Dh.SubscriptionTableData;
          const removed = (data as unknown as { removed?: RangeSet }).removed;
          if (first || (removed && removed.size > 0)) {
            first = false;
            listener.snapshot(all(data));
            return;
          }
          const rows = (rs: unknown) => keys(rs as RangeSet).map(k => read(data, k)).filter((r): r is FeedRow => r != null);
          const change = applyChanges(current, {
            added: rows((data as unknown as { added: RangeSet }).added),
            modified: rows((data as unknown as { modified: RangeSet }).modified),
            removedTimes: [],
          });
          if (change.snapshot) listener.snapshot(change.rows);
          else if (change.rows.length) listener.update(change.rows);
        } catch (e) {
          listener.error?.(e);
        }
      });
      return () => sub.close();
    },
  };
}
