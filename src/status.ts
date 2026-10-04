import fs from 'node:fs';
import { pauseClock, readClock, writeClock, type Mode } from './clock.ts';
import { emit } from './events.ts';
import { nowIso, readJson, rm, writeJson } from './fsx.ts';
import type { GoalPaths } from './paths.ts';

export type RunState =
  | 'idle' | 'running' | 'waiting' | 'rate_limited' | 'cooldown' | 'pausing'
  | 'paused' | 'needs_input' | 'stopped' | 'crashed' | 'failed' | 'done' | 'timeboxed';

export const LIVE_STATES: RunState[] = ['running', 'waiting', 'rate_limited', 'cooldown', 'pausing'];

export interface Limits {
  status: string;
  resets_at: string | null;
  windows: Record<string, { utilization: number; resets_at: string | null }>;
  at: string;
}

export interface Status {
  version: 1;
  state: RunState;
  pid: number | null;
  run: string | null;
  cycle: number;
  mode: Mode | null;
  cycle_started_at: string | null;
  heartbeat_at: string | null;
  waiting_until: string | null;
  wait_reason: 'rate_limit' | 'cooldown' | 'between_cycles' | null;
  pause_requested: boolean;
  fails_in_row: number;
  limits: Limits | null;
  /** set while state is needs_input (`epoptes wait-for-human`) */
  needs?: { reason: string; since: string } | null;
  updated_at: string;
}

export function idleStatus(): Status {
  return {
    version: 1, state: 'idle', pid: null, run: null, cycle: 0, mode: null, cycle_started_at: null,
    heartbeat_at: null, waiting_until: null, wait_reason: null, pause_requested: false, fails_in_row: 0,
    limits: null, needs: null, updated_at: nowIso(),
  };
}

export const readStatus = (p: GoalPaths) => readJson<Status>(p.status);
export const writeStatus = (p: GoalPaths, s: Status) => writeJson(p.status, { ...s, updated_at: nowIso() });

export function isAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Reads the status and repairs it if its runner died without cleaning up: the state becomes
 * `crashed` and the clock is frozen at the last heartbeat. Safe to call from any reader.
 */
export function reconcile(p: GoalPaths): Status {
  const s = readStatus(p) ?? idleStatus();
  // A cycle's sandbox can hide the runner PID. Only readers outside that cycle reconcile it.
  const ownCycle = process.env.EPOPTES_GOAL_DIR === p.root
    && process.env.EPOPTES_RUN === s.run
    && process.env.EPOPTES_CYCLE === String(s.cycle);
  if (!LIVE_STATES.includes(s.state) || ownCycle || isAlive(s.pid)) return s;
  const at = s.heartbeat_at ?? s.updated_at;
  const c = readClock(p);
  if (c) writeClock(p, pauseClock(c, at));
  const fixed: Status = { ...s, state: 'crashed', pid: null, waiting_until: null, wait_reason: null };
  writeStatus(p, fixed);
  rm(p.lock);
  emit(p, { src: 'runner', type: 'run.end', run: s.run, cycle: s.cycle || null, reason: 'crashed' });
  return fixed;
}

/** Last started cycle number: the larger of status.cycle and the newest cycles/ directory. */
export function lastCycle(p: GoalPaths): number {
  let max = readStatus(p)?.cycle ?? 0;
  try {
    for (const d of fs.readdirSync(p.cycles)) if (/^\d{6}$/.test(d)) max = Math.max(max, Number(d));
  } catch {
    // no cycles yet
  }
  return max;
}
