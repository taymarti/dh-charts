import { describe, expect, it } from 'vitest';
import { formatDuration, marketStatus, sessionRanges, type SessionSpec } from '../src/sessions';

// CME equity index futures: Globex 17:00-16:00 Chicago, Sunday evening to Friday; regular hours 08:30-15:00
const ES: SessionSpec = { tz: 'America/Chicago', open: '17:00', close: '16:00', rth: ['08:30', '15:00'], days: [1, 2, 3, 4, 5] };
const at = (iso: string) => Date.parse(iso) / 1000;

describe('marketStatus', () => {
  it('is open in regular hours, until the regular close', () => {
    const s = marketStatus(ES, at('2026-11-18T16:00:00Z')); // Wed 10:00 CST
    expect(s.state).toBe('regular');
    expect(s.until).toBe(at('2026-11-18T21:00:00Z')); // 15:00 CST
  });
  it('is pre-market before regular hours', () => {
    expect(marketStatus(ES, at('2026-11-18T13:00:00Z')).label).toBe('Pre-market'); // 07:00 CST
  });
  it('is after hours between the regular close and the session close', () => {
    expect(marketStatus(ES, at('2026-11-18T21:30:00Z')).label).toBe('After hours'); // 15:30 CST
  });
  it('is closed in the daily halt, until the evening open', () => {
    const s = marketStatus(ES, at('2026-11-18T22:30:00Z')); // 16:30 CST
    expect(s.state).toBe('closed');
    expect(s.until).toBe(at('2026-11-18T23:00:00Z')); // 17:00 CST
  });
  it('is closed on Saturday, until Sunday evening', () => {
    const s = marketStatus(ES, at('2026-11-21T18:00:00Z'));
    expect(s.state).toBe('closed');
    expect(s.until).toBe(at('2026-11-22T23:00:00Z')); // Sun 17:00 CST opens Monday's session
  });
  it('follows daylight saving (CDT in July)', () => {
    expect(marketStatus(ES, at('2026-07-15T15:00:00Z')).state).toBe('regular'); // 10:00 CDT
    expect(marketStatus(ES, at('2026-07-15T21:30:00Z')).state).toBe('closed'); // 16:30 CDT
  });
});

describe('sessionRanges', () => {
  it('shades the weekend as closed', () => {
    const ranges = sessionRanges(ES, at('2026-11-20T00:00:00Z'), at('2026-11-23T12:00:00Z'));
    const closed = ranges.filter(r => r.color.includes('120, 123, 134'));
    // Friday 16:00 CST to Sunday 17:00 CST is closed
    expect(closed.some(r => r.from <= at('2026-11-20T22:00:00Z') && r.to >= at('2026-11-22T23:00:00Z'))).toBe(true);
    expect(ranges.length).toBeGreaterThan(2);
  });
  it('refuses spans over 120 days', () => {
    expect(sessionRanges(ES, 0, 200 * 86400)).toEqual([]);
  });
});

describe('formatDuration', () => {
  it.each([
    [45, '45s'],
    [14 * 60, '14m'],
    [2 * 3600 + 5 * 60, '2h 05m'],
    [3 * 86400 + 4 * 3600, '3d 4h'],
  ])('%i s is %s', (s, out) => expect(formatDuration(s)).toBe(out));
});
