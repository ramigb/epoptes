import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { agentsFromDir, parseFrontmatter, StreamParser } from '../src/adapters/claude-code.ts';
import { activeS, clockState, newClock, pauseClock, resumeClock, readClock, writeClock } from '../src/clock.ts';
import { addCard, askApproval, boardCounts, boardMilestones, commentCard, currentCards, decide, followUpCards, ingest, isBlocked, openWork, pendingApprovals, readBoard, setCard } from '../src/board.ts';
import { hm, parseDuration } from '../src/fsx.ts';
import { goalPaths } from '../src/paths.ts';
import { validate } from '../src/schema.ts';
import { idleStatus, reconcile, writeStatus } from '../src/status.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'epoptes-test-'));
const iso = (s: number) => new Date(s * 1000).toISOString();
/** A project with a bare goal.json: enough for the board (it reads goal.json without validating it). */
const tmpGoal = () => {
  const p = goalPaths(tmp());
  fs.mkdirSync(p.state, { recursive: true });
  fs.writeFileSync(p.goal, JSON.stringify({ id: 'g', name: 'G' }));
  return p;
};

test('own-cycle readers do not crash a runner hidden by a sandbox PID namespace', (t) => {
  const p = goalPaths(tmp());
  const context = { EPOPTES_GOAL_DIR: p.root, EPOPTES_RUN: 'r1', EPOPTES_CYCLE: '1' };
  const previous = Object.fromEntries(Object.keys(context).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const status = { ...idleStatus(), state: 'running' as const, pid: 2147483647, run: 'r1', cycle: 1, heartbeat_at: iso(1800000000) };
  const clock = newClock('r1', { total_min: 15, wrapup_min: 2, grace_min: 0, pause_on_rate_limit: true });
  const seed = () => {
    writeStatus(p, status);
    writeClock(p, clock);
    fs.writeFileSync(p.lock, String(status.pid));
  };
  Object.assign(process.env, context);
  seed();
  assert.equal(reconcile(p).state, 'running');
  assert.equal(readClock(p)!.paused_at, null);
  assert.ok(fs.existsSync(p.lock));
  assert.ok(!fs.existsSync(p.events), 'no false crash event');

  for (const key of Object.keys(context)) {
    Object.assign(process.env, context);
    process.env[key] = 'different';
    seed();
    assert.equal(reconcile(p).state, 'crashed', `${key} must match this goal and cycle`);
    assert.equal(readClock(p)!.paused_at, status.heartbeat_at);
    assert.ok(!fs.existsSync(p.lock), 'external readers still repair a dead runner');
  }
});

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

test('board: ids, inbox ingestion, whose turn it is, reopening and approvals', () => {
  const p = tmpGoal();
  assert.equal(addCard(p, 'the bow is too small', 'cli'), 'C-1');
  fs.writeFileSync(p.inbox, '# Inbox\n\nWrite notes here.\n\n- arms clip into dresses\n- \n- already handled → C-1\n* add a spin dance\n');
  assert.deepEqual(ingest(p), ['C-2', 'C-3']);
  assert.deepEqual(ingest(p), []);
  assert.match(fs.readFileSync(p.inbox, 'utf8'), /- arms clip into dresses → C-2\n- \n- already handled → C-1\n\* add a spin dance → C-3\n/);

  let c = readBoard(p).cards;
  assert.deepEqual([c.get('C-1')!.column, c.get('C-1')!.epic, c.get('C-1')!.waiting, c.get('C-3')!.src], ['backlog', 'job-1', true, 'file']);
  // The orchestrator triages it: no longer waiting. The human comments: waiting again. Any agent reply answers it.
  setCard(p, 'C-1', { column: 'todo', milestone: 'm1' }, 'orchestrator', 3);
  assert.deepEqual([readBoard(p).cards.get('C-1')!.waiting, readBoard(p).cards.get('C-1')!.milestone], [false, 'M1']);
  commentCard(p, 'C-1', 'make it red too', 'user', null, true);
  assert.deepEqual([readBoard(p).cards.get('C-1')!.waiting, readBoard(p).cards.get('C-1')!.steering], [true, true]);
  commentCard(p, 'C-1', 'will do', 'worker', 4);
  c = readBoard(p).cards;
  assert.deepEqual([c.get('C-1')!.waiting, c.get('C-1')!.steering, c.get('C-1')!.cycle], [false, false, 4]);
  // Done, then the human comments: back to TODO. Cut, then moved: the cut reason goes.
  setCard(p, 'C-1', { column: 'done' }, 'orchestrator', 5);
  commentCard(p, 'C-1', 'still too small on phones', 'user');
  assert.deepEqual([readBoard(p).cards.get('C-1')!.column, readBoard(p).cards.get('C-1')!.waiting], ['todo', true]);
  setCard(p, 'C-2', { column: 'done', cut: 'not a bug' }, 'orchestrator', 5);
  assert.equal(readBoard(p).cards.get('C-2')!.cut, 'not a bug');
  setCard(p, 'C-2', { column: 'todo' }, 'user');
  assert.equal(readBoard(p).cards.get('C-2')!.cut, null);

  // An approval goes on the card it gates; a ref that isn't a card gets a new one.
  assert.equal(askApproval(p, 'buy a font', 'C-3', 'orchestrator', 6), 'C-3');
  assert.equal(askApproval(p, 'use a paid API', 'M2-1', 'orchestrator', 6), 'C-4');
  c = readBoard(p).cards;
  assert.deepEqual([isBlocked(c.get('C-3')!), c.get('C-4')!.title, c.get('C-4')!.column], [true, 'M2-1: use a paid API', 'todo']);
  assert.deepEqual(pendingApprovals([...c.values()]).map((x) => x.id), ['C-3', 'C-4']);
  assert.throws(() => decide(p, 'C-2', 'approved'), /no approval request/);
  decide(p, 'C-3', 'rejected', 'free fonts only');
  c = readBoard(p).cards;
  assert.deepEqual([isBlocked(c.get('C-3')!), c.get('C-3')!.waiting, c.get('C-3')!.comments.at(-1)!.text], [false, true, 'rejected: free fonts only']);

  assert.throws(() => setCard(p, 'C-9', { column: 'done' }, 'user'), /no card C-9/);
  assert.throws(() => setCard(p, 'C-1', { column: 'finished' as never }, 'user'), /unknown column/);
  assert.throws(() => commentCard(p, 'C-1', '  ', 'user'), /empty/);
  for (const line of fs.readFileSync(p.board, 'utf8').trim().split('\n')) assert.deepEqual(validate('board', JSON.parse(line)), [], line);
});

test('board: a harness from before the board is imported once (feedback.jsonl, backlog.md)', () => {
  const p = tmpGoal();
  const ops = [
    { ts: '2026-09-28T10:00:00.000Z', op: 'add', id: 'F-1', text: 'bigger title', src: 'dashboard' },
    { ts: '2026-09-28T10:01:00.000Z', op: 'add', id: 'F-2', text: 'buy a font', src: 'orchestrator', kind: 'approval', ref: 'M1-2' },
    { ts: '2026-09-28T10:02:00.000Z', op: 'decide', id: 'F-2', decision: 'approved', by: 'user' },
    { ts: '2026-09-28T10:03:00.000Z', op: 'add', id: 'F-3', text: 'rebuild as an app', src: 'cli' },
    { ts: '2026-09-28T10:04:00.000Z', op: 'status', id: 'F-3', status: 'blocked', by: 'orchestrator', cycle: 2, note: 'needs a new run: big' },
    { ts: '2026-09-28T10:05:00.000Z', op: 'add', id: 'F-4', text: 'stray idea', src: 'cli' },
    { ts: '2026-09-28T10:06:00.000Z', op: 'status', id: 'F-4', status: 'wont_do', by: 'orchestrator', cycle: 2, note: 'out of scope' },
  ];
  fs.writeFileSync(p.feedback, ops.map((o) => JSON.stringify(o)).join('\n') + '\n');
  fs.writeFileSync(path.join(p.state, 'backlog.md'), [
    '# Backlog', '**Current milestone: M1**', '## Feedback (from `epoptes feedback`)', '- [x] F-1 bigger title',
    '## M1 · Form works (target 0:40)', '- [x] M1-1 a', '- [~] M1-2 b', '- [blocked: needs key] M1-3 c', '- [cut] M1-4 d',
    '## Review fixes', '- [ ] R-1 [low] nicer shadow',
  ].join('\n'));
  const b = readBoard(p);
  assert.ok(fs.existsSync(`${p.feedback}.imported`) && !fs.existsSync(p.feedback));
  assert.ok(fs.existsSync(path.join(p.state, 'backlog.md.imported')));
  const c = (id: string) => b.cards.get(id)!;
  assert.deepEqual([c('F-1').column, c('F-1').waiting], ['done', false], 'the backlog line moved the feedback card');
  assert.deepEqual([c('F-2').approval!.decision, c('F-2').waiting], ['approved', true]);
  assert.deepEqual([c('F-3').blocked, c('F-4').cut, c('F-4').comments[0].text], ['needs a new run: big', "won't do", 'out of scope']);
  assert.deepEqual([...b.cards.values()].filter((x) => x.id.startsWith('C-')).map((x) => [x.title, x.column, x.milestone, x.blocked, x.cut, x.priority]), [
    ['M1-1 a', 'done', 'M1', null, null, null], ['M1-2 b', 'doing', 'M1', null, null, null], ['M1-3 c', 'todo', 'M1', 'needs key', null, null],
    ['M1-4 d', 'done', 'M1', null, 'cut', null], ['R-1 [low] nicer shadow', 'todo', null, null, null, 'low'],
  ]);
  const cards = currentCards(p);
  assert.deepEqual(boardCounts(cards, boardMilestones(b, 'job-1')), { backlog: 0, todo: 2, doing: 1, review: 0, done: 2, blocked: 2, cut: 2, milestone: 'M1' });
  assert.deepEqual(followUpCards(cards).map((x) => x.id), ['F-2'], 'blocked, cut and done cards are not follow-up work');
  // Seeding again later adds to the board; the old feedback log is never read again.
  fs.writeFileSync(path.join(p.state, 'backlog.md'), '## M2 · Next (target 1:20)\n- [ ] M2-1 e\n');
  assert.equal(readBoard(p).cards.size, b.cards.size + 1);
  for (const line of fs.readFileSync(p.board, 'utf8').trim().split('\n')) assert.deepEqual(validate('board', JSON.parse(line)), [], line);
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
  assert.equal(limits!.source, 'claude-code');
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

test('stream parser: usage so far counts each API message once, across subagents', () => {
  const parser = new StreamParser('/work');
  const msg = (id: string, model: string, parent: string | null, u: Record<string, number>) =>
    ({ type: 'assistant', parent_tool_use_id: parent, message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: u } });
  const a = { input_tokens: 2, output_tokens: 8, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 };
  let usage = null;
  for (const m of [msg('m1', 'opus', null, a), msg('m1', 'opus', null, a), msg('m2', 'haiku', 'toolu_1', { input_tokens: 1, cache_read_input_tokens: 50 }), { type: 'user' }]) {
    usage = parser.feed(m).usage ?? usage;
  }
  assert.deepEqual(usage, {
    models: { opus: { input: 2, output: 8, cache_read: 100, cache_write: 10, cost_usd: null }, haiku: { input: 1, output: 0, cache_read: 50, cache_write: 0, cost_usd: null } },
    cost_usd: null,
  });
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

test('milestones from a seeded backlog: targets, card counts, the current one', () => {
  const p = tmpGoal();
  fs.writeFileSync(path.join(p.state, 'backlog.md'), [
    '# Backlog', '', '**Current milestone: M2 · Templates**', '',
    '## Feedback (from `epoptes feedback`)', '- [ ] F-1 bigger title', '',
    '## M1 · Form works (target 0:40)', '- [x] M1-1 a', '- [x] M1-2 b', '- [cut] M1-3 c', '',
    '## M2 · Templates (target 1:20)', '- [x] M2-1 a', '- [~] M2-2 b', '- [blocked: needs approval F-3] M2-3 c', '- [ ] M2-4 d', '',
    '## Review fixes', '- [ ] R-1 [high] x', '',
    '### M3: Polish', '- [ ] M3-1 a',
  ].join('\n'));
  const ms = boardMilestones(readBoard(p), 'job-1');
  assert.deepEqual(ms.map((m) => [m.id, m.title, m.target_s, m.done, m.doing, m.blocked, m.cut, m.todo, m.current]), [
    ['M1', 'Form works', 2400, 2, 0, 0, 1, 0, false],
    ['M2', 'Templates', 4800, 1, 1, 1, 0, 1, true],
    ['M3', 'Polish', null, 0, 0, 0, 0, 1, false],
  ]);
});

test('time use: phases from events, roles and tools from activity', async () => {
  const { cycleUse, phaseTotals } = await import('../src/timeuse.ts');
  const t = (s: number) => new Date(Date.UTC(2026, 9, 4, 10, 0, s)).toISOString();
  const ev = (s: number, type: string, extra: Record<string, unknown> = {}) => ({ ts: t(s), run: 'r1', cycle: 1, src: 'runner' as const, type, ...extra });
  const phases = phaseTotals([
    ev(0, 'run.start'), ev(0, 'cycle.start'), ev(100, 'cycle.end', { duration_s: 100 }),
    ev(100, 'wait', { reason: 'rate_limit', seconds: 600 }), ev(400, 'cycle.start'), // cut short after 300 s
    ev(500, 'cycle.end', { duration_s: 100 }), ev(500, 'run.end', { reason: 'needs_you' }),
    ev(800, 'run.start'), ev(900, 'run.end', { reason: 'done' }), ev(5000, 'run.start'), // a gap after DONE doesn't count
  ], Date.parse(t(6000)));
  assert.deepEqual(phases, { working: 200, between_cycles: 0, rate_limit: 300, cooldown: 0, needs_you: 300, paused: 0 });

  const a = (s: number, agent: string, kind: string, tool?: string) => ({ ts: t(s), agent, kind, ...(tool ? { tool } : {}), summary: '' }) as any;
  const use = cycleUse([
    a(0, 'orchestrator', 'tool', 'Read'), a(10, 'orchestrator', 'tool', 'Agent'),
    a(10, 'worker#a1', 'agent.start'), a(12, 'worker#a1', 'tool', 'Edit'), a(40, 'worker#a1', 'agent.end'),
    a(20, 'worker#b2', 'agent.start'), a(60, 'worker#b2', 'agent.end'),
    a(30, 'agent#bg', 'agent.start'), a(90, 'agent#bg', 'agent.end'), // a background shell task
    a(70, 'orchestrator', 'tool', 'mcp__docs__search'),
  ], Date.parse(t(0)), Date.parse(t(100)));
  assert.deepEqual(Object.fromEntries(use.roles), { worker: { seconds: 70, spans: 2 }, 'orchestrator (alone)': { seconds: 50, spans: 1 } });
  assert.deepEqual(Object.fromEntries(use.tools), {
    Read: { seconds: 10, calls: 1 }, Agent: { seconds: 60, calls: 1 }, 'mcp:search': { seconds: 30, calls: 1 },
    Edit: { seconds: 28, calls: 1 }, 'background commands': { seconds: 60, calls: 1 },
  });
});

test('open work ignores low/med cards; projection follows milestone pace', async () => {
  const { projectFinish } = await import('../src/summary.ts');
  const p = tmpGoal();
  assert.equal(openWork(currentCards(p)), null);
  fs.writeFileSync(path.join(p.state, 'backlog.md'), ['## Review fixes', '- [ ] R-1 [low] ui: nicer shadow', '- [ ] R-2 [med] copy: shorter intro', '## M1 · A', '- [x] M1-1 a', '- [blocked: needs approval] M1-2 b'].join('\n'));
  assert.deepEqual(openWork(currentCards(p)), { open: 0, blocked: 1, minor: 2, untriaged: 0, waiting: 0 });
  const id = addCard(p, 'crash on load', 'cli');
  assert.deepEqual(openWork(currentCards(p)), { open: 0, blocked: 1, minor: 2, untriaged: 1, waiting: 1 });
  setCard(p, id, { column: 'review', priority: 'high' }, 'orchestrator');
  assert.deepEqual(openWork(currentCards(p)), { open: 1, blocked: 1, minor: 2, untriaged: 0, waiting: 0 });

  const m = (id: string, target_s: number | null, active_s: number | null) => ({ id, title: id, target_s, todo: 0, doing: 0, done: 0, blocked: 0, cut: 0, current: false, reached: active_s == null ? null : { at: '', run: 'r1', active_s } });
  // M1 planned for 2h, done in 30 min: the run is on a quarter of the plan, so a 10h plan lands at ~2h30m.
  assert.deepEqual(projectFinish([m('M1', 7200, 1800), m('M2', 18000, null), m('M3', 36000, null)], 1900), { end_s: 9000, pace: 0.25, basis: 'M1' });
  assert.equal(projectFinish([m('M1', 7200, null), m('M2', 36000, null)], 100), null, 'no reached milestone with a time yet');
  assert.equal(projectFinish([m('M1', 7200, 1800)], 1900), null, 'nothing left to project');
  // M2 is current and already past its target: that slower pace wins.
  const late = [m('M1', 2400, 2100), { ...m('M2', 4800, null), current: true }, m('M3', 6600, null)];
  assert.deepEqual(projectFinish(late, 5640), { end_s: 7755, pace: 1.175, basis: 'M2' });
});
