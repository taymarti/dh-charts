/**
 * Server objects drawn by the server's own plugins, inside a page under DeephavenWidgetsRoot (import this entry,
 * @acme/dh-widgets/widgets, only from code loaded after the root: see root.tsx).
 *
 *   ShellSession             the @acme/app-shell session over the bootstrap's connection (DeephavenProvider), so
 *                            the shell's stores, hooks and panels work in the same page
 *   PluginWidget             one object by type and name, drawn by the plugin registered for its type
 *   ServerWidget             a deephaven.ui element (or any type) full size, with what deephaven.ui's components
 *                            expect from Deephaven's dashboard, and an error boundary
 *   serverWidgetPanel        a ServerWidget as an @acme/app-shell panel kind
 *
 * Styles: import '@acme/dh-widgets/style.css' once.
 *
 * deephaven.ui's table expects to live in Deephaven's golden-layout dashboard: it reads the dashboard's
 * LayoutManager for its event hub (to open a chart from the table, to hear "clear all filters"), the dashboard's id
 * (its grid linker keeps state in the app's redux store under it) and its panel's id. A shell panel is not that
 * dashboard, so each ServerWidget gets those three: a layout manager that is only an event hub, local to the page;
 * one dashboard id per page; its own panel id.
 */
import { Component, useMemo, type ReactNode } from 'react';
import { useConnection } from '@deephaven/app-utils';
import { DashboardIdContext, LayoutManagerContext, PanelIdContext } from '@deephaven/dashboard';
// deephaven.ui elements need a FiberProvider above them (Deephaven's own Dashboard adds one); @deephaven/dashboard
// does not export it from its index, so import its module directly
import { FiberProvider } from '@deephaven/dashboard/dist/useFiber.js';
import { useApi } from '@deephaven/jsapi-bootstrap';
import { isWidgetPlugin, usePlugins } from '@deephaven/plugin';
import { adoptConnection } from '@acme/dh-bindings';
import { DeephavenProvider, definePanel, type PanelKind } from '@acme/app-shell';
import './widgets.css';

export const UI_ELEMENT = 'deephaven.ui.Element';

/** The shell's session (DeephavenProvider) over the bootstrap's connection; never closed: the connection is the bootstrap's. */
export function ShellSession({ children }: { children: ReactNode }) {
  const dh = useApi();
  const connection = useConnection();
  const session = useMemo(() => adoptConnection(dh as never, connection as never), [dh, connection]);
  return <DeephavenProvider session={session}>{children}</DeephavenProvider>;
}

/**
 * Like Deephaven's WidgetView, but passes the widget descriptor ({ type, name }) as metadata: deephaven.ui's
 * component requires it ("No widget descriptor"), and WidgetView only passes fetch. Put a FiberProvider above it
 * for deephaven.ui elements (ServerWidget does).
 */
export function PluginWidget({ type, name, fetch }: { type: string; name: string; fetch: () => Promise<unknown> }) {
  const plugins = usePlugins();
  const plugin = useMemo(() => [...plugins.values()].filter(isWidgetPlugin).find(p => [p.supportedTypes].flat().includes(type)), [plugins, type]);
  if (plugin == null) return <div>No plugin for {type}</div>;
  const C = plugin.component;
  return <C fetch={fetch} metadata={{ type, name }} />;
}

const LAYOUT_STANDIN = (() => {
  const handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  const on = (ev: string, fn: (...a: unknown[]) => void) => void (handlers.get(ev) ?? handlers.set(ev, new Set()).get(ev)!).add(fn);
  const off = (ev: string, fn: (...a: unknown[]) => void) => void handlers.get(ev)?.delete(fn);
  const emit = (ev: string, ...args: unknown[]) => handlers.get(ev)?.forEach(fn => fn(...args));
  return { eventHub: { on, off, emit, trigger: emit, unbind: off }, root: null };
})();

/** A widget that fails shows its error in its own panel instead of taking the page down. */
class WidgetBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="acme-widget-error">
        <b>{this.props.name}</b> could not be drawn here: {error.message}
        <button onClick={() => this.setState({ error: null })}>Retry</button>
      </div>
    );
  }
}

export interface ServerWidgetProps {
  /** the published name */
  name: string;
  /** its type (default a deephaven.ui element) */
  type?: string;
  /** an id for its panel, unique in the page */
  panelId: string;
  /** the page's dashboard id (deephaven.ui's grids keep state under it) */
  dashboardId?: string;
}

/** One server object, full size, drawn by the plugin for its type. */
export function ServerWidget({ name, type = UI_ELEMENT, panelId, dashboardId = 'acme-page' }: ServerWidgetProps) {
  const connection = useConnection();
  const fetch = useMemo(() => () => connection.getObject({ type, name } as never), [connection, name, type]);
  return (
    <div className="acme-widget">
      <WidgetBoundary name={name}>
        <LayoutManagerContext.Provider value={LAYOUT_STANDIN as never}>
          <DashboardIdContext.Provider value={dashboardId}>
            <PanelIdContext.Provider value={panelId}>
              <FiberProvider>
                <PluginWidget type={type} name={name} fetch={fetch} />
              </FiberProvider>
            </PanelIdContext.Provider>
          </DashboardIdContext.Provider>
        </LayoutManagerContext.Provider>
      </WidgetBoundary>
    </div>
  );
}

export interface ServerWidgetPanelOptions {
  /** the published name, also the panel kind */
  name: string;
  title: string;
  description?: string;
  type?: string;
  dashboardId?: string;
}

/**
 * A server widget as a shell panel kind. Widgets share no React state with the page or each other, so the
 * shell's link chips are off for them: link them on the server (dh_chart_ext.uikit.LinkHub).
 */
export function serverWidgetPanel({ name, title, description, type, dashboardId }: ServerWidgetPanelOptions): PanelKind {
  return definePanel({
    kind: name,
    title,
    label: title,
    description,
    linkable: false,
    defaultLink: null,
    component: ({ id }) => <ServerWidget name={name} type={type} panelId={id} dashboardId={dashboardId} />,
  });
}
