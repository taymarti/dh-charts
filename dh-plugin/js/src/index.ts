/**
 * Brings @acme/chart-ext to Deephaven TradingView charts in any Deephaven web UI, deephaven.ui
 * dashboards included.
 *
 * 1. When the web UI loads this module, it listens on the document for the TradingView plugin's
 *    "tvl-chart" events (our fork) and applies the default extensions to every chart on the page;
 *    the crosshair group spans them all. (deephaven.ui renders plugin objects directly, never through
 *    widget middleware, so a document listener is the one place that sees every chart.)
 * 2. It exports an element plugin with two elements. `acme.chart.Toolbar` is @acme/chart-react's
 *    ChartToolbar (TradingView-style), driven from Python: the workspace passes value, options and an
 *    on_change callback (dh_chart_ext.workspace.toolbar_element). `acme.chart.Annotations`, which the workspace renders
 *    (dh_chart_ext.store.annotations_element) with the annotations table. The element draws nothing; it
 *    builds an annotation store over the table and makes it the page's store, so price lines (and later
 *    drawings) persist.
 *
 * A host that applies the extensions itself (web/, with its own per-page choices) sets
 * globalThis.__acmeChartExtHostManaged = true before plugins load, and step 1 stays out of it.
 */
import React, { useEffect } from 'react';
import { useApi } from '@deephaven/jsapi-bootstrap';
import type { ElementPlugin } from '@deephaven/plugin';
import {
  attachTvlExtensions,
  browserOwner,
  defaultExtensions,
  providePageAnnotationStore,
  tableAnnotationStore,
} from '@acme/chart-ext';
import { ChartToolbar, type ToolbarOptions, type ToolbarValue } from '@acme/chart-react';

const g = globalThis as { __acmeChartExtHostManaged?: boolean; __acmeChartExtAttached?: boolean };
if (!g.__acmeChartExtHostManaged && !g.__acmeChartExtAttached && typeof document !== 'undefined') {
  g.__acmeChartExtAttached = true;
  attachTvlExtensions(document.documentElement, defaultExtensions());
}

/** deephaven.ui hands exported objects (tables) to element props as objects with reexport()/fetch(). */
interface ExportedObject {
  reexport?: () => Promise<{ fetch(): Promise<unknown> }>;
  fetch?: () => Promise<unknown>;
}

async function resolveTable(obj: ExportedObject): Promise<unknown> {
  if (typeof obj.reexport === 'function') return (await obj.reexport()).fetch();
  if (typeof obj.fetch === 'function') return obj.fetch();
  return obj; // already a table
}

function Annotations({ table, owner }: { table: ExportedObject; owner?: string }) {
  const dh = useApi();
  useEffect(() => {
    let closed = false;
    let close = () => {};
    resolveTable(table).then(t => {
      if (closed) return;
      const store = tableAnnotationStore(dh, t as never, owner ?? browserOwner());
      const release = providePageAnnotationStore(store);
      close = () => {
        release();
        store.close();
        (t as { close?: () => void }).close?.();
      };
    });
    return () => {
      closed = true;
      close();
    };
  }, [dh, table, owner]);
  return null;
}

/** The toolbar, driven by Python state: onChange is the workspace's callback (a server round trip). */
function Toolbar({ value, options, onChange }: { value: ToolbarValue; options: ToolbarOptions; onChange: (patch: ToolbarValue) => void }) {
  return React.createElement(ChartToolbar, { value: value ?? {}, options: options ?? {}, onChange: patch => onChange?.(patch) });
}

const plugin: ElementPlugin = {
  name: '@acme/dh-chart-ext',
  type: 'ElementPlugin',
  mapping: { 'acme.chart.Annotations': Annotations as never, 'acme.chart.Toolbar': Toolbar as never },
};

export default plugin;
