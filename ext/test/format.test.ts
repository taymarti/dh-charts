import { describe, expect, it } from 'vitest';
import { TickMarkType, type UTCTimestamp } from 'lightweight-charts';
import { priceFormatFor, tickDecimals, timeFormatters } from '../src/format';

describe('tick sizes', () => {
  it.each([
    [0.25, 2],
    [1, 0],
    [0.1, 1],
    [1 / 64, 6],
    [1 / 256, 8],
    [0.00005, 5],
    [0.0000005, 7],
  ])('%f has %i decimals', (tick, d) => expect(tickDecimals(tick)).toBe(d));
  it('makes a price format', () => {
    expect(priceFormatFor(0.25)).toEqual({ type: 'price', precision: 2, minMove: 0.25 });
    expect(priceFormatFor(null)).toEqual({ type: 'price', precision: 2, minMove: 0.01 });
  });
});

describe('timeFormatters', () => {
  const t = (Date.parse('2026-11-18T16:05:30Z') / 1000) as UTCTimestamp;
  it('shows UTC', () => {
    const f = timeFormatters('UTC');
    expect(f.tickMarkFormatter(t, TickMarkType.Time)).toBe('16:05');
    expect(f.tickMarkFormatter(t, TickMarkType.TimeWithSeconds)).toBe('16:05:30');
    expect(f.timeFormatter(t)).toContain('16:05:30');
  });
  it('shows an exchange zone', () => {
    const f = timeFormatters('America/Chicago');
    expect(f.tickMarkFormatter(t, TickMarkType.Time)).toBe('10:05'); // CST
    expect(f.tickMarkFormatter(t, TickMarkType.DayOfMonth)).toBe('18 Nov');
  });
  it('labels the day boundary in the zone, not in UTC', () => {
    const late = (Date.parse('2026-11-19T03:00:00Z') / 1000) as UTCTimestamp; // 21:00 on the 18th in Chicago
    expect(timeFormatters('America/Chicago').tickMarkFormatter(late, TickMarkType.DayOfMonth)).toBe('18 Nov');
    expect(timeFormatters('UTC').tickMarkFormatter(late, TickMarkType.DayOfMonth)).toBe('19 Nov');
  });
});
