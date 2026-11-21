import { defineConfig } from 'vite';

// The npm distribution of @acme/chart-react: one ES module (dist/index.js) plus types (dist/types).
// React stays external (a peer dependency): the app supplies it.
export default defineConfig({
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: () => 'index.js' },
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    rollupOptions: { external: ['react', 'react/jsx-runtime', 'react-dom'] },
  },
});
