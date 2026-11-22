import { defineConfig } from 'vite';

// The npm distribution of @acme/dh-bindings: one ES module (dist/index.js), types from tsc (dist/types).
// @acme/chart-ext, Lightweight Charts and the Deephaven JS API stay external: the consumer supplies them.
export default defineConfig({
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: () => 'index.js' },
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    rollupOptions: { external: ['@acme/chart-ext', 'lightweight-charts', /^@deephaven\//] },
  },
});
