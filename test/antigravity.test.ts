import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { antigravity, AgyStreamParser } from '../src/adapters/antigravity.ts';
import type { CycleSpec } from '../src/adapters/types.ts';
import { validate } from '../src/schema.ts';

const meta = { startedAt: '2026-10-28T10:00:00Z', endedAt: '2026-10-28T10:00:05Z', code: 0, signal: null, stderrTail: '' };
const step = (s: object) => ({ event: 'step_update', step_update: { conversation_id: 'c1', ...s } });
const result = (r: object) => ({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: '', num_turns: 1, ...r } });

test('agy stream-json events (recorded from agy 1.4.9) map to activity, usage and results', () => {
  const p = new AgyStreamParser(process.cwd(), '');
  const usage = { input_tokens: 7605, output_tokens: 84, thinking_tokens: 6, cache_read_tokens: 5000, total_tokens: 7695 };
  const fed = [
    null, { event: 'future' },
    { event: 'init', conversation_id: 'c1', init: { model: 'gemini-3.8-flash', tools: [], permission_mode: 'request-review' } },
    step({ step_index: 0, state: 'DONE', step_type: 'user_input' }),
    step({ step_index: 1, state: 'DONE', step_type: 'agent_response', usage }),
    step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: path.join(process.cwd(), 'a.txt') } } }),
    step({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: {}, output: '1 lines' } }),
    step({ step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'npm test' } } }),
    step({ step_index: 4, state: 'ACTIVE', step_type: 'tool', tool_name: 'invoke_subagent', tool_info: { name: 'invoke_subagent', parameters: { Role: 'Lister' } } }),
    step({ step_index: 5, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'All ' }),
    step({ step_index: 5, state: 'DONE', step_type: 'agent_response', text_delta: 'good.', usage }),
    result({ usage: { ...usage, input_tokens: 20000, cache_read_tokens: 12000 } }),
  ].map((m) => p.feed(m));
  const activity = fed.flatMap((r) => r.activity);
  for (const a of activity) assert.deepEqual(validate('activity', a), []);
  assert.equal(activity[0].summary, 'gemini-3.8-flash · antigravity');
  assert.equal(activity.find((a) => a.tool === 'Read')?.path, 'a.txt');
  assert.equal(activity.find((a) => a.tool === 'Bash')?.summary, 'npm test');
  assert.equal(activity.find((a) => a.tool === 'Agent')?.summary, 'Lister');
  assert.ok(activity.some((a) => a.kind === 'text' && a.summary === 'All good.'));
  const live = fed.map((r) => r.usage).filter(Boolean);
  assert.deepEqual(live[1], { models: { 'gemini-3.8-flash': { input: 5210, output: 180, cache_read: 10000, cache_write: 0, cost_usd: null } }, cost_usd: null });
  const r = p.result(meta);
  assert.equal(r.exit, 'ok');
  assert.equal(r.session_id, 'c1');
  assert.equal(r.turns, 2);
  assert.deepEqual(r.models['gemini-3.8-flash'], { input: 8000, output: 90, cache_read: 12000, cache_write: 0, cost_usd: null }, "the result's totals win");
  assert.deepEqual(validate('cycle-result', { version: 1, run: 'r1', cycle: 1, ...r }), []);
});

test('agy failures: denied commands, errors, quota, no result and signals', () => {
  const run = (...ms: unknown[]) => {
    const p = new AgyStreamParser(process.cwd(), 'm');
    for (const m of ms) p.feed(m);
    return p;
  };
  const denied = run(result({ denied_actions: [{ action: 'command', display_name: 'RunCommand' }] }));
  assert.equal(denied.result(meta).exit, 'error', 'a denied command ends the turn although agy says SUCCESS');
  assert.match(denied.result(meta).error!, /command\(epoptes\)/);
  assert.ok(run().feed(result({ denied_actions: [{ action: 'command', display_name: 'RunCommand' }] })).warn.length);
  const bad = run(result({ status: 'ERROR', conversation_id: '', error: 'invalid model selection' })).result({ ...meta, code: 1 });
  assert.equal(bad.exit, 'error');
  assert.match(bad.error!, /invalid model/);
  assert.equal(run(result({ status: 'ERROR', error: 'RESOURCE_EXHAUSTED: quota' })).result({ ...meta, code: 1 }).exit, 'rate_limited');
  assert.match(run().result(meta).error!, /no result/);
  assert.equal(run().result({ ...meta, code: null, signal: 'SIGINT' }).exit, 'interrupted');
});

test('Antigravity goal defaults and command: modes, model, effort and the prompt in -p', () => {
  const goal: any = { version: 1, id: 'agy-test', name: 'agy', kind: 'other', objective: 'test', done: [{ id: 'D1', check: 'done', verify: { type: 'file', path: 'out.txt' } }], timebox: { total_min: 15 }, adapter: { type: 'antigravity' } };
  assert.deepEqual(validate('goal', goal), []);
  assert.deepEqual([goal.adapter.model, goal.adapter.effort, goal.adapter.permission_mode], ['', '', 'accept-edits']);
  assert.ok(validate('goal', { ...goal, adapter: { type: 'antigravity', permission_mode: 'default' } }).length);
  assert.ok(validate('goal', { ...goal, cycle: { max_budget_usd: 1 } }).length);
  const spec: CycleSpec = { cwd: process.cwd(), goalDir: '/g', cycleDir: '/g/c', prompt: 'A prompt\nwith "quotes".', model: 'gemini-3.8-flash', effort: 'low', permissionMode: 'accept-edits', args: ['--sandbox'], budgetUsd: null, agentsDir: '/g/agents', settingsFile: null, env: { PATH: process.env.PATH, ABSENT: undefined } };
  const cmd = antigravity.command(spec);
  assert.deepEqual(cmd.args, ['--output-format', 'stream-json', '--mode', 'accept-edits', '--model', 'gemini-3.8-flash', '--effort', 'low', '--sandbox', `-p=${spec.prompt}`]);
  assert.equal(cmd.stdin, undefined);
  assert.ok(!('ABSENT' in cmd.env));
  assert.deepEqual(antigravity.command({ ...spec, permissionMode: 'skip-permissions', model: '', effort: '', args: [] }).args, ['--output-format', 'stream-json', '--dangerously-skip-permissions', `-p=${spec.prompt}`]);
  assert.throws(() => antigravity.command({ ...spec, permissionMode: 'default' }), /permission_mode/);
  assert.throws(() => antigravity.command({ ...spec, budgetUsd: 1 }), /max_budget_usd/);
});

test('role files become agy subagents in the cycle folder, with Claude tool names mapped to agy tools', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epoptes-agy-'));
  fs.mkdirSync(path.join(dir, 'agents'));
  fs.writeFileSync(path.join(dir, 'agents', 'qa.md'), '---\nname: qa\ndescription: Runs "checks"\nmodel: flash\neffort: low\ntools: Read, Bash(npm run *), Grep, Agent\n---\nRun the checks.\n');
  fs.writeFileSync(path.join(dir, 'agents', 'builder.md'), '---\nname: builder\ndescription: Builds\n---\nBuild.\n');
  const spec: CycleSpec = { cwd: dir, goalDir: dir, cycleDir: path.join(dir, 'c1'), prompt: 'go', model: '', effort: '', permissionMode: 'accept-edits', args: [], budgetUsd: null, agentsDir: path.join(dir, 'agents'), settingsFile: null, env: {} };
  assert.deepEqual(antigravity.command(spec).args.slice(-3), ['--add-dir', spec.cycleDir, '-p=go']);
  const read = (n: string) => fs.readFileSync(path.join(spec.cycleDir, '.agents', 'agents', `${n}.md`), 'utf8');
  assert.equal(read('qa'), '---\nname: "qa"\ndescription: "Runs \\"checks\\""\nmodel: "flash"\nmainAgent: false\ntools: ["view_file", "read_file", "run_command", "grep_search"]\n---\nRun the checks.\n');
  assert.match(read('builder'), /^---\nname: "builder"\ndescription: "Builds"\nmainAgent: false\ntools: \[.*"write_to_file".*\]\n---\nBuild\.\n$/, 'no tools listed means all of them, as in Claude Code');
  assert.ok(!antigravity.command({ ...spec, agentsDir: path.join(dir, 'none') }).args.includes('--add-dir'));
});
