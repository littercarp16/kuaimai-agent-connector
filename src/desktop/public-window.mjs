import { readFile } from 'node:fs/promises';
const names = new Map([
  ['/connect', ['connect-window.html', 'text/html; charset=utf-8']],
  ['/connect-window.js', ['connect-window.js', 'text/javascript; charset=utf-8']],
  ['/connect-window.css', ['connect-window.css', 'text/css; charset=utf-8']],
]);
export function createConnectionWindow(grants) {
  const files = new Map();
  return {
    ...grants,
    async handlePublic(req, res) {
      const item = names.get(req.url); if (!item) return false;
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return true; }
      if (!files.has(item[0])) files.set(item[0], await readFile(new URL('../../web/' + item[0], import.meta.url)));
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Type', item[1]);
      res.writeHead(200); res.end(req.method === 'HEAD' ? undefined : files.get(item[0])); return true;
    },
  };
}
