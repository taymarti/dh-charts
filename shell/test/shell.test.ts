import { describe, expect, it, vi } from 'vitest';
import { LAYOUT_VERSION, apiWorkspaceStore, localWorkspaceStore, migrateLayout } from '../src/workspace-store';
import { parseField } from '../src/panels';
import { layoutGraph } from '../src/graph/GraphPanel';
import { oneRowPerTime } from '../src/series/SeriesPanel';

const memoryStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } as unknown as Storage;
};
const layout = (n: number) => ({ version: LAYOUT_VERSION, dock: { n }, links: { red: { symbol: 'ES' } } });

describe('migrateLayout', () => {
  it('accepts this version, fills links, refuses unknown or newer layouts', () => {
    expect(migrateLayout({ version: 1, dock: {} })).toEqual({ version: 1, dock: {}, links: {} });
    expect(migrateLayout({ version: LAYOUT_VERSION + 1, dock: {} })).toBeNull();
    expect(migrateLayout({ dock: {} })).toBeNull();
    expect(migrateLayout('x')).toBeNull();
  });
});

describe('localWorkspaceStore', () => {
  it('saves, lists newest first, loads and removes', async () => {
    const s = localWorkspaceStore('t', memoryStorage());
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1);
    await s.save('a', layout(1));
    now.mockReturnValue(2);
    await s.save('b', layout(2));
    now.mockRestore();
    expect((await s.list()).map(w => w.name)).toEqual(['b', 'a']);
    expect(await s.load('a')).toEqual(layout(1));
    await s.remove('a');
    expect(await s.load('a')).toBeNull();
  });
});

describe('apiWorkspaceStore', () => {
  it('maps to the workspace methods, and not_found to null', async () => {
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'workspace_load' && params?.name === 'gone') throw Object.assign(new Error('no'), { code: 'not_found' });
      if (method === 'workspace_load') return { result: { layout: layout(3) }, refs: [] };
      if (method === 'workspaces') return { result: [{ name: 'x', saved_at: 5 }], refs: [] };
      return { result: {}, refs: [] };
    });
    const s = apiWorkspaceStore({ request } as never);
    expect(await s.list()).toEqual([{ name: 'x', saved_at: 5 }]);
    expect(await s.load('x')).toEqual(layout(3));
    expect(await s.load('gone')).toBeNull();
    await s.save('x', layout(4));
    expect(request).toHaveBeenLastCalledWith('workspace_save', { name: 'x', layout: layout(4) });
    await s.remove('x');
    expect(request).toHaveBeenLastCalledWith('workspace_delete', { name: 'x' });
  });
});

describe('parseField', () => {
  const p = (type: string) => ({ name: 'f', type, required: false });
  it('reads form text by the parameter type', () => {
    expect(parseField(p('string'), ' ES ')).toBe('ES');
    expect(parseField(p('string'), '')).toBeUndefined();
    expect(parseField(p('integer'), '12')).toBe(12);
    expect(() => parseField(p('number'), 'x')).toThrow('a number');
    expect(parseField(p('array'), 'EMA_20, RSI_14')).toEqual(['EMA_20', 'RSI_14']);
    expect(parseField(p('array'), '[{"type":"EMA"}]')).toEqual([{ type: 'EMA' }]);
    expect(parseField(p('object'), '{"a":1}')).toEqual({ a: 1 });
    expect(() => parseField(p('object'), 'nope')).toThrow('JSON');
    expect(parseField(p('any'), 'plain')).toBe('plain');
    expect(parseField(p('boolean'), 'true')).toBe(true);
  });
});


describe('layoutGraph', () => {
  const n = (id: number, parents: number[] = [], variables: string[] = []) => ({ id, kind: 'op', label: '', description: '', variables, parents });
  it('puts each node one column right of its deepest input', () => {
    // 1 -> 2 -> 4, 1 -> 3 -> 4, 3 -> 5; 6 alone
    const { placed } = layoutGraph([n(1), n(2, [1]), n(3, [1]), n(4, [2, 3], ['out']), n(5, [3]), n(6)]);
    const col = (id: number) => placed.get(id)!.x;
    expect(col(1)).toBe(col(6));
    expect(col(2)).toBeGreaterThan(col(1));
    expect(col(2)).toBe(col(3));
    expect(col(4)).toBeGreaterThan(col(2));
    expect(col(5)).toBe(col(4));
  });
  it('survives a cycle and parents that are not in the list', () => {
    const { placed } = layoutGraph([n(1, [2]), n(2, [1]), n(3, [99])]);
    expect(placed.size).toBe(3);
  });
});

describe('oneRowPerTime', () => {
  it('keeps the last row per time, in time order', () => {
    const rows = [
      { time: 2, v: 1 },
      { time: 1, v: 2 },
      { time: 2, v: 3 },
    ];
    expect(oneRowPerTime(rows)).toEqual([
      { time: 1, v: 2 },
      { time: 2, v: 3 },
    ]);
  });
});
