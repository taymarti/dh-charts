/**
 * Instrumentation the benchmark runner reads from window.__perf. Each chart reports when it has
 * drawn its snapshot, and after each live update is painted, how old the newest painted tick was
 * ("freshness": tick timestamp to pixels, including the server's cycle and Barrage interval).
 */
export interface PerfProbe {
  ready: Set<string>;
  /** per paint: now - newest tick time, in ms */
  freshness: number[];
  /** wall time (ms) of each batch arrival, per chart */
  arrivals: Record<string, number[]>;
  rowsReceived: number;
}

declare global {
  interface Window {
    __perf: PerfProbe;
  }
}

window.__perf = { ready: new Set(), freshness: [], arrivals: {}, rowsReceived: 0 };

export function markReady(id: string): void {
  window.__perf.ready.add(id);
}

export function recordBatch(id: string, rows: number): void {
  (window.__perf.arrivals[id] ??= []).push(performance.timeOrigin + performance.now());
  window.__perf.rowsReceived += rows;
}

/** Call after the chart has been handed new data; measures at the next painted frame. */
export function recordPaint(newestTickMs: number): void {
  requestAnimationFrame(() => {
    // the frame's paint follows this callback; a second rAF lands after it
    requestAnimationFrame(() => window.__perf.freshness.push(Date.now() - newestTickMs));
  });
}
