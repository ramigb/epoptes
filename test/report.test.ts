// Reports (built only from recorded files) and the run.sh importer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { appendJsonl, writeJson } from '../src/fsx.ts';
import { importRunSh, parseWatchdog } from '../src/importers/runsh.ts';
import { goalPaths } from '../src/paths.ts';
import { buildReport, renderAllHtml, renderAllMarkdown, renderHtml, renderMarkdown } from '../src/report.ts';
import { validate } from '../src/schema.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'epoptes-report-'));
const usage = (out: number, cost: number) => ({ input: 10, output: out, cache_read: 9000, cache_write: 990, cost_usd: cost });

function goalWithHistory() {
  const p = goalPaths(tmp());
  fs.mkdirSync(p.state, { recursive: true });
  writeJson(p.goal, { version: 1, id: 'rep', name: 'Report <test>', kind: 'content', objective: 'o', done: [{ id: 'D1', check: 'c', verify: { type: 'manual' } }], timebox: { total_min: 60 }, adapter: { type: 'claude-code' }, checkpoints: 'none' });
  const ev = (ts: string, run: string, cycle: number | null, src: string, type: string, extra = {}) => appendJsonl(p.events, { ts, run, cycle, src, type, ...extra });
  ev('2026-09-28T10:00:00.000Z', 'r1', null, 'runner', 'run.start', { timebox_s: 3600, resumed: false });
  const costs = [1, 1, 1, 5];
  costs.forEach((c, i) => {
    const n = i + 1;
    const start = new Date(Date.parse('2026-09-28T10:00:00Z') + i * 600_000).toISOString();
    const end = new Date(Date.parse(start) + 500_000).toISOString();
    writeJson(path.join(p.cycleDir(n), 'result.json'), { version: 1, cycle: n, run: 'r1', adapter: 'claude-code', started_at: start, ended_at: end, duration_s: 500, exit: n === 3 ? 'error' : 'ok', turns: 5, session_id: null, cost_usd: c, cost_basis: 'estimate', models: { 'claude-sonnet-5': usage(100, c * 0.8), 'claude-haiku-4-5-20251001': usage(50, c * 0.2) }, rate_limit: null, error: n === 3 ? 'boom' : null });
  });
  ev('2026-09-28T10:20:00.000Z', 'r1', 3, 'runner', 'wait', { reason: 'rate_limit', seconds: 300 });
  ev('2026-09-28T10:30:00.000Z', 'r1', 4, 'orchestrator', 'milestone', { text: 'M1 done' });
  ev('2026-09-28T10:40:00.000Z', 'r1', 4, 'runner', 'run.end', { reason: 'done' });
  appendJsonl(p.feedback, { ts: '2026-09-28T10:05:00.000Z', op: 'add', id: 'F-1', text: '<script>alert(1)</script> bigger title', src: 'dashboard' });
  appendJsonl(p.feedback, { ts: '2026-09-28T10:25:00.000Z', op: 'status', id: 'F-1', status: 'done', by: 'orchestrator', cycle: 4, note: 'title is bigger' });
  fs.writeFileSync(path.join(p.state, 'backlog.md'), '- [x] A one\n- [ ] B two\n- [blocked: needs key] C three\n- [cut] D four\n');
  fs.writeFileSync(path.join(p.state, 'scores.jsonl'), '{"cycle":2,"scores":{"clarity":6}}\n{"cycle":4,"accuracy":9,"clarity":8}\n');
  return p;
}

test('report totals, runs, flags and feedback come from the recorded files', () => {
  const r = buildReport(goalWithHistory());
  assert.equal(r.totals.cycles, 4);
  assert.equal(r.totals.cost_usd, 8);
  assert.equal(r.totals.failed_cycles, 1);
  assert.equal(r.totals.wall_s, 2400);
  assert.equal(r.totals.active_s, 2400 - 300, 'rate-limit waits pause the clock by default');
  assert.equal(r.totals.models['claude-sonnet-5'].cost_usd, 6.4);
  assert.deepEqual(r.cycles.map((c) => c.flagged), [false, false, false, true], 'over twice the median');
  assert.equal(r.runs[0].end_reason, 'done');
  assert.deepEqual(r.tasks, { done: ['A one'], blocked: ['C three (needs key)'], cut: ['D four'], open: 1 });
  assert.equal(r.feedback[0].closed_cycle, 4);
  assert.deepEqual(r.scores.criteria.sort(), ['accuracy', 'clarity'], 'both score shapes are read');
  assert.ok(r.estimate);
  assert.equal(r.problems.length, 1);
});

test('rendered reports label estimates and escape recorded text', () => {
  const r = buildReport(goalWithHistory());
  const md = renderMarkdown(r);
  assert.match(md, /≈ \$8\.00 \(API-equivalent estimate, not billed\)/);
  assert.match(md, /★ M1 done/);
  const html = renderHtml(r);
  assert.ok(!html.includes('<script>'), 'no raw script from feedback');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; bigger title/);
  assert.match(html, /Report &lt;test&gt;/);
  assert.match(html, /title="API-equivalent estimate, not billed"/);
  assert.match(html, /<svg viewBox/);
});

test('unknown Codex costs stay unknown in reports and combined totals', () => {
  const p = goalWithHistory();
  const file = path.join(p.cycleDir(4), 'result.json');
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  result.adapter = 'codex';
  result.cost_usd = null;
  result.models = { 'test-codex': { input: 20, output: 10, cache_read: 80, cache_write: 0, cost_usd: null } };
  writeJson(file, result);
  const report = buildReport(p);
  assert.equal(report.totals.cost_usd, null);
  assert.equal(report.runs[0].cost_usd, null);
  assert.equal(report.totals.models['test-codex'].cost_usd, null);
  assert.match(renderMarkdown(report), /\| Cost \| –/);
  assert.match(renderHtml(report), /<div class="k">Cost<\/div><div class="v">.*?–/);
  assert.match(renderAllMarkdown([report]), /\*\*–\*\*/);
  assert.match(renderAllHtml([report]), /<div class="k">Cost<\/div><div class="v">.*?–/);
  assert.doesNotMatch(renderAllMarkdown([report]), /test-codex[^\n]*\$0\.00/);
});

test('run.sh importer: two runs become one monotonic cycle sequence', () => {
  const dir = tmp();
  const logs = path.join(dir, 'harness', 'logs');
  fs.mkdirSync(path.join(logs, 'run1'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'harness', 'state'), { recursive: true });
  fs.writeFileSync(path.join(logs, 'watchdog.log'), [
    '[2026-09-27 03:00:00] cycle 1 start: mode=build opus/high timeout=5400s',
    '[2026-09-27 03:20:00] cycle 1 end: rc=0 1200s turns=3 cost=$1.00 error=false',
    '[2026-09-27 03:20:15] cycle 2 start: mode=build opus/high timeout=5400s',
    '[2026-09-27 04:50:15] cycle 2 end: rc=124 5400s turns=9 cost=$2.00 error=true',
    '[2026-09-27 04:50:15] cycle 2 hit its timeout',
    '[2026-09-27 05:00:00] finished: mode=wrapup done=yes',
    '[2026-09-27 06:00:00] cycle 1 start: mode=build opus/high timeout=7200s',
    '[2026-09-27 06:30:00] cycle 1 end: rc=0 1800s turns=4 cost=$3.00 error=false',
    '[2026-09-27 06:31:00] finished: mode=wrapup done=yes',
  ].join('\n'));
  const cj = (cost: number) => JSON.stringify({ num_turns: 3, total_cost_usd: cost, is_error: false, session_id: 's', modelUsage: { 'claude-opus-5-5': { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, costUSD: cost } } });
  fs.writeFileSync(path.join(logs, 'run1', 'cycle-001.json'), cj(1));
  fs.writeFileSync(path.join(logs, 'run1', 'cycle-002.json'), cj(2));
  fs.writeFileSync(path.join(logs, 'run1', 'cycle-002.err'), 'Background tasks still running after 600s; terminating.\n');
  fs.writeFileSync(path.join(logs, 'cycle-001.json'), cj(3));
  fs.writeFileSync(path.join(dir, 'harness', 'state', 'progress.md'), '| c2 | 1h | F-1 | ok | fixed |\n');
  fs.writeFileSync(path.join(dir, 'harness', 'state', 'backlog.md'), '- [x] F-1 bow bigger\n');
  fs.writeFileSync(path.join(dir, 'FEEDBACK.md'), '- the bow is too small → F-1\n');

  assert.equal(parseWatchdog(fs.readFileSync(path.join(logs, 'watchdog.log'), 'utf8')).runs, 2);
  const s = importRunSh(dir, { id: 'imp' });
  assert.deepEqual([s.runs, s.cycles, s.feedback], [2, 3, 1]);
  const p = goalPaths(dir);
  const results = [1, 2, 3].map((n) => JSON.parse(fs.readFileSync(path.join(p.cycleDir(n), 'result.json'), 'utf8')));
  assert.deepEqual(results.map((r) => [r.run, r.exit, r.cost_usd]), [['r1', 'ok', 1], ['r1', 'timeout', 2], ['r2', 'ok', 3]]);
  for (const r of results) assert.deepEqual(validate('cycle-result', r), []);
  for (const e of fs.readFileSync(p.events, 'utf8').trim().split('\n').map((l) => JSON.parse(l))) assert.deepEqual(validate('event', e), [], JSON.stringify(e));

  const r = buildReport(p);
  assert.equal(r.totals.cost_usd, 6);
  assert.equal(r.runs.length, 2);
  assert.equal(r.runs[0].wall_s, 2 * 3600);
  assert.equal(r.feedback[0].closed_cycle, 2);
  assert.ok(r.problems.some((x) => x.text.includes('Background tasks')));
  assert.throws(() => importRunSh(dir), /already has Epoptes records/);
});
