/**
 * Deephaven connection and a minimal "append stream" over a ticking table, with no @deephaven React
 * packages: the JS API module comes from the server (/jsapi/dh-core.js, proxied same-origin).
 *
 * streamTable() makes a full Barrage subscription and hands the caller each update's newly added
 * rows as plain arrays (time in epoch ms, values as numbers). The benchmark feeds are append-only,
 * so added rows are all a chart needs.
 */
import type { dh as Dh } from '@deephaven/jsapi-types';

export type DhApi = typeof Dh;

async function connect(): Promise<{ dh: DhApi; connection: Dh.IdeConnection }> {
  const origin = window.location.origin;
  const mod = await import(/* @vite-ignore */ `${origin}/jsapi/dh-core.js`);
  const dh: DhApi = mod.default;
  const client = new dh.CoreClient(origin);
  await client.login({ type: dh.CoreClient.LOGIN_TYPE_ANONYMOUS });
  return { dh, connection: await client.getAsIdeConnection() };
}

export const deephaven = connect();

export interface Batch {
  /** epoch milliseconds (fractional), ascending */
  t: Float64Array;
  /** one array per requested value column */
  v: Float64Array[];
  /** true for the first batch (the snapshot) */
  snapshot: boolean;
}

function num(x: unknown): number {
  if (x != null && typeof x === 'object' && typeof (x as { asNumber?: () => number }).asNumber === 'function') {
    return (x as { asNumber: () => number }).asNumber();
  }
  return x as number;
}

function sortByTime(t: Float64Array, v: Float64Array[]): void {
  const order = Array.from(t.keys()).sort((a, b) => t[a] - t[b]);
  const t2 = order.map(i => t[i]);
  t.set(t2);
  for (const col of v) col.set(order.map(i => col[i]));
}

/** Subscribe to `name` and call onBatch with each update's added rows. Returns a close function. */
export async function streamTable(
  name: string,
  timeCol: string,
  valueCols: string[],
  onBatch: (b: Batch) => void,
  updateIntervalMs?: number,
): Promise<() => void> {
  const { dh, connection } = await deephaven;
  const table = (await connection.getObject({ type: dh.VariableType.TABLE, name })) as Dh.Table;
  const tc = table.findColumn(timeCol);
  const vcs = valueCols.map(c => table.findColumn(c));
  const sub = (table.subscribe as (cols: Dh.Column[], interval?: number) => Dh.TableSubscription)(
    [tc, ...vcs],
    updateIntervalMs,
  );
  let first = true;
  sub.addEventListener(dh.Table.EVENT_UPDATED, ev => {
    const data = (ev as CustomEvent).detail as Dh.SubscriptionTableData;
    // added rows, plus modified ones (an aggregated bar table updates its last bar in place)
    const sets = first ? [data.added] : [data.added, data.modified];
    const n = sets.reduce((s, r) => s + r.size, 0);
    if (n === 0 && !first) return;
    const t = new Float64Array(n);
    const v = vcs.map(() => new Float64Array(n));
    let i = 0;
    for (const rs of sets) {
      for (const it = rs.iterator(); it.hasNext(); ) {
        const key = it.next().value;
        // DateTime columns arrive as DateWrapper: asNumber() is epoch nanoseconds
        t[i] = num(data.getData(key, tc)) / 1e6;
        for (let c = 0; c < vcs.length; c++) v[c][i] = num(data.getData(key, vcs[c]));
        i++;
      }
    }
    if (sets.length > 1 && data.modified.size > 0) sortByTime(t, v);
    onBatch({ t, v, snapshot: first });
    first = false;
  });
  return () => {
    sub.close();
    table.close();
  };
}
