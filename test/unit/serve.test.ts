import { describe, it, expect } from 'vitest';
import path from 'node:path';
import http from 'node:http';
import { serveStatic } from '../helpers/serve';

describe('fixture server', () => {
  it('serves the fixture index and assets', async () => {
    const server = await serveStatic(path.resolve('test/fixtures/site'));
    try {
      const html = await fetch(`${server.url}/`).then((r) => r.text());
      expect(html).toContain('Fixture Co');
      const css = await fetch(`${server.url}/styles.css`);
      expect(css.headers.get('content-type')).toContain('text/css');
      const font = await fetch(`${server.url}/fonts/Fixture-Regular.woff2`);
      expect(font.status).toBe(200);
      const missing = await fetch(`${server.url}/nope.html`);
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('refuses a path that escapes the served dir and records what it served', async () => {
    const server = await serveStatic(path.resolve('test/fixtures/site'));
    try {
      await fetch(`${server.url}/about.html`);
      const { port } = new URL(server.url);
      // the url class collapses `..`, so the escape is sent percent-encoded on a raw request
      const status = await new Promise<number>((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path: '/%2e%2e/package.json' }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          })
          .on('error', reject);
      });
      expect(status).toBe(403);
      expect(server.hits).toEqual(['/about.html', '/../package.json']);
    } finally {
      await server.close();
    }
  });
});
