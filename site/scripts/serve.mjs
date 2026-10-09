// Minimal static server for `out/` that mimics S3 + CloudFront (gzip for text, immutable cache for
// /_next/static, as in infra/): `/path/` → `/path/index.html`,
// `/path` → `/path/index.html` when it is a directory, unknown paths → 404.html with status 404.
// Usage: pnpm serve [port]   (default 4321)
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createGzip } from 'node:zlib';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve('out');
const port = Number(process.argv[2] ?? process.env.PORT ?? 4321);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

function resolveFile(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^([/\\])+/, '');
  const file = join(root, clean);
  if (!file.startsWith(root)) return null;
  if (existsSync(file) && statSync(file).isFile()) return file;
  const index = join(file, 'index.html');
  if (existsSync(index)) return index;
  if (existsSync(`${file}.html`)) return `${file}.html`;
  return null;
}

createServer((req, res) => {
  const file = resolveFile(req.url ?? '/');
  const target = file ?? join(root, '404.html');
  const type = TYPES[extname(target)] ?? 'application/octet-stream';
  const headers = { 'content-type': type };
  if ((req.url ?? '').startsWith('/_next/static/')) headers['cache-control'] = 'public, max-age=31536000, immutable';
  const gzip = /text|javascript|json|xml|svg/.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
  if (gzip) headers['content-encoding'] = 'gzip';
  res.writeHead(file ? 200 : 404, headers);
  const stream = createReadStream(target);
  (gzip ? stream.pipe(createGzip()) : stream).pipe(res);
}).listen(port, () => console.log(`Serving ${root} on http://localhost:${port}`));
