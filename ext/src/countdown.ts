/**
 * Bar-close countdown, as in TradingView: under the last-price label on the price axis, the time
 * left in the forming bar ("00:42", "12:05", "1:02:10"), colored like the bar. A DOM overlay on any
 * LWC chart; the host says the bar length (Deephaven charts don't carry it).
 *
 *   bindCountdown(chart, series, host, barSeconds)
 */
import { MismatchDirection, type IChartApi, type ISeriesApi, type SeriesType } from 'lightweight-charts';

const UP = '#26a69a';
const DOWN = '#ef5350';

type Bar = { time?: unknown; open?: number; close?: number; value?: number };

function format(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

export function bindCountdown(chart: IChartApi, series: ISeriesApi<SeriesType>, host: HTMLElement, barSeconds: number): () => void {
  if (!(barSeconds >= 5)) return () => {}; // nothing to count down on ticks and 1-second bars
  const el = document.createElement('div');
  el.className = 'acme-countdown';
  Object.assign(el.style, {
    position: 'absolute', zIndex: '4', pointerEvents: 'none', display: 'none', padding: '0 4px', borderRadius: '2px',
    font: '11px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, sans-serif', color: '#fff', lineHeight: '16px',
    boxSizing: 'border-box', textAlign: 'center',
  });
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.appendChild(el);

  const render = () => {
    let bar: Bar | null = null;
    try {
      bar = series.dataByIndex(Number.MAX_SAFE_INTEGER, MismatchDirection.NearestLeft) as Bar | null;
    } catch {
      bar = null;
    }
    const close = bar?.close ?? bar?.value;
    const t = Number(bar?.time);
    const left = t + barSeconds - Date.now() / 1000;
    // only while the bar is forming (a stale chart, or a closed market, shows nothing)
    if (close == null || !Number.isFinite(t) || left < 0 || left > barSeconds) {
      el.style.display = 'none';
      return;
    }
    let y: number | null;
    let scaleWidth: number;
    let chartEl: HTMLElement;
    try {
      y = series.priceToCoordinate(close);
      scaleWidth = chart.priceScale('right').width();
      chartEl = chart.chartElement();
    } catch {
      el.style.display = 'none'; // the chart is being rebuilt
      return;
    }
    if (y == null || !scaleWidth) {
      el.style.display = 'none';
      return;
    }
    const hr = host.getBoundingClientRect();
    const cr = chartEl.getBoundingClientRect();
    el.textContent = format(left);
    el.style.display = 'block';
    el.style.background = bar?.open != null && close < bar.open ? DOWN : bar?.open != null ? UP : '#2962ff';
    el.style.width = `${scaleWidth}px`;
    el.style.left = `${cr.left - hr.left + cr.width - scaleWidth}px`;
    el.style.top = `${cr.top - hr.top + y + 10}px`;
  };

  const timer = setInterval(render, 1000);
  // a data change (every tick) only schedules a render: render() measures the layout, and doing that inside the
  // feed's update forced a synchronous layout of the whole page on every tick
  let frame = 0;
  const onData = () => {
    if (!frame) frame = requestAnimationFrame(() => ((frame = 0), render()));
  };
  series.subscribeDataChanged(onData);
  chart.timeScale().subscribeVisibleLogicalRangeChange(onData);
  render();
  return () => {
    clearInterval(timer);
    cancelAnimationFrame(frame);
    try {
      series.unsubscribeDataChanged(onData);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onData);
    } catch {
      /* the chart is gone */
    }
    el.remove();
  };
}
