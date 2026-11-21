import { crosshairSync, sessionShading, userPriceLines } from './extensions';
import { alternatingBlocks } from './lwc-plugins/time-range-shading';
import type { TvlExtension } from './hook';

export type ExtensionName = 'sync' | 'lines' | 'sessions';

/**
 * The default feature set, by name. `sync` is one crosshair group shared by every chart the returned
 * extensions are applied to, so call this once per page (or per group of charts that should move together).
 */
export function defaultExtensions(names: Iterable<ExtensionName> = ['sync', 'lines', 'sessions']): TvlExtension[] {
  const want = new Set(names);
  const exts: TvlExtension[] = [];
  if (want.has('sync')) exts.push(crosshairSync());
  if (want.has('lines')) exts.push(userPriceLines({ lineColor: '#f7a600' }));
  // demo: alternate 15-minute blocks, standing in for real session/auction windows
  if (want.has('sessions')) exts.push(sessionShading(alternatingBlocks(900, 'rgba(41, 98, 255, 0.12)')));
  return exts;
}
