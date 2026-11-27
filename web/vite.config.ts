import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const server = process.env.KIMMI_DEV_SERVER ?? 'http://localhost:8700';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    proxy: { '/api': server, '/i': server, '/kimmi.js': server, '/kimmi-feedback.js': server },
  },
});
