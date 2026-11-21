/**
 * Our side of the chart hook: find every Deephaven TradingView chart under a root element and run our
 * extensions (plain Lightweight Charts plugins and behaviours) against its LWC chart and series.
 *
 * The plugin side is our fork of Deephaven's plugin (TVL_CHART_EVENT in TradingViewChartRenderer, branch
 * acme/tradingview-lightweight): the renderer fires a bubbling "tvl-chart" DOM event from its container
 * on "ready", "series" and "destroy", and keeps itself as container.__tvlRenderer. Nothing here imports
 * or reaches into the Deephaven plugin's code (the names are literals), so the same extensions work in
 * our React host and, via dh-chart-ext's document listener, in deephaven.ui.
 *
 * Series are recreated whenever the plugin reconfigures them, so each extension is (re)applied on every
 * "series" event, after the previous application's cleanup has run.
 */
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';

/** The part of the plugin's TradingViewChartRenderer we rely on (public methods in 0.1.0). */
export interface TvlRenderer {
  getChart(): IChartApi;
  getDataSeriesList(): ISeriesApi<SeriesType>[];
  getSeriesIds(): string[];
}

export interface TvlChartContext {
  chart: IChartApi;
  renderer: TvlRenderer;
  /** the data series, in the plugin's order (the first is usually the main price series) */
  series: ISeriesApi<SeriesType>[];
  /** the chart's container element */
  element: HTMLElement;
}

/** Applied once per chart per series configuration; returns its cleanup. */
export type TvlExtension = (ctx: TvlChartContext) => (() => void) | void;

interface TvlChartEventDetail {
  kind: 'ready' | 'series' | 'destroy';
  renderer: TvlRenderer;
  chart: IChartApi;
}

type HostElement = HTMLElement & { __tvlRenderer?: TvlRenderer };

/** Counters for debugging and tests: events seen by kind, and extension applications. */
export const stats = { events: {} as Record<string, number>, applied: 0 };
(globalThis as { __tvlExtStats?: typeof stats }).__tvlExtStats = stats;

/** Run `extensions` on every TradingView chart under `root`, now and as charts come and go. */
export function attachTvlExtensions(root: HTMLElement, extensions: TvlExtension[]): () => void {
  const applied = new Map<TvlRenderer, Array<() => void>>();

  const clear = (renderer: TvlRenderer) => {
    for (const c of applied.get(renderer) ?? []) safe(c);
    applied.delete(renderer);
  };
  const apply = (renderer: TvlRenderer, element: HTMLElement) => {
    clear(renderer);
    const series = renderer.getDataSeriesList();
    if (series.length === 0) return; // wait for the "series" event
    const ctx: TvlChartContext = { chart: renderer.getChart(), renderer, series, element };
    const cleanups: Array<() => void> = [];
    for (const ext of extensions) {
      try {
        const c = ext(ctx);
        if (c) cleanups.push(c);
      } catch (e) {
        console.error('[tvl-ext] extension failed', e);
      }
    }
    applied.set(renderer, cleanups);
    stats.applied++;
  };

  const onEvent = (ev: Event) => {
    const { kind, renderer } = (ev as CustomEvent<TvlChartEventDetail>).detail;
    stats.events[kind] = (stats.events[kind] ?? 0) + 1;
    if (kind === 'destroy' || kind === 'ready') clear(renderer); // a rebuilt chart has new series coming
    else apply(renderer, ev.target as HTMLElement);
  };
  root.addEventListener('tvl-chart', onEvent);

  // charts that announced themselves before we started listening
  root.querySelectorAll<HTMLElement>('.tv-lightweight-charts').forEach(lwc => {
    const host = lwc.parentElement as HostElement | null;
    if (host?.__tvlRenderer) apply(host.__tvlRenderer, host);
  });

  return () => {
    root.removeEventListener('tvl-chart', onEvent);
    for (const r of [...applied.keys()]) clear(r);
  };
}

function safe(f: () => void) {
  try {
    f();
  } catch (e) {
    console.error('[tvl-ext] cleanup failed', e);
  }
}
