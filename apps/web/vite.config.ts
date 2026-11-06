import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Client lives in ./client, builds to ./dist (served by the Hono server).
// Dev: `npm run web:dev` (HMR) against a local server (`npm run web`).
export default defineConfig({
  root: 'apps/web/client',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
