import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// API_PORT lets you run the Express backend on a non-default port (useful when
// other dev servers are already using :3000). Defaults to 3000 for backwards
// compat. Pass to Vite as `API_PORT=3002 vite` etc.
const apiTarget = `http://localhost:${process.env.API_PORT || 3000}`;

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
  server: {
    port: Number(process.env.VITE_PORT) || 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
});
