/**
 * Bar storage for every symbol at three base resolutions, all symbols on one time grid per tier:
 *   1s   the last hour or two (live seconds)
 *   1m   the last five days
 *   1d   two years
 * Chart nodes roll any resolution up from the largest tier that divides it. OHLC are Float32 (exact for tick
 * multiples like k/256), volume too; times are UTC seconds.
 */

export interface SeriesArrays {
  o: Float32Array;
  h: Float32Array;
  l: Float32Array;
  c: Float32Array;
  v: Float32Array;
}

export class Tier {
  times: Float64Array;
  n = 0;
  readonly series: SeriesArrays[] = [];
  /** the lowest row changed since takeDirty() (Infinity: none) */
  private dirty = Infinity;
  /** bumped when rows are dropped from the head: dependents rebuild */
  epoch = 0;
  private cap: number;

  constructor(
    readonly name: '1s' | '1m' | '1d',
    readonly step: number,
    /** first bucket recorded (UTC seconds) */
    public start: number,
    capacity: number,
  ) {
    this.cap = capacity;
    this.times = new Float64Array(capacity);
  }

  addSymbol(): number {
    const mk = () => new Float32Array(this.cap).fill(NaN);
    const s = { o: mk(), h: mk(), l: mk(), c: mk(), v: new Float32Array(this.cap) };
    this.series.push(s);
    return this.series.length - 1;
  }

  private grow() {
    const next = this.cap * 2;
    const g = (a: Float32Array, fill: number) => {
      const x = new Float32Array(next).fill(fill);
      x.set(a.subarray(0, this.n));
      return x;
    };
    const t = new Float64Array(next);
    t.set(this.times.subarray(0, this.n));
    this.times = t;
    for (const s of this.series) {
      s.o = g(s.o, NaN);
      s.h = g(s.h, NaN);
      s.l = g(s.l, NaN);
      s.c = g(s.c, NaN);
      s.v = g(s.v, 0);
    }
    this.cap = next;
  }

  bucket(tSec: number) {
    return Math.floor(tSec / this.step) * this.step;
  }

  /** add one sample of every symbol at tSec (values NaN: no price yet) */
  record(tSec: number, vals: Float64Array, vols: Float64Array) {
    if (tSec < this.start) return;
    const b = this.bucket(tSec);
    const n = this.n;
    let i: number;
    if (n === 0 || b > this.times[n - 1]) {
      if (n === this.cap) this.grow();
      i = n;
      this.times[i] = b;
      this.n = n + 1;
      for (let s = 0; s < this.series.length; s++) {
        const a = this.series[s];
        const v = vals[s];
        a.o[i] = a.h[i] = a.l[i] = a.c[i] = v;
        a.v[i] = vols[s] || 0;
      }
    } else {
      i = n - 1;
      for (let s = 0; s < this.series.length; s++) {
        const v = vals[s];
        if (!Number.isFinite(v)) continue;
        const a = this.series[s];
        if (!Number.isFinite(a.o[i])) a.o[i] = a.h[i] = a.l[i] = v;
        if (v > a.h[i]) a.h[i] = v;
        if (v < a.l[i]) a.l[i] = v;
        a.c[i] = v;
        a.v[i] += vols[s] || 0;
      }
    }
    if (i < this.dirty) this.dirty = i;
  }

  /** the lowest row changed since the last call (-1: none) */
  takeDirty(): number {
    const d = this.dirty;
    this.dirty = Infinity;
    return d === Infinity ? -1 : d;
  }

  /** drop the oldest `count` rows */
  trimHead(count: number) {
    if (count <= 0 || count >= this.n) return;
    this.times.copyWithin(0, count, this.n);
    for (const s of this.series) {
      s.o.copyWithin(0, count, this.n);
      s.h.copyWithin(0, count, this.n);
      s.l.copyWithin(0, count, this.n);
      s.c.copyWithin(0, count, this.n);
      s.v.copyWithin(0, count, this.n);
    }
    this.n -= count;
    this.start = this.times[0];
    this.epoch++;
    this.dirty = 0;
  }

  /** the row index of the bucket at or before tSec (-1: before the first) */
  indexAt(tSec: number): number {
    let lo = 0;
    let hi = this.n - 1;
    if (hi < 0 || tSec < this.times[0]) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.times[mid] <= tSec) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}
