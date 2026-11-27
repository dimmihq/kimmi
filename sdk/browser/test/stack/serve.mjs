// Serves a built single-page app: files as they are, and index.html for any other path.
//   node serve.mjs <folder> <port>
// The stack suite uses it for the example shop, so it can run beside a `vite preview` of the same project.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const [folder, port] = [process.argv[2], Number(process.argv[3])];
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(folder, path);
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // A missing asset is a 404, as on a real host; a missing page is the app's to route.
    if (extname(path) && extname(path) !== '.html') return res.writeHead(404).end();
    file = join(folder, 'index.html');
  }
  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(port);
