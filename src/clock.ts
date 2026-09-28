// Active-time clock (port of dress2impress harness/clock.mjs). Active time = wall time since start
// minus paused time; it only accrues while a runner is live.
import { epochS, exists, nowIso, readJson, writeJson } from './fsx.ts';
import type { Goal } from './goal.ts';
import type { GoalPaths } from './paths.ts';

export interface Clock {
  version: 1;
  run: string;
  started_at: string;
  paused_s: number;
  paused_at: string | null;
  timebox_s: number;
  wrapup_s: number;
  grace_s: number;
}

export type Mode = 'build' | 'wrapup' | 'overtime' | 'stop';

export interface ClockState {
  mode: Mode;
  active: number;
  toWrapup: number;
  toEnd: number;
  toHard: number;
}

const nowS = () => Math.floor(Date.now() / 1000);

export function newClock(run: string, t: Goal['timebox'], at = nowIso()): Clock {
  return {
    version: 1,
    run,
    started_at: at,
    paused_s: 0,
    paused_at: null,
    timebox_s: t.total_min * 60,
    wrapup_s: t.wrapup_min * 60,
    grace_s: t.grace_min * 60,
  };
}

export function activeS(c: Clock, now = nowS()): number {
  const open = c.paused_at ? now - epochS(c.paused_at) : 0;
  return now - epochS(c.started_at) - c.paused_s - open;
}

export function clockState(c: Clock, { wrapupMarker = false, now = nowS() } = {}): ClockState {
  const active = activeS(c, now);
  const end = c.timebox_s;
  const wrap = end - c.wrapup_s;
  const hard = end + c.grace_s;
  let mode: Mode = active < wrap ? 'build' : active < end ? 'wrapup' : active < hard ? 'overtime' : 'stop';
  // WRAPUP marker: the orchestrator finished early, so wrap up now.
  if (mode === 'build' && wrapupMarker) mode = 'wrapup';
  return { mode, active, toWrapup: wrap - active, toEnd: end - active, toHard: hard - active };
}

/** Freezes the clock (no-op if already paused). */
export function pauseClock(c: Clock, at = nowIso()): Clock {
  return c.paused_at ? c : { ...c, paused_at: at };
}

/** Unfreezes the clock, counting the frozen gap as paused time. */
export function resumeClock(c: Clock, now = nowS()): Clock {
  if (!c.paused_at) return c;
  return { ...c, paused_s: c.paused_s + Math.max(0, now - epochS(c.paused_at)), paused_at: null };
}

export const readClock = (p: GoalPaths) => readJson<Clock>(p.clock);
export const writeClock = (p: GoalPaths, c: Clock) => writeJson(p.clock, c);
export const readClockState = (p: GoalPaths) => {
  const c = readClock(p);
  return c ? clockState(c, { wrapupMarker: exists(p.wrapup) }) : null;
};
