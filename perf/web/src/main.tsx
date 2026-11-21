/**
 * Standalone React client for the benchmark: N charts in a grid, straight off the JS API.
 *   ?lib=lwc|plotly   chart library            (default lwc)
 *   &kind=line|candle ticks or 1-minute bars   (default line)
 *   &bars=bars1s     bar table prefix for kind=candle (default bars: 1-minute)
 *   &n=16             charts                   (default 16)
 *   &interval=ms      Barrage update interval requested per subscription (default: server's)
 */
import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { lwcChart, plotlyChart, type Kind } from './charts';
import { streamTable } from './dh';
import './probe';
import './styles.css';

const q = new URLSearchParams(location.search);
const LIB = (q.get('lib') ?? 'lwc') as 'lwc' | 'plotly';
const KIND = (q.get('kind') ?? 'line') as Kind;
const N = Number(q.get('n') ?? 16);
const INTERVAL = q.get('interval') ? Number(q.get('interval')) : undefined;
const SYMS = ['ES', 'NQ', 'RTY', 'YM', 'ZN', 'ZB', 'ZF', 'ZT', 'CL', 'NG', 'GC', 'SI', '6E', '6J', 'UST10', 'BUND'].slice(0, N);

function Chart({ sym }: { sym: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const handle = (LIB === 'lwc' ? lwcChart : plotlyChart)(el, sym, KIND);
    const [name, cols] = KIND === 'line' ? [`t_${sym}`, ['Price']] : [`${q.get('bars') ?? 'bars'}_${sym}`, ['Open', 'High', 'Low', 'Close', 'Updated']];
    let close: (() => void) | undefined;
    let dead = false;
    streamTable(name, 'Timestamp', cols, b => {
      window.__perf.rowsReceived += b.t.length;
      (window.__perf.arrivals[sym] ??= []).push(Date.now());
      handle.push(b);
    }, INTERVAL).then(c => (dead ? c() : (close = c)));
    return () => { dead = true; close?.(); handle.dispose(); };
  }, [sym]);
  return (
    <div className="cell">
      {LIB === 'lwc' && <span className="label">{sym}</span>}
      <div ref={ref} className="chart" />
    </div>
  );
}

function App() {
  const cols = Math.ceil(Math.sqrt(N));
  return (
    <div className="grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {SYMS.map(s => <Chart key={s} sym={s} />)}
    </div>
  );
}

// no StrictMode: its double effects would subscribe every table twice during the measurement
createRoot(document.getElementById('root')!).render(<App />);
