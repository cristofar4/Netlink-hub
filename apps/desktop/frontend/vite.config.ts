// vitest/config re-exports defineConfig with the `test` block typed; plain
// vite's defineConfig does not know about it.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The workspace packages are consumed straight from source. Vite compiles
      // them along with the app, so there is no separate build step to forget
      // and no stale dist to debug.
      '@netlink/contracts': fileURLToPath(
        new URL('../../../packages/contracts/src', import.meta.url),
      ),
      '@netlink/ui': fileURLToPath(new URL('../../../packages/ui/src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    // Wails embeds this directory.
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
