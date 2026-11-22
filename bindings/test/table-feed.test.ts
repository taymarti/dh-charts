import { describe, expect, it, vi } from 'vitest';
import { tableFeed } from '../src/table-feed';

// A stand-in for a Deephaven table and its subscription: rows by row key, events with RangeSets.
type Rows = Map<number, Record<string, unknown>>;
const rangeSet = (keys: number[]) => ({
  size: keys.length,
  iterator: () => {
    let i = 0;
    return { hasNext: () => i < keys.length, next: () => ({ value: keys[i++] }) };
  },
});
const ns = (sec: number) => ({ asNumber: () => sec * 1e9 }); // an Instant column value (DateWrapper)

function fakeTable() {
  let listener: ((e: unknown) => void) | undefined;
  const closed = vi.fn();
  const table = {
    findColumn: (name: string) => ({ name }),
    subscribe: () => ({
      addEventListener: (_t: string, cb: (e: unknown) => void) => (listener = cb),
      close: closed,
    }),
  };
  const emit = (rows: Rows, ch: { added?: number[]; modified?: number[]; removed?: number[] }) =>
    listener!({
      detail: {
        fullIndex: rangeSet([...rows.keys()]),
        added: rangeSet(ch.added ?? []),
        modified: rangeSet(ch.modified ?? []),
        removed: rangeSet(ch.removed ?? []),
        getData: (k: number, c: { name: string }) => rows.get(k)![c.name],
      },
    });
  return { table, emit, closed };
}

const dh = { Table: { EVENT_UPDATED: 'updated' } };
const bar = (t: number, close: number | null) => ({ Timestamp: ns(t), Close: close });

describe('tableFeed', () => {
  it('delivers a snapshot, then updates, in UTC seconds', () => {
    const { table, emit } = fakeTable();
    const snapshot = vi.fn();
    const update = vi.fn();
    tableFeed(dh as never, table as never, ['Close']).subscribe({ snapshot, update });
    const rows: Rows = new Map([
      [0, bar(60, 1)],
      [1, bar(120, 2)],
    ]);
    emit(rows, { added: [0, 1] });
    expect(snapshot).toHaveBeenCalledWith([
      { time: 60, Close: 1 },
      { time: 120, Close: 2 },
    ]);
    rows.set(1, bar(120, 2.5));
    rows.set(2, bar(180, null));
    emit(rows, { modified: [1], added: [2] });
    expect(update).toHaveBeenCalledWith([
      { time: 120, Close: 2.5 },
      { time: 180, Close: null },
    ]);
  });

  it('resends a snapshot when rows are removed (the window moved)', () => {
    const { table, emit } = fakeTable();
    const snapshot = vi.fn();
    tableFeed(dh as never, table as never, ['Close']).subscribe({ snapshot, update: vi.fn() });
    const rows: Rows = new Map([
      [0, bar(60, 1)],
      [1, bar(120, 2)],
    ]);
    emit(rows, { added: [0, 1] });
    rows.delete(0);
    emit(rows, { removed: [0] });
    expect(snapshot).toHaveBeenLastCalledWith([{ time: 120, Close: 2 }]);
  });

  it('resends a snapshot when older history arrives', () => {
    const { table, emit } = fakeTable();
    const snapshot = vi.fn();
    const update = vi.fn();
    tableFeed(dh as never, table as never, ['Close']).subscribe({ snapshot, update });
    const rows: Rows = new Map([[5, bar(120, 2)]]);
    emit(rows, { added: [5] });
    rows.set(4, bar(60, 1));
    emit(rows, { added: [4] });
    expect(update).not.toHaveBeenCalled();
    expect(snapshot).toHaveBeenLastCalledWith([
      { time: 60, Close: 1 },
      { time: 120, Close: 2 },
    ]);
  });

  it('closes the subscription on unsubscribe', () => {
    const { table, closed } = fakeTable();
    tableFeed(dh as never, table as never, ['Close']).subscribe({ snapshot: vi.fn(), update: vi.fn() })();
    expect(closed).toHaveBeenCalled();
  });
});
