import { defineConfig } from 'vite';

// The npm distribution of @acme/chart-ext: one ES module for bundlers (dist/index.js), with types
// from tsc (dist/types). Lightweight Charts and the official plugin stay external: the consumer
// supplies them (peer and regular dependencies), so an app has exactly one copy of each.
export default defineConfig({
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: () => 'index.js' },
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    rollupOptions: { external: ['lightweight-charts', '@tradingview/lwc-plugin-user-price-lines'] },
  },
});
