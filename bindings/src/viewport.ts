/**
 * A window onto a (possibly large, ticking) table, for grids: the server sends only the rows in the viewport,
 * plus the table's size, and pushes changes to them. Sorting and filtering run on the server, on this handle
 * only (open it with session.openTable so other consumers are unaffected).
 *
 *   const view = new TableViewport(dh, table, snap => render(snap));
 *   view.setRange(0, 49);                      // rows 0..49; call again as the grid scrolls
 *   view.sort([{ column: 'Mv', direction: 'desc' }]);
 *   view.filter({ Desk: 'tech', Qty: '>100' }); // quick filters, as typed in a grid's filter row
 *   view.close();
 */
import type { dh as Dh } from '@deephaven/jsapi-types';
import { safeClose, toPlain, type DhApi } from './connection';
import type { Row } from './table-rows';

export interface ColumnInfo {
  name: string;
  /** the Java type, e.g. java.lang.String, double, java.time.Instant */
  type: string;
  description: string | null;
  /** a number type: right-aligned, numeric filters */
  numeric: boolean;
}

export interface ViewportSnapshot {
  /** the position of rows[0] in the table */
  offset: number;
  rows: Row[];
  /** the table's row count (after filters) */
  size: number;
  columns: ColumnInfo[];
}

export type SortSpec = { column: string; direction: 'asc' | 'desc'; abs?: boolean };

const NUMERIC = new Set(['byte', 'short', 'int', 'long', 'float', 'double', 'char', 'java.lang.Byte', 'java.lang.Short',
  'java.lang.Integer', 'java.lang.Long', 'java.lang.Float', 'java.lang.Double', 'java.math.BigDecimal', 'java.math.BigInteger']);
const TIME = new Set(['java.time.Instant', 'java.time.ZonedDateTime', 'io.deephaven.time.DateTime', 'java.time.LocalDateTime']);

export function columnsOf(table: Dh.Table): ColumnInfo[] {
  return table.columns.map(c => ({ name: c.name, type: c.type, description: c.description ?? null, numeric: NUMERIC.has(c.type) }));
}

export class TableViewport {
  private sub: Dh.TableViewportSubscription | null = null;
  private range: [number, number] = [0, -1];
  private visible: string[] | null = null;
  private columns: ColumnInfo[];
  private last: ViewportSnapshot;
  private removeSize: () => void;
  private closed = false;
  private sorted = '[]';
  private filtered = '[]';

  constructor(
    private readonly dh: DhApi,
    readonly table: Dh.Table,
    private readonly onData: (snapshot: ViewportSnapshot) => void,
    private readonly updateIntervalMs = 250,
  ) {
    this.columns = columnsOf(table);
    this.last = { offset: 0, rows: [], size: table.size, columns: this.columns };
    // a size change with no row in view changing (rows added past the viewport) still updates the scrollbar
    this.removeSize = table.addEventListener(dh.Table.EVENT_SIZECHANGED, () => this.emit({ ...this.last, size: table.size }));
  }

  /** the latest snapshot */
  get snapshot(): ViewportSnapshot {
    return this.last;
  }

  /** Show rows first..last (inclusive; positions after sort and filter). */
  setRange(first: number, last: number) {
    first = Math.max(0, Math.floor(first));
    last = Math.max(first, Math.floor(last));
    if (this.sub && first === this.range[0] && last === this.range[1]) return;
    this.range = [first, last];
    this.subscribe();
  }

  /** Only these columns (null: all). */
  setColumns(names: string[] | null) {
    this.visible = names;
    if (this.sub) this.subscribe();
  }

  /** Sort on the server (an unchanged sort is not sent again). */
  sort(specs: SortSpec[]) {
    const sig = JSON.stringify(specs);
    if (sig === this.sorted) return;
    this.sorted = sig;
    this.table.applySort(
      specs.map(s => {
        let sort = this.table.findColumn(s.column).sort();
        if (s.abs) sort = sort.abs();
        return s.direction === 'desc' ? sort.desc() : sort.asc();
      }),
    );
    this.resubscribe();
  }

  /** Quick filters by column (empty strings are ignored); see parseQuickFilter. Throws on a bad filter. */
  filter(quick: Record<string, string>) {
    const conds: Dh.FilterCondition[] = [];
    for (const [name, text] of Object.entries(quick)) {
      const info = this.columns.find(c => c.name === name);
      if (!info || !text.trim()) continue;
      conds.push(quickFilter(this.dh, this.table.findColumn(name), info, text));
    }
    const sig = JSON.stringify(Object.entries(quick).filter(([, t]) => t.trim()).sort());
    if (sig === this.filtered) return;
    this.filtered = sig;
    this.table.applyFilter(conds);
    this.resubscribe();
  }

  // applySort and applyFilter give the handle a new server table: a viewport subscription made before stays on
  // the old one (it keeps updating, unsorted and unfiltered; seen with the 42.6 JS API), so make a new one
  private resubscribe() {
    safeClose(this.sub);
    this.sub = null;
    this.subscribe();
  }

  private subscribe() {
    if (this.closed) return;
    const [first, last] = this.range;
    if (last < first) return;
    const columns = this.visible ? this.visible.map(n => this.table.findColumn(n)) : this.table.columns;
    if (this.sub) {
      this.sub.setViewport(first, last, columns, this.updateIntervalMs);
      return;
    }
    const t = this.table as Dh.Table & { createViewportSubscription?: Dh.Table['createViewportSubscription'] };
    this.sub = t.createViewportSubscription
      ? t.createViewportSubscription({ rows: { first, last }, columns, updateIntervalMs: this.updateIntervalMs } as never)
      : (t.setViewport(first, last, columns, this.updateIntervalMs) as unknown as Dh.TableViewportSubscription);
    this.sub.addEventListener(this.dh.Table.EVENT_UPDATED, ev => {
      const data = (ev as CustomEvent).detail as Dh.ViewportData;
      const cols = data.columns;
      this.emit({
        offset: data.offset,
        rows: data.rows.map(r => Object.fromEntries(cols.map(c => [c.name, toPlain(r.get(c))]))),
        size: this.table.size,
        columns: this.columns,
      });
    });
  }

  private emit(s: ViewportSnapshot) {
    if (this.closed) return;
    this.last = s;
    this.onData(s);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.removeSize();
    safeClose(this.sub);
    this.sub = null;
  }
}

export type QuickFilter =
  | { op: 'eq' | 'notEq' | 'greaterThan' | 'greaterThanOrEqualTo' | 'lessThan' | 'lessThanOrEqualTo'; value: string }
  | { op: 'contains'; value: string }
  | { op: 'isNull' }
  | { op: 'notNull' };

/**
 * A grid's filter-row text: `>5`, `<=2.5`, `=ES`, `!=ES`, `null`, `!null`; otherwise text matches by
 * "contains" (case-insensitive) on text columns and by equality on number columns.
 */
export function parseQuickFilter(text: string, numeric: boolean): QuickFilter {
  const t = text.trim();
  if (/^null$/i.test(t)) return { op: 'isNull' };
  if (/^!null$/i.test(t)) return { op: 'notNull' };
  const m = /^(>=|<=|!=|=|>|<)\s*(.*)$/.exec(t);
  if (m) {
    const op = ({ '>=': 'greaterThanOrEqualTo', '<=': 'lessThanOrEqualTo', '!=': 'notEq', '=': 'eq', '>': 'greaterThan', '<': 'lessThan' } as const)[
      m[1] as '>='
    ];
    return { op, value: m[2] };
  }
  return numeric ? { op: 'eq', value: t } : { op: 'contains', value: t };
}

function quickFilter(dh: DhApi, column: Dh.Column, info: ColumnInfo, text: string): Dh.FilterCondition {
  const q = parseQuickFilter(text, info.numeric);
  const f = column.filter();
  if (q.op === 'isNull') return f.isNull();
  if (q.op === 'notNull') return f.isNull().not();
  if (q.op === 'contains') return f.containsIgnoreCase(dh.FilterValue.ofString(q.value));
  let v: Dh.FilterValue;
  if (info.numeric) {
    const n = Number(q.value);
    if (!Number.isFinite(n)) throw new Error(`${info.name}: not a number: ${q.value}`);
    v = dh.FilterValue.ofNumber(n);
  } else if (TIME.has(info.type)) {
    const ms = Date.parse(q.value);
    if (Number.isNaN(ms)) throw new Error(`${info.name}: not a time: ${q.value}`);
    v = dh.FilterValue.ofNumber(dh.DateWrapper.ofJsDate(new Date(ms)) as never);
  } else if (info.type === 'boolean' || info.type === 'java.lang.Boolean') {
    v = dh.FilterValue.ofBoolean(/^(true|1|yes)$/i.test(q.value));
  } else {
    v = dh.FilterValue.ofString(q.value);
  }
  return f[q.op](v);
}
