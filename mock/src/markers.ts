/**
 * Two kinds of table for the mock server's graph that aren't rows an app writes:
 *
 *   MarkerSource   a node that stands for something that isn't a table (the simulator, a tier, an engine), so the
 *                  "Update graph" panel shows it with its cost
 *   TierTable      every symbol's bars from one tier (bars_1m, bars_1d), as one long table: Sym, Timestamp, OHLCV
 */
import { Engine, Source, D, S, T, instant, type ColumnDef } from './engine';
import type { BarMarket, MockInstrument } from './market';
import type { Tier } from './tiers';

export class MarkerSource extends Source {
  readonly columns: ColumnDef[] = [];
  constructor(engine: Engine, label: string, kind: 'source' | 'op' | 'callback' | 'sink', description: string, parents: Source[] = []) {
    super(engine, label);
    this.kind = kind;
    this.description = description;
    this.parents = parents;
  }
  keys() {
    return [];
  }
  get() {
    return null;
  }
  tick(ms: number, rows: number) {
    this.measure(ms, rows);
  }
}

export class TierTable extends Source {
  readonly columns: ColumnDef[] = [S('Sym'), T('Timestamp'), D('Open'), D('High'), D('Low'), D('Close'), D('Volume')];
  private cache: Int32Array | null = null;
  private cachedN = -1;
  private cachedEpoch = -1;
  private symIdx: number[];

  /** `include`: which instruments are in the table (default: all but the ones typed as expressions) */
  constructor(
    engine: Engine,
    label: string,
    private market: BarMarket,
    readonly tier: Tier,
    include: (i: MockInstrument) => boolean = i => !i.expr,
  ) {
    super(engine, label);
    this.kind = 'op';
    this.description = `every symbol's bars from the ${tier.name} tier`;
    this.symIdx = market.inst.map((_, i) => i).filter(i => include(market.inst[i]));
  }

  keys() {
    const t = this.tier;
    if (this.cache && this.cachedN === t.n && this.cachedEpoch === t.epoch) return this.cache;
    const out: number[] = [];
    for (let p = 0; p < this.symIdx.length; p++) {
      const s = t.series[this.symIdx[p]];
      for (let r = 0; r < t.n; r++) if (Number.isFinite(s.o[r])) out.push((p << 20) | r);
    }
    this.cache = Int32Array.from(out);
    this.cachedN = t.n;
    this.cachedEpoch = t.epoch;
    return this.cache;
  }

  get(key: number, col: string) {
    const p = key >>> 20;
    const r = key & 0xfffff;
    const k = this.symIdx[p];
    if (k == null || r >= this.tier.n) return null;
    const s = this.tier.series[k];
    switch (col) {
      case 'Sym':
        return this.market.inst[k].sym;
      case 'Timestamp':
        return instant(this.tier.times[r] * 1000);
      case 'Open':
        return s.o[r];
      case 'High':
        return s.h[r];
      case 'Low':
        return s.l[r];
      case 'Close':
        return s.c[r];
      case 'Volume':
        return s.v[r];
    }
    return null;
  }

  /** the tier's rows from `from` changed (prevN: its size before); epochChanged: rows were dropped from its head */
  onTier(from: number, prevN: number, epochChanged: boolean) {
    if (epochChanged) {
      const all = Array.from(this.keys());
      return this.note(all, [], all);
    }
    const added: number[] = [];
    const modified: number[] = [];
    for (let p = 0; p < this.symIdx.length; p++) {
      const s = this.tier.series[this.symIdx[p]];
      for (let r = from; r < this.tier.n; r++) {
        if (!Number.isFinite(s.o[r])) continue;
        (r < prevN ? modified : added).push((p << 20) | r);
      }
    }
    this.note(added, modified);
  }
}
