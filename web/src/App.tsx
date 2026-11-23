/**
 * Pattern A: a chart defined once in Python (a `tvl.*` TvlChart published as a field) and drawn in a
 * standalone React app by Deephaven's own TradingView plugin component, the same one deephaven.ui uses.
 *
 * WidgetView (from @deephaven/plugin) picks the plugin the server registered for the object's type,
 * so this app has no TradingView code of its own and needs no npm package for the plugin.
 * Our features are plain Lightweight Charts plugins from @acme/chart-ext (ext/), attached through its hook.
 *
 *   ?prefix=tvl1s_            published chart fields are <prefix><SYM>   (default tvl1s_: 1-second candles)
 *   &n=16                     charts in the grid                         (default 16)
 *   &ext=sync,lines,sessions,draw,alerts  extensions to attach; ext= (empty) for none (default all five)
 *   &user=alice               who annotations are saved as (default: a per-browser id)
 *   &annotations=chart_annotations   the published annotations table (default chart_annotations)
 *   &alerts=chart_alerts             the published alerts table (default chart_alerts)
 *
 * Or one server object full-page, of any type a server plugin renders (front-end group B):
 *   ?widget=ws                              a deephaven.ui element (type deephaven.ui.Element, the default)
 *   ?widget=chart_ES&type=deephaven.plot.tradingview_lightweight.TvlChart
 *
 * Or a chart from table data only, our own LWC chart (front-end group C; see @acme/app-shell's chart/RawChart.tsx):
 *   ?raw=bars_1m&sym=ES&studies=EMA_20,BB_20_2_Upper,BB_20_2_Lower
 *   ?workspace&sym=ES                       the same with the TradingView-style toolbar (@acme/chart-react)
 *   ?workspace&api                          ... with charts from the server's chart API (any resolution, spreads,
 *                                           RSI and volume panes, compare; nodes shared with every other client);
 *                                           &api=<name> for another API object
 *   &tz=America/Chicago                     the time zone of group C's charts (default: local, as Deephaven's chart)

 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useConnection } from '@deephaven/app-utils';
import { useApi } from '@deephaven/jsapi-bootstrap';
import { WidgetView } from '@deephaven/plugin';
import { PluginWidget } from '@acme/dh-widgets/widgets';
// deephaven.ui elements need a FiberProvider above them (Deephaven's own Dashboard adds one); @deephaven/dashboard
// does not export it from its index, so import its module directly
import { FiberProvider } from '@deephaven/dashboard/dist/useFiber.js';
import { attachTvlExtensions, browserOwner, defaultExtensions, type ExtensionName } from '@acme/chart-ext';
import { adoptConnection } from '@acme/dh-bindings';
import { LinkProvider, createLinkBus, type ToolbarValue } from '@acme/chart-react';
// group C's chart lives in the app shell; it takes the session from context, so this app (Deephaven's own
// bootstrap) provides one over the bootstrap's connection
import { DeephavenProvider, RawChart, RawWorkspace, usePageStores } from '@acme/app-shell';

const TVL_TYPE = 'deephaven.plot.tradingview_lightweight.TvlChart';
const SYMS = ['ES', 'NQ', 'RTY', 'YM', 'ZN', 'ZB', 'ZF', 'ZT', 'CL', 'NG', 'GC', 'SI', '6E', '6J', 'UST10', 'BUND'];

const q = new URLSearchParams(location.search);
const PREFIX = q.get('prefix') ?? 'tvl1s_';
const N = Number(q.get('n') ?? 16);
const WIDGET = q.get('widget');
const RAW = q.get('raw');
const WIDGET_TYPE = q.get('type') ?? 'deephaven.ui.Element';
/** who this page writes annotations as (Community has no user identity): ?user=, else a per-browser id */
const USER = q.get('user') ?? browserOwner();
const ANNOTATIONS = q.get('annotations') ?? 'chart_annotations';
const ALERTS = q.get('alerts') ?? 'chart_alerts';
/** the time zone our own charts show (group C): local (as Deephaven's chart does), UTC, or an IANA zone */
const TZ = q.get('tz') ?? 'local';
const EXT = (q.get('ext') ?? 'sync,lines,sessions,draw,alerts').split(',').filter(Boolean) as ExtensionName[];

function Chart({ name }: { name: string }) {
  const connection = useConnection();
  // stable fetch: WidgetView re-fetches if it changes
  const fetch = useMemo(() => () => connection.getObject({ type: TVL_TYPE, name } as never), [connection, name]);
  return (
    <div className="cell">
      <span className="label">{name}</span>
      <div className="chart">
        <WidgetView type={TVL_TYPE} fetch={fetch} />
      </div>
    </div>
  );
}

function SingleWidget({ name, type }: { name: string; type: string }) {
  const connection = useConnection();
  const fetch = useMemo(() => () => connection.getObject({ type, name } as never), [connection, name, type]);
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => attachTvlExtensions(root.current!, defaultExtensions(EXT)), []);
  usePageStores(USER, { annotations: ANNOTATIONS, alerts: ALERTS });
  return (
    <div ref={root} className="single">
      <FiberProvider>
        <PluginWidget type={type} name={name} fetch={fetch} />
      </FiberProvider>
    </div>
  );
}

export default function App() {
  const dh = useApi();
  const connection = useConnection();
  // never closed: the connection is the bootstrap's
  const session = useMemo(() => adoptConnection(dh, connection), [dh, connection]);
  return (
    <DeephavenProvider session={session}>
      <Page />
    </DeephavenProvider>
  );
}

function Page() {
  if (RAW) {
    const studies = (q.get('studies') ?? 'EMA_20').split(',').filter(Boolean);
    return (
      <RawChart data={{ kind: 'table', table: RAW }} sym={q.get('sym') ?? 'ES'} studies={studies} annotations={ANNOTATIONS} user={USER}
        timeZone={TZ} />
    );
  }
  if (q.has('workspace')) {
    // group C with the toolbar: our own charts from the published bars_<res> tables
    const initial = { symbol: q.get('sym') ?? 'ES', resolution: '1m', range: '4h', studies: ['EMA_20'], scale: 'normal' };
    return <RawWorkspacePage initial={initial} />;
  }
  if (WIDGET) return <SingleWidget name={WIDGET} type={WIDGET_TYPE} />;
  return <Grid />;
}

/** Group C's workspace, with the page's alert store and session calendar from the published tables. */
function RawWorkspacePage({ initial }: { initial: ToolbarValue }) {
  usePageStores(USER, { annotations: null, alerts: ALERTS });
  const api = q.has('api') ? q.get('api') || 'chart_api' : null;
  // the page's link bus: the watchlist and the chart share the symbol in group "red"
  const bus = useMemo(() => createLinkBus(), []);
  return (
    <LinkProvider bus={bus}>
      <RawWorkspace symbols={SYMS} annotations={ANNOTATIONS} user={USER} initial={initial} apiName={api} timeZone={TZ} />
    </LinkProvider>
  );
}

function Grid() {
  const cols = Math.ceil(Math.sqrt(N));
  const root = useRef<HTMLDivElement>(null);
  // a layout effect runs before the charts' own effects create them, so no "ready" event is missed
  useLayoutEffect(() => attachTvlExtensions(root.current!, defaultExtensions(EXT)), []);
  usePageStores(USER, { annotations: ANNOTATIONS, alerts: ALERTS });
  return (
    <div ref={root} className="grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {SYMS.slice(0, N).map(s => (
        <Chart key={s} name={`${PREFIX}${s}`} />
      ))}
    </div>
  );
}
