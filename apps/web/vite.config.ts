import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = process.env.RAION_API ?? 'http://127.0.0.1:7600';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    // Keep all assets as files so the strict Content-Security-Policy (no inline code) holds.
    assetsInlineLimit: 0,
  },
  server: {
    proxy: {
      // Development only: forward API calls to a locally running `raion server`.
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        configure: (proxy) => {
          // The server rejects cross-origin mutations; present the API's own origin.
          proxy.on('proxyReq', (req) => req.setHeader('origin', API_TARGET));
        },
      },
    },
  },
});
