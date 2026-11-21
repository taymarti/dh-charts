/**
 * Watchlist: a TradingView-style symbol list with last price and change, colored up/down, the last
 * price flashing on each tick. Clicking a row selects the symbol (the host points its chart at it).
 * Controlled and data-agnostic: the host supplies the rows (a deephaven.ui workspace from a live
 * quotes table, via the `acme.chart.Watchlist` element; a React app from any source).
 */
import { useRef } from 'react';
import { injectToolbarStyles } from './styles';

export interface WatchlistRow {
  symbol: string;
  last?: number | null;
  chg?: number | null;
  chgPct?: number | null;
  description?: string;
}

export interface WatchlistProps {
  rows: WatchlistRow[];
  selected?: string;
  onSelect?: (symbol: string) => void;
  title?: string;
  className?: string;
}

const ok = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
const decimals = (v: number) => (Math.abs(v) < 10 ? 4 : 2);

export function Watchlist({ rows, selected, onSelect, title = 'Watchlist', className }: WatchlistProps) {
  injectToolbarStyles();
  const prev = useRef(new Map<string, number>());
  const dirs = new Map<string, 'up' | 'down' | ''>();
  for (const r of rows) {
    const before = prev.current.get(r.symbol);
    dirs.set(r.symbol, ok(r.last) && before != null && r.last !== before ? (r.last > before ? 'up' : 'down') : '');
  }
  // remember for the next render (after computing directions for this one)
  queueMicrotask(() => rows.forEach(r => ok(r.last) && prev.current.set(r.symbol, r.last)));

  return (
    <div className={`acme-wl${className ? ` ${className}` : ''}`}>
      <div className="acme-wl-head">{title}</div>
      <div className="acme-wl-cols">
        <span>Symbol</span>
        <span>Last</span>
        <span>Chg</span>
        <span>Chg%</span>
      </div>
      <div className="acme-wl-body">
        {rows.map(r => {
          const d = ok(r.last) ? decimals(r.last) : 2;
          const sign = ok(r.chg) ? (r.chg > 0 ? 'up' : r.chg < 0 ? 'down' : '') : '';
          const dir = dirs.get(r.symbol);
          return (
            <div
              key={r.symbol}
              className={`acme-wl-row${r.symbol === selected ? ' selected' : ''}`}
              onClick={() => onSelect?.(r.symbol)}
              title={r.description}
            >
              <span className="acme-wl-sym">{r.symbol}</span>
              {/* the key changes with the price, so the flash animation replays on each tick */}
              <span key={`${r.symbol}-${r.last}`} className={dir ? `acme-wl-flash-${dir}` : ''}>
                {ok(r.last) ? r.last.toFixed(d) : '—'}
              </span>
              <span className={sign}>{ok(r.chg) ? `${r.chg > 0 ? '+' : ''}${r.chg.toFixed(d)}` : '—'}</span>
              <span className={sign}>{ok(r.chgPct) ? `${r.chgPct > 0 ? '+' : ''}${r.chgPct.toFixed(2)}%` : '—'}</span>
            </div>
          );
        })}
        {rows.length === 0 && <div className="acme-tb-empty">No symbols yet</div>}
      </div>
    </div>
  );
}
