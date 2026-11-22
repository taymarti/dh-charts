/**
 * The link bus: values that widgets share (symbol, interval, time range, account), per link group,
 * so a watchlist, a blotter and a chart can drive one another without knowing about each other. Like
 * TradingView's symbol link groups: widgets in the same group follow each other; another group, or none,
 * is independent.
 *
 *   const bus = createLinkBus();
 *   <LinkProvider bus={bus}> ... </LinkProvider>
 *
 *   const [symbol, setSymbol] = useLink<string>('symbol', { group: 'red', initial: 'ES' });  // any widget
 *
 * The core (createLinkBus) has no React in it, so non-React code (a chart plugin, a test) can use it.
 */
import { createContext, createElement, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';

export interface LinkBus {
  get<T = unknown>(group: string, key: string): T | undefined;
  /** set a value; listeners of (group, key) are told, with the setter's `source` (to ignore its own echo) */
  set<T = unknown>(group: string, key: string, value: T, source?: unknown): void;
  subscribe(group: string, key: string, listener: (value: unknown, source?: unknown) => void): () => void;
  /** the group's values, for saving a workspace */
  snapshot(group: string): Record<string, unknown>;
  /** restore saved values (each listener told once) */
  restore(group: string, values: Record<string, unknown>): void;
}

/** Link groups with a color each, as a picker would show them. */
export const LINK_GROUPS = [
  { key: 'red', color: '#ef5350' },
  { key: 'green', color: '#26a69a' },
  { key: 'blue', color: '#2962ff' },
  { key: 'orange', color: '#ff9800' },
] as const;

export function createLinkBus(initial: Record<string, Record<string, unknown>> = {}): LinkBus {
  const values = new Map<string, Map<string, unknown>>(Object.entries(initial).map(([g, v]) => [g, new Map(Object.entries(v))]));
  const listeners = new Map<string, Set<(value: unknown, source?: unknown) => void>>();
  const id = (group: string, key: string) => `${group}\u0000${key}`;
  const groupOf = (g: string) => {
    let m = values.get(g);
    if (!m) values.set(g, (m = new Map()));
    return m;
  };
  const tell = (group: string, key: string, value: unknown, source?: unknown) =>
    listeners.get(id(group, key))?.forEach(l => l(value, source));
  return {
    get: <T,>(group: string, key: string) => values.get(group)?.get(key) as T | undefined,
    set(group, key, value, source) {
      const m = groupOf(group);
      if (m.has(key) && Object.is(m.get(key), value)) return;
      m.set(key, value);
      tell(group, key, value, source);
    },
    subscribe(group, key, listener) {
      const k = id(group, key);
      let s = listeners.get(k);
      if (!s) listeners.set(k, (s = new Set()));
      s.add(listener);
      return () => {
        s!.delete(listener);
      };
    },
    snapshot: group => Object.fromEntries(values.get(group) ?? []),
    restore(group, v) {
      const m = groupOf(group);
      for (const [key, value] of Object.entries(v)) {
        if (Object.is(m.get(key), value)) continue;
        m.set(key, value);
        tell(group, key, value);
      }
    },
  };
}

const LinkContext = createContext<LinkBus | null>(null);

/** Gives the widgets below it a link bus (one per page or workspace). */
export function LinkProvider({ bus, children }: { bus: LinkBus; children?: ReactNode }) {
  return createElement(LinkContext.Provider, { value: bus }, children);
}

/** The page's link bus (throws outside a LinkProvider). */
export function useLinkBus(): LinkBus {
  const bus = useContext(LinkContext);
  if (!bus) throw new Error('useLink needs a <LinkProvider bus={createLinkBus()}> above it');
  return bus;
}

/**
 * A linked value: [value, set]. With group null the value is the widget's own (not linked), kept in a
 * private group per hook so the widget works the same either way.
 */
export function useLink<T>(key: string, opts: { group?: string | null; initial?: T } = {}): [T, (v: T) => void] {
  const bus = useLinkBus();
  const own = useMemo(() => `own-${Math.random().toString(36).slice(2)}`, []);
  const group = opts.group === undefined ? 'default' : opts.group ?? own;
  if (opts.initial !== undefined && bus.get(group, key) === undefined) bus.set(group, key, opts.initial);
  const value = useSyncExternalStore(
    cb => bus.subscribe(group, key, cb),
    () => bus.get<T>(group, key) as T,
  );
  const set = useCallback((v: T) => bus.set(group, key, v), [bus, group, key]);
  return [value, set];
}
