// Controls shared by the CLI and (later) the dashboard. They only touch files, signals and the runner process.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { readClock, runFinished, writeClock } from './clock.ts';
import { emit, readEvents } from './events.ts';
import { addFeedback, decideApproval, pendingApprovals, readFeedback, type Decision, type Src } from './feedback.ts';
import { exists, nowIso, rm, writeJson } from './fsx.ts';
import { adapters } from './adapters/index.ts';
import { loadGoal } from './goal.ts';
import { goalPaths, type GoalPaths } from './paths.ts';
import { LIVE_STATES, readStatus, reconcile, writeStatus, type Status } from './status.ts';

const isLive = (s: Status) => LIVE_STATES.includes(s.state);

/**
 * Spawns a detached runner for the goal and waits until it reports in. Resumes the current run; a goal whose
 * run is over (DONE, or past its hard stop) only starts again with newRun, because a new run spends tokens
 * and finds work only if feedback or backlog tasks were added since.
 */
export async function start(project: string, { newRun = false } = {}): Promise<Status> {
  const p = goalPaths(project);
  const goal = loadGoal(p); // fail fast on an invalid goal
  const s = reconcile(p);
  if (isLive(s)) throw new Error(`already ${s.state} (pid ${s.pid})`);
  // Without this, a missing CLI shows up as six failed cycles.
  const check = await adapters[goal.adapter.type].check();
  if (!check.ok) throw new Error(check.problem);
  const finished = runFinished(p);
  if (finished && !newRun) {
    throw new Error(
      exists(p.done)
        ? 'this goal is done. Starting again begins a new run with a fresh time box, and the orchestrator only finds work if you added feedback or backlog tasks. Use `epoptes start --new-run` to do it anyway.'
        : 'the time box is over. Use `epoptes extend <dur>` to continue this run, or `epoptes start --new-run` to begin a new one.',
    );
  }
  const action = finished || !readClock(p) ? 'start' : 'resume';
  fs.mkdirSync(p.run, { recursive: true });
  const out = fs.openSync(p.runnerLog, 'a');
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], '_run', p.project], {
    cwd: p.project,
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
  fs.closeSync(out);
  emit(p, { src: 'user', type: 'control', run: s.run, action });

  // Confirm with the runner's run.start event: a short run can already be over by the first poll.
  const spawnedAt = Date.now() - 1000;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    const started = readEvents(p).findLast((e) => e.type === 'run.start' && Date.parse(e.ts) >= spawnedAt);
    if (started) return readStatus(p)!;
    if (child.exitCode !== null) break;
  }
  const tail = fs.readFileSync(p.runnerLog, 'utf8').trim().split('\n').slice(-5).join('\n');
  throw new Error(`runner did not start; last lines of ${p.runnerLog}:\n${tail}`);
}

/** Pause after the current cycle (the safe default). The runner pauses the clock and exits. */
export function pause(project: string) {
  const p = goalPaths(project);
  const s = reconcile(p);
  if (!isLive(s)) throw new Error(`not running (state: ${s.state})`);
  writeJson(p.control, { version: 1, pause_after_cycle: true, requested_at: nowIso(), by: process.env.EPOPTES_CYCLE ? 'orchestrator' : 'user' });
  emit(p, { src: 'user', type: 'control', run: s.run, cycle: s.cycle || null, action: 'pause' });
  return s;
}

/**
 * Ends the run after this cycle as `needs_input`: the orchestrator can't move anything else until the human
 * answers (approvals, a review, an opinion). Unlike a plain pause, the dashboard and status say so clearly.
 */
export function waitForHuman(project: string, reason: string) {
  const p = goalPaths(project);
  reason = reason.trim();
  if (!reason) throw new Error('say what you are waiting for: epoptes wait-for-human "<what the human should do>"');
  const s = reconcile(p);
  if (!isLive(s)) throw new Error(`not running (state: ${s.state})`);
  const inCycle = Boolean(process.env.EPOPTES_CYCLE);
  writeJson(p.control, { version: 1, pause_after_cycle: true, requested_at: nowIso(), by: inCycle ? 'orchestrator' : 'user', for_human: { reason } });
  emit(p, { src: inCycle ? 'orchestrator' : 'user', type: 'needs_you', run: s.run, cycle: s.cycle || null, text: reason });
  return s;
}

/**
 * The human's answer to an approval. When the run was waiting for the human and this was the last
 * unanswered approval, the run resumes by itself.
 */
export async function decide(project: string, id: string, decision: Decision, note?: string): Promise<{ resumed: boolean; problem?: string }> {
  const p = goalPaths(project);
  decideApproval(p, id, decision, note);
  return resumeIfAnswered(project);
}

/** Resumes a needs_input run once no approval is left unanswered. */
export async function resumeIfAnswered(project: string, { force = false } = {}): Promise<{ resumed: boolean; problem?: string }> {
  const p = goalPaths(project);
  const s = reconcile(p);
  if (s.state !== 'needs_input') return { resumed: false };
  if (!force && pendingApprovals(readFeedback(p)).length) return { resumed: false };
  try {
    await start(project);
  } catch (e) {
    // The answer is recorded either way; say why the run didn't resume (e.g. the time box is over).
    return { resumed: false, problem: (e as Error).message };
  }
  return { resumed: true };
}

/**
 * Steering feedback: adds the item and, if a cycle is running, interrupts it (SIGUSR2 to the runner) so a fresh
 * cycle starts at once and replans around it. Work on disk is kept; the next cycle recovers it. When no runner is
 * live, the item waits and the next start replans first.
 */
export function steer(project: string, text: string, src: Src): { id: string; interrupted: boolean } {
  const p = goalPaths(project);
  const id = addFeedback(p, text, src, { steer: true });
  const s = reconcile(p);
  let interrupted = false;
  if (isLive(s) && s.pid) {
    process.kill(s.pid, 'SIGUSR2');
    interrupted = s.state === 'running' || s.state === 'pausing';
  }
  emit(p, { src: 'user', type: 'control', run: s.run, cycle: s.cycle || null, action: 'steer', ref: id });
  return { id, interrupted };
}

/** Stop now: SIGINT to the runner, which interrupts the cycle; the next cycle recovers the interrupted work. */
export function stop(project: string) {
  const p = goalPaths(project);
  const s = reconcile(p);
  if (!isLive(s) || !s.pid) throw new Error(`not running (state: ${s.state})`);
  process.kill(s.pid, 'SIGINT');
  emit(p, { src: 'user', type: 'control', run: s.run, cycle: s.cycle || null, action: 'stop' });
  return s;
}

export function extend(project: string, seconds: number) {
  const p = goalPaths(project);
  const c = readClock(p);
  if (!c) throw new Error('no clock yet: start the goal first (the time box comes from goal.json)');
  if (seconds <= 0) throw new Error('extend by a positive duration');
  writeClock(p, { ...c, timebox_s: c.timebox_s + seconds });
  emit(p, { src: 'user', type: 'control', run: c.run, action: 'extend', seconds });
}

/** Clears the clock and end markers; the next start begins a new run with goal.json's time box. */
export function resetClock(project: string) {
  const p: GoalPaths = goalPaths(project);
  const s = reconcile(p);
  if (isLive(s)) throw new Error(`can't reset while ${s.state}: pause or stop it first`);
  for (const f of [p.clock, p.done, p.wrapup, p.control]) rm(f);
  if (readStatus(p)) writeStatus(p, { ...s, state: 'idle', mode: null, fails_in_row: 0 });
  emit(p, { src: 'user', type: 'control', run: s.run, action: 'reset' });
}
