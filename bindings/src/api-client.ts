/**
 * Client for a server request API (dh_chart_ext.rpc.Api, e.g. the published `chart_api`): JSON requests
 * over one plugin message stream, replies matched by id; a reply that returns tables carries them as
 * references. Framework-agnostic (no React); see web/src/chartApi.ts for a hook.
 *
 *   const api = await openApi(dh, connection, 'chart_api');
 *   await api.hello(token);                                  // optional: who the user is
 *   const { result, tables } = await api.request('chart', { sym: 'NQ', res: '2m' });
 *   ...
 *   api.close();                                             // the server releases what this stream held
 *
 * The server sends {event: 'ready', version, lease_s, methods} first. The client pings every lease_s / 3,
 * so the server keeps what this stream holds; a page that vanishes without closing is released after
 * the lease.
 */
import type { dh as Dh } from '@deephaven/jsapi-types';

export const API_TYPE = 'acme.Api';

export interface ApiReady {
  event: 'ready';
  version: number;
  lease_s: number;
  methods?: string[];
}

export class ApiError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiReply<R = unknown> {
  result: R;
  /** the reply's table references, unfetched: fetch() each (or close() it) */
  refs: Dh.WidgetExportedObject[];
}

/** One parameter of a method, as `describe` reports it. */
export interface ParamSpec {
  name: string;
  type: string;
  required: boolean;
  default?: unknown;
  doc?: string;
}

export interface MethodSpec {
  name: string;
  doc: string;
  params: ParamSpec[];
  returns_tables: boolean;
}

type Pending = { resolve: (r: ApiReply<any>) => void; reject: (e: Error) => void };

export class ApiClient {
  readonly ready: ApiReady;
  private next = 1;
  private pending = new Map<number, Pending>();
  private off: () => void;
  private pinger: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private widget: Dh.Widget, dh: typeof Dh) {
    let ready: ApiReady = { event: 'ready', version: 1, lease_s: 90 };
    try {
      ready = { ...ready, ...JSON.parse(widget.getDataAsString()) };
    } catch {
      /* an empty or older first message */
    }
    this.ready = ready;
    this.off = widget.addEventListener(dh.Widget.EVENT_MESSAGE, (e: Dh.Event<Dh.WidgetMessageDetails>) =>
      this.onMessage(e.detail.getDataAsString(), e.detail.exportedObjects),
    );
    this.pinger = setInterval(() => void this.request('ping').catch(() => {}), (ready.lease_s / 3) * 1000);
  }

  /** Handle one message from the server (public for tests). */
  onMessage(text: string, refs: Dh.WidgetExportedObject[]): void {
    let msg: { id?: number; result?: unknown; error?: string; code?: string };
    try {
      msg = JSON.parse(text);
    } catch {
      refs.forEach(r => r.close());
      return;
    }
    const p = msg.id != null ? this.pending.get(msg.id) : undefined;
    if (!p) {
      refs.forEach(r => r.close()); // nobody is waiting: don't leak the exports
      return;
    }
    this.pending.delete(msg.id!);
    if (msg.error != null) {
      refs.forEach(r => r.close());
      p.reject(new ApiError(msg.error, msg.code));
    } else p.resolve({ result: msg.result, refs });
  }

  request<R = unknown>(method: string, params: Record<string, unknown> = {}): Promise<ApiReply<R>> {
    if (this.closed) return Promise.reject(new ApiError('the API stream is closed', 'closed'));
    const id = this.next++;
    return new Promise<ApiReply<R>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.widget.sendMessage(JSON.stringify({ id, method, params }), []);
    });
  }

  /** Request and fetch the reply's tables (every reference is fetched as a table). */
  async requestTables<R = unknown>(method: string, params: Record<string, unknown> = {}): Promise<{ result: R; tables: Dh.Table[] }> {
    const { result, refs } = await this.request<R>(method, params);
    const tables = (await Promise.all(refs.map(r => r.fetch()))) as Dh.Table[];
    return { result, tables };
  }

  /** Tell the server who the user is (a token it verifies). */
  hello(token?: string): Promise<{ user: string; verified: boolean }> {
    return this.request<{ user: string; verified: boolean }>('hello', token ? { token } : {}).then(r => r.result);
  }

  /** The server's methods and their parameters. */
  describe(): Promise<MethodSpec[]> {
    return this.request<MethodSpec[]>('describe').then(r => r.result);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pinger);
    this.off();
    this.pending.forEach(p => p.reject(new ApiError('the API stream is closed', 'closed')));
    this.pending.clear();
    this.widget.close();
  }
}

/** Open the published API object `name` (type acme.Api). */
export async function openApi(dh: typeof Dh, connection: Dh.IdeConnection, name: string): Promise<ApiClient> {
  const widget = (await connection.getObject({ type: API_TYPE, name } as never)) as Dh.Widget;
  return new ApiClient(widget, dh);
}
