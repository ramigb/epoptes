// The detached per-goal runner: a TypeScript port of dress2impress harness/run.sh.
// Runs fresh-context cycles until the goal is done, the time box ends, or it is paused or stopped.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { adapters } from './adapters/index.ts';
import { gatherGoal, rebuildIndex } from './brain.ts';
import type { Activity, Cycle, CycleExit } from './adapters/types.ts';
import { clockState, newClock, newFollowUpClock, runFinished, pauseClock, readClock, resumeClock, writeClock, type Clock, type Mode } from './clock.ts';
import { emit, readEvents } from './events.ts';
import { currentCards, followUpCards, ingest, lastAsk, openWork, pendingSteers, type Card } from './board.ts';
import { appendJsonl, exists, nowIso, readJson, rm, touch, writeJson } from './fsx.ts';
import { loadGoal, type Goal } from './goal.ts';
import { goalPaths, type GoalPaths } from './paths.ts';
import { idleStatus, isAlive, lastCycle, readStatus, writeStatus, type Status } from './status.ts';

const HEARTBEAT_MS = 15_000;
const KILL_AFTER_MS = 120_000;
const MIN_TIMEOUT_MIN = 20;
const MAX_TIMEOUT_MIN = 180;
/** A follow-up has no time box; this many cycles without DONE pauses it so it can't run away. */
export const FOLLOWUP_MAX_CYCLES = 3;

type EndReason = 'done' | 'timebox' | 'paused' | 'needs_you' | 'stopped' | 'failed';
const END_STATE = { done: 'done', timebox: 'timeboxed', paused: 'paused', needs_you: 'needs_input', stopped: 'stopped', failed: 'failed' } as const;

const log = (msg: string) => console.log(`[${nowIso()}] ${msg}`);

/** Takes the per-goal runner lock, or throws if another live runner holds it. */
function acquireLock(p: GoalPaths) {
  fs.mkdirSync(p.run, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(p.lock, String(process.pid), { flag: 'wx' });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const holder = Number(fs.readFileSync(p.lock, 'utf8').trim());
      if (isAlive(holder)) throw new Error(`a runner is already live for this goal (pid ${holder})`);
      rm(p.lock);
    }
  }
  throw new Error(`could not take ${p.lock}`);
}

/** run/bin/epoptes: the same CLI that started this runner, first on the cycle's PATH. */
function writeShim(p: GoalPaths): string {
  const bin = path.join(p.run, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const cli = process.argv[1];
  fs.writeFileSync(path.join(bin, 'epoptes'), `#!/bin/sh\nexec ${[process.execPath, ...process.execArgv, cli].map(q).join(' ')} "$@"\n`, { mode: 0o755 });
  return bin;
}

const nextRunId = (prev: string | null | undefined) => `r${(Number(prev?.slice(1)) || 0) + 1}`;

/** Commits the workspace to .epoptes/snapshots.git (checkpoints = shadow). No tokens, never touches the user's repo. */
function shadowSnapshot(p: GoalPaths, n: number) {
  const git = (...args: string[]) =>
    execFileSync('git', ['--git-dir', p.snapshots, '--work-tree', p.project, ...args], { cwd: p.project, stdio: 'pipe', timeout: 120_000 });
  if (!exists(p.snapshots)) {
    execFileSync('git', ['init', '-q', '--bare', p.snapshots], { stdio: 'pipe' });
    fs.writeFileSync(path.join(p.snapshots, 'info', 'exclude'), '.epoptes/\nnode_modules/\n.git/\n');
  }
  git('add', '-A');
  try {
    git('diff', '--cached', '--quiet');
    return false; // nothing changed
  } catch {
    git('-c', 'user.name=epoptes', '-c', 'user.email=epoptes@localhost', 'commit', '-q', '-m', `c${n}`);
    return true;
  }
}

/**
 * A note the runner puts in front of loop.md when the human is steering, so the cycle replans first.
 * It lives here rather than in loop.md so harnesses generated before steering existed get it too.
 */
export function steerPreamble(cards: Card[], interrupted: boolean): string {
  if (!cards.length) return '';
  const ids = cards.map((c) => c.id).join(', ');
  const list = cards.map((c) => `>   - ${c.id}: ${JSON.stringify(lastAsk(c))}`).join('\n');
  return [
    `> **Epoptes runner: STEERING.** The human is steering (${ids})${interrupted ? ' and interrupted the previous cycle to do it' : ''}. It outranks everything else. Before normal work:`,
    `> 1. Orient as usual.${interrupted ? ' The last cycle was cut off mid-task, so do the interrupted-work check carefully.' : ''}`,
    '> 2. Read each with `epoptes card <id>`:',
    list,
    "> 3. Replan with the ripple effect: walk every open card and milestone on the board (`epoptes board --open`), then cut, rewrite, reorder or add cards so the whole plan follows the new direction (not just one card). Check the current milestone and the wrap-up list still make sense. Record the change in `state/decisions.md`.",
    '> 4. Answer on each card: `epoptes card <id> comment "replanned: <what changed in the plan>"`, move it where it belongs, and carry on with the new plan.',
    '',
    '',
  ].join('\n');
}

/**
 * The note in front of loop.md when the board has run out of real work in build mode: check done, then wrap up.
 * Without it an orchestrator with hours left on the clock tends to invent tasks to fill them.
 */
export function backlogClearPreamble(w: { blocked: number; minor: number }): string {
  return [
    `> **Epoptes runner: BOARD CLEAR.** No open cards are left on the board${w.minor ? ` except ${w.minor} low/med priority card${w.minor > 1 ? 's' : ''}` : ''}${w.blocked ? `, and ${w.blocked} blocked` : ''}, and nothing waits for triage or a reply. Unused time is fine: the time box is a limit, not a target. This cycle:`,
    '> 1. Orient as usual, then run every done check from goal.json.',
    '> 2. All pass → `epoptes event wrapup "<why>"` and do the wrap-up checklist. One fails → add only the cards that make it pass (say which check each is for), and do them.',
    `> 3. Don't add cards for anything else. Ideas go in the handoff's next-tasks list for the human.${w.blocked ? ' If what\'s left is blocked on the human, `epoptes wait-for-human "<what you need>"` after wrapping up what you can.' : ''}`,
    '',
    '',
  ].join('\n');
}

const SCOPE_NOTE = { auto: 'triage it yourself', tweak: 'the human marked it a quick tweak: do it in place', new_run: '' };

/**
 * The note in front of loop.md during a follow-up run: handle exactly these cards, each judged on its own, with no
 * time box, and nothing else. Minor items get done; major ones are flagged for a new run.
 */
export function followUpPreamble(cards: Card[]): string {
  const list = cards.map((c) => `>   - ${c.id}: ${JSON.stringify(lastAsk(c))} (${c.approval?.decision ? `approval ${c.approval.decision}; ` : ''}${SCOPE_NOTE[c.scope]})`).join('\n');
  return [
    "> **Epoptes runner: FOLLOW-UP (MODE=followup).** This goal was already finished. The human started a follow-up for their cards and comments. There is no time box: take the time each item needs, judged on its own, and nothing more. The items (read each with `epoptes card <id>`):",
    list,
    '> For each item you triage:',
    '> - **Minor** (adjust what exists: a colour, a size, wording, a small bug, a small addition) → do it, verify it, checkpoint, then `epoptes card <id> done "<what changed>"`.',
    '> - **Major** (restart the job, a new version of the output, a change of direction, or more than about one cycle of work) → do not start it. Run `epoptes card <id> block "needs a new run: <why, and a rough size>"`.',
    '> - **Just a question or a remark** → answer it: `epoptes card <id> comment "<reply>"`.',
    "> Don't pick up other cards, review fixes, agent notes or polish that no item asks for. Skip the wrap-up checklist. When every item is done, blocked or answered, update the handoff, then `epoptes event done \"follow-up: <one line>\"` and exit.",
    '',
    '',
  ].join('\n');
}

/** For a loop.md written before the board: what replaced backlog.md and `epoptes feedback`. */
export const BOARD_PREAMBLE = [
  "> **Epoptes runner: THE BOARD.** This harness's loop.md predates the board. Work is tracked on a kanban board now, not in state/backlog.md or the feedback list:",
  '> - `epoptes board --open` replaces reading backlog.md and `epoptes feedback --open`; `epoptes card <id>` shows one card with its comments.',
  '> - Columns: backlog (untriaged: the human\'s feedback, agent notes) → todo → doing → review (being verified) → done. Triage each backlog card: `epoptes card <id> todo`, or `cut "<why>"`.',
  '> - Move cards with `epoptes card <id> doing|review|done ["note"]`, `block "<why>"`, `cut "<why>"`; add one with `epoptes card add "<task>" --column todo --milestone M<n>`. Do this wherever loop.md says to tick, add or block a backlog task or set a feedback status. Never create or edit state/backlog.md.',
  '> - When the human comments on a card, act on it or just reply: `epoptes card <id> comment "<reply>"`.',
  '',
  '',
].join('\n');

function capWarnings(p: GoalPaths, goal: Goal): string[] {
  const out: string[] = [];
  for (const [file, max] of Object.entries(goal.state_caps)) {
    try {
      const lines = fs.readFileSync(path.join(p.state, file), 'utf8').split('\n').filter((l, i, a) => i < a.length - 1 || l).length;
      if (lines > max) out.push(`state/${file} has ${lines} lines (cap ${max})`);
    } catch {
      // not created yet
    }
  }
  return out;
}

export async function runGoal(project: string, { followUp = false } = {}) {
  const p = goalPaths(project);
  acquireLock(p);

  let goal = loadGoal(p);
  const adapter = adapters[goal.adapter.type];
  if (!adapter) throw new Error(`unknown adapter ${goal.adapter.type}`);

  // ---- status + clock: resume the current run, or begin a new one ----
  const prev = readStatus(p) ?? idleStatus();
  let clock = readClock(p);
  let resumed = true;
  if (!clock || runFinished(p)) {
    rm(p.done);
    rm(p.wrapup);
    const id = nextRunId(clock?.run ?? prev.run);
    clock = followUp ? newFollowUpClock(id) : newClock(id, goal.timebox);
    resumed = false;
  }
  const isFollowUp = clock.kind === 'followup';
  clock = resumeClock(clock);
  writeClock(p, clock);
  let backup: Clock = clock;
  const run = clock.run;
  rm(p.control);
  const shimDir = writeShim(p);

  let status: Status = { ...prev, state: 'waiting', pid: process.pid, run, heartbeat_at: nowIso(), pause_requested: false, fails_in_row: 0, waiting_until: null, wait_reason: null, needs: null };
  const setStatus = (patch: Partial<Status>) => {
    status = { ...status, ...patch };
    writeStatus(p, status);
  };
  setStatus({});
  emit(p, { src: 'runner', type: 'run.start', run, timebox_s: clock.timebox_s, resumed, job: goal.job?.id ?? null, ...(isFollowUp ? { followup: true } : {}) });
  log(`run ${run} ${resumed ? 'resumed' : 'started'} (pid ${process.pid})`);

  // ---- signals, heartbeat, cancellable sleep ----
  let stopRequested = false;
  let steerRequested = false; // SIGUSR2 from steering (`epoptes feedback --steer`, a steer comment): interrupt this cycle, start the next at once
  let current: Cycle | null = null;
  let wake: (() => void) | null = null;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(() => ((wake = null), resolve()), ms);
      wake = () => (clearTimeout(t), (wake = null), resolve());
    });

  const readControl = () => readJson<{ pause_after_cycle?: boolean; for_human?: { reason: string } }>(p.control);
  const pauseRequested = () => readControl()?.pause_after_cycle === true;
  // A pause from `epoptes wait-for-human` ends the run as needs_input, with its reason.
  const pauseReason = (): EndReason => (readControl()?.for_human ? 'needs_you' : 'paused');
  const onStop = () => {
    if (stopRequested) return;
    stopRequested = true;
    log('stop requested');
    current?.interrupt();
    wake?.();
  };
  const onSteer = () => {
    log('steering: interrupting the cycle to replan');
    if (current) {
      steerRequested = true;
      current.interrupt();
    } else if (status.wait_reason === 'between_cycles') wake?.(); // never cut a rate-limit or cooldown wait short
  };
  process.on('SIGINT', onStop);
  process.on('SIGTERM', onStop);
  process.on('SIGUSR2', onSteer);

  const heartbeat = setInterval(() => {
    const patch: Partial<Status> = { heartbeat_at: nowIso() };
    if (pauseRequested() && !status.pause_requested) {
      patch.pause_requested = true;
      if (status.state === 'running') patch.state = 'pausing';
      else wake?.(); // idle between cycles: pause right away
    }
    setStatus(patch);
  }, HEARTBEAT_MS);

  const finish = (reason: EndReason) => {
    clearInterval(heartbeat);
    const c = readClock(p) ?? backup;
    writeClock(p, pauseClock(c));
    const needs = reason === 'needs_you' ? { reason: readControl()?.for_human?.reason ?? 'the orchestrator needs you', since: nowIso() } : null;
    if (reason === 'paused' || reason === 'needs_you') rm(p.control);
    setStatus({ state: END_STATE[reason], pid: null, pause_requested: false, waiting_until: null, wait_reason: null, cycle_started_at: null, live_usage: null, needs });
    emit(p, { src: 'runner', type: 'run.end', run, cycle: status.cycle || null, reason });
    rm(p.lock);
    // After run.end, so the digest sees how the run ended. Feed the brain (~/.epoptes/brain): token-free, and never allowed to break the run's ending.
    try {
      gatherGoal(p);
      rebuildIndex();
    } catch (e) {
      log(`brain not updated: ${(e as Error).message}`);
    }
    log(`run ${run} ended: ${reason}`);
  };

  const wait = async (seconds: number, state: Status['state'], reason: NonNullable<Status['wait_reason']>, pauseTheClock = false) => {
    if (seconds <= 0) return;
    setStatus({ state, waiting_until: nowIso(Date.now() + seconds * 1000), wait_reason: reason });
    emit(p, { src: 'runner', type: 'wait', run, cycle: status.cycle || null, reason, seconds });
    if (pauseTheClock) writeClock(p, pauseClock(readClock(p) ?? backup));
    await sleep(seconds * 1000);
    if (pauseTheClock) {
      backup = resumeClock(readClock(p) ?? backup);
      writeClock(p, backup);
    }
    setStatus({ state: 'waiting', waiting_until: null, wait_reason: null });
  };

  // ---- the loop ----
  let fails = 0;
  let lastSteered = false; // the previous cycle was interrupted by steering
  let backoff = goal.rate_limit.backoff_s;
  let lastMode: Mode | null = status.mode;

  try {
    for (;;) {
      // The clock must survive agents; restore it if something deleted it.
      const c = readClock(p);
      if (c) backup = c;
      else {
        writeClock(p, backup);
        emit(p, { src: 'runner', type: 'warn', run, text: 'run/clock.json was missing and has been restored' });
      }

      try {
        goal = loadGoal(p);
      } catch (e) {
        emit(p, { src: 'runner', type: 'warn', run, text: `goal.json not reloaded: ${(e as Error).message}` });
      }

      if (stopRequested) return finish('stopped');
      if (exists(p.done)) return finish('done');
      if (pauseRequested()) return finish(pauseReason());

      const st = clockState(backup, { wrapupMarker: exists(p.wrapup) });
      if (lastMode && st.mode !== lastMode) emit(p, { src: 'runner', type: 'mode', run, from: lastMode, to: st.mode });
      lastMode = st.mode;
      setStatus({ mode: st.mode });
      if (st.mode === 'stop') return finish('timebox');

      for (const id of ingest(p)) log(`card ${id} added from FEEDBACK.md`);
      const cards = currentCards(p);

      let preamble = '';
      if (isFollowUp) {
        const items = followUpCards(cards);
        if (!items.length) {
          // Every item is done, answered or flagged for a new run: nothing left to spend a cycle on.
          touch(p.done);
          emit(p, { src: 'runner', type: 'done', run, cycle: status.cycle || null, text: 'follow-up: every card is handled' });
          return finish('done');
        }
        const ran = readEvents(p).filter((e) => e.type === 'cycle.start' && e.run === run).length;
        if (ran >= FOLLOWUP_MAX_CYCLES) {
          emit(p, { src: 'runner', type: 'warn', run, text: `follow-up paused after ${ran} cycles without DONE; resume to continue, or look at what's left` });
          return finish('paused');
        }
        preamble = followUpPreamble(items);
      }

      const n = lastCycle(p) + 1;
      const timeoutMin = Math.min(MAX_TIMEOUT_MIN, Math.max(MIN_TIMEOUT_MIN, goal.cycle.timeout_min));
      const timeoutS = Math.round(Math.max(60, Math.min(timeoutMin * 60, st.toHard)));
      const cycleDir = p.cycleDir(n);
      fs.mkdirSync(cycleDir, { recursive: true });
      const steers = pendingSteers(cards);
      // Build mode with nothing real left to do: steer the cycle to the done checks and wrap-up, not new work.
      const work = st.mode === 'build' && !exists(p.wrapup) ? openWork(cards) : null;
      const clear = Boolean(work && work.open === 0 && !work.untriaged && !work.waiting && !steers.length);
      if (clear) preamble += backlogClearPreamble(work!);
      const loop = fs.readFileSync(path.join(p.root, goal.adapter.prompt), 'utf8');
      const prompt = steerPreamble(steers, lastSteered) + preamble + (/epoptes (board|card)\b/.test(loop) ? '' : BOARD_PREAMBLE) + loop;

      const spec = {
        cwd: p.project,
        goalDir: p.root,
        cycleDir,
        prompt,
        model: goal.adapter.model,
        effort: goal.adapter.effort,
        permissionMode: goal.adapter.permission_mode,
        args: goal.adapter.args,
        budgetUsd: goal.cycle.max_budget_usd,
        agentsDir: p.agents,
        settingsFile: exists(p.settings) ? p.settings : null,
        env: {
          ...process.env,
          PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`,
          EPOPTES_GOAL_DIR: p.root,
          EPOPTES_RUN: run,
          EPOPTES_CYCLE: String(n),
          EPOPTES_MODE: st.mode,
          // Background subagents were killed 600 s after the turn ended in dress2impress; the timeout bounds the cycle.
          CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
        },
      };

      setStatus({ state: status.pause_requested ? 'pausing' : 'running', cycle: n, cycle_started_at: nowIso(), live_usage: null });
      emit(p, { src: 'runner', type: 'cycle.start', run, cycle: n, mode: st.mode, model: goal.adapter.model, effort: goal.adapter.effort, timeout_s: timeoutS, ...(steers.length ? { steer: steers.map((f) => f.id) } : {}), ...(clear ? { backlog_clear: true } : {}) });
      log(`cycle ${n} start: mode=${st.mode} ${goal.adapter.model}/${goal.adapter.effort} timeout=${timeoutS}s`);

      const activityFile = path.join(cycleDir, 'activity.jsonl');
      const cycle = adapter.start(spec, {
        activity: (a: Activity) => appendJsonl(activityFile, a),
        limits: (l) => setStatus({ limits: l }),
        usage: (u) => setStatus({ live_usage: { ...u, at: nowIso() } }),
        warn: (text) => emit(p, { src: 'runner', type: 'warn', run, cycle: n, text }),
      });
      current = cycle;
      if (stopRequested) cycle.interrupt();

      let timedOut = false;
      let killTimer: NodeJS.Timeout | null = null;
      const escalate = () => {
        killTimer ??= setTimeout(() => cycle.kill(), KILL_AFTER_MS);
      };
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        log(`cycle ${n} hit its timeout`);
        cycle.interrupt();
        escalate();
      }, timeoutS * 1000);
      const stopWatch = setInterval(() => (stopRequested || steerRequested) && escalate(), 1000);

      const result = await cycle.done;
      current = null;
      clearTimeout(timeoutTimer);
      clearInterval(stopWatch);
      if (killTimer) clearTimeout(killTimer);

      let exit: CycleExit = result.exit;
      const steered = steerRequested && !stopRequested;
      steerRequested = false;
      lastSteered = steered;
      if (stopRequested || steered) exit = 'interrupted';
      else if (timedOut) exit = 'timeout';
      writeJson(path.join(cycleDir, 'result.json'), { version: 1, cycle: n, run, ...result, exit });
      emit(p, { src: 'runner', type: 'cycle.end', run, cycle: n, exit, duration_s: result.duration_s, cost_usd: result.cost_usd, turns: result.turns, ...(steered ? { steered: true } : {}) });
      log(`cycle ${n} end: ${exit} ${result.duration_s}s turns=${result.turns ?? '?'} ${result.cost_usd == null ? 'cost=unknown' : `cost≈$${result.cost_usd.toFixed(2)}`}${result.error ? ` error=${result.error}` : ''}`);

      if (goal.checkpoints === 'shadow') {
        try {
          if (shadowSnapshot(p, n)) log(`cycle ${n} snapshot committed`);
        } catch (e) {
          emit(p, { src: 'runner', type: 'warn', run, cycle: n, text: `snapshot failed: ${(e as Error).message.split('\n')[0]}` });
        }
      }
      for (const text of capWarnings(p, goal)) emit(p, { src: 'runner', type: 'warn', run, cycle: n, text });
      setStatus({ cycle_started_at: null, live_usage: null });

      if (stopRequested) return finish('stopped');

      if (exit === 'rate_limited') {
        const resetsAt = result.rate_limit?.resets_at ? Date.parse(result.rate_limit.resets_at) : NaN;
        const secs = Number.isFinite(resetsAt) && resetsAt > Date.now() ? Math.ceil((resetsAt - Date.now()) / 1000) + 30 : backoff;
        log(`rate limited: waiting ${secs}s`);
        backoff = Math.min(backoff * 2, goal.rate_limit.backoff_max_s);
        await wait(secs, 'rate_limited', 'rate_limit', goal.timebox.pause_on_rate_limit);
        continue;
      }
      backoff = goal.rate_limit.backoff_s;

      if (steered) continue; // not a failure, and no pause: the steering cycle starts now
      fails = exit === 'ok' ? 0 : fails + 1;
      setStatus({ fails_in_row: fails });
      if (fails >= goal.failures.give_up_after) {
        log(`${fails} failed cycles in a row: giving up (see ${path.join(cycleDir, 'stderr.log')})`);
        return finish('failed');
      }
      if (fails >= goal.failures.cooldown_after) {
        log(`${fails} failed cycles in a row: cooling down ${goal.failures.cooldown_min} min`);
        await wait(goal.failures.cooldown_min * 60, 'cooldown', 'cooldown');
        continue;
      }
      if (!exists(p.done) && !pauseRequested() && !stopRequested) await wait(goal.cycle.pause_between_s, 'waiting', 'between_cycles');
    }
  } catch (e) {
    emit(p, { src: 'runner', type: 'warn', run, text: `runner error: ${(e as Error).message}` });
    log(`runner error: ${(e as Error).stack ?? e}`);
    finish('failed');
    throw e;
  } finally {
    process.off('SIGINT', onStop);
    process.off('SIGTERM', onStop);
    process.off('SIGUSR2', onSteer);
  }
}
