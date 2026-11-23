/**
 * Things for the shell's top bar (its `extra`):
 *
 *   ThemeSwitch    pick one of the app's themes: sets html[data-theme], remembers it, and tells the charts
 *   ApiStatus      the server's chip: the round trip to the app's API (its `stats` method) every few seconds
 */
import { useEffect, useState, type ReactNode } from 'react';
import { notifyThemeChange } from '@acme/chart-ext';
import { useApiClient } from './deephaven';

export interface ThemeChoice {
  key: string;
  label: string;
  /** a CSS background for the swatch */
  swatch: string;
}

/** The theme the page was left on (from `storageKey`), set on html[data-theme] before the first render. */
export function restoreTheme(storageKey: string, fallback: string): string {
  let t = fallback;
  try {
    t = localStorage.getItem(storageKey) ?? fallback;
  } catch {
    /* not kept */
  }
  document.documentElement.dataset.theme = t;
  return t;
}

/** Buttons for the app's themes: html[data-theme] is the app's CSS hook; every chart re-reads its colours. */
export function ThemeSwitch({ themes, storageKey }: { themes: ThemeChoice[]; storageKey: string }) {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? themes[0]?.key);
  const pick = (t: string) => {
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem(storageKey, t);
    } catch {
      /* not kept */
    }
    setTheme(t);
    notifyThemeChange();
  };
  return (
    <span className="acme-theme" title="Chart and panel theme">
      {themes.map(t => (
        <button key={t.key} className={theme === t.key ? 'on' : ''} onClick={() => pick(t.key)}>
          <i style={{ background: t.swatch }} />
          {t.label}
        </button>
      ))}
    </span>
  );
}

/**
 * The server's chip: `label` (e.g. DEEPHAVEN), the round trip to the API's `stats` method, the time and `who`.
 * Red when the API doesn't answer. `title` is the tooltip; the API's stream and node counts are added to it.
 */
export function ApiStatus({ api, user, label, who, title }: { api: string; user: string; label: string; who?: ReactNode; title?: string }) {
  const client = useApiClient(api, `user:${user}`).value;
  const [s, setS] = useState<{ ms: number; nodes: number; streams: number } | null>(null);
  const [down, setDown] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!client) return;
    let live = true;
    const poll = () => {
      const t0 = performance.now();
      client
        .request<{ streams: number; nodes: unknown }>('stats')
        .then(r => {
          if (!live) return;
          const n = r.result.nodes as { entries?: unknown[] } | unknown[];
          setS({ ms: performance.now() - t0, streams: r.result.streams, nodes: Array.isArray(n) ? n.length : Array.isArray(n?.entries) ? n.entries.length : 0 });
          setDown(false);
        })
        .catch(() => live && setDown(true));
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [client]);
  return (
    <span className={`acme-status${down ? ' down' : ''}`} title={`${title ?? ''}${s ? `\n${s.streams} API streams, ${s.nodes} shared chart nodes` : ''}`}>
      <b className="ok">{label}</b> {down ? 'unreachable' : s ? `${s.ms.toFixed(0)} ms` : '…'} · {new Date().toLocaleTimeString([], { hourCycle: 'h23' })}
      {who != null && <> · {who}</>}
    </span>
  );
}
