/**
 * Data hooks for panels, on top of the session in context (deephaven.tsx):
 *
 *   requestOnce(client, method, params)     a request whose answer doesn't change (a catalog): one per page
 *   useFilteredRows(table, where, columns)  the live rows of a published table, filtered on the server
 *   usePolled(client, method, params, ms)   a request repeated every `ms` (and when params change)
 */
import { useEffect, useState } from 'react';
import type { dh as Dh } from '@deephaven/jsapi-types';
import { safeClose, subscribeRows, type ApiClient, type Row } from '@acme/dh-bindings';
import { useDeephaven } from './deephaven';

const once = new Map<string, Promise<unknown>>();

/** The result of `method(params)`, asked once per page and shared (a failure is forgotten, so it is asked again). */
export function requestOnce<T>(client: ApiClient, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const key = method + JSON.stringify(params);
  let p = once.get(key) as Promise<T> | undefined;
  if (!p) {
    p = client.request<T>(method, params).then(r => r.result);
    once.set(key, p);
    p.catch(() => once.delete(key));
  }
  return p;
}

/** Forget requestOnce's answers for methods starting with `method`, so the next call asks again. */
export const forgetRequests = (method: string) => [...once.keys()].filter(k => k.startsWith(method)).forEach(k => once.delete(k));

/** The live rows of a published table filtered on the server (column = value), re-rendering on each update. */
export function useFilteredRows(table: string | null, where: Record<string, string>, columns: string[]): Row[] | null {
  const { dh, connection } = useDeephaven();
  const [rows, setRows] = useState<Row[] | null>(null);
  const key = JSON.stringify([table, where, columns]);
  useEffect(() => {
    setRows(null);
    if (!table) return;
    let t: Dh.Table | null = null;
    let stop = () => {};
    let done = false;
    (connection.getObject({ type: dh.VariableType.TABLE, name: table } as never) as Promise<Dh.Table>).then(
      tt => {
        if (done) return safeClose(tt);
        t = tt;
        const conds = Object.entries(where).map(([c, v]) => tt.findColumn(c).filter().eq(dh.FilterValue.ofString(v)));
        if (conds.length) tt.applyFilter(conds);
        stop = subscribeRows(dh, tt, columns, setRows);
      },
      () => setRows([]),
    );
    return () => {
      done = true;
      stop();
      safeClose(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dh, connection, key]);
  return rows;
}

/** Request `method` every `ms` (and when params change); the latest result, and the last error. */
export function usePolled<T>(client: ApiClient | null, method: string, params: Record<string, unknown> | null, ms: number): { value: T | null; error: string | null } {
  const [out, setOut] = useState<{ value: T | null; error: string | null }>({ value: null, error: null });
  const key = JSON.stringify(params);
  useEffect(() => {
    if (!client || !params) return;
    let done = false;
    const go = () =>
      client.request<T>(method, params).then(
        r => !done && setOut({ value: r.result, error: null }),
        e => !done && setOut(o => ({ value: o.value, error: e.message ?? String(e) })),
      );
    void go();
    const t = ms > 0 ? setInterval(go, ms) : undefined;
    return () => {
      done = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, method, key, ms]);
  return out;
}
