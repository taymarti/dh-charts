/**
 * Front-end group C: a React chart that uses only table data. No Deephaven UI objects, no Deephaven chart
 * plugin, no hook: the JS API reads a published L0 table (bars_<res>, every symbol, standard studies),
 * filters it to one symbol on the server, and this component draws its own Lightweight Charts chart.
 * Our LWC plugins from @acme/chart-ext attach to it directly.
 *
 *   ?raw=bars_1m&sym=ES&studies=EMA_20,BB_20_2_Upper,BB_20_2_Lower
 *
 * RawWorkspace adds @acme/chart-react's ChartToolbar on top, ChartLegend over the chart and Watchlist
 * on the right, with plain React state: symbol, interval (which bars_<res> table), overlay indicators
 * (which study columns), scale. No server round trip beyond re-subscribing: the studies are the
 * published standard set's columns, so the legend can show, hide and remove them but not change their
 * parameters (that needs Python: groups A and B). The watchlist subscribes the published `quotes` table.
 *
 * Price lines and drawings persist through the same annotations table as the other front ends (bindPriceLines on
 * our own series, chart key = the symbol), so a line drawn here shows on every ES chart and vice versa.
 *
 * Bars arrive as Barrage deltas: a new bar is an added row, the forming bar a modified row; both go
 * through series.update(), which LWC handles incrementally for the last bar.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
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
  type SeriesType,
  type UTCTimestamp,
} from 'lightweight-charts';
import {
  bindCountdown,
  bindDrawings,
  bindLegend,
  bindNavigation,
  bindPriceLines,
  bindSessionShading,
  bindSync,
  describeAlert,
  formatDuration,
  marketStatus,
  onPageAlertStore,
  onPageSessions,
  sessionSpecFor,
  subscribeRows,
  tableAnnotationStore,
  type AlertStore,
  type Navigation,
} from '@acme/chart-ext';
import {
  AlertsPanel,
  ChartLegend,
  ChartToolbar,
  Watchlist,
  type LegendStatus,
  type LegendStudy,
  type ToolbarOptions,
  type ToolbarValue,
  type WatchlistRow,
} from '@acme/chart-react';

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
  colors = COLORS,
  onChart,
  viewWindow,
  barSeconds,
}: {
  table: string;
  sym: string;
  studies: string[];
  annotations: string;
  user: string;
  scale?: string;
  /** one color per study column */
  colors?: string[];
  /** with it, the host draws the legend (ChartLegend) from the chart and series it gets here */
  onChart?: (lwc: { chart: IChartApi; series: ISeriesApi<SeriesType>[] } | null) => void;
  /** seconds to show at the end of the data (null: all); the whole history is loaded either way */
  viewWindow?: number | null;
  /** bar length, for the bar-close countdown */
  barSeconds?: number;
}) {
  const nav = useRef<Navigation | null>(null);
  const windowRef = useRef(viewWindow);
  windowRef.current = viewWindow;
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
      title: sym,
    });
    // titled with their column, so a legend can find them
    const lines: ISeriesApi<'Line'>[] = studies.map((c, i) =>
      chart.addSeries(LineSeries, {
        color: colors[i % colors.length], lineWidth: 1, lastValueVisible: false, priceLineVisible: false, title: c,
      }),
    );
    // our plugins, attached directly: no Deephaven involved
    const unbindSessions = bindSessionShading(candles, sym); // the page's calendar (the `sessions` table)
    const unbindLegend = onChart ? () => {} : bindLegend(chart, candles, el.current!, sym);
    const unbindSync = bindSync(chart, candles, el.current!);
    // this chart holds the symbol's whole history, so navigation never needs to load more
    const navigation = bindNavigation(chart, candles, el.current!, { viewWindow: windowRef.current ?? null, historyComplete: true, settleMs: 0 });
    nav.current = navigation;
    const unbindCountdown = barSeconds ? bindCountdown(chart, candles, el.current!, barSeconds) : () => {};
    onChart?.({ chart, series: [candles, ...lines] });

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
      unbindSync();
      unbindSessions();
      navigation.dispose();
      nav.current = null;
      unbindCountdown();
      onChart?.(null);
      chartRef.current = null;
      chart.remove();
    };
  }, [dh, connection, name, sym, studies.join(','), colors.join(','), annotations, user, barSeconds]);

  useEffect(() => nav.current?.update({ viewWindow: viewWindow ?? null }), [viewWindow]);

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
const STUDY_LABELS: Record<string, string> = { EMA_20: 'EMA 20', EMA_50: 'EMA 50', SMA_20: 'SMA 20', BB_20_2: 'BB 20 2', VWAP: 'VWAP' };
const STUDY_ORDER = Object.keys(STUDY_COLUMNS);

/** Rows of a published quotes table (Sym, Last, Chg, ChgPct), live. */
function useQuotes(name: string): WatchlistRow[] {
  const dh = useApi();
  const connection = useConnection();
  const [rows, setRows] = useState<WatchlistRow[]>([]);
  useEffect(() => {
    let closed = false;
    let close = () => {};
    connection
      .getObject({ type: dh.VariableType.TABLE, name } as never)
      .then(obj => {
        const t = obj as Dh.Table;
        if (closed) return t.close();
        const unsubscribe = subscribeRows(dh, t, ['Sym', 'Last', 'Chg', 'ChgPct'], rs =>
          setRows(rs.map(r => ({ symbol: String(r.Sym), last: r.Last as number, chg: r.Chg as number, chgPct: r.ChgPct as number }))),
        );
        close = () => {
          unsubscribe();
          t.close();
        };
      })
      .catch(() => {});
    return () => {
      closed = true;
      close();
    };
  }, [dh, connection, name]);
  return rows;
}

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
    ranges: Object.keys(RANGES).map(k => ({ key: k, label: k })),
    scales: true,
    panels: [
      { key: 'watchlist', label: 'Watchlist' },
      { key: 'alerts', label: 'Alerts' },
    ],
  };
}

/** The view window per range choice (seconds; null: all). */
const RANGES: Record<string, number | null> = { '30m': 1800, '1h': 3600, '4h': 14400, '1D': 86400, '5D': 432000, All: null };
const BAR_SECONDS: Record<string, number> = { '1s': 1, '5s': 5, '1m': 60, '5m': 300 };
const ALERT_SOURCES = [
  { key: 'Last', label: 'Price (last trade)' },
  ...['EMA_20', 'EMA_50', 'SMA_20', 'VWAP', 'RSI_14'].flatMap(c =>
    ['1m', '5m'].map(r => ({ key: `${c}@${r}`, label: `${c.replace(/_/g, ' ')} (${r})` })),
  ),
];

/** The market status for a symbol from the page's session calendar, refreshed every 15 s. */
function useMarketStatus(sym: string): LegendStatus | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    const off = onPageSessions(() => setNow(Date.now()));
    return () => {
      clearInterval(t);
      off();
    };
  }, []);
  return useMemo(() => {
    const spec = sessionSpecFor(sym);
    if (!spec) return undefined;
    const st = marketStatus(spec, now / 1000);
    const change = st.until ? `${st.state === 'closed' ? 'opens' : st.state === 'regular' ? 'closes' : 'changes'} in ${formatDuration(st.until - now / 1000)}` : '';
    return { state: st.state, label: st.label, detail: [change, st.name].filter(Boolean).join(' · ') };
  }, [sym, now]);
}

/** The alerts panel over the page's alert store (published `chart_alerts`; evaluated on the server). */
function PageAlerts({ symbol }: { symbol: string }) {
  const [store, setStore] = useState<AlertStore | undefined>();
  const [, redraw] = useState(0);
  useEffect(() => onPageAlertStore(setStore), []);
  useEffect(() => store?.subscribe(() => redraw(n => n + 1)), [store]);
  const rows = (store?.list() ?? [])
    .filter(a => a.status === 'active' || a.status === 'triggered')
    .map(a => ({
      id: a.id, sym: a.sym, description: describeAlert(a), message: a.message, status: a.status as 'active' | 'triggered',
      createdMs: a.createdMs, triggeredMs: a.triggeredMs, triggerValue: a.triggerValue,
    }));
  return (
    <AlertsPanel
      alerts={rows}
      symbol={symbol}
      sources={ALERT_SOURCES}
      onCreate={
        store
          ? a => void store.put({ sym: a.sym, source: a.source, kind: a.source === 'Last' ? 'price' : 'study', op: a.op, level: a.level, message: a.message })
          : undefined
      }
      onCancel={store ? id => void store.cancel(id) : undefined}
    />
  );
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
  const [value, setValue] = useState<ToolbarValue>({ panel: 'watchlist', range: '4h', ...initial });
  const [hidden, setHidden] = useState<string[]>([]);
  const [lwc, setLwc] = useState<{ chart: IChartApi; series: ISeriesApi<SeriesType>[] } | null>(null);
  const quotes = useQuotes('quotes');
  const sym = value.symbol ?? symbols[0];
  const status = useMarketStatus(sym);
  const keys = value.studies ?? [];
  // a color per study, kept when others are added or hidden; the chart gets one per column
  const colorOf = (k: string) => COLORS[STUDY_ORDER.indexOf(k) % COLORS.length];
  const shown = keys.filter(k => !hidden.includes(k));
  const columns = shown.flatMap(k => STUDY_COLUMNS[k] ?? []);
  const colors = shown.flatMap(k => (STUDY_COLUMNS[k] ?? []).map(() => colorOf(k)));
  const legend: LegendStudy[] = useMemo(
    () =>
      keys.map(k => ({ id: k, label: STUDY_LABELS[k] ?? k, columns: STUDY_COLUMNS[k] ?? [], color: colorOf(k), visible: !hidden.includes(k) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keys.join(','), hidden.join(',')],
  );
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', background: '#131722' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <ChartToolbar value={value} options={toolbarOptions(symbols)} onChange={patch => setValue(v => ({ ...v, ...patch }))} />
        <div style={{ position: 'relative', flex: 1 }}>
          <RawChart
            table={`bars_${value.resolution ?? '1m'}`}
            sym={sym}
            studies={columns}
            colors={colors}
            annotations={annotations}
            user={user}
            scale={value.scale}
            onChart={setLwc}
            viewWindow={RANGES[value.range ?? '4h'] ?? null}
            barSeconds={BAR_SECONDS[value.resolution ?? '1m']}
          />
          <ChartLegend
            chart={lwc?.chart ?? null}
            series={lwc?.series ?? []}
            title={sym}
            status={status}
            studies={legend}
            onStudyChange={p => {
              if (p.remove) setValue(v => ({ ...v, studies: (v.studies ?? []).filter(k => k !== p.id) }));
              if (p.visible !== undefined) setHidden(h => (p.visible ? h.filter(k => k !== p.id) : [...h, p.id]));
            }}
          />
        </div>
      </div>
      {value.panel === 'watchlist' && (
        <div style={{ width: 280, flex: 'none' }}>
          <Watchlist rows={quotes} selected={sym} onSelect={symbol => setValue(v => ({ ...v, symbol }))} />
        </div>
      )}
      {value.panel === 'alerts' && (
        <div style={{ width: 300, flex: 'none' }}>
          <PageAlerts symbol={sym} />
        </div>
      )}
    </div>
  );
}
