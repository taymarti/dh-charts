/**
 * Trading sessions from a calendar spec (dh_chart_ext.sessions on the server): shaded closed and
 * extended hours on charts, the market status ("open", "extended", "closed") and when it changes.
 * Times are computed in the exchange's time zone with Intl, so DST is handled; holidays are not.
 *
 *   sessionRanges(spec, from, to)        ranges to shade between two UTC-second times
 *   marketStatus(spec, now)              { state, label, until }
 *   setPageSessions({ ES: spec, ... })   the page's calendar (the Services element, or a JS client)
 *   marketSessions()                     extension: shading on every Deephaven chart, by chart key
 */
import { TimeRangeShading, type ShadedRange } from './lwc-plugins/time-range-shading';
import { titleChartKey } from './persistent-price-lines';
import type { TvlChartContext, TvlExtension } from './hook';

export interface SessionSpec {
  /** IANA time zone of the times below */
  tz: string;
  /** session start "HH:MM"; later than `close` means the evening before the trading day */
  open: string;
  close: string;
  /** regular trading hours [start, end], or null */
  rth?: [string, string] | null;
  /** ISO weekdays that are trading days (Mon=1 .. Fri=5) */
  days: number[];
  name?: string;
}

export type MarketState = 'regular' | 'extended' | 'closed';

export const SESSION_COLORS = {
  closed: 'rgba(120, 123, 134, 0.13)',
  extended: 'rgba(255, 183, 77, 0.05)',
};

// ----------------------------------------------------------------------------- time zones

const fmts = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
      second: 'numeric',
    });
    fmts.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of `ms` in `tz`. */
function wall(tz: string, ms: number) {
  const p: Record<string, number> = {};
  for (const x of fmt(tz).formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

/** UTC ms of the wall-clock time y-m-d hh:mm in `tz`. */
function zoned(tz: string, y: number, m: number, d: number, hhmm: string): number {
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off = (t: number) => {
    const w = wall(tz, t);
    return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(t / 1000) * 1000;
  };
  let t = guess - off(guess);
  const o2 = off(t);
  if (guess - o2 !== t) t = guess - o2;
  return t;
}

interface Session {
  open: number; // UTC seconds
  close: number;
  rthOpen?: number;
  rthClose?: number;
}

const cache = new Map<string, Session[]>();

/** The sessions whose trading day falls in [fromSec - 2d, toSec + 2d]. */
function sessionsAround(spec: SessionSpec, fromSec: number, toSec: number): Session[] {
  const day0 = Math.floor(fromSec / 86400) - 2;
  const day1 = Math.ceil(toSec / 86400) + 2;
  const key = `${spec.tz}|${spec.open}|${spec.close}|${spec.rth?.join('-')}|${spec.days.join('')}|${day0}|${day1}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out: Session[] = [];
  const overnight = spec.open > spec.close;
  for (let day = day0; day <= day1; day++) {
    // the calendar date `day` (days since the epoch), as a date in any zone
    const dt = new Date(day * 86400e3);
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    const iso = dt.getUTCDay() === 0 ? 7 : dt.getUTCDay();
    if (!spec.days.includes(iso)) continue;
    const prev = new Date((day - 1) * 86400e3);
    const open = overnight
      ? zoned(spec.tz, prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), spec.open)
      : zoned(spec.tz, y, m, d, spec.open);
    const s: Session = { open: open / 1000, close: zoned(spec.tz, y, m, d, spec.close) / 1000 };
    if (spec.rth) {
      s.rthOpen = zoned(spec.tz, y, m, d, spec.rth[0]) / 1000;
      s.rthClose = zoned(spec.tz, y, m, d, spec.rth[1]) / 1000;
    }
    out.push(s);
  }
  if (cache.size > 200) cache.clear();
  cache.set(key, out);
  return out;
}

// ----------------------------------------------------------------------------- shading and status

/** Closed and extended-hours ranges between two UTC-second times (none for spans over 120 days). */
export function sessionRanges(spec: SessionSpec, fromSec: number, toSec: number): ShadedRange[] {
  if (!(toSec > fromSec) || toSec - fromSec > 120 * 86400) return [];
  const ss = sessionsAround(spec, fromSec, toSec);
  const out: ShadedRange[] = [];
  let cursor = fromSec - 3 * 86400;
  for (const s of ss) {
    if (s.open > cursor) out.push({ from: cursor, to: s.open, color: SESSION_COLORS.closed });
    if (s.rthOpen != null && s.rthClose != null) {
      if (s.rthOpen > s.open) out.push({ from: s.open, to: s.rthOpen, color: SESSION_COLORS.extended });
      if (s.close > s.rthClose) out.push({ from: s.rthClose, to: s.close, color: SESSION_COLORS.extended });
    }
    cursor = Math.max(cursor, s.close);
  }
  out.push({ from: cursor, to: toSec + 3 * 86400, color: SESSION_COLORS.closed });
  return out.filter(r => r.to > fromSec && r.from < toSec);
}

export interface MarketStatus {
  state: MarketState;
  label: string;
  /** UTC seconds of the next change, if known */
  until?: number;
  name?: string;
}

/** Whether the market is in regular hours, extended hours or closed at `nowSec`, and until when. */
export function marketStatus(spec: SessionSpec, nowSec = Date.now() / 1000): MarketStatus {
  const ss = sessionsAround(spec, nowSec - 86400, nowSec + 8 * 86400);
  const name = spec.name;
  for (const s of ss) {
    if (nowSec < s.open) return { state: 'closed', label: 'Market closed', until: s.open, name };
    if (nowSec < s.close) {
      if (s.rthOpen != null && s.rthClose != null) {
        if (nowSec < s.rthOpen) return { state: 'extended', label: 'Pre-market', until: s.rthOpen, name };
        if (nowSec < s.rthClose) return { state: 'regular', label: 'Market open', until: s.rthClose, name };
        return { state: 'extended', label: 'After hours', until: s.close, name };
      }
      return { state: 'regular', label: 'Market open', until: s.close, name };
    }
  }
  return { state: 'closed', label: 'Market closed', name };
}

/** "2h 05m", "14m", "3d 4h" */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

// ----------------------------------------------------------------------------- the page's calendar

let specs: Record<string, SessionSpec> = {};
const listeners = new Set<() => void>();

/** Set the page's session calendar, by symbol. */
export function setPageSessions(map: Record<string, SessionSpec> | undefined): void {
  specs = map ?? {};
  listeners.forEach(l => l());
}

/** Call `cb` whenever the calendar changes. */
export function onPageSessions(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The spec for a symbol; for a spread or ratio ("ES-NQ"), its first leg's. */
export function sessionSpecFor(sym: string | undefined): SessionSpec | undefined {
  if (!sym) return undefined;
  if (specs[sym]) return specs[sym];
  const m = /\d*[A-Za-z][A-Za-z0-9_.]*/.exec(sym);
  return m ? specs[m[0]] : undefined;
}

/** Extension: shade closed and extended hours on every Deephaven chart, from the page's calendar. */
export function marketSessions(keyOf: (ctx: TvlChartContext) => string | undefined = titleChartKey): TvlExtension {
  return ctx => {
    const key = keyOf(ctx);
    const prim = new TimeRangeShading((from, to) => {
      const spec = sessionSpecFor(key);
      return spec ? sessionRanges(spec, from, to) : [];
    });
    ctx.series[0].attachPrimitive(prim);
    return () => ctx.series[0].detachPrimitive(prim);
  };
}

/** Shade sessions on any LWC chart's price series (front-end group C). */
export function bindSessionShading(series: { attachPrimitive(p: unknown): void; detachPrimitive(p: unknown): void }, sym: string) {
  const prim = new TimeRangeShading((from, to) => {
    const spec = sessionSpecFor(sym);
    return spec ? sessionRanges(spec, from, to) : [];
  });
  series.attachPrimitive(prim);
  return () => series.detachPrimitive(prim);
}
