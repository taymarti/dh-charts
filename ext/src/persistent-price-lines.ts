/**
 * Persistent price lines: TradingView's official user-price-lines plugin, unchanged, bound to an
 * AnnotationStore. Lines the user adds are saved (kind "price_line", spec {price}); saved lines are
 * restored when the chart is (re)built and follow changes from other tabs and users live.
 *
 * Gestures, beyond the plugin's own "+" button:
 *   Shift+click on a line   delete it (own lines only)
 *   Ctrl+click on a line    share / unshare it (own lines only)
 * Others' shared lines are drawn in blue with the owner's name.
 *
 * Usable by every front end: bindPriceLines(series, store, chartKey) needs only an LWC series.
 */
import type { IChartApi, IPriceLine, ISeriesApi, MouseEventParams, SeriesType, Time } from 'lightweight-charts';
import { UserPriceLines, type UserPriceLinesOptions } from '@tradingview/lwc-plugin-user-price-lines';
import { newAnnotationId, onPageAnnotationStore, type AnnotationStore } from './annotations';
import type { TvlChartContext, TvlExtension } from './hook';

const KIND = 'price_line';
const OWN = '#f7a600';
const SHARED_OWN = '#ffd54f';
const OTHERS = '#2962ff';
const HIT_PX = 6;

export function bindPriceLines(
  chart: IChartApi,
  series: ISeriesApi<SeriesType>,
  store: AnnotationStore,
  chartKey: string,
  options?: Partial<UserPriceLinesOptions>,
): () => void {
  const plugin = new UserPriceLines({ lineColor: OWN, ...options });
  series.attachPrimitive(plugin);
  const idOf = new Map<IPriceLine, string>();
  const lineOf = new Map<string, IPriceLine>();
  let applying = false; // changes we make from the store must not be saved back
  let detaching = false; // detaching removes every line; that is not the user deleting them

  const style = (line: IPriceLine, a: { owner: string; shared: boolean }) => {
    const mine = a.owner === store.owner;
    line.applyOptions({
      color: mine ? (a.shared ? SHARED_OWN : OWN) : OTHERS,
      title: mine ? (a.shared ? 'shared' : '') : a.owner,
    });
  };

  const sync = () => {
    applying = true;
    try {
      const want = store.list(chartKey).filter(a => a.kind === KIND && typeof a.spec.price === 'number');
      const ids = new Set(want.map(a => a.id));
      for (const [id, line] of lineOf) {
        if (!ids.has(id)) {
          plugin.removeLine(line);
          lineOf.delete(id);
          idOf.delete(line);
        }
      }
      for (const a of want) {
        let line = lineOf.get(a.id);
        if (!line) {
          line = plugin.addLine(a.spec.price as number);
          lineOf.set(a.id, line);
          idOf.set(line, a.id);
        } else if (line.options().price !== a.spec.price) {
          line.applyOptions({ price: a.spec.price as number });
        }
        style(line, a);
      }
    } finally {
      applying = false;
    }
  };

  const onAdded = (line: IPriceLine) => {
    if (applying) return;
    const id = newAnnotationId();
    idOf.set(line, id);
    lineOf.set(id, line);
    void store.put({ chartKey, id, kind: KIND, spec: { price: line.options().price } });
  };
  const onRemoved = (line: IPriceLine) => {
    if (applying || detaching) return;
    const id = idOf.get(line);
    if (id === undefined) return;
    idOf.delete(line);
    lineOf.delete(id);
    void store.remove(chartKey, id);
  };

  // Shift+click deletes, Ctrl+click shares: the user's own line nearest the click, within a few pixels
  const onClick = (p: MouseEventParams<Time>) => {
    const ev = p.sourceEvent;
    if (!p.point || !ev || !(ev.shiftKey || ev.ctrlKey || ev.metaKey)) return;
    let best: { id: string; dist: number } | undefined;
    for (const [id, line] of lineOf) {
      const y = series.priceToCoordinate(line.options().price);
      const dist = y == null ? Infinity : Math.abs(y - p.point.y);
      if (dist <= HIT_PX && (!best || dist < best.dist)) best = { id, dist };
    }
    if (!best) return;
    const a = store.list(chartKey).find(x => x.id === best!.id);
    if (!a || a.owner !== store.owner) return;
    if (ev.shiftKey) void store.remove(chartKey, a.id);
    else void store.put({ chartKey, id: a.id, kind: KIND, spec: a.spec, shared: !a.shared });
  };

  plugin.lineAdded().subscribe(onAdded);
  plugin.lineRemoved().subscribe(onRemoved);
  chart.subscribeClick(onClick);
  sync();
  const unsubscribe = store.subscribe(sync);

  return () => {
    unsubscribe();
    chart.unsubscribeClick(onClick);
    plugin.lineAdded().unsubscribe(onAdded);
    plugin.lineRemoved().unsubscribe(onRemoved);
    detaching = true;
    series.detachPrimitive(plugin);
  };
}

/** The chart key of a Deephaven chart: its price series' title (L1 charts set it to the symbol). */
export function titleChartKey(ctx: TvlChartContext): string | undefined {
  const title = ctx.series[0]?.options().title;
  return title ? String(title) : undefined;
}

/**
 * Extension: persistent price lines on every chart, using `store`, or the page's store when it
 * arrives (setPageAnnotationStore). Charts without a chart key get the plain, unsaved plugin.
 */
export function persistentPriceLines(
  options?: Partial<UserPriceLinesOptions>,
  store?: AnnotationStore,
  keyOf: (ctx: TvlChartContext) => string | undefined = titleChartKey,
): TvlExtension {
  return ctx => {
    const key = keyOf(ctx);
    let unbind = () => {};
    const bind = (s: AnnotationStore | undefined) => {
      unbind();
      unbind = s && key ? bindPriceLines(ctx.chart, ctx.series[0], s, key, options) : plainLines(ctx, options);
    };
    if (store) {
      bind(store);
      return () => unbind();
    }
    // unsaved lines until the page's store arrives (pages without one keep working), then saved ones
    bind(undefined);
    const unsubscribe = onPageAnnotationStore(bind);
    return () => {
      unsubscribe();
      unbind();
    };
  };
}

function plainLines(ctx: TvlChartContext, options?: Partial<UserPriceLinesOptions>): () => void {
  const plugin = new UserPriceLines({ lineColor: OWN, ...options });
  ctx.series[0].attachPrimitive(plugin);
  return () => ctx.series[0].detachPrimitive(plugin);
}
