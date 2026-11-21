/**
 * Brings @acme/chart-ext to Deephaven TradingView charts in any Deephaven web UI, deephaven.ui
 * dashboards included.
 *
 * The Deephaven web UI loads every server JS plugin when a page starts. When this module loads, it
 * listens on the document for the TradingView plugin's "tvl-chart" events (the chart-events patch)
 * and applies the default extensions to every chart on the page; the crosshair group spans them all.
 *
 * Why the document and not a widget middleware wrapper: deephaven.ui 0.42.2 renders plugin objects
 * through its own ObjectView, which picks the widget plugin and renders its component directly, so
 * middleware never wraps charts inside ui components. A document listener needs no wrapper at all.
 *
 * A host that applies the extensions itself (web/, with its own per-page choices) sets
 * globalThis.__acmeChartExtHostManaged = true before plugins load, and this module stays out of it.
 *
 * The module still has to export a plugin object; it exports a pass-through widget middleware for
 * TvlChart (applied where the web UI does chain middleware, e.g. a chart opened as its own panel),
 * kept as the place for future per-chart options.
 */
import React from 'react';
import type { WidgetMiddlewareComponentProps, WidgetMiddlewarePlugin } from '@deephaven/plugin';
import { attachTvlExtensions, defaultExtensions } from '@acme/chart-ext';

const TVL_TYPE = 'deephaven.plot.tradingview_lightweight.TvlChart';

const g = globalThis as { __acmeChartExtHostManaged?: boolean; __acmeChartExtAttached?: boolean };
if (!g.__acmeChartExtHostManaged && !g.__acmeChartExtAttached && typeof document !== 'undefined') {
  g.__acmeChartExtAttached = true;
  attachTvlExtensions(document.documentElement, defaultExtensions());
}

function PassThrough({ Component, ...props }: WidgetMiddlewareComponentProps) {
  return React.createElement(Component, props);
}

const plugin: WidgetMiddlewarePlugin = {
  name: '@acme/dh-chart-ext',
  type: 'MiddlewarePlugin',
  supportedTypes: TVL_TYPE,
  component: PassThrough,
};

export default plugin;
