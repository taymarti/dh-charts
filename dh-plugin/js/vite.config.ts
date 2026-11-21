import { defineConfig } from 'vite';

// A Deephaven JS plugin: one CommonJS file whose default export is the plugin object. The web UI
// supplies react and @deephaven/* at runtime (its remote-module requires), so they stay external;
// everything else (@acme/chart-ext, lightweight-charts helpers, the official LWC plugins) is bundled.
export default defineConfig({
  // one copy of lightweight-charts, this package's (@acme/chart-ext lists it as a peer dependency)
  resolve: { dedupe: ['lightweight-charts'] },
  build: {
    lib: { entry: 'src/index.ts', formats: ['cjs'], fileName: () => 'index.js' },
    outDir: '../src/dh_chart_ext/_js/dist',
    emptyOutDir: true,
    minify: false,
    // exports.default = plugin (the shape Deephaven's loader reads, as in the TradingView plugin)
    rollupOptions: { external: ['react', '@deephaven/plugin', '@deephaven/jsapi-bootstrap'], output: { exports: 'named' } },
  },
});
