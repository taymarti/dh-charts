/**
 * The mock engine: in-memory tables that tick, standing in for a Deephaven server's update graph.
 *
 *   Source          a table: columns, ordered row keys, a getter, and change events (added / modified / removed keys)
 *     RowSource     rows as objects (quotes, books, reference data, input tables); optional key columns (upserts)
 *     SeriesSource  columnar numbers keyed 0..n-1 (bars and chart nodes); grows at the end, the last rows change
 *
 * Mutations are collected per source and delivered once per update cycle (`Engine.cycle`), like Deephaven's
 * update graph: every source's pending change goes to its listeners, listeners may change other sources (derived
 * tables), and that repeats until nothing is pending. Then the table handles (mock/dh.ts) push to their
 * subscriptions. Every source is a node of the graph the "Update graph" panel shows, with its measured cost.
 */

export type ColType = 'java.lang.String' | 'double' | 'long' | 'int' | 'boolean' | 'java.time.Instant';

export interface ColumnDef {
  name: string;
  type: ColType;
  description?: string;
}

export interface Change {
  added: number[];
  modified: number[];
  removed: number[];
}

export type NodeKind = 'source' | 'op' | 'callback' | 'sink' | 'internal';

/** An Instant cell, like the JS API's DateWrapper: nanoseconds, and a Date. */
export class Instant {
  constructor(readonly ms: number) {}
  asNumber() {
    return this.ms * 1e6;
  }
  asDate() {
    return new Date(this.ms);
  }
  valueOf() {
    return this.ms;
  }
  toString() {
    return new Date(this.ms).toISOString();
  }
}

export const instant = (ms: number | null | undefined) => (ms == null || !Number.isFinite(ms) ? null : new Instant(ms));

let nextId = 1;

export abstract class Source {
  readonly id = nextId++;
  /** names this table is published under (the graph's bold labels) */
  readonly variables: string[] = [];
  parents: Source[] = [];
  kind: NodeKind = 'op';
  description = '';
  /** measured per cycle (an exponential average), for the update graph */
  readonly cost = { ms: 0, rows: 0, last: 0 };
  private listeners = new Set<(c: Change) => void>();
  private pending: Change | null = null;
  closed = false;
  /** keys come back after a removal (series rows 0..n-1) */
  protected reusesKeys = false;

  constructor(
    readonly engine: Engine,
    public label: string,
  ) {
    engine.sources.add(this);
  }

  abstract readonly columns: ColumnDef[];
  /** row keys in table order */
  abstract keys(): ArrayLike<number>;
  abstract get(key: number, col: string): unknown;

  get size(): number {
    return this.keys().length;
  }

  hasColumn(name: string) {
    return this.columns.some(c => c.name === name);
  }

  on(listener: (c: Change) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  get listened() {
    return this.listeners.size > 0;
  }

  /** queue a change for this cycle's delivery */
  protected note(added: number[] = [], modified: number[] = [], removed: number[] = []) {
    if (!added.length && !modified.length && !removed.length) return;
    const p = (this.pending ??= { added: [], modified: [], removed: [] });
    p.added.push(...added);
    p.modified.push(...modified);
    p.removed.push(...removed);
    this.engine.dirty.add(this);
    this.engine.wake();
  }

  /** deliver the queued change (Engine.cycle calls it) */
  deliver() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    // a key added and then modified in one cycle is just added. Row keys are never reused, so one added and
    // removed in the same cycle never existed for a subscriber; series keys are reused (a rebuild removes every
    // row and adds them again), so there both are reported: removed first, then added
    const added = new Set(p.added);
    const removed = new Set<number>();
    for (const k of p.removed) {
      if (!this.reusesKeys && added.has(k)) added.delete(k);
      else removed.add(k);
    }
    const modified = [...new Set(p.modified)].filter(k => !added.has(k) && !removed.has(k));
    const c: Change = { added: [...added], modified, removed: [...removed] };
    const t0 = performance.now();
    for (const l of [...this.listeners]) {
      try {
        l(c);
      } catch (e) {
        console.warn(`${this.label}: listener failed`, e);
      }
    }
    this.measure(performance.now() - t0, c.added.length + c.modified.length + c.removed.length);
  }

  measure(ms: number, rows: number) {
    this.cost.ms = this.cost.ms * 0.8 + ms * 0.2;
    this.cost.rows = this.cost.rows * 0.8 + rows * 0.2;
    this.cost.last = Date.now();
  }

  close() {
    this.closed = true;
    this.listeners.clear();
    this.engine.sources.delete(this);
  }
}

// ----------------------------------------------------------------------------- rows as objects

export type Row = Record<string, unknown>;

export class RowSource extends Source {
  readonly columns: ColumnDef[];
  private rows = new Map<number, Row>();
  private order: number[] = [];
  private next = 0;
  private byKey: Map<string, number> | null;
  readonly keyCols: string[] | null;
  /** an input table: clients may addRow (upserts by keyCols) */
  readonly input: boolean;
  /** called after a client writes rows (persistence) */
  onWrite?: (rows: Row[]) => void;

  constructor(engine: Engine, label: string, columns: ColumnDef[], opts: { keyCols?: string[]; input?: boolean; kind?: NodeKind; description?: string } = {}) {
    super(engine, label);
    this.columns = columns;
    this.keyCols = opts.keyCols ?? null;
    this.byKey = this.keyCols ? new Map() : null;
    this.input = !!opts.input;
    this.kind = opts.kind ?? 'source';
    this.description = opts.description ?? '';
  }

  keys() {
    return this.order;
  }

  get(key: number, col: string) {
    return this.rows.get(key)?.[col];
  }

  row(key: number): Row | undefined {
    return this.rows.get(key);
  }

  all(): Row[] {
    return this.order.map(k => this.rows.get(k)!);
  }

  private keyOf(row: Row) {
    return this.keyCols!.map(c => String(row[c] ?? '')).join('\u0000');
  }

  /** append rows (no key columns) or upsert them (key columns); returns their keys */
  put(rows: Row[]): number[] {
    const added: number[] = [];
    const modified: number[] = [];
    const out: number[] = [];
    for (const r of rows) {
      if (this.byKey) {
        const kk = this.keyOf(r);
        const existing = this.byKey.get(kk);
        if (existing != null) {
          this.rows.set(existing, { ...this.rows.get(existing), ...r });
          modified.push(existing);
          out.push(existing);
          continue;
        }
        const k = this.next++;
        this.byKey.set(kk, k);
        this.rows.set(k, { ...r });
        this.order.push(k);
        added.push(k);
        out.push(k);
      } else {
        const k = this.next++;
        this.rows.set(k, { ...r });
        this.order.push(k);
        added.push(k);
        out.push(k);
      }
    }
    this.note(added, modified);
    return out;
  }

  /** merge into an existing row */
  patch(key: number, patch: Row) {
    const r = this.rows.get(key);
    if (!r) return;
    Object.assign(r, patch);
    this.note([], [key]);
  }

  /** the key of the row with these key-column values (key columns only) */
  find(values: unknown[]): number | undefined {
    return this.byKey?.get(values.map(v => String(v ?? '')).join('\u0000'));
  }

  remove(keys: number[]) {
    const gone = new Set(keys.filter(k => this.rows.has(k)));
    if (!gone.size) return;
    for (const k of gone) {
      const r = this.rows.get(k)!;
      if (this.byKey) this.byKey.delete(this.keyOf(r));
      this.rows.delete(k);
    }
    this.order = this.order.filter(k => !gone.has(k));
    this.note([], [], [...gone]);
  }

  /** drop the oldest rows beyond `max` (a tape) */
  cap(max: number) {
    if (this.order.length > max) this.remove(this.order.slice(0, this.order.length - max));
  }

  /** replace everything */
  reset(rows: Row[]) {
    this.remove([...this.order]);
    this.put(rows);
  }

  /** a client's addRow on an input table */
  clientWrite(rows: Row[]) {
    if (!this.input) throw new Error(`${this.label} is not an input table`);
    this.put(rows);
    this.onWrite?.(rows);
  }
}

// ----------------------------------------------------------------------------- columnar series (bars, chart nodes)

export class SeriesSource extends Source {
  readonly columns: ColumnDef[];
  /** column -> values; Timestamp is UTC seconds */
  readonly data: Record<string, Float64Array>;
  n = 0;
  private cachedKeys: Int32Array | null = null;
  private timeCol: string;

  constructor(engine: Engine, label: string, columns: ColumnDef[], opts: { timeCol?: string; capacity?: number; kind?: NodeKind; description?: string } = {}) {
    super(engine, label);
    this.columns = columns;
    this.timeCol = opts.timeCol ?? 'Timestamp';
    const cap = Math.max(16, opts.capacity ?? 1024);
    this.data = {};
    for (const c of columns) if (c.type !== 'java.lang.String') this.data[c.name] = new Float64Array(cap);
    this.kind = opts.kind ?? 'op';
    this.description = opts.description ?? '';
    this.reusesKeys = true;
  }

  keys() {
    if (!this.cachedKeys || this.cachedKeys.length !== this.n) {
      this.cachedKeys = new Int32Array(this.n);
      for (let i = 0; i < this.n; i++) this.cachedKeys[i] = i;
    }
    return this.cachedKeys;
  }

  get(key: number, col: string) {
    if (key < 0 || key >= this.n) return null;
    const a = this.data[col];
    if (!a) return null;
    const v = a[key];
    if (col === this.timeCol || this.columns.find(c => c.name === col)?.type === 'java.time.Instant') return instant(v * 1000);
    return Number.isNaN(v) ? null : v;
  }

  ensure(n: number) {
    const cap = this.data[this.timeCol].length;
    if (n <= cap) return;
    let next = cap;
    while (next < n) next *= 2;
    for (const k of Object.keys(this.data)) {
      const grown = new Float64Array(next);
      grown.set(this.data[k].subarray(0, this.n));
      this.data[k] = grown;
    }
  }

  /** keep rows [0, n) and report rows from..newN as modified/added */
  commitFrom(from: number, prevN: number) {
    const mod: number[] = [];
    const add: number[] = [];
    for (let i = from; i < this.n; i++) (i < prevN ? mod : add).push(i);
    const removed: number[] = [];
    for (let i = this.n; i < prevN; i++) removed.push(i);
    this.note(add, mod, removed);
  }

  /** replace all rows (a rebuild): everything is reported, so subscribers take a new snapshot */
  rebuilt(prevN: number) {
    const removed: number[] = [];
    for (let i = 0; i < prevN; i++) removed.push(i);
    const added: number[] = [];
    for (let i = 0; i < this.n; i++) added.push(i);
    this.note(added, [], removed);
  }
}

// ----------------------------------------------------------------------------- the update cycle

export class Engine {
  readonly sources = new Set<Source>();
  readonly dirty = new Set<Source>();
  /** run before delivery each cycle: the market simulator, alert evaluation */
  readonly tickers: Array<{ label: string; fn: (now: number, dtMs: number) => void; cost: { ms: number } }> = [];
  /** run after delivery each cycle: table handles push to subscriptions */
  readonly flushers = new Set<(now: number) => void>();
  readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private soon: ReturnType<typeof setTimeout> | null = null;
  private last = Date.now();
  cycles = 0;
  cycleMs = 0;
  paused = false;

  constructor(intervalMs = 250) {
    this.intervalMs = intervalMs;
  }

  addTicker(label: string, fn: (now: number, dtMs: number) => void) {
    this.tickers.push({ label, fn, cost: { ms: 0 } });
  }

  start() {
    if (this.timer) return;
    this.last = Date.now();
    this.timer = setInterval(() => this.cycle(), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** a client wrote something between cycles: deliver it promptly (the echo of an input-table write) */
  wake() {
    if (this.soon || this.inCycle) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      this.deliverAll();
      this.flush(Date.now());
    }, 0);
  }

  private inCycle = false;

  cycle() {
    const now = Date.now();
    const dt = now - this.last;
    this.last = now;
    const t0 = performance.now();
    this.inCycle = true;
    try {
      if (!this.paused)
        for (const t of this.tickers) {
          const s = performance.now();
          try {
            t.fn(now, dt);
          } catch (e) {
            console.warn(`${t.label} failed`, e);
          }
          t.cost.ms = t.cost.ms * 0.8 + (performance.now() - s) * 0.2;
        }
      this.deliverAll();
    } finally {
      this.inCycle = false;
    }
    this.flush(now);
    this.cycles++;
    this.cycleMs = this.cycleMs * 0.9 + (performance.now() - t0) * 0.1;
  }

  deliverAll() {
    for (let guard = 0; this.dirty.size && guard < 50; guard++) {
      const batch = [...this.dirty];
      this.dirty.clear();
      for (const s of batch) s.deliver();
    }
  }

  private flush(now: number) {
    for (const f of [...this.flushers]) {
      try {
        f(now);
      } catch (e) {
        console.warn('a subscription failed', e);
      }
    }
  }
}

// ----------------------------------------------------------------------------- column helpers

export const S = (name: string, description?: string): ColumnDef => ({ name, type: 'java.lang.String', description });
export const D = (name: string, description?: string): ColumnDef => ({ name, type: 'double', description });
export const L = (name: string, description?: string): ColumnDef => ({ name, type: 'long', description });
export const I = (name: string, description?: string): ColumnDef => ({ name, type: 'int', description });
export const B = (name: string, description?: string): ColumnDef => ({ name, type: 'boolean', description });
export const T = (name: string, description?: string): ColumnDef => ({ name, type: 'java.time.Instant', description });
