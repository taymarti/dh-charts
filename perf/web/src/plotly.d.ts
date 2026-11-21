declare module 'plotly.js-dist-min' {
  // The benchmark uses four calls; typed loosely on purpose.
  const Plotly: {
    newPlot(el: HTMLElement, data: unknown[], layout?: unknown, config?: unknown): Promise<unknown>;
    react(el: HTMLElement, data: unknown[], layout?: unknown, config?: unknown): Promise<unknown>;
    extendTraces(el: HTMLElement, update: Record<string, unknown[]>, indices: number[], maxPoints?: number): Promise<unknown>;
    purge(el: HTMLElement): void;
  };
  export default Plotly;
}
