import React, { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
// Must be the first stylesheet: Deephaven's base theme variables + resets.
import '@deephaven/components/scss/BaseStyleSheet.scss';
import { LoadingOverlay, preloadTheme } from '@deephaven/components';
import { ApiBootstrap } from '@deephaven/jsapi-bootstrap';
import './styles.css';

preloadTheme();

// This page applies @acme/chart-ext itself (App.tsx, with ?ext= choices); tell the dh-chart-ext server
// plugin, which AppBootstrap also loads, not to apply them a second time.
(globalThis as { __acmeChartExtHostManaged?: boolean }).__acmeChartExtHostManaged = true;

// Loaded lazily so nothing touches the `dh` API before ApiBootstrap has imported it from the server.
const App = React.lazy(() => import('./App'));
const AppBootstrap = React.lazy(async () => ({
  default: (await import('@deephaven/app-utils')).AppBootstrap,
}));

const apiUrl = new URL(`${import.meta.env.VITE_CORE_API_URL}/${import.meta.env.VITE_CORE_API_NAME}`, document.baseURI);
const pluginsUrl = new URL(import.meta.env.VITE_MODULE_PLUGINS_URL, document.baseURI);

/*
 * The same bootstrap chain as react-client/:
 *   ApiBootstrap  import(dh-core.js) from the server            -> useApi()
 *   AppBootstrap  redux store, theme, and the server's JS plugins -> usePlugins()
 *                 (this is what brings in the TradingView plugin's JS, matching the server's version)
 *                 then client, login and IdeConnection           -> useConnection()
 */
createRoot(document.getElementById('root')!).render(
  <ApiBootstrap apiUrl={apiUrl.href} setGlobally>
    <Suspense fallback={<LoadingOverlay />}>
      <AppBootstrap serverUrl={apiUrl.origin} pluginsUrl={pluginsUrl.href}>
        <App />
      </AppBootstrap>
    </Suspense>
  </ApiBootstrap>,
);
