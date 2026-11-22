import { describe, expect, it, vi } from 'vitest';
import { applyChanges, memoryFeed, type FeedRow } from '../src/feed';

const row = (time: number, Close: number | null = time): FeedRow => ({ time, Close }) as FeedRow;

describe('memoryFeed', () => {
  it('sends a snapshot on subscribe, then updates', () => {
    const f = memoryFeed(['Close'], [row(2), row(1)]);
    const snapshot = vi.fn();
    const update = vi.fn();
    f.subscribe({ snapshot, update });
    expect(snapshot).toHaveBeenCalledWith([row(1), row(2)]);
    f.push([row(3)]);
    expect(update).toHaveBeenCalledWith([row(3)]);
  });
  it('turns a change before the last row into a snapshot', () => {
    const f = memoryFeed(['Close'], [row(1), row(2), row(3)]);
    const snapshot = vi.fn();
    f.subscribe({ snapshot, update: vi.fn() });
    f.push([row(2, 99)]);
    expect(snapshot).toHaveBeenLastCalledWith([row(1), row(2, 99), row(3)]);
  });
  it('stops after unsubscribe', () => {
    const f = memoryFeed(['Close']);
    const update = vi.fn();
    f.subscribe({ snapshot: vi.fn(), update })();
    f.push([row(1)]);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('applyChanges', () => {
  const start = () => new Map([1, 2, 3].map(t => [t, row(t)]));
  it('updates at or after the last row', () => {
    const cur = start();
    expect(applyChanges(cur, { added: [row(4)], modified: [row(3, 30)], removedTimes: [] })).toEqual({
      snapshot: false,
      rows: [row(3, 30), row(4)],
    });
    expect(cur.size).toBe(4);
  });
  it('snapshots when rows are removed', () => {
    expect(applyChanges(start(), { added: [], modified: [], removedTimes: [1] })).toEqual({ snapshot: true, rows: [row(2), row(3)] });
  });
  it('snapshots when older history arrives', () => {
    const r = applyChanges(start(), { added: [row(0)], modified: [], removedTimes: [] });
    expect(r.snapshot).toBe(true);
    expect(r.rows.map(x => x.time)).toEqual([0, 1, 2, 3]);
  });
});
