import { describe, expect, it } from 'vitest';
import { paneIndexes, pointOf } from '../src/price-chart';
import type { FeedRow } from '../src/feed';
import { describeAlert } from '../src/alerts';

describe('paneIndexes', () => {
  it('puts overlays on the price pane and other panes below in first-seen order', () => {
    expect(
      paneIndexes([{ column: 'EMA_20' }, { column: 'RSI_14', pane: 'rsi' }, { column: 'Volume', pane: 'volume' }, { column: 'RSI_7', pane: 'rsi' }]),
    ).toEqual({ overlay: 0, rsi: 1, volume: 2 });
  });
});

describe('pointOf', () => {
  const r = { time: 100, Open: 1, High: 3, Low: 0.5, Close: 2, EMA_20: null } as unknown as FeedRow;
  it('makes OHLC points', () => {
    expect(pointOf(r, 'ohlc')).toEqual({ time: 100, open: 1, high: 3, low: 0.5, close: 2 });
  });
  it('makes a gap for a null value', () => {
    expect(pointOf(r, 'EMA_20')).toEqual({ time: 100 });
    expect(pointOf(r, 'Close')).toEqual({ time: 100, value: 2 });
  });
});

describe('describeAlert', () => {
  it('reads like a sentence', () => {
    expect(describeAlert({ sym: 'ES', source: 'Last', kind: 'price', op: 'cross', level: 100.25 })).toBe('ES crosses 100.25');
  });
});
