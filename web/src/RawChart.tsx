/**
 * Front-end group C: a React chart that uses only table data. No Deephaven UI objects, no Deephaven chart
 * plugin, no hook: the JS API reads a published L0 table (bars_<res>, every symbol, standard studies),
 * filters it to one symbol on the server, and this component draws its own Lightweight Charts chart.
 * Our LWC plugins from @acme/chart-ext attach to it directly.
 *
 *   ?raw=bars_1m&sym=ES&studies=EMA_20,BB_20_2_Upper,BB_20_2_Lower
 *
 * RawWorkspace adds @acme/chart-react's ChartToolbar on top, with plain React state: symbol, interval
 * (which bars_<res> table), overlay indicators (which study columns), and scale. No server round trip
 * beyond re-subscribing: the studies are the published standard set's columns.
 *
 * Price lines and drawings persist through the same annotations table as the other front ends (bindPriceLines on
 * our own series, chart key = the symbol), so a line drawn here shows on every ES chart and vice versa.
 *
 * Bars arrive as Barrage deltas: a new bar is an added row, the forming bar a modified row; both go
 * through series.update(), which LWC handles incrementally for the last bar.
 */
import { useEffect, useRef, useState } from 'react';
import { useApi } from '@deephaven/jsapi-bootstrap';
import { useConnection } from '@deephaven/app-utils';
import type { dh as Dh } from '@deephaven/jsapi-types';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  PriceScaleMode,
  type IChartApi,
  createChart,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { TimeRangeShading, alternatingBlocks, bindDrawings, bindLegend, bindPriceLines, tableAnnotationStore } from '@acme/chart-ext';
import { ChartToolbar, type ToolbarOptions, type ToolbarValue } from '@acme/chart-react';

const COLORS = ['#f7a600', '#ab47bc', '#00bcd4', '#8bc34a'];

const num = (x: unknown) =>
  x != null && typeof x === 'object' && 'asNumber' in (x as object) ? (x as { asNumber(): number }).asNumber() : (x as number);

export function RawChart({
  table: name,
  sym,
  studies,
  annotations,
  user,
  scale = 'normal',
}: {
  table: string;
  sym: string;
  studies: string[];
  annotations: string;
  user: string;
  scale?: string;
}) {
  const dh = useApi();
  const connection = useConnection();
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    const chart = createChart(el.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#131722' }, textColor: '#d1d4dc', attributionLogo: false },
      grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { timeVisible: true, secondsVisible: true },
    });
    chartRef.current = chart;
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a', downColor: '#ef5350', borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350',
    });
    const lines: ISeriesApi<'Line'>[] = studies.map((_, i) =>
      chart.addSeries(LineSeries, { color: COLORS[i % COLORS.length], lineWidth: 1, lastValueVisible: false, priceLineVisible: false }),
    );
    // our plugins, attached directly: no Deephaven involved
    candles.attachPrimitive(new TimeRangeShading(alternatingBlocks(900, 'rgba(41, 98, 255, 0.12)')));
    const unbindLegend = bindLegend(chart, candles, el.current!, sym);

    let closed = false;
    let cleanup = () => {};
    let unbindLines = () => {};
    // persistent price lines, if the server publishes the annotations table
    connection
      .getObject({ type: dh.VariableType.TABLE, name: annotations } as never)
      .then(obj => {
        const at = obj as Dh.Table;
        if (closed) return at.close();
        const store = tableAnnotationStore(dh, at, user);
        const unbind = bindPriceLines(chart, candles, store, sym);
        const unbindDrawings = bindDrawings(chart, candles, store, sym, el.current!);
        unbindLines = () => {
          unbindDrawings();
          unbind();
          store.close();
          at.close();
        };
      })
      .catch(() => {});
    (async () => {
      const t = (await connection.getObject({ type: dh.VariableType.TABLE, name } as never)) as Dh.Table;
      if (closed) return t.close();
      t.applyFilter([t.findColumn('Sym').filter().eq(dh.FilterValue.ofString(sym))]); // server-side
      const cols = ['Timestamp', 'Open', 'High', 'Low', 'Close', ...studies].map(c => t.findColumn(c));
      const sub = t.subscribe(cols);
      let first = true;
      sub.addEventListener(dh.Table.EVENT_UPDATED, ev => {
        const data = (ev as CustomEvent).detail as Dh.SubscriptionTableData;
        const rows: number[][] = [];
        for (const rs of first ? [data.fullIndex] : [data.added, data.modified])
          for (const it = rs.iterator(); it.hasNext(); ) {
            const k = it.next().value;
            rows.push(cols.map(c => num(data.getData(k, c))));
          }
        rows.sort((a, b) => a[0] - b[0]);
        const bar = (r: number[]) => ({ time: (r[0] / 1e9) as UTCTimestamp, open: r[1], high: r[2], low: r[3], close: r[4] });
        const pt = (r: number[], i: number) =>
          Number.isFinite(r[5 + i]) ? { time: (r[0] / 1e9) as UTCTimestamp, value: r[5 + i] } : { time: (r[0] / 1e9) as UTCTimestamp };
        if (first) {
          candles.setData(rows.map(bar));
          lines.forEach((l, i) => l.setData(rows.map(r => pt(r, i))));
          first = false;
        } else {
          for (const r of rows) {
            candles.update(bar(r));
            lines.forEach((l, i) => l.update(pt(r, i)));
          }
        }
      });
      cleanup = () => {
        sub.close();
        t.close();
      };
    })();
    return () => {
      closed = true;
      cleanup();
      unbindLines(); // before chart.remove(): it detaches from the series
      unbindLegend();
      chartRef.current = null;
      chart.remove();
    };
  }, [dh, connection, name, sym, studies.join(','), annotations, user]);

  // the price scale mode follows `scale` without rebuilding the chart
  useEffect(() => {
    chartRef.current?.priceScale('right').applyOptions({
      mode: scale === 'log' ? PriceScaleMode.Logarithmic : scale === 'percent' ? PriceScaleMode.Percentage : PriceScaleMode.Normal,
    });
  }, [scale, name, sym]);

  return <div ref={el} style={{ position: 'absolute', inset: 0 }} />;
}

// ----------------------------------------------------------------------------- with the toolbar

const STUDY_COLUMNS: Record<string, string[]> = {
  EMA_20: ['EMA_20'],
  EMA_50: ['EMA_50'],
  SMA_20: ['SMA_20'],
  BB_20_2: ['BB_20_2_Upper', 'BB_20_2_Mid', 'BB_20_2_Lower'],
  VWAP: ['VWAP'],
};

function toolbarOptions(symbols: string[]): ToolbarOptions {
  return {
    symbols: symbols.map(s => ({ key: s, label: s })),
    resolutions: [
      { key: '1s', label: '1s', group: 'Seconds' },
      { key: '5s', label: '5s', group: 'Seconds' },
      { key: '1m', label: '1m', group: 'Minutes' },
      { key: '5m', label: '5m', group: 'Minutes' },
    ],
    studies: [
      { key: 'EMA_20', label: 'EMA 20', group: 'Moving averages' },
      { key: 'EMA_50', label: 'EMA 50', group: 'Moving averages' },
      { key: 'SMA_20', label: 'SMA 20', group: 'Moving averages' },
      { key: 'BB_20_2', label: 'Bollinger Bands (20, 2)', group: 'Bands and channels' },
      { key: 'VWAP', label: 'VWAP', group: 'Volume' },
    ],
    scales: true,
  };
}

/** Group C's workspace: ChartToolbar + RawChart, all state in React. */
export function RawWorkspace({
  symbols,
  annotations,
  user,
  initial,
}: {
  symbols: string[];
  annotations: string;
  user: string;
  initial: ToolbarValue;
}) {
  const [value, setValue] = useState<ToolbarValue>(initial);
  const studies = (value.studies ?? []).flatMap(k => STUDY_COLUMNS[k] ?? []);
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#131722' }}>
      <ChartToolbar value={value} options={toolbarOptions(symbols)} onChange={patch => setValue(v => ({ ...v, ...patch }))} />
      <div style={{ position: 'relative', flex: 1 }}>
        <RawChart
          table={`bars_${value.resolution ?? '1m'}`}
          sym={value.symbol ?? symbols[0]}
          studies={studies}
          annotations={annotations}
          user={user}
          scale={value.scale}
        />
      </div>
    </div>
  );
}
