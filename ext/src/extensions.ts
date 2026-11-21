/**
 * Extensions: each is a plain Lightweight Charts plugin or behaviour, applied through attachTvlExtensions.
 * User price lines is TradingView's official package used as published; the rest are ours.
 */
import { MismatchDirection, type IChartApi, type ISeriesApi, type SeriesType, type Time } from 'lightweight-charts';
import { UserPriceLines, type UserPriceLinesOptions } from '@tradingview/lwc-plugin-user-price-lines';
import { TimeRangeShading, type RangesFor } from './lwc-plugins/time-range-shading';
import type { TvlExtension } from './hook';

/** Official @tradingview/lwc-plugin-user-price-lines: a "+" at the right edge adds a price line. */
export function userPriceLines(options?: Partial<UserPriceLinesOptions>): TvlExtension {
  return ({ series }) => {
    const plugin = new UserPriceLines(options);
    series[0].attachPrimitive(plugin);
    return () => series[0].detachPrimitive(plugin);
  };
}

/**
 * Shade time ranges (sessions, auctions, halts) with our TimeRangeShading primitive.
 * (The official @tradingview/lwc-plugin-session-highlighting paints one column per bar slot; on the
 * Deephaven plugin's 1-second scaffold a slot is 0.2 px wide, so it draws nothing visible.)
 */
export function sessionShading(rangesFor: RangesFor): TvlExtension {
  return ({ series }) => {
    const plugin = new TimeRangeShading(rangesFor);
    series[0].attachPrimitive(plugin);
    return () => series[0].detachPrimitive(plugin);
  };
}

/**
 * Crosshair sync across every chart the returned extension is applied to: moving over one chart puts
 * the crosshair at the same time on all the others, at each one's own price at that time.
 * Charts share one time axis (UTC seconds), so times line up even though prices differ.
 */
export function crosshairSync(): TvlExtension {
  const members = new Set<{ chart: IChartApi; series: ISeriesApi<SeriesType> }>();
  let syncing = false; // setCrosshairPosition must not echo back into the group

  return ({ chart, series }) => {
    const me = { chart, series: series[0] };
    members.add(me);
    const onMove = (param: { time?: Time }) => {
      if (syncing) return;
      syncing = true;
      try {
        for (const m of members) {
          if (m === me) continue;
          if (param.time === undefined) {
            m.chart.clearCrosshairPosition();
            continue;
          }
          const price = priceAt(m.chart, m.series, param.time);
          if (price === undefined) m.chart.clearCrosshairPosition();
          else m.chart.setCrosshairPosition(price, param.time, m.series);
        }
      } finally {
        syncing = false;
      }
    };
    chart.subscribeCrosshairMove(onMove);
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      members.delete(me);
    };
  };
}

/** The series' value (close, for OHLC) at or just before `time`. */
function priceAt(chart: IChartApi, series: ISeriesApi<SeriesType>, time: Time): number | undefined {
  const idx = chart.timeScale().timeToIndex(time, true);
  if (idx == null) return undefined;
  const bar = series.dataByIndex(idx, MismatchDirection.NearestLeft) as { close?: number; value?: number } | null;
  return bar?.close ?? bar?.value;
}
