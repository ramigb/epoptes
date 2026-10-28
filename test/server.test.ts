// Dashboard server: API, local-only guards, and the live update stream.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'epoptes-ui-'));
process.env.EPOPTES_HOME = path.join(base, 'home');
const project = path.join(base, 'project');
fs.mkdirSync(path.join(project, '.epoptes', 'state'), { recursive: true });
fs.writeFileSync(path.join(project, '.epoptes', 'loop.md'), 'x');
fs.writeFileSync(path.join(project, '.epoptes', 'state', 'backlog.md'), '- [x] A\n- [ ] B\n');
fs.writeFileSync(
  path.join(project, '.epoptes', 'goal.json'),
  JSON.stringify({ version: 1, id: 'ui-test', name: 'UI test', kind: 'other', objective: 'test', done: [{ id: 'D1', check: 'x', verify: { type: 'manual' } }], timebox: { total_min: 30 }, adapter: { type: 'claude-code' } }),
);

const { addGoal } = await import('../src/registry.ts');
const { serve, closeAll } = await import('../src/ui/server.ts');
addGoal(project);

let server: http.Server;
let port = 0;
before(async () => {
  port = 20000 + Math.floor(Math.random() * 20000);
  server = await serve({ port, lan: false, pollMs: 100 });
});
after(() => closeAll(server));

function req(method: string, p: string, { headers = {}, body }: { headers?: Record<string, string>; body?: unknown } = {}) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode!, json: data ? JSON.parse(data) : null }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}
const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  req('POST', p, { body, headers: { 'Content-Type': 'application/json', 'X-Epoptes': '1', ...headers } });

test('state and detail views', async () => {
  const s = await req('GET', '/api/state');
  assert.equal(s.status, 200);
  assert.equal(s.json.goals[0].id, 'ui-test');
  assert.deepEqual(s.json.goals[0].board, { backlog: 0, todo: 1, doing: 0, review: 0, done: 1, blocked: 0, cut: 0, milestone: null }, 'the seeded backlog.md is on the board');
  const d = await req('GET', '/api/goals/ui-test');
  assert.equal(d.json.state, 'idle');
  assert.deepEqual(d.json.cycles_detail, []);
  assert.equal((await req('GET', '/api/goals/nope')).status, 404);
  assert.deepEqual(s.json.limits, {});
  assert.equal(s.json.goals[0].adapter, 'claude-code');
  const time = await req('GET', '/api/goals/ui-test/time');
  assert.deepEqual([time.status, time.json.cycles, time.json.phases.working], [200, 0, 0]);
});

test('rejects foreign hosts and cross-site writes', async () => {
  assert.equal((await req('GET', '/api/state', { headers: { Host: `evil.example:${port}` } })).status, 403);
  assert.equal((await req('POST', '/api/goals/ui-test/cards', { body: { title: 'x' }, headers: { 'Content-Type': 'application/json' } })).status, 403);
  assert.equal((await req('POST', '/api/goals/ui-test/cards', { body: { title: 'x' }, headers: { 'Content-Type': 'text/plain', 'X-Epoptes': '1' } })).status, 403);
  assert.equal((await post('/api/goals/ui-test/cards', { title: 'x' }, { Origin: 'http://evil.example' })).status, 403);
  assert.ok(!fs.readFileSync(path.join(project, '.epoptes', 'board.jsonl'), 'utf8').includes('"x"'), 'nothing was written');
});

test('cards from the dashboard stream to clients; moves, comments and bad fields', async () => {
  const got = new Promise<any>((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        for (const m of buf.matchAll(/event: update\ndata: (.*)\n\n/g)) {
          const u = JSON.parse(m[1]);
          if (u.board.some((o: any) => o.title === 'bigger title')) {
            r.destroy();
            resolve(u);
          }
        }
      });
    });
    r.on('error', (e) => (e.message.includes('socket hang up') ? null : reject(e)));
  });
  await new Promise((r) => setTimeout(r, 300));
  const add = await post('/api/goals/ui-test/cards', { title: 'bigger title' });
  assert.deepEqual(add.json, { id: 'C-3' });
  const u = await got;
  assert.equal(u.id, 'ui-test');
  const op = u.board.find((o: any) => o.id === 'C-3');
  assert.deepEqual([op.src, op.column, op.epic], ['dashboard', 'backlog', 'job-1']);

  assert.equal((await post('/api/goals/ui-test/cards/C-3', { column: 'todo', milestone: 'M1' })).status, 200);
  assert.equal((await post('/api/goals/ui-test/cards/C-3', { comment: 'and bold' })).status, 200);
  assert.equal((await post('/api/goals/ui-test/cards/C-3', { column: 'finished' })).status, 400);
  assert.equal((await post('/api/goals/ui-test/cards/C-3', { assignee: { evil: 1 } })).status, 400);
  assert.equal((await post('/api/goals/ui-test/cards/C-3', { pid: 1 })).status, 400, 'unknown fields change nothing');
  assert.equal((await post('/api/goals/ui-test/cards/C-99', { column: 'done' })).status, 400);
  const d = await req('GET', '/api/goals/ui-test');
  const c = d.json.board_cards.find((x: any) => x.id === 'C-3');
  assert.deepEqual([c.column, c.milestone, c.waiting, c.comments[0].text], ['todo', 'M1', true, 'and bold']);
  assert.deepEqual(d.json.epics, [{ id: 'job-1', title: 'UI test', current: true }]);
});

test('approvals are answered from the dashboard', async () => {
  const { askApproval } = await import('../src/board.ts');
  const { goalPaths } = await import('../src/paths.ts');
  const id = askApproval(goalPaths(project), 'use a paid map API', 'C-2', 'orchestrator', 4);
  await new Promise((r) => setTimeout(r, 300)); // let the watcher poll the file
  let d = await req('GET', '/api/goals/ui-test');
  assert.deepEqual(d.json.pending_approvals, [{ id: 'C-2', text: 'use a paid map API', ref: 'B' }]);
  assert.equal((await post('/api/goals/ui-test/cards/C-1', { decision: 'approved' })).status, 400, 'only cards with an approval take a decision');
  const r = await post(`/api/goals/ui-test/cards/${id}`, { decision: 'rejected', note: 'use the free one' });
  assert.deepEqual(r.json, { ok: true, resumed: false }, 'an idle goal is not started');
  d = await req('GET', '/api/goals/ui-test');
  const c = d.json.board_cards.find((x: any) => x.id === id);
  assert.deepEqual([c.approval.decision, c.waiting, d.json.pending_approvals.length], ['rejected', true, 0]);
});

test('controls report errors instead of crashing', async () => {
  const r = await post('/api/goals/ui-test/control', { action: 'pause' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /not running/);
  assert.equal((await post('/api/goals/ui-test/control', { action: 'explode' })).status, 400);
});

test('outputs are served on their own origin, never outside the project or from dotfiles', async () => {
  fs.mkdirSync(path.join(project, 'site'), { recursive: true });
  fs.writeFileSync(path.join(project, 'site', 'index.html'), '<h1>game</h1>');
  fs.writeFileSync(path.join(project, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(base, 'outside.txt'), 'nope');
  fs.symlinkSync(path.join(base, 'outside.txt'), path.join(project, 'link.txt'));
  const g = JSON.parse(fs.readFileSync(path.join(project, '.epoptes', 'goal.json'), 'utf8'));
  fs.writeFileSync(path.join(project, '.epoptes', 'goal.json'), JSON.stringify({ ...g, output: 'site/' }));
  await new Promise((r) => setTimeout(r, 300));
  const d = await req('GET', '/api/goals/ui-test');
  assert.equal(d.json.output.href, `http://127.0.0.1:${port + 1}/ui-test/site/`);
  const get = (p: string, host = `127.0.0.1:${port + 1}`) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: port + 1, path: p, headers: { Host: host } }, (res) => {
        let body = '';
        res.on('data', (x) => (body += x));
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      }).on('error', reject);
    });
  assert.deepEqual(await get('/ui-test/site/'), { status: 200, body: '<h1>game</h1>' });
  for (const p of ['/ui-test/.env', '/ui-test/.epoptes/goal.json', '/ui-test/link.txt', '/ui-test/%2e%2e/outside.txt', '/ui-test/../outside.txt', '/nope/site/']) {
    assert.equal((await get(p)).status, 404, p);
  }
  assert.equal((await get('/ui-test/site/', `evil.example:${port + 1}`)).status, 403);
  const { emit } = await import('../src/events.ts');
  const { goalPaths } = await import('../src/paths.ts');
  emit(goalPaths(project), { src: 'orchestrator', type: 'output', path: 'https://example.com/demo', text: 'deployed preview' });
  await new Promise((r) => setTimeout(r, 300));
  const d2 = await req('GET', '/api/goals/ui-test');
  assert.deepEqual([d2.json.output.kind, d2.json.output.href, d2.json.output.from], ['url', 'https://example.com/demo', 'event']);
});
