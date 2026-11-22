import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The desk app (front-end group C grown up, scenario S2/S3): our own app shell on our own Deephaven
// connection, no @deephaven React packages. It serves on :4060 and proxies the paths the JS API needs to the
// Deephaven server (default :10040), so the browser talks to one origin.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.VITE_PROXY_URL || 'http://localhost:10040';
  const proxy = {
    '/jsapi': { target, changeOrigin: true },
    '^/arrow\..*': { target, changeOrigin: true, ws: true },
    '^/io\.deephaven\..*': { target, changeOrigin: true, ws: true },
  };
  const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));
  return {
    server: { port: 4060, proxy, fs: { allow: ['..'] } },
    preview: { port: 4060, proxy },
    resolve: {
      // one copy of each: the app's (the @acme packages list them as peer dependencies)
      dedupe: ['react', 'react-dom', 'lightweight-charts'],
      alias: [
        // the @acme packages from source (their npm distributions are the built dist/)
        { find: '@acme/chart-ext', replacement: src('../ext/src/index.ts') },
        { find: '@acme/chart-react', replacement: src('../react/src/index.ts') },
        { find: '@acme/dh-bindings', replacement: src('../bindings/src/index.ts') },
        { find: '@acme/app-shell', replacement: src('../shell/src/index.ts') },
      ],
    },
    plugins: [react()],
  };
});
