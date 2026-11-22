/**
 * A grid over any Deephaven table: only the rows in view come from the server (TableViewport), so a table of
 * millions of rows scrolls like a small one. Sorting (click a header; shift-click adds a column) and quick
 * filters (the row under the headers: `>5`, `=ES`, `!null`, or text to match) run on the server, on this
 * grid's own handle. Columns resize by dragging their right edge.
 *
 *   <DataGrid table={t} onRowClick={row => ...} highlight={row => row.Sym === symbol} />
 *
 * Scrolling is by whole rows: the rows layer stays in view and the scroll position picks the first row, so a
 * table taller than a browser can scroll (about 15 million pixels) still reaches its last row.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { dh as Dh } from '@deephaven/jsapi-types';
import { TableViewport, columnsOf, type ColumnInfo, type Row, type SortSpec, type ViewportSnapshot } from '@acme/dh-bindings';
import { useDeephaven } from '../deephaven';

const ROW_H = 22;
const HEAD_H = 26;
const FILTER_H = 24;
const MAX_SPACER = 10_000_000; // px; browsers cap element height (Chrome ~33M, Firefox ~17M)
const OVERSCAN = 30;

export interface GridState {
  sorts: SortSpec[];
  filters: Record<string, string>;
  widths: Record<string, number>;
}

export interface DataGridProps {
  /** a handle of the grid's own (useOwnTable): the grid sorts and filters it */
  table: Dh.Table;
  initial?: Partial<GridState>;
  onStateChange?: (state: GridState) => void;
  onRowClick?: (row: Row, index: number) => void;
  /** rows to mark (e.g. the linked symbol's) */
  highlight?: (row: Row) => boolean;
  /** only these columns, in this order (default: all) */
  columns?: string[];
  /** cell text (default: formatCell) */
  format?: (value: unknown, column: ColumnInfo) => string;
}

export function DataGrid({ table, initial, onStateChange, onRowClick, highlight, columns: only, format = formatCell }: DataGridProps) {
  const { dh } = useDeephaven();
  const [snap, setSnap] = useState<ViewportSnapshot>({ offset: 0, rows: [], size: table.size, columns: [] });
  const [sorts, setSorts] = useState<SortSpec[]>(initial?.sorts ?? []);
  const [filters, setFilters] = useState<Record<string, string>>(initial?.filters ?? {});
  const [widths, setWidths] = useState<Record<string, number>>(initial?.widths ?? {});
  const [filterError, setFilterError] = useState<string | null>(null);
  const [first, setFirst] = useState(0);
  const [height, setHeight] = useState(400);
  const scroller = useRef<HTMLDivElement>(null);
  // made in an effect, not a memo: StrictMode's trial unmount would close a memoized one for good
  const [view, setView] = useState<TableViewport | null>(null);
  useEffect(() => {
    const v = new TableViewport(dh, table, setSnap);
    setView(v);
    return () => v.close();
  }, [dh, table]);
  const tableColumns = useMemo(() => columnsOf(table), [table]);

  const all = snap.columns.length ? snap.columns : tableColumns;
  const cols = only ? only.map(n => all.find(c => c.name === n)).filter((c): c is ColumnInfo => !!c) : all;
  const widthOf = (c: ColumnInfo) => widths[c.name] ?? (c.numeric ? 96 : 120);
  const totalWidth = cols.reduce((w, c) => w + widthOf(c), 0);
  const visible = Math.max(1, Math.ceil((height - HEAD_H - FILTER_H) / ROW_H));
  const size = snap.size;
  const spacer = Math.min(size * ROW_H, MAX_SPACER);
  const scaled = size * ROW_H > MAX_SPACER;

  // the server's window: what's in view plus some rows either side
  useEffect(() => {
    view?.setRange(Math.max(0, first - OVERSCAN), first + visible + OVERSCAN);
  }, [view, first, visible]);
  useEffect(() => {
    if (only) view?.setColumns(only);
  }, [view, only?.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    view?.sort(sorts);
  }, [view, sorts]);
  useEffect(() => {
    if (!view) return undefined;
    const t = setTimeout(() => {
      try {
        view.filter(filters);
        setFilterError(null);
      } catch (e) {
        setFilterError((e as Error).message);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [view, filters]);

  const report = useRef(onStateChange);
  report.current = onStateChange;
  useEffect(() => {
    report.current?.({ sorts, filters, widths });
  }, [sorts, filters, widths]);

  useLayoutEffect(() => {
    const el = scroller.current!;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    const el = scroller.current!;
    const max = Math.max(1, el.scrollHeight - el.clientHeight);
    const lastFirst = Math.max(0, size - visible);
    setFirst(Math.min(lastFirst, scaled ? Math.round((el.scrollTop / max) * lastFirst) : Math.floor(el.scrollTop / ROW_H)));
  }, [size, visible, scaled]);

  // the table shrank under the scroll position (a filter): back into range
  useEffect(() => {
    if (first > Math.max(0, size - visible)) onScroll();
  }, [size, first, visible, onScroll]);

  const clickHeader = (e: MouseEvent, name: string) => {
    setSorts(prev => {
      const i = prev.findIndex(s => s.column === name);
      const cur = i >= 0 ? prev[i] : null;
      const next: SortSpec | null = cur == null ? { column: name, direction: 'asc' } : cur.direction === 'asc' ? { ...cur, direction: 'desc' } : null;
      if (!e.shiftKey) return next ? [next] : [];
      const rest = prev.filter(s => s.column !== name);
      return next ? (i >= 0 ? prev.map(s => (s.column === name ? next : s)) : [...rest, next]) : rest;
    });
  };

  const startResize = (e: MouseEvent, c: ColumnInfo) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = widthOf(c);
    const move = (ev: globalThis.MouseEvent) => setWidths(w => ({ ...w, [c.name]: Math.max(40, w0 + ev.clientX - x0) }));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const rows: Array<{ index: number; row: Row | undefined }> = [];
  for (let i = first; i < Math.min(size, first + visible); i++) rows.push({ index: i, row: snap.rows[i - snap.offset] });

  const cell = (c: ColumnInfo): { width: number; textAlign: 'left' | 'right' } => ({ width: widthOf(c), textAlign: c.numeric ? 'right' : 'left' });

  return (
    <div className="acme-grid">
      <div ref={scroller} className="acme-grid-scroll" onScroll={onScroll}>
        <div style={{ height: HEAD_H + FILTER_H + spacer, width: totalWidth, position: 'relative' }}>
          <div className="acme-grid-head" style={{ width: totalWidth }}>
            <div className="acme-grid-row acme-grid-titles" style={{ height: HEAD_H }}>
              {cols.map(c => {
                const s = sorts.findIndex(x => x.column === c.name);
                return (
                  <div key={c.name} className="acme-grid-cell" style={cell(c)} onClick={e => clickHeader(e, c.name)} title={`${c.name}: ${c.type}${c.description ? `\n${c.description}` : ''}`}>
                    {c.name}
                    {s >= 0 && (
                      <span className="acme-grid-sort">
                        {sorts[s].direction === 'asc' ? '▲' : '▼'}
                        {sorts.length > 1 ? s + 1 : ''}
                      </span>
                    )}
                    <span className="acme-grid-resize" onMouseDown={e => startResize(e, c)} onClick={e => e.stopPropagation()} />
                  </div>
                );
              })}
            </div>
            <div className="acme-grid-row acme-grid-filters" style={{ height: FILTER_H }}>
              {cols.map(c => (
                <div key={c.name} className="acme-grid-cell" style={{ width: widthOf(c) }}>
                  <input
                    value={filters[c.name] ?? ''}
                    placeholder={c.numeric ? '>0' : 'filter'}
                    onChange={e => setFilters(f => ({ ...f, [c.name]: e.target.value }))}
                    spellCheck={false}
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="acme-grid-body" style={{ top: HEAD_H + FILTER_H, height: Math.min(visible, size) * ROW_H }}>
            {rows.map(({ index, row }) => (
              <div
                key={index}
                className={`acme-grid-row${row && highlight?.(row) ? ' acme-grid-hl' : ''}${index % 2 ? ' acme-grid-odd' : ''}`}
                style={{ height: ROW_H }}
                onClick={row && onRowClick ? () => onRowClick(row, index) : undefined}
              >
                {cols.map(c => (
                  <div key={c.name} className="acme-grid-cell" style={cell(c)}>
                    {row ? format(row[c.name], c) : ''}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="acme-grid-foot">
        {size.toLocaleString()} rows
        {sorts.length > 0 && <button onClick={() => setSorts([])}>clear sort</button>}
        {Object.values(filters).some(Boolean) && <button onClick={() => setFilters({})}>clear filters</button>}
        {filterError && <span className="acme-grid-err">{filterError}</span>}
      </div>
    </div>
  );
}

const num = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
const int = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const INTS = new Set(['byte', 'short', 'int', 'long', 'java.lang.Integer', 'java.lang.Long', 'java.lang.Short', 'java.lang.Byte', 'java.math.BigInteger']);

/** Default cell text: numbers grouped (integers without decimals), times as local date-time, null as blank. */
export function formatCell(v: unknown, c: ColumnInfo): string {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isNaN(v) ? '' : Number.isFinite(v) ? (INTS.has(c.type) ? int : num).format(v) : String(v);
  if (v instanceof Date) return formatTime(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
function formatTime(d: Date): string {
  const today = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  return d.toDateString() === today.toDateString() ? time : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}
