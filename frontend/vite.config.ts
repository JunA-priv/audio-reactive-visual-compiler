import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // User-provided demo tracks remain available to local dev, but production builds
  // must opt in after the source/model-derived asset publication review is complete.
  publicDir: command === 'serve' || process.env.ARVC_DEMO_ASSETS_PUBLICATION_APPROVED === 'true' ? 'public' : false,
  server: {
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:8080' },
  },
  test: {
    environment: 'happy-dom',
  },
}));
