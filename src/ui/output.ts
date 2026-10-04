// Serves each goal's deliverable ("output") on its own local origin (the dashboard's port + 1), so a page an agent
// built, a game say, runs with its scripts but can't reach the dashboard's API: a different port is a different
// origin, and the dashboard answers no CORS preflight. Only files inside the project; never dotfiles or .epoptes/.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { readRegistry } from '../registry.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
  // Text formats are shown, not downloaded.
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8', '.yaml': 'text/plain; charset=utf-8', '.yml': 'text/plain; charset=utf-8',
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Maps a request path `/<goal id>/<file path>` to a file inside that goal's project, or null when it isn't allowed:
 * outside the project (including through symlinks), or any segment starting with a dot (.epoptes, .git, .env).
 */
export function resolveOutput(urlPath: string, goals: { id: string; path: string }[]): { file: string; root: string; rel: string; goal: string } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const [, id, ...rest] = decoded.split('/');
  const g = goals.find((x) => x.id === id);
  if (!g) return null;
  if (rest.some((seg) => seg.startsWith('.') || seg.includes('\0') || seg.includes('\\'))) return null;
  let root: string;
  let file: string;
  try {
    root = fs.realpathSync(g.path);
    file = fs.realpathSync(path.join(root, ...rest));
  } catch {
    return null;
  }
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  const rel = path.relative(root, file);
  if (rel.split(path.sep).some((seg) => seg.startsWith('.'))) return null;
  return { file, root, rel, goal: g.id };
}

export function serveOutput({ port, host = '127.0.0.1' }: { port: number; host?: string }) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const server = http.createServer((req, res) => {
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
    const fail = (code: number, msg: string) => {
      res.writeHead(code, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(msg);
    };
    if (!allowedHosts.has(req.headers.host ?? '')) return fail(403, 'forbidden host');
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'read-only');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const hit = resolveOutput(url.pathname, readRegistry().goals);
    if (!hit) return fail(404, 'not found (only files inside a registered goal\'s project, and never dotfiles, are served)');
    const stat = fs.statSync(hit.file);
    if (stat.isDirectory()) {
      if (!url.pathname.endsWith('/')) {
        res.writeHead(301, { ...headers, Location: `${url.pathname}/` });
        return res.end();
      }
      const index = path.join(hit.file, 'index.html');
      if (fs.existsSync(index)) {
        res.writeHead(200, { ...headers, 'Content-Type': TYPES['.html'] });
        return res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(index));
      }
      const entries = fs.readdirSync(hit.file, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      const items = entries.map((e) => `<li><a href="${encodeURIComponent(e.name)}${e.isDirectory() ? '/' : ''}">${esc(e.name)}${e.isDirectory() ? '/' : ''}</a></li>`).join('');
      res.writeHead(200, { ...headers, 'Content-Type': TYPES['.html'], 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
      return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(hit.goal)}/${esc(hit.rel)}</title><style>body{font:14px system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color-scheme:light dark}li{margin:4px 0}</style><h1>${esc(hit.goal)}/${esc(hit.rel)}</h1><ul>${items || '<li>(empty)</li>'}</ul>`);
    }
    res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(hit.file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(hit.file).pipe(res);
  });
  return new Promise<http.Server>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
