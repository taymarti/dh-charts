/**
 * The desk app: an app shell (dockable chart, table, watchlist and request panels, saved workspaces, link
 * groups) on one Deephaven connection made here, not by Deephaven's React bootstrap.
 *
 *   http://localhost:4060/?user=alice      who the workspaces and annotations belong to (default: a per-browser id)
 *   &tz=America/Chicago                    the charts' time zone (default local)
 *   &api=chart_api                         the request API (charts, workspaces)
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { browserOwner } from '@acme/chart-ext';
import { connect } from '@acme/dh-bindings';
import {
  DeephavenRoot,
  Shell,
  apiWorkspaceStore,
  chartPanel,
  graphPanel,
  localWorkspaceStore,
  requestPanel,
  tablePanel,
  useApiClient,
  usePageStores,
  watchlistPanel,
  type AddPanel,
  type PanelKind,
  type WorkspaceStore,
} from '@acme/app-shell';
import type { DockviewApi } from 'dockview-react';

const q = new URLSearchParams(location.search);
const USER = q.get('user') ?? browserOwner();
const TZ = q.get('tz') ?? 'local';
const API = q.get('api') ?? 'chart_api';
const FALLBACK_SYMBOLS = ['ES', 'NQ', 'RTY', 'YM', 'ZN', 'ZB', 'CL', 'NG', 'GC', 'SI', '6E', '6J'];

function defaultLayout(api: DockviewApi, add: AddPanel) {
  add('chart', { symbol: 'ES' });
  add('watchlist', {}, { position: { direction: 'right' } });
  add('request', {}, { position: { referencePanel: api.panels[1].id, direction: 'within' } });
  api.panels[1].api.setActive();
  add('table', { table: 'chart_nodes' }, { title: 'chart_nodes', position: { referencePanel: api.panels[0].id, direction: 'below' } });
  // the chart gets most of the width and height
  api.panels[0].group.api.setSize({ width: Math.round(api.width * 0.72), height: Math.round(api.height * 0.68) });
}

function App() {
  const { value: client, error } = useApiClient(API, `user:${USER}`);
  const [symbols, setSymbols] = useState<string[] | null>(null);
  usePageStores(USER);
  useEffect(() => {
    if (error) setSymbols(FALLBACK_SYMBOLS);
    client?.request<string[]>('symbols').then(r => setSymbols(r.result), () => setSymbols(FALLBACK_SYMBOLS));
  }, [client, error]);
  const [kinds, setKinds] = useState<PanelKind[] | null>(null);
  const [store, setStore] = useState<WorkspaceStore | null>(null);
  useEffect(() => {
    if (!symbols) return;
    setKinds([
      chartPanel({ symbols, user: USER, api: error ? null : API, timeZone: TZ }),
      watchlistPanel(),
      tablePanel(),
      requestPanel({ api: API, user: USER }),
      graphPanel({ api: API, user: USER }),
    ]);
    setStore(client ? apiWorkspaceStore(client) : localWorkspaceStore());
  }, [symbols, client, error]);
  if (!kinds) return <div style={{ color: '#787b86', padding: 16, font: '13px sans-serif' }}>connecting…</div>;
  return (
    <Shell
      kinds={kinds}
      store={store}
      defaultLayout={defaultLayout}
      title="Desk"
      extra={<span style={{ color: '#787b86', fontSize: 12 }}>{USER}</span>}
      popoutUrl="/popout.html"
    />
  );
}

// a stable function: DeephavenRoot connects with it, and again after the server drops the session
const connectToServer = () => connect({ serverUrl: location.origin });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DeephavenRoot connect={connectToServer}>
      <App />
    </DeephavenRoot>
  </StrictMode>,
);
