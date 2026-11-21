/**
 * Extensions: each is a plain Lightweight Charts plugin or behaviour, applied through attachTvlExtensions.
 * User price lines is TradingView's official package used as published; the rest are ours.
 */
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

export { crosshairSync } from './sync';
