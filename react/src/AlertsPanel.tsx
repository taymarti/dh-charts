/**
 * AlertsPanel: the user's alerts, TradingView style: a form for a new alert on the current symbol
 * (on the price or on a study value, crossing a level), the active alerts, and the log of fired
 * ones. Controlled and data-agnostic: the host supplies rows and handles create / cancel (dh-chart-ext
 * binds it to the page's alert store; the server evaluates the alerts).
 */
import { useEffect, useState } from 'react';
import { icons } from './icons';
import { injectToolbarStyles } from './styles';

export interface AlertsPanelRow {
  id: string;
  sym: string;
  /** "NQ crosses up 124.50" */
  description: string;
  message?: string;
  status: 'active' | 'triggered';
  createdMs?: number;
  triggeredMs?: number | null;
  triggerValue?: number | null;
}

export interface NewAlert {
  sym: string;
  source: string;
  op: 'cross' | 'above' | 'below';
  level: number;
  message: string;
}

export interface AlertsPanelProps {
  alerts: AlertsPanelRow[];
  /** the symbol a new alert is for */
  symbol?: string;
  /** what an alert can watch: [{ key: "Last", label: "Price" }, { key: "RSI_14@1m", label: "RSI 14 (1m)" }] */
  sources?: Array<{ key: string; label: string }>;
  /** the form's starting level (e.g. the last price) */
  defaultLevel?: number;
  onCreate?: (a: NewAlert) => void;
  /** cancel an active alert, or dismiss a fired one from the log */
  onCancel?: (id: string) => void;
  className?: string;
}

const OPS: Array<[NewAlert['op'], string]> = [
  ['cross', 'Crossing'],
  ['above', 'Crossing up'],
  ['below', 'Crossing down'],
];

const time = (ms?: number | null) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');

export function AlertsPanel({ alerts, symbol, sources = [{ key: 'Last', label: 'Price' }], defaultLevel, onCreate, onCancel, className }: AlertsPanelProps) {
  injectToolbarStyles();
  const [source, setSource] = useState(sources[0]?.key ?? 'Last');
  const [op, setOp] = useState<NewAlert['op']>('cross');
  const [level, setLevel] = useState(defaultLevel != null ? String(+defaultLevel.toFixed(4)) : '');
  const [message, setMessage] = useState('');
  // a new symbol starts the form over at its price
  useEffect(() => {
    setLevel(defaultLevel != null && source === 'Last' ? String(+defaultLevel.toFixed(4)) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);
  const value = Number(level);
  const valid = !!symbol && level.trim() !== '' && Number.isFinite(value);
  const create = () => {
    if (!valid || !symbol) return;
    onCreate?.({ sym: symbol, source, op, level: value, message: message.trim() });
    setMessage('');
  };
  const active = alerts.filter(a => a.status === 'active');
  const fired = alerts.filter(a => a.status === 'triggered').sort((x, y) => (y.triggeredMs ?? 0) - (x.triggeredMs ?? 0));

  return (
    <div className={`acme-wl acme-al${className ? ` ${className}` : ''}`}>
      <div className="acme-wl-head">Alerts</div>
      {onCreate && (
        <div className="acme-al-form" onKeyDown={e => e.key === 'Enter' && create()}>
          <div className="acme-al-sym">
            {icons.bell}
            <span>{symbol ?? '—'}</span>
          </div>
          <select className="acme-tb-search" value={source} onChange={e => setSource(e.target.value)}>
            {sources.map(s => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          <div className="acme-al-row">
            <select className="acme-tb-search" value={op} onChange={e => setOp(e.target.value as NewAlert['op'])}>
              {OPS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            <input className="acme-tb-search" type="number" step="any" placeholder="Value" value={level} onChange={e => setLevel(e.target.value)} />
          </div>
          <input className="acme-tb-search" placeholder="Message (optional)" value={message} onChange={e => setMessage(e.target.value)} />
          <button className="acme-tb-btn acme-lg-ok" disabled={!valid} onClick={create}>
            Create alert
          </button>
        </div>
      )}
      <div className="acme-wl-body">
        <div className="acme-tb-group">Active · {active.length}</div>
        {active.map(a => (
          <div key={a.id} className="acme-al-item">
            <div>
              <div>{a.description}</div>
              {a.message && <div className="acme-al-sub">{a.message}</div>}
            </div>
            {onCancel && (
              <button title="Cancel alert" onClick={() => onCancel(a.id)}>
                {icons.close}
              </button>
            )}
          </div>
        ))}
        {active.length === 0 && <div className="acme-tb-empty">No active alerts. Right-click a chart or press Alt+A to add one.</div>}
        <div className="acme-tb-group">Log · {fired.length}</div>
        {fired.map(a => (
          <div key={a.id} className="acme-al-item fired">
            <div>
              <div>{a.description}</div>
              <div className="acme-al-sub">
                {time(a.triggeredMs)}
                {a.triggerValue != null ? ` · at ${+a.triggerValue.toFixed(4)}` : ''}
                {a.message ? ` · ${a.message}` : ''}
              </div>
            </div>
            {onCancel && (
              <button title="Remove from the log" onClick={() => onCancel(a.id)}>
                {icons.close}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
