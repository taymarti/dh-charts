/**
 * Client for the server's chart API (dh_chart_ext.api, published as `chart_api`): ask for a chart, get a
 * shared table back. One message stream per page; requests and replies are JSON matched by id, and a reply
 * that returns a table carries it as a reference.
 *
 *   const api = useChartApi();                       // null until the stream is open
 *   const c = await api.chart('NQ', '2m', ['EMA_20']); // c.table: a Dh.Table, c.columns: the study columns
 *   ...
 *   c.release();                                     // closes the table; the server drops its reference
 *
 * The server shares nodes between every client asking for the same chart and keeps them while someone holds
 * them, so release charts you stop showing. Closing the stream (the page) releases everything it held; the
 * client pings to keep its lease, so a page that vanishes without closing is released after the lease (90 s).
 */
import { useEffect, useState } from 'react';
import { useApi } from '@deephaven/jsapi-bootstrap';
import { useConnection } from '@deephaven/app-utils';
import type { dh as Dh } from '@deephaven/jsapi-types';

export const CHART_API_TYPE = 'acme.chart.Api';

export type StudySpec = string | { type: string; params?: Record<string, number> };

export type ChartHandle = {
  key: unknown[];
  columns: string[];
  res: string;
  table: Dh.Table;
  release(): void;
};

type Reply = { id: number; result?: any; error?: string };

export class ChartApiClient {
  private next = 1;
  private pending = new Map<number, { resolve: (r: { result: any; refs: Dh.WidgetExportedObject[] }) => void; reject: (e: Error) => void }>();
  private off: () => void;
  private pinger: ReturnType<typeof setInterval>;

  constructor(private widget: Dh.Widget, dh: typeof Dh) {
    // the server's first message: {event: 'ready', version, lease_s}; ping well inside the lease
    let lease = 90;
    try {
      lease = Number(JSON.parse(widget.getDataAsString()).lease_s) || lease;
    } catch {
      /* an older server */
    }
    this.pinger = setInterval(() => void this.call('ping').catch(() => {}), (lease / 3) * 1000);
    this.off = widget.addEventListener(dh.Widget.EVENT_MESSAGE, (e: Dh.Event<Dh.WidgetMessageDetails>) => {
      const msg = JSON.parse(e.detail.getDataAsString()) as Reply;
      const refs = e.detail.exportedObjects;
      const p = this.pending.get(msg.id);
      if (!p) {
        refs.forEach(r => r.close()); // nobody asked: don't leak the export
        return;
      }
      this.pending.delete(msg.id);
      if (msg.error != null) {
        refs.forEach(r => r.close());
        p.reject(new Error(msg.error));
      } else p.resolve({ result: msg.result, refs });
    });
  }

  call(method: string, params: Record<string, unknown> = {}) {
    const id = this.next++;
    return new Promise<{ result: any; refs: Dh.WidgetExportedObject[] }>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.widget.sendMessage(JSON.stringify({ id, method, params }), []);
    });
  }

  /** One instrument's bars at `res` ('2m', '15s', ...) with the studies' columns, shared with other clients. */
  async chart(sym: string, res: string, studies: StudySpec[] = []): Promise<ChartHandle> {
    const { result, refs } = await this.call('chart', { sym, res, studies });
    const table = (await refs[0].fetch()) as Dh.Table;
    let released = false;
    return {
      key: result.key,
      columns: result.columns,
      res: result.res,
      table,
      release: () => {
        if (released) return;
        released = true;
        table.close();
        void this.call('release', { key: result.key }).catch(() => {});
      },
    };
  }

  stats() {
    return this.call('stats').then(r => r.result);
  }

  whoami() {
    return this.call('whoami').then(r => r.result);
  }

  close() {
    clearInterval(this.pinger);
    this.off();
    this.pending.forEach(p => p.reject(new Error('chart API closed')));
    this.pending.clear();
    this.widget.close();
  }
}

/** The page's chart API client (one stream, opened on first use), or null until it is open (or with name null). */
export function useChartApi(name: string | null = 'chart_api'): ChartApiClient | null {
  const dh = useApi();
  const connection = useConnection();
  const [client, setClient] = useState<ChartApiClient | null>(null);
  useEffect(() => {
    if (name == null) return undefined;
    let closed = false;
    let c: ChartApiClient | null = null;
    connection
      .getObject({ type: CHART_API_TYPE, name } as never)
      .then(obj => {
        if (closed) return (obj as Dh.Widget).close();
        c = new ChartApiClient(obj as Dh.Widget, dh);
        (window as unknown as { chartApi?: ChartApiClient }).chartApi = c; // for the console
        setClient(c);
      })
      .catch(e => console.warn('chart API unavailable', e));
    return () => {
      closed = true;
      c?.close();
    };
  }, [dh, connection, name]);
  return client;
}
