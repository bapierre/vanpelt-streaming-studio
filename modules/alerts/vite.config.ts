import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** The hub serves dist/ at /m/alerts/, so assets use relative paths. */
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: { chunkFileNames: 'assets/shared-[hash].js' },
      input: {
        popup: resolve(import.meta.dirname, 'popup.html'),
        goal: resolve(import.meta.dirname, 'goal.html'),
      },
    },
  },
});
