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
 *   &ext=sync,lines,sessions,draw  extensions to attach; ext= (empty) for none (default all four)
 *   &user=alice               who annotations are saved as (default: a per-browser id)
 *   &annotations=chart_annotations   the published annotations table (default chart_annotations)
 *
 * Or one server object full-page, of any type a server plugin renders (front-end group B):
 *   ?widget=ws                              a deephaven.ui element (type deephaven.ui.Element, the default)
 *   ?widget=chart_ES&type=deephaven.plot.tradingview_lightweight.TvlChart
 *
 * Or a chart from table data only, our own LWC chart (front-end group C; see RawChart.tsx):
 *   ?raw=bars_1m&sym=ES&studies=EMA_20,BB_20_2_Upper,BB_20_2_Lower
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useConnection } from '@deephaven/app-utils';
import { useApi } from '@deephaven/jsapi-bootstrap';
import type { dh as Dh } from '@deephaven/jsapi-types';
import { WidgetView, isWidgetPlugin, usePlugins } from '@deephaven/plugin';
// deephaven.ui elements need a FiberProvider above them (Deephaven's own Dashboard adds one); @deephaven/dashboard
// does not export it from its index, so import its module directly
import { FiberProvider } from '@deephaven/dashboard/dist/useFiber.js';
import {
  TRADINGVIEW_ATTRIBUTION,
  attachTvlExtensions,
  browserOwner,
  defaultExtensions,
  providePageAnnotationStore,
  tableAnnotationStore,
  type ExtensionName,
} from '@acme/chart-ext';
import { RawChart } from './RawChart';

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
const EXT = (q.get('ext') ?? 'sync,lines,sessions,draw').split(',').filter(Boolean) as ExtensionName[];

/**
 * Provide the page's annotation store from the published annotations table, if the server has one:
 * persistent price lines (and later drawings) on every chart the page's extensions reach.
 */
function usePageAnnotations() {
  const dh = useApi();
  const connection = useConnection();
  useEffect(() => {
    let closed = false;
    let release = () => {};
    connection
      .getObject({ type: dh.VariableType.TABLE, name: ANNOTATIONS } as never)
      .then(obj => {
        const t = obj as Dh.Table;
        if (closed) return t.close();
        const store = tableAnnotationStore(dh, t, USER);
        const unprovide = providePageAnnotationStore(store);
        release = () => {
          unprovide();
          store.close();
          t.close();
        };
      })
      .catch(() => {}); // no annotations table on this server: lines stay unsaved
    return () => {
      closed = true;
      release();
    };
  }, [dh, connection]);
}

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

/**
 * Like WidgetView, but passes the widget descriptor ({ type, name }) as metadata: deephaven.ui's component
 * requires it ("No widget descriptor"), and WidgetView only passes fetch.
 */
function PluginWidget({ type, name, fetch }: { type: string; name: string; fetch: () => Promise<unknown> }) {
  const plugins = usePlugins();
  const plugin = useMemo(
    () => [...plugins.values()].filter(isWidgetPlugin).find(p => [p.supportedTypes].flat().includes(type)),
    [plugins, type],
  );
  if (plugin == null) return <div>No plugin for {type}</div>;
  const Component = plugin.component;
  return <Component fetch={fetch} metadata={{ type, name }} />;
}

/** Lightweight Charts' license: its attribution notice and a link to TradingView, once per page. */
function Attribution() {
  return (
    <div className="attribution">
      Charts: <a href={TRADINGVIEW_ATTRIBUTION.url} target="_blank" rel="noreferrer">{TRADINGVIEW_ATTRIBUTION.linkText}</a>
      {TRADINGVIEW_ATTRIBUTION.notice.replace(TRADINGVIEW_ATTRIBUTION.linkText, '')}
    </div>
  );
}

function SingleWidget({ name, type }: { name: string; type: string }) {
  const connection = useConnection();
  const fetch = useMemo(() => () => connection.getObject({ type, name } as never), [connection, name, type]);
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => attachTvlExtensions(root.current!, defaultExtensions(EXT)), []);
  usePageAnnotations();
  return (
    <div ref={root} className="single">
      <FiberProvider>
        <PluginWidget type={type} name={name} fetch={fetch} />
      </FiberProvider>
      {/* a deephaven.ui workspace shows its own attribution */}
      {type !== 'deephaven.ui.Element' && <Attribution />}
    </div>
  );
}

export default function App() {
  if (RAW) {
    const studies = (q.get('studies') ?? 'EMA_20').split(',').filter(Boolean);
    return <RawChart table={RAW} sym={q.get('sym') ?? 'ES'} studies={studies} annotations={ANNOTATIONS} user={USER} />;
  }
  if (WIDGET) return <SingleWidget name={WIDGET} type={WIDGET_TYPE} />;
  return <Grid />;
}

function Grid() {
  const cols = Math.ceil(Math.sqrt(N));
  const root = useRef<HTMLDivElement>(null);
  // a layout effect runs before the charts' own effects create them, so no "ready" event is missed
  useLayoutEffect(() => attachTvlExtensions(root.current!, defaultExtensions(EXT)), []);
  usePageAnnotations();
  return (
    <div ref={root} className="grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {SYMS.slice(0, N).map(s => (
        <Chart key={s} name={`${PREFIX}${s}`} />
      ))}
      <Attribution />
    </div>
  );
}
