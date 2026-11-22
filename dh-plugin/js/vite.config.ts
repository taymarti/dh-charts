import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// A Deephaven JS plugin: one CommonJS file whose default export is the plugin object. The web UI
// supplies react and @deephaven/* at runtime (its remote-module requires), so they stay external;
// everything else (@acme/chart-ext, lightweight-charts helpers, the official LWC plugins) is bundled.
export default defineConfig({
  // React's bundled JSX runtime reads process.env.NODE_ENV, which a browser does not have
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  // one copy of lightweight-charts, this package's (@acme/chart-ext lists it as a peer dependency)
  resolve: {
    dedupe: ['lightweight-charts', 'react'],
    // @acme/chart-ext from source (its npm distribution is the built dist/)
    alias: [
      { find: '@acme/chart-ext', replacement: fileURLToPath(new URL('../../ext/src/index.ts', import.meta.url)) },
      { find: '@acme/dh-bindings', replacement: fileURLToPath(new URL('../../bindings/src/index.ts', import.meta.url)) },
      { find: '@acme/chart-react', replacement: fileURLToPath(new URL('../../react/src/index.ts', import.meta.url)) },
    ],
  },
  build: {
    lib: { entry: 'src/index.ts', formats: ['cjs'], fileName: () => 'index.js' },
    outDir: '../src/dh_chart_ext/_js/dist',
    emptyOutDir: true,
    minify: false,
    // exports.default = plugin (the shape Deephaven's loader reads, as in the TradingView plugin)
    rollupOptions: { external: ['react', '@deephaven/plugin', '@deephaven/jsapi-bootstrap'], output: { exports: 'named' } },
  },
});
