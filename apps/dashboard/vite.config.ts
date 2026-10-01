import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', 'HUB_');
  const hubPort = env.HUB_PORT || '4747';
  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: { '/ws': { target: `ws://127.0.0.1:${hubPort}`, ws: true } },
    },
    build: { outDir: 'dist' },
  };
});
