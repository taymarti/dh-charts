/**
 * Brings @acme/chart-ext to Deephaven TradingView charts in any Deephaven web UI, deephaven.ui
 * dashboards included.
 *
 * 1. When the web UI loads this module, it listens on the document for the TradingView plugin's
 *    "tvl-chart" events (our fork) and applies the default extensions to every chart on the page;
 *    the crosshair group spans them all. (deephaven.ui renders plugin objects directly, never through
 *    widget middleware, so a document listener is the one place that sees every chart.)
 * 2. It exports an element plugin with these elements. `acme.chart.Toolbar` is @acme/chart-react's
 *    ChartToolbar (TradingView-style), driven from Python: the workspace passes value, options and an
 *    on_change callback (dh_chart_ext.workspace.toolbar_element). `acme.chart.Annotations`, which the workspace renders
 *    (dh_chart_ext.store.annotations_element) with the annotations table. The element draws nothing; it
 *    builds an annotation store over the table and makes it the page's store, so price lines (and later
 *    drawings) persist. `acme.chart.Frame` wraps one chart of a workspace: the legend with study rows
 *    (show/hide, settings, remove, reported to Python), the active-pane outline of a multi-chart layout,
 *    and the sync-group attributes the crosshair/time sync reads. `acme.chart.Watchlist` is the
 *    watchlist over a live quotes table, subscribed here; a click calls Python's on_select.
 *    `acme.chart.Services` provides the page's stores (annotations, alerts with their toasts) and the
 *    session calendar; `acme.chart.AlertsPanel` lists and creates alerts on the page's alert store.
 *    The Frame also binds navigation (view window, history on demand via Python, jump to now, go
 *    to date), the bar-close countdown and the market status.
 *
 * A host that applies the extensions itself (web/, with its own per-page choices) sets
 * globalThis.__acmeChartExtHostManaged = true before plugins load, and step 1 stays out of it.
 */
import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import { useApi } from '@deephaven/jsapi-bootstrap';
import type { ElementPlugin } from '@deephaven/plugin';
import {
  attachTvlExtensions,
  bindCountdown,
  bindNavigation,
  browserOwner,
  defaultExtensions,
  describeAlert,
  formatDuration,
  marketStatus,
  onPageAlertStore,
  providePageAlertStore,
  providePageAnnotationStore,
  sessionSpecFor,
  setPageSessions,
  showAlertToasts,
  type AlertStore,
  type Navigation,
  type SessionSpec,
  type TvlRenderer,
} from '@acme/chart-ext';
import { subscribeRows, tableAlertStore, tableAnnotationStore } from '@acme/dh-bindings';
import {
  AlertsPanel,
  ChartLegend,
  ChartToolbar,
  Watchlist,
  injectToolbarStyles,
  type LegendStatus,
  type LegendStudy,
  type StudyPatch,
  type StudyTypes,
  type ToolbarOptions,
  type ToolbarValue,
  type WatchlistRow,
} from '@acme/chart-react';

const g = globalThis as { __acmeChartExtHostManaged?: boolean; __acmeChartExtAttached?: boolean };
if (!g.__acmeChartExtHostManaged && !g.__acmeChartExtAttached && typeof document !== 'undefined') {
  g.__acmeChartExtAttached = true;
  attachTvlExtensions(document.documentElement, defaultExtensions());
}

/** deephaven.ui hands exported objects (tables) to element props as objects with reexport()/fetch(). */
interface ExportedObject {
  reexport?: () => Promise<{ fetch(): Promise<unknown> }>;
  fetch?: () => Promise<unknown>;
}

async function resolveTable(obj: ExportedObject): Promise<unknown> {
  if (typeof obj.reexport === 'function') return (await obj.reexport()).fetch();
  if (typeof obj.fetch === 'function') return obj.fetch();
  return obj; // already a table
}

/** Resolve `table` and run `use(t)` while mounted; `use` returns its cleanup. */
function useTable(table: ExportedObject | undefined, use: (t: unknown) => () => void, deps: unknown[]) {
  useEffect(() => {
    if (!table) return;
    let closed = false;
    let close = () => {};
    resolveTable(table).then(t => {
      if (closed) return;
      const stop = use(t);
      close = () => {
        stop();
        (t as { close?: () => void }).close?.();
      };
    });
    return () => {
      closed = true;
      close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, ...deps]);
}

/**
 * The page's chart services (draws nothing but alert notifications): the annotation store (price
 * lines, drawings), the alert store (alert lines, context-menu alerts, a toast when one of the
 * user's alerts fires) and the session calendar (shading, market status).
 */
function Services({
  annotations,
  alerts,
  sessions,
  owner,
}: {
  annotations?: ExportedObject;
  alerts?: ExportedObject;
  sessions?: Record<string, SessionSpec>;
  owner?: string;
}) {
  const dh = useApi();
  const who = owner ?? browserOwner();
  useEffect(() => {
    if (sessions) setPageSessions(sessions);
  }, [sessions]);
  useTable(
    annotations,
    t => {
      const store = tableAnnotationStore(dh, t as never, who);
      const release = providePageAnnotationStore(store);
      return () => {
        release();
        store.close();
      };
    },
    [dh, who],
  );
  useTable(
    alerts,
    t => {
      const store = tableAlertStore(dh, t as never, who);
      const release = providePageAlertStore(store);
      const stopToasts = showAlertToasts(store);
      return () => {
        stopToasts();
        release();
        store.close();
      };
    },
    [dh, who],
  );
  return null;
}

/** The earlier name: annotations only. */
function Annotations({ table, owner }: { table: ExportedObject; owner?: string }) {
  return React.createElement(Services, { annotations: table, owner });
}

/** The page alert store, as React state. */
function usePageAlertStore(): AlertStore | undefined {
  const [store, setStore] = useState<AlertStore | undefined>();
  useEffect(() => onPageAlertStore(setStore), []);
  return store;
}

/** The alerts panel, on the page's alert store: list, cancel, and create alerts on `symbol`. */
function AlertsPanelElement({
  symbol,
  sources,
}: {
  symbol?: string;
  sources?: Array<{ key: string; label: string }>;
}) {
  const store = usePageAlertStore();
  const [, redraw] = useState(0);
  useEffect(() => store?.subscribe(() => redraw(n => n + 1)), [store]);
  const rows = (store?.list() ?? [])
    .filter(a => a.status === 'active' || a.status === 'triggered')
    .map(a => ({
      id: a.id, sym: a.sym, description: describeAlert(a), message: a.message, status: a.status as 'active' | 'triggered',
      createdMs: a.createdMs, triggeredMs: a.triggeredMs, triggerValue: a.triggerValue,
    }));
  return React.createElement(AlertsPanel, {
    alerts: rows,
    symbol,
    sources,
    onCreate: store
      ? a => void store.put({ sym: a.sym, source: a.source, kind: a.source === 'Last' ? 'price' : 'study', op: a.op, level: a.level, message: a.message })
      : undefined,
    onCancel: store ? id => void store.cancel(id) : undefined,
  });
}

/** The market status for a symbol, refreshed every 15 s. */
function useMarketStatus(sym: string | undefined, spec: SessionSpec | undefined): LegendStatus | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);
  return useMemo(() => {
    const s = spec ?? sessionSpecFor(sym);
    if (!s) return undefined;
    const st = marketStatus(s, now / 1000);
    const change = st.until ? `${st.state === 'closed' ? 'opens' : st.state === 'regular' ? 'closes' : 'changes'} in ${formatDuration(st.until - now / 1000)}` : '';
    return { state: st.state, label: st.label, detail: [change, st.name].filter(Boolean).join(' · ') };
  }, [sym, spec, now]);
}

/** The toolbar, driven by Python state: onChange is the workspace's callback (a server round trip). */
function Toolbar({ value, options, onChange }: { value: ToolbarValue; options: ToolbarOptions; onChange: (patch: ToolbarValue) => void }) {
  return React.createElement(ChartToolbar, { value: value ?? {}, options: options ?? {}, onChange: patch => onChange?.(patch) });
}

interface FrameProps {
  children?: ReactNode;
  title?: string;
  studies?: LegendStudy[];
  studyTypes?: StudyTypes;
  onStudyChange?: (patch: StudyPatch) => void;
  /** part of a multi-chart layout: draw the pane border, and the active one highlighted */
  multi?: boolean;
  active?: boolean;
  onActivate?: () => void;
  /** crosshair sync group ("none": off) and time sync group (none: off); see @acme/chart-ext sync */
  syncCrosshair?: string;
  syncTime?: string;
  /** seconds to show at the end of the data (null: all of it) */
  viewWindow?: number | null;
  /** bar length, for the bar-close countdown */
  barSeconds?: number | null;
  /** the symbol's trading sessions, for the market status */
  session?: SessionSpec | null;
  /** load older data (Python widens the chart's lookback); `before`: a date to reach */
  onHistory?: (before?: number) => void;
  historyComplete?: boolean;
}

/** One chart of a workspace, with its legend. The chart comes from the plugin's "tvl-chart" events. */
function Frame({
  children, title, studies, studyTypes, onStudyChange, multi, active, onActivate, syncCrosshair, syncTime, viewWindow,
  barSeconds, session, onHistory, historyComplete,
}: FrameProps) {
  injectToolbarStyles();
  const el = useRef<HTMLDivElement>(null);
  const [lwc, setLwc] = useState<{ chart: IChartApi; series: ISeriesApi<SeriesType>[] } | null>(null);
  const status = useMarketStatus(title, session ?? undefined);

  // navigation (view window, history on demand, jump to now, go to date) and the bar countdown
  const nav = useRef<Navigation | null>(null);
  const latest = useRef({ onHistory, viewWindow, historyComplete });
  latest.current = { onHistory, viewWindow, historyComplete };
  useEffect(() => {
    if (!lwc) return;
    const host = el.current!;
    const n = bindNavigation(lwc.chart, lwc.series[0], host, {
      viewWindow: latest.current.viewWindow ?? null,
      historyComplete: latest.current.historyComplete,
      onHistory: before => latest.current.onHistory?.(before),
    });
    nav.current = n;
    const stopCountdown = barSeconds ? bindCountdown(lwc.chart, lwc.series[0], host, barSeconds) : () => {};
    return () => {
      n.dispose();
      stopCountdown();
      nav.current = null;
    };
  }, [lwc, barSeconds, title]); // a new symbol can arrive in the same plugin chart: re-apply the view
  useEffect(() => {
    nav.current?.update({ viewWindow: viewWindow ?? null, historyComplete });
  }, [viewWindow, historyComplete]);
  useEffect(() => {
    const root = el.current!;
    const take = (r: TvlRenderer) => {
      const series = r.getDataSeriesList();
      setLwc(series.length ? { chart: r.getChart(), series } : null);
    };
    const onEvent = (ev: Event) => {
      const { kind, renderer } = (ev as CustomEvent<{ kind: string; renderer: TvlRenderer }>).detail;
      if (kind === 'series') take(renderer);
      else setLwc(null);
    };
    root.addEventListener('tvl-chart', onEvent);
    root.querySelectorAll<HTMLElement>('.tv-lightweight-charts').forEach(c => {
      const host = c.parentElement as (HTMLElement & { __tvlRenderer?: TvlRenderer }) | null;
      if (host?.__tvlRenderer) take(host.__tvlRenderer);
    });
    return () => root.removeEventListener('tvl-chart', onEvent);
  }, []);
  return React.createElement(
    'div',
    {
      ref: el,
      className: `acme-frame${multi ? ' multi' : ''}${active ? ' active' : ''}`,
      'data-acme-legend': '',
      'data-acme-sync-crosshair': syncCrosshair ?? 'page',
      'data-acme-sync-time': syncTime ?? 'none',
      onMouseDownCapture: () => {
        if (multi && !active) onActivate?.();
      },
    },
    children,
    React.createElement(ChartLegend, {
      chart: lwc?.chart ?? null,
      series: lwc?.series ?? [],
      title: title ?? '',
      status,
      studies: studies ?? [],
      studyTypes,
      onStudyChange: onStudyChange ? (p: StudyPatch) => onStudyChange(p) : undefined,
    }),
  );
}

/** The watchlist over a quotes table (Sym, Last, Chg, ChgPct), live; a click calls on_select(symbol). */
function WatchlistElement({
  table,
  value,
  onSelect,
  title,
  symbolColumn = 'Sym',
}: {
  table: ExportedObject;
  value?: string;
  onSelect?: (symbol: string) => void;
  title?: string;
  symbolColumn?: string;
}) {
  const dh = useApi();
  const [rows, setRows] = useState<WatchlistRow[]>([]);
  useEffect(() => {
    let closed = false;
    let close = () => {};
    resolveTable(table).then(t => {
      if (closed) return;
      const unsubscribe = subscribeRows(dh, t as never, [symbolColumn, 'Last', 'Chg', 'ChgPct'], rs =>
        setRows(
          rs.map(r => ({
            symbol: String(r[symbolColumn]),
            last: r.Last as number,
            chg: r.Chg as number,
            chgPct: r.ChgPct as number,
          })),
        ),
      );
      close = () => {
        unsubscribe();
        (t as { close?: () => void }).close?.();
      };
    });
    return () => {
      closed = true;
      close();
    };
  }, [dh, table, symbolColumn]);
  return React.createElement(Watchlist, { rows, selected: value, onSelect: s => onSelect?.(s), title });
}

const plugin: ElementPlugin = {
  name: '@acme/dh-chart-ext',
  type: 'ElementPlugin',
  mapping: {
    'acme.chart.Annotations': Annotations as never,
    'acme.chart.Toolbar': Toolbar as never,
    'acme.chart.Frame': Frame as never,
    'acme.chart.Watchlist': WatchlistElement as never,
    'acme.chart.Services': Services as never,
    'acme.chart.AlertsPanel': AlertsPanelElement as never,
  },
};

export default plugin;
