/**
 * The app shell: dockable panels (dockview: tabs, splits, floating and pop-out windows, maximize), saved
 * workspaces, and link groups shared by the panels.
 *
 *   <Shell kinds={[chartPanel, tablePanel]} store={apiWorkspaceStore(client)} defaultLayout={api => ...} />
 *
 * The current layout is kept in this browser (autosaveKey) and comes back on reload; named workspaces go to
 * `store` (the server, per user, or this browser). Each panel's header has a link-group chip: panels in the
 * same group share values on the link bus (the symbol), so a table row click can move every red chart.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FunctionComponent, type ReactNode } from 'react';
import {
  DockviewReact,
  themeDark,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelProps,
} from 'dockview-react';
import { LINK_GROUPS, LinkProvider, createLinkBus, type LinkBus } from '@acme/chart-react';
import { titleOf, type PanelKind, type PanelProps, type StoredParams } from './registry';
import { LAYOUT_VERSION, migrateLayout, type WorkspaceLayout, type WorkspaceStore, type WorkspaceSummary } from './workspace-store';
import { useConnectionState } from './deephaven';

export interface ShellProps {
  kinds: PanelKind[];
  /** where named workspaces are saved (none: no workspace menu) */
  store?: WorkspaceStore | null;
  /** the layout of a fresh shell (no autosaved layout), and of "Reset" */
  defaultLayout?: (api: DockviewApi, add: AddPanel) => void;
  /** shown at the left of the top bar */
  title?: ReactNode;
  /** shown at the right of the top bar, before the connection status */
  extra?: ReactNode;
  /** the link bus (default: the shell's own) */
  bus?: LinkBus;
  /** where the current layout is kept in this browser (null: not kept) */
  autosaveKey?: string | null;
  /** dockview's pop-out page (a blank HTML page on this origin) */
  popoutUrl?: string;
}

export type AddPanel = (kind: string, params?: Record<string, unknown>, options?: { title?: string; position?: unknown }) => void;

let nextId = 1;
const newId = (kind: string) => `${kind}-${Date.now().toString(36)}-${(nextId++).toString(36)}`;
const GROUP_KEYS = LINK_GROUPS.map(g => g.key);

export function Shell({ kinds, store = null, defaultLayout, title, extra, bus: givenBus, autosaveKey = 'acme.shell.current', popoutUrl }: ShellProps) {
  const bus = useMemo(() => givenBus ?? createLinkBus(), [givenBus]);
  const apiRef = useRef<DockviewApi | null>(null);
  const kindsRef = useRef(kinds);
  kindsRef.current = kinds;
  const [current, setCurrent] = useState<string | null>(null);
  const [saved, setSaved] = useState<WorkspaceSummary[]>([]);
  const [note, setNote] = useState<string | null>(null);

  const snapshot = useCallback((): WorkspaceLayout | null => {
    const api = apiRef.current;
    if (!api) return null;
    const links: WorkspaceLayout['links'] = {};
    for (const g of GROUP_KEYS) links[g] = bus.snapshot(g);
    return { version: LAYOUT_VERSION, dock: api.toJSON(), links };
  }, [bus]);

  const autosave = useMemo(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return () => {
      if (!autosaveKey) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const s = snapshot();
        try {
          if (s) localStorage.setItem(autosaveKey, JSON.stringify({ ...s, name: currentRef.current }));
        } catch {
          /* storage full or blocked: the layout just isn't kept */
        }
      }, 300);
    };
  }, [autosaveKey, snapshot]);
  const currentRef = useRef(current);
  currentRef.current = current;

  const add: AddPanel = useCallback((kind, params = {}, options = {}) => {
    const api = apiRef.current;
    const k = kindsRef.current.find(x => x.kind === kind);
    if (!api || !k) return;
    const p: StoredParams = { ...(k.defaultParams ?? {}), ...params };
    // the header shows a link chip for panels with __link; a kind that can't link has none
    if (!('__link' in p) && k.linkable !== false) p.__link = k.defaultLink === undefined ? 'red' : k.defaultLink;
    api.addPanel({ id: newId(kind), component: kind, title: options.title ?? titleOf(k, p), params: p, ...(options.position ? { position: options.position as never } : {}) });
  }, []);

  const apply = useCallback(
    (layout: WorkspaceLayout) => {
      const api = apiRef.current!;
      for (const [g, values] of Object.entries(layout.links)) bus.restore(g, values);
      api.fromJSON(layout.dock as never);
    },
    [bus],
  );

  const reset = useCallback(() => {
    const api = apiRef.current!;
    api.clear();
    defaultLayout?.(api, add);
  }, [add, defaultLayout]);

  const onReady = useCallback(
    (e: DockviewReadyEvent) => {
      apiRef.current = e.api;
      let restored = false;
      if (autosaveKey) {
        try {
          const raw = JSON.parse(localStorage.getItem(autosaveKey) ?? 'null');
          const layout = migrateLayout(raw);
          if (layout) {
            apply(layout);
            setCurrent(typeof raw?.name === 'string' ? raw.name : null);
            restored = true;
          }
        } catch (err) {
          console.warn('the saved layout could not be restored; starting fresh', err);
          e.api.clear();
        }
      }
      if (!restored) defaultLayout?.(e.api, add);
      e.api.onDidLayoutChange(autosave);
    },
    [add, apply, autosave, autosaveKey, defaultLayout],
  );

  useEffect(() => {
    const save = () => autosave();
    window.addEventListener('beforeunload', save);
    return () => window.removeEventListener('beforeunload', save);
  }, [autosave]);

  const refresh = useCallback(() => {
    store?.list().then(setSaved, e => setNote(`workspaces: ${e.message ?? e}`));
  }, [store]);
  useEffect(refresh, [refresh]);

  const flash = (text: string) => {
    setNote(text);
    setTimeout(() => setNote(n => (n === text ? null : n)), 3000);
  };

  const saveAs = async (name: string | null) => {
    if (!store || !name) return;
    const s = snapshot();
    if (!s) return;
    try {
      await store.save(name, s);
      setCurrent(name);
      autosave();
      refresh();
      flash(`Saved "${name}" (${store.where})`);
    } catch (e) {
      flash(`Not saved: ${(e as Error).message}`);
    }
  };

  const open = async (name: string) => {
    if (!store) return;
    try {
      const layout = await store.load(name);
      if (!layout) return flash(`"${name}" can't be read by this version`);
      apply(layout);
      setCurrent(name);
      autosave();
    } catch (e) {
      flash(`Not loaded: ${(e as Error).message}`);
    }
  };

  const [naming, setNaming] = useState<string | null>(null); // the "save as" field's text, while it is open
  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = async () => {
    if (!store || !current) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 4000);
      return;
    }
    setConfirmDelete(false);
    await store.remove(current).catch(e => flash(`Not deleted: ${e.message}`));
    setCurrent(null);
    refresh();
  };

  // dockview needs stable component functions: one wrapper per kind, made once per kinds list
  const components = useMemo(() => {
    const out: Record<string, FunctionComponent<IDockviewPanelProps>> = {};
    for (const k of kinds) out[k.kind] = props => <PanelHost kind={k} dock={props} add={add} autosave={autosave} />;
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kinds.map(k => k.kind).join(',')]);

  return (
    <LinkProvider bus={bus}>
      <div className="acme-shell">
        <header className="acme-shell-bar">
          <span className="acme-shell-title">{title}</span>
          <select
            className="acme-shell-add"
            value=""
            onChange={e => {
              if (e.target.value) add(e.target.value);
              e.target.value = '';
            }}
            title="Add a panel"
          >
            <option value="">+ Panel</option>
            {kinds.map(k => (
              <option key={k.kind} value={k.kind} title={k.description}>
                {k.label ?? titleOf(k, k.defaultParams ?? {})}
              </option>
            ))}
          </select>
          {store && (
            <>
              <select className="acme-shell-ws" value={current ?? ''} onChange={e => e.target.value && void open(e.target.value)} title={`Workspaces (${store.where})`}>
                <option value="">{current ? current : 'Workspace…'}</option>
                {saved.filter(w => w.name !== current).map(w => (
                  <option key={w.name} value={w.name}>
                    {w.name}
                  </option>
                ))}
              </select>
              {naming == null ? (
                <>
                  <button onClick={() => (current ? void saveAs(current) : setNaming('My workspace'))} title={current ? `Save "${current}"` : 'Save'}>
                    Save
                  </button>
                  <button onClick={() => setNaming(current ? `${current} copy` : 'My workspace')}>Save as…</button>
                  {current && (
                    <button onClick={() => void open(current)} title={`Back to "${current}" as saved`}>
                      Revert
                    </button>
                  )}
                  {current && <button onClick={() => void remove()}>{confirmDelete ? `Delete "${current}"?` : 'Delete'}</button>}
                </>
              ) : (
                <form
                  className="acme-shell-name"
                  onSubmit={e => {
                    e.preventDefault();
                    const name = naming.trim();
                    setNaming(null);
                    if (name) void saveAs(name);
                  }}
                >
                  <input autoFocus value={naming} onChange={e => setNaming(e.target.value)} onKeyDown={e => e.key === 'Escape' && setNaming(null)} aria-label="Workspace name" maxLength={64} />
                  <button type="submit">Save</button>
                  <button type="button" onClick={() => setNaming(null)}>
                    Cancel
                  </button>
                </form>
              )}
            </>
          )}
          <button onClick={reset} title="The default layout">
            Reset
          </button>
          <span className="acme-shell-note">{note}</span>
          <span className="acme-shell-spacer" />
          {extra}
          <ConnectionDot />
        </header>
        <div className="acme-shell-dock">
          <DockviewReact
            theme={themeDark}
            components={components}
            onReady={onReady}
            rightHeaderActionsComponent={HeaderActions}
            popoutUrl={popoutUrl}
          />
        </div>
      </div>
    </LinkProvider>
  );
}

function PanelHost({ kind, dock, add, autosave }: { kind: PanelKind; dock: IDockviewPanelProps; add: AddPanel; autosave: () => void }) {
  const [params, setLocal] = useState<StoredParams>(() => ({ ...(dock.params as StoredParams) }));
  const paramsRef = useRef(params);
  paramsRef.current = params;
  useEffect(() => {
    const d = dock.api.onDidParametersChange(() => setLocal({ ...(dock.api.getParameters() as StoredParams) }));
    return () => d.dispose();
  }, [dock.api]);
  const setParams = useCallback(
    (patch: Record<string, unknown>) => {
      const next = { ...paramsRef.current, ...patch };
      paramsRef.current = next;
      dock.api.updateParameters(next);
      setLocal(next);
      autosave();
    },
    [dock.api, autosave],
  );
  const { __link, ...own } = params;
  const props: PanelProps = {
    id: dock.api.id,
    params: own,
    setParams,
    setTitle: t => dock.api.setTitle(t),
    linkGroup: __link ?? null,
    openPanel: (k, p, title) => add(k, p, { title, position: { referencePanel: dock.api.id, direction: 'right' } }),
  };
  const C = kind.component;
  return (
    <div className="acme-panel">
      <C {...props} />
    </div>
  );
}

/** The active panel's link chip, and float / pop out / maximize, in each group's header. */
function HeaderActions({ activePanel, containerApi, group }: IDockviewHeaderActionsProps) {
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!activePanel) return undefined;
    const d = activePanel.api.onDidParametersChange(() => rerender(x => x + 1));
    return () => d.dispose();
  }, [activePanel]);
  if (!activePanel) return null;
  const params = activePanel.api.getParameters() as StoredParams;
  const linkable = '__link' in params;
  const link = params.__link ?? null;
  const color = LINK_GROUPS.find(g => g.key === link)?.color;
  const cycle = () => {
    const i = link == null ? -1 : GROUP_KEYS.indexOf(link as (typeof GROUP_KEYS)[number]);
    const next = i + 1 >= GROUP_KEYS.length ? null : GROUP_KEYS[i + 1];
    activePanel.api.updateParameters({ ...params, __link: next });
  };
  const where = group.api.location.type;
  return (
    <div className="acme-shell-actions">
      {linkable && (
        <button
          className="acme-link-chip"
          style={{ background: color ?? 'transparent', borderColor: color ?? '#5d606b' }}
          onClick={cycle}
          title={link ? `Linked: ${link} (click for the next group)` : 'Not linked (click to link)'}
        />
      )}
      {where === 'grid' && (
        <>
          <button title="Float" onClick={() => containerApi.addFloatingGroup(group)}>
            ⧉
          </button>
          <button title="Pop out into a window" onClick={() => void containerApi.addPopoutGroup(group)}>
            ↗
          </button>
          <button title={group.api.isMaximized() ? 'Restore' : 'Maximize'} onClick={() => (group.api.isMaximized() ? group.api.exitMaximized() : group.api.maximize())}>
            {group.api.isMaximized() ? '▭' : '□'}
          </button>
        </>
      )}
    </div>
  );
}

const STATE_COLORS: Record<string, string> = {
  connected: '#26a69a',
  connecting: '#ff9800',
  disconnected: '#ff9800',
  reconnecting: '#ff9800',
  auth_failed: '#ef5350',
  shutdown: '#ef5350',
  closed: '#5d606b',
};

function ConnectionDot() {
  const { state, last } = useConnectionState();
  const down = state === 'auth_failed' || state === 'shutdown';
  return (
    <span className="acme-shell-conn" title={`Deephaven: ${state}${last ? ` since ${new Date(last.at).toLocaleTimeString()}` : ''}`}>
      <span style={{ background: STATE_COLORS[state] ?? '#5d606b' }} />
      {state === 'connected' ? '' : state.replace('_', ' ')}
      {down && <button onClick={() => location.reload()}>Reconnect</button>}
    </span>
  );
}
