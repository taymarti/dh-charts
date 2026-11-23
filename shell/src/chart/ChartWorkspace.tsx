/**
 * A chart panel kind for the shell (front-end group C): our own Lightweight Charts chart from the chart API's
 * shared nodes, with the TradingView-style toolbar and legend, for any app whose server has a chart API
 * (dh_chart_ext.api.ChartApi, or @acme/dh-mock's mockChartApi). RawWorkspace is the simpler one; this one adds
 *
 *   - indicators as instances with parameters (EMA 20 and EMA 50, BB 20 2.5, MACD, ...), only the ones that
 *     apply to the symbol (no VWAP on a series without volume)
 *   - typed expressions: spreads and ratios the server resolves (ZN-ZNH7, 100*(US10Y-US2Y))
 *   - chart types (candles, bars, line, area), any resolution from 1s to 1W, ranges up to a year
 *   - prices in the instrument's notation (32nds, % for yields, bp for spreads), from the reply's metadata
 *   - drawings and price lines (saved per user, shared ones shown), alerts, session shading, bar countdown,
 *     navigation, crosshair sync, compare on a % scale
 *   - side panels: a watchlist (any table with Sym, Last, Chg, ChgPct, Name), alerts, and the app's own
 *
 * The symbol is a linked value (link groups): a watchlist or table in the same group drives it.
 *
 *   chartWorkspacePanel({ user, useSymbols, useInstrument, watchlist: 'watchlist_core', panels: [...] })
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { dh as Dh } from '@deephaven/jsapi-types';
import { CrosshairMode, PriceScaleMode, createChart, type IChartApi, type ISeriesApi, type SeriesType } from 'lightweight-charts';
import {
  STUDY_TYPES,
  bindAlertLines,
  bindCompare,
  bindCountdown,
  bindDrawings,
  bindFeed,
  bindNavigation,
  bindPriceLines,
  bindSessionShading,
  bindSync,
  describeAlert,
  fmt32,
  followTheme,
  formatDuration,
  makeStudy,
  marketStatus,
  onPageAlertStore,
  onPageSessions,
  sessionSpecFor,
  studiesFor,
  studyLabel,
  timeZoneOptions,
  type AlertStore,
  type Navigation,
  type PriceNotation,
  type PriceType,
  type StudyLayout,
} from '@acme/chart-ext';
import { safeClose, tableAnnotationStore, tableFeed } from '@acme/dh-bindings';
import {
  AlertsPanel,
  ChartLegend,
  ChartToolbar,
  STUDY_PALETTE,
  Watchlist,
  useLink,
  type LegendStatus,
  type LegendStudy,
  type ToolbarItem,
  type ToolbarOptions,
  type ToolbarValue,
} from '@acme/chart-react';
import { useApiClient, useDeephaven, useRows } from '../deephaven';
import { definePanel, type PanelKind, type PanelProps } from '../registry';

export interface StudyInstance {
  id: string;
  type: string;
  params: Record<string, number>;
  color: string;
  visible: boolean;
}

export interface ChartWorkspaceParams {
  symbol: string;
  res: string;
  range: string;
  chartType: string;
  scale: string;
  studies: StudyInstance[];
  compare: string[];
  /** the side panel shown: 'watchlist', 'alerts', one of the app's, or '' */
  panel: string;
  /** which of the symbol's series is charted (with options.useSeries), e.g. 'yield'; none: the first */
  series?: string;
}

/** One series a symbol offers: a security's price, its yield, its spread to the curve... */
export interface SeriesChoice {
  key: string;
  label: string;
  /** the symbol charted for it */
  sym: string;
}

/** What the workspace needs to know about a symbol: its notation, name, and whether it has volume. */
export type ChartInstrument = PriceNotation & { name?: string; has_volume?: boolean };

export interface ChartWorkspaceOptions {
  /** the panel kind (default 'chart-workspace'); keep it stable, saved layouts refer to it */
  kind?: string;
  label?: string;
  description?: string;
  /** the chart API's published name (default chart_api) */
  api?: string;
  /** whose drawings, price lines and alerts */
  user: string;
  /** the symbols the toolbar's search offers (a hook: it may fetch them) */
  useSymbols: () => ToolbarItem[];
  /** a symbol's notation and name (a hook), or null while unknown */
  useInstrument: (sym: string) => ChartInstrument | null;
  /** the watchlist side panel's table (Sym, Last, Chg, ChgPct, Name) and title; none: no watchlist */
  watchlist?: { table: string; title?: string };
  /** the app's own side panels, after Watchlist and Alerts */
  panels?: Array<{ key: string; label: string; render: (sym: string, inst: ChartInstrument | null) => ReactNode }>;
  /** the annotations table (default chart_annotations) */
  annotations?: string;
  /** a note after the market status in the legend (e.g. "simulated data ticks around the clock") */
  statusNote?: string;
  defaultParams?: Partial<ChartWorkspaceParams>;
  /**
   * The series a (base) symbol offers, a hook: the toolbar shows a menu of them, and the chart draws the chosen one.
   * The link bus keeps the base symbol, so linked panels see the security, not one of its series.
   */
  useSeries?: (sym: string) => SeriesChoice[];
  /** a series symbol's base and series key (e.g. 'X.IDIO' -> { base: 'X', series: 'idio' }), or null for a base symbol */
  baseOf?: (sym: string) => { base: string; series: string } | null;
}

const COMPARE_COLORS = ['#2962ff', '#e91e63', '#00bcd4', '#8bc34a'];
const RES: Array<[string, string]> = [
  ['1s', 'Seconds'], ['5s', 'Seconds'], ['15s', 'Seconds'], ['30s', 'Seconds'], ['1m', 'Minutes'], ['2m', 'Minutes'], ['3m', 'Minutes'], ['5m', 'Minutes'],
  ['10m', 'Minutes'], ['15m', 'Minutes'], ['30m', 'Minutes'], ['1h', 'Hours'], ['2h', 'Hours'], ['4h', 'Hours'], ['1D', 'Days'], ['1W', 'Days'],
];
const RANGES: Record<string, number | null> = { '30m': 1800, '1h': 3600, '4h': 14400, '1D': 86400, '5D': 432000, '1M': 30 * 86400, '6M': 182 * 86400, '1Y': 365 * 86400, All: null };
const secsOf = (r: string) => Number(r.slice(0, -1)) * ({ s: 1, m: 60, h: 3600, D: 86400, W: 604800 } as Record<string, number>)[r.slice(-1)];

let nextId = 1;
/** A study instance of `type` with its default parameters (overridden by `params`). */
export const newStudy = (type: string, color: string, params?: Record<string, number>): StudyInstance => ({
  id: `s${Date.now().toString(36)}${nextId++}`,
  type,
  params: { ...STUDY_TYPES[type].params, ...(params ?? {}) },
  color,
  visible: true,
});

/** "EMA_20" strings to instances, coloured from the study palette. */
export function instancesOf(keys: string[]): StudyInstance[] {
  return keys.map((k, i) => {
    const s = makeStudy(k);
    return newStudy(s.type, STUDY_PALETTE[i % STUDY_PALETTE.length], s.params);
  });
}

const keyOf = (s: StudyInstance) => makeStudy({ type: s.type, params: s.params }).key;

function pickColor(used: string[]) {
  return STUDY_PALETTE.find(c => !used.includes(c)) ?? STUDY_PALETTE[used.length % STUDY_PALETTE.length];
}

// ----------------------------------------------------------------------------- the chart itself

interface ChartCore {
  api: string;
  user: string;
  annotations: string;
  sym: string;
  res: string;
  chartType: PriceType;
  studies: StudyInstance[];
  compare: { sym: string; color: string }[];
  scale: string;
  viewWindow: number | null;
  onChart: (lwc: { chart: IChartApi; series: ISeriesApi<SeriesType>[] } | null) => void;
  onProblem: (p: string | null) => void;
}

function shade(hex: string, f: number) {
  const n = parseInt(hex.slice(1), 16);
  const c = (x: number) => Math.max(0, Math.min(255, Math.round(x * f)));
  return `#${((c(n >> 16) << 16) | (c((n >> 8) & 255) << 8) | c(n & 255)).toString(16).padStart(6, '0')}`;
}

function WorkspaceChart({ api, user, annotations, sym, res, chartType, studies, compare, scale, viewWindow, onChart, onProblem }: ChartCore) {
  const { dh, connection } = useDeephaven();
  const client = useApiClient(api, `user:${user}`).value;
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const nav = useRef<Navigation | null>(null);
  const windowRef = useRef(viewWindow);
  windowRef.current = viewWindow;
  const visible = studies.filter(s => s.visible);
  const studyKey = visible.map(s => `${keyOf(s)}:${s.color}`).join(',');
  const compareKey = compare.map(c => `${c.sym}:${c.color}`).join(',');

  useEffect(() => {
    if (!client || !el.current) return;
    // daily and weekly bars are dated at UTC midnight: label them in UTC, or every date shows as the day before
    const zone = timeZoneOptions(secsOf(res) >= 86400 ? 'UTC' : 'local');
    const chart = createChart(el.current, {
      autoSize: true,
      layout: { attributionLogo: false },
      crosshair: { mode: CrosshairMode.Normal },
      localization: zone.localization,
      timeScale: { timeVisible: true, secondsVisible: secsOf(res) < 60, minBarSpacing: 0.01, rightOffset: 6, ...zone.timeScale },
    });
    chartRef.current = chart;
    let closed = false;
    // colours from the page's theme (--acme-chart-* custom properties), live when the theme changes
    const cleanups: Array<() => void> = [followTheme(chart, el.current)];
    onProblem(null);

    (async () => {
      const keys = visible.map(keyOf);
      const { result, tables } = await client.requestTables<{
        key: unknown;
        columns: Array<{ column: string; pane: string; study: string; levels?: number[]; histogram?: boolean }>;
        tick: number | null;
        thirty_seconds?: boolean;
        unit?: string;
        decimals?: number;
      }>('chart', { sym, res, studies: keys });
      const table = tables[0] as Dh.Table;
      const release = () => {
        safeClose(table);
        void client.request('release', { key: result.key }).catch(() => {});
      };
      if (closed) return release();
      cleanups.push(release);
      const studyCols = result.columns.filter(c => c.column !== 'Volume');
      const cols = ['Open', 'High', 'Low', 'Close', 'Volume', ...studyCols.map(c => c.column)];
      const feed = tableFeed(dh, table, cols);
      const colorFor = (studyKeyName: string) => visible[keys.indexOf(studyKeyName)]?.color ?? STUDY_PALETTE[0];
      const layout: StudyLayout[] = result.columns.map(c => {
        const base = colorFor(c.study);
        const sub = c.column.endsWith('_Signal') || c.column.endsWith('_D');
        const mid = c.column.endsWith('_Mid');
        return {
          column: c.column,
          pane: c.pane,
          levels: c.levels,
          histogram: !!c.histogram,
          color: c.histogram ? (c.column === 'Volume' ? undefined : shade(base, 0.8)) : sub ? '#ff9800' : mid ? shade(base, 0.7) : base,
          dashed: mid || sub,
        };
      });
      const drawn = bindFeed(chart, feed, { price: { type: chartType, title: sym, tick: result.tick }, studies: layout, priceStretch: 3 });
      cleanups.push(drawn.dispose);
      const price = drawn.series[0];
      // panes in the price's units (MACD, ATR, ROC on a spread worth hundredths) need the instrument's precision
      const prec = Math.min(4, Math.max(2, result.decimals ?? 2));
      layout.forEach((l, i) => {
        if (l.pane && !['overlay', 'rsi', 'stoch', 'zscore', 'volume'].includes(l.pane))
          drawn.series[i + 1]?.applyOptions({ priceFormat: { type: 'price', precision: prec, minMove: 10 ** -prec } });
      });
      if (result.thirty_seconds) {
        const tick = result.tick ?? 1 / 256;
        price.applyOptions({ priceFormat: { type: 'custom', minMove: tick, formatter: (p: number) => fmt32(p, tick) } });
      } else if (result.unit === 'bp') {
        price.applyOptions({ priceFormat: { type: 'price', precision: 1, minMove: 0.1 } });
      } else if (result.unit === '%') {
        price.applyOptions({ priceFormat: { type: 'price', precision: 3, minMove: 0.001 } });
      }

      const compared: ISeriesApi<SeriesType>[] = [];
      for (const c of compare) {
        const r = await client.requestTables<{ key: unknown }>('chart', { sym: c.sym, res, studies: [] }).catch(e => {
          onProblem(`compare ${c.sym}: ${e.message}`);
          return null;
        });
        if (!r) continue;
        const t = r.tables[0] as Dh.Table;
        const rel = () => {
          safeClose(t);
          void client.request('release', { key: r.result.key }).catch(() => {});
        };
        if (closed) return rel();
        const d = bindCompare(chart, tableFeed(dh, t, ['Open', 'High', 'Low', 'Close']), { title: c.sym, color: c.color });
        cleanups.push(() => {
          d.dispose();
          rel();
        });
        compared.push(...d.series);
      }

      cleanups.push(bindSessionShading(price, sym));
      cleanups.push(bindSync(chart, price, el.current!));
      let unbindAlerts = () => {};
      cleanups.push(
        onPageAlertStore(s => {
          unbindAlerts();
          unbindAlerts = s ? bindAlertLines(price, s, sym) : () => {};
        }),
      );
      cleanups.push(() => unbindAlerts());
      const navigation = bindNavigation(chart, price, el.current!, { viewWindow: windowRef.current ?? null, historyComplete: true, settleMs: 0 });
      nav.current = navigation;
      cleanups.push(() => {
        navigation.dispose();
        nav.current = null;
      });
      cleanups.push(bindCountdown(chart, price, el.current!, secsOf(res)));
      onChart({ chart, series: [...drawn.series, ...compared] });
      applyScale(chart, scale, compare.length > 0);

      // saved price lines and drawings (chart key = the symbol: they show on every chart of it)
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
    })().catch(e => onProblem(e?.message ?? String(e)));

    return () => {
      closed = true;
      for (const c of [...cleanups].reverse()) {
        try {
          c();
        } catch {
          /* already gone */
        }
      }
      onChart(null);
      chartRef.current = null;
      chart.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, dh, connection, sym, res, chartType, studyKey, compareKey, user, annotations]);

  useEffect(() => nav.current?.update({ viewWindow: viewWindow ?? null }), [viewWindow]);
  useEffect(() => {
    if (chartRef.current) applyScale(chartRef.current, scale, compare.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, compareKey]);
  return <div ref={el} style={{ position: 'absolute', inset: 0 }} />;
}

function applyScale(chart: IChartApi, scale: string, comparing: boolean) {
  const s = comparing && scale === 'normal' ? 'percent' : scale;
  try {
    chart.priceScale('right', 0).applyOptions({
      mode: s === 'log' ? PriceScaleMode.Logarithmic : s === 'percent' ? PriceScaleMode.Percentage : PriceScaleMode.Normal,
    });
    for (let i = 1; i < chart.panes().length; i++) chart.priceScale('right', i).applyOptions({ mode: PriceScaleMode.Normal });
  } catch {
    /* being rebuilt */
  }
}

// ----------------------------------------------------------------------------- market status, alerts

function useMarketStatus(sym: string, note?: string): LegendStatus | undefined {
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
    return { state: st.state, label: st.label, detail: [change, st.name, note].filter(Boolean).join(' · ') };
  }, [sym, now, note]);
}

function PageAlerts({ symbol, studies }: { symbol: string; studies: StudyInstance[] }) {
  const [store, setStore] = useState<AlertStore | undefined>();
  const [, redraw] = useState(0);
  useEffect(() => onPageAlertStore(setStore), []);
  useEffect(() => store?.subscribe(() => redraw(n => n + 1)), [store]);
  const rows = (store?.list() ?? [])
    .filter(a => a.status === 'active' || a.status === 'triggered')
    .map(a => ({ id: a.id, sym: a.sym, description: describeAlert(a), message: a.message, status: a.status as 'active' | 'triggered', createdMs: a.createdMs, triggeredMs: a.triggeredMs, triggerValue: a.triggerValue }));
  // alert on the price, or on the value of any of the chart's single-line studies at 1m and 5m
  const sources = [
    { key: 'Last', label: 'Price (last)' },
    ...studies
      .filter(s => !['BB', 'KC', 'DC', 'Volume'].includes(s.type))
      .flatMap(s => {
        const st = makeStudy({ type: s.type, params: s.params });
        return ['1m', '5m'].map(r => ({ key: `${st.columns[0]}@${r}`, label: `${studyLabel(s.type, s.params)} (${r})` }));
      }),
  ];
  return (
    <AlertsPanel
      alerts={rows}
      symbol={symbol}
      sources={sources}
      onCreate={store ? a => void store.put({ sym: a.sym, source: a.source, kind: a.source === 'Last' ? 'price' : 'study', op: a.op, level: a.level, message: a.message }) : undefined}
      onCancel={store ? id => void store.cancel(id) : undefined}
    />
  );
}

function WatchlistSide({ table, title, sym, setSym }: { table: string; title?: string; sym: string; setSym: (s: string) => void }) {
  const watch = useRows(table, ['Sym', 'Last', 'Chg', 'ChgPct', 'Name']).value ?? [];
  return (
    <Watchlist
      title={title ?? 'Watchlist'}
      rows={watch.map(r => ({ symbol: String(r.Sym), last: r.Last as number, chg: r.Chg as number, chgPct: r.ChgPct as number, description: String(r.Name ?? '') }))}
      selected={sym}
      onSelect={setSym}
    />
  );
}

// ----------------------------------------------------------------------------- the workspace (toolbar, legend, side panel)

function ChartWorkspace({ opts, params, setParams, setTitle, linkGroup }: PanelProps<ChartWorkspaceParams> & { opts: ChartWorkspaceOptions }) {
  const symbols = opts.useSymbols();
  const [linked, setSym] = useLink<string>('symbol', { group: linkGroup, initial: params.symbol });
  // a series symbol arriving on the link (a bond's idio) charts that series of its base symbol
  const resolved = linked ? opts.baseOf?.(linked) ?? null : null;
  const base = resolved?.base ?? linked;
  const choices = opts.useSeries?.(base) ?? [];
  const seriesKey = (resolved && choices.some(c => c.key === resolved.series) ? resolved.series : undefined) ??
    choices.find(c => c.key === params.series)?.key ?? choices[0]?.key;
  const sym = choices.find(c => c.key === seriesKey)?.sym ?? base;
  useEffect(() => {
    if (resolved && resolved.base !== linked) {
      setParams({ series: resolved.series });
      setSym(resolved.base);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked]);
  const inst = opts.useInstrument(sym);
  const [lwc, setLwc] = useState<{ chart: IChartApi; series: ISeriesApi<SeriesType>[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const status = useMarketStatus(sym, opts.statusNote);
  const p = params;
  const set = (patch: Partial<ChartWorkspaceParams>) => setParams(patch);

  // the symbol is linked: keep the saved params and the tab title in step
  useEffect(() => {
    if (base && base !== p.symbol) setParams({ symbol: base });
    setTitle(`${sym} ${p.res}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sym, p.res]);

  const allowed = useMemo(() => new Set(studiesFor(inst?.has_volume ?? true)), [inst?.has_volume]);
  const shownStudies = p.studies.filter(s => allowed.has(s.type));

  const options: ToolbarOptions = useMemo(
    () => ({
      symbols,
      expressions: true,
      compare: true,
      resolutions: RES.map(([k, g]) => ({ key: k, label: k, group: g })),
      chartTypes: [
        { key: 'candle', label: 'Candles' },
        { key: 'bar', label: 'Bars' },
        { key: 'line', label: 'Line' },
        { key: 'area', label: 'Area' },
      ],
      studies: Object.entries(STUDY_TYPES)
        .filter(([k]) => allowed.has(k))
        .map(([k, t]) => ({ key: k, label: t.label, group: t.group, description: t.description })),
      addStudies: true,
      ranges: Object.keys(RANGES).map(k => ({ key: k, label: k })),
      scales: true,
      panels: [
        ...(opts.watchlist ? [{ key: 'watchlist', label: 'Watchlist' }] : []),
        { key: 'alerts', label: 'Alerts' },
        ...(opts.panels ?? []).map(x => ({ key: x.key, label: x.label })),
      ],
      series: choices.map(c => ({ key: c.key, label: c.label, description: c.sym })),
    }),
    [symbols, allowed, opts.watchlist, opts.panels, choices.map(c => c.key + c.sym).join()], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const compare = p.compare.map((c, i) => ({ sym: c, color: COMPARE_COLORS[i % COMPARE_COLORS.length] }));

  const onToolbar = (patch: ToolbarValue) => {
    if (patch.symbol) setSym(patch.symbol);
    if (patch.series) set({ series: patch.series });
    if (patch.addStudy && STUDY_TYPES[patch.addStudy]) set({ studies: [...p.studies, newStudy(patch.addStudy, pickColor(p.studies.map(s => s.color)))] });
    if (patch.addCompare && patch.addCompare !== sym && !p.compare.includes(patch.addCompare)) set({ compare: [...p.compare, patch.addCompare] });
    const out: Partial<ChartWorkspaceParams> = {};
    if (patch.resolution) out.res = patch.resolution;
    if (patch.range) out.range = patch.range;
    if (patch.chartType) out.chartType = patch.chartType;
    if (patch.scale) out.scale = patch.scale;
    if (patch.panel !== undefined) out.panel = patch.panel;
    if (Object.keys(out).length) set(out);
  };

  const legend: LegendStudy[] = [
    ...shownStudies.map(s => {
      const st = makeStudy({ type: s.type, params: s.params });
      return { id: s.id, label: studyLabel(s.type, s.params), columns: st.columns, color: s.color, visible: s.visible, type: s.type, params: s.params };
    }),
    ...compare.map(c => ({ id: `cmp:${c.sym}`, label: c.sym, columns: [c.sym], color: c.color, visible: true, kind: 'compare' as const })),
  ];
  const studyTypes = useMemo(
    () => Object.fromEntries(Object.entries(STUDY_TYPES).filter(([, t]) => Object.keys(t.params).length).map(([k, t]) => [k, { label: t.label, params: t.params }])),
    [],
  );
  const scaleShown = compare.length && p.scale === 'normal' ? 'percent' : p.scale;
  const own = opts.panels?.find(x => x.key === p.panel);

  return (
    <div className="acme-cw">
      <div className="acme-cw-main">
        <ChartToolbar
          value={{ symbol: base, series: seriesKey, resolution: p.res, range: p.range, chartType: p.chartType, studies: shownStudies.map(s => s.type), scale: scaleShown, panel: p.panel }}
          options={options}
          onChange={onToolbar}
        />
        <div className="acme-cw-body">
          <WorkspaceChart
            api={opts.api ?? 'chart_api'}
            user={opts.user}
            annotations={opts.annotations ?? 'chart_annotations'}
            sym={sym}
            res={p.res}
            chartType={(p.chartType || 'candle') as PriceType}
            studies={shownStudies}
            compare={compare}
            scale={p.scale}
            viewWindow={RANGES[p.range] ?? null}
            onChart={setLwc}
            onProblem={setProblem}
          />
          <ChartLegend
            chart={lwc?.chart ?? null}
            series={lwc?.series ?? []}
            title={`${sym}${inst?.name ? ' · ' + inst.name : ''}`}
            status={status}
            studies={legend}
            studyTypes={studyTypes}
            onStudyChange={patch => {
              if (patch.id.startsWith('cmp:')) {
                if (patch.remove) set({ compare: p.compare.filter(c => c !== patch.id.slice(4)) });
                return;
              }
              if (patch.remove) return set({ studies: p.studies.filter(s => s.id !== patch.id) });
              set({
                studies: p.studies.map(s =>
                  s.id !== patch.id
                    ? s
                    : { ...s, ...(patch.visible !== undefined ? { visible: patch.visible } : {}), ...(patch.params ? { params: { ...s.params, ...patch.params } } : {}), ...(patch.color ? { color: patch.color } : {}) },
                ),
              });
            }}
          />
          {problem && <div className="acme-cw-problem">{problem}</div>}
        </div>
      </div>
      {p.panel === 'watchlist' && opts.watchlist && (
        <div className="acme-cw-side">
          <WatchlistSide table={opts.watchlist.table} title={opts.watchlist.title} sym={sym} setSym={setSym} />
        </div>
      )}
      {p.panel === 'alerts' && (
        <div className="acme-cw-side">
          <PageAlerts symbol={sym} studies={shownStudies} />
        </div>
      )}
      {own && <div className="acme-cw-side">{own.render(sym, inst)}</div>}
    </div>
  );
}

/** The chart workspace as a panel kind. */
export function chartWorkspacePanel(opts: ChartWorkspaceOptions): PanelKind {
  const defaults: ChartWorkspaceParams = {
    symbol: '', res: '5m', range: '1D', chartType: 'candle', scale: 'normal', compare: [], panel: '', studies: instancesOf(['EMA_20', 'EMA_50', 'Volume']),
    ...opts.defaultParams,
  };
  return definePanel<ChartWorkspaceParams>({
    kind: opts.kind ?? 'chart-workspace',
    label: opts.label ?? 'Chart',
    title: p => `${p.symbol} ${p.res}`,
    description: opts.description ?? 'A chart of any symbol or expression: indicators, drawings, alerts, compare',
    defaultParams: defaults,
    component: props => <ChartWorkspace {...props} opts={opts} />,
  });
}
