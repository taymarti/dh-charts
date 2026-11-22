/**
 * Draw a SeriesFeed on a Lightweight Charts chart: the price (candles, bars, line or area) and study
 * columns, each study on the price pane ("overlay") or in its own pane below (rsi, volume, ...), in
 * first-seen order. Panes need Lightweight Charts 5.
 *
 *   const drawn = bindFeed(chart, feed, {
 *     price: { type: 'candle', title: 'ES', tick: 0.25 },
 *     studies: [{ column: 'EMA_20', color: '#f7a600' }, { column: 'RSI_14', pane: 'rsi' },
 *               { column: 'Volume', pane: 'volume', histogram: true }],
 *   });
 *   drawn.series      // [price, ...studies], for legends
 *   drawn.dispose()   // removes the series and unsubscribes
 *
 * bindCompare overlays another feed's Close as a line (put the price scale in percent mode to compare).
 */
import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { FeedRow, SeriesFeed } from './feed';
import { priceFormatFor } from './format';

export type PriceType = 'candle' | 'bar' | 'line' | 'area';

export interface StudyLayout {
  column: string;
  /** "overlay" (default): on the price pane; any other name: its own pane, shared by studies with that name */
  pane?: string;
  color?: string;
  title?: string;
  dashed?: boolean;
  histogram?: boolean;
  /** reference levels on the study's pane (RSI 30 and 70) */
  levels?: number[];
}

export interface FeedLayout {
  price: { type?: PriceType; title?: string; tick?: number | null; up?: string; down?: string; line?: string };
  studies?: StudyLayout[];
  /** the price pane's height relative to each other pane (default 3) */
  priceStretch?: number;
}

export interface DrawnFeed {
  /** the price series first, then one per study, in layout order */
  series: ISeriesApi<SeriesType>[];
  /** pane index per pane name ("overlay" is 0) */
  panes: Record<string, number>;
  dispose(): void;
}

const UP = '#26a69a';
const DOWN = '#ef5350';
const LINE = '#2962ff';

const ts = (r: FeedRow) => r.time as UTCTimestamp;
const ok = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

/** Pane index per pane name: overlay 0, then others in first-seen order. */
export function paneIndexes(studies: StudyLayout[]): Record<string, number> {
  const out: Record<string, number> = { overlay: 0 };
  let next = 1;
  for (const s of studies) {
    const p = s.pane ?? 'overlay';
    if (!(p in out)) out[p] = next++;
  }
  return out;
}

/** The point a row gives a series: OHLC for candles and bars, a value otherwise; a gap when missing. */
export function pointOf(r: FeedRow, kind: 'ohlc' | string) {
  if (kind === 'ohlc')
    return ok(r.Open) && ok(r.High) && ok(r.Low) && ok(r.Close)
      ? { time: ts(r), open: r.Open, high: r.High, low: r.Low, close: r.Close }
      : { time: ts(r) };
  const v = r[kind];
  return ok(v) ? { time: ts(r), value: v } : { time: ts(r) };
}

export function bindFeed(chart: IChartApi, feed: SeriesFeed, layout: FeedLayout): DrawnFeed {
  const studies = layout.studies ?? [];
  const panes = paneIndexes(studies);
  const p = layout.price;
  const type = p.type ?? 'candle';
  const fmt = priceFormatFor(p.tick);
  const up = p.up ?? UP;
  const down = p.down ?? DOWN;

  const price: ISeriesApi<SeriesType> =
    type === 'candle'
      ? chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down, title: p.title, priceFormat: fmt })
      : type === 'bar'
        ? chart.addSeries(BarSeries, { upColor: up, downColor: down, title: p.title, priceFormat: fmt })
        : type === 'line'
          ? chart.addSeries(LineSeries, { color: p.line ?? LINE, lineWidth: 2, title: p.title, priceFormat: fmt })
          : chart.addSeries(AreaSeries, {
              lineColor: p.line ?? LINE, topColor: 'rgba(41, 98, 255, 0.4)', bottomColor: 'rgba(41, 98, 255, 0)', title: p.title, priceFormat: fmt,
            });
  const priceKind = type === 'candle' || type === 'bar' ? 'ohlc' : 'Close';

  const studySeries = studies.map(s => {
    const pane = panes[s.pane ?? 'overlay'];
    const own = pane > 0;
    const series = s.histogram
      ? chart.addSeries(HistogramSeries, { color: s.color ?? 'rgba(120, 144, 156, 0.6)', title: s.title ?? s.column, priceFormat: { type: 'volume' }, lastValueVisible: true }, pane)
      : chart.addSeries(
          LineSeries,
          {
            color: s.color ?? '#f7a600', lineWidth: 1, lineStyle: s.dashed ? LineStyle.Dashed : LineStyle.Solid,
            title: s.title ?? s.column, lastValueVisible: false, priceLineVisible: false,
            // overlays share the price's format; a pane of their own keeps two decimals
            priceFormat: own ? { type: 'price', precision: 2, minMove: 0.01 } : fmt,
          },
          pane,
        );
    for (const level of s.levels ?? [])
      series.createPriceLine({ price: level, color: 'rgba(120, 144, 156, 0.6)', lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
    return series;
  });

  // the price pane taller than the study panes
  try {
    const all = chart.panes();
    all.forEach((pane, i) => pane.setStretchFactor(i === 0 ? (layout.priceStretch ?? 3) : 1));
  } catch {
    /* an older Lightweight Charts without panes */
  }

  const unsubscribe = feed.subscribe({
    snapshot: rows => {
      price.setData(rows.map(r => pointOf(r, priceKind)) as never);
      studySeries.forEach((s, i) => s.setData(rows.map(r => pointOf(r, studies[i].column)) as never));
    },
    update: rows => {
      for (const r of rows) {
        price.update(pointOf(r, priceKind) as never);
        studySeries.forEach((s, i) => s.update(pointOf(r, studies[i].column) as never));
      }
    },
  });

  return {
    series: [price, ...studySeries],
    panes,
    dispose: () => {
      unsubscribe();
      for (const s of [...studySeries, price]) {
        try {
          chart.removeSeries(s);
        } catch {
          /* the chart is gone */
        }
      }
    },
  };
}

/** Another feed's Close as a line on the price pane (a compared symbol). */
export function bindCompare(chart: IChartApi, feed: SeriesFeed, opts: { title: string; color: string }): DrawnFeed {
  const series = chart.addSeries(LineSeries, { color: opts.color, lineWidth: 2, title: opts.title, lastValueVisible: true, priceLineVisible: false });
  const unsubscribe = feed.subscribe({
    snapshot: rows => series.setData(rows.map(r => pointOf(r, 'Close')) as never),
    update: rows => rows.forEach(r => series.update(pointOf(r, 'Close') as never)),
  });
  return {
    series: [series],
    panes: { overlay: 0 },
    dispose: () => {
      unsubscribe();
      try {
        chart.removeSeries(series);
      } catch {
        /* the chart is gone */
      }
    },
  };
}
