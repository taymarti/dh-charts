/**
 * @acme/app-shell (layer 3): an app shell for Deephaven-backed desk apps.
 *
 *   Shell, definePanel                 dockable panels (dockview), saved workspaces, link groups per panel
 *   WorkspaceStore                     apiWorkspaceStore (server, per user) or localWorkspaceStore (this browser)
 *   DeephavenProvider, use*            the session as React context: tables, rows, API clients, published objects
 *   DataGrid                           any table, server-side viewport, sort and quick filters
 *   chartPanel, watchlistPanel,        generic panel kinds
 *   tablePanel, requestPanel,
 *   graphPanel                         ... and the app's update graph (introspect)
 *   seriesPanel, strategiesPanel       line charts of any table; strategies and backtests (dh_chart_ext.backtests)
 *   RawChart, RawWorkspace,            front-end group C's chart, and the page's chart stores
 *   usePageStores
 *
 * Styles: import '@acme/app-shell/style.css' once (it includes dockview's).
 */
import './shell.css';

export { Shell, type AddPanel, type ShellProps } from './Shell';
export { definePanel, titleOf, type PanelKind, type PanelPlacement, type PanelProps } from './registry';
export {
  LAYOUT_VERSION,
  apiWorkspaceStore,
  localWorkspaceStore,
  migrateLayout,
  type WorkspaceLayout,
  type WorkspaceStore,
  type WorkspaceSummary,
} from './workspace-store';
export {
  DeephavenProvider,
  DeephavenRoot,
  useApiClient,
  useConnectionState,
  useDeephaven,
  useOptionalDeephaven,
  useOwnTable,
  usePublished,
  useRows,
  useTableLease,
  type Loaded,
} from './deephaven';
export { DataGrid, formatCell, type DataGridProps, type GridState } from './grid/DataGrid';
export {
  chartPanel,
  parseField,
  requestPanel,
  tablePanel,
  watchlistPanel,
  type ChartPanelOptions,
  type ChartPanelParams,
  type RequestPanelParams,
  type TablePanelParams,
} from './panels';
export { seriesPanel, oneRowPerTime, type SeriesPanelParams } from './series/SeriesPanel';
export { strategiesPanel, type RunInfo } from './backtest/StrategiesPanel';
export { graphPanel, layoutGraph, type GraphNode, type GraphReply } from './graph/GraphPanel';
export { RawChart, RawWorkspace, type ChartData } from './chart/RawChart';
export { usePageStores, type PageStoreTables } from './chart/page-stores';
