import { crosshairSync } from './extensions';
import { persistentPriceLines } from './persistent-price-lines';
import { drawingTools } from './drawings';
import { ohlcLegend } from './legend';
import { marketSessions } from './sessions';
import { alertLines } from './alerts';
import type { AnnotationStore } from './annotations';
import type { TvlExtension } from './hook';

export type ExtensionName = 'legend' | 'sync' | 'lines' | 'sessions' | 'draw' | 'alerts';

/**
 * The default feature set, by name. `sync` charts follow each other by the data-acme-sync-*
 * attributes on their ancestors (crosshair: page-wide by default).
 *
 * `lines` are saved to `store` when given, else to the page's store once one is set
 * (setPageAnnotationStore), and are plain unsaved lines until then. `draw` (drawing tools) waits for
 * a store. `sessions` shades closed and extended hours from the page's calendar (setPageSessions);
 * `alerts` draws the page alert store's active price alerts (providePageAlertStore).
 */
export function defaultExtensions(
  names: Iterable<ExtensionName> = ['legend', 'sync', 'lines', 'sessions', 'draw', 'alerts'],
  { store }: { store?: AnnotationStore } = {},
): TvlExtension[] {
  const want = new Set(names);
  const exts: TvlExtension[] = [];
  if (want.has('sessions')) exts.push(marketSessions());
  if (want.has('legend')) exts.push(ohlcLegend());
  if (want.has('sync')) exts.push(crosshairSync());
  if (want.has('lines')) exts.push(persistentPriceLines(undefined, store));
  // drawing tools need a store to save to: they appear once one is set
  if (want.has('draw')) exts.push(drawingTools(store));
  if (want.has('alerts')) exts.push(alertLines());
  return exts;
}
