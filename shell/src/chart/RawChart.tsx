/**
 * Front-end group C: a React chart that uses only table data. No Deephaven UI objects, no Deephaven chart
 * plugin: this component draws its own Lightweight Charts chart from a SeriesFeed (@acme/chart-ext's
 * bindFeed), and our LWC plugins attach to it directly. The feed comes either from
 *
 *   the chart API (data = {kind: 'api'})    a shared node the server builds per request: any resolution,
 *                                           any study parameters, spreads; studies in their own panes
 *   a published table (data = {kind: 'table'})   bars_<res> filtered to the symbol on the server; its
 *                                           standard study columns as overlays
 *
 *   ?raw=bars_1m&sym=ES&studies=EMA_20,BB_20_2_Upper,BB_20_2_Lower      one bare chart from a table
 *   ?workspace&api&sym=NQ&tz=America/Chicago                            the workspace on the chart API
 *
 * RawWorkspace adds @acme/chart-react's ChartToolbar on top, ChartLegend over the chart and a Watchlist or
 * Alerts panel on the right. Its symbol is a linked value (the link bus, group "red"): the watchlist and
 * the toolbar set it, the chart follows it. Compare (API only) overlays other symbols on a % scale.
 *
 * Price lines and drawings persist through the same annotations table as the other front ends (chart key =
 * the symbol), so a line drawn here shows on every ES chart and vice versa. Times are shown in `timeZone`
 * ('local' by default, like Deephaven's own chart; 'UTC' or an IANA zone), prices by the instrument's tick.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { dh as Dh } from '@deephaven/jsapi-types';
import { CrosshairMode, PriceScaleMode, createChart, type IChartApi, type ISeriesApi, type SeriesType } from 'lightweight-charts';
import {
  bindAlertLines,
  bindCompare,
  bindCountdown,
  bindDrawings,
  bindFeed,
  bindLegend,
  bindNavigation,
  bindPriceLines,
  bindSessionShading,
  bindSync,
  followTheme,
  describeAlert,
  formatDuration,
  marketStatus,
  onPageAlertStore,
  onPageSessions,
  sessionSpecFor,
  timeZoneOptions,
  type AlertStore,
  type DrawnFeed,
  type Navigation,
  type SeriesFeed,
  type StudyLayout,
} from '@acme/chart-ext';
import { requestChart, safeClose, subscribeRows, tableAnnotationStore, tableFeed, type ApiClient } from '@acme/dh-bindings';
import {
  AlertsPanel,
  ChartLegend,
  ChartToolbar,
  Watchlist,
  useLink,
  type LegendStatus,
  type LegendStudy,
  type ToolbarOptions,
  type ToolbarValue,
  type WatchlistRow,
} from '@acme/chart-react';
import { useApiClient, useDeephaven } from '../deephaven';

const COLORS = ['#f7a600', '#ab47bc', '#00bcd4', '#8bc34a', '#ff7043', '#90a4ae'];
const COMPARE_COLORS = ['#2962ff', '#e91e63', '#00bcd4', '#8bc34a'];

/** Where a chart's data comes from. */
export type ChartData = { kind: 'table'; table: string } | { kind: 'api'; client: ApiClient };

export function RawChart({
  data,
  sym,
  res = '1m',
  studies,
  colorOf = (_s, i) => COLORS[i % COLORS.length],
  compare = [],
  annotations,
  user,
  scale = 'normal',
  timeZone = 'local',
  onChart,
  viewWindow,
  barSeconds,
}: {
  data: ChartData;
  sym: string;
  res?: string;
  /** API: study keys ("EMA_20", "RSI_14", "Volume"); table: the study columns to draw as overlays */
  studies: string[];
  /** a color per study (API: the study key; table: the column) */
  colorOf?: (study: string, index: number) => string;
  /** symbols to overlay as lines of their closes (API only) */
  compare?: { sym: string; color: string }[];
  annotations: string;
  user: string;
  scale?: string;
  /** 'local' (default), 'UTC' or an IANA zone */
  timeZone?: string;
  /** with it, the host draws the legend (ChartLegend) from the chart and series it gets here */
  onChart?: (lwc: { chart: IChartApi; series: ISeriesApi<SeriesType>[] } | null) => void;
  /** seconds to show at the end of the data (null: all) */
  viewWindow?: number | null;
  /** bar length, for the bar-close countdown */
  barSeconds?: number;
}) {
  const nav = useRef<Navigation | null>(null);
  const windowRef = useRef(viewWindow);
  windowRef.current = viewWindow;
  const { dh, connection } = useDeephaven();
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const studiesKey = studies.join(',');
  const compareKey = compare.map(c => `${c.sym}:${c.color}`).join(',');
  const client = data.kind === 'api' ? data.client : null;
  const table = data.kind === 'table' ? data.table : null;

  useEffect(() => {
    const zone = timeZoneOptions(timeZone);
    const chart = createChart(el.current!, {
      autoSize: true,
      layout: { attributionLogo: false },
      crosshair: { mode: CrosshairMode.Normal },
      localization: zone.localization,
      // minBarSpacing: let days of 1-minute bars fit the width (the default 0.5 px caps a view at ~1500 bars)
      timeScale: { timeVisible: true, secondsVisible: true, minBarSpacing: 0.01, ...zone.timeScale },
    });
    chartRef.current = chart;
    let closed = false;
    // colours from the page's --acme-chart-* properties (defaults: the TradingView dark theme)
    const cleanups: (() => void)[] = [followTheme(chart, el.current!)];

    (async () => {
      // the data: a shared node from the chart API, or a published table filtered to the symbol
      let feed: SeriesFeed;
      let layout: StudyLayout[];
      let tick: number | null = null;
      if (client) {
        const keys = studies.filter(s => s !== 'Volume');
        const h = await requestChart(dh, client, { sym, res, studies: keys, volume: studies.includes('Volume') });
        if (closed) return h.release();
        cleanups.push(h.release);
        feed = h.feed;
        tick = h.tick;
        layout = h.studies.map(s => {
          const study = h.columns.find(c => c.column === s.column)?.study ?? s.column;
          const i = Math.max(0, studies.indexOf(study));
          return { ...s, color: s.histogram ? undefined : colorOf(study, i) };
        });
      } else {
        const t = (await connection.getObject({ type: dh.VariableType.TABLE, name: table } as never)) as Dh.Table;
        if (closed) return safeClose(t);
        t.applyFilter([t.findColumn('Sym').filter().eq(dh.FilterValue.ofString(sym))]); // server-side
        cleanups.push(() => safeClose(t));
        feed = tableFeed(dh, t, ['Open', 'High', 'Low', 'Close', 'Volume', ...studies]);
        layout = studies.map((c, i) => ({ column: c, color: colorOf(c, i), dashed: c.endsWith('_Mid') }));
      }
      const drawn: DrawnFeed = bindFeed(chart, feed, { price: { type: 'candle', title: sym, tick }, studies: layout });
      cleanups.push(drawn.dispose);
      const price = drawn.series[0];

      // compared symbols: each its own shared node, a line of its closes
      const compared: ISeriesApi<SeriesType>[] = [];
      if (client)
        for (const c of compare) {
          const h = await requestChart(dh, client, { sym: c.sym, res });
          if (closed) return h.release();
          const d = bindCompare(chart, h.feed, { title: c.sym, color: c.color });
          cleanups.push(() => {
            d.dispose();
            h.release();
          });
          compared.push(...d.series);
        }

      // our plugins, attached directly: no Deephaven involved
      cleanups.push(bindSessionShading(price, sym)); // the page's calendar (the `sessions` table)
      if (!onChart) cleanups.push(bindLegend(chart, price, el.current!, sym));
      cleanups.push(bindSync(chart, price, el.current!));
      let unbindAlerts = () => {};
      cleanups.push(
        onPageAlertStore(s => {
          unbindAlerts();
          unbindAlerts = s ? bindAlertLines(price, s, sym) : () => {};
        }),
      );
      cleanups.push(() => unbindAlerts());
      // this chart holds the symbol's whole history, so navigation never needs to load more
      const navigation = bindNavigation(chart, price, el.current!, { viewWindow: windowRef.current ?? null, historyComplete: true, settleMs: 0 });
      nav.current = navigation;
      cleanups.push(() => {
        navigation.dispose();
        nav.current = null;
      });
      if (barSeconds) cleanups.push(bindCountdown(chart, price, el.current!, barSeconds));
      onChart?.({ chart, series: [...drawn.series, ...compared] });
      applyScale(chart, scale, compare.length > 0);

      // persistent price lines and drawings, if the server publishes the annotations table
      try {
        const at = (await connection.getObject({ type: dh.VariableType.TABLE, name: annotations } as never)) as Dh.Table;
        if (closed) return safeClose(at);
        const store = tableAnnotationStore(dh, at, user);
        const unbind = bindPriceLines(chart, price, store, sym);
        const unbindDrawings = bindDrawings(chart, price, store, sym, el.current!);
        cleanups.push(() => {
          unbindDrawings();
          unbind();
          store.close();
          safeClose(at);
        });
      } catch {
        /* no annotations table on this server */
      }
    })().catch(e => console.warn('chart data failed', e));

    return () => {
      closed = true;
      // last bound, first released: plugins detach from the series before the series and data go
      for (const c of [...cleanups].reverse()) {
        try {
          c();
        } catch {
          /* already gone */
        }
      }
      onChart?.(null);
      chartRef.current = null;
      chart.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dh, connection, client, table, sym, res, studiesKey, compareKey, annotations, user, barSeconds, timeZone]);

  useEffect(() => nav.current?.update({ viewWindow: viewWindow ?? null }), [viewWindow]);

  // the price scale mode follows `scale` without rebuilding the chart
  useEffect(() => {
    if (chartRef.current) applyScale(chartRef.current, scale, compare.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, compareKey]);

  return <div ref={el} style={{ position: 'absolute', inset: 0 }} />;
}

/** Comparing only makes sense in percent: compared symbols switch a normal scale to percent. */
function applyScale(chart: IChartApi, scale: string, comparing: boolean) {
  const s = comparing && scale === 'normal' ? 'percent' : scale;
  try {
    chart.priceScale('right', 0).applyOptions({
      mode: s === 'log' ? PriceScaleMode.Logarithmic : s === 'percent' ? PriceScaleMode.Percentage : PriceScaleMode.Normal,
    });
    // study panes (RSI, volume) keep a linear scale: each pane has its own right scale
    for (let i = 1; i < chart.panes().length; i++) chart.priceScale('right', i).applyOptions({ mode: PriceScaleMode.Normal });
  } catch {
    /* the chart is being rebuilt */
  }
}

// ----------------------------------------------------------------------------- with the toolbar

/** Columns per standard study key (the published tables' columns; the API's are the same). */
const STUDY_COLUMNS: Record<string, string[]> = {
  EMA_20: ['EMA_20'],
  EMA_50: ['EMA_50'],
  SMA_20: ['SMA_20'],
  BB_20_2: ['BB_20_2_Upper', 'BB_20_2_Mid', 'BB_20_2_Lower'],
  VWAP: ['VWAP'],
  RSI_14: ['RSI_14'],
  Volume: ['Volume'],
};
const STUDY_LABELS: Record<string, string> = {
  EMA_20: 'EMA 20', EMA_50: 'EMA 50', SMA_20: 'SMA 20', BB_20_2: 'BB 20 2', VWAP: 'VWAP', RSI_14: 'RSI 14', Volume: 'Volume',
};
const STUDY_ORDER = Object.keys(STUDY_COLUMNS);
/** what a published bars_<res> table has (RSI and Volume need panes: API only) */
const TABLE_STUDIES = ['EMA_20', 'EMA_50', 'SMA_20', 'BB_20_2', 'VWAP'];

/** Rows of a published quotes table (Sym, Last, Chg, ChgPct), live. */
function useQuotes(name: string): WatchlistRow[] {
  const { dh, connection } = useDeephaven();
  const [rows, setRows] = useState<WatchlistRow[]>([]);
  useEffect(() => {
    let closed = false;
    let close = () => {};
    connection
      .getObject({ type: dh.VariableType.TABLE, name } as never)
      .then(obj => {
        const t = obj as Dh.Table;
        if (closed) return safeClose(t);
        const unsubscribe = subscribeRows(dh, t, ['Sym', 'Last', 'Chg', 'ChgPct'], rs =>
          setRows(rs.map(r => ({ symbol: String(r.Sym), last: r.Last as number, chg: r.Chg as number, chgPct: r.ChgPct as number }))),
        );
        close = () => {
          unsubscribe();
          safeClose(t);
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

/** Resolutions: the published bars_<res> tables, or with the chart API any (it builds them on demand). */
const TABLE_RESOLUTIONS = ['1s', '5s', '1m', '5m'];
const API_RESOLUTIONS = ['1s', '5s', '15s', '1m', '2m', '5m', '15m', '30m', '1h'];
const secsOf = (r: string) => Number(r.slice(0, -1)) * ({ s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[r.slice(-1)];

function toolbarOptions(symbols: string[], api: boolean): ToolbarOptions {
  return {
    symbols: symbols.map(s => ({ key: s, label: s })),
    // with the API, a typed spread or ratio (ES-NQ, ZN/ZB) is an instrument too, and other symbols can be compared
    expressions: api,
    compare: api,
    resolutions: (api ? API_RESOLUTIONS : TABLE_RESOLUTIONS).map(r => ({
      key: r, label: r, group: secsOf(r) < 60 ? 'Seconds' : secsOf(r) < 3600 ? 'Minutes' : 'Hours',
    })),
    studies: [
      { key: 'EMA_20', label: 'EMA 20', group: 'Moving averages' },
      { key: 'EMA_50', label: 'EMA 50', group: 'Moving averages' },
      { key: 'SMA_20', label: 'SMA 20', group: 'Moving averages' },
      { key: 'BB_20_2', label: 'Bollinger Bands (20, 2)', group: 'Bands and channels' },
      { key: 'VWAP', label: 'VWAP', group: 'Volume' },
      ...(api
        ? [
            { key: 'RSI_14', label: 'Relative Strength Index (14)', group: 'Oscillators' },
            { key: 'Volume', label: 'Volume', group: 'Volume' },
          ]
        : []),
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

/** Group C's workspace: ChartToolbar + RawChart, state in React; the symbol on the link bus (needs a LinkProvider). */
export function RawWorkspace({
  symbols,
  annotations,
  user,
  initial,
  apiName = null,
  timeZone = 'local',
  linkGroup = 'red',
  initialCompare = [],
  onChange,
  sidePanel = true,
}: {
  symbols: string[];
  annotations: string;
  user: string;
  initial: ToolbarValue;
  /** the published chart API to load charts through (null: the published bars_<res> tables) */
  apiName?: string | null;
  timeZone?: string;
  /** the link group the symbol is shared in (null: not linked) */
  linkGroup?: string | null;
  /** symbols to compare from the start (API only) */
  initialCompare?: string[];
  /** told the toolbar's state, the symbol and the compared symbols whenever they change (to save them) */
  onChange?: (state: { value: ToolbarValue; symbol: string; compare: string[] }) => void;
  /** whether the watchlist and alerts panels can open beside the chart (an app shell may have its own) */
  sidePanel?: boolean;
}) {
  const { value: client } = useApiClient(apiName, user ? `user:${user}` : undefined);
  const api = apiName != null;
  const [value, setValue] = useState<ToolbarValue>({ panel: 'watchlist', range: '4h', ...initial });
  const [sym, setSym] = useLink<string>('symbol', { group: linkGroup, initial: initial.symbol ?? symbols[0] });
  const [hidden, setHidden] = useState<string[]>([]);
  const [compare, setCompare] = useState<{ sym: string; color: string; visible: boolean }[]>(() =>
    initialCompare.map((c, i) => ({ sym: c, color: COMPARE_COLORS[i % COMPARE_COLORS.length], visible: true })),
  );
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    onChangeRef.current?.({ value, symbol: sym, compare: compare.map(c => c.sym) });
  }, [value, sym, compare]);
  const [lwc, setLwc] = useState<{ chart: IChartApi; series: ISeriesApi<SeriesType>[] } | null>(null);
  const quotes = useQuotes('quotes');
  const status = useMarketStatus(sym);
  const res = value.resolution ?? '1m';
  const keys = (value.studies ?? []).filter(k => api || TABLE_STUDIES.includes(k));
  // a color per study, kept when others are added or hidden
  const colorOf = (k: string) => COLORS[Math.max(0, STUDY_ORDER.indexOf(k)) % COLORS.length];
  const shown = keys.filter(k => !hidden.includes(k));
  const shownCompare = compare.filter(c => c.visible).map(({ sym: s, color }) => ({ sym: s, color }));
  const legend: LegendStudy[] = useMemo(
    () => [
      ...keys.map(k => ({ id: k, label: STUDY_LABELS[k] ?? k, columns: STUDY_COLUMNS[k] ?? [k], color: colorOf(k), visible: !hidden.includes(k) })),
      ...compare.map(c => ({ id: `cmp:${c.sym}`, label: c.sym, columns: [c.sym], color: c.color, visible: c.visible, kind: 'compare' as const })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keys.join(','), hidden.join(','), JSON.stringify(compare)],
  );
  const onToolbar = (patch: ToolbarValue) => {
    const { symbol, addCompare, ...rest } = patch;
    if (symbol) setSym(symbol);
    if (addCompare && addCompare !== sym)
      setCompare(cs =>
        cs.some(c => c.sym === addCompare)
          ? cs
          : [...cs, { sym: addCompare, color: COMPARE_COLORS.find(col => !cs.some(c => c.color === col)) ?? COMPARE_COLORS[0], visible: true }],
      );
    setValue(v => ({ ...v, ...rest }));
  };
  const scaleShown = shownCompare.length && (value.scale ?? 'normal') === 'normal' ? 'percent' : value.scale;
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', background: 'var(--acme-bg, #131722)' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <ChartToolbar value={{ ...value, symbol: sym, studies: keys, scale: scaleShown }} options={toolbarOptions(symbols, api)} onChange={onToolbar} />
        <div style={{ position: 'relative', flex: 1 }}>
          {api && client == null ? null : (
            <RawChart
              data={client ? { kind: 'api', client } : { kind: 'table', table: `bars_${res}` }}
              sym={sym}
              res={res}
              studies={client ? shown : shown.flatMap(k => STUDY_COLUMNS[k] ?? [])}
              colorOf={client ? s => colorOf(s) : c => colorOf(keys.find(k => (STUDY_COLUMNS[k] ?? []).includes(c)) ?? c)}
              compare={shownCompare}
              annotations={annotations}
              user={user}
              scale={value.scale}
              timeZone={timeZone}
              onChart={setLwc}
              viewWindow={RANGES[value.range ?? '4h'] ?? null}
              barSeconds={secsOf(res)}
            />
          )}
          <ChartLegend
            chart={lwc?.chart ?? null}
            series={lwc?.series ?? []}
            title={sym}
            status={status}
            studies={legend}
            onStudyChange={p => {
              if (p.id.startsWith('cmp:')) {
                const s = p.id.slice(4);
                if (p.remove) setCompare(cs => cs.filter(c => c.sym !== s));
                if (p.visible !== undefined) setCompare(cs => cs.map(c => (c.sym === s ? { ...c, visible: !!p.visible } : c)));
                return;
              }
              if (p.remove) setValue(v => ({ ...v, studies: (v.studies ?? []).filter(k => k !== p.id) }));
              if (p.visible !== undefined) setHidden(h => (p.visible ? h.filter(k => k !== p.id) : [...h, p.id]));
            }}
          />
        </div>
      </div>
      {sidePanel && value.panel === 'watchlist' && (
        <div style={{ width: 280, flex: 'none' }}>
          <Watchlist rows={quotes} selected={sym} onSelect={setSym} />
        </div>
      )}
      {sidePanel && value.panel === 'alerts' && (
        <div style={{ width: 300, flex: 'none' }}>
          <PageAlerts symbol={sym} />
        </div>
      )}
    </div>
  );
}
