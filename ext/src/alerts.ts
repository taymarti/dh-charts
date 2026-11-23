/**
 * Alerts on the client: a store over the server's alerts table (dh_chart_ext.alerts.alert_table),
 * active alert levels drawn on charts, and a notification when one of the user's alerts fires.
 * Evaluation happens on the server (dh_chart_ext.alerts.AlertEngine), so alerts fire with no
 * browser open; the browser only creates, cancels, shows and announces them.
 *
 *   AlertStore                                 the interface; @acme/dh-bindings' tableAlertStore implements it
 *   providePageAlertStore(store)               the page's store (the Services element, or a JS client)
 *   bindAlertLines(series, store, sym)         active price alerts as dashed lines with a bell
 *   showAlertToasts(store)                     a toast when one of the owner's alerts fires
 *   alertLines()                               extension: alert lines on every Deephaven chart
 */
import type { IPriceLine, ISeriesApi, SeriesType } from 'lightweight-charts';
import { newAnnotationId } from './annotations';
import { titleChartKey } from './persistent-price-lines';
import type { TvlChartContext, TvlExtension } from './hook';

export type AlertKind = 'price' | 'line' | 'study';
export type AlertOp = 'cross' | 'above' | 'below';
export type AlertStatus = 'active' | 'triggered' | 'cancelled';

export interface Alert {
  id: string;
  owner: string;
  sym: string;
  /** "Last" or "<column>@<resolution>" */
  source: string;
  kind: AlertKind;
  op: AlertOp;
  level: number | null;
  t0: number | null;
  p0: number | null;
  t1: number | null;
  p1: number | null;
  drawingId: string | null;
  message: string;
  status: AlertStatus;
  createdMs: number;
  triggeredMs: number | null;
  triggerValue: number | null;
}

export interface AlertInput {
  id?: string;
  sym: string;
  source?: string;
  kind: AlertKind;
  op?: AlertOp;
  level?: number | null;
  line?: { t0: number; p0: number; t1: number; p1: number } | null;
  drawingId?: string | null;
  message?: string;
}

export interface AlertStore {
  readonly owner: string;
  /** the owner's alerts (active and triggered; not cancelled), newest first */
  list(): Alert[];
  /** active alerts on a symbol */
  active(sym: string): Alert[];
  subscribe(listener: () => void): () => void;
  /** create, or replace (same id), an active alert */
  put(input: AlertInput): Promise<string>;
  cancel(id: string): Promise<void>;
  close(): void;
}

/** "ES crosses 100.25", "ES crosses up the trend line", "NQ RSI 14 (1m) crosses down 70" */
export function describeAlert(a: Pick<Alert, 'sym' | 'source' | 'kind' | 'op' | 'level'>, fmt = (v: number) => String(+v.toFixed(4))): string {
  const verb = a.op === 'above' ? 'crosses up' : a.op === 'below' ? 'crosses down' : 'crosses';
  const what = a.source === 'Last' ? a.sym : `${a.sym} ${a.source.replace('@', ' (').replace(/_/g, ' ')})`;
  const target = a.kind === 'line' ? 'the trend line' : a.level != null ? fmt(a.level) : '?';
  return `${what} ${verb} ${target}`;
}

// ----------------------------------------------------------------------------- the page's store

const providers: AlertStore[] = [];
const waiters = new Set<(s: AlertStore | undefined) => void>();
let current: AlertStore | undefined;

function publish() {
  const next = providers[providers.length - 1];
  if (next === current) return;
  current = next;
  waiters.forEach(w => w(next));
}

export function providePageAlertStore(store: AlertStore): () => void {
  providers.push(store);
  publish();
  return () => {
    const i = providers.lastIndexOf(store);
    if (i >= 0) providers.splice(i, 1);
    publish();
  };
}

export function onPageAlertStore(cb: (s: AlertStore | undefined) => void): () => void {
  waiters.add(cb);
  if (current) cb(current);
  return () => waiters.delete(cb);
}

export function currentAlertStore(): AlertStore | undefined {
  return current;
}

// ----------------------------------------------------------------------------- on charts

export const ALERT_COLOR = '#ff9800';

/** Active price alerts on `sym` as dashed lines on `series` (alerts tied to a drawing show on it instead). */
export function bindAlertLines(series: ISeriesApi<SeriesType>, store: AlertStore, sym: string): () => void {
  const lines = new Map<string, IPriceLine>();
  const sync = () => {
    const want = store.active(sym).filter(a => a.kind === 'price' && a.source === 'Last' && a.level != null && !a.drawingId);
    const ids = new Set(want.map(a => a.id));
    for (const [id, l] of lines) {
      if (!ids.has(id)) {
        series.removePriceLine(l);
        lines.delete(id);
      }
    }
    for (const a of want) {
      const opts = {
        price: a.level as number, color: ALERT_COLOR, lineWidth: 1 as const, lineStyle: 2 as const, axisLabelVisible: true,
        title: `🔔 ${a.message || (a.op === 'cross' ? 'alert' : a.op === 'above' ? 'up' : 'down')}`,
      };
      const l = lines.get(a.id);
      if (l) l.applyOptions(opts);
      else lines.set(a.id, series.createPriceLine(opts));
    }
  };
  sync();
  const unsubscribe = store.subscribe(sync);
  return () => {
    unsubscribe();
    for (const l of lines.values()) {
      try {
        series.removePriceLine(l);
      } catch {
        /* the series is gone */
      }
    }
    lines.clear();
  };
}

/** Extension: alert lines on every Deephaven chart, from the page's alert store. */
export function alertLines(keyOf: (ctx: TvlChartContext) => string | undefined = titleChartKey): TvlExtension {
  return ctx => {
    const key = keyOf(ctx);
    if (!key) return;
    let unbind = () => {};
    const unsubscribe = onPageAlertStore(s => {
      unbind();
      unbind = s ? bindAlertLines(ctx.series[0], s, key) : () => {};
    });
    return () => {
      unsubscribe();
      unbind();
    };
  };
}

// ----------------------------------------------------------------------------- notifications

const announced = new Set<string>(); // per page: several Services elements share one set of toasts
let toastBox: HTMLElement | null = null;

function toast(title: string, body: string) {
  if (!toastBox || !toastBox.isConnected) {
    toastBox = document.createElement('div');
    Object.assign(toastBox.style, {
      position: 'fixed', top: '12px', right: '12px', zIndex: '2000', display: 'flex', flexDirection: 'column', gap: '8px',
      font: '13px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, sans-serif',
    });
    document.body.appendChild(toastBox);
  }
  const el = document.createElement('div');
  Object.assign(el.style, {
    minWidth: '260px', maxWidth: '360px', padding: '10px 14px', background: '#1e222d', color: '#d1d4dc', cursor: 'pointer',
    border: `1px solid ${ALERT_COLOR}`, borderLeft: `4px solid ${ALERT_COLOR}`, borderRadius: '6px',
    boxShadow: '0 6px 24px rgba(0,0,0,.5)',
  });
  const h = document.createElement('div');
  h.textContent = `🔔 ${title}`;
  Object.assign(h.style, { fontWeight: '600', marginBottom: '2px', paddingRight: '18px', position: 'relative' });
  const x = document.createElement('span');
  x.textContent = '✕';
  x.title = 'Dismiss';
  Object.assign(x.style, { position: 'absolute', right: '0', top: '0', color: '#787b86', fontWeight: '400' });
  h.append(x);
  const b = document.createElement('div');
  b.textContent = body;
  b.style.color = '#b2b5be';
  el.append(h, b);
  el.addEventListener('click', () => el.remove());
  toastBox.appendChild(el);
  setTimeout(() => el.remove(), 12000);
}

/** A toast (and a browser notification, if the page already has permission) when one of the store
 * owner's alerts fires after the page loaded. Returns a function that stops listening. */
export function showAlertToasts(store: AlertStore): () => void {
  const since = Date.now() - 2000;
  const check = () => {
    for (const a of store.list()) {
      if (a.status !== 'triggered' || announced.has(a.id + a.triggeredMs)) continue;
      announced.add(a.id + a.triggeredMs);
      if ((a.triggeredMs ?? 0) < since) continue;
      const title = describeAlert(a);
      const body = `${a.message ? `${a.message} · ` : ''}at ${a.triggerValue?.toFixed(4) ?? '?'}, ${new Date(a.triggeredMs ?? Date.now()).toLocaleTimeString()}`;
      toast(title, body);
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body });
      } catch {
        /* notifications unavailable */
      }
    }
  };
  check();
  return store.subscribe(check);
}
