/**
 * @acme/chart-ext: our chart features as plain Lightweight Charts plugins, plus the hook that applies
 * them to Deephaven's TradingView plugin charts. Shared, as source, by every host:
 *   web/        the standalone React host
 *   dh-plugin/  a server plugin that brings the same features to deephaven.ui
 */
export { attachTvlExtensions, stats, type TvlChartContext, type TvlExtension, type TvlRenderer } from './hook';
export { crosshairSync, sessionShading, userPriceLines } from './extensions';
export { TimeRangeShading, alternatingBlocks, type RangesFor, type ShadedRange } from './lwc-plugins/time-range-shading';
export { defaultExtensions, type ExtensionName } from './defaults';
