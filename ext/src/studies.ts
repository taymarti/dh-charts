/**
 * Indicators (studies) computed on bars, the same contract as dh_chart_ext.data: a study has a key
 * ("EMA_20", "BB_20_2", "MACD_12_26_9"), output columns, and a pane ("overlay" or its own: "rsi", "macd"...).
 * Computation is incremental: compute(from) recomputes rows from..n-1 using the outputs before `from`, so a
 * live chart node only redoes its last bar each cycle.
 *
 * Applicability: studies that need volume (VWAP, Volume) are only offered for instruments that trade; for
 * yields and spreads (additive units) ROC is a change, not a percentage, and realized vol is in bp.
 */

export interface StudyType {
  label: string;
  group: string;
  params: Record<string, number>;
  pane: string;
  levels?: number[];
  needsVolume?: boolean;
  description: string;
}

export const STUDY_TYPES: Record<string, StudyType> = {
  EMA: { label: 'Moving Average Exponential', group: 'Moving averages', params: { length: 20 }, pane: 'overlay', description: 'Exponential moving average of the close' },
  SMA: { label: 'Moving Average', group: 'Moving averages', params: { length: 20 }, pane: 'overlay', description: 'Simple moving average of the close' },
  WMA: { label: 'Moving Average Weighted', group: 'Moving averages', params: { length: 20 }, pane: 'overlay', description: 'Linearly weighted moving average' },
  BB: { label: 'Bollinger Bands', group: 'Bands and channels', params: { length: 20, mult: 2.0 }, pane: 'overlay', description: 'SMA ± mult standard deviations' },
  KC: { label: 'Keltner Channels', group: 'Bands and channels', params: { length: 20, mult: 1.5 }, pane: 'overlay', description: 'EMA ± mult ATR' },
  DC: { label: 'Donchian Channels', group: 'Bands and channels', params: { length: 20 }, pane: 'overlay', description: 'Highest high and lowest low' },
  VWAP: { label: 'VWAP', group: 'Volume', params: {}, pane: 'overlay', needsVolume: true, description: 'Volume-weighted average price, resets each New York day' },
  Volume: { label: 'Volume', group: 'Volume', params: {}, pane: 'volume', needsVolume: true, description: 'Contracts or shares traded per bar' },
  RSI: { label: 'Relative Strength Index', group: 'Oscillators', params: { length: 14 }, pane: 'rsi', levels: [30, 70], description: "Wilder's RSI" },
  STOCH: { label: 'Stochastic', group: 'Oscillators', params: { k: 14, d: 3 }, pane: 'stoch', levels: [20, 80], description: '%K and its %D signal' },
  MACD: { label: 'MACD', group: 'Momentum', params: { fast: 12, slow: 26, signal: 9 }, pane: 'macd', levels: [0], description: 'EMA difference, signal line and histogram' },
  ROC: { label: 'Rate of Change', group: 'Momentum', params: { length: 10 }, pane: 'roc', levels: [0], description: 'Percent change (prices) or change (yields, spreads) over length bars' },
  ATR: { label: 'Average True Range', group: 'Volatility', params: { length: 14 }, pane: 'atr', description: "Wilder's average true range" },
  RVOL: { label: 'Realized Volatility', group: 'Volatility', params: { length: 20 }, pane: 'rvol', description: 'Annualized: % for prices, bp for yields and spreads' },
  ZSCORE: { label: 'Z-Score', group: 'Statistics', params: { length: 50 }, pane: 'zscore', levels: [-2, 0, 2], description: 'Distance from the rolling mean in standard deviations' },
};

export interface Bars {
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
  n: number;
}

export interface StudyContext {
  /** additive units (yields %, bp): changes rather than returns */
  additive: boolean;
  /** bp per unit (100 for %, 1 for bp) */
  bpPerUnit: number;
  /** bar length in seconds (for annualizing) */
  barSeconds: number;
}

export interface Study {
  key: string;
  type: string;
  params: Record<string, number>;
  pane: string;
  levels?: number[];
  columns: string[];
  histogram: Set<string>;
  /** fill outputs[col] for rows from..n-1 */
  compute(b: Bars, out: Record<string, Float64Array>, from: number, ctx: StudyContext): void;
  /** internal state arrays (grown with the node) */
  state: Record<string, Float64Array>;
}

// keys and column names write a non-integer with p for the point (KC_20_1p5), as the Deephaven server does:
// a column name cannot hold a dot
const fmt = (v: number) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4))).replace('.', 'p'));

/** A study from "EMA_20", "BB_20_2" or { type: "EMA", params: { length: 20 } }. Throws on bad input. */
export function makeStudy(spec: string | { type: string; params?: Record<string, number> }): Study {
  let type: string;
  let given: Record<string, unknown> = {};
  if (typeof spec === 'string') {
    const [t, ...vals] = spec.split('_');
    type = t;
    const st = STUDY_TYPES[type];
    if (!st) throw new Error(`unknown study ${spec}`);
    Object.keys(st.params).forEach((k, i) => vals[i] !== undefined && (given[k] = vals[i].replace('p', '.')));
  } else {
    type = String(spec.type);
    given = { ...(spec.params ?? {}) };
  }
  const st = STUDY_TYPES[type];
  if (!st) throw new Error(`unknown study type ${type}`);
  const params: Record<string, number> = {};
  for (const [k, d] of Object.entries(st.params)) {
    const v = Number(given[k] ?? d);
    if (!Number.isFinite(v)) throw new Error(`bad ${k} for ${type}: ${given[k]}`);
    if (Number.isInteger(d)) {
      if (!Number.isInteger(v) || v < 1 || v > 1000) throw new Error(`${type} ${k} must be a whole number 1..1000`);
    } else if (!(v > 0 && v <= 10)) throw new Error(`${type} ${k} must be in (0, 10]`);
    params[k] = v;
  }
  const key = [type, ...Object.values(params).map(fmt)].join('_');
  const P = params;
  const mk = (cols: string[], compute: Study['compute'], histogram: string[] = []): Study => ({
    key, type, params, pane: st.pane, levels: st.levels, columns: cols, histogram: new Set(histogram), compute, state: {},
  });
  switch (type) {
    case 'EMA':
      return mk([key], (b, o, f) => ema(b.c, o[key], f, b.n, P.length));
    case 'SMA':
      return mk([key], (b, o, f) => sma(b.c, o[key], f, b.n, P.length));
    case 'WMA':
      return mk([key], (b, o, f) => {
        const n = P.length;
        const w = (n * (n + 1)) / 2;
        for (let i = f; i < b.n; i++) {
          if (i < n - 1) {
            o[key][i] = NaN;
            continue;
          }
          let s = 0;
          for (let j = 0; j < n; j++) s += b.c[i - j] * (n - j);
          o[key][i] = s / w;
        }
      });
    case 'BB': {
      const [u, m, l] = [`${key}_Upper`, `${key}_Mid`, `${key}_Lower`];
      return mk([u, m, l], (b, o, f) => {
        const n = P.length;
        for (let i = f; i < b.n; i++) {
          if (i < n - 1) {
            o[u][i] = o[m][i] = o[l][i] = NaN;
            continue;
          }
          let s = 0;
          let q = 0;
          for (let j = 0; j < n; j++) {
            const x = b.c[i - j];
            s += x;
            q += x * x;
          }
          const mean = s / n;
          const sd = Math.sqrt(Math.max(0, q / n - mean * mean));
          o[m][i] = mean;
          o[u][i] = mean + P.mult * sd;
          o[l][i] = mean - P.mult * sd;
        }
      });
    }
    case 'KC': {
      const [u, m, l] = [`${key}_Upper`, `${key}_Mid`, `${key}_Lower`];
      const s = mk([u, m, l], (b, o, f) => {
        s.state.atr ??= new Float64Array(o[m].length);
        ema(b.c, o[m], f, b.n, P.length);
        atr(b, s.state.atr, f, P.length);
        for (let i = f; i < b.n; i++) {
          o[u][i] = o[m][i] + P.mult * s.state.atr[i];
          o[l][i] = o[m][i] - P.mult * s.state.atr[i];
        }
      });
      return s;
    }
    case 'DC': {
      const [u, m, l] = [`${key}_Upper`, `${key}_Mid`, `${key}_Lower`];
      return mk([u, m, l], (b, o, f) => {
        const n = P.length;
        for (let i = f; i < b.n; i++) {
          let hh = -Infinity;
          let ll = Infinity;
          for (let j = Math.max(0, i - n + 1); j <= i; j++) {
            if (b.h[j] > hh) hh = b.h[j];
            if (b.l[j] < ll) ll = b.l[j];
          }
          o[u][i] = hh;
          o[l][i] = ll;
          o[m][i] = (hh + ll) / 2;
        }
      });
    }
    case 'VWAP': {
      const s = mk([key], (b, o, f) => {
        s.state.pv ??= new Float64Array(o[key].length);
        s.state.vv ??= new Float64Array(o[key].length);
        const pv = s.state.pv;
        const vv = s.state.vv;
        for (let i = f; i < b.n; i++) {
          const tp = (b.h[i] + b.l[i] + b.c[i]) / 3;
          const v = b.v[i] || 0;
          const day = Math.floor((b.t[i] - 22 * 3600) / 86400); // New York session day (17:00 ET)
          const prevDay = i > 0 ? Math.floor((b.t[i - 1] - 22 * 3600) / 86400) : -1;
          const fresh = i === 0 || day !== prevDay;
          pv[i] = (fresh ? 0 : pv[i - 1]) + tp * v;
          vv[i] = (fresh ? 0 : vv[i - 1]) + v;
          o[key][i] = vv[i] > 0 ? pv[i] / vv[i] : tp;
        }
      });
      return s;
    }
    case 'Volume':
      return mk(['Volume'], () => {}, ['Volume']);
    case 'RSI': {
      const s = mk([key], (b, o, f) => {
        s.state.g ??= new Float64Array(o[key].length);
        s.state.l ??= new Float64Array(o[key].length);
        const G = s.state.g;
        const Ls = s.state.l;
        const n = P.length;
        for (let i = f; i < b.n; i++) {
          if (i === 0) {
            G[0] = Ls[0] = 0;
            o[key][0] = NaN;
            continue;
          }
          const d = b.c[i] - b.c[i - 1];
          const up = d > 0 ? d : 0;
          const dn = d < 0 ? -d : 0;
          G[i] = (G[i - 1] * (n - 1) + up) / n;
          Ls[i] = (Ls[i - 1] * (n - 1) + dn) / n;
          o[key][i] = i < n ? NaN : Ls[i] === 0 ? 100 : 100 - 100 / (1 + G[i] / Ls[i]);
        }
      });
      return s;
    }
    case 'STOCH': {
      const [k, d] = [`${key}_K`, `${key}_D`];
      return mk([k, d], (b, o, f) => {
        for (let i = f; i < b.n; i++) {
          let hh = -Infinity;
          let ll = Infinity;
          for (let j = Math.max(0, i - P.k + 1); j <= i; j++) {
            if (b.h[j] > hh) hh = b.h[j];
            if (b.l[j] < ll) ll = b.l[j];
          }
          o[k][i] = i < P.k - 1 ? NaN : hh === ll ? 50 : (100 * (b.c[i] - ll)) / (hh - ll);
        }
        sma(o[k], o[d], f, b.n, P.d);
      });
    }
    case 'MACD': {
      const [m, sg, h] = [key, `${key}_Signal`, `${key}_Hist`];
      const s = mk(
        [m, sg, h],
        (b, o, f) => {
          s.state.fast ??= new Float64Array(o[m].length);
          s.state.slow ??= new Float64Array(o[m].length);
          ema(b.c, s.state.fast, f, b.n, P.fast);
          ema(b.c, s.state.slow, f, b.n, P.slow);
          for (let i = f; i < b.n; i++) o[m][i] = s.state.fast[i] - s.state.slow[i];
          ema(o[m], o[sg], f, b.n, P.signal);
          for (let i = f; i < b.n; i++) o[h][i] = i < P.slow ? NaN : o[m][i] - o[sg][i];
          for (let i = f; i < Math.min(b.n, P.slow); i++) o[m][i] = o[sg][i] = NaN;
        },
        [h],
      );
      return s;
    }
    case 'ROC':
      return mk([key], (b, o, f, ctx) => {
        const n = P.length;
        for (let i = f; i < b.n; i++)
          o[key][i] = i < n ? NaN : ctx.additive ? (b.c[i] - b.c[i - n]) * ctx.bpPerUnit : 100 * (b.c[i] / b.c[i - n] - 1);
      });
    case 'ATR': {
      return mk([key], (b, o, f) => atr(b, o[key], f, P.length));
    }
    case 'RVOL':
      return mk([key], (b, o, f, ctx) => {
        const n = P.length;
        const perYear = Math.sqrt((365.25 * 86400) / Math.max(1, ctx.barSeconds));
        for (let i = f; i < b.n; i++) {
          if (i < n) {
            o[key][i] = NaN;
            continue;
          }
          let s = 0;
          let q = 0;
          for (let j = i - n + 1; j <= i; j++) {
            const r = ctx.additive ? (b.c[j] - b.c[j - 1]) * ctx.bpPerUnit : Math.log(b.c[j] / b.c[j - 1]);
            s += r;
            q += r * r;
          }
          const sd = Math.sqrt(Math.max(0, q / n - (s / n) ** 2));
          o[key][i] = ctx.additive ? sd * perYear : 100 * sd * perYear;
        }
      });
    case 'ZSCORE':
      return mk([key], (b, o, f) => {
        const n = P.length;
        for (let i = f; i < b.n; i++) {
          if (i < n - 1) {
            o[key][i] = NaN;
            continue;
          }
          let s = 0;
          let q = 0;
          for (let j = 0; j < n; j++) {
            const x = b.c[i - j];
            s += x;
            q += x * x;
          }
          const mean = s / n;
          const sd = Math.sqrt(Math.max(0, q / n - mean * mean));
          o[key][i] = sd > 0 ? (b.c[i] - mean) / sd : 0;
        }
      });
  }
  throw new Error(`unknown study type ${type}`);
}

function ema(src: Float64Array, out: Float64Array, from: number, n: number, len: number) {
  const a = 2 / (len + 1);
  for (let i = from; i < n; i++) {
    const x = src[i];
    const prev = i > 0 ? out[i - 1] : NaN;
    out[i] = !Number.isFinite(prev) ? x : Number.isFinite(x) ? a * x + (1 - a) * prev : prev;
  }
}

function sma(src: Float64Array, out: Float64Array, from: number, n: number, len: number) {
  for (let i = from; i < n; i++) {
    if (i < len - 1) {
      out[i] = NaN;
      continue;
    }
    let s = 0;
    let k = 0;
    for (let j = i - len + 1; j <= i; j++)
      if (Number.isFinite(src[j])) {
        s += src[j];
        k++;
      }
    out[i] = k ? s / k : NaN;
  }
}

function atr(b: Bars, out: Float64Array, from: number, len: number) {
  for (let i = from; i < b.n; i++) {
    const tr = i === 0 ? b.h[0] - b.l[0] : Math.max(b.h[i] - b.l[i], Math.abs(b.h[i] - b.c[i - 1]), Math.abs(b.l[i] - b.c[i - 1]));
    out[i] = i === 0 || !Number.isFinite(out[i - 1]) ? tr : (out[i - 1] * (len - 1) + tr) / len;
  }
}

/** The study keys offered for an instrument (volume studies only where it trades). */
export function studiesFor(hasVolume: boolean): string[] {
  return Object.entries(STUDY_TYPES)
    .filter(([, t]) => hasVolume || !t.needsVolume)
    .map(([k]) => k);
}

/** "EMA 20", "BB 20 2", "VWAP" */
export function studyLabel(type: string, params: Record<string, number>) {
  const vals = Object.values(params).map(v => fmt(v).replace('p', '.')).join(' ');
  return `${type === 'Volume' ? 'Volume' : type}${vals ? ' ' + vals : ''}`;
}
