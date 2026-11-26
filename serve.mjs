// Serve this exact dashboard directory, without browser caching. Node standard library only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--port');
const port = arg < 0 ? 8765 : Number(process.argv[arg + 1]);
const types = {'.html':'text/html', '.mjs':'text/javascript', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.geojson':'application/geo+json', '.svg':'image/svg+xml', '.png':'image/png'};
http.createServer((request, response) => {
  let name;
  try { name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
  catch { response.writeHead(400).end(); return; }
  const target = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
  if (!target.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
  fs.stat(target, (error, stat) => {
    if (error || !stat.isFile()) { response.writeHead(404).end('Not found'); return; }
    response.writeHead(200, {'Content-Type': (types[path.extname(target)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control':'no-store'});
    fs.createReadStream(target).pipe(response);
  });
}).listen(port, '127.0.0.1', () => console.log(`Dashboard: http://127.0.0.1:${port}/`));
