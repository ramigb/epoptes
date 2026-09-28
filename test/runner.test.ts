// End-to-end runner tests through the real CLI and detached runner, with a fake `claude` (no tokens).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readJsonl } from '../src/fsx.ts';
import { validate } from '../src/schema.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const fake = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));

function setup(extra: Record<string, unknown> = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'epoptes-e2e-'));
  const project = path.join(base, 'project');
  const root = path.join(project, '.epoptes');
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'loop.md'), 'Read `epoptes feedback --open`, do one small thing, then `epoptes event done` when finished.\n');
  fs.writeFileSync(path.join(root, 'agents', 'scribe.md'), '---\nname: scribe\ndescription: Writes files\nmodel: haiku\n---\nWrite the file.\n');
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ permissions: { allow: ['Read'], deny: ['Bash(git push *)', 'Bash(git reset --hard *)', 'Bash(git clean -fdx *)'] } }));
  const goal = {
    version: 1, id: `e2e-${path.basename(base).slice(-6).toLowerCase()}`, name: 'E2E', kind: 'other', objective: 'test',
    done: [{ id: 'D1', check: 'done', verify: { type: 'file', path: 'out.txt' } }],
    approval_required: ['spending money'],
    timebox: { total_min: 15, wrapup_min: 3, grace_min: 2 },
    adapter: { type: 'claude-code', model: 'haiku', effort: 'low' },
    cycle: { pause_between_s: 0 },
    ...extra,
  };
  fs.writeFileSync(path.join(root, 'goal.json'), JSON.stringify(goal));
  const env = { ...process.env, EPOPTES_HOME: path.join(base, 'home'), EPOPTES_CLAUDE_BIN: fake, EPOPTES_CYCLE: '', EPOPTES_GOAL_DIR: '' };
  const run = (args: string[], more: Record<string, string> = {}) =>
    execFileSync(process.execPath, [cli, ...args], { env: { ...env, ...more }, encoding: 'utf8' });
  run(['add', project]);
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
  return { project, root, run, read, events: () => readJsonl<any>(path.join(root, 'events.jsonl')) };
}

async function until(fn: () => boolean, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (fn()) return;
    } catch {
      // file not there yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting');
}

test('runs cycles until the orchestrator marks DONE', async () => {
  const g = setup();
  g.run(['start', g.project], { FAKE_DONE_AT: '2' });
  await until(() => g.read('run/status.json').state === 'done');

  const status = g.read('run/status.json');
  assert.equal(status.cycle, 2);
  assert.equal(status.pid, null);
  assert.deepEqual(validate('status', status), []);
  assert.ok(g.read('run/clock.json').paused_at, 'clock frozen once the runner exits');
  assert.equal(fs.existsSync(path.join(g.root, 'run', 'runner.lock')), false);

  for (const n of [1, 2]) {
    const dir = `cycles/00000${n}`;
    const r = g.read(`${dir}/result.json`);
    assert.equal(r.exit, 'ok');
    assert.deepEqual(validate('cycle-result', r), []);
    const argv = g.read(`${dir}/fake-argv.json`);
    assert.equal(argv.settings.permissions.defaultMode, 'auto', 'settings file carries the permission mode');
    assert.deepEqual(argv.settings.permissions.deny, ['Bash(git push *)', 'Bash(git reset --hard *)', 'Bash(git clean -fdx *)']);
    assert.deepEqual(argv.settings.permissions.allow, ['Read', 'Bash(epoptes *)']);
    assert.equal(argv.agents.scribe.model, 'haiku');
    assert.equal(argv.env.bg, '0');
    assert.ok(argv.argv.includes('stream-json'));
    assert.ok(fs.readFileSync(path.join(g.root, dir, 'activity.jsonl'), 'utf8').includes('agent.start'));
  }

  const ev = g.events();
  for (const e of ev) assert.deepEqual(validate('event', e), [], JSON.stringify(e));
  assert.deepEqual(
    ev.filter((e) => e.src === 'runner' && e.type !== 'warn' && e.type !== 'wait').map((e) => e.type),
    ['run.start', 'cycle.start', 'cycle.end', 'cycle.start', 'cycle.end', 'run.end'],
  );
  assert.equal(ev.at(-1).reason, 'done');
  const notes = ev.filter((e) => e.type === 'note');
  assert.deepEqual(notes.map((e) => [e.src, e.cycle, e.run, e.text]), [['orchestrator', 1, 'r1', 'fake cycle 1 ran'], ['orchestrator', 2, 'r1', 'fake cycle 2 ran']]);
  assert.match(g.run(['status', g.project]), /state done .* cycle 2/);

  // After DONE, a plain start refuses (it would spend tokens on a finished goal); --new-run begins a new run.
  assert.throws(() => g.run(['start', g.project]), /this goal is done/);
  g.run(['start', g.project, '--new-run'], { FAKE_DONE_AT: '3' });
  await until(() => g.read('run/status.json').state === 'done' && g.read('run/status.json').cycle === 3);
  assert.equal(g.read('cycles/000003/result.json').run, 'r2');
  assert.deepEqual(g.events().filter((e) => e.type === 'control').map((e) => e.action), ['start', 'start']);
});

test('stop interrupts the cycle; start resumes the same run', async () => {
  const g = setup();
  g.run(['start', g.project], { FAKE_CLAUDE: 'slow' });
  await until(() => g.read('run/status.json').state === 'running');
  assert.throws(() => g.run(['start', g.project]), /already running/);
  g.run(['stop', g.project]);
  await until(() => g.read('run/status.json').state === 'stopped');
  assert.equal(g.read('cycles/000001/result.json').exit, 'interrupted');

  g.run(['start', g.project], { FAKE_DONE_AT: '2' });
  await until(() => g.read('run/status.json').state === 'done');
  assert.equal(g.read('cycles/000002/result.json').run, 'r1', 'resumed, not a new run');
  assert.equal(g.events().filter((e) => e.type === 'run.start')[1].resumed, true);
  assert.deepEqual(g.events().filter((e) => e.type === 'control').map((e) => e.action), ['start', 'stop', 'resume']);
});

test('pause after this cycle, extend, feedback and events from the CLI', async () => {
  const g = setup();
  g.run(['start', g.project], { FAKE_CLAUDE: 'slow' });
  await until(() => g.read('run/status.json').state === 'running');
  g.run(['pause', g.project]);
  // The slow fake runs 60 s; interrupt it so the test is quick. Stop wins over pause.
  g.run(['stop', g.project]);
  await until(() => ['stopped', 'paused'].includes(g.read('run/status.json').state));

  const before = g.read('run/clock.json').timebox_s;
  g.run(['extend', g.project, '30m']);
  assert.equal(g.read('run/clock.json').timebox_s, before + 1800);

  assert.match(g.run(['feedback', g.project, 'make the title bigger']), /added F-1/);
  const inCycle = { EPOPTES_GOAL_DIR: g.root, EPOPTES_CYCLE: '4', EPOPTES_RUN: 'r1' };
  g.run(['feedback', 'F-1', 'in_progress'], inCycle);
  g.run(['feedback', 'F-1', 'done', 'bigger', 'title'], inCycle);
  g.run(['event', 'milestone', 'M1', 'done'], inCycle);
  g.run(['event', 'wrapup', 'backlog clear'], inCycle);
  assert.ok(fs.existsSync(path.join(g.root, 'run', 'WRAPUP')));
  const fb = readJsonl<any>(path.join(g.root, 'feedback.jsonl'));
  assert.deepEqual(fb.map((f) => f.status ?? f.op), ['add', 'in_progress', 'done']);
  assert.equal(fb[2].note, 'bigger title');
  assert.equal(fb[2].by, 'orchestrator');
  const ms = g.events().find((e) => e.type === 'milestone');
  assert.deepEqual([ms.src, ms.cycle, ms.text], ['orchestrator', 4, 'M1 done']);
  assert.match(g.run(['status', g.project]), /feedback 0 new · 0 open · 0 blocked · 1 closed/);
});

test('gives up after repeated failures and reports a crash', async () => {
  const g = setup({ failures: { cooldown_after: 5, cooldown_min: 0, give_up_after: 2 } });
  g.run(['start', g.project], { FAKE_CLAUDE: 'error' });
  await until(() => g.read('run/status.json').state === 'failed');
  assert.equal(g.read('cycles/000002/result.json').exit, 'error');
  assert.match(g.read('cycles/000001/result.json').error, /something broke/);

  // A runner that dies without cleaning up is reported as crashed by the next reader.
  const s = g.read('run/status.json');
  fs.writeFileSync(path.join(g.root, 'run', 'status.json'), JSON.stringify({ ...s, state: 'running', pid: 999999 }));
  assert.match(g.run(['status', g.project]), /state crashed/);
});

test('dry run checks the setup and never starts the clock', () => {
  const g = setup();
  const out = g.run(['run', g.project, '--dry-run']);
  assert.match(out, /clock: not started/);
  assert.match(out, /--permission-mode auto/);
  assert.match(out, /\nok\n$/);
  assert.match(g.run(['clock', g.project]), /MODE=none/);

  // Template leftovers are problems; secrets and missing guardrails are warnings.
  fs.writeFileSync(path.join(g.root, 'state', 'notes.md'), 'token = abcdefghijklmnopqrstuvwx\n{{fill me}}\n');
  fs.writeFileSync(path.join(g.root, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(*)'] } }));
  let failed = '';
  try {
    g.run(['run', g.project, '--dry-run']);
  } catch (e) {
    failed = (e as { stdout: string }).stdout;
  }
  assert.match(failed, /state\/notes\.md still has \{\{placeholders\}\}/);
  assert.match(failed, /state\/notes\.md looks like it contains a password assignment/);
  assert.doesNotMatch(failed, /abcdefghijklmnop/, 'never prints the secret itself');
  assert.match(failed, /deny list is missing Bash\(git push \*\)/);
  assert.match(failed, /allows Bash\(\*\)/);
  assert.equal(fs.existsSync(path.join(g.root, 'run', 'clock.json')), false);
});
