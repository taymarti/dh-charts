/**
 * A mock of the Deephaven JS API (the part @acme/dh-bindings and @acme/app-shell use), over the mock engine.
 * `connect({ dh: createMockDh(server) })` gives the shell a session that behaves like one on a real server:
 * published tables by name, handles with their own filters and sorts, full and viewport subscriptions that
 * tick, input tables, request-API widgets, and the console's field updates.
 *
 * What is covered: CoreClient, IdeConnection (getObject, subscribeToFieldUpdates), VariableType, Table
 * (columns, size, findColumn, subscribe, setViewport, applyFilter, applySort, copy, selectDistinct,
 * inputTable, close, events), Column.sort / filter, FilterValue, DateWrapper, Widget. Not covered: tree and
 * partitioned tables, totals, rollups, custom columns, the console (runCode).
 */
import { Engine, Instant, RowSource, type Change, type ColumnDef, type Source } from './engine';
import type { Api, Stream } from './rpc';

type Listener = (e: { type: string; detail?: unknown }) => void;

class Events {
  private map = new Map<string, Set<Listener>>();
  addEventListener(type: string, fn: Listener): () => void {
    let s = this.map.get(type);
    if (!s) this.map.set(type, (s = new Set()));
    s.add(fn);
    return () => void s!.delete(fn);
  }
  removeEventListener(type: string, fn: Listener) {
    this.map.get(type)?.delete(fn);
  }
  protected fire(type: string, detail?: unknown) {
    for (const fn of [...(this.map.get(type) ?? [])]) {
      try {
        fn({ type, detail });
      } catch (e) {
        console.warn(`a ${type} listener failed`, e);
      }
    }
  }
  hasListeners(type: string) {
    return (this.map.get(type)?.size ?? 0) > 0;
  }
}

// ----------------------------------------------------------------------------- the server: what is published

export interface Published {
  name: string;
  type: string;
  source?: Source;
  api?: Api;
}

export class MockServer {
  readonly objects = new Map<string, Published>();
  /** every open table handle (the update graph shows their filters and sorts) */
  readonly handles = new Set<MockTable>();
  private fieldListeners = new Set<(c: { created: unknown[]; updated: unknown[]; removed: unknown[] }) => void>();
  constructor(readonly engine: Engine) {}

  publishTable(name: string, source: Source) {
    const existed = this.objects.has(name);
    if (!source.variables.includes(name)) source.variables.push(name);
    this.objects.set(name, { name, type: 'Table', source });
    this.fields(existed ? 'updated' : 'created', name, 'Table');
  }

  publishApi(name: string, api: Api) {
    this.objects.set(name, { name, type: 'acme.Api', api });
    this.fields('created', name, 'acme.Api');
  }

  unpublish(name: string) {
    const o = this.objects.get(name);
    if (!o) return;
    this.objects.delete(name);
    if (o.source) o.source.variables.splice(o.source.variables.indexOf(name), 1);
    this.fields('removed', name, o.type);
  }

  tableSource(name: string): Source | undefined {
    return this.objects.get(name)?.source;
  }

  private fields(kind: 'created' | 'updated' | 'removed', name: string, type: string) {
    const d = { id: name, title: name, name, type };
    const change = { created: kind === 'created' ? [d] : [], updated: kind === 'updated' ? [d] : [], removed: kind === 'removed' ? [d] : [] };
    for (const l of [...this.fieldListeners]) setTimeout(() => l(change), 0);
  }

  onFields(cb: (c: { created: unknown[]; updated: unknown[]; removed: unknown[] }) => void): () => void {
    this.fieldListeners.add(cb);
    const created = [...this.objects.values()].map(o => ({ id: o.name, title: o.name, name: o.name, type: o.type }));
    setTimeout(() => this.fieldListeners.has(cb) && cb({ created, updated: [], removed: [] }), 0);
    return () => void this.fieldListeners.delete(cb);
  }

  fetch(type: string, name: string): Promise<unknown> {
    const o = this.objects.get(name);
    if (!o) return Promise.reject(new Error(`no object named ${name}`));
    if (type === 'Table') {
      if (o.type !== 'Table' || !o.source) return Promise.reject(new Error(`${name} is a ${o.type}, not a table`));
      return delay(new MockTable(this, o.source));
    }
    if (type === o.type && o.api) return delay(new MockWidget(this, o.api));
    return Promise.reject(new Error(`${name} is a ${o.type}, not a ${type}`));
  }
}

// a resolved promise a little later, like a round trip
const delay = <T,>(v: T, ms = 1) => new Promise<T>(r => setTimeout(() => r(v), ms));

// ----------------------------------------------------------------------------- filters and sorts

type Getter = (col: string) => unknown;

export class FilterCondition {
  constructor(readonly test: (get: Getter) => boolean) {}
  not() {
    return new FilterCondition(g => !this.test(g));
  }
  and(...others: FilterCondition[]) {
    return new FilterCondition(g => this.test(g) && others.every(o => o.test(g)));
  }
  or(...others: FilterCondition[]) {
    return new FilterCondition(g => this.test(g) || others.some(o => o.test(g)));
  }
  toString() {
    return 'FilterCondition';
  }
}

export class FilterValue {
  constructor(readonly v: unknown) {}
  static ofString(s: unknown) {
    return new FilterValue(String(s));
  }
  static ofNumber(n: unknown) {
    // a DateWrapper (nanoseconds) or a plain number
    const x = n != null && typeof n === 'object' && 'asNumber' in (n as object) ? (n as { asNumber(): number }).asNumber() : Number(n);
    return new FilterValue(x);
  }
  static ofBoolean(b: unknown) {
    return new FilterValue(!!b);
  }
}

const cellNum = (v: unknown) => (v instanceof Instant ? v.ms : typeof v === 'number' ? v : v == null ? NaN : Number(v));

function compare(cell: unknown, want: unknown, colType: string): number {
  if (colType === 'java.time.Instant') {
    const w = typeof want === 'number' ? want / 1e6 : cellNum(want); // ns from ofNumber
    return cellNum(cell) - w;
  }
  if (typeof want === 'number') return cellNum(cell) - want;
  if (typeof want === 'boolean') return Number(cell === true) - Number(want);
  const a = cell == null ? '' : String(cell);
  const b = String(want);
  return a < b ? -1 : a > b ? 1 : 0;
}

class ColumnFilter {
  constructor(
    private col: string,
    private type: string,
  ) {}
  private c(op: (d: number) => boolean, fv: FilterValue) {
    return new FilterCondition(g => {
      const v = g(this.col);
      if (v == null) return false;
      return op(compare(v, fv.v, this.type));
    });
  }
  eq(fv: FilterValue) {
    return this.c(d => d === 0, fv);
  }
  notEq(fv: FilterValue) {
    return new FilterCondition(g => g(this.col) == null || compare(g(this.col), fv.v, this.type) !== 0);
  }
  greaterThan(fv: FilterValue) {
    return this.c(d => d > 0, fv);
  }
  greaterThanOrEqualTo(fv: FilterValue) {
    return this.c(d => d >= 0, fv);
  }
  lessThan(fv: FilterValue) {
    return this.c(d => d < 0, fv);
  }
  lessThanOrEqualTo(fv: FilterValue) {
    return this.c(d => d <= 0, fv);
  }
  eqIgnoreCase(fv: FilterValue) {
    return new FilterCondition(g => String(g(this.col) ?? '').toLowerCase() === String(fv.v).toLowerCase());
  }
  containsIgnoreCase(fv: FilterValue) {
    return new FilterCondition(g => String(g(this.col) ?? '').toLowerCase().includes(String(fv.v).toLowerCase()));
  }
  contains(fv: FilterValue) {
    return new FilterCondition(g => String(g(this.col) ?? '').includes(String(fv.v)));
  }
  in(values: FilterValue[]) {
    return new FilterCondition(g => values.some(fv => g(this.col) != null && compare(g(this.col), fv.v, this.type) === 0));
  }
  isNull() {
    return new FilterCondition(g => g(this.col) == null);
  }
  isTrue() {
    return new FilterCondition(g => g(this.col) === true);
  }
  isFalse() {
    return new FilterCondition(g => g(this.col) === false);
  }
}

export class Sort {
  constructor(
    readonly column: MockColumn,
    readonly direction: 'ASC' | 'DESC' = 'ASC',
    readonly isAbs = false,
  ) {}
  asc() {
    return new Sort(this.column, 'ASC', this.isAbs);
  }
  desc() {
    return new Sort(this.column, 'DESC', this.isAbs);
  }
  abs() {
    return new Sort(this.column, this.direction, true);
  }
}

export class MockColumn {
  constructor(
    readonly name: string,
    readonly type: string,
    readonly description: string | null,
    readonly index: number,
  ) {}
  sort() {
    return new Sort(this);
  }
  filter() {
    return new ColumnFilter(this.name, this.type);
  }
  get isPartitionColumn() {
    return false;
  }
}

// ----------------------------------------------------------------------------- range sets

class KeySet {
  constructor(private ks: ArrayLike<number>) {}
  get size() {
    return this.ks.length;
  }
  iterator() {
    let i = 0;
    const ks = this.ks;
    return { hasNext: () => i < ks.length, next: () => ({ value: ks[i++], done: false }) };
  }
}

// ----------------------------------------------------------------------------- tables

interface Pending {
  added: Set<number>;
  modified: Set<number>;
  removed: Set<number>;
}

export class MockTable extends Events {
  static EVENT_UPDATED = 'updated';
  static EVENT_SIZECHANGED = 'sizechanged';
  static EVENT_FILTERCHANGED = 'filterchanged';
  static EVENT_SORTCHANGED = 'sortchanged';
  static EVENT_DISCONNECT = 'disconnect';
  static EVENT_RECONNECT = 'reconnect';
  static SIZE_UNCOALESCED = -2;

  readonly columns: MockColumn[];
  private filters: FilterCondition[] = [];
  private sorts: Sort[] = [];
  private viewCache: ArrayLike<number> | null = null;
  private member: Set<number> | null = null;
  private subs = new Set<FullSub | ViewportSub>();
  private viewListeners = new Set<() => void>();
  private off: () => void;
  private flusher: (now: number) => void;
  private lastSize = -1;
  private closedFlag = false;

  constructor(
    readonly server: MockServer,
    readonly source: Source,
    filters: FilterCondition[] = [],
    sorts: Sort[] = [],
  ) {
    super();
    this.columns = source.columns.map((c, i) => new MockColumn(c.name, c.type, c.description ?? null, i));
    this.filters = filters;
    this.sorts = sorts.map(s => new Sort(this.findColumn(s.column.name), s.direction, s.isAbs));
    this.rebuildMembers();
    this.off = source.on(c => this.onSource(c));
    this.flusher = now => this.flush(now);
    server.engine.flushers.add(this.flusher);
    this.lastSize = this.size;
    server.handles.add(this);
  }

  get size() {
    return this.view().length;
  }
  get totalSize() {
    return this.source.size;
  }
  get isClosed() {
    return this.closedFlag;
  }
  get hasInputTable() {
    return this.source instanceof RowSource && this.source.input;
  }
  get description() {
    return this.source.description;
  }
  get filter() {
    return [...this.filters];
  }
  get sort() {
    return [...this.sorts];
  }
  get customColumns() {
    return [];
  }

  findColumn(name: string): MockColumn {
    const c = this.columns.find(x => x.name === name);
    if (!c) throw new Error(`no column ${name} in ${this.source.variables[0] ?? this.source.label}`);
    return c;
  }
  findColumns(names: string[]) {
    return names.map(n => this.findColumn(n));
  }

  private getter(key: number): Getter {
    return col => this.source.get(key, col);
  }

  private passes(key: number) {
    if (!this.filters.length) return true;
    const g = this.getter(key);
    return this.filters.every(f => f.test(g));
  }

  private rebuildMembers() {
    this.viewCache = null;
    if (!this.filters.length) {
      this.member = null;
      return;
    }
    const keys = this.source.keys();
    const m = new Set<number>();
    for (let i = 0; i < keys.length; i++) if (this.passes(keys[i])) m.add(keys[i]);
    this.member = m;
  }

  /** the handle's row keys, in order (filtered, sorted) */
  view(): ArrayLike<number> {
    if (this.viewCache) return this.viewCache;
    const all = this.source.keys();
    let ks: ArrayLike<number> = all;
    if (this.member) {
      const out: number[] = [];
      for (let i = 0; i < all.length; i++) if (this.member.has(all[i])) out.push(all[i]);
      ks = out;
    }
    if (this.sorts.length) {
      const arr = Array.from(ks);
      const specs = this.sorts.map(s => ({ col: s.column.name, type: s.column.type, dir: s.direction === 'DESC' ? -1 : 1, abs: s.isAbs }));
      const val = (k: number, sp: (typeof specs)[number]) => {
        const v = this.source.get(k, sp.col);
        if (v == null) return null;
        if (v instanceof Instant) return v.ms;
        if (typeof v === 'number') return sp.abs ? Math.abs(v) : v;
        if (typeof v === 'boolean') return v ? 1 : 0;
        return String(v);
      };
      arr.sort((a, b) => {
        for (const sp of specs) {
          const x = val(a, sp);
          const y = val(b, sp);
          if (x === y) continue;
          if (x == null) return -sp.dir; // nulls first, ascending
          if (y == null) return sp.dir;
          const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x) < String(y) ? -1 : 1;
          if (d) return d * sp.dir;
        }
        return a - b;
      });
      ks = arr;
    }
    this.viewCache = ks;
    return ks;
  }

  private onSource(c: Change) {
    let added: number[], modified: number[], removed: number[];
    if (!this.member) {
      ({ added, modified, removed } = c);
    } else {
      added = [];
      modified = [];
      removed = [];
      const m = this.member;
      for (const k of c.removed)
        if (m.delete(k)) removed.push(k);
      for (const k of c.added)
        if (this.passes(k)) {
          m.add(k);
          added.push(k);
        }
      for (const k of c.modified) {
        const was = m.has(k);
        const now = this.passes(k);
        if (was && now) modified.push(k);
        else if (was) {
          m.delete(k);
          removed.push(k);
        } else if (now) {
          m.add(k);
          added.push(k);
        }
      }
    }
    if (!added.length && !modified.length && !removed.length) return;
    if (added.length || removed.length || this.sorts.length) this.viewCache = null;
    for (const s of this.subs) s.changed(added, modified, removed);
    for (const l of this.viewListeners) l();
  }

  /** for derived tables (selectDistinct): called after every change to this handle's rows */
  onView(fn: () => void): () => void {
    this.viewListeners.add(fn);
    return () => void this.viewListeners.delete(fn);
  }

  private flush(now: number) {
    for (const s of this.subs) s.flush(now);
    const size = this.size;
    if (size !== this.lastSize) {
      this.lastSize = size;
      this.fire(MockTable.EVENT_SIZECHANGED, size);
    }
  }

  private reset(fireEvent: string) {
    const before = Array.from(this.view());
    this.rebuildMembers();
    const after = Array.from(this.view());
    for (const s of this.subs) s.reset(before, after);
    for (const l of this.viewListeners) l();
    this.fire(fireEvent);
  }

  applyFilter(filters: FilterCondition[]) {
    const prev = this.filters;
    this.filters = [...filters];
    this.reset(MockTable.EVENT_FILTERCHANGED);
    return prev;
  }

  applySort(sorts: Sort[]) {
    const prev = this.sorts;
    this.sorts = sorts.map(s => new Sort(this.findColumn(s.column.name), s.direction, s.isAbs));
    this.reset(MockTable.EVENT_SORTCHANGED);
    return prev;
  }

  applyCustomColumns() {
    throw new Error('custom columns are not supported by the mock server');
  }

  copy(): Promise<MockTable> {
    return delay(new MockTable(this.server, this.source, [...this.filters], [...this.sorts]));
  }

  selectDistinct(cols: MockColumn[]): Promise<MockTable> {
    const names = cols.map(c => c.name);
    const src = new RowSource(
      this.server.engine,
      `selectDistinct(${names.join(', ')})`,
      names.map(n => this.source.columns.find(c => c.name === n) as ColumnDef),
      { keyCols: names, kind: 'op' },
    );
    src.parents = [this.source];
    const follow = new MockTable(this.server, this.source, [...this.filters], []);
    const recompute = () => {
      const seen = new Map<string, Record<string, unknown>>();
      const ks = follow.view();
      for (let i = 0; i < ks.length; i++) {
        const row: Record<string, unknown> = {};
        for (const n of names) row[n] = this.source.get(ks[i], n);
        const key = names.map(n => String(row[n] ?? '')).join('\u0000');
        if (!seen.has(key)) seen.set(key, row);
      }
      const have = new Set(src.all().map(r => names.map(n => String(r[n] ?? '')).join('\u0000')));
      const fresh = [...seen.entries()].filter(([k]) => !have.has(k)).map(([, r]) => r);
      if (fresh.length) src.put(fresh);
      const gone = src
        .keys()
        .filter(k => !seen.has(names.map(n => String(src.get(k, n) ?? '')).join('\u0000')));
      if (gone.length) src.remove(gone);
    };
    recompute();
    const offView = follow.onView(recompute);
    const out = new MockTable(this.server, src);
    const close = out.close.bind(out);
    out.close = () => {
      offView();
      follow.close();
      close();
      src.close();
    };
    return delay(out);
  }

  inputTable(): Promise<{ addRow(row: Record<string, unknown>): Promise<void>; addRows(rows: Record<string, unknown>[]): Promise<void>; table: MockTable }> {
    const s = this.source;
    if (!(s instanceof RowSource) || !s.input) return Promise.reject(new Error(`${s.variables[0] ?? s.label} is not an input table`));
    return delay({
      table: this,
      addRow: async (row: Record<string, unknown>) => s.clientWrite([row]),
      addRows: async (rows: Record<string, unknown>[]) => s.clientWrite(rows),
    });
  }

  subscribe(columns?: MockColumn[]) {
    const sub = new FullSub(this, columns ?? this.columns);
    this.subs.add(sub);
    return sub;
  }

  setViewport(first: number, last: number, columns?: MockColumn[] | null, updateIntervalMs?: number) {
    const sub = new ViewportSub(this, first, last, columns ?? this.columns, updateIntervalMs ?? 250);
    this.subs.add(sub);
    return sub;
  }

  /** a one-off snapshot of rows (like getViewportData after setViewport) */
  getViewportData() {
    const ks = this.view();
    return Promise.resolve({ offset: 0, columns: this.columns, rows: Array.from(ks).map(k => rowOf(this.source, k)) });
  }

  dropSub(s: FullSub | ViewportSub) {
    this.subs.delete(s);
  }

  close() {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.server.handles.delete(this);
    this.off();
    this.server.engine.flushers.delete(this.flusher);
    for (const s of this.subs) s.close();
    this.subs.clear();
    this.viewListeners.clear();
  }
}

const rowOf = (source: Source, k: number) => ({ get: (c: MockColumn | string) => source.get(k, typeof c === 'string' ? c : c.name) });

/** table.subscribe(columns): every row, then added / modified / removed keys on each change */
class FullSub extends Events {
  private pending: Pending = { added: new Set(), modified: new Set(), removed: new Set() };
  private first = true;
  private dirty = true;
  private closed = false;

  constructor(
    private table: MockTable,
    readonly columns: MockColumn[],
  ) {
    super();
    setTimeout(() => this.send(), 0);
  }

  changed(added: number[], modified: number[], removed: number[]) {
    const p = this.pending;
    for (const k of removed) {
      p.added.delete(k);
      p.modified.delete(k);
      p.removed.add(k);
    }
    for (const k of added) p.added.add(k);
    for (const k of modified) if (!p.added.has(k)) p.modified.add(k);
    this.dirty = true;
  }

  reset(before: number[], after: number[]) {
    this.changed(after, [], before);
  }

  flush() {
    if (this.dirty) this.send();
  }

  private send() {
    if (this.closed || !this.dirty) return;
    this.dirty = false;
    const t = this.table;
    const p = this.pending;
    this.pending = { added: new Set(), modified: new Set(), removed: new Set() };
    const full = t.view();
    let added: ArrayLike<number> = [...p.added];
    if (this.first) {
      this.first = false;
      added = full;
      p.removed.clear();
      p.modified.clear();
    }
    const detail = {
      fullIndex: new KeySet(full),
      added: new KeySet(added),
      modified: new KeySet([...p.modified]),
      removed: new KeySet([...p.removed]),
      rows: [] as unknown[],
      columns: this.columns,
      getData: (k: number, c: MockColumn | string) => t.source.get(k, typeof c === 'string' ? c : c.name),
      get: (k: number) => rowOf(t.source, k),
    };
    this.fire(MockTable.EVENT_UPDATED, detail);
  }

  close() {
    this.closed = true;
    this.table.dropSub(this);
  }
}

/** table.setViewport(first, last): the rows in view, re-sent when anything in the table changes */
class ViewportSub extends Events {
  private dirty = true;
  private lastSent = 0;
  private closed = false;

  constructor(
    private table: MockTable,
    private first: number,
    private last: number,
    private columns: MockColumn[],
    private interval: number,
  ) {
    super();
    setTimeout(() => this.send(), 0);
  }

  setViewport(first: number, last: number, columns?: MockColumn[] | null, updateIntervalMs?: number) {
    this.first = first;
    this.last = last;
    if (columns) this.columns = columns;
    if (updateIntervalMs) this.interval = updateIntervalMs;
    this.dirty = true;
    setTimeout(() => this.send(), 0);
  }

  changed() {
    this.dirty = true;
  }

  reset() {
    this.dirty = true;
  }

  flush(now: number) {
    if (this.dirty && now - this.lastSent >= this.interval - 20) this.send();
  }

  private send() {
    if (this.closed || !this.dirty) return;
    this.dirty = false;
    this.lastSent = Date.now();
    const ks = this.table.view();
    const rows: ReturnType<typeof rowOf>[] = [];
    const end = Math.min(ks.length - 1, this.last);
    for (let i = this.first; i <= end; i++) rows.push(rowOf(this.table.source, ks[i]));
    this.fire(MockTable.EVENT_UPDATED, { offset: this.first, rows, columns: this.columns });
  }

  getViewportData() {
    const ks = this.table.view();
    const rows: ReturnType<typeof rowOf>[] = [];
    for (let i = this.first; i <= Math.min(ks.length - 1, this.last); i++) rows.push(rowOf(this.table.source, ks[i]));
    return Promise.resolve({ offset: this.first, rows, columns: this.columns });
  }

  close() {
    this.closed = true;
    this.table.dropSub(this);
  }
}

// ----------------------------------------------------------------------------- widgets (request APIs)

export class MockWidget extends Events {
  static EVENT_MESSAGE = 'message';
  static EVENT_CLOSE = 'close';
  private stream: Stream;
  private ready: string;
  readonly type: string;
  readonly exportedObjects: unknown[] = [];

  constructor(
    private server: MockServer,
    api: Api,
  ) {
    super();
    this.type = 'acme.Api';
    this.ready = JSON.stringify({ event: 'ready', version: 1, lease_s: 90, methods: [...api.methods.keys()] });
    this.stream = api.openStream((json, tables) => {
      const refs = tables.map(source => ({
        type: 'Table',
        fetch: () => delay(new MockTable(this.server, source)),
        close: () => {},
      }));
      setTimeout(() => this.fire(MockWidget.EVENT_MESSAGE, { getDataAsString: () => json, getDataAsBase64: () => btoa(json), exportedObjects: refs }), 1);
    });
  }

  getDataAsString() {
    return this.ready;
  }

  sendMessage(text: string, _refs?: unknown[]) {
    this.stream.receive(text);
  }

  close() {
    this.stream.close();
    this.fire(MockWidget.EVENT_CLOSE);
  }
}

// ----------------------------------------------------------------------------- the client and the connection

class IdeConnection extends Events {
  static EVENT_DISCONNECT = 'disconnect';
  static EVENT_RECONNECT = 'reconnect';
  static EVENT_SHUTDOWN = 'shutdown';
  constructor(private server: MockServer) {
    super();
  }
  getObject(d: { type: string; name: string }) {
    return this.server.fetch(d.type, d.name);
  }
  getTable(name: string) {
    return this.server.fetch('Table', name);
  }
  subscribeToFieldUpdates(cb: (c: { created: unknown[]; updated: unknown[]; removed: unknown[] }) => void) {
    return this.server.onFields(cb);
  }
  close() {}
}

/** The mock `dh` namespace: pass it to connect({ dh }) (it stands in for the JS API module, so it is untyped here). */
export function createMockDh(server: MockServer): Record<string, unknown> {
  class CoreClient extends Events {
    static EVENT_CONNECT = 'connect';
    static EVENT_DISCONNECT = 'disconnect';
    static EVENT_RECONNECT = 'reconnect';
    static EVENT_RECONNECT_AUTH_FAILED = 'reconnectauthfailed';
    static EVENT_REQUEST_FAILED = 'requestfailed';
    static LOGIN_TYPE_ANONYMOUS = 'anonymous';
    static LOGIN_TYPE_PASSWORD = 'password';
    constructor(readonly serverUrl: string) {
      super();
    }
    login() {
      return delay(undefined, 5);
    }
    getAsIdeConnection() {
      return delay(new IdeConnection(server), 5);
    }
    getServerConfigValues() {
      return Promise.resolve([['mock', 'true']]);
    }
    disconnect() {}
  }

  return {
    CoreClient,
    IdeConnection,
    Table: MockTable,
    Widget: MockWidget,
    FilterValue,
    FilterCondition,
    Sort,
    VariableType: {
      TABLE: 'Table',
      TREETABLE: 'TreeTable',
      HIERARCHICALTABLE: 'HierarchicalTable',
      PARTITIONEDTABLE: 'PartitionedTable',
      FIGURE: 'Figure',
      OTHERWIDGET: 'OtherWidget',
    },
    DateWrapper: {
      ofJsDate: (d: Date) => ({ asNumber: () => d.getTime() * 1e6, asDate: () => d, valueOf: () => d.getTime() }),
    },
    LongWrapper: { ofString: (s: string) => ({ asNumber: () => Number(s), valueOf: () => Number(s) }) },
    mock: true,
  };
}
