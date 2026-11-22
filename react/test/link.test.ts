import { describe, expect, it, vi } from 'vitest';
import { createLinkBus } from '../src/link';

describe('createLinkBus', () => {
  it('shares a value within a group', () => {
    const bus = createLinkBus();
    const chart = vi.fn();
    bus.subscribe('red', 'symbol', chart);
    bus.set('red', 'symbol', 'NQ', 'watchlist');
    expect(chart).toHaveBeenCalledWith('NQ', 'watchlist');
    expect(bus.get('red', 'symbol')).toBe('NQ');
  });

  it('keeps groups apart', () => {
    const bus = createLinkBus();
    const blue = vi.fn();
    bus.subscribe('blue', 'symbol', blue);
    bus.set('red', 'symbol', 'NQ');
    expect(blue).not.toHaveBeenCalled();
    expect(bus.get('blue', 'symbol')).toBeUndefined();
  });

  it('does not tell listeners about an unchanged value', () => {
    const bus = createLinkBus({ red: { symbol: 'ES' } });
    const l = vi.fn();
    bus.subscribe('red', 'symbol', l);
    bus.set('red', 'symbol', 'ES');
    expect(l).not.toHaveBeenCalled();
  });

  it('stops after unsubscribe', () => {
    const bus = createLinkBus();
    const l = vi.fn();
    bus.subscribe('red', 'symbol', l)();
    bus.set('red', 'symbol', 'NQ');
    expect(l).not.toHaveBeenCalled();
  });

  it('saves and restores a group', () => {
    const bus = createLinkBus();
    bus.set('red', 'symbol', 'NQ');
    bus.set('red', 'interval', '2m');
    const saved = bus.snapshot('red');
    expect(saved).toEqual({ symbol: 'NQ', interval: '2m' });
    const other = createLinkBus();
    const l = vi.fn();
    other.subscribe('red', 'interval', l);
    other.restore('red', saved);
    expect(l).toHaveBeenCalledWith('2m', undefined);
    expect(other.get('red', 'symbol')).toBe('NQ');
  });
});
