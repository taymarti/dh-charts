/**
 * ChartLegend: the TradingView-style legend over a Lightweight Charts chart. The first row is the
 * symbol and O H L C (or the value) of the bar under the crosshair, or of the latest bar, with the
 * change from the previous close; then one row per study with its value(s) in its color, and, on
 * hover, show/hide, settings and remove buttons. Settings opens a dialog for the study's parameters
 * and color.
 *
 * Controlled like the toolbar: `studies` is what to show, and `onStudyChange(patch)` reports what the
 * user did; the host decides what that means (a deephaven.ui workspace recomputes the study in Python;
 * a React host with fixed study columns can only hide or remove them).
 *
 * The chart and its series come from the host: the series are matched to studies by title (each
 * study lists its series' titles in `columns`); `series[0]` is the price series. Lightweight Charts
 * is only a type dependency.
 */
import { useEffect, useMemo, useReducer, useState } from 'react';
import type { IChartApi, ISeriesApi, MouseEventParams, SeriesType, Time } from 'lightweight-charts';
import { icons } from './icons';
import { injectToolbarStyles } from './styles';

export interface LegendStudy {
  id: string;
  label: string;
  /** titles of the study's series on the chart (the study's columns) */
  columns: string[];
  color?: string;
  visible?: boolean;
  /** key into `studyTypes`, for the settings dialog */
  type?: string;
  params?: Record<string, number>;
  /** "compare": a compared symbol (a line of its closes), shown with its value and no settings */
  kind?: 'study' | 'compare';
}

/** The market's state, shown as a dot by the symbol (from a session calendar). */
export interface LegendStatus {
  state: 'regular' | 'extended' | 'closed';
  label: string;
  /** tooltip detail, e.g. "closes in 2h 05m · CME Globex" */
  detail?: string;
}

/** Editable parameters per study type, with defaults: { EMA: { label, params: { length: 20 } } }. */
export type StudyTypes = Record<string, { label: string; params: Record<string, number> }>;

export interface StudyPatch {
  id: string;
  visible?: boolean;
  remove?: boolean;
  params?: Record<string, number>;
  color?: string;
}

export interface ChartLegendProps {
  chart: IChartApi | null;
  /** the chart's series; series[0] is the price series */
  series: ISeriesApi<SeriesType>[];
  title: string;
  studies?: LegendStudy[];
  /** with it, each study row gets a settings button for its type's parameters */
  studyTypes?: StudyTypes;
  onStudyChange?: (patch: StudyPatch) => void;
  /** left offset in px (default 44: to the right of the drawing palette) */
  left?: number;
  status?: LegendStatus;
}

const STATUS_COLOR = { regular: '#26a69a', extended: '#ff9800', closed: '#787b86' };

export const STUDY_PALETTE = [
  '#f7a600', '#ab47bc', '#00bcd4', '#8bc34a', '#ff7043', '#90a4ae', '#2962ff', '#e91e63', '#ffeb3b', '#ffffff',
];

const UP = '#26a69a';
const DOWN = '#ef5350';
const MUTED = '#787b86';

type Bar = { time?: Time; open?: number; high?: number; low?: number; close?: number; value?: number };

const lastOf = (s: ISeriesApi<SeriesType>): Bar | undefined => {
  const d = s.data() as Bar[];
  for (let i = d.length - 1; i >= 0; i--) if (d[i].close != null || d[i].value != null) return d[i];
  return undefined;
};

/** The data point before `bar` (by time), skipping whitespace. */
function prevOf(s: ISeriesApi<SeriesType>, bar: Bar): Bar | undefined {
  const data = s.data() as Bar[];
  const t = Number(bar.time);
  let lo = 0;
  let hi = data.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const mt = Number(data[mid].time);
    if (mt < t) lo = mid + 1;
    else hi = mid - 1;
  }
  for (let i = lo - 1; i >= 0; i--) if (data[i].close != null || data[i].value != null) return data[i];
  return undefined;
}

export function ChartLegend({ chart, series, title, studies = [], studyTypes, onStudyChange, left = 44, status }: ChartLegendProps) {
  injectToolbarStyles();
  const [hover, setHover] = useState<MouseEventParams<Time> | null>(null);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [editing, setEditing] = useState<LegendStudy | null>(null);
  const price = series[0];
  const byTitle = useMemo(() => {
    const m = new Map<string, ISeriesApi<SeriesType>>();
    for (const s of series) {
      const t = s.options().title;
      if (t) m.set(String(t), s);
    }
    return m;
  }, [series]);

  // follow the crosshair; follow the data (throttled to one render per frame) when not hovering
  useEffect(() => {
    if (!chart || !price) return;
    let frame = 0;
    const onMove = (p: MouseEventParams<Time>) => setHover(p.time === undefined ? null : p);
    const onData = () => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), redraw()));
    };
    chart.subscribeCrosshairMove(onMove);
    price.subscribeDataChanged(onData);
    return () => {
      cancelAnimationFrame(frame);
      try {
        chart.unsubscribeCrosshairMove(onMove);
        price.unsubscribeDataChanged(onData);
      } catch {
        /* the chart is already gone */
      }
    };
  }, [chart, price]);

  if (!chart || !price) return null;

  const valueOf = (s: ISeriesApi<SeriesType> | undefined): Bar | undefined => {
    if (!s) return undefined;
    try {
      return hover ? (hover.seriesData.get(s) as Bar | undefined) : lastOf(s);
    } catch {
      return undefined; // a series removed under us
    }
  };
  const precision = (s: ISeriesApi<SeriesType>) => (s.options().priceFormat as { precision?: number } | undefined)?.precision ?? 2;
  const p = precision(price);
  const f = (v: number | undefined, prec = p) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(prec));

  const bar = valueOf(price);
  const close = bar?.close ?? bar?.value;
  const prev = bar && prevOf(price, bar);
  const prevClose = prev?.close ?? prev?.value;
  const chg = close != null && prevClose != null ? close - prevClose : undefined;
  const color = chg == null ? '#d1d4dc' : chg >= 0 ? UP : DOWN;
  const ohlc = (label: string, v: number | undefined) => (
    <span key={label}>
      <span className="acme-lg-k">{label}</span>
      <span style={{ color }}>{f(v)}</span>
    </span>
  );

  return (
    <div className="acme-lg" style={{ left }}>
      <div className="acme-lg-row">
        <span className="acme-lg-title">{title}</span>
        {status && (
          <span className="acme-lg-status" title={status.detail ? `${status.label} · ${status.detail}` : status.label}>
            <span className="acme-lg-dot" style={{ background: STATUS_COLOR[status.state] }} />
          </span>
        )}
        {bar?.open != null ? [ohlc('O', bar.open), ohlc('H', bar.high), ohlc('L', bar.low), ohlc('C', bar.close)] : ohlc('', close)}
        {chg != null && prevClose ? (
          <span style={{ color }}>
            {chg >= 0 ? '+' : ''}
            {chg.toFixed(p)} ({chg >= 0 ? '+' : ''}
            {((100 * chg) / Math.abs(prevClose)).toFixed(2)}%)
          </span>
        ) : null}
      </div>
      {studies.map(st => {
        const visible = st.visible !== false;
        const values = visible ? st.columns.map(c => byTitle.get(c)).map(s => (s ? f(valueOf(s)?.value, precision(s)) : '—')) : [];
        return (
          <div key={st.id} className={`acme-lg-row acme-lg-study${visible ? '' : ' hidden'}`}>
            <span className="acme-lg-label" style={st.kind === 'compare' ? { color: st.color } : undefined}>
              {st.label}
            </span>
            {values.map((v, i) => (
              <span key={i} style={{ color: st.color ?? '#d1d4dc' }}>
                {v}
              </span>
            ))}
            {onStudyChange && (
              <span className="acme-lg-tools">
                <button title={visible ? 'Hide' : 'Show'} onClick={() => onStudyChange({ id: st.id, visible: !visible })}>
                  {visible ? icons.eye : icons.eyeOff}
                </button>
                {studyTypes && st.kind !== 'compare' && st.type && studyTypes[st.type] && (
                  <button title="Settings" onClick={() => setEditing(st)}>
                    {icons.gear}
                  </button>
                )}
                <button title="Remove" onClick={() => onStudyChange({ id: st.id, remove: true })}>
                  {icons.close}
                </button>
              </span>
            )}
          </div>
        );
      })}
      {editing && studyTypes && editing.type && (
        <StudySettings
          study={editing}
          info={studyTypes[editing.type]}
          onClose={() => setEditing(null)}
          onApply={(params, c) => {
            setEditing(null);
            onStudyChange?.({ id: editing.id, params, color: c });
          }}
        />
      )}
    </div>
  );
}

const labelOf = (name: string) =>
  ({ length: 'Length', mult: 'StdDev multiplier' } as Record<string, string>)[name] ?? name.charAt(0).toUpperCase() + name.slice(1);

function StudySettings({
  study,
  info,
  onClose,
  onApply,
}: {
  study: LegendStudy;
  info: { label: string; params: Record<string, number> };
  onClose: () => void;
  onApply: (params: Record<string, number>, color: string | undefined) => void;
}) {
  const [params, setParams] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries({ ...info.params, ...study.params }).map(([k, v]) => [k, String(v)])),
  );
  const [color, setColor] = useState(study.color);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const parsed = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, Number(v)]));
  const valid = Object.values(parsed).every(v => Number.isFinite(v) && v > 0);
  const apply = () => valid && onApply(parsed, color);
  return (
    <div className="acme-tb-modal-bg" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="acme-tb-modal" role="dialog" aria-label={`${info.label} settings`} style={{ width: 340 }}>
        <div className="acme-tb-modal-head">
          {info.label}
          <button className="acme-tb-btn" onClick={onClose} title="Close">
            {icons.close}
          </button>
        </div>
        <div className="acme-lg-form" onKeyDown={e => e.key === 'Enter' && apply()}>
          {Object.keys(params).map(k => (
            <label key={k}>
              <span>{labelOf(k)}</span>
              <input
                className="acme-tb-search"
                type="number"
                min={0}
                step={Number.isInteger(info.params[k]) ? 1 : 0.1}
                value={params[k]}
                onChange={e => setParams(p => ({ ...p, [k]: e.target.value }))}
              />
            </label>
          ))}
          <label>
            <span>Color</span>
            <span className="acme-lg-swatches">
              {STUDY_PALETTE.map(c => (
                <button
                  key={c}
                  title={c}
                  className={c === color ? 'on' : ''}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </span>
          </label>
        </div>
        <div className="acme-lg-actions">
          <button className="acme-tb-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="acme-tb-btn acme-lg-ok" disabled={!valid} onClick={apply}>
            Ok
          </button>
        </div>
      </div>
    </div>
  );
}
