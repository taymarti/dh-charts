/**
 * The Deephaven session as React context, and hooks over it. Components take the session from context, never
 * from @deephaven/app-utils, so they run under our own connection (`connect`, the shell app) and under
 * Deephaven's bootstrap (`adoptConnection(useApi(), useConnection())`, the A/B app) alike.
 *
 *   <DeephavenProvider session={session}> ... </DeephavenProvider>
 *   const { table } = useTableLease('quotes');           // shared handle
 *   const rows = useRows('quotes', ['Sym', 'Last']);     // live rows of a small table
 *   const { client } = useApiClient('chart_api', 'user:alice');   // one stream per page and name
 */
import { createContext, createElement, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { dh as Dh } from '@deephaven/jsapi-types';
import { openApi, safeClose, subscribeRows, type ApiClient, type ConnectionState, type DeephavenSession, type Row, type StateChange } from '@acme/dh-bindings';

const Ctx = createContext<DeephavenSession | null>(null);

export function DeephavenProvider({ session, children }: { session: DeephavenSession; children?: ReactNode }) {
  return createElement(Ctx.Provider, { value: session }, children);
}

/**
 * Connects, provides the session, and when the server drops it (a restart: 'auth_failed' or 'shutdown')
 * connects again and remounts `children` on the new session. What the app keeps outside React state (the
 * shell's autosaved layout, the link bus if passed in) comes back; server-side holds are re-requested by the
 * remounted components.
 *
 *   <DeephavenRoot connect={() => connect({ serverUrl: location.origin })}> <App /> </DeephavenRoot>
 */
export function DeephavenRoot({
  connect,
  children,
  retryMs = 3000,
  status = defaultStatus,
}: {
  connect: () => Promise<DeephavenSession>;
  children?: ReactNode;
  retryMs?: number;
  status?: (text: string, error: boolean) => ReactNode;
}) {
  const [session, setSession] = useState<DeephavenSession | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let stopped = false;
    let current: DeephavenSession | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      connect().then(
        s => {
          if (stopped) return s.close();
          current = s;
          (globalThis as { dhSession?: DeephavenSession }).dhSession = s; // for the console
          setProblem(null);
          setSession(s);
          setGeneration(g => g + 1);
          s.onState(st => {
            if (stopped || s !== current || (st !== 'auth_failed' && st !== 'shutdown')) return;
            current = null;
            // unmount the app first (its cleanups run while the session object still exists), then close
            setSession(null);
            setProblem('the server dropped the session; reconnecting…');
            setTimeout(() => s.close(), 0);
            timer = setTimeout(attempt, 500);
          });
        },
        e => {
          if (stopped) return;
          setProblem(`Deephaven is not reachable (${message(e)}); retrying…`);
          timer = setTimeout(attempt, retryMs);
        },
      );
    };
    attempt();
    return () => {
      stopped = true;
      clearTimeout(timer);
      current?.close();
    };
  }, [connect, retryMs]);
  if (!session) return status(problem ?? 'connecting…', problem != null);
  return createElement(Ctx.Provider, { key: generation, value: session }, children);
}

const defaultStatus = (text: string, error: boolean) =>
  createElement('div', { style: { color: error ? '#ef5350' : '#787b86', padding: 16, font: '13px sans-serif' } }, text);

/** The page's session (throws outside a DeephavenProvider). */
export function useDeephaven(): DeephavenSession {
  const s = useContext(Ctx);
  if (!s) throw new Error('useDeephaven needs a <DeephavenProvider>');
  return s;
}

/** The session, or null outside a provider (for components that also work without Deephaven). */
export function useOptionalDeephaven(): DeephavenSession | null {
  return useContext(Ctx);
}

/** The connection's state, re-rendering on every change. */
export function useConnectionState(): { state: ConnectionState; last: StateChange | undefined } {
  const s = useOptionalDeephaven();
  const state = useSyncExternalStore(
    cb => (s ? s.onState(() => cb()) : () => {}),
    () => (s ? s.state : 'closed'),
  );
  return { state, last: s?.history[s.history.length - 1] };
}

export interface Loaded<T> {
  value: T | null;
  error: string | null;
}

/** A published table on the page's shared handle (null name: nothing). */
export function useTableLease(name: string | null): Loaded<Dh.Table> {
  const s = useDeephaven();
  const [out, setOut] = useState<Loaded<Dh.Table>>({ value: null, error: null });
  useEffect(() => {
    setOut({ value: null, error: null });
    if (!name) return undefined;
    let release: (() => void) | null = null;
    let done = false;
    s.acquireTable(name).then(
      lease => {
        if (done) return lease.release();
        release = lease.release;
        setOut({ value: lease.table, error: null });
      },
      e => !done && setOut({ value: null, error: message(e) }),
    );
    return () => {
      done = true;
      release?.();
    };
  }, [s, name]);
  return out;
}

/** A published table on a handle of its own (for sorting and filtering), closed on unmount. */
export function useOwnTable(name: string | null): Loaded<Dh.Table> {
  const s = useDeephaven();
  const [out, setOut] = useState<Loaded<Dh.Table>>({ value: null, error: null });
  useEffect(() => {
    setOut({ value: null, error: null });
    if (!name) return undefined;
    let table: Dh.Table | null = null;
    let done = false;
    s.openTable(name).then(
      t => {
        if (done) return safeClose(t);
        table = t;
        setOut({ value: t, error: null });
      },
      e => !done && setOut({ value: null, error: message(e) }),
    );
    return () => {
      done = true;
      safeClose(table);
    };
  }, [s, name]);
  return out;
}

/** Every row of a small live table (a watchlist's quotes), re-rendering on each update. */
export function useRows(name: string | null, columns: string[]): Loaded<Row[]> {
  const s = useDeephaven();
  const { value: table, error } = useTableLease(name);
  const [rows, setRows] = useState<Row[] | null>(null);
  const key = columns.join(',');
  useEffect(() => {
    setRows(null);
    if (!table) return undefined;
    return subscribeRows(s.dh, table, columns, setRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, table, key]);
  return { value: rows, error };
}

// One API stream per session and name, shared by every component that asks for it, closed after the last.
const apis = new WeakMap<DeephavenSession, Map<string, { client: Promise<ApiClient>; refs: number; token?: string }>>();

/**
 * The page's client for a published request API (rpc.Api). `token` is sent as `hello` when the stream opens
 * (the first caller's token wins; Community has no identity: 'user:<name>' is unverified).
 */
export function useApiClient(name: string | null, token?: string): Loaded<ApiClient> {
  const s = useDeephaven();
  const [out, setOut] = useState<Loaded<ApiClient>>({ value: null, error: null });
  useEffect(() => {
    setOut({ value: null, error: null });
    if (!name) return undefined;
    let byName = apis.get(s);
    if (!byName) apis.set(s, (byName = new Map()));
    let entry = byName.get(name);
    if (!entry) {
      const client = openApi(s.dh, s.connection, name).then(async c => {
        if (token) await c.hello(token).catch(e => console.warn(`${name}: hello failed`, e));
        return c;
      });
      entry = { client, refs: 0, token };
      byName.set(name, entry);
      const mine = entry;
      client.catch(() => byName!.get(name) === mine && byName!.delete(name));
    }
    entry.refs++;
    const mine = entry;
    let done = false;
    mine.client.then(
      c => !done && setOut({ value: c, error: null }),
      e => !done && setOut({ value: null, error: message(e) }),
    );
    return () => {
      done = true;
      if (--mine.refs > 0) return;
      if (byName!.get(name) === mine) byName!.delete(name);
      mine.client.then(c => c.close()).catch(() => {});
    };
  }, [s, name, token]);
  return out;
}

/**
 * The names and types of the server's published objects (the console scope), live: tables, widgets, APIs.
 * The catalog a "pick a table" menu offers.
 */
export function usePublished(): Array<{ name: string; type: string }> {
  const s = useDeephaven();
  const [items, setItems] = useState<Array<{ name: string; type: string }>>([]);
  useEffect(() => {
    const byId = new Map<string, { name: string; type: string }>();
    const conn = s.connection as Dh.IdeConnection;
    return conn.subscribeToFieldUpdates(changes => {
      for (const d of changes.removed) byId.delete(d.id ?? d.title ?? '');
      for (const d of [...changes.created, ...changes.updated]) byId.set(d.id ?? d.title ?? '', { name: d.title ?? '', type: d.type });
      setItems([...byId.values()].filter(v => v.name).sort((a, b) => a.name.localeCompare(b.name)));
    });
  }, [s]);
  return items;
}

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
