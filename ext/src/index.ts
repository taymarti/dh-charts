/**
 * @acme/chart-ext: our chart features as plain Lightweight Charts plugins, plus the hook that applies
 * them to Deephaven's TradingView plugin charts, and annotation persistence. Shared, as source, by every host:
 *   web/        the standalone React host
 *   dh-plugin/  a server plugin that brings the same features to deephaven.ui
 */
export { attachTvlExtensions, stats, type TvlChartContext, type TvlExtension, type TvlRenderer } from './hook';
export { sessionShading, userPriceLines } from './extensions';
export { bindSync, crosshairSync } from './sync';
export { subscribeRows, type Row } from './table-rows';
export { TimeRangeShading, alternatingBlocks, type RangesFor, type ShadedRange } from './lwc-plugins/time-range-shading';
export { defaultExtensions, type ExtensionName } from './defaults';
export {
  browserOwner,
  newAnnotationId,
  onPageAnnotationStore,
  providePageAnnotationStore,
  setPageAnnotationStore,
  tableAnnotationStore,
  type Annotation,
  type AnnotationInput,
  type AnnotationStore,
} from './annotations';
export { bindPriceLines, persistentPriceLines, titleChartKey } from './persistent-price-lines';
export { bindDrawings, drawingTools, type DrawingPoint, type DrawingType } from './drawings';
export { bindLegend, ohlcLegend } from './legend';
export {
  SESSION_COLORS,
  bindSessionShading,
  formatDuration,
  marketSessions,
  marketStatus,
  onPageSessions,
  sessionRanges,
  sessionSpecFor,
  setPageSessions,
  type MarketState,
  type MarketStatus,
  type SessionSpec,
} from './sessions';
export { bindCountdown } from './countdown';
export { bindNavigation, type NavOptions, type Navigation } from './nav';
export {
  ALERT_COLOR,
  alertLines,
  bindAlertLines,
  currentAlertStore,
  describeAlert,
  onPageAlertStore,
  providePageAlertStore,
  showAlertToasts,
  tableAlertStore,
  type Alert,
  type AlertInput,
  type AlertKind,
  type AlertOp,
  type AlertStatus,
  type AlertStore,
} from './alerts';
