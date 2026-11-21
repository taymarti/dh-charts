/**
 * TimeRangeShading: a Lightweight Charts series primitive that shades time ranges (sessions, auctions,
 * halts, news windows) behind the series. A plain LWC plugin with no Deephaven dependency.
 *
 * Unlike TradingView's session-highlighting example, which paints one column per data bar (as wide
 * as the bar spacing), this paints by time: each range runs from the x of its start to the x of its
 * end. That is what sessions are, and it keeps working on charts whose time scale has more slots than
 * bars, such as Deephaven's TradingView plugin, whose 1-second scaffold makes bar spacing a fraction
 * of a pixel.
 *
 *   series.attachPrimitive(new TimeRangeShading((from, to) => sessionsBetween(from, to)))
 *
 * `rangesFor(from, to)` gets the visible span in UTC seconds and returns the ranges to shade.
 */
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';

export interface ShadedRange {
  /** UTC seconds */
  from: number;
  /** UTC seconds */
  to: number;
  color: string;
}

export type RangesFor = (fromSec: number, toSec: number) => ShadedRange[];

export class TimeRangeShading implements ISeriesPrimitive<Time> {
  private chart: IChartApi | undefined;
  private requestUpdate: (() => void) | undefined;
  private readonly view: IPrimitivePaneView;

  constructor(private rangesFor: RangesFor, private zOrderValue: PrimitivePaneViewZOrder = 'bottom') {
    this.view = {
      zOrder: () => this.zOrderValue,
      renderer: () => this.renderer(),
    };
  }

  attached({ chart, requestUpdate }: SeriesAttachedParameter<Time>): void {
    this.chart = chart;
    this.requestUpdate = requestUpdate;
    requestUpdate();
  }

  detached(): void {
    this.chart = undefined;
    this.requestUpdate = undefined;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  /** Replace the range function and redraw. */
  setRanges(rangesFor: RangesFor): void {
    this.rangesFor = rangesFor;
    this.requestUpdate?.();
  }

  private renderer(): IPrimitivePaneRenderer | null {
    const chart = this.chart;
    if (!chart) return null;
    const ts = chart.timeScale();
    const visible = ts.getVisibleRange();
    if (!visible) return null;
    const from = visible.from as number;
    const to = visible.to as number;
    const ranges = this.rangesFor(from, to);
    if (ranges.length === 0) return null;
    // x of a time: exact when the time is on the scale, else clamped to the pane's edge
    const xOf = (t: number, width: number) => {
      const x = ts.timeToCoordinate(t as UTCTimestamp);
      if (x !== null) return x;
      return t <= from ? 0 : t >= to ? width : null;
    };
    return {
      draw: target =>
        target.useMediaCoordinateSpace(({ context, mediaSize }) => {
          for (const r of ranges) {
            if (r.to <= from || r.from >= to) continue;
            const x1 = xOf(r.from, mediaSize.width);
            const x2 = xOf(r.to, mediaSize.width);
            if (x1 === null || x2 === null || x2 <= x1) continue;
            context.fillStyle = r.color;
            context.fillRect(x1, 0, x2 - x1, mediaSize.height);
          }
        }),
    };
  }
}

/** Convenience: fixed-length blocks alternating between two colours (e.g. 900 s = 15 minutes). */
export function alternatingBlocks(seconds: number, color: string, other = ''): RangesFor {
  return (from, to) => {
    const out: ShadedRange[] = [];
    for (let t = Math.floor(from / seconds) * seconds; t < to; t += seconds) {
      const c = Math.floor(t / seconds) % 2 ? color : other;
      if (c) out.push({ from: t, to: t + seconds, color: c });
    }
    return out;
  };
}
