/**
 * The page's client for the server's chart API (published `chart_api`, type acme.Api): a React hook over
 * @acme/dh-bindings' openApi. One stream per page; it tells the server who the user is (hello), and pings
 * to keep its lease. Charts come from requestChart(dh, client, ...).
 */
import { useEffect, useState } from 'react';
import { useApi } from '@deephaven/jsapi-bootstrap';
import { useConnection } from '@deephaven/app-utils';
import { openApi, type ApiClient } from '@acme/dh-bindings';

/** The page's API client, or null until it is open (or with name null). `user` is sent as hello's token. */
export function useChartApi(name: string | null = 'chart_api', user?: string): ApiClient | null {
  const dh = useApi();
  const connection = useConnection();
  const [client, setClient] = useState<ApiClient | null>(null);
  useEffect(() => {
    if (name == null) return undefined;
    let closed = false;
    let c: ApiClient | null = null;
    openApi(dh, connection, name)
      .then(async api => {
        if (closed) return api.close();
        c = api;
        // Community has no user identity: an unverified "user:<name>" (a server with ACME_API_SECRET wants a signed token)
        if (user) await api.hello(`user:${user}`).catch(e => console.warn('chart API hello failed', e));
        (window as unknown as { chartApi?: ApiClient }).chartApi = api; // for the console
        setClient(api);
      })
      .catch(e => console.warn('chart API unavailable', e));
    return () => {
      closed = true;
      c?.close();
    };
  }, [dh, connection, name, user]);
  return client;
}
