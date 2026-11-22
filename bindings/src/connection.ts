/**
 * One Deephaven connection per page, with no @deephaven React packages: the JS API module is loaded from the
 * server itself (/jsapi/dh-core.js), so the client always matches the server's version (desk-app's pattern).
 *
 *   const session = await connect({ serverUrl: location.origin });
 *   const quotes = await session.acquireTable('quotes');   // shared, ref-counted handle
 *   const grid = await session.openTable('book');          // a private handle (its own sorts and filters)
 *   session.onState(s => ...)                              // 'connected' | 'disconnected' | 'reconnecting' | ...
 *
 * `adoptConnection(dh, connection)` wraps a connection someone else made (Deephaven's own bootstrap, in the
 * A/B app), so the same components run under either.
 *
 * Connection state comes from CoreClient's and IdeConnection's events. A dropped transport is retried by the
 * JS API itself ('disconnected', then 'reconnecting' until 'connected'); when the server restarts, the session
 * is gone and its exports with it: 'auth_failed' or 'shutdown', and the page must connect again.
 */
import type { dh as Dh } from '@deephaven/jsapi-types';

export type DhApi = typeof Dh;

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'auth_failed' | 'shutdown' | 'closed';

/** A state change, with the time it was seen (for measurements and status bars). */
export interface StateChange {
  state: ConnectionState;
  at: number;
  /** the JS API event that caused it */
  event?: string;
}

export interface ConnectOptions {
  /** the Deephaven server (or a same-origin proxy to it); default location.origin */
  serverUrl?: string;
  /** where dh-core.js is; default `${serverUrl}/jsapi/dh-core.js` */
  jsapiUrl?: string;
  /** an already loaded JS API module (tests, or a host that loaded it) */
  dh?: DhApi;
  /** credentials; default anonymous */
  login?: Dh.LoginCredentials;
}

export interface TableLease {
  table: Dh.Table;
  release(): void;
}

export interface DeephavenSession {
  readonly dh: DhApi;
  readonly connection: Dh.IdeConnection;
  /** null when the connection was adopted */
  readonly client: Dh.CoreClient | null;
  readonly state: ConnectionState;
  /** every state change since the session started (newest last) */
  readonly history: readonly StateChange[];
  /** called on every change, and once at once with the current state; returns an unsubscribe */
  onState(listener: (state: ConnectionState, change: StateChange) => void): () => void;
  /** a published table, shared by everyone who acquires the same name; closed after the last release */
  acquireTable(name: string): Promise<TableLease>;
  /** a published table on a handle of its own (sorts, filters and viewports don't affect others); close it */
  openTable(name: string): Promise<Dh.Table>;
  /** any published object by name and type (a widget, an API) */
  getObject<T = unknown>(name: string, type: string): Promise<T>;
  close(): void;
}

/** Load the JS API module from the server. */
export async function loadDh(jsapiUrl: string): Promise<DhApi> {
  const mod = await import(/* @vite-ignore */ jsapiUrl);
  return (mod.default ?? mod) as DhApi;
}

/** Connect, log in and open the IDE connection. */
export async function connect(options: ConnectOptions = {}): Promise<DeephavenSession> {
  const serverUrl = (options.serverUrl ?? globalThis.location?.origin ?? '').replace(/\/$/, '');
  const dh = options.dh ?? (await loadDh(options.jsapiUrl ?? `${serverUrl}/jsapi/dh-core.js`));
  const client = new dh.CoreClient(serverUrl);
  const session = new Session(dh, client);
  await client.login(options.login ?? ({ type: dh.CoreClient.LOGIN_TYPE_ANONYMOUS } as Dh.LoginCredentials));
  session.attach(await client.getAsIdeConnection());
  return session;
}

/** A session over a connection made elsewhere (e.g. @deephaven/app-utils' bootstrap). */
export function adoptConnection(dh: DhApi, connection: Dh.IdeConnection): DeephavenSession {
  const session = new Session(dh, null);
  session.attach(connection);
  return session;
}

class Session implements DeephavenSession {
  private _connection: Dh.IdeConnection | null = null;
  private _state: ConnectionState = 'connecting';
  readonly history: StateChange[] = [{ state: 'connecting', at: Date.now() }];
  private listeners = new Set<(s: ConnectionState, c: StateChange) => void>();
  private shared = new Map<string, { table: Promise<Dh.Table>; refs: number }>();
  private unlisten: Array<() => void> = [];

  constructor(
    readonly dh: DhApi,
    readonly client: Dh.CoreClient | null,
  ) {
    if (client) {
      const C = dh.CoreClient;
      this.on(client, C.EVENT_DISCONNECT, 'disconnected');
      this.on(client, C.EVENT_RECONNECT, 'connected');
      this.on(client, C.EVENT_RECONNECT_AUTH_FAILED, 'auth_failed');
      this.on(client, C.EVENT_REQUEST_FAILED, e => this.failed(e));
    }
  }

  get connection(): Dh.IdeConnection {
    if (!this._connection) throw new Error('not connected yet');
    return this._connection;
  }

  get state() {
    return this._state;
  }

  attach(connection: Dh.IdeConnection) {
    this._connection = connection;
    const I = this.dh.IdeConnection;
    this.on(connection, I.EVENT_DISCONNECT, 'disconnected');
    this.on(connection, I.EVENT_RECONNECT, 'connected');
    this.on(connection, I.EVENT_SHUTDOWN, 'shutdown');
    // the connection reports its own failed requests (not in the types): after a server restart, its
    // reconnect attempts fail with UNAUTHENTICATED, and no auth-failed event comes (42.6, measured)
    this.on(connection, this.dh.CoreClient.EVENT_REQUEST_FAILED ?? 'requestfailed', e => this.failed(e));
    this.set('connected');
  }

  /**
   * A failed request: the session is gone if the server no longer knows it (a restart); otherwise, while
   * disconnected, the JS API is still retrying on its own.
   */
  private failed(e: unknown): ConnectionState | null {
    if (isAuthFailure(e)) return 'auth_failed';
    return this._state === 'disconnected' ? 'reconnecting' : null;
  }

  private on(target: Dh.HasEventHandling, event: string, to: ConnectionState | ((e: unknown) => ConnectionState | null)) {
    if (!event) return; // an older JS API without this event
    const remove = target.addEventListener(event, ev => {
      const s = typeof to === 'function' ? to(ev) : to;
      if (s) this.set(s, event);
    });
    this.unlisten.push(remove);
  }

  private set(state: ConnectionState, event?: string) {
    if (state === this._state) return;
    // each failed retry is reported as a disconnect again: stay 'reconnecting'
    if (state === 'disconnected' && this._state === 'reconnecting') return;
    // nothing revives a session after these: ignore late transport events
    if (this._state === 'closed' || this._state === 'auth_failed' || this._state === 'shutdown') return;
    this._state = state;
    const change: StateChange = { state, at: Date.now(), event };
    this.history.push(change);
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200);
    for (const l of [...this.listeners]) l(state, change);
  }

  onState(listener: (s: ConnectionState, c: StateChange) => void) {
    this.listeners.add(listener);
    listener(this._state, this.history[this.history.length - 1]);
    return () => void this.listeners.delete(listener);
  }

  async acquireTable(name: string): Promise<TableLease> {
    let entry = this.shared.get(name);
    if (!entry) {
      const table = this.openTable(name);
      entry = { table, refs: 0 };
      this.shared.set(name, entry);
      // a failed fetch is not cached: the next acquire tries again
      table.catch(() => this.shared.get(name) === entry && this.shared.delete(name));
    }
    entry.refs++;
    const mine = entry;
    let table: Dh.Table;
    try {
      table = await mine.table;
    } catch (e) {
      mine.refs--;
      throw e;
    }
    let released = false;
    return {
      table,
      release: () => {
        if (released) return;
        released = true;
        if (--mine.refs > 0) return;
        if (this.shared.get(name) === mine) this.shared.delete(name);
        safeClose(table);
      },
    };
  }

  openTable(name: string): Promise<Dh.Table> {
    return this.getObject<Dh.Table>(name, this.dh.VariableType.TABLE);
  }

  getObject<T>(name: string, type: string): Promise<T> {
    return this.connection.getObject({ type, name } as Dh.ide.VariableDescriptor) as Promise<T>;
  }

  close() {
    for (const { table } of this.shared.values()) table.then(t => safeClose(t)).catch(() => {});
    this.shared.clear();
    this.unlisten.forEach(u => u());
    this.unlisten = [];
    this.set('closed');
    this.listeners.clear();
    try {
      if (this.client) this.client.disconnect();
      else this._connection?.close();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Close a JS API object, ignoring errors: once the session's transport is gone (a server restart), the
 * 42.6 JS API's close() throws synchronously ("Cannot read properties of null (reading 'webSocket')"),
 * which inside a React effect cleanup would take the whole tree down.
 */
export function safeClose(x: { close(): void } | null | undefined): void {
  try {
    x?.close();
  } catch {
    /* the session is gone: nothing to release on the server */
  }
}

/** Whether a requestfailed event says the server rejected the session (it restarted, or the login expired). */
export function isAuthFailure(e: unknown): boolean {
  const d = (e as { detail?: unknown } | null)?.detail ?? e;
  const text = d instanceof Error ? d.message : typeof d === 'string' ? d : JSON.stringify(d ?? '') ?? '';
  return /UNAUTHENTICATED|Authentication details invalid/i.test(String(d) + ' ' + text);
}

/** Unwrap the JS API's value wrappers: DateWrapper to Date, LongWrapper to number, BigDecimal/BigInteger to number. */
export function toPlain(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value;
  const v = value as { asDate?: () => Date; asNumber?: () => number; doubleValue?: () => number };
  if (typeof v.asDate === 'function') return v.asDate();
  if (typeof v.asNumber === 'function') return v.asNumber();
  if (typeof v.doubleValue === 'function') return v.doubleValue();
  return value;
}
