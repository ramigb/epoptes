#!/usr/bin/env node
// Stands in for `claude -p` in runner tests (set EPOPTES_CLAUDE_BIN to this file). Costs no tokens.
// FAKE_CLAUDE = ok (default) | slow | error | ratelimit | trickle (slow stream, for watching the dashboard)
//   | approval (asks for an approval, then waits for the human). FAKE_DONE_AT = cycle number that marks the goal DONE.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const mode = process.env.FAKE_CLAUDE ?? 'ok';
const cycle = Number(process.env.EPOPTES_CYCLE);
const argv = process.argv.slice(2);
const arg = (name) => argv[argv.indexOf(name) + 1];

if (argv[0] === '--version') {
  console.log('0.0.0 (fake claude)');
  process.exit(0);
}

// The same executable also stands in for `codex exec --json` in adapter tests.
if (argv[0] === 'exec') {
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  fs.writeFileSync(path.join(process.env.EPOPTES_GOAL_DIR, 'cycles', String(cycle).padStart(6, '0'), 'fake-argv.json'), JSON.stringify({ argv, prompt }));
  const out = (m) => console.log(JSON.stringify(m));
  out({ type: 'thread.started', thread_id: `codex-${cycle}` });
  out({ type: 'turn.started' });
  if (mode === 'slow') {
    process.on('SIGINT', () => process.exit(130));
    await new Promise((r) => setTimeout(r, 60000));
  } else if (mode === 'error' || mode === 'ratelimit') {
    out({ type: 'turn.failed', error: { message: mode === 'ratelimit' ? 'You have hit your usage limit' : 'something broke' } });
    process.exit(1);
  }
  out({ type: 'item.started', item: { type: 'command_execution', command: 'epoptes event note' } });
  execFileSync('epoptes', ['event', 'note', `fake codex cycle ${cycle} ran`]);
  out({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'out.txt', kind: 'add' }] } });
  out({ type: 'item.completed', item: { type: 'agent_message', text: 'Completed the work.' } });
  out({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } });
  if (Number(process.env.FAKE_DONE_AT) === cycle) execFileSync('epoptes', ['event', 'done', 'fake codex finished']);
  process.exit(0);
}

// Record what we were started with, so tests can check flags and generated files.
const settings = JSON.parse(fs.readFileSync(arg('--settings'), 'utf8'));
const agents = JSON.parse(fs.readFileSync(arg('--agents'), 'utf8'));
fs.writeFileSync(
  path.join(path.dirname(arg('--settings')), 'fake-argv.json'),
  JSON.stringify({ argv: argv.filter((a, i) => argv[i - 1] !== '-p'), settings, agents, env: { cycle, mode: process.env.EPOPTES_MODE, bg: process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS } }),
);

const fixture = fs.readFileSync(new URL('./fixtures/stream-subagent.jsonl', import.meta.url), 'utf8').trim().split('\n');
const out = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n');

if (mode === 'error') {
  process.stderr.write('something broke\n');
  process.exit(1);
}
if (mode === 'ratelimit') {
  out(fixture[0]);
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) - 10, unifiedWindows: { five_hour: { utilization: 1, resetsAt: 0 } } } });
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, result: "You've hit your usage limit", total_cost_usd: 0, modelUsage: {} });
  process.exit(1);
}
if (mode === 'trickle') {
  const delay = Number(process.env.FAKE_DELAY_MS ?? 900);
  for (const [i, line] of fixture.entries()) {
    out(line);
    if (i === Math.floor(fixture.length / 2) && cycle % 2 === 0) execFileSync('epoptes', ['event', 'milestone', `halfway through cycle ${cycle}`]);
    await new Promise((r) => setTimeout(r, delay));
  }
  if (Number(process.env.FAKE_DONE_AT) === cycle) execFileSync('epoptes', ['event', 'done', 'demo finished']);
  process.exit(0);
}
if (mode === 'approval') {
  for (const line of fixture) out(line);
  execFileSync('epoptes', ['approval', 'buy a $5 font licence', '--ref', 'M1-2']);
  execFileSync('epoptes', ['wait-for-human', 'approve or reject F-1 (the font)']);
} else if (mode === 'slow') {
  out(fixture[0]);
  process.on('SIGINT', () => process.exit(130));
  setTimeout(() => process.exit(0), 60_000);
} else {
  for (const line of fixture) out(line);
  execFileSync('epoptes', ['event', 'note', `fake cycle ${cycle} ran`]); // through the run/bin shim on PATH
  if (Number(process.env.FAKE_DONE_AT) === cycle) fs.writeFileSync(path.join(process.env.EPOPTES_GOAL_DIR, 'run', 'DONE'), '');
}
