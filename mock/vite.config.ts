import { defineConfig } from 'vite';

// The npm distribution of @acme/dh-mock: one ES module (dist/index.js, with the backtest worker inlined), types
// from tsc (dist/types). @acme/chart-ext stays external: the app supplies it.
export default defineConfig({
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: () => 'index.js' },
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    rollupOptions: { external: ['@acme/chart-ext', 'lightweight-charts'] },
  },
});
