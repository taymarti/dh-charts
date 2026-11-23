/**
 * The market's place in the mock server's cycle: first in each cycle, step the app's market, then tell the chart
 * nodes and the tier tables which bars changed (each tier's dirty rows), so everything built on the bars updates
 * in the same cycle, as it would on a server.
 */
import type { Engine } from './engine';
import type { BarMarket } from './market';
import type { MarkerSource, TierTable } from './markers';
import type { NodeCache } from './nodes';
import type { Tier } from './tiers';

export interface MarketTickerOptions {
  /** the tier tables to notify (bars_1m, bars_1d...): a getter, since they are often built after the ticker */
  tierTables?: () => TierTable[];
  /** a graph node to charge the step's cost to (the simulator) */
  marker?: () => MarkerSource | null;
}

/** Adds the market's ticker to `engine`: step(now) moves the market (fills its tiers); then nodes and tables follow. */
export function addMarketTicker(engine: Engine, market: BarMarket, nodes: NodeCache, step: (now: number) => void, opts: MarketTickerOptions = {}) {
  const tiers = () => [market.tiers.s1, market.tiers.m1, market.tiers.d1];
  const seen = new Map<Tier, { n: number; epoch: number }>();
  for (const t of tiers()) seen.set(t, { n: t.n, epoch: t.epoch });
  engine.addTicker('market', now => {
    const t0 = performance.now();
    step(now);
    const dirty = new Map<Tier, number>();
    const tables = opts.tierTables?.() ?? [];
    for (const t of tiers()) {
      const from = t.takeDirty();
      const before = seen.get(t)!;
      dirty.set(t, from);
      if (from >= 0) for (const tt of tables) if (tt.tier === t) tt.onTier(from, before.n, before.epoch !== t.epoch);
      seen.set(t, { n: t.n, epoch: t.epoch });
    }
    nodes.onTiers(dirty);
    opts.marker?.()?.tick(performance.now() - t0, market.inst.length);
  });
}
