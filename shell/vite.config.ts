import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// The npm distribution of @acme/app-shell: one ES module (dist/index.js), its styles (dist/app-shell.css,
// with dockview's), and types (dist/types). React, the other @acme packages and lightweight-charts stay
// external (peer dependencies), and dockview-react (a dependency the app's bundler resolves).
export default defineConfig({
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: () => 'index.js', cssFileName: 'app-shell' },
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    rollupOptions: {
      external: ['react', 'react/jsx-runtime', 'react-dom', 'lightweight-charts', /^@acme\//, /^@deephaven\//, /^dockview/],
    },
  },
  // tests compile the other @acme packages from source (the build keeps them external)
  test: {
    environment: 'jsdom',
    alias: [
      { find: '@acme/chart-ext', replacement: fileURLToPath(new URL('../ext/src/index.ts', import.meta.url)) },
      { find: '@acme/chart-react', replacement: fileURLToPath(new URL('../react/src/index.ts', import.meta.url)) },
      { find: '@acme/dh-bindings', replacement: fileURLToPath(new URL('../bindings/src/index.ts', import.meta.url)) },
    ],
  },
} as never);
