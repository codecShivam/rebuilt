import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AddressInfo } from 'node:net';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

/** serve a directory on a free localhost port. `hits` is every request path, in order. */
export async function serveStatic(
  dir: string,
): Promise<{ url: string; hits: string[]; close(): Promise<void> }> {
  const hits: string[] = [];
  const server = http.createServer(async (req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    hits.push(urlPath);
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = path.join(dir, rel);
    if (!file.startsWith(dir + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        // a font fetched from another origin is a cors request; a fixture page on a second
        // port must be able to load this server's fonts
        'access-control-allow-origin': '*',
      });
      res.end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
