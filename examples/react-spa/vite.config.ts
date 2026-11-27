import react from '@vitejs/plugin-react';
import { defineConfig, type Connect, type Plugin } from 'vite';

// The shop has no backend: anything under /api answers 404 instead of falling back to index.html,
// except /api/echo, which the privacy lab calls to put secrets in request and response bodies.
const noApi: Connect.NextHandleFunction = (req, res, next) => {
  if (!req.url?.startsWith('/api/')) return next();
  res.setHeader('content-type', 'application/json');
  if (!req.url.startsWith('/api/echo')) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
  req.on('end', () => res.end(JSON.stringify({ ok: true, access_token: 'LabResponseToken55', echo: body })));
};

const missingApi: Plugin = {
  name: 'missing-api',
  configureServer: (server) => void server.middlewares.use(noApi),
  configurePreviewServer: (server) => void server.middlewares.use(noApi),
};

export default defineConfig({
  plugins: [react(), missingApi],
  server: { port: 5220, strictPort: true },
  preview: { port: 5220, strictPort: true },
});
