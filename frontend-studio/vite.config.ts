import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      // Makes the frontend and backend same-origin from the browser's point of
      // view — the rtp_session cookie (SameSite=Lax, Secure=false for local
      // http) doesn't reliably survive a cross-origin fetch from :5173 to
      // :8000 otherwise. Vite proxies server-side (not subject to browser CORS
      // at all) and strips /api before forwarding, so the backend's routes
      // stay exactly as they are — see api.ts's API_URL for the client side.
      proxy: {
        '/api': {
          target: 'http://localhost:8000',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  };
});
