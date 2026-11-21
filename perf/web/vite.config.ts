import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Serves the benchmark client and proxies Deephaven (JS API, gRPC-web, websockets) so the page
// talks to one origin. DH_URL picks the server (default the benchmark server on :10040).
const target = process.env.DH_URL ?? 'http://localhost:10040';
const proxy = Object.fromEntries(
  ['/jsapi', '/js-plugins', '^/arrow\..*', '^/io\.deephaven\..*'].map(p => [p, { target, changeOrigin: true, ws: true }]),
);

export default defineConfig({
  plugins: [react()],
  server: { port: 4040, proxy },
  preview: { port: 4040, proxy },
  build: { target: 'es2022' },
});
