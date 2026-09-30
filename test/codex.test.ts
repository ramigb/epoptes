import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { codex, CodexStreamParser } from '../src/adapters/codex.ts';
import { startCli } from '../src/adapters/process.ts';
import type { CycleSpec } from '../src/adapters/types.ts';
import { validate } from '../src/schema.ts';
import { totalCost } from '../src/summary.ts';
import { summary as dashboardSummary, detail } from '../src/ui/views.ts';
import { GoalWatch } from '../src/ui/watch.ts';

const meta = { startedAt: '2026-09-30T10:00:00Z', endedAt: '2026-09-30T10:00:05Z', code: 0, signal: null, stderrTail: '' };

test('Codex JSONL maps activity, cached tokens and completion to the shared schemas', () => {
  const parser = new CodexStreamParser(process.cwd(), 'test-model');
  const messages = [
    null, { type: 'future.event' },
    { type: 'thread.started', thread_id: 'thread-1' }, { type: 'turn.started' },
    { type: 'item.started', item: { type: 'command_execution', command: 'node --test' } },
    { type: 'item.completed', item: { type: 'command_execution', command: 'node --test' } },
    { type: 'item.completed', item: { type: 'file_change', changes: [{ path: path.join(process.cwd(), 'out.txt'), kind: 'add' }] } },
    { type: 'item.started', item: { type: 'mcp_tool_call', server: 'docs', tool: 'search' } },
    { type: 'item.completed', item: { type: 'web_search', query: 'documentation' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'All checks pass.' } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } },
  ];
  const activity = messages.flatMap((m) => parser.feed(m).activity);
  for (const a of activity) assert.deepEqual(validate('activity', a), []);
  assert.equal(activity.filter((a) => a.tool === 'Bash').length, 1);
  assert.equal(activity.find((a) => a.tool === 'Edit')?.path, 'out.txt');
  const result = parser.result(meta);
  assert.equal(result.exit, 'ok');
  assert.equal(result.session_id, 'thread-1');
  assert.equal(result.turns, 1);
  assert.deepEqual(result.models['test-model'], { input: 20, output: 10, cache_read: 80, cache_write: 0, cost_usd: null });
  assert.equal(result.cost_usd, null);
  assert.deepEqual(validate('cycle-result', { version: 1, run: 'r1', cycle: 1, ...result }), []);
  parser.feed({ type: 'turn.started' });
  assert.equal(parser.result(meta).exit, 'error', 'a previous completed turn cannot mask a truncated next turn');
  parser.feed({ type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 2 } });
  assert.equal(parser.result(meta).models['test-model'].cache_read, 85);
  assert.equal(parser.result(meta).turns, 2);
});

test('Codex errors, missing completion, nonzero exit and rate limits remain failures', () => {
  const p = new CodexStreamParser(process.cwd(), 'test-model');
  assert.equal(p.result(meta).exit, 'error');
  p.feed({ type: 'turn.failed', error: { message: 'You have hit your usage limit' } });
  assert.equal(p.result({ ...meta, code: 1 }).exit, 'rate_limited');
  assert.equal(p.result({ ...meta, code: 1 }).rate_limit?.resets_at, null);
  p.feed({ type: 'turn.started' });
  p.feed({ type: 'turn.completed' });
  assert.equal(p.result({ ...meta, code: 1 }).exit, 'error');
  assert.equal(p.result({ ...meta, code: null, signal: 'SIGINT' }).exit, 'interrupted');
  p.feed({ type: 'error', message: 'authentication failed' });
  assert.match(p.result(meta).error!, /authentication failed/);
  const retried = new CodexStreamParser(process.cwd(), 'test-model');
  for (const m of [{ type: 'turn.started' }, { type: 'error', message: 'Reconnecting... 1/5' }, { type: 'turn.completed' }]) retried.feed(m);
  assert.equal(retried.result(meta).exit, 'ok', 'a transient error before completion does not fail the cycle');
  assert.equal(totalCost([{ cost_usd: 1 }, { cost_usd: null }]), null);
  assert.equal(totalCost([{ cost_usd: 1 }, { cost_usd: 2 }]), 3);
});

test('Codex goal defaults and commands use its sandbox, configured model and stdin', () => {
  const goal: any = { version: 1, id: 'codex-test', name: 'Codex', kind: 'other', objective: 'test', done: [{ id: 'D1', check: 'done', verify: { type: 'file', path: 'out.txt' } }], timebox: { total_min: 15 }, adapter: { type: 'codex' } };
  assert.deepEqual(validate('goal', goal), []);
  assert.equal(goal.adapter.model, '');
  assert.equal(goal.adapter.permission_mode, 'workspace-write');
  const spec: CycleSpec = { cwd: process.cwd(), goalDir: '.epoptes', cycleDir: os.tmpdir(), prompt: 'A long prompt\nwith "quotes" and $literal text.', model: '', effort: 'high', permissionMode: 'workspace-write', args: [], budgetUsd: null, agentsDir: 'agents', settingsFile: null, env: { PATH: process.env.PATH, ABSENT: undefined } };
  const cmd = codex.command(spec);
  assert.deepEqual(cmd.args, ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-c', 'model_reasoning_effort="high"', '-']);
  assert.equal(cmd.stdin, spec.prompt);
  assert.ok(!('ABSENT' in cmd.env));
  assert.throws(() => codex.command({ ...spec, budgetUsd: 1 }), /max_budget_usd/);
  assert.throws(() => codex.command({ ...spec, permissionMode: 'auto' }), /permission_mode/);
  goal.cycle.max_budget_usd = 1;
  assert.ok(validate('goal', goal).length);
  goal.cycle.max_budget_usd = null;
  goal.adapter.permission_mode = 'auto';
  assert.ok(validate('goal', goal).length);
  const legacy = { ...goal, adapter: { type: 'claude-code' } };
  assert.deepEqual(validate('goal', legacy), []);
  assert.equal(legacy.adapter.model, 'opus');
  assert.equal(legacy.adapter.permission_mode, 'auto');
});

test('missing CLI and early stdin closure produce results instead of crashing the runner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epoptes-spawn-'));
  const spec: CycleSpec = { cwd: dir, goalDir: dir, cycleDir: dir, prompt: 'x'.repeat(200000), model: '', effort: '', permissionMode: 'read-only', args: [], budgetUsd: null, agentsDir: dir, settingsFile: null, env: process.env };
  for (const command of [{ bin: path.join(dir, 'missing-cli'), args: [] }, { bin: process.execPath, args: ['-e', 'process.exit(1)'] }]) {
    const cycle = startCli(spec, { activity() {}, limits() {}, warn() {} }, { ...command, env: {}, stdin: spec.prompt }, new CodexStreamParser(dir, ''));
    assert.equal((await cycle.done).exit, 'error');
  }
});

test('dashboard reads Codex results and leaves unknown costs intact', (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'epoptes-codex-ui-'));
  const previousHome = process.env.EPOPTES_HOME;
  process.env.EPOPTES_HOME = path.join(project, 'home');
  t.after(() => {
    if (previousHome === undefined) delete process.env.EPOPTES_HOME;
    else process.env.EPOPTES_HOME = previousHome;
  });
  const root = path.join(project, '.epoptes');
  const dir = path.join(root, 'cycles', '000001');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, 'goal.json'), JSON.stringify({ version: 1, id: 'codex-ui', name: 'Codex', kind: 'other', objective: 'test', done: [{ id: 'D1', check: 'done', verify: { type: 'file', path: 'out.txt' } }], timebox: { total_min: 15 }, adapter: { type: 'codex' } }));
  const parser = new CodexStreamParser(project, 'test-model');
  parser.feed({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } });
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ version: 1, cycle: 1, run: 'r1', ...parser.result(meta) }));
  const watch = new GoalWatch('codex-ui', project);
  const card = dashboardSummary(watch);
  assert.equal(card.cost_usd, null);
  const page = detail(watch);
  assert.equal(page.cost_usd, null);
  assert.equal(page.cycles_detail?.[0].models['test-model'].cache_read, 80);
  assert.equal(page.goal?.adapter.type, 'codex');
});
