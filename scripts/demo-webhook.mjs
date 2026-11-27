// Receives kimmi's webhook deliveries during a demo and keeps them in a file, one JSON object per line.
//   node scripts/demo-webhook.mjs [port] [file]
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 5290);
const file = process.argv[3] ?? 'demo-webhook.log';
createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    try {
      const delivery = JSON.parse(body);
      appendFileSync(file, `${JSON.stringify({ receivedAt: new Date().toISOString(), signature: req.headers['x-kimmi-signature'] ?? '', ...delivery })}\n`);
      console.log(`${delivery.event}: ${delivery.title}`);
    } catch {
      // not a delivery
    }
    res.writeHead(204).end();
  });
}).listen(port, () => console.log(`webhook receiver on :${port}, writing ${file}`));
