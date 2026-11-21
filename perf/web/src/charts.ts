/**
 * The two client-side chart implementations, written the way a careful developer would:
 *   lwc     TradingView Lightweight Charts 5: setData once, then series.update() per new point
 *   plotly  plotly.js scattergl (what dx.line uses by default): newPlot once, then extendTraces;
 *           candles redraw with Plotly.react (they are few)
 * Each takes a container and returns { push(batch), dispose() }. Pushes are coalesced to one
 * draw per animation frame.
 */
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import Plotly from 'plotly.js-dist-min';
import type { Batch } from './dh';
import { markReady, recordPaint } from './probe';

export type Kind = 'line' | 'candle';
export interface ChartHandle {
  push(b: Batch): void;
  dispose(): void;
}

const THEME = { bg: '#131722', text: '#d1d4dc', grid: '#1e222d', border: '#2a2e39', up: '#26a69a', down: '#ef5350', line: '#2962ff' };

/** Coalesce batches into one draw per frame. */
function framed(draw: (batches: Batch[]) => void): (b: Batch) => void {
  let pending: Batch[] = [];
  let scheduled = false;
  return b => {
    pending.push(b);
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const bs = pending;
      pending = [];
      draw(bs);
    });
  };
}

const sec = (ms: number) => (ms / 1000) as UTCTimestamp;

/** Time of the newest tick in a batch: the row time for ticks, the Updated column (v[4], epoch ns) for bars. */
function newestTick(b: Batch): number {
  if (b.v.length < 5) return b.t[b.t.length - 1];
  let m = -Infinity;
  for (const u of b.v[4]) m = Math.max(m, u / 1e6);
  return m;
}

export function lwcChart(el: HTMLElement, id: string, kind: Kind): ChartHandle {
  const chart: IChartApi = createChart(el, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: THEME.bg }, textColor: THEME.text, fontSize: 11, attributionLogo: false },
    grid: { vertLines: { color: THEME.grid }, horzLines: { color: THEME.grid } },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: THEME.border },
    timeScale: { borderColor: THEME.border, timeVisible: true, secondsVisible: true },
  });
  const series: ISeriesApi<'Line'> | ISeriesApi<'Candlestick'> =
    kind === 'line'
      ? chart.addSeries(LineSeries, { color: THEME.line, lineWidth: 1, priceLineVisible: true })
      : chart.addSeries(CandlestickSeries, {
          upColor: THEME.up, downColor: THEME.down, borderVisible: false, wickUpColor: THEME.up, wickDownColor: THEME.down,
        });
  let lastT = -Infinity;
  const toPoint = (b: Batch, i: number) =>
    kind === 'line'
      ? { time: sec(b.t[i]), value: b.v[0][i] }
      : { time: sec(b.t[i]), open: b.v[0][i], high: b.v[1][i], low: b.v[2][i], close: b.v[3][i] };

  const push = framed(batches => {
    let newest = -Infinity;
    for (const b of batches) {
      if (b.t.length === 0) continue;
      if (b.snapshot) {
        const pts = Array.from(b.t, (_, i) => toPoint(b, i));
        (series as ISeriesApi<'Line'>).setData(pts as never);
        lastT = b.t[b.t.length - 1];
      } else {
        for (let i = 0; i < b.t.length; i++) {
          if (b.t[i] < lastT) continue; // LWC accepts only the last point or a newer one
          (series as ISeriesApi<'Line'>).update(toPoint(b, i) as never);
          lastT = b.t[i];
        }
      }
      newest = Math.max(newest, newestTick(b));
    }
    if (batches.some(b => b.snapshot)) markReady(id);
    else if (newest > -Infinity) recordPaint(newest);
  });
  return { push, dispose: () => chart.remove() };
}

export function plotlyChart(el: HTMLElement, id: string, kind: Kind): ChartHandle {
  const layout: Record<string, unknown> = {
    paper_bgcolor: THEME.bg,
    plot_bgcolor: THEME.bg,
    font: { color: THEME.text, size: 10 },
    margin: { l: 40, r: 10, t: 20, b: 30 },
    xaxis: { type: 'date', gridcolor: THEME.grid, rangeslider: { visible: false } },
    yaxis: { gridcolor: THEME.grid, side: 'right' },
    showlegend: false,
    title: { text: id, font: { size: 11 } },
  };
  const config: Record<string, unknown> = { responsive: true, displaylogo: false };
  let started = false;
  // candles: keep bars by time, redraw all (a few dozen) per update
  const bars = new Map<number, [number, number, number, number]>();

  const push = framed(async batches => {
    let newest = -Infinity;
    for (const b of batches) if (b.t.length) newest = Math.max(newest, newestTick(b));
    if (kind === 'line') {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const b of batches) for (let i = 0; i < b.t.length; i++) { xs.push(b.t[i]); ys.push(b.v[0][i]); }
      if (!started) {
        await Plotly.newPlot(el, [{ type: 'scattergl', mode: 'lines', x: xs, y: ys, line: { color: THEME.line, width: 1 } }], layout, config);
        started = true;
        markReady(id);
        return;
      }
      if (xs.length) await Plotly.extendTraces(el, { x: [xs], y: [ys] }, [0]);
    } else {
      for (const b of batches) for (let i = 0; i < b.t.length; i++) bars.set(b.t[i], [b.v[0][i], b.v[1][i], b.v[2][i], b.v[3][i]]);
      const ts = [...bars.keys()].sort((a, c) => a - c);
      const trace = {
        type: 'candlestick' as const,
        x: ts,
        open: ts.map(t => bars.get(t)![0]),
        high: ts.map(t => bars.get(t)![1]),
        low: ts.map(t => bars.get(t)![2]),
        close: ts.map(t => bars.get(t)![3]),
        increasing: { line: { color: THEME.up } },
        decreasing: { line: { color: THEME.down } },
      };
      await Plotly.react(el, [trace], layout, config);
      if (!started) { started = true; markReady(id); return; }
    }
    if (newest > -Infinity) recordPaint(newest);
  });
  return { push, dispose: () => Plotly.purge(el) };
}
