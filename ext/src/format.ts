/**
 * Display formats for a chart: the time zone of the axis and crosshair, and prices by tick size.
 *
 *   createChart(el, { ...timeZoneOptions('America/Chicago') })   // or 'local' (the default) or 'UTC'
 *   series.applyOptions({ priceFormat: priceFormatFor(0.25) })    // ES: 2 decimals, steps of 0.25
 *
 * Lightweight Charts shows times in UTC unless told otherwise; Deephaven's own chart shows the browser's
 * local time. Charts that should agree use the same zone here.
 */
import { TickMarkType, type Time, type UTCTimestamp } from 'lightweight-charts';

/** 'local' (the browser's zone), 'UTC', or an IANA name like 'America/Chicago'. */
export type DisplayZone = string;

const zoneOf = (zone: DisplayZone) => (zone === 'local' ? undefined : zone);

function fmt(zone: DisplayZone, opts: Intl.DateTimeFormatOptions) {
  const f = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: zoneOf(zone), hourCycle: 'h23' });
  return (sec: number) => f.format(new Date(sec * 1000));
}

const seconds = (t: Time): number =>
  typeof t === 'number' ? t : typeof t === 'string' ? Date.parse(t) / 1000 : Date.UTC(t.year, t.month - 1, t.day) / 1000;

/** The crosshair's time label and the axis' tick marks in `zone`. */
export function timeFormatters(zone: DisplayZone = 'local') {
  const full = fmt(zone, { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const year = fmt(zone, { year: 'numeric' });
  const month = fmt(zone, { month: 'short' });
  const day = fmt(zone, { day: 'numeric', month: 'short' });
  const time = fmt(zone, { hour: '2-digit', minute: '2-digit' });
  const timeSec = fmt(zone, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return {
    timeFormatter: (t: Time) => full(seconds(t)),
    tickMarkFormatter: (t: Time, type: TickMarkType) => {
      const s = seconds(t);
      switch (type) {
        case TickMarkType.Year:
          return year(s);
        case TickMarkType.Month:
          return month(s);
        case TickMarkType.DayOfMonth:
          return day(s);
        case TickMarkType.TimeWithSeconds:
          return timeSec(s);
        default:
          return time(s);
      }
    },
  };
}

/** Chart options that show times in `zone` (spread into createChart's or applyOptions' argument). */
export function timeZoneOptions(zone: DisplayZone = 'local') {
  const f = timeFormatters(zone);
  return { localization: { timeFormatter: f.timeFormatter }, timeScale: { tickMarkFormatter: f.tickMarkFormatter } };
}

/** Decimal places of a tick size (0.25 -> 2, 0.015625 -> 6, 1 -> 0), at most 8. */
export function tickDecimals(tick: number): number {
  if (!(tick > 0)) return 2;
  for (let d = 0; d <= 8; d++) if (Math.abs(Math.round(tick * 10 ** d) - tick * 10 ** d) < 1e-9) return d;
  return 8;
}

/** A series' priceFormat for an instrument's tick size (null: two decimals, any step). */
export function priceFormatFor(tick: number | null | undefined) {
  if (!tick || !(tick > 0)) return { type: 'price' as const, precision: 2, minMove: 0.01 };
  return { type: 'price' as const, precision: tickDecimals(tick), minMove: tick };
}

/** "21 Nov 26 19:50:00" for a UTC timestamp, in `zone` (for legends and tooltips). */
export function formatTime(t: UTCTimestamp | number, zone: DisplayZone = 'local'): string {
  return timeFormatters(zone).timeFormatter(t as UTCTimestamp);
}

// ----------------------------------------------------------------------------- price notation

/**
 * Treasury price notation: 110-16+ is 110 + 16.5/32; a third digit is eighths of a 32nd (2 = 1/4, 6 = 3/4),
 * as CME and dealer screens show it. A tick of 1/64 shows halves (+) only; 1/32 shows whole 32nds.
 */
export function fmt32(price: number, tick = 1 / 256): string {
  if (!Number.isFinite(price)) return '';
  const neg = price < 0;
  let v = Math.abs(price);
  v = Math.round(v / tick) * tick;
  let whole = Math.floor(v + 1e-9);
  const frac32 = (v - whole) * 32;
  let n32 = Math.floor(frac32 + 1e-9);
  let eighth = Math.round((frac32 - n32) * 8);
  if (eighth === 8) {
    eighth = 0;
    n32++;
  }
  if (n32 === 32) {
    n32 = 0;
    whole++;
  }
  let digit = '';
  if (tick < 1 / 32 - 1e-12) {
    if (tick >= 1 / 64 - 1e-12) digit = eighth >= 4 ? '+' : '';
    else digit = eighth === 4 ? '+' : String(eighth);
  }
  return `${neg ? '-' : ''}${whole}-${String(n32).padStart(2, '0')}${digit}`;
}

/** Parse "110-16+", "110-165", "110-16" or a decimal. */
export function parse32(text: string): number | null {
  const t = text.trim();
  const m = /^(-?\d+)-(\d{2})([+0-7])?$/.exec(t);
  if (!m) {
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  const whole = Number(m[1]);
  const n32 = Number(m[2]);
  const e = m[3] === '+' ? 4 : m[3] ? Number(m[3]) : 0;
  const v = Math.abs(whole) + (n32 + e / 8) / 32;
  return whole < 0 ? -v : v;
}

/**
 * How an instrument's prices are written, as the chart API's instrument metadata gives it (dh_chart_ext meta):
 * 32nds (Treasuries), a unit ('%' yields, 'bp' spreads, '' prices) and decimal places.
 */
export interface PriceNotation {
  thirty_seconds?: boolean;
  tick?: number | null;
  decimals: number;
  unit?: string;
}

/** A price in its notation: 32nds, a yield to 2-4 places, or the instrument's decimals. */
export function formatPrice(n: PriceNotation | null | undefined, v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  if (!n) return v.toFixed(3);
  if (n.thirty_seconds) return fmt32(v, n.tick ?? 1 / 256);
  if (n.unit === '%') return v.toFixed(Math.min(4, Math.max(2, n.decimals)));
  return v.toFixed(n.decimals);
}

/** A change: bp for yields, 32nds for Treasury prices, else the price's decimals; signed. */
export function formatChange(n: PriceNotation | null | undefined, d: unknown): string {
  if (typeof d !== 'number' || !Number.isFinite(d)) return '';
  const sign = d > 0 ? '+' : d < 0 ? '-' : '';
  if (!n) return sign + Math.abs(d).toFixed(3);
  if (n.unit === '%') return `${sign}${Math.abs(d * 100).toFixed(1)}bp`;
  if (n.unit === 'bp') return `${sign}${Math.abs(d).toFixed(1)}`;
  if (n.thirty_seconds) return sign + fmt32(Math.abs(d), n.tick ?? 1 / 256);
  return sign + Math.abs(d).toFixed(n.decimals);
}

/** 'up', 'down' or '' for a number's sign (a class name for green and red). */
export const upDown = (v: unknown) => (typeof v === 'number' && v > 0 ? 'up' : typeof v === 'number' && v < 0 ? 'down' : '');
