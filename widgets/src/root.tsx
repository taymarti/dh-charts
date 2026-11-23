/**
 * The bootstrap chain Deephaven's own web app uses, for a page of ours:
 *
 *   ApiBootstrap   import(dh-core.js) from the server                        -> useApi()
 *   AppBootstrap   redux store, theme, and the server's JS plugins            -> usePlugins()
 *                  (the plugins' JS comes from the server, so it matches the server's Python plugins)
 *                  then the client, login and IdeConnection                   -> useConnection()
 *
 * Everything under it can draw any object a server plugin renders (see ./widgets). AppBootstrap is loaded lazily,
 * and the page's own code should be too (React.lazy): some of Deephaven's modules read the `dh` global when they
 * are imported, and it exists only once ApiBootstrap has loaded it.
 *
 *   createRoot(el).render(
 *     <DeephavenWidgetsRoot apiUrl="/jsapi/dh-core.js" pluginsUrl="/js-plugins">
 *       <App />          // React.lazy(() => import('./App'))
 *     </DeephavenWidgetsRoot>,
 *   );
 *
 * The page needs Deephaven's base styles first: import '@deephaven/components/scss/BaseStyleSheet.scss'.
 */
import React, { Suspense, type ReactNode } from 'react';
import { LoadingOverlay, preloadTheme } from '@deephaven/components';
import { ApiBootstrap } from '@deephaven/jsapi-bootstrap';

const AppBootstrap = React.lazy(async () => ({ default: (await import('@deephaven/app-utils')).AppBootstrap }));

export interface DeephavenWidgetsRootProps {
  /** the JS API, absolute or relative to the page (default /jsapi/dh-core.js: same origin, e.g. through a proxy) */
  apiUrl?: string;
  /** the server's JS plugins, without a trailing slash (default /js-plugins): Deephaven's bootstrap adds /manifest.json */
  pluginsUrl?: string;
  /**
   * The page applies @acme/chart-ext to its TradingView charts itself (attachTvlExtensions): tell the
   * dh-chart-ext server plugin, which AppBootstrap also loads, not to apply them a second time. Default true.
   */
  pageAppliesChartExt?: boolean;
  children: ReactNode;
}

let themed = false;

export function DeephavenWidgetsRoot({ apiUrl = '/jsapi/dh-core.js', pluginsUrl = '/js-plugins', pageAppliesChartExt = true, children }: DeephavenWidgetsRootProps) {
  if (!themed) {
    preloadTheme();
    themed = true;
  }
  if (pageAppliesChartExt) (globalThis as { __acmeChartExtHostManaged?: boolean }).__acmeChartExtHostManaged = true;
  const api = new URL(apiUrl, document.baseURI);
  const plugins = new URL(pluginsUrl, document.baseURI);
  return (
    <ApiBootstrap apiUrl={api.href} setGlobally>
      <Suspense fallback={<LoadingOverlay />}>
        <AppBootstrap serverUrl={api.origin} pluginsUrl={plugins.href}>
          {children}
        </AppBootstrap>
      </Suspense>
    </ApiBootstrap>
  );
}
