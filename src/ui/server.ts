// The local dashboard: static files, a JSON API over the goal files, and a Server-Sent Events stream.
// Closing it never affects runs; controls go through the same code as the CLI.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as control from '../control.ts';
import { addFeedback, noteFeedback, setFeedbackStatus, type FeedbackStatus } from '../feedback.ts';
import { readRegistry } from '../registry.ts';
import { buildReport, renderAllHtml, renderHtml } from '../report.ts';
import { goalPaths } from '../paths.ts';
import { cycleView, detail, markSeen, summary } from './views.ts';
import { GoalWatch, type GoalUpdate } from './watch.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(here, '../../ui');
const VENDOR = fileURLToPath(import.meta.resolve('htm/preact/standalone'));

const STATIC: Record<string, [string, string]> = {
  '/': [path.join(UI_DIR, 'index.html'), 'text/html; charset=utf-8'],
  '/app.js': [path.join(UI_DIR, 'app.js'), 'text/javascript; charset=utf-8'],
  '/style.css': [path.join(UI_DIR, 'style.css'), 'text/css; charset=utf-8'],
  '/mark.svg': [path.join(UI_DIR, 'mark.svg'), 'image/svg+xml'],
  '/vendor/preact.js': [VENDOR, 'text/javascript; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

export interface ServeOptions {
  port: number;
  lan: boolean;
  pollMs?: number;
}

export function serve({ port, lan, pollMs = 1000 }: ServeOptions) {
  const watches = new Map<string, GoalWatch>();
  const clients = new Set<http.ServerResponse>();

  const syncRegistry = () => {
    const reg = readRegistry();
    for (const g of reg.goals) if (!watches.has(g.id)) watches.set(g.id, new GoalWatch(g.id, g.path));
    for (const id of watches.keys()) if (!reg.goals.some((g) => g.id === id)) watches.delete(id);
  };
  syncRegistry();
  // Warm the caches and the schema validator (slow to load from WSL's /mnt drives) before the first request.
  for (const w of watches.values()) {
    w.poll();
    try {
      summary(w);
    } catch {
      // shown as an error card later
    }
  }

  const broadcast = (u: GoalUpdate) => {
    const msg = `event: update\ndata: ${JSON.stringify(u)}\n\n`;
    for (const c of clients) c.write(msg);
  };

  let ticks = 0;
  const timer = setInterval(() => {
    if (++ticks % 5 === 0) syncRegistry();
    for (const w of watches.values()) {
      try {
        const u = w.poll();
        if (u) broadcast(u);
      } catch (e) {
        console.error(`poll ${w.id}: ${(e as Error).message}`);
      }
    }
  }, pollMs);
  const ping = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, 15_000);

  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  const send = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: http.IncomingMessage) =>
    new Promise<any>((resolve, reject) => {
      let data = '';
      req.on('data', (d) => {
        data += d;
        if (data.length > 100_000) reject(new Error('body too large'));
      });
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          reject(new Error('invalid JSON'));
        }
      });
    });

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      // DNS-rebinding guard: only answer to our own local names (LAN mode is an explicit opt-in).
      if (!lan && !allowedHosts.has(host)) return send(res, 403, { error: 'forbidden host' });
      const url = new URL(req.url ?? '/', `http://${host || 'localhost'}`);

      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache' });
        return res.end(fs.readFileSync(file));
      }

      // Reports are self-contained pages with inline styles and no scripts.
      const sendReport = (body: string) => {
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:", 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(body);
      };
      if (req.method === 'GET' && url.pathname === '/report.html') {
        return sendReport(renderAllHtml([...watches.values()].flatMap((x) => {
          try {
            return [buildReport(goalPaths(x.p.project))];
          } catch {
            return [];
          }
        })));
      }
      const rm = /^\/goals\/([a-z0-9-]+)\/report\.html$/.exec(url.pathname);
      if (req.method === 'GET' && rm) {
        const w = watches.get(rm[1]);
        if (!w) return send(res, 404, { error: `no goal ${rm[1]}` });
        return sendReport(renderHtml(buildReport(w.p)));
      }

      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });

      if (req.method !== 'GET') {
        // CSRF guard: a custom header and a JSON body force a CORS preflight, which we never answer.
        const origin = req.headers.origin;
        if (req.headers['x-epoptes'] !== '1' || !String(req.headers['content-type']).startsWith('application/json') || (origin && origin !== `http://${host}`)) {
          return send(res, 403, { error: 'forbidden' });
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/stream') {
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('event: hello\ndata: {}\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        const goals = [...watches.values()].map(summary);
        const limits = goals
          .map((g) => ('limits' in g ? g.limits : null))
          .filter(Boolean)
          .sort((a, b) => (a!.at < b!.at ? 1 : -1))[0] ?? null;
        return send(res, 200, { goals, limits, lan });
      }

      const m = /^\/api\/goals\/([a-z0-9-]+)(?:\/(.*))?$/.exec(url.pathname);
      if (!m) return send(res, 404, { error: 'not found' });
      const w = watches.get(m[1]);
      if (!w) return send(res, 404, { error: `no goal ${m[1]}` });
      const sub = m[2] ?? '';
      const project = w.p.project;

      if (req.method === 'GET' && sub === '') return send(res, 200, detail(w));
      const cm = /^cycles\/(\d+)$/.exec(sub);
      if (req.method === 'GET' && cm) return send(res, 200, cycleView(w, Number(cm[1])));

      if (req.method === 'POST') {
        const body = await readBody(req);
        // After a write, refresh this goal's caches right away (and tell every client) instead of waiting for the poll.
        const refresh = () => {
          const u = w.poll();
          if (u) broadcast(u);
        };
        if (sub === 'control') {
          switch (body.action) {
            case 'start':
              await control.start(project, { newRun: body.new_run === true });
              break;
            case 'pause':
              control.pause(project);
              break;
            case 'stop':
              control.stop(project);
              break;
            case 'extend':
              control.extend(project, Number(body.seconds));
              break;
            case 'reset':
              control.resetClock(project);
              break;
            default:
              return send(res, 400, { error: `unknown action ${body.action}` });
          }
          refresh();
          return send(res, 200, { ok: true });
        }
        if (sub === 'feedback') {
          const id = addFeedback(w.p, String(body.text ?? ''), 'dashboard');
          // "Send & resume" from the waiting-for-you banner: the reply is the answer the run waited for.
          const r = body.resume === true ? await control.resumeIfAnswered(project, { force: true }) : null;
          refresh();
          return send(res, 200, { id, ...r });
        }
        const fm = /^feedback\/(F-\d+)$/.exec(sub);
        if (fm) {
          if (body.decision === 'approved' || body.decision === 'rejected') {
            const r = await control.decide(project, fm[1], body.decision, body.note ? String(body.note) : undefined);
            refresh();
            return send(res, 200, { ok: true, ...r });
          }
          if (body.status) setFeedbackStatus(w.p, fm[1], body.status as FeedbackStatus, 'user', null, body.note || undefined);
          else if (body.note) noteFeedback(w.p, fm[1], String(body.note), 'user', null);
          else return send(res, 400, { error: 'status or note required' });
          refresh();
          return send(res, 200, { ok: true });
        }
        if (sub === 'seen') {
          markSeen(w.id);
          return send(res, 200, { ok: true });
        }
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
  });

  return new Promise<http.Server>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, lan ? '0.0.0.0' : '127.0.0.1', () => {
      server.on('close', () => {
        clearInterval(timer);
        clearInterval(ping);
      });
      resolve(server);
    });
  });
}

export function closeAll(server: http.Server) {
  server.closeAllConnections();
  server.close();
}
