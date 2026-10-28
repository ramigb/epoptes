#!/usr/bin/env node
// epoptes: a thin CLI over the goal files, used by you and by orchestrators inside cycles.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { adapters } from './adapters/index.ts';
import { agentsFromDir } from './adapters/claude-code.ts';
import { activeS, readClock, readClockState } from './clock.ts';
import * as control from './control.ts';
import { addCard, addMilestone, askApproval, boardCounts, boardMilestones, COLUMNS, commentCard, currentCards, currentEpic, followUpCards, isAgentNote, isBlocked, pendingApprovals, pendingSteers, readBoard, setCard, type Card, type Column, type Fields, type Priority, type Scope } from './board.ts';
import { emit, readEvents } from './events.ts';
import { exists, hm, parseDuration, readJson, touch } from './fsx.ts';
import { loadGoal } from './goal.ts';
import { inJob, jobsOf } from './jobs.ts';
import { lintGoal } from './lint.ts';
import { epoptesHome, goalPaths } from './paths.ts';
import { addGoal, readRegistry, resolveGoal } from './registry.ts';
import { runGoal } from './runner.ts';
import { reconcile } from './status.ts';
import { lastResult, milestonesWithReach, money, outputOf, projectFinish, readHead } from './summary.ts';

const HELP = `epoptes: create, run, watch and steer long-running Claude Code, Codex or pi harnesses

Goals
  add [dir]                       validate <dir>/.epoptes/goal.json and register it
  list                            all registered goals
  status [goal]                   state, clock, pace, cycle, board, approvals, output, handoff
  clock [goal]                    one line for orchestrators: CYCLE MODE ACTIVE TO_WRAPUP TO_END …
  job [goal]                      this harness's jobs (the current one last)
  job new "<title>" [--id slug]   start the next job (a new epic on the board): archive the finished job's handoff
                                  and progress, keep roles, lessons and decisions, reset the clock

Runs
  start [goal] [--new-run]        resume, or start (spawns a detached runner); --new-run after DONE / time box over
        [--follow-up]             after DONE: handle just the open feedback, no time box (minor fixes in place)
  pause [goal]                    pause after the current cycle (the clock pauses too)
  stop [goal]                     stop now; the next cycle recovers interrupted work
  extend [goal] <dur>             lengthen the time box, e.g. 2h, 30m, 1h30m
  reset-clock [goal]              clear the clock; the next start is a new run
  run [goal] --dry-run            check everything and print the next cycle's command

The board (one per harness; each job is an epic; columns ${COLUMNS.join(' → ')})
  board [goal] [--open] [--all]   the current epic's cards (--open: hide done; --all: every epic)
  feedback [goal] "<text>"        add a card to the backlog (inside a cycle: an agent note)
           [--steer]              steer: interrupt the running cycle and replan around it now
  card add "<title>"              add a card [--column c] [--milestone M1] [--assign role] [--priority high|med|low]
  card <id>                       one card with its comments
  card <id> <column> ["note"]     move it: ${COLUMNS.join(' | ')} (takes the set flags too)
  card <id> cut|block "<why>"     drop it (into done) | mark it blocked;  card <id> unblock
  card <id> comment "<text>"      comment [--steer] [--as role]; the human's comment on a done card reopens it
  card <id> set                   [--title t] [--milestone M] [--assign r] [--priority p|none] [--epic e]
                                  [--scope auto|tweak|new_run] (scope: how a follow-up after DONE treats it)
  card <id> approve|reject [note] answer an approval request
  milestone [goal]                the current epic's milestones
  milestone add <M-id> "<title>" [--target h:mm]   add or rename one (target: active time from the run's start)
  event <type> "<text>"           milestone | blocked | note | artifact | round | wrapup | done
  event output <path|url> [text]  where the main deliverable is (the dashboard links to it)

Inside cycles (orchestrators)
  approval "<what>" [--ref <card>]  ask the human before doing something on the approval list
  wait-for-human "<what>"         end the run after this cycle as "waiting for you" (nothing else can move)
  lesson "<rule>" [--topic t]     a harness lesson for the brain (topics: roles, briefs, cycles, checks, tools, state, cost, steering, other)

Brain
  brain                           gather every goal's digest and lessons into ~/.epoptes/brain/INDEX.md
  brain lessons [--kind k]        print the harness lessons (optionally for one goal kind)

Skill
  skill install [--agent codex|pi] link the skill for Claude Code (default), Codex or pi
  skill path                      print where the skill lives

Dashboard
  ui [--port N] [--lan]           live dashboard on http://127.0.0.1:4747 (--lan: whole network, no auth)

Import
  import-runsh <project> [-g id]  import a dress2impress-style run.sh harness into <project>/.epoptes

Reports
  report [goal] [--all]           Markdown + HTML report into .epoptes/reports/ (--all: ~/.epoptes/reports/)
         [--md|--html] [--stdout] [--out <dir>] [--job <id>|all]   (default: the current job)

[goal] is a registered id or a path. Without it: $EPOPTES_GOAL_DIR, then the nearest .epoptes/ above the cwd.`;

const EVENT_TYPES = ['milestone', 'blocked', 'note', 'artifact', 'output', 'round', 'wrapup', 'done'];

const inCycle = () => Boolean(process.env.EPOPTES_CYCLE);

/** One line per card in `epoptes board`, with what the orchestrator needs to know up front. */
function cardLine(c: Card): string {
  const tags: string[] = [];
  if (c.milestone) tags.push(c.milestone);
  if (c.assignee) tags.push(`@${c.assignee}`);
  if (c.priority) tags.push(`[${c.priority}]`);
  if (c.src !== 'orchestrator') tags.push('[from the human]');
  else if (isAgentNote(c)) tags.push('[agent note]');
  if (c.steering) tags.push('[STEERING: replan around this first]');
  if (c.approval) tags.push(c.approval.decision ? `[approval: ${c.approval.decision.toUpperCase()}${c.approval.note ? ` "${c.approval.note}"` : ''}]` : '[approval: waiting for the human; do not do it yet]');
  if (c.blocked) tags.push(`[blocked: ${c.blocked}]`);
  if (c.cut) tags.push(`[cut: ${c.cut}]`);
  if (c.scope === 'tweak') tags.push('[quick tweak]');
  if (c.scope === 'new_run') tags.push('[needs a new run]');
  if (c.waiting && !c.steering) tags.push(c.comments.at(-1)?.by === 'user' ? '[the human commented: read it]' : '[new: triage it]');
  return `${c.id.padEnd(6)} ${tags.length ? `${tags.join(' ')} ` : ''}${c.title}${c.comments.length ? `  (${c.comments.length} comment${c.comments.length > 1 ? 's' : ''})` : ''}`;
}

function boardText(project: string, { open = false, all = false } = {}): string {
  const p = goalPaths(project);
  const board = readBoard(p);
  const epic = currentEpic(p);
  const goal = loadGoal(p);
  const out: string[] = [];
  for (const j of jobsOf(readEvents(p), goal).filter((x) => all || x.id === epic)) {
    const cards = [...board.cards.values()].filter((c) => c.epic === j.id);
    const ms = boardMilestones(board, j.id);
    const cur = ms.find((m) => m.current);
    out.push(`== epic ${j.id}: ${j.title}${j.current ? ' (current)' : ''}${cur ? ` · milestone ${cur.id}${cur.title ? ` ${cur.title}` : ''}${cur.target_s != null ? ` (target ${hm(cur.target_s)})` : ''}` : ''}`);
    if (ms.length) out.push(`milestones: ${ms.map((m) => `${m.id}${m.target_s != null ? `@${hm(m.target_s)}` : ''} ${m.done}/${m.todo + m.doing + m.done + m.blocked}`).join(' · ')}`);
    for (const col of COLUMNS) {
      const list = cards.filter((c) => c.column === col);
      if (col === 'done' && open) {
        out.push(`${col.toUpperCase()} (${list.length}; \`epoptes board\` lists them)`);
        continue;
      }
      out.push(`${col.toUpperCase()}${col === 'backlog' && list.length ? ' (untriaged: move each to todo, or cut it with a reason)' : ''}`);
      for (const c of list) out.push(`  ${cardLine(c)}`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}

function cardText(c: Card): string {
  const out = [cardLine(c), `column ${c.column}${isBlocked(c) ? ' (blocked)' : ''} · epic ${c.epic} · from ${c.src === 'orchestrator' ? 'the orchestrator' : `the human (${c.src})`} · added ${ago(c.created_at)} ago${c.cycle ? ` · last touched in c${c.cycle}` : ''}`];
  if (c.approval) out.push(`approval: ${c.approval.text}${c.approval.decision ? ` → ${c.approval.decision}${c.approval.note ? `: ${c.approval.note}` : ''}` : ' (waiting for the human)'}`);
  for (const m of c.comments) out.push(`  ${m.by === 'user' ? 'human' : m.by}${m.cycle ? ` c${m.cycle}` : ''} (${ago(m.ts)} ago)${m.steer ? ' STEERING' : ''}: ${m.text}`);
  if (c.waiting) out.push(c.comments.at(-1)?.by === 'user' ? '→ the human is waiting for an answer: act on it, or reply with `epoptes card <id> comment "…"`.'.replace('<id>', c.id) : '→ new from the human: triage it.');
  return out.join('\n');
}

const envCycle = () => (process.env.EPOPTES_CYCLE ? Number(process.env.EPOPTES_CYCLE) : null);
const tilde = (p: string) => (p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p);
const ago = (iso: string | null) => (iso ? hm((Date.now() - Date.parse(iso)) / 1000) : '–');

function statusText(project: string): string {
  const p = goalPaths(project);
  const goal = loadGoal(p);
  const s = reconcile(p);
  const out: string[] = [];
  out.push(`${goal.id} · ${goal.name}   (${tilde(p.project)})`);
  const pid = s.pid ? ` (pid ${s.pid})` : '';
  const jobs = jobsOf(readEvents(p), goal);
  if (jobs.length > 1 || goal.job) out.push(`job ${jobs.at(-1)!.title} (${jobs.at(-1)!.id}, ${jobs.length} of ${jobs.length})`);
  out.push(`state ${s.state}${pid}${s.pause_requested ? ' · pause requested' : ''} · run ${s.run ?? '–'} · cycle ${s.cycle || '–'} · mode ${s.mode ?? '–'}`);
  const cs = readClockState(p);
  const c = readClock(p);
  if (cs && c && c.kind === 'followup') out.push(`clock ${hm(cs.active)} active · follow-up, no time box${c.paused_at ? ' · paused' : ''}`);
  else if (cs && c) {
    out.push(`clock ${hm(cs.active)} active of ${hm(c.timebox_s)} · wrap-up in ${hm(cs.toWrapup)} · end in ${hm(cs.toEnd)} · hard stop in ${hm(cs.toHard)}${c.paused_at ? ' · paused' : ''}`);
  } else out.push('clock not started');
  if (s.state === 'needs_input') out.push(`WAITING FOR YOU (${ago(s.needs?.since ?? null)}): ${s.needs?.reason ?? 'the orchestrator needs you'}`);
  if (s.cycle_started_at) out.push(`cycle ${s.cycle} running for ${ago(s.cycle_started_at)}`);
  if (s.waiting_until) out.push(`waiting (${s.wait_reason}) until ${new Date(s.waiting_until).toLocaleTimeString()}`);
  if (exists(p.done)) out.push('DONE marker set');
  if (exists(p.wrapup)) out.push('WRAPUP marker set (early finish)');

  const board = readBoard(p);
  const cards = currentCards(p, board);
  const ms = boardMilestones(board, currentEpic(p));
  const proj = cs && c && c.kind !== 'followup' && !exists(p.done) ? projectFinish(milestonesWithReach(ms, readEvents(p), s.run), cs.active) : null;
  if (proj && c) out.push(`pace ${proj.basis} ${proj.pace > 1 ? 'is running at' : 'took'} ${Math.round(proj.pace * 100)}% of its planned time · on pace to finish at ~${hm(proj.end_s)} of ${hm(c.timebox_s)}${proj.end_s > c.timebox_s ? ' (over the time box)' : ''}`);
  if (cards.length) {
    const b = boardCounts(cards, ms);
    out.push(`board ${b.done}/${b.todo + b.doing + b.review + b.done + b.blocked} done · ${b.backlog} backlog · ${b.todo} todo · ${b.doing} doing · ${b.review} review · ${b.blocked} blocked · ${b.cut} cut${b.milestone ? ` · milestone ${b.milestone}` : ''}`);
    const fu = followUpCards(cards).length;
    if (fu && s.state === 'done') out.push(`  ${fu} open card${fu > 1 ? 's' : ''} of yours since DONE: \`epoptes start --follow-up\` handles just those (no time box)`);
    for (const x of pendingSteers(cards)) out.push(`  steering ${x.id} waits for the next cycle: ${x.title}`);
    for (const x of cards.filter((y) => y.waiting && !y.steering)) out.push(`  ${x.id} waits for the orchestrator: ${x.title}`);
    for (const x of pendingApprovals(cards)) out.push(`  approval ${x.id} waits for you: ${x.approval!.text}  (epoptes card ${x.id} approve|reject ["note"])`);
  }
  if (s.limits) {
    const w = Object.entries(s.limits.windows).map(([k, v]) => `${k} ${Math.round(v.utilization * 100)}%`).join(' · ');
    out.push(`${s.limits.source === 'codex' ? 'Codex' : 'Claude'} usage ${s.limits.status}${w ? ` · ${w}` : ''} (as of ${ago(s.limits.at)} ago)`);
  }
  const r = lastResult(p);
  if (r) out.push(`last cycle c${r.cycle}: ${r.exit} · ${hm(r.duration_s)} · ${r.turns ?? '?'} turns · ${money(r.cost_usd, r.cost_basis)}${r.error ? ` · ${r.error}` : ''}`);
  const output = outputOf(p, goal);
  if (output) out.push(`output ${output.target}${output.kind === 'file' && !output.exists ? ' (not there yet)' : ''}`);
  const handoff = readHead(path.join(p.state, 'handoff.md'), 10).filter(Boolean);
  if (handoff.length) out.push('', '== handoff', ...handoff);
  return out.join('\n');
}

async function dryRun(project: string) {
  const p = goalPaths(project);
  const goal = loadGoal(p);
  const adapter = adapters[goal.adapter.type];
  const problems: string[] = [];
  const check = await adapter.check();
  if (!check.ok) problems.push(check.problem!);
  if (!exists(path.join(p.root, goal.adapter.prompt))) problems.push(`missing ${goal.adapter.prompt}`);
  if (!exists(p.state)) problems.push('missing state/ (run `epoptes add` first)');
  const dir = path.join(os.tmpdir(), `epoptes-dry-run-${goal.id}`);
  const cmd = adapter.command({
    cwd: p.project, goalDir: p.root, cycleDir: dir, prompt: `<${goal.adapter.prompt}>`,
    model: goal.adapter.model, effort: goal.adapter.effort, permissionMode: goal.adapter.permission_mode,
    args: goal.adapter.args, budgetUsd: goal.cycle.max_budget_usd, agentsDir: p.agents,
    settingsFile: exists(p.settings) ? p.settings : null, env: {},
  });
  const agents = Object.keys(agentsFromDir(p.agents));
  console.log(`goal ${goal.id}: ${goal.objective}`);
  console.log(`adapter ${adapter.id}${check.version ? ` (${check.version})` : ''} · roles: ${agents.join(', ') || '(none)'}`);
  console.log(`time box ${goal.timebox.total_min} min (wrap-up ${goal.timebox.wrapup_min}, grace ${goal.timebox.grace_min}) · cycle timeout ${goal.cycle.timeout_min} min · checkpoints ${goal.checkpoints}`);
  const cs = readClockState(p);
  console.log(cs ? `clock: mode ${cs.mode}, ${hm(cs.active)} active (unchanged)` : 'clock: not started (a dry run never starts it)');
  console.log(`next cycle runs in ${tilde(p.project)}:\n  ${cmd.bin} ${cmd.args.map((a) => (/[\s<>*]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  if (adapter.id === 'claude-code') console.log(`generated files: ${tilde(dir)}/{agents,settings}.json`);
  else console.log('prompt: sent on stdin; roles in agents/*.md are guidance, not native agent configuration');
  if (adapter.id === 'pi') console.log(`deny list: ${tilde(dir)}/pi-guard.json, enforced by the epoptes guard extension`);
  const lint = lintGoal(p, goal);
  problems.push(...lint.problems);
  if (lint.warnings.length) console.log(`\nwarnings:\n  ${lint.warnings.join('\n  ')}`);
  if (problems.length) {
    console.log(`\nproblems:\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
  } else console.log(lint.warnings.length ? '\nok with warnings' : '\nok');
}

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean' },
      'new-run': { type: 'boolean' },
      'follow-up': { type: 'boolean' },
      steer: { type: 'boolean' },
      open: { type: 'boolean' },
      md: { type: 'boolean' },
      html: { type: 'boolean' },
      stdout: { type: 'boolean' },
      out: { type: 'string' },
      goal: { type: 'string', short: 'g' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      all: { type: 'boolean' },
      port: { type: 'string' },
      lan: { type: 'boolean' },
      agent: { type: 'string' },
      ref: { type: 'string' },
      topic: { type: 'string' },
      kind: { type: 'string' },
      id: { type: 'string' },
      job: { type: 'string' },
      column: { type: 'string' },
      milestone: { type: 'string' },
      assign: { type: 'string' },
      priority: { type: 'string' },
      title: { type: 'string' },
      epic: { type: 'string' },
      scope: { type: 'string' },
      as: { type: 'string' },
      target: { type: 'string' },
    },
  });
  const [cmd, ...rest] = positionals;
  const goalArg = (i = 0) => values.goal ?? rest[i];

  if (values.version) {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return console.log(`epoptes ${pkg.version}`);
  }
  switch (cmd) {
    case undefined:
    case 'help':
      console.log(HELP);
      return;
    case '_run': // internal: the detached runner process
      await runGoal(rest[0], { followUp: Boolean(values['follow-up']) });
      return;
    case 'add': {
      const goal = addGoal(path.resolve(rest[0] ?? '.'));
      console.log(`registered ${goal.id} (${goal.name})`);
      return;
    }
    case 'list': {
      const reg = readRegistry();
      if (!reg.goals.length) return console.log('no goals yet: `epoptes add <dir>`');
      for (const g of reg.goals) {
        try {
          const p = goalPaths(g.path);
          const s = reconcile(p);
          const cs = readClockState(p);
          console.log(`${g.id.padEnd(24)} ${s.state.padEnd(12)} cycle ${String(s.cycle || '–').padEnd(4)} ${cs ? `${cs.mode.padEnd(8)} ${hm(cs.active)}` : ''.padEnd(14)}  ${tilde(g.path)}`);
        } catch (e) {
          console.log(`${g.id.padEnd(24)} error: ${(e as Error).message.split('\n')[0]}`);
        }
      }
      return;
    }
    case 'status':
      console.log(statusText(resolveGoal(goalArg())));
      return;
    case 'clock': {
      const p = goalPaths(resolveGoal(goalArg()));
      const c = readClock(p);
      const cs = readClockState(p);
      const s = reconcile(p);
      if (!c || !cs) return console.log(`CYCLE=${s.cycle} MODE=none (clock not started)`);
      const elapsed = s.cycle_started_at ? ` CYCLE_ELAPSED=${hm((Date.now() - Date.parse(s.cycle_started_at)) / 1000)}` : '';
      const left = (x: number) => (Number.isFinite(x) ? hm(x) : 'none');
      // The current milestone's target lets the orchestrator see whether it's ahead of or behind plan.
      const m = boardMilestones(readBoard(p), currentEpic(p)).find((x) => x.current);
      const ms = m ? ` MILESTONE=${m.id}${m.target_s != null ? ` M_TARGET=${hm(m.target_s)}` : ''}` : '';
      console.log(`CYCLE=${envCycle() ?? s.cycle} RUN=${c.run} MODE=${cs.mode} ACTIVE=${hm(cs.active)} TO_WRAPUP=${left(cs.toWrapup)} TO_END=${left(cs.toEnd)} TO_HARD_STOP=${left(cs.toHard)}${elapsed}${ms}`);
      return;
    }
    case 'skill': {
      const src = fileURLToPath(new URL('../plugin/skills/epoptes', import.meta.url));
      if (rest[0] === 'path') return console.log(src);
      if (rest[0] !== 'install') throw new Error('usage: epoptes skill install [--agent claude-code|codex|pi] | epoptes skill path');
      const agent = values.agent ?? 'claude-code';
      const names: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', pi: 'pi' };
      if (!Object.hasOwn(names, agent)) throw new Error('--agent must be claude-code, codex or pi');
      // Codex and pi both read the shared Agent Skills location.
      const dest = path.join(os.homedir(), agent === 'claude-code' ? '.claude' : '.agents', 'skills', 'epoptes');
      let current: string | null = null;
      try {
        current = fs.readlinkSync(dest);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${dest} cannot be read as a link; move it away first (${(e as Error).message})`);
      }
      if (current === src) return console.log(`already installed: ${tilde(dest)} → ${src}`);
      if (current) fs.rmSync(dest);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.symlinkSync(src, dest, process.platform === 'win32' ? 'junction' : 'dir');
      console.log(`installed: ${tilde(dest)} → ${src}\nIn ${names[agent]}: "use the epoptes skill to build a harness for <goal>"`);
      return;
    }
    case 'start': {
      const followUp = Boolean(values['follow-up']);
      const s = await control.start(resolveGoal(goalArg()), { newRun: Boolean(values['new-run']), followUp });
      console.log(`started${followUp ? ' a follow-up' : ''}: run ${s.run}, runner pid ${s.pid}`);
      return;
    }
    case 'pause':
      control.pause(resolveGoal(goalArg()));
      console.log('pause requested: the current cycle finishes, then the run pauses');
      return;
    case 'stop':
      control.stop(resolveGoal(goalArg()));
      console.log('stopping: the cycle is interrupted now; the next start recovers its work');
      return;
    case 'extend': {
      const [ref, dur] = rest.length >= 2 ? rest : [values.goal, rest[0]];
      if (!dur) throw new Error('usage: epoptes extend [goal] <dur>');
      const secs = parseDuration(dur);
      control.extend(resolveGoal(ref), secs);
      console.log(`time box extended by ${hm(secs)}`);
      return;
    }
    case 'reset-clock':
      control.resetClock(resolveGoal(goalArg()));
      console.log('clock reset: the next start begins a new run');
      return;
    case 'run':
      if (!values['dry-run']) throw new Error('use `epoptes start` to run; `epoptes run --dry-run` checks the setup');
      await dryRun(resolveGoal(goalArg()));
      return;
    case 'board':
      console.log(boardText(resolveGoal(goalArg()), { open: Boolean(values.open), all: Boolean(values.all) }));
      return;
    case 'card': {
      const p = goalPaths(resolveGoal(values.goal));
      const by = inCycle() ? (values.as ?? 'orchestrator') : 'user';
      const [id, what, ...words] = rest;
      const text = words.join(' ').trim();
      if (id === 'add') {
        const title = [what, ...words].join(' ');
        const nid = addCard(p, title, inCycle() ? 'orchestrator' : 'cli', { column: (values.column as Column) ?? (inCycle() ? 'todo' : 'backlog'), milestone: values.milestone, assignee: values.assign, priority: values.priority as Priority, cycle: envCycle(), steer: Boolean(values.steer) && !inCycle() });
        return console.log(`added ${nid}`);
      }
      if (!/^[A-Z]+-\d+$/.test(id ?? '')) throw new Error('usage: epoptes card add "<title>" | epoptes card <id> [<column>|cut|block|unblock|comment|set|approve|reject] …');
      if (!what) {
        const c = readBoard(p).cards.get(id);
        if (!c) throw new Error(`no card ${id}`);
        return console.log(cardText(c));
      }
      const none = (v: string | undefined) => (v === 'none' ? null : v);
      const flags: Fields = Object.fromEntries(Object.entries({ title: values.title, milestone: none(values.milestone), assignee: none(values.assign), priority: none(values.priority), epic: values.epic, scope: values.scope }).filter(([, v]) => v !== undefined));
      if ((COLUMNS as readonly string[]).includes(what)) {
        setCard(p, id, { column: what as Column, ...flags }, by, envCycle());
        if (text) commentCard(p, id, text, by, envCycle());
      } else if (what === 'cut') {
        if (!text) throw new Error(`say why: epoptes card ${id} cut "<why>"`);
        setCard(p, id, { column: 'done', cut: text }, by, envCycle());
      } else if (what === 'block') {
        if (!text) throw new Error(`say why: epoptes card ${id} block "<why>"`);
        setCard(p, id, { blocked: text }, by, envCycle());
      } else if (what === 'unblock') setCard(p, id, { blocked: null }, by, envCycle());
      else if (what === 'comment') {
        if (values.steer) {
          if (inCycle()) throw new Error('steering is for the human');
          const r = control.steer(p.project, text, 'cli', id);
          return console.log(`${id}: steering comment added${r.interrupted ? '; the running cycle is interrupted now and a fresh one replans around it' : '; the next cycle replans around it first'}`);
        }
        commentCard(p, id, text, by, envCycle());
      } else if (what === 'set') setCard(p, id, flags, by, envCycle());
      else if (what === 'approve' || what === 'reject') {
        if (inCycle()) throw new Error('only the human answers approvals');
        const r = await control.decide(p.project, id, what === 'approve' ? 'approved' : 'rejected', text || undefined);
        return console.log(`${id} ${what === 'approve' ? 'approved' : 'rejected'}${r.resumed ? '; the run resumes' : r.problem ? `; not resumed: ${r.problem}` : ''}`);
      } else throw new Error(`unknown card action "${what}" (use ${COLUMNS.join(', ')}, cut, block, unblock, comment, set, approve, reject)`);
      console.log(`${id}: ${what}${text && what !== 'comment' ? ` (${text})` : ''}`);
      return;
    }
    case 'milestone': {
      if (rest[0] === 'add') {
        const p = goalPaths(resolveGoal(values.goal));
        addMilestone(p, rest[1] ?? '', rest.slice(2).join(' '), values.target);
        return console.log(`milestone ${rest[1].toUpperCase()} recorded`);
      }
      const p = goalPaths(resolveGoal(goalArg()));
      const ms = boardMilestones(readBoard(p), currentEpic(p));
      if (!ms.length) return console.log('no milestones yet: `epoptes milestone add M1 "<what is checkable at the end>" --target 1:00`');
      for (const m of ms) console.log(`${m.current ? '*' : ' '} ${m.id.padEnd(5)} ${m.target_s != null ? hm(m.target_s) : '  –  '}  ${m.done}/${m.todo + m.doing + m.done + m.blocked} done${m.blocked ? ` · ${m.blocked} blocked` : ''}  ${m.title}`);
      return;
    }
    case 'feedback': {
      // Before the board this was its own list; now feedback is a backlog card. Item commands map onto `card`.
      if (/^[A-Z]+-\d+$/.test(rest[0] ?? '')) {
        const verb: Record<string, string[]> = { new: ['backlog'], seen: ['todo'], in_progress: ['doing'], done: ['done'], wont_do: ['cut'], blocked: ['block'], note: ['comment'] };
        const [id, what, ...text] = rest;
        if (what === 'edit' || what === 'scope') {
          setCard(goalPaths(resolveGoal(values.goal)), id, what === 'edit' ? { title: text.join(' ') } : { scope: text[0] as Scope }, inCycle() ? 'orchestrator' : 'user', envCycle());
          return console.log(`${id}: ${what}`);
        }
        const mapped = verb[what] ?? [what];
        if ((what === 'wont_do' || what === 'blocked') && !text.length) text.push(what === 'wont_do' ? "won't do" : 'blocked');
        return main(['card', id, ...mapped, ...text, ...(values.goal ? ['--goal', values.goal] : [])]);
      }
      const isGoalRef = (s?: string) => {
        if (!s) return false;
        try {
          return Boolean(resolveGoal(s));
        } catch {
          return false;
        }
      };
      // One argument: a goal to list, or text to add. Two: goal, then text.
      const [ref, text] = rest.length >= 2 ? rest : isGoalRef(rest[0]) ? [rest[0], undefined] : [values.goal, rest[0]];
      if (!text) return console.log(boardText(resolveGoal(ref), { open: Boolean(values.open) }));
      if (values.steer) {
        if (inCycle()) throw new Error('steering is for the human; file an agent note instead');
        const r = control.steer(resolveGoal(ref), text, 'cli');
        console.log(`added ${r.id} (steering)${r.interrupted ? ': the running cycle is interrupted now and a fresh one replans around it' : ': the next cycle replans around it first'}`);
        return;
      }
      // Inside a cycle this is an agent note: something the next cycle must act on, shown to the human too.
      const id = addCard(goalPaths(resolveGoal(ref)), text, inCycle() ? 'orchestrator' : 'cli', { cycle: envCycle() });
      console.log(inCycle() ? `added ${id} to the backlog (agent note for the next cycle; the human can edit or cut it)` : `added ${id} to the backlog`);
      return;
    }
    case 'approval': {
      const text = rest.join(' ').trim();
      if (!text) throw new Error('usage: epoptes approval "<what needs approval>" [--ref <card id>]');
      const p = goalPaths(resolveGoal(values.goal));
      const s = reconcile(p);
      const id = askApproval(p, text, values.ref, inCycle() ? 'orchestrator' : 'user', envCycle());
      emit(p, { src: inCycle() ? 'orchestrator' : 'user', type: 'blocked', run: process.env.EPOPTES_RUN ?? s.run, cycle: envCycle() ?? (s.cycle || null), text: `needs approval: ${text}`, ref: id });
      console.log(`${id}: approval requested; the card is blocked until the human answers. Carry on with other work; the answer shows in \`epoptes board --open\`.`);
      return;
    }
    case 'job': {
      const { newJob } = await import('./jobs.ts');
      if (rest[0] === 'new') {
        const r = newJob(resolveGoal(values.goal), rest.slice(1).join(' '), values.id);
        console.log(`new job ${r.id}: ${r.title}`);
        console.log(r.archived.length ? `  archived ${r.archived.join(', ')} of ${r.previous} into .epoptes/${r.archiveDir}/` : `  nothing to archive from ${r.previous}`);
        console.log('  kept: goal settings, roles, permissions, state/lessons.md, state/decisions.md · clock reset (the next start is a new run)');
        if (r.carried.length) console.log(`  ${r.carried.length} untriaged backlog card${r.carried.length > 1 ? 's' : ''} moved to the new epic: ${r.carried.join(', ')} (cut any that belonged to the old job)`);
        console.log('Next: update goal.json (objective, done checks, time box, output) and the job-specific parts of loop.md, seed the board (write state/backlog.md in the seed format, or `epoptes milestone add` + `epoptes card add`), then `epoptes run --dry-run`.');
        return;
      }
      if (rest[0] && rest[0] !== 'list') values.goal ??= rest[0]; // `epoptes job <goal>`
      const p = goalPaths(resolveGoal(values.goal));
      const goal = loadGoal(p);
      const { readResults } = await import('./report.ts');
      const results = readResults(p);
      for (const j of jobsOf(readEvents(p), goal)) {
        const rs = results.filter((r) => inJob(r.started_at, j));
        const cost = !rs.length ? '–' : rs.some((r) => r.cost_usd == null) ? 'unknown' : `≈ $${rs.reduce((a, r) => a + r.cost_usd!, 0).toFixed(2)}`;
        console.log(`${j.current ? '*' : ' '} ${j.id.padEnd(24)} ${String(rs.length).padStart(3)} cycles  ${cost.padStart(9)}  ${j.title}${j.from ? `  (since ${j.from.slice(0, 10)})` : ''}`);
      }
      return;
    }
    case 'lesson': {
      const text = rest.join(' ').trim();
      const { LESSON_TOPICS } = await import('./brain.ts');
      const topic = values.topic ?? 'other';
      if (!text) throw new Error('usage: epoptes lesson "<a rule for future harnesses>" [--topic <topic>]');
      if (!(LESSON_TOPICS as readonly string[]).includes(topic)) throw new Error(`topic must be one of ${LESSON_TOPICS.join(', ')}`);
      const p = goalPaths(resolveGoal(values.goal));
      const s = reconcile(p);
      emit(p, { src: inCycle() ? 'orchestrator' : 'user', type: 'lesson', run: process.env.EPOPTES_RUN ?? s.run, cycle: envCycle() ?? (s.cycle || null), text, topic });
      console.log(`lesson recorded (${topic}); it reaches ~/.epoptes/brain when the run ends`);
      return;
    }
    case 'brain': {
      const { gatherAll, lessonIndex, readDigests, brainDir } = await import('./brain.ts');
      if (rest[0] === 'lessons') {
        const ds = readDigests().filter((d) => !values.kind || d.kind === values.kind);
        const idx = lessonIndex(ds);
        if (!idx.length) return console.log(`no harness lessons yet${values.kind ? ` for ${values.kind} goals` : ''}`);
        for (const t of idx) {
          console.log(`== ${t.topic}`);
          for (const l of t.lessons) console.log(`- ${l.text}  (${l.goals.join(', ')})`);
        }
        return;
      }
      if (rest[0]) throw new Error('usage: epoptes brain | epoptes brain lessons [--kind <kind>]');
      const r = gatherAll();
      const lessons = r.digests.reduce((a, d) => a + d.lessons.length, 0);
      const signals = r.digests.reduce((a, d) => a + d.signals.length, 0);
      console.log(`brain: ${r.digests.length} goal${r.digests.length === 1 ? '' : 's'}, ${lessons} harness lesson${lessons === 1 ? '' : 's'}, ${signals} signal${signals === 1 ? '' : 's'}`);
      for (const s of r.skipped) console.log(`  skipped ${s}`);
      console.log(`  ${tilde(r.file)}${fs.existsSync(path.join(brainDir(), 'NOTES.md')) ? `
  ${tilde(path.join(brainDir(), 'NOTES.md'))} (curated)` : ''}`);
      return;
    }
    case 'wait-for-human': {
      const text = rest.join(' ').trim();
      control.waitForHuman(resolveGoal(values.goal), text);
      console.log('the run ends after this cycle and waits for the human; finish recording state, then exit');
      return;
    }
    case 'event': {
      const [type, ...text] = rest;
      if (!EVENT_TYPES.includes(type)) throw new Error(`event type must be one of ${EVENT_TYPES.join(', ')}`);
      const p = goalPaths(resolveGoal(values.goal));
      const s = reconcile(p);
      const base = { src: inCycle() ? ('orchestrator' as const) : ('user' as const), type, run: process.env.EPOPTES_RUN ?? s.run, cycle: envCycle() ?? (s.cycle || null) };
      // Active time at the event puts milestones on the clock bar (wall time would include pauses).
      const clock = readClock(p);
      const at = ['milestone', 'wrapup', 'done'].includes(type) && clock ? { active_s: activeS(clock) } : {};
      if (type === 'round') emit(p, { ...base, n: Number(text[0]) || 1 });
      else if (type === 'artifact' || type === 'output') {
        if (!text[0]) throw new Error(`usage: epoptes event ${type} <${type === 'output' ? 'path or URL' : 'path'}> ["text"]`);
        emit(p, { ...base, path: text[0], ...(text[1] ? { text: text.slice(1).join(' ') } : {}) });
      } else {
        if (!text.length) throw new Error(`usage: epoptes event ${type} "<text>"`);
        emit(p, { ...base, ...at, text: text.join(' ') });
      }
      if (type === 'done') touch(p.done);
      if (type === 'wrapup') touch(p.wrapup);
      console.log(`recorded ${type}`);
      return;
    }
    case 'import-runsh': {
      if (!rest[0]) throw new Error('usage: epoptes import-runsh <project> [--goal <id>]');
      const { importRunSh } = await import('./importers/runsh.ts');
      const r = importRunSh(path.resolve(rest[0]), { id: values.goal });
      console.log(`imported ${r.runs} runs, ${r.cycles} cycles, ${r.events} events, ${r.milestones} milestones, ${r.feedback} feedback items into ${tilde(path.join(path.resolve(rest[0]), '.epoptes'))}\nNext: epoptes add ${rest[0]} && epoptes report ${rest[0]}`);
      return;
    }
    case 'report': {
      const { buildReport, renderMarkdown, renderHtml, renderAllMarkdown, renderAllHtml } = await import('./report.ts');
      const both = !values.md && !values.html;
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
      let md: string;
      let htmlOut: string;
      let dir: string;
      let name: string;
      if (values.all) {
        const reports = readRegistry().goals.flatMap((g) => {
          try {
            return [buildReport(goalPaths(g.path), Date.now(), { job: 'all' })];
          } catch (e) {
            console.error(`skipping ${g.id}: ${(e as Error).message.split('\n')[0]}`);
            return [];
          }
        });
        md = renderAllMarkdown(reports);
        htmlOut = renderAllHtml(reports);
        dir = values.out ?? path.join(epoptesHome(), 'reports');
        name = `all-goals-${stamp}`;
      } else {
        const p = goalPaths(resolveGoal(goalArg()));
        const r = buildReport(p, Date.now(), { job: values.job ?? 'current' });
        md = renderMarkdown(r);
        htmlOut = renderHtml(r);
        dir = values.out ?? path.join(p.root, 'reports');
        name = `${r.goal.id}${r.job && !r.job.current ? `-${r.job.id}` : r.jobs > 1 && !r.job ? '-all-jobs' : ''}-${stamp}`;
      }
      if (values.stdout) return console.log(values.html ? htmlOut : md);
      fs.mkdirSync(dir, { recursive: true });
      if (both || values.md) fs.writeFileSync(path.join(dir, `${name}.md`), md);
      if (both || values.html) fs.writeFileSync(path.join(dir, `${name}.html`), htmlOut);
      console.log(`report written:${both || values.md ? `\n  ${tilde(path.join(dir, name + '.md'))}` : ''}${both || values.html ? `\n  ${tilde(path.join(dir, name + '.html'))}` : ''}`);
      return;
    }
    case 'ui': {
      const cfg = readJson<{ port?: number; lan?: boolean }>(path.join(epoptesHome(), 'config.json')) ?? {};
      const port = Number(values.port ?? cfg.port ?? 4747);
      const lan = Boolean(values.lan ?? cfg.lan);
      const { serve } = await import('./ui/server.ts');
      try {
        await serve({ port, lan });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error(`port ${port} is in use. Is the dashboard already running? Open http://127.0.0.1:${port}, or pick another port with --port.`);
        throw e;
      }
      if (lan) {
        console.warn('WARNING: --lan serves the dashboard to your whole network with no login. Anyone who can reach this');
        console.warn('machine can start and stop runs and add feedback, which goes into the agents\' prompts.');
        console.log(`epoptes dashboard on http://0.0.0.0:${port}`);
      } else console.log(`epoptes dashboard on http://127.0.0.1:${port}  (Ctrl-C to quit; runs keep going)`);
      return;
    }
    default:
      throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`epoptes: ${(e as Error).message}`);
  process.exit(1);
});
