import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { agentsFromDir, parseFrontmatter, StreamParser } from '../src/adapters/claude-code.ts';
import { activeS, clockState, newClock, pauseClock, resumeClock } from '../src/clock.ts';
import { addFeedback, ingestInbox, readFeedback, setFeedbackStatus } from '../src/feedback.ts';
import { hm, parseDuration } from '../src/fsx.ts';
import { goalPaths } from '../src/paths.ts';
import { validate } from '../src/schema.ts';
import { backlogCounts } from '../src/summary.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'epoptes-test-'));
const iso = (s: number) => new Date(s * 1000).toISOString();

test('clock modes follow active time, and pauses do not count', () => {
  const t0 = 1_800_000_000;
  const c = newClock('r1', { total_min: 60, wrapup_min: 10, grace_min: 5, pause_on_rate_limit: true }, iso(t0));
  assert.equal(clockState(c, { now: t0 + 49 * 60 }).mode, 'build');
  assert.equal(clockState(c, { now: t0 + 50 * 60 }).mode, 'wrapup');
  assert.equal(clockState(c, { now: t0 + 61 * 60 }).mode, 'overtime');
  assert.equal(clockState(c, { now: t0 + 65 * 60 }).mode, 'stop');
  assert.equal(clockState(c, { now: t0 + 60, wrapupMarker: true }).mode, 'wrapup');

  const paused = pauseClock(c, iso(t0 + 600));
  assert.equal(activeS(paused, t0 + 3600), 600, 'frozen while paused');
  const resumed = resumeClock(paused, t0 + 3600);
  assert.equal(resumed.paused_s, 3000);
  assert.equal(activeS(resumed, t0 + 3660), 660);
});

test('durations', () => {
  assert.equal(parseDuration('2h'), 7200);
  assert.equal(parseDuration('1h30m'), 5400);
  assert.equal(parseDuration('45s'), 45);
  assert.throws(() => parseDuration('soon'));
  assert.equal(hm(3 * 3600 + 7 * 60), '3h07m');
  assert.equal(hm(-720), '-0h12m');
});

test('feedback: ids, status fold, inbox ingestion is idempotent', () => {
  const p = goalPaths(tmp());
  fs.mkdirSync(p.root, { recursive: true });
  assert.equal(addFeedback(p, 'the bow is too small', 'cli'), 'F-1');
  fs.writeFileSync(p.inbox, '# Inbox\n\nWrite notes here.\n\n- arms clip into dresses\n- \n- already handled → F-1\n* add a spin dance\n');
  assert.deepEqual(ingestInbox(p), ['F-2', 'F-3']);
  assert.deepEqual(ingestInbox(p), []);
  assert.match(fs.readFileSync(p.inbox, 'utf8'), /- arms clip into dresses → F-2\n- \n- already handled → F-1\n\* add a spin dance → F-3\n/);

  setFeedbackStatus(p, 'F-2', 'in_progress', 'orchestrator', 11);
  setFeedbackStatus(p, 'F-2', 'done', 'orchestrator', 12, 'arms clear skirts');
  const items = readFeedback(p);
  assert.equal(items.get('F-2')!.status, 'done');
  assert.equal(items.get('F-2')!.history.length, 3);
  assert.equal(items.get('F-3')!.src, 'file');
  assert.throws(() => setFeedbackStatus(p, 'F-9', 'done', 'user', null));
  assert.throws(() => setFeedbackStatus(p, 'F-1', 'finished' as never, 'user', null));
  for (const line of fs.readFileSync(p.feedback, 'utf8').trim().split('\n')) assert.deepEqual(validate('feedback', JSON.parse(line)), []);
});

test('stream parser: subagents, tools, limits and the last result', () => {
  const lines = fs.readFileSync(new URL('./fixtures/stream-subagent.jsonl', import.meta.url), 'utf8').trim().split('\n');
  const parser = new StreamParser('/work/probe', 'auto');
  const activity = [];
  const warns: string[] = [];
  let limits = null;
  for (const l of lines) {
    const r = parser.feed(JSON.parse(l));
    activity.push(...r.activity);
    warns.push(...r.warn);
    limits = r.limits ?? limits;
  }
  for (const a of activity) assert.deepEqual(validate('activity', a), [], JSON.stringify(a));

  assert.equal(activity[0].kind, 'init');
  const start = activity.find((a) => a.kind === 'agent.start')!;
  assert.match(start.agent, /^scribe#/);
  const sub = activity.filter((a) => a.agent === start.agent && a.kind === 'tool');
  assert.deepEqual(sub.map((a) => a.tool), ['Bash', 'Write']);
  assert.equal(sub[1].path, 'hello.txt', 'paths are relative to the cwd');
  assert.ok(activity.some((a) => a.kind === 'agent.end' && a.agent === start.agent));
  assert.ok(activity.some((a) => a.agent === 'orchestrator' && a.tool === 'Bash'));
  assert.equal(activity.filter((a) => a.kind === 'init').length, 1, 'later turns re-send init; only the first counts');

  assert.equal(warns.length, 1, 'requested auto but the stream reports default');
  assert.equal(limits!.status, 'allowed');
  assert.ok('five_hour' in limits!.windows);

  const res = parser.result({ startedAt: '2026-09-28T07:53:25.000Z', endedAt: '2026-09-28T07:53:41.000Z', code: 0, signal: null, stderrTail: '' });
  assert.equal(res.exit, 'ok');
  assert.equal(res.duration_s, 16);
  assert.equal(res.cost_basis, 'estimate');
  assert.equal(res.turns, 2);
  assert.ok(res.models['claude-haiku-4-5-20251001'].cache_read > 0);
  assert.deepEqual(validate('cycle-result', { version: 1, cycle: 1, run: 'r1', ...res }), []);
});

test('stream parser: rate limits and errors', () => {
  const p = new StreamParser('/w');
  p.feed({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_800_000_000 } });
  p.feed({ type: 'result', is_error: true, result: 'limit reached', modelUsage: {} });
  const r = p.result({ startedAt: iso(0), endedAt: iso(1), code: 1, signal: null, stderrTail: '' });
  assert.equal(r.exit, 'rate_limited');
  assert.equal(r.rate_limit!.resets_at, iso(1_800_000_000));

  const q = new StreamParser('/w').result({ startedAt: iso(0), endedAt: iso(1), code: 1, signal: null, stderrTail: 'API Error: 529 overloaded' });
  assert.equal(q.exit, 'rate_limited', 'text fallback, as in run.sh');
  const e = new StreamParser('/w').result({ startedAt: iso(0), endedAt: iso(1), code: 1, signal: null, stderrTail: 'boom' });
  assert.equal(e.exit, 'error');
  assert.match(e.error!, /exit 1: boom/);
});

test('role files become --agents JSON', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'qa.md'), '---\nname: qa\ndescription: "Runs checks"\nmodel: haiku\neffort: low\nmaxTurns: 25\ntools: Read, Bash(npm run *)\n---\n\nRun the checks.\n');
  assert.deepEqual(agentsFromDir(dir), { qa: { description: 'Runs checks', prompt: 'Run the checks.', model: 'haiku', effort: 'low', maxTurns: 25, tools: ['Read', 'Bash(npm run *)'] } });
  assert.deepEqual(parseFrontmatter('no frontmatter'), { data: {}, body: 'no frontmatter' });
});

test('backlog markers', () => {
  const p = goalPaths(tmp());
  fs.mkdirSync(p.state, { recursive: true });
  fs.writeFileSync(path.join(p.state, 'backlog.md'), '**Current milestone: M2**\n- [x] A\n- [ ] B\n- [~] C\n- [blocked: needs key] D\n- [cut] E\n  - [X] F\n');
  assert.deepEqual(backlogCounts(p), { todo: 1, doing: 1, done: 2, blocked: 1, cut: 1, milestone: 'M2' });
});

test('skill templates: goal.json validates once filled in, and every template file is lint-clean after adaptation', () => {
  const tpl = new URL('../plugin/skills/epoptes/templates/', import.meta.url);
  const raw = fs.readFileSync(new URL('goal.json', tpl), 'utf8');
  const filled = JSON.parse(raw.replace('{{goal-id}}', 'sample').replace(/\{\{[^}]*\}\}/g, 'sample text'));
  assert.deepEqual(validate('goal', filled), []);
  const settings = JSON.parse(fs.readFileSync(new URL('settings.json', tpl), 'utf8'));
  for (const d of ['Bash(git push *)', 'Bash(git reset --hard *)', 'Bash(git clean -fdx *)', 'Read(./.env)']) assert.ok(settings.permissions.deny.includes(d), d);
  const skill = fs.readFileSync(new URL('../plugin/skills/epoptes/SKILL.md', import.meta.url), 'utf8');
  const { data } = parseFrontmatter(skill);
  assert.equal(data.name, 'epoptes');
  assert.ok(data.description.length > 50);
  for (const ref of skill.matchAll(/\]\(([^)#]+)\)/g)) assert.ok(fs.existsSync(new URL(`../plugin/skills/epoptes/${ref[1]}`, import.meta.url)), `SKILL.md links to missing ${ref[1]}`);
});
