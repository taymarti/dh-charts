/**
 * Line charts of any table with a time column, for results rather than prices: a backtest's equity, a
 * strategy's plotted indicators, a risk metric over time.
 *
 * Two shapes of table:
 *   wide   one column per series:     { table: 'bt1_equity', columns: ['Equity'] }
 *   long   one row per time and series: { table: 'bt1_signals', split: ['Sym', 'Name'], value: 'Value', where: { Kind: 'plot' } }
 *          each distinct split value is a series of its own, filtered on the server
 *
 * `panes` puts each series (wide) or each first split value, e.g. each symbol (long), in a pane of its own.
 */
import { useEffect, useRef, useState } from 'react';
import { CrosshairMode, LineSeries, createChart, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { followTheme } from '@acme/chart-ext';
import type { dh as Dh } from '@deephaven/jsapi-types';
import type { FeedRow } from '@acme/chart-ext';
import { safeClose, subscribeRows, tableFeed, type DhApi } from '@acme/dh-bindings';
import { definePanel, type PanelProps } from '../registry';
import { message, useDeephaven, useOwnTable } from '../deephaven';

export interface SeriesPanelParams {
  table: string | null;
  time?: string;
  /** wide: the value columns */
  columns?: string[];
  /** long: the columns that name a series, the value column, and fixed filters (column: value) */
  split?: string[];
  value?: string;
  where?: Record<string, string>;
  /** a pane per series (wide) or per first split value (long) */
  panes?: boolean;
}

const COLORS = ['#2962ff', '#f7a600', '#26a69a', '#ab47bc', '#ef5350', '#00bcd4', '#8bc34a', '#ff7043', '#90a4ae', '#e91e63'];

export function seriesPanel() {
  return definePanel<SeriesPanelParams>({
    kind: 'series',
    label: 'Series chart',
    titlePrefix: 'S:',
    title: p => p.table ?? 'Series',
    description: 'Line charts of any table with a time column',
    defaultParams: { table: null },
    linkable: false,
    component: function SeriesPanel({ params }: PanelProps<SeriesPanelParams>) {
      const { value: table, error } = useOwnTable(params.table);
      if (!params.table) return <div className="acme-empty">no table set</div>;
      if (error) return <div className="acme-error">{params.table}: {error}</div>;
      if (!table) return <div className="acme-empty">loading {params.table}…</div>;
      return <SeriesChart table={table} params={params} />;
    },
  });
}

/** Rows with one per time (the last wins), in time order: Lightweight Charts rejects repeated times. */
export function oneRowPerTime(rows: FeedRow[]): FeedRow[] {
  const byTime = new Map<number, FeedRow>();
  for (const r of rows) byTime.set(r.time, r);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function whereConditions(dh: DhApi, t: Dh.Table, where: Record<string, string> = {}): Dh.FilterCondition[] {
  return Object.entries(where).map(([c, v]) => t.findColumn(c).filter().eq(dh.FilterValue.ofString(v)));
}

function SeriesChart({ table, params }: { table: Dh.Table; params: SeriesPanelParams }) {
  const { dh } = useDeephaven();
  const el = useRef<HTMLDivElement>(null);
  const [legend, setLegend] = useState<Array<{ name: string; color: string }>>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const key = JSON.stringify(params);
  useEffect(() => {
    const chart = createChart(el.current!, {
      autoSize: true,
      layout: { attributionLogo: false },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    const time = params.time ?? 'Timestamp';
    const cleanups: Array<() => void> = [followTheme(chart, el.current!)];
    let closed = false;
    const shown: Array<{ name: string; color: string }> = [];
    const panes = new Map<string, number>();
    // keep the whole series in view while results stream in, until the user scrolls or zooms
    let follow = true;
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    const refit = () => {
      if (!follow || fitTimer) return;
      fitTimer = setTimeout(() => {
        fitTimer = undefined;
        if (follow && !closed) chart.timeScale().fitContent();
      }, 250);
    };
    const stopFollowing = () => (follow = false);
    el.current!.addEventListener('wheel', stopFollowing, { passive: true });
    el.current!.addEventListener('pointerdown', stopFollowing);
    cleanups.push(() => clearTimeout(fitTimer));
    setLegend([]);
    setProblem(null);

    const draw = (name: string, source: Dh.Table, column: string, paneKey: string) => {
      const color = COLORS[shown.length % COLORS.length];
      shown.push({ name, color });
      setLegend([...shown]);
      if (!panes.has(paneKey)) panes.set(paneKey, params.panes ? panes.size : 0);
      const series: ISeriesApi<'Line'> = chart.addSeries(LineSeries, { color, lineWidth: 2, priceLineVisible: false }, panes.get(paneKey));
      const point = (r: FeedRow) => (r[column] == null ? { time: r.time as UTCTimestamp } : { time: r.time as UTCTimestamp, value: r[column] as number });
      cleanups.push(
        tableFeed(dh, source, [column], time).subscribe({
          snapshot: rows => {
            series.setData(oneRowPerTime(rows).map(point));
            refit();
          },
          update: rows => {
            oneRowPerTime(rows).forEach(r => series.update(point(r)));
            refit();
          },
          error: e => setProblem(message(e)),
        }),
      );
    };

    if (!params.split?.length) {
      // wide: one series per column, filtered by `where` if given
      const go = (t: Dh.Table) => (params.columns ?? []).forEach(c => draw(c, t, c, c));
      if (params.where && Object.keys(params.where).length) {
        void table.copy().then(copy => {
          if (closed) return safeClose(copy);
          cleanups.push(() => safeClose(copy));
          copy.applyFilter(whereConditions(dh, copy, params.where));
          go(copy);
        });
      } else go(table);
    } else {
      // long: the distinct split values (themselves live: a new symbol or plot name adds a series), one filtered copy each
      const split = params.split;
      const value = params.value ?? 'Value';
      const seen = new Set<string>();
      void table.copy().then(async scoped => {
        if (closed) return safeClose(scoped);
        cleanups.push(() => safeClose(scoped));
        scoped.applyFilter(whereConditions(dh, scoped, params.where));
        const distinct = await scoped.selectDistinct(split.map(c => scoped.findColumn(c)));
        if (closed) return safeClose(distinct);
        cleanups.push(() => safeClose(distinct));
        cleanups.push(
          subscribeRows(dh, distinct, split, rows => {
            for (const r of rows) {
              const parts = split.map(c => String(r[c] ?? ''));
              const name = parts.filter(Boolean).join(' ');
              if (seen.has(name)) continue;
              seen.add(name);
              void table.copy().then(copy => {
                if (closed) return safeClose(copy);
                cleanups.push(() => safeClose(copy));
                copy.applyFilter([
                  ...whereConditions(dh, copy, params.where),
                  ...split.map((c, i) => copy.findColumn(c).filter().eq(dh.FilterValue.ofString(parts[i]))),
                ]);
                draw(name, copy, value, parts[0]);
              });
            }
          }),
        );
      }).catch(e => !closed && setProblem(message(e)));
    }
    const node = el.current!;
    return () => {
      closed = true;
      node.removeEventListener('wheel', stopFollowing);
      node.removeEventListener('pointerdown', stopFollowing);
      cleanups.forEach(c => c());
      chart.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dh, table, key]);

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div ref={el} style={{ position: 'absolute', inset: 0 }} />
      <div className="acme-series-legend">
        {legend.map(l => (
          <span key={l.name}>
            <i style={{ background: l.color }} />
            {l.name}
          </span>
        ))}
        {problem && <span className="acme-grid-err">{problem}</span>}
      </div>
    </div>
  );
}
