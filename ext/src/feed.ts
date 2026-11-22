/**
 * SeriesFeed: how a chart gets its data, whatever the source. A feed delivers rows keyed by time:
 * a snapshot (everything, replacing what the chart has) and updates (new or changed rows, at or after
 * the last time). The chart side (bindFeed) never knows where rows come from: @acme/dh-bindings'
 * tableFeed reads a Deephaven table; memoryFeed below is for tests, demos and non-Deephaven sources.
 *
 * Rows: { time: UTC seconds, <column>: number | null, ... }. Null is a gap.
 * A source that removes rows, or changes a row before the last one, sends a new snapshot: Lightweight
 * Charts updates only at or after the last bar, and replaces everything otherwise.
 */
export type FeedRow = { time: number } & Record<string, number | null>;

export interface FeedListener {
  /** every row, in time order; replaces what the chart shows */
  snapshot(rows: FeedRow[]): void;
  /** new or changed rows, in time order, none before the last row already delivered */
  update(rows: FeedRow[]): void;
  /** the feed failed or ended */
  error?(e: unknown): void;
}

export interface SeriesFeed {
  /** the value columns the rows carry (besides time) */
  readonly columns: string[];
  /** start delivering; returns the unsubscribe function */
  subscribe(listener: FeedListener): () => void;
}

/** A feed held in memory: set() sends a snapshot, push() an update (or a snapshot when it goes back in time). */
export interface MemoryFeed extends SeriesFeed {
  set(rows: FeedRow[]): void;
  push(rows: FeedRow[]): void;
  rows(): FeedRow[];
}

export function memoryFeed(columns: string[], initial: FeedRow[] = []): MemoryFeed {
  let data = [...initial].sort((a, b) => a.time - b.time);
  const listeners = new Set<FeedListener>();
  return {
    columns,
    rows: () => data,
    subscribe(l) {
      listeners.add(l);
      l.snapshot(data);
      return () => listeners.delete(l);
    },
    set(rows) {
      data = [...rows].sort((a, b) => a.time - b.time);
      listeners.forEach(l => l.snapshot(data));
    },
    push(rows) {
      if (!rows.length) return;
      const sorted = [...rows].sort((a, b) => a.time - b.time);
      const last = data.length ? data[data.length - 1].time : -Infinity;
      const byTime = new Map(data.map(r => [r.time, r]));
      sorted.forEach(r => byTime.set(r.time, r));
      data = [...byTime.values()].sort((a, b) => a.time - b.time);
      if (sorted[0].time < last) listeners.forEach(l => l.snapshot(data));
      else listeners.forEach(l => l.update(sorted));
    },
  };
}

/**
 * Merge Deephaven-style changes into ordered rows and say what a listener should get: the rows to
 * deliver, and whether that is a snapshot. Used by feeds over sources that report added, modified and
 * removed rows (tableFeed). `current` is keyed by time.
 */
export function applyChanges(
  current: Map<number, FeedRow>,
  changes: { added: FeedRow[]; modified: FeedRow[]; removedTimes: number[] },
): { snapshot: boolean; rows: FeedRow[] } {
  const lastBefore = current.size ? Math.max(...current.keys()) : -Infinity;
  changes.removedTimes.forEach(t => current.delete(t));
  const changed = [...changes.added, ...changes.modified];
  changed.forEach(r => current.set(r.time, r));
  const all = () => [...current.values()].sort((a, b) => a.time - b.time);
  if (changes.removedTimes.length) return { snapshot: true, rows: all() };
  if (changed.some(r => r.time < lastBefore)) return { snapshot: true, rows: all() };
  return { snapshot: false, rows: changed.sort((a, b) => a.time - b.time) };
}
