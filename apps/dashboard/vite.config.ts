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
      // fs.deny replaces Vite's defaults, so the dotfile and key-material entries repeat them.
      fs: { deny: ['**/.streamhub/**', '**/.git/**', '.env', '.env.*', '**/*.pem', '**/*.crt'] },
      proxy: { '/ws': { target: `ws://127.0.0.1:${hubPort}`, ws: true } },
    },
    build: { outDir: 'dist' },
  };
});
