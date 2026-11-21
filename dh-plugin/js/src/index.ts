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
 *
 * A host that applies the extensions itself (web/, with its own per-page choices) sets
 * globalThis.__acmeChartExtHostManaged = true before plugins load, and step 1 stays out of it.
 */
import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import { useApi } from '@deephaven/jsapi-bootstrap';
import type { ElementPlugin } from '@deephaven/plugin';
import {
  attachTvlExtensions,
  browserOwner,
  defaultExtensions,
  providePageAnnotationStore,
  subscribeRows,
  tableAnnotationStore,
  type TvlRenderer,
} from '@acme/chart-ext';
import {
  ChartLegend,
  ChartToolbar,
  Watchlist,
  injectToolbarStyles,
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

function Annotations({ table, owner }: { table: ExportedObject; owner?: string }) {
  const dh = useApi();
  useEffect(() => {
    let closed = false;
    let close = () => {};
    resolveTable(table).then(t => {
      if (closed) return;
      const store = tableAnnotationStore(dh, t as never, owner ?? browserOwner());
      const release = providePageAnnotationStore(store);
      close = () => {
        release();
        store.close();
        (t as { close?: () => void }).close?.();
      };
    });
    return () => {
      closed = true;
      close();
    };
  }, [dh, table, owner]);
  return null;
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
}

/** One chart of a workspace, with its legend. The chart comes from the plugin's "tvl-chart" events. */
function Frame({ children, title, studies, studyTypes, onStudyChange, multi, active, onActivate, syncCrosshair, syncTime }: FrameProps) {
  injectToolbarStyles();
  const el = useRef<HTMLDivElement>(null);
  const [lwc, setLwc] = useState<{ chart: IChartApi; series: ISeriesApi<SeriesType>[] } | null>(null);
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
  },
};

export default plugin;
