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
