// Static file server for the demo. Node built-ins only, to match the library.
// Run `npm run build` first, then `npm run demo`.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT ?? 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

if (!existsSync(join(ROOT, 'dist', 'index.js'))) {
  console.error('dist/index.js is missing — run `npm run build` first.');
  process.exit(1);
}

createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  const target = path === '/' ? '/demo/index.html' : path;
  const file = join(ROOT, normalize(target).replace(/^(\.\.[/\\])+/, ''));

  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('Not found');
    return;
  }

  response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
}).listen(PORT, () => {
  console.log(`pixelscrub demo → http://localhost:${PORT}`);
});
