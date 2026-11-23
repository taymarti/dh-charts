/**
 * ChartToolbar: a TradingView-style chart toolbar. Controlled: it shows `value`, offers `options`, and
 * reports changes through `onChange(patch)`; the host owns the state (React state, or Python state in a
 * deephaven.ui workspace via the `acme.chart.Toolbar` element).
 *
 *   symbol ▾ (search) | interval ▾ | chart type ▾ | ƒx Indicators (dialog)  ...  range ▾ | % | log | layout ▾ | watchlist
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
  /** selected study keys; with options.addStudies, the types of the chart's study instances (repeats allowed) */
  studies?: string[];
  scale?: string; // "normal" | "log" | "percent"
  /** multi-chart layout key: "1", "2h" (side by side), "2v" (stacked), "3h", "4" */
  layout?: string;
  sync?: SyncValue;
  /** the watchlist panel is open */
  watchlist?: boolean;
  /** in onChange only, with options.addStudies: the indicators dialog asks to add an instance of this type */
  addStudy?: string;
  /** in onChange only, with options.compare: overlay this symbol (or expression) */
  addCompare?: string;
  /** the open side panel's key ("" or undefined: none), with options.panels */
  panel?: string;
  /** which of the symbol's series is charted (its price, its yield, ...), with options.series */
  series?: string;
}

/** What follows the active chart across a multi-chart layout. */
export interface SyncValue {
  symbol?: boolean;
  interval?: boolean;
  crosshair?: boolean;
  time?: boolean;
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
  /** the indicators dialog adds an instance per click (onChange({ addStudy })) instead of toggling keys */
  addStudies?: boolean;
  /** multi-chart layouts to offer (keys as in ToolbarValue.layout) */
  layouts?: ToolbarItem[];
  /** offer the sync toggles in the layout menu */
  sync?: boolean;
  /** offer the watchlist toggle (a single panel; see `panels` for several) */
  watchlist?: boolean;
  /** side panels to toggle, one open at a time (keys "watchlist", "alerts" get icons) */
  panels?: ToolbarItem[];
  /** the symbol search also accepts spreads and ratios typed as expressions ("ES-NQ", "ZN/ZB", "2*ZN-ZB") */
  expressions?: boolean;
  /** offer "Compare": overlay another symbol */
  compare?: boolean;
  /** the symbol's series to choose from (a security's price, yield, spread to the curve, ...): a menu before Indicators */
  series?: ToolbarItem[];
}

export interface ChartToolbarProps {
  value: ToolbarValue;
  options: ToolbarOptions;
  onChange: (patch: ToolbarValue) => void;
  className?: string;
}

const TYPE_ICON: Record<string, ReactNode> = { candle: icons.candle, bar: icons.bar, line: icons.line, area: icons.area };
const LAYOUT_ICON: Record<string, ReactNode> = {
  '1': icons.layout1, '2h': icons.layout2h, '2v': icons.layout2v, '3h': icons.layout3h, '4': icons.layout4,
};
const SYNC_ITEMS: Array<[keyof SyncValue, string]> = [
  ['symbol', 'Symbol'], ['interval', 'Interval'], ['crosshair', 'Crosshair'], ['time', 'Time'],
];

type Open = 'symbol' | 'interval' | 'type' | 'range' | 'layout' | 'compare' | 'series' | null;

const PANEL_ICON: Record<string, ReactNode> = { watchlist: icons.watchlist, alerts: icons.bell };

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
        {open === 'symbol' && (
          <SymbolSearch items={options.symbols} value={value.symbol} expressions={options.expressions} onPick={symbol => pick({ symbol })} />
        )}
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
  if (options.series && options.series.length > 1) {
    parts.push(
      sep('s3'),
      <span key="series" style={{ position: 'relative' }}>
        <button className={`acme-tb-btn${open === 'series' ? ' on' : ''}`} onClick={() => toggle('series')} title="Which series of the symbol to chart">
          {labelOf(options.series, value.series)}
          {icons.caret}
        </button>
        {open === 'series' && <Menu items={options.series} selected={value.series} onPick={series => pick({ series })} />}
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
  if (options.compare && options.symbols?.length) {
    parts.push(
      <span key="cmp" style={{ position: 'relative' }}>
        <button className={`acme-tb-btn${open === 'compare' ? ' on' : ''}`} onClick={() => toggle('compare')} title="Compare or add symbol">
          {icons.compare}
          Compare
        </button>
        {open === 'compare' && (
          <SymbolSearch
            items={options.symbols.filter(s => s.key !== value.symbol)}
            expressions={options.expressions}
            placeholder="Compare with"
            onPick={addCompare => pick({ addCompare })}
          />
        )}
      </span>,
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
  if (options.layouts?.length) {
    const sync = value.sync ?? {};
    parts.push(
      sep('s4'),
      <span key="lay" style={{ position: 'relative' }}>
        <button className={`acme-tb-btn${open === 'layout' ? ' on' : ''}`} onClick={() => toggle('layout')} title="Layout">
          {LAYOUT_ICON[value.layout ?? '1'] ?? icons.layout1}
          {icons.caret}
        </button>
        {open === 'layout' && (
          <div className="acme-tb-pop" style={{ right: 0, minWidth: 200 }}>
            <div className="acme-tb-group">Layout</div>
            {options.layouts.map(it => (
              <div
                key={it.key}
                className={`acme-tb-item${it.key === (value.layout ?? '1') ? ' selected' : ''}`}
                onClick={() => pick({ layout: it.key })}
              >
                {LAYOUT_ICON[it.key]}
                {it.label}
              </div>
            ))}
            {options.sync && (
              <>
                <div className="acme-tb-group">Sync in layout</div>
                {SYNC_ITEMS.map(([k, label]) => (
                  <div key={k} className="acme-tb-item toggle" onClick={() => onChange({ sync: { ...sync, [k]: !sync[k] } })}>
                    <span className={`acme-tb-box${sync[k] ? ' on' : ''}`}>{sync[k] ? '✓' : ''}</span>
                    {label}
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </span>,
    );
  }
  if (options.panels?.length) {
    parts.push(sep('s5'));
    for (const p of options.panels) {
      parts.push(
        <button
          key={`panel-${p.key}`}
          className={`acme-tb-btn${value.panel === p.key ? ' active' : ''}`}
          title={p.label}
          onClick={() => onChange({ panel: value.panel === p.key ? '' : p.key })}
        >
          {PANEL_ICON[p.key] ?? p.label}
        </button>,
      );
    }
  } else if (options.watchlist) {
    parts.push(
      <button
        key="wl"
        className={`acme-tb-btn${value.watchlist ? ' active' : ''}`}
        title="Watchlist"
        onClick={() => onChange({ watchlist: !value.watchlist })}
      >
        {icons.watchlist}
      </button>,
    );
  }

  return (
    <div ref={root} className={`acme-tb${className ? ` ${className}` : ''}`}>
      {parts}
      {studiesOpen && options.studies && (
        <IndicatorsDialog
          items={options.studies}
          selected={value.studies ?? []}
          counts={!!options.addStudies}
          onToggle={key => {
            if (options.addStudies) return onChange({ addStudy: key });
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

const isExpression = (s: string) => /[-+*/()]/.test(s);

function SymbolSearch({
  items,
  value,
  onPick,
  expressions,
  placeholder = 'Search symbol',
}: {
  items: ToolbarItem[];
  value?: string;
  onPick: (key: string) => void;
  expressions?: boolean;
  placeholder?: string;
}) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const raw = q.trim();
    const s = raw.toLowerCase();
    // a typed expression ("es-nq") is offered first, symbols upper-cased: the server checks it
    const expr: ToolbarItem[] =
      expressions && isExpression(raw)
        ? [{ key: raw.replace(/\s+/g, '').toUpperCase(), label: raw.replace(/\s+/g, '').toUpperCase(), description: /\//.test(raw) ? 'Ratio' : 'Spread' }]
        : [];
    const its = s && !expr.length ? items.filter(i => i.key.toLowerCase().includes(s) || i.label.toLowerCase().includes(s) || i.description?.toLowerCase().includes(s)) : items;
    return [...expr, ...(expr.length ? [] : its)];
  }, [items, q, expressions]);
  return (
    <div className="acme-tb-pop" style={{ left: 0, width: 260 }}>
      <input
        className="acme-tb-search"
        autoFocus
        placeholder={expressions ? `${placeholder}, or a spread: ES-NQ, ZN/ZB` : placeholder}
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
  counts,
  onToggle,
  onClose,
}: {
  items: ToolbarItem[];
  selected: string[];
  /** show how many of each are on the chart (instances) instead of a check mark */
  counts?: boolean;
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
                  {counts
                    ? selected.includes(it.key) && <span className="acme-tb-count">{selected.filter(k => k === it.key).length}</span>
                    : selected.includes(it.key) && <span className="acme-tb-check">✓</span>}
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
