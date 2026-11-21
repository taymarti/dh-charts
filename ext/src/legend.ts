/**
 * OHLC legend, TradingView style, at the chart's top left: the symbol, then O H L C of the bar under
 * the crosshair (or the latest bar), and the change from the previous bar's close, colored up/down.
 * Line or area series show their value. A plain DOM overlay over any LWC chart; no Deephaven dependency.
 *
 *   bindLegend(chart, series, host, title)   any LWC chart
 *   ohlcLegend()                             extension for Deephaven charts (title = chart key)
 */
import type { IChartApi, ISeriesApi, MouseEventParams, SeriesType, Time } from 'lightweight-charts';
import { titleChartKey } from './persistent-price-lines';
import type { TvlChartContext, TvlExtension } from './hook';

const UP = '#26a69a';
const DOWN = '#ef5350';

type Bar = { time?: unknown; open?: number; high?: number; low?: number; close?: number; value?: number };

export function bindLegend(chart: IChartApi, series: ISeriesApi<SeriesType>, host: HTMLElement, title: string): () => void {
  const el = document.createElement('div');
  el.className = 'acme-legend';
  Object.assign(el.style, {
    position: 'absolute', left: '8px', top: '6px', zIndex: '4', pointerEvents: 'none', whiteSpace: 'nowrap',
    font: '12px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif', color: '#d1d4dc',
  });
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.appendChild(el);

  const precision = () => {
    const pf = series.options().priceFormat as { precision?: number } | undefined;
    return pf?.precision ?? 2;
  };
  const prevOf = (bar: Bar): Bar | undefined => {
    const data = series.data() as Bar[];
    let lo = 0;
    let hi = data.length - 1;
    const t = Number(bar.time);
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const mt = Number(data[mid].time);
      if (mt === t) return data[mid - 1];
      if (mt < t) lo = mid + 1;
      else hi = mid - 1;
    }
    return undefined;
  };
  const render = (bar: Bar | undefined) => {
    const p = precision();
    const f = (v: number | undefined) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(p));
    const close = bar?.close ?? bar?.value;
    const prev = bar && prevOf(bar);
    const prevClose = prev?.close ?? prev?.value;
    const chg = close != null && prevClose != null ? close - prevClose : undefined;
    const color = chg == null ? '#d1d4dc' : chg >= 0 ? UP : DOWN;
    const v = (label: string, x: number | undefined) =>
      `${label ? `<span style="color:#787b86;margin-right:2px">${label}</span>` : ''}<span style="color:${color}">${f(x)}</span>`;
    const parts = [`<span style="font-weight:600;font-size:13px">${title}</span>`];
    if (bar?.open != null) parts.push(v('O', bar.open), v('H', bar.high), v('L', bar.low), v('C', bar.close));
    else parts.push(v('', close));
    if (chg != null && prevClose) {
      const sign = chg >= 0 ? '+' : '';
      parts.push(`<span style="color:${color}">${sign}${chg.toFixed(p)} (${sign}${((100 * chg) / prevClose).toFixed(2)}%)</span>`);
    }
    el.innerHTML = parts.join('&nbsp;&nbsp;');
  };

  let hovering = false;
  const latest = () => {
    const d = series.data() as Bar[];
    return d[d.length - 1];
  };
  const onMove = (p: MouseEventParams<Time>) => {
    const bar = p.seriesData.get(series) as Bar | undefined;
    hovering = bar != null;
    render(bar ?? latest());
  };
  const onData = () => {
    if (!hovering) render(latest());
  };
  chart.subscribeCrosshairMove(onMove);
  series.subscribeDataChanged(onData);
  render(latest());

  return () => {
    chart.unsubscribeCrosshairMove(onMove);
    series.unsubscribeDataChanged(onData);
    el.remove();
  };
}

/** Extension: the OHLC legend on every Deephaven chart, titled with the chart key (the symbol). */
export function ohlcLegend(keyOf: (ctx: TvlChartContext) => string | undefined = titleChartKey): TvlExtension {
  return ctx => bindLegend(ctx.chart, ctx.series[0], ctx.element, keyOf(ctx) ?? '');
}
