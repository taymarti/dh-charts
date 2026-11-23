/**
 * The backtest runner: a Web Worker standing in for the CEP's process (cep_sim/runner.py). It gets the spec and
 * the bars, runs the strategy over them in time order, and posts what it does: orders, trades, positions,
 * plotted values, equity, progress. The page writes those into the run's tables. A worker can be terminated,
 * so a runaway strategy is stopped by Cancel.
 *
 * The strategy is JavaScript with the same DSL as the Python runner:
 *   function on_start(ctx) {}            optional
 *   function on_bar(ctx, bar) {}         every bar of every symbol, in time order; bar: {sym, time, open, high, low, close, volume}
 *   function on_end(ctx) {}              optional
 *   ctx.param(name, default) ctx.state ctx.position(sym) ctx.cash ctx.equity()
 *   ctx.ema(key, n, x) ctx.sma(key, n, x) ctx.plot(name, value, sym) ctx.target(sym, qty) ctx.buy / sell(sym, qty) ctx.log(text)
 */

interface Spec {
  code: string;
  params: Record<string, unknown>;
  speed: number;
  bars: Record<string, { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[] }>;
  multipliers: Record<string, number>;
}

type Out = Record<string, unknown> & { event: string };

const post = (m: Out) => (self as unknown as Worker).postMessage(m);

self.onmessage = (e: MessageEvent<Spec>) => {
  try {
    run(e.data);
  } catch (err) {
    post({ event: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

function run(spec: Spec) {
  const fns = new Function(
    'ctx',
    `"use strict";\n${spec.code}\n;return { on_start: typeof on_start === 'function' ? on_start : null, on_bar: typeof on_bar === 'function' ? on_bar : null, on_end: typeof on_end === 'function' ? on_end : null };`,
  )(null) as { on_start: ((c: unknown) => void) | null; on_bar: ((c: unknown, b: unknown) => void) | null; on_end: ((c: unknown) => void) | null };
  if (!fns.on_bar) throw new Error('the strategy has no on_bar(ctx, bar)');

  const capital = Number(spec.params.capital ?? 1_000_000);
  const commission = Number(spec.params.commission ?? 1.5);
  // every bar of every symbol, in time order
  const events: Array<{ sym: string; i: number; t: number }> = [];
  for (const [sym, b] of Object.entries(spec.bars)) for (let i = 0; i < b.t.length; i++) events.push({ sym, i, t: b.t[i] });
  events.sort((a, b) => a.t - b.t || a.sym.localeCompare(b.sym));

  const pos: Record<string, number> = {};
  const avg: Record<string, number> = {};
  const last: Record<string, number> = {};
  const ind: Record<string, { v: number; q?: number[] }> = {};
  let cash = capital;
  let realized = 0;
  let trades = 0;
  let peak = capital;
  let maxdd = 0;
  let now = 0;
  let logs = 0;
  const mult = (s: string) => spec.multipliers[s] ?? 1;
  const unreal = () => Object.keys(pos).reduce((a, s) => a + (pos[s] ? pos[s] * (last[s] - avg[s]) * mult(s) : 0), 0);
  const equity = () => capital + realized + unreal();

  const fill = (sym: string, qty: number) => {
    if (!qty) return;
    const px = last[sym];
    post({ event: 'order', Timestamp: now, Sym: sym, Side: qty > 0 ? 'Buy' : 'Sell', Qty: Math.abs(qty), Type: 'Market', Price: px, Status: 'Filled' });
    const p = pos[sym] ?? 0;
    let pnl = 0;
    if (p && Math.sign(p) !== Math.sign(qty)) {
      const closed = Math.min(Math.abs(p), Math.abs(qty));
      pnl = closed * Math.sign(p) * (px - avg[sym]) * mult(sym);
      realized += pnl;
    }
    const next = p + qty;
    if (!next) avg[sym] = 0;
    else if (!p || Math.sign(p) === Math.sign(qty)) avg[sym] = ((avg[sym] ?? 0) * Math.abs(p) + px * Math.abs(qty)) / Math.abs(next);
    else if (Math.sign(next) !== Math.sign(p)) avg[sym] = px;
    pos[sym] = next;
    const fee = commission * Math.abs(qty);
    realized -= fee;
    cash += pnl - fee;
    trades++;
    post({ event: 'trade', Timestamp: now, Sym: sym, Side: qty > 0 ? 'Buy' : 'Sell', Qty: Math.abs(qty), Price: px, Commission: fee, RealizedPnl: pnl });
    post({ event: 'position', Sym: sym, Qty: next, AvgPrice: avg[sym], Unrealized: next * (px - avg[sym]) * mult(sym), Updated: now });
  };

  const ctx = {
    state: {} as Record<string, unknown>,
    get cash() {
      return cash;
    },
    params: spec.params,
    param: (name: string, d?: unknown) => (name in spec.params ? spec.params[name] : d),
    position: (sym: string) => pos[sym] ?? 0,
    equity,
    ema: (key: string, n: number, x: number) => {
      const s = (ind[key] ??= { v: x });
      s.v = s.v + (2 / (n + 1)) * (x - s.v);
      return s.v;
    },
    sma: (key: string, n: number, x: number) => {
      const s = (ind[key] ??= { v: x, q: [] });
      s.q!.push(x);
      if (s.q!.length > n) s.q!.shift();
      s.v = s.q!.reduce((a, b) => a + b, 0) / s.q!.length;
      return s.v;
    },
    plot: (name: string, value: number, sym = '') => post({ event: 'signal', Timestamp: now, Sym: sym, Kind: 'plot', Name: name, Value: value }),
    target: (sym: string, qty: number) => fill(sym, qty - (pos[sym] ?? 0)),
    buy: (sym: string, qty = 1) => fill(sym, Math.abs(qty)),
    sell: (sym: string, qty = 1) => fill(sym, -Math.abs(qty)),
    log: (text: unknown) => logs++ < 200 && post({ event: 'log', text: String(text) }),
  };

  post({ event: 'started', of: events.length });
  fns.on_start?.(ctx);
  const speed = Math.max(50, Number(spec.speed) || 2000); // bars per second
  const chunk = Math.max(1, Math.round(speed / 20));
  let k = 0;
  let lastEq = -1;
  const step = () => {
    const end = Math.min(events.length, k + chunk);
    for (; k < end; k++) {
      const ev = events[k];
      const b = spec.bars[ev.sym];
      now = ev.t * 1000;
      last[ev.sym] = b.c[ev.i];
      fns.on_bar!(ctx, { sym: ev.sym, time: ev.t, open: b.o[ev.i], high: b.h[ev.i], low: b.l[ev.i], close: b.c[ev.i], volume: b.v[ev.i] });
      const eq = equity();
      peak = Math.max(peak, eq);
      maxdd = Math.max(maxdd, peak - eq);
      if (k % 10 === 0 || k === events.length - 1) {
        if (eq !== lastEq) post({ event: 'equity', Timestamp: now, Equity: eq, Cash: cash, Drawdown: peak - eq });
        lastEq = eq;
        for (const s of Object.keys(pos)) if (pos[s]) post({ event: 'position', Sym: s, Qty: pos[s], AvgPrice: avg[s], Unrealized: pos[s] * (last[s] - avg[s]) * mult(s), Updated: now });
      }
    }
    post({ event: 'progress', bars: k, of: events.length, equity: equity(), trades, pnl: equity() - capital, maxdrawdown: maxdd });
    if (k < events.length) setTimeout(step, 50);
    else {
      fns.on_end?.(ctx);
      post({ event: 'done', summary: { equity: equity(), pnl: equity() - capital, trades, maxdrawdown: maxdd } });
    }
  };
  step();
}
