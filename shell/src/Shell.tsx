/**
 * The app shell: dockable panels (dockview: tabs, splits, floating and pop-out windows, maximize), saved
 * workspaces, and link groups shared by the panels.
 *
 *   <Shell kinds={[chartPanel, tablePanel]} store={apiWorkspaceStore(client)} defaultLayout={api => ...} />
 *
 * The current layout is kept in this browser (autosaveKey) and comes back on reload; named workspaces go to
 * `store` (the server, per user, or this browser). Each panel's header has a link-group chip: panels in the
 * same group share values on the link bus (the symbol), so a table row click can move every red chart.
 *
 * New panels open as floating windows (from "+ Panel" and from links inside panels); the user closes them or drags
 * them into the layout. Ctrl+click in "+ Panel" adds a tab to the active group instead. Closing or dragging out a
 * docked panel leaves a blank space (an empty group) where it was, and each group's header can split off a blank
 * space beside or below it; a floating window dropped on a blank space snaps into it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FunctionComponent, type ReactNode } from 'react';
import {
  DockviewReact,
  themeDark,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelProps,
  type IWatermarkPanelProps,
} from 'dockview-react';
import { LINK_GROUPS, LinkProvider, createLinkBus, type LinkBus } from '@acme/chart-react';
import { titleOf, withPrefix, type PanelKind, type PanelProps, type StoredParams } from './registry';
import { LAYOUT_VERSION, migrateLayout, type WorkspaceLayout, type WorkspaceStore, type WorkspaceSummary } from './workspace-store';
import { useConnectionState } from './deephaven';
import { EngineScope } from './engines';
import { fill, snapDrag, toFree, toTiled, watchWindows } from './freeLayout';

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
  /**
   * How panels are arranged when the user hasn't picked (they switch in the top bar; the choice is kept with
   * autosaveKey): 'tiled', dockview's grid (a row's sizes add up to the row), or 'free', every panel a window that
   * moves anywhere and resizes from any edge, edges snapping flush (see freeLayout.ts). Default 'tiled'.
   */
  defaultArrangement?: 'tiled' | 'free';
}

export type AddPanel = (
  kind: string,
  params?: Record<string, unknown>,
  options?: { title?: string; position?: unknown; floating?: number },
) => string | null;

/** a new floating window's share of the shell's size */
export const FLOAT_SIZE = 0.6;

let nextId = 1;
let cascade = 0;
const newId = (kind: string) => `${kind}-${Date.now().toString(36)}-${(nextId++).toString(36)}`;
const GROUP_KEYS = LINK_GROUPS.map(g => g.key);

export function Shell({ kinds, store = null, defaultLayout, title, extra, bus: givenBus, autosaveKey = 'acme.shell.current', popoutUrl, defaultArrangement = 'tiled' }: ShellProps) {
  const freeKey = autosaveKey ? `${autosaveKey}.arrangement` : null;
  const [free, setFreeState] = useState<boolean>(() => {
    try {
      const v = freeKey ? localStorage.getItem(freeKey) : null;
      return (v ?? defaultArrangement) === 'free';
    } catch {
      return defaultArrangement === 'free';
    }
  });
  const freeRef = useRef(free);
  freeRef.current = free;
  const dockRef = useRef<HTMLDivElement>(null);
  const setFree = useCallback(
    (on: boolean) => {
      const api = apiRef.current;
      if (!api || on === freeRef.current) return;
      freeRef.current = on;
      setFreeState(on);
      try {
        if (freeKey) localStorage.setItem(freeKey, on ? 'free' : 'tiled');
      } catch {
        /* not kept */
      }
      if (on && dockRef.current) toFree(api, dockRef.current);
      else toTiled(api);
    },
    [freeKey],
  );
  const bus = useMemo(() => givenBus ?? createLinkBus(), [givenBus]);
  const apiRef = useRef<DockviewApi | null>(null);
  const kindsRef = useRef(kinds);
  kindsRef.current = kinds;
  const [current, setCurrent] = useState<string | null>(null);
  const [saved, setSaved] = useState<WorkspaceSummary[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});

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
    if (!api || !k) return null;
    const p: StoredParams = { ...(k.defaultParams ?? {}), ...params };
    // the header shows a link chip for panels with __link; a kind that can't link has none
    if (!('__link' in p) && k.linkable !== false) p.__link = k.defaultLink === undefined ? 'red' : k.defaultLink;
    const id = newId(kind);
    // floating windows cascade, so a second one doesn't hide the first
    const step = (cascade++ % 6) * 28 - 70;
    const where = options.floating
      ? {
          floating: {
            width: Math.round(api.width * options.floating),
            height: Math.round(api.height * options.floating),
            x: Math.max(0, Math.round((api.width * (1 - options.floating)) / 2) + step),
            y: Math.max(0, Math.round((api.height * (1 - options.floating)) / 2) + step),
          },
        }
      : options.position
        ? { position: options.position }
        : {};
    api.addPanel({ id, component: kind, title: options.title ? withPrefix(k, options.title) : titleOf(k, p), params: p, ...(where as object) });
    return id;
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
      // free layout: a docked layout (the default one, or a tiled workspace) becomes windows once it has its sizes
      const freeUp = () => {
        if (freeRef.current && dockRef.current && e.api.groups.some(g => g.api.location.type === 'grid' && g.panels.length)) toFree(e.api, dockRef.current);
      };
      requestAnimationFrame(() => requestAnimationFrame(freeUp));
      e.api.onDidLayoutFromJSON(() => requestAnimationFrame(freeUp));
      e.api.onDidLayoutChange(() => watchWindows(e.api, () => freeRef.current));
      e.api.onDidLayoutChange(autosave);
      // blank spaces belong to the layout: a floating or popped-out window that empties (its last tab closed or
      // dragged into the layout) goes away
      e.api.onDidLayoutChange(() => {
        for (const g of e.api.groups) if (g.panels.length === 0 && g.api.location.type !== 'grid') e.api.removeGroup(g);
      });
      // the "+ Panel" menu's counts: how many of each kind are on the layout
      const recount = () => {
        const c: Record<string, number> = {};
        for (const panel of e.api.panels) {
          const kind = (panel.api as unknown as { component?: string }).component ?? (panel as unknown as { view?: { contentComponent?: string } }).view?.contentComponent;
          if (kind) c[kind] = (c[kind] ?? 0) + 1;
        }
        setCounts(c);
      };
      recount();
      e.api.onDidAddPanel(recount);
      e.api.onDidRemovePanel(recount);
      e.api.onDidLayoutFromJSON(recount);
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

  /** "+ Panel": a floating window, or (Ctrl+click) a tab in the active group */
  const addFromMenu = useCallback(
    (kind: string, asTab: boolean) => {
      const g = apiRef.current?.activeGroup;
      if (asTab && g) add(kind, {}, { position: { referenceGroup: g.id, direction: 'within' } });
      else if (asTab || !apiRef.current?.groups.length) add(kind);
      else add(kind, {}, { floating: FLOAT_SIZE });
    },
    [add],
  );
  const menu = useMemo(() => ({ kinds, counts, add, free }), [kinds, counts, add, free]);

  // dockview needs stable component functions: one wrapper per kind, made once per kinds list
  const components = useMemo(() => {
    const out: Record<string, FunctionComponent<IDockviewPanelProps>> = {};
    for (const k of kinds) out[k.kind] = props => <PanelHost kind={k} dock={props} add={add} autosave={autosave} />;
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kinds.map(k => k.kind).join(',')]);

  return (
    <LinkProvider bus={bus}>
      <MenuContext.Provider value={menu}>
      <div className="acme-shell">
        <header className="acme-shell-bar">
          <span className="acme-shell-title">{title}</span>
          <AddMenu kinds={kinds} counts={counts} onAdd={addFromMenu} label="+ Panel" hint="Click: a new window · Ctrl+click: a tab in the active panel" />
          <span className="acme-shell-arrange" title="Tiled: panels fill the grid. Free: windows anywhere, resizable from any edge, edges snap.">
            <button className={free ? '' : 'on'} onClick={() => setFree(false)}>
              Tiled
            </button>
            <button className={free ? 'on' : ''} onClick={() => setFree(true)}>
              Free
            </button>
          </span>
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
        <div className={`acme-shell-dock${free ? ' acme-free' : ''}`} ref={dockRef}>
          <DockviewReact
            theme={themeDark}
            components={components}
            onReady={onReady}
            rightHeaderActionsComponent={HeaderActions}
            watermarkComponent={BlankSpace}
            closeEmptyGroups={false}
            transformFloatingGroupDrag={ctx => (freeRef.current ? snapDrag(ctx) : undefined)}
            floatingGroupDragHandle="tabbar"
            popoutUrl={popoutUrl}
          />
        </div>
      </div>
      </MenuContext.Provider>
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
  // a layout saved before the kind had its prefix (or a title set elsewhere): add it
  useEffect(() => {
    const t = dock.api.title ?? '';
    if (kind.titlePrefix && t && !t.startsWith(kind.titlePrefix)) dock.api.setTitle(withPrefix(kind, t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const { __link, __engine, ...own } = params;
  const props: PanelProps = {
    id: dock.api.id,
    params: own,
    setParams,
    setTitle: t => dock.api.setTitle(withPrefix(kind, t)),
    linkGroup: __link ?? null,
    // a floating window unless the caller docks it (docked, or a tab: 'within')
    openPanel: (k, p, title, where) =>
      where?.docked || where?.direction === 'within'
        ? add(k, p, { title, position: { referencePanel: where?.referencePanel ?? dock.api.id, direction: where?.direction ?? 'right' } })
        : add(k, p, { title, floating: where?.floating ?? FLOAT_SIZE }),
  };
  const C = kind.component;
  return (
    <div className="acme-panel">
      {__engine ? (
        <EngineScope engine={__engine}>
          <C {...props} />
        </EngineScope>
      ) : (
        <C {...props} />
      )}
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
  const free = useContext(MenuContext)?.free ?? false;
  const where = group.api.location.type;
  const split = where === 'grid' && !free && (
    <>
      <button title="Blank space to the right (drag a window into it)" onClick={() => containerApi.addGroup({ referenceGroup: group.id, direction: 'right' })}>
        ◫
      </button>
      <button title="Blank space below (drag a window into it)" onClick={() => containerApi.addGroup({ referenceGroup: group.id, direction: 'below' })}>
        ⊟
      </button>
    </>
  );
  const close = (
    <button
      className="acme-shell-close"
      title={group.panels.length > 1 ? `Close these ${group.panels.length} tabs and their space` : group.panels.length ? 'Close, and its space' : 'Remove this blank space'}
      onClick={() => {
        if (group.api.isMaximized()) group.api.exitMaximized();
        containerApi.removeGroup(group);
      }}
    >
      ✕
    </button>
  );
  if (!activePanel)
    return (
      <div className="acme-shell-actions">
        {split}
        {close}
      </div>
    );
  // the panel's params, not api.getParameters(): dockview 8.8's api returns {} until the first updateParameters,
  // so a panel that never changes its params (a curve, a watchlist) showed no link chip
  const params = ((activePanel as { params?: StoredParams }).params ?? activePanel.api.getParameters()) as StoredParams;
  const linkable = '__link' in params;
  const link = params.__link ?? null;
  const color = LINK_GROUPS.find(g => g.key === link)?.color;
  const cycle = () => {
    const i = link == null ? -1 : GROUP_KEYS.indexOf(link as (typeof GROUP_KEYS)[number]);
    const next = i + 1 >= GROUP_KEYS.length ? null : GROUP_KEYS[i + 1];
    activePanel.api.updateParameters({ ...params, __link: next });
  };
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
      {split}
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
      {/* free layout: grow into the blank space around the window */}
      {free && where === 'floating' && (
        <button title="Fill the blank space around it" onClick={() => fill(containerApi, group)}>
          ⤢
        </button>
      )}
      {/* a floating or popped-out group can always go back into the layout (in a free layout, windows are the layout) */}
      {where !== 'grid' && !free && (
        <button title="Dock into the layout" onClick={() => group.api.moveTo({ position: 'right' })}>
          ⇲
        </button>
      )}
      {/* every group, wherever it is, can be closed in one click (all its tabs, and the space); a tab's own ✕
          closes just it and leaves a blank space */}
      {close}
    </div>
  );
}

interface MenuState {
  free: boolean;
  kinds: PanelKind[];
  counts: Record<string, number>;
  add: AddPanel;
}
const MenuContext = createContext<MenuState | null>(null);

/** A menu of panel kinds (a panel already on the layout is marked, with how many). */
export function AddMenu({ kinds, counts, onAdd, label, hint }: { kinds: PanelKind[]; counts: Record<string, number>; onAdd: (kind: string, ctrl: boolean) => void; label: string; hint?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const off = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', off);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', off);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="acme-addmenu" ref={ref}>
      <button className="acme-shell-add" onClick={() => setOpen(o => !o)} title={hint}>
        {label} ▾
      </button>
      {open && (
        <div className="acme-addmenu-list" role="menu">
          {hint && <div className="acme-addmenu-hint">{hint}</div>}
          {kinds.map(k => (
            <button
              key={k.kind}
              role="menuitem"
              title={k.description}
              onClick={e => {
                setOpen(false);
                onAdd(k.kind, e.ctrlKey || e.metaKey);
              }}
            >
              <span className="acme-addmenu-dot">{counts[k.kind] ? '●' : ''}</span>
              {k.label ?? titleOf(k, k.defaultParams ?? {})}
              {counts[k.kind] ? <small>{counts[k.kind]} open</small> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** An empty group: a blank space to drop a window into, or to add a panel to. */
function BlankSpace({ group }: IWatermarkPanelProps) {
  const m = useContext(MenuContext);
  return (
    <div className="acme-blank">
      <div>
        {m?.free
          ? 'Free layout: move windows anywhere (drag the tab bar), resize them from any edge; edges snap flush. ⤢ fills a window into the space around it.'
          : group
            ? 'Blank space: drag a window or tab here'
            : 'No panels'}
      </div>
      {m && (
        <AddMenu
          kinds={m.kinds}
          counts={m.counts}
          label="Add a panel here"
          onAdd={kind => m.add(kind, {}, group ? { position: { referenceGroup: group.id, direction: 'within' } } : {})}
        />
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
