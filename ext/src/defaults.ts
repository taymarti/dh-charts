import { crosshairSync, sessionShading } from './extensions';
import { alternatingBlocks } from './lwc-plugins/time-range-shading';
import { persistentPriceLines } from './persistent-price-lines';
import { drawingTools } from './drawings';
import type { AnnotationStore } from './annotations';
import type { TvlExtension } from './hook';

export type ExtensionName = 'sync' | 'lines' | 'sessions' | 'draw';

/**
 * The default feature set, by name. `sync` is one crosshair group shared by every chart the returned
 * extensions are applied to, so call this once per page (or per group of charts that should move together).
 *
 * `lines` are saved to `store` when given, else to the page's store once one is set
 * (setPageAnnotationStore), and are plain unsaved lines until then. `draw` (drawing tools) waits for a store.
 */
export function defaultExtensions(
  names: Iterable<ExtensionName> = ['sync', 'lines', 'sessions', 'draw'],
  { store }: { store?: AnnotationStore } = {},
): TvlExtension[] {
  const want = new Set(names);
  const exts: TvlExtension[] = [];
  if (want.has('sync')) exts.push(crosshairSync());
  if (want.has('lines')) exts.push(persistentPriceLines(undefined, store));
  // drawing tools need a store to save to: they appear once one is set
  if (want.has('draw')) exts.push(drawingTools(store));
  // demo: alternate 15-minute blocks, standing in for real session/auction windows
  if (want.has('sessions')) exts.push(sessionShading(alternatingBlocks(900, 'rgba(41, 98, 255, 0.12)')));
  return exts;
}
