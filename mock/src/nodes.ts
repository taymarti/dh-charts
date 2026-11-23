/**
 * Charts on demand as shared nodes, as in dh_chart_ext.nodes / cache: one instrument's bars at a resolution
 * with the studies' columns, built when a client first asks and shared by everyone asking for the same thing.
 * Requests are made canonical first (2m = 120s; studies by key, sorted), so equal requests share one node.
 * Each node is reference-counted; at zero it is kept for a grace period (a reload reuses it), then released and
 * no longer updated. `chart_nodes` is the cache as a live table.
 *
 * Resolutions roll up from the largest base tier that divides them: under a minute from the 1s tier, minutes
 * and hours from the 1m tier, days and weeks from the daily tier.
 */
import { makeStudy, type Bars, type Study, type StudyContext } from '@acme/chart-ext';
import { Engine, RowSource, SeriesSource, D, I, L, S, T, type ColumnDef } from './engine';
import type { BarMarket as Market } from './market';
import type { Tier } from './tiers';

export function resolutionSecs(res: string | number): number {
  if (typeof res === 'number') return res;
  const r = res.trim();
  const iso = /^PT(\d+)([SMH])$/i.exec(r);
  if (iso) return Number(iso[1]) * ({ S: 1, M: 60, H: 3600 } as Record<string, number>)[iso[2].toUpperCase()];
  const m = /^(\d+)\s*(s|m|h|d|D|w|W)$/.exec(r);
  if (!m) throw new Error(`unknown resolution ${res}`);
  const n = Number(m[1]);
  const mult = { s: 1, m: 60, h: 3600, d: 86400, D: 86400, w: 604800, W: 604800 }[m[2]]!;
  const secs = n * mult;
  if (secs < 1 || secs > 604800) throw new Error(`resolution ${res} is out of range (1s to 1W)`);
  return secs;
}

export function resolutionName(secs: number): string {
  if (secs % 604800 === 0) return `${secs / 604800}W`;
  if (secs % 86400 === 0) return `${secs / 86400}D`;
  if (secs % 3600 === 0) return `${secs / 3600}h`;
  if (secs % 60 === 0) return `${secs / 60}m`;
  return `${secs}s`;
}

export const RESOLUTIONS = ['1s', '5s', '15s', '30s', '1m', '2m', '3m', '5m', '10m', '15m', '30m', '1h', '2h', '4h', '1D', '1W'];

const WEEK_OFFSET = 4 * 86400; // the epoch was a Thursday: weeks start on Monday

const BAR_COLUMNS: ColumnDef[] = [T('Timestamp', 'Bar start'), D('Open'), D('High'), D('Low'), D('Close'), D('Volume')];

/** One symbol's bars at one resolution, with study columns. */
export class BarNode extends SeriesSource {
  readonly tier: Tier;
  readonly symIdx: number;
  /** first tier row of each bar */
  private first = new Int32Array(1024);
  private epoch: number;
  private ctx: StudyContext;

  constructor(
    engine: Engine,
    readonly market: Market,
    readonly sym: string,
    readonly res: number,
    readonly studies: Study[],
  ) {
    const cols = [...BAR_COLUMNS, ...studies.flatMap(s => s.columns.filter(c => c !== 'Volume').map(c => D(c, `${s.type} ${Object.values(s.params).join(' ')}`)))];
    super(engine, `${sym} ${resolutionName(res)}${studies.length ? ' + ' + studies.map(s => s.key).join(', ') : ''}`, cols, { capacity: 1024, kind: 'op' });
    const t = market.tiers;
    this.tier = res % 86400 === 0 ? t.d1 : res % 60 === 0 ? t.m1 : t.s1;
    const k = market.index.get(sym);
    if (k == null) throw new Error(`unknown symbol ${sym}`);
    this.symIdx = k;
    this.epoch = this.tier.epoch;
    const inst = market.inst[k];
    this.ctx = { additive: inst.unit === '%' || inst.unit === 'bp', bpPerUnit: inst.unit === '%' ? 100 : 1, barSeconds: res };
    this.description = `rollup of the ${this.tier.name} tier to ${resolutionName(res)}${studies.length ? ', with ' + studies.map(s => s.key).join(', ') : ''}`;
    this.rebuild();
  }

  private bucket(t: number) {
    if (this.res % 604800 === 0) return Math.floor((t - WEEK_OFFSET) / this.res) * this.res + WEEK_OFFSET;
    return Math.floor(t / this.res) * this.res;
  }

  private bars(): Bars {
    const d = this.data;
    return { t: d.Timestamp, o: d.Open, h: d.High, l: d.Low, c: d.Close, v: d.Volume, n: this.n };
  }

  private growFirst(n: number) {
    if (n <= this.first.length) return;
    let c = this.first.length;
    while (c < n) c *= 2;
    const g = new Int32Array(c);
    g.set(this.first);
    this.first = g;
  }

  /** aggregate tier rows from `row` on, into bars starting at bar index `bar` */
  private aggregate(row: number, bar: number) {
    const tier = this.tier;
    const s = tier.series[this.symIdx];
    const d = this.data;
    let n = bar;
    for (let r = row; r < tier.n; r++) {
      const o = s.o[r];
      if (!Number.isFinite(o)) continue;
      const b = this.bucket(tier.times[r]);
      if (n === 0 || d.Timestamp[n - 1] !== b) {
        this.n = n; // ensure() keeps rows [0, this.n) when it grows the arrays
        this.ensure(n + 1);
        this.growFirst(n + 1);
        d.Timestamp[n] = b;
        d.Open[n] = o;
        d.High[n] = s.h[r];
        d.Low[n] = s.l[r];
        d.Close[n] = s.c[r];
        d.Volume[n] = s.v[r];
        this.first[n] = r;
        n++;
      } else {
        const i = n - 1;
        if (s.h[r] > d.High[i]) d.High[i] = s.h[r];
        if (s.l[r] < d.Low[i]) d.Low[i] = s.l[r];
        d.Close[i] = s.c[r];
        d.Volume[i] += s.v[r];
      }
    }
    this.n = n;
  }

  private computeStudies(from: number) {
    if (!this.studies.length) return;
    this.ensure(this.n);
    const b = this.bars();
    for (const st of this.studies) {
      for (const k of Object.keys(st.state))
        if (st.state[k].length < this.data.Timestamp.length) {
          const g = new Float64Array(this.data.Timestamp.length);
          g.set(st.state[k]);
          st.state[k] = g;
        }
      st.compute(b, this.data, from, this.ctx);
    }
  }

  rebuild() {
    const prev = this.n;
    this.n = 0;
    this.aggregate(0, 0);
    this.computeStudies(0);
    this.epoch = this.tier.epoch;
    if (prev) this.rebuilt(prev);
  }

  /** the tier changed from `row` on */
  refresh(row: number) {
    if (this.closed) return;
    if (this.tier.epoch !== this.epoch) return this.rebuild();
    const t0 = performance.now();
    const prev = this.n;
    // the bar containing that row: the last bar whose first row is <= row
    let bar = this.n - 1;
    while (bar > 0 && this.first[bar] > row) bar--;
    if (bar < 0) bar = 0;
    const startRow = this.n ? this.first[bar] : 0;
    this.aggregate(startRow, bar);
    this.computeStudies(bar);
    this.commitFrom(bar, prev);
    this.measure(performance.now() - t0, this.n - bar);
  }
}

// ----------------------------------------------------------------------------- the cache

interface Entry {
  key: string;
  node: BarNode;
  refs: number;
  idleSince: number | null;
  buildMs: number;
  row: number;
}

export class NodeCache {
  readonly entries = new Map<string, Entry>();
  readonly table: RowSource;
  private byTier = new Map<Tier, Set<BarNode>>();
  readonly graceMs = 60_000;
  readonly limit = 300;

  constructor(
    readonly engine: Engine,
    readonly market: Market,
  ) {
    this.table = new RowSource(
      engine,
      'chart_nodes',
      [S('Key'), S('Sym'), S('Res'), S('Studies'), I('Refs'), L('Rows'), D('BuildMs'), S('State'), T('IdleSince')],
      { keyCols: ['Key'], kind: 'op', description: 'the chart node cache: shared nodes, their holders and size' },
    );
    engine.addTicker('chart node upkeep', now => this.upkeep(now));
  }

  canonical(sym: string, res: string | number, studies: Array<string | { type: string; params?: Record<string, number> }>) {
    const secs = resolutionSecs(res);
    const objs = new Map<string, Study>();
    for (const s of studies) {
      const st = makeStudy(s);
      objs.set(st.key, st);
    }
    const keys = [...objs.keys()].sort();
    return { secs, studies: keys.map(k => objs.get(k)!), key: JSON.stringify(['chart', sym, secs, keys]) };
  }

  /** a node, held until `release` is called */
  acquire(sym: string, res: string | number, studies: Array<string | { type: string; params?: Record<string, number> }> = []) {
    const { secs, studies: objs, key } = this.canonical(sym, res, studies);
    let e = this.entries.get(key);
    if (!e) {
      if (this.entries.size >= this.limit) this.evictIdle(true);
      const t0 = performance.now();
      const node = new BarNode(this.engine, this.market, sym, secs, objs);
      node.parents = [];
      e = { key, node, refs: 0, idleSince: null, buildMs: performance.now() - t0, row: -1 };
      this.entries.set(key, e);
      let set = this.byTier.get(node.tier);
      if (!set) this.byTier.set(node.tier, (set = new Set()));
      set.add(node);
    }
    e.refs++;
    e.idleSince = null;
    this.write(e);
    const mine = e;
    let released = false;
    return {
      key: JSON.parse(key) as unknown[],
      keyText: key,
      node: e.node,
      release: () => {
        if (released) return;
        released = true;
        mine.refs = Math.max(0, mine.refs - 1);
        if (mine.refs === 0) mine.idleSince = Date.now();
        this.write(mine);
      },
    };
  }

  private write(e: Entry) {
    const [, sym, secs, studies] = JSON.parse(e.key) as [string, string, number, string[]];
    this.table.put([
      {
        Key: e.key, Sym: sym, Res: resolutionName(secs), Studies: studies.join(', '), Refs: e.refs, Rows: e.node.n,
        BuildMs: Math.round(e.buildMs * 10) / 10, State: e.refs ? 'held' : 'idle', IdleSince: e.idleSince ? new Date(e.idleSince) : null,
      },
    ]);
  }

  private evictIdle(force = false) {
    const now = Date.now();
    for (const e of [...this.entries.values()]) {
      if (e.refs > 0 || e.idleSince == null) continue;
      if (!force && now - e.idleSince < this.graceMs) continue;
      this.entries.delete(e.key);
      this.byTier.get(e.node.tier)?.delete(e.node);
      e.node.close();
      const k = this.table.find([e.key]);
      if (k != null) this.table.remove([k]);
      if (force) return;
    }
  }

  private lastRows = 0;

  /** the market ticker's changed rows per tier, this cycle */
  onTiers(dirty: Map<Tier, number>) {
    for (const [tier, nodes] of this.byTier) {
      const from = dirty.get(tier) ?? -1;
      if (from < 0) continue;
      for (const n of nodes) n.refresh(from);
    }
  }

  private upkeep(now: number) {
    if (now - this.lastRows > 5000) {
      this.lastRows = now;
      for (const e of this.entries.values()) {
        const k = this.table.find([e.key]);
        if (k != null && this.table.get(k, 'Rows') !== e.node.n) this.table.patch(k, { Rows: e.node.n });
      }
      this.evictIdle();
    }
  }

  stats() {
    return [...this.entries.values()].map(e => ({ key: JSON.parse(e.key), refs: e.refs, rows: e.node.n, idle_since: e.idleSince }));
  }
}
