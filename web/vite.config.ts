import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The React host for the charts project (a standalone web server, not the Deephaven IDE).
// It serves OUR compiled React bundle on :4050 and reverse-proxies the few
// paths the Deephaven JS API needs to the Deephaven server (default :10040), so the
// browser talks to a single origin (no CORS, one port to expose).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.VITE_PROXY_URL || 'http://localhost:10040';
  const proxy = {
    '/jsapi': { target, changeOrigin: true }, // dh-core.js (the JS API itself)
    '/js-plugins': { target, changeOrigin: true }, // server-side JS plugin manifest
    // gRPC-web / websocket traffic made by the JS API client
    '^/arrow\\..*': { target, changeOrigin: true, ws: true },
    '^/io\\.deephaven\\..*': { target, changeOrigin: true, ws: true },
  };
  return {
    // ../ext is linked in as @acme/chart-ext (source); let the dev server read it
    server: { port: 4050, proxy, fs: { allow: ['..'] } },
    preview: { port: 4050, proxy },
    resolve: {
      // one copy of lightweight-charts: the app's (@acme/chart-ext lists it as a peer dependency)
      dedupe: ['react', 'react-dom', 'react-redux', 'redux', 'lightweight-charts'],
      alias: [
        // @acme/chart-ext from source (its npm distribution is the built dist/; see ext/package.json)
        { find: '@acme/chart-ext', replacement: fileURLToPath(new URL('../ext/src/index.ts', import.meta.url)) },
        // CJS/ESM default-export interop fix; see the shim for details.
        {
          find: /^@paciolan\/remote-module-loader$/,
          replacement: fileURLToPath(new URL('./src/shims/remote-module-loader.ts', import.meta.url)),
        },
      ],
    },
    define: { 'process.env': {} },
    optimizeDeps: { esbuildOptions: { define: { global: 'globalThis' } } },
    plugins: [react()],
  };
});
