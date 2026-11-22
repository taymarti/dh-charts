/**
 * Other engines: a panel can read from a Deephaven engine other than the page's own, e.g. the engine a
 * backtest or a deployed strategy runs in. The panel's layout stores only a reference ({ run: 123 }); an
 * EngineResolver the app provides turns it into an address and credentials when the panel opens (so keys
 * never land in saved layouts), and sessions are shared per engine and closed when no panel uses them.
 *
 *   <EngineResolverProvider resolve={ref => api.request('backtest_engine', { run_id: ref.run }).then(...)}>
 *     <Shell ... />                      // a panel with params.__engine = { run: 123 } reads from that engine
 *   </EngineResolverProvider>
 *
 * Deephaven Community answers any Origin with CORS headers (C29), so the page connects to each engine
 * directly; an engine therefore needs a key, not anonymous login.
 */
import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from 'react';
import { connect, type DeephavenSession } from '@acme/dh-bindings';
import { DeephavenProvider, message, useConnectionState, type Loaded } from './deephaven';

export interface EngineRef {
  /** a backtest or deployment run */
  run: number;
}

export interface EngineAddress {
  url: string;
  /** a pre-shared key; none: anonymous */
  psk?: string | null;
  /** false: the engine has stopped (the resolver may still return its last address) */
  up?: boolean;
}

export type EngineResolver = (ref: EngineRef) => Promise<EngineAddress>;

const PSK = 'io.deephaven.authentication.psk.PskAuthenticationHandler';
const ResolverCtx = createContext<EngineResolver | null>(null);

export function EngineResolverProvider({ resolve, children }: { resolve: EngineResolver; children?: ReactNode }) {
  return createElement(ResolverCtx.Provider, { value: resolve }, children);
}

const pool = new Map<string, { session: Promise<DeephavenSession>; refs: number; timer?: ReturnType<typeof setTimeout> }>();

/** A shared session to an engine (released with the returned function; closed 10 s after the last release). */
export function acquireEngine(addr: EngineAddress): { session: Promise<DeephavenSession>; release: () => void } {
  const key = `${addr.url}|${addr.psk ?? ''}`;
  let entry = pool.get(key);
  if (!entry) {
    const session = connect({
      serverUrl: addr.url,
      login: addr.psk ? ({ type: PSK, token: addr.psk } as never) : undefined,
    });
    entry = { session, refs: 0 };
    pool.set(key, entry);
    const mine = entry;
    session.catch(() => pool.get(key) === mine && pool.delete(key));
  }
  const mine = entry;
  clearTimeout(mine.timer);
  mine.refs++;
  let released = false;
  return {
    session: mine.session,
    release: () => {
      if (released) return;
      released = true;
      if (--mine.refs > 0) return;
      mine.timer = setTimeout(() => {
        if (mine.refs > 0 || pool.get(key) !== mine) return;
        pool.delete(key);
        mine.session.then(s => s.close()).catch(() => {});
      }, 10_000);
    },
  };
}

/** The session for an engine reference (null: none asked). */
export function useEngineSession(ref: EngineRef | null): Loaded<DeephavenSession> {
  const resolve = useContext(ResolverCtx);
  const [out, setOut] = useState<Loaded<DeephavenSession>>({ value: null, error: null });
  const key = ref ? JSON.stringify(ref) : '';
  useEffect(() => {
    setOut({ value: null, error: null });
    if (!ref) return undefined;
    if (!resolve) {
      setOut({ value: null, error: 'this app has no EngineResolverProvider' });
      return undefined;
    }
    let done = false;
    let release = () => {};
    resolve(ref)
      .then(addr => {
        if (done) return;
        if (addr.up === false) throw new Error('its engine has stopped');
        const lease = acquireEngine(addr);
        release = lease.release;
        return lease.session.then(s => !done && setOut({ value: s, error: null }));
      })
      .catch(e => !done && setOut({ value: null, error: message(e) }));
    return () => {
      done = true;
      release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolve, key]);
  return out;
}

/** Renders `children` on an engine's session (and says so when it can't be reached or stops). */
export function EngineScope({ engine, children }: { engine: EngineRef; children?: ReactNode }) {
  const { value: session, error } = useEngineSession(engine);
  if (error) return <div className="acme-error">Run {engine.run}: {error}</div>;
  if (!session) return <div className="acme-empty">connecting to run {engine.run}'s engine…</div>;
  return (
    <DeephavenProvider session={session}>
      <EngineGone run={engine.run} />
      {children}
    </DeephavenProvider>
  );
}

function EngineGone({ run }: { run: number }) {
  const { state } = useConnectionState();
  if (state === 'connected' || state === 'connecting') return null;
  // an engine that stopped (its linger ended, or it was stopped) does not come back: its archive is the way in
  return <div className="acme-engine-gone">run {run}'s engine is unreachable ({state.replace('_', ' ')}): reopen the run to read its archive</div>;
}
