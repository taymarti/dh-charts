import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// tests compile @acme/chart-ext from source, as the in-repo hosts do
export default defineConfig({
  resolve: { alias: { '@acme/chart-ext': fileURLToPath(new URL('../ext/src/index.ts', import.meta.url)) } },
});
