#!/usr/bin/env node
// epoptes: a thin CLI over the goal files, used by you and by orchestrators inside cycles.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { adapters } from './adapters/index.ts';
import { agentsFromDir } from './adapters/claude-code.ts';
import { readClock, readClockState } from './clock.ts';
import * as control from './control.ts';
import { emit } from './events.ts';
import { addFeedback, editFeedback, ingestInbox, isAgentNote, noteFeedback, pendingApprovals, readFeedback, setFeedbackStatus, STATUSES, type FeedbackItem, type FeedbackStatus } from './feedback.ts';
import { exists, hm, parseDuration, readJson, touch } from './fsx.ts';
import { loadGoal } from './goal.ts';
import { lintGoal } from './lint.ts';
import { epoptesHome, goalPaths } from './paths.ts';
import { addGoal, readRegistry, resolveGoal } from './registry.ts';
import { runGoal } from './runner.ts';
import { reconcile } from './status.ts';
import { backlogCounts, lastResult, money, readHead } from './summary.ts';

const HELP = `epoptes: create, run, watch and steer long-running Claude Code or Codex harnesses

Goals
  add [dir]                       validate <dir>/.epoptes/goal.json and register it
  list                            all registered goals
  status [goal]                   state, clock, cycle, backlog, feedback, handoff
  clock [goal]                    one line for orchestrators: CYCLE MODE ACTIVE TO_WRAPUP TO_END …

Runs
  start [goal] [--new-run]        resume, or start (spawns a detached runner); --new-run after DONE / time box over
  pause [goal]                    pause after the current cycle (the clock pauses too)
  stop [goal]                     stop now; the next cycle recovers interrupted work
  extend [goal] <dur>             lengthen the time box, e.g. 2h, 30m, 1h30m
  reset-clock [goal]              clear the clock; the next start is a new run
  run [goal] --dry-run            check everything and print the next cycle's command

Steering
  feedback [goal] "<text>"        add a feedback item (F-<n>)
           [--steer]              steer: interrupt the running cycle and replan around it now
  feedback [goal] [--open]        list feedback (--open: only items that still need attention)
  feedback <F-n> <status> [note]  set status: ${STATUSES.join(', ')}
  feedback <F-n> note "<text>"    comment on an item
  feedback <F-n> edit "<text>"    change an item's text (e.g. correct an agent note)
  feedback <F-n> approve|reject [note]  answer an approval request
  event <type> "<text>"           milestone | blocked | note | artifact | round | wrapup | done

Inside cycles (orchestrators)
  feedback "<text>"               an agent note: something the next cycle must act on (the human sees it)
  approval "<what>" [--ref <task>]  ask the human before doing something on the approval list
  wait-for-human "<what>"         end the run after this cycle as "waiting for you" (nothing else can move)

Later
Skill
  skill install [--agent codex]    link the skill for Claude Code (default) or Codex
  skill path                      print where the skill lives

Dashboard
  ui [--port N] [--lan]           live dashboard on http://127.0.0.1:4747 (--lan: whole network, no auth)

Import
  import-runsh <project> [-g id]  import a dress2impress-style run.sh harness into <project>/.epoptes

Reports
  report [goal] [--all]           Markdown + HTML report into .epoptes/reports/ (--all: ~/.epoptes/reports/)
         [--md|--html] [--stdout] [--out <dir>]

[goal] is a registered id or a path. Without it: $EPOPTES_GOAL_DIR, then the nearest .epoptes/ above the cwd.`;

const EVENT_TYPES = ['milestone', 'blocked', 'note', 'artifact', 'round', 'wrapup', 'done'];

const inCycle = () => Boolean(process.env.EPOPTES_CYCLE);

/** One line per item in `epoptes feedback`; approvals say whether the human has answered. */
function feedbackLine(f: FeedbackItem): string {
  let tag = '';
  if (f.kind === 'approval') tag = f.decision ? `[approval: ${f.decision.toUpperCase()}${decisionNote(f)}] ` : '[approval: waiting for the human; do not do it yet] ';
  else if (isAgentNote(f)) tag = f.edited ? '[agent note, edited by the human] ' : '[agent note] ';
  else if (f.steer) tag = '[STEERING: replan around this first] ';
  return `${f.id.padEnd(6)} ${f.status.padEnd(12)} ${tag}${f.text}${f.ref ? ` (${f.ref})` : ''}`;
}
const decisionNote = (f: FeedbackItem) => {
  const op = f.history.findLast((o) => o.op === 'decide');
  return op && op.op === 'decide' && op.note ? ` "${op.note}"` : '';
};
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
  out.push(`state ${s.state}${pid}${s.pause_requested ? ' · pause requested' : ''} · run ${s.run ?? '–'} · cycle ${s.cycle || '–'} · mode ${s.mode ?? '–'}`);
  const cs = readClockState(p);
  const c = readClock(p);
  if (cs && c) {
    out.push(`clock ${hm(cs.active)} active of ${hm(c.timebox_s)} · wrap-up in ${hm(cs.toWrapup)} · end in ${hm(cs.toEnd)} · hard stop in ${hm(cs.toHard)}${c.paused_at ? ' · paused' : ''}`);
  } else out.push('clock not started');
  if (s.state === 'needs_input') out.push(`WAITING FOR YOU (${ago(s.needs?.since ?? null)}): ${s.needs?.reason ?? 'the orchestrator needs you'}`);
  if (s.cycle_started_at) out.push(`cycle ${s.cycle} running for ${ago(s.cycle_started_at)}`);
  if (s.waiting_until) out.push(`waiting (${s.wait_reason}) until ${new Date(s.waiting_until).toLocaleTimeString()}`);
  if (exists(p.done)) out.push('DONE marker set');
  if (exists(p.wrapup)) out.push('WRAPUP marker set (early finish)');

  const b = backlogCounts(p);
  if (b) out.push(`backlog ${b.done}/${b.todo + b.doing + b.done + b.blocked} done · ${b.doing} in progress · ${b.blocked} blocked · ${b.cut} cut${b.milestone ? ` · milestone ${b.milestone}` : ''}`);
  ingestInbox(p);
  const fb = [...readFeedback(p).values()];
  if (fb.length) {
    const n = (st: FeedbackStatus[]) => fb.filter((f) => st.includes(f.status)).length;
    out.push(`feedback ${n(['new'])} new · ${n(['seen', 'in_progress'])} open · ${n(['blocked'])} blocked · ${n(['done', 'wont_do'])} closed`);
    for (const f of fb.filter((x) => x.steer && x.status === 'new')) out.push(`  steering ${f.id} waits for the next cycle: ${f.text}`);
    for (const f of pendingApprovals(fb)) out.push(`  approval ${f.id} waits for you: ${f.text}  (epoptes feedback ${f.id} approve|reject ["note"])`);
  }
  if (s.limits) {
    const w = Object.entries(s.limits.windows).map(([k, v]) => `${k} ${Math.round(v.utilization * 100)}%`).join(' · ');
    out.push(`usage ${s.limits.status}${w ? ` · ${w}` : ''} (as of ${ago(s.limits.at)} ago)`);
  }
  const r = lastResult(p);
  if (r) out.push(`last cycle c${r.cycle}: ${r.exit} · ${hm(r.duration_s)} · ${r.turns ?? '?'} turns · ${money(r.cost_usd, r.cost_basis)}${r.error ? ` · ${r.error}` : ''}`);
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
      await runGoal(rest[0]);
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
      console.log(`CYCLE=${envCycle() ?? s.cycle} RUN=${c.run} MODE=${cs.mode} ACTIVE=${hm(cs.active)} TO_WRAPUP=${hm(cs.toWrapup)} TO_END=${hm(cs.toEnd)} TO_HARD_STOP=${hm(cs.toHard)}${elapsed}`);
      return;
    }
    case 'skill': {
      const src = fileURLToPath(new URL('../plugin/skills/epoptes', import.meta.url));
      if (rest[0] === 'path') return console.log(src);
      if (rest[0] !== 'install') throw new Error('usage: epoptes skill install [--agent claude-code|codex] | epoptes skill path');
      const agent = values.agent ?? 'claude-code';
      if (!['claude-code', 'codex'].includes(agent)) throw new Error('--agent must be claude-code or codex');
      const dest = path.join(os.homedir(), agent === 'codex' ? '.agents' : '.claude', 'skills', 'epoptes');
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
      console.log(`installed: ${tilde(dest)} → ${src}\nIn ${agent === 'codex' ? 'Codex' : 'Claude Code'}: "use the epoptes skill to build a harness for <goal>"`);
      return;
    }
    case 'start': {
      const s = await control.start(resolveGoal(goalArg()), { newRun: Boolean(values['new-run']) });
      console.log(`started: run ${s.run}, runner pid ${s.pid}`);
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
    case 'feedback': {
      const by = inCycle() ? 'orchestrator' : 'user';
      if (/^F-\d+$/.test(rest[0] ?? '')) {
        const p = goalPaths(resolveGoal(values.goal));
        const [id, what, ...text] = rest;
        if (what === 'note') {
          noteFeedback(p, id, text.join(' '), by, envCycle());
          console.log(`${id}: note added`);
        } else if (what === 'edit') {
          editFeedback(p, id, text.join(' '), by);
          console.log(`${id}: text changed`);
        } else if (what === 'approve' || what === 'reject') {
          if (inCycle()) throw new Error('only the human answers approvals');
          const r = await control.decide(p.project, id, what === 'approve' ? 'approved' : 'rejected', text.join(' ') || undefined);
          console.log(`${id} ${what === 'approve' ? 'approved' : 'rejected'}${r.resumed ? '; the run resumes' : r.problem ? `; not resumed: ${r.problem}` : ''}`);
        } else {
          setFeedbackStatus(p, id, what as FeedbackStatus, by, envCycle(), text.join(' ') || undefined);
          console.log(`${id} → ${what}`);
        }
        return;
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
      if (!text) {
        const p = goalPaths(resolveGoal(ref));
        ingestInbox(p);
        const items = [...readFeedback(p).values()].filter((f) => !values.open || !['done', 'wont_do'].includes(f.status));
        if (!items.length) console.log(values.open ? 'no open feedback' : 'no feedback yet');
        for (const f of items) console.log(feedbackLine(f));
        return;
      }
      if (values.steer) {
        if (inCycle()) throw new Error('steering is for the human; file an agent note instead');
        const r = control.steer(resolveGoal(ref), text, 'cli');
        console.log(`added ${r.id} (steering)${r.interrupted ? ': the running cycle is interrupted now and a fresh one replans around it' : ': the next cycle replans around it first'}`);
        return;
      }
      // Inside a cycle this is an agent note: something the next cycle must act on, shown to the human too.
      const id = addFeedback(goalPaths(resolveGoal(ref)), text, inCycle() ? 'orchestrator' : 'cli');
      console.log(inCycle() ? `added ${id} (agent note for the next cycle; the human can edit or dismiss it)` : `added ${id}`);
      return;
    }
    case 'approval': {
      const text = rest.join(' ').trim();
      if (!text) throw new Error('usage: epoptes approval "<what needs approval>" [--ref <task id>]');
      const p = goalPaths(resolveGoal(values.goal));
      const s = reconcile(p);
      const id = addFeedback(p, text, inCycle() ? 'orchestrator' : 'cli', { kind: 'approval', ref: values.ref });
      emit(p, { src: inCycle() ? 'orchestrator' : 'user', type: 'blocked', run: process.env.EPOPTES_RUN ?? s.run, cycle: envCycle() ?? (s.cycle || null), text: `needs approval: ${text}`, ref: id });
      console.log(`${id}: approval requested. Carry on with other work; the decision shows in \`epoptes feedback --open\`.`);
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
      if (type === 'round') emit(p, { ...base, n: Number(text[0]) || 1 });
      else if (type === 'artifact') {
        if (!text[0]) throw new Error('usage: epoptes event artifact <path> ["text"]');
        emit(p, { ...base, path: text[0], ...(text[1] ? { text: text.slice(1).join(' ') } : {}) });
      } else {
        if (!text.length) throw new Error(`usage: epoptes event ${type} "<text>"`);
        emit(p, { ...base, text: text.join(' ') });
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
            return [buildReport(goalPaths(g.path))];
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
        const r = buildReport(p);
        md = renderMarkdown(r);
        htmlOut = renderHtml(r);
        dir = values.out ?? path.join(p.root, 'reports');
        name = `${r.goal.id}-${stamp}`;
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
