/**
 * Where workspaces are saved. A workspace is the shell's whole layout: dockview's serialized grid (panels,
 * their kinds and params, groups, floating and pop-out windows) and the link groups' values.
 *
 *   apiWorkspaceStore(client)   on the server, per user (dh_chart_ext.workspaces through a request API)
 *   localWorkspaceStore()       in this browser (no server, or before sign-in)
 *
 * Versioned: a layout from an older shell is migrated by `migrateLayout` when it is loaded.
 */
import type { ApiClient } from '@acme/dh-bindings';

export const LAYOUT_VERSION = 1;

export interface WorkspaceLayout {
  version: number;
  /** dockview's toJSON() */
  dock: unknown;
  /** the link bus's values per group */
  links: Record<string, Record<string, unknown>>;
}

export interface WorkspaceSummary {
  name: string;
  saved_at: number;
}

export interface WorkspaceStore {
  /** a short description for the UI: "server" or "this browser" */
  readonly where: string;
  list(): Promise<WorkspaceSummary[]>;
  load(name: string): Promise<WorkspaceLayout | null>;
  save(name: string, layout: WorkspaceLayout): Promise<void>;
  remove(name: string): Promise<void>;
}

/** Bring a saved layout up to LAYOUT_VERSION (null if it can't be read). */
export function migrateLayout(raw: unknown): WorkspaceLayout | null {
  if (raw == null || typeof raw !== 'object') return null;
  const l = raw as Partial<WorkspaceLayout>;
  if (typeof l.version !== 'number' || l.dock == null) return null;
  if (l.version > LAYOUT_VERSION) return null; // from a newer shell: don't guess
  // version 1 is the first; later versions add their steps here
  return { version: LAYOUT_VERSION, dock: l.dock, links: l.links ?? {} };
}

export function localWorkspaceStore(prefix = 'acme.workspaces', storage: Storage | undefined = globalThis.localStorage): WorkspaceStore {
  const read = (): Record<string, { layout: WorkspaceLayout; saved_at: number }> => {
    try {
      return JSON.parse(storage?.getItem(prefix) ?? '{}');
    } catch {
      return {};
    }
  };
  const write = (all: ReturnType<typeof read>) => storage?.setItem(prefix, JSON.stringify(all));
  return {
    where: 'this browser',
    async list() {
      return Object.entries(read())
        .map(([name, w]) => ({ name, saved_at: w.saved_at }))
        .sort((a, b) => b.saved_at - a.saved_at);
    },
    async load(name) {
      return migrateLayout(read()[name]?.layout);
    },
    async save(name, layout) {
      const all = read();
      all[name] = { layout, saved_at: Date.now() };
      write(all);
    },
    async remove(name) {
      const all = read();
      delete all[name];
      write(all);
    },
  };
}

export function apiWorkspaceStore(client: ApiClient): WorkspaceStore {
  return {
    where: 'server',
    async list() {
      return (await client.request<WorkspaceSummary[]>('workspaces')).result;
    },
    async load(name) {
      try {
        const { result } = await client.request<{ layout: unknown }>('workspace_load', { name });
        return migrateLayout(result.layout);
      } catch (e) {
        if ((e as { code?: string }).code === 'not_found') return null;
        throw e;
      }
    },
    async save(name, layout) {
      await client.request('workspace_save', { name, layout });
    },
    async remove(name) {
      await client.request('workspace_delete', { name });
    },
  };
}
