/**
 * ChartToolbar: a TradingView-style chart toolbar. Controlled: it shows `value`, offers `options`, and
 * reports changes through `onChange(patch)`; the host owns the state (React state, or Python state in a
 * deephaven.ui workspace via the `acme.chart.Toolbar` element).
 *
 *   symbol ▾ (search) | interval ▾ | chart type ▾ | ƒx Indicators (dialog)  ...  range ▾ | % | log
 *
 * Any part whose options are missing or empty is left out, so a host offers only what it supports.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { icons } from './icons';
import { injectToolbarStyles } from './styles';

export interface ToolbarValue {
  symbol?: string;
  resolution?: string;
  range?: string;
  chartType?: string;
  studies?: string[];
  scale?: string; // "normal" | "log" | "percent"
}

export interface ToolbarItem {
  key: string;
  label: string;
  /** a heading to group items under (intervals: "Ticks", "Seconds", "Minutes"; indicators: categories) */
  group?: string;
  description?: string;
}

export interface ToolbarOptions {
  symbols?: ToolbarItem[];
  resolutions?: ToolbarItem[];
  ranges?: ToolbarItem[];
  chartTypes?: ToolbarItem[];
  studies?: ToolbarItem[];
  /** offer the % and log scale toggles */
  scales?: boolean;
}

export interface ChartToolbarProps {
  value: ToolbarValue;
  options: ToolbarOptions;
  onChange: (patch: ToolbarValue) => void;
  className?: string;
}

const TYPE_ICON: Record<string, ReactNode> = { candle: icons.candle, bar: icons.bar, line: icons.line, area: icons.area };

type Open = 'symbol' | 'interval' | 'type' | 'range' | null;

export function ChartToolbar({ value, options, onChange, className }: ChartToolbarProps) {
  injectToolbarStyles();
  const [open, setOpen] = useState<Open>(null);
  const [studiesOpen, setStudiesOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // close a dropdown on an outside click or Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (patch: ToolbarValue) => {
    setOpen(null);
    onChange(patch);
  };
  const toggle = (o: Open) => setOpen(cur => (cur === o ? null : o));
  const labelOf = (items: ToolbarItem[] | undefined, key: string | undefined) => items?.find(i => i.key === key)?.label ?? key ?? '';

  const parts: ReactNode[] = [];
  const sep = (k: string) => <span key={k} className="acme-tb-sep" />;

  if (options.symbols?.length) {
    parts.push(
      <span key="sym" style={{ position: 'relative' }}>
        <button className="acme-tb-btn" onClick={() => toggle('symbol')} title="Symbol search">
          {icons.search}
          <span className="acme-tb-sym">{value.symbol ?? 'Symbol'}</span>
        </button>
        {open === 'symbol' && <SymbolSearch items={options.symbols} value={value.symbol} onPick={symbol => pick({ symbol })} />}
      </span>,
      sep('s1'),
    );
  }
  if (options.resolutions?.length) {
    parts.push(
      <span key="int" style={{ position: 'relative' }}>
        <button className={`acme-tb-btn${open === 'interval' ? ' on' : ''}`} onClick={() => toggle('interval')} title="Interval">
          {labelOf(options.resolutions, value.resolution)}
          {icons.caret}
        </button>
        {open === 'interval' && (
          <Menu items={options.resolutions} selected={value.resolution} onPick={resolution => pick({ resolution })} />
        )}
      </span>,
    );
  }
  if (options.chartTypes?.length) {
    parts.push(
      <span key="type" style={{ position: 'relative' }}>
        <button className={`acme-tb-btn${open === 'type' ? ' on' : ''}`} onClick={() => toggle('type')} title="Chart type">
          {TYPE_ICON[value.chartType ?? ''] ?? labelOf(options.chartTypes, value.chartType)}
          {icons.caret}
        </button>
        {open === 'type' && (
          <Menu items={options.chartTypes} selected={value.chartType} icons={TYPE_ICON} onPick={chartType => pick({ chartType })} />
        )}
      </span>,
    );
  }
  if (options.studies?.length) {
    const n = value.studies?.length ?? 0;
    parts.push(
      sep('s2'),
      <button key="fx" className="acme-tb-btn" onClick={() => setStudiesOpen(true)} title="Indicators">
        {icons.fx}
        Indicators{n ? <span style={{ color: 'var(--acme-tb-muted)' }}> · {n}</span> : null}
      </button>,
    );
  }
  parts.push(<span key="sp" className="acme-tb-spacer" />);
  if (options.ranges?.length) {
    parts.push(
      <span key="rng" style={{ position: 'relative' }}>
        <button className={`acme-tb-btn${open === 'range' ? ' on' : ''}`} onClick={() => toggle('range')} title="Range">
          {labelOf(options.ranges, value.range)}
          {icons.caret}
        </button>
        {open === 'range' && <Menu items={options.ranges} selected={value.range} onPick={range => pick({ range })} right />}
      </span>,
    );
  }
  if (options.scales) {
    const scaleBtn = (key: string, label: string, title: string) => (
      <button
        key={key}
        className={`acme-tb-btn${value.scale === key ? ' active' : ''}`}
        title={title}
        onClick={() => onChange({ scale: value.scale === key ? 'normal' : key })}
      >
        {label}
      </button>
    );
    parts.push(sep('s3'), scaleBtn('percent', '%', 'Percent scale'), scaleBtn('log', 'log', 'Logarithmic scale'));
  }

  return (
    <div ref={root} className={`acme-tb${className ? ` ${className}` : ''}`}>
      {parts}
      {studiesOpen && options.studies && (
        <IndicatorsDialog
          items={options.studies}
          selected={value.studies ?? []}
          onToggle={key => {
            const cur = value.studies ?? [];
            onChange({ studies: cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key] });
          }}
          onClose={() => setStudiesOpen(false)}
        />
      )}
    </div>
  );
}

/** Items by group, groups in the order they first appear (items need not arrive sorted by group). */
function grouped(items: ToolbarItem[]): Array<[string | undefined, ToolbarItem[]]> {
  const byGroup = new Map<string | undefined, ToolbarItem[]>();
  for (const it of items) {
    const list = byGroup.get(it.group);
    if (list) list.push(it);
    else byGroup.set(it.group, [it]);
  }
  return [...byGroup.entries()];
}

function Menu({
  items,
  selected,
  onPick,
  icons: itemIcons,
  right,
}: {
  items: ToolbarItem[];
  selected?: string;
  onPick: (key: string) => void;
  icons?: Record<string, ReactNode>;
  right?: boolean;
}) {
  return (
    <div className="acme-tb-pop" style={right ? { right: 0 } : { left: 0 }}>
      {grouped(items).map(([g, its], gi) => (
        <div key={g ?? gi}>
          {g && <div className="acme-tb-group">{g}</div>}
          {its.map(it => (
            <div key={it.key} className={`acme-tb-item${it.key === selected ? ' selected' : ''}`} onClick={() => onPick(it.key)}>
              {itemIcons?.[it.key]}
              {it.label}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function SymbolSearch({ items, value, onPick }: { items: ToolbarItem[]; value?: string; onPick: (key: string) => void }) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? items.filter(i => i.key.toLowerCase().includes(s) || i.label.toLowerCase().includes(s) || i.description?.toLowerCase().includes(s)) : items;
  }, [items, q]);
  return (
    <div className="acme-tb-pop" style={{ left: 0, width: 260 }}>
      <input
        className="acme-tb-search"
        autoFocus
        placeholder="Search symbol"
        value={q}
        onChange={e => setQ(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && shown[0] && onPick(shown[0].key)}
      />
      {shown.map(it => (
        <div key={it.key} className={`acme-tb-item${it.key === value ? ' selected' : ''}`} onClick={() => onPick(it.key)}>
          <span className="acme-tb-sym">{it.label}</span>
          {it.description && <span style={{ color: 'var(--acme-tb-muted)', marginLeft: 'auto' }}>{it.description}</span>}
        </div>
      ))}
      {shown.length === 0 && <div className="acme-tb-empty">No matches</div>}
    </div>
  );
}

function IndicatorsDialog({
  items,
  selected,
  onToggle,
  onClose,
}: {
  items: ToolbarItem[];
  selected: string[];
  onToggle: (key: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const s = q.trim().toLowerCase();
  const shown = s ? items.filter(i => i.label.toLowerCase().includes(s) || i.group?.toLowerCase().includes(s)) : items;
  return (
    <div className="acme-tb-modal-bg" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="acme-tb-modal" role="dialog" aria-label="Indicators">
        <div className="acme-tb-modal-head">
          Indicators
          <button className="acme-tb-btn" onClick={onClose} title="Close">
            {icons.close}
          </button>
        </div>
        <input className="acme-tb-search" autoFocus placeholder="Search" value={q} onChange={e => setQ(e.target.value)} />
        <div className="acme-tb-modal-list">
          {grouped(shown).map(([g, its], gi) => (
            <div key={g ?? gi}>
              {g && <div className="acme-tb-group">{g}</div>}
              {its.map(it => (
                <div key={it.key} className="acme-tb-item" onClick={() => onToggle(it.key)}>
                  {it.label}
                  {selected.includes(it.key) && <span className="acme-tb-check">✓</span>}
                </div>
              ))}
            </div>
          ))}
          {shown.length === 0 && <div className="acme-tb-empty">No matches</div>}
        </div>
      </div>
    </div>
  );
}
