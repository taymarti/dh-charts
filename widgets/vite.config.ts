import { defineConfig } from 'vite';

// The npm distribution of @acme/dh-widgets: dist/index.js and the remote-module-loader shim (an app aliases
// @paciolan/remote-module-loader to it), types from tsc. React, Deephaven's packages and the other @acme packages
// stay external: the app supplies them, one copy each.
export default defineConfig({
  build: {
    lib: {
      entry: { index: 'src/index.ts', widgets: 'src/widgets.tsx', 'remote-module-loader': 'src/remote-module-loader.ts' },
      formats: ['es'],
      fileName: (_f, name) => `${name}.js`,
      cssFileName: 'dh-widgets',
    },
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    rollupOptions: { external: ['react', 'react/jsx-runtime', 'react-dom', /^@acme\//, /^@deephaven\//, /^@paciolan\//] },
  },
});
