/**
 * Crosshair and time-range sync between charts, in groups. A chart's groups come from the nearest
 * ancestor attributes, read at the moment of each move, so a host can switch sync on and off (or move
 * a chart between groups) without rebinding:
 *
 *   data-acme-sync-crosshair="<group>"   crosshair group; "none" turns it off. Without the attribute: "page".
 *   data-acme-sync-time="<group>"        visible-range group; no attribute (or "none"): no time sync.
 *
 * Moving over one chart puts the crosshair at the same time on the group's other charts, at each one's
 * own price at that time; scrolling or zooming one (time sync) shows the same time range on the others.
 * Charts share one time axis (UTC seconds), so times line up across symbols and resolutions.
 *
 *   bindSync(chart, series, element)   any LWC chart (front-end group C)
 *   crosshairSync()                    extension for Deephaven charts (crosshair and time, by attribute)
 */
import { MismatchDirection, type IChartApi, type ISeriesApi, type LogicalRange, type SeriesType, type Time } from 'lightweight-charts';
import type { TvlExtension } from './hook';

interface Member {
  chart: IChartApi;
  series: ISeriesApi<SeriesType>;
  element: HTMLElement;
}

/** Event a synced chart fires when it is asked to show a range older than its data. */
export const NEED_HISTORY = 'acme-need-history';

const members = new Set<Member>();
let syncing = false; // our own setCrosshairPosition / setVisibleRange must not echo back

function groupOf(el: HTMLElement, kind: 'crosshair' | 'time'): string | null {
  const attr = `data-acme-sync-${kind}`;
  const v = el.closest(`[${attr}]`)?.getAttribute(attr);
  if (v == null) return kind === 'crosshair' ? 'page' : null;
  return v === '' || v === 'none' ? null : v;
}

function peers(me: Member, kind: 'crosshair' | 'time'): Member[] {
  const g = groupOf(me.element, kind);
  if (g == null) return [];
  return [...members].filter(m => m !== me && m.element.isConnected && groupOf(m.element, kind) === g);
}

/** Sync `chart` (price series `series`, inside `element`) with the other bound charts of its groups. */
export function bindSync(chart: IChartApi, series: ISeriesApi<SeriesType>, element: HTMLElement): () => void {
  const me: Member = { chart, series, element };
  members.add(me);

  const onMove = (param: { time?: Time }) => {
    if (syncing) return;
    syncing = true;
    try {
      for (const m of peers(me, 'crosshair')) {
        try {
          const price = param.time === undefined ? undefined : priceAt(m.chart, m.series, param.time);
          if (price === undefined || param.time === undefined) m.chart.clearCrosshairPosition();
          else m.chart.setCrosshairPosition(price, param.time, m.series);
        } catch {
          // a peer between rebuilds (its series is being replaced): skip it this move
        }
      }
    } finally {
      syncing = false;
    }
  };

  // only the chart the user is working (pointer over it) leads; the others follow
  const onRange = (_: LogicalRange | null) => {
    if (syncing || !element.matches(':hover')) return;
    const v = chart.timeScale().getVisibleRange();
    if (!v) return;
    // whole seconds: setVisibleRange ignores fractional times (the plugin's ranges can be fractional)
    const r = { from: Math.floor(v.from as number) as Time, to: Math.ceil(v.to as number) as Time };
    syncing = true;
    try {
      for (const m of peers(me, 'time')) {
        try {
          // a range older than the peer's data: ask its host to load history (bindNavigation listens)
          // and to show the range once it is there
          const first = (m.series.data()[0] as { time?: unknown } | undefined)?.time;
          if (first != null && (r.from as number) < Number(first)) {
            m.element.dispatchEvent(
              new CustomEvent(NEED_HISTORY, { bubbles: true, detail: { before: r.from as number, from: r.from, to: r.to } }),
            );
          }
          m.chart.timeScale().setVisibleRange(r);
        } catch {
          /* a chart with no data yet */
        }
      }
    } finally {
      syncing = false;
    }
  };

  chart.subscribeCrosshairMove(onMove);
  chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
  return () => {
    chart.unsubscribeCrosshairMove(onMove);
    chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
    members.delete(me);
  };
}

/** Extension: crosshair (and, where the attribute says so, time) sync for every Deephaven chart. */
export function crosshairSync(): TvlExtension {
  return ({ chart, series, element }) => bindSync(chart, series[0], element);
}

/** The series' value (close, for OHLC) at or just before `time`. */
function priceAt(chart: IChartApi, series: ISeriesApi<SeriesType>, time: Time): number | undefined {
  const idx = chart.timeScale().timeToIndex(time, true);
  if (idx == null) return undefined;
  const bar = series.dataByIndex(idx, MismatchDirection.NearestLeft) as { close?: number; value?: number } | null;
  return bar?.close ?? bar?.value;
}
