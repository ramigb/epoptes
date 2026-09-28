// The runner adapter interface. v1 ships only claude-code; other providers implement the same shape.
import type { Limits } from '../status.ts';

export interface Activity {
  ts: string;
  agent: string;
  kind: 'init' | 'tool' | 'agent.start' | 'agent.end' | 'text' | 'result';
  tool?: string;
  path?: string;
  summary: string;
}

export interface ModelUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number | null;
}

export type CycleExit = 'ok' | 'error' | 'timeout' | 'interrupted' | 'rate_limited';

/** cycle-result.schema.json minus the fields the runner adds (version, cycle, run). */
export interface CycleResult {
  adapter: string;
  started_at: string;
  ended_at: string;
  duration_s: number;
  exit: CycleExit;
  turns: number | null;
  session_id: string | null;
  cost_usd: number | null;
  cost_basis: 'billed' | 'estimate';
  models: Record<string, ModelUsage>;
  rate_limit: { status: string; resets_at: string | null; windows: Limits['windows'] } | null;
  error: string | null;
}

export interface CycleSpec {
  cwd: string;
  goalDir: string;
  cycleDir: string;
  prompt: string;
  model: string;
  effort: string;
  permissionMode: string;
  args: string[];
  budgetUsd: number | null;
  agentsDir: string;
  settingsFile: string | null;
  env: Record<string, string | undefined>;
}

export interface CycleHooks {
  activity(a: Activity): void;
  limits(l: Limits): void;
  warn(text: string): void;
}

export interface Cycle {
  pid: number | undefined;
  /** Ask the cycle to stop (SIGINT). The runner escalates to kill() after a grace period. */
  interrupt(): void;
  kill(): void;
  done: Promise<CycleResult>;
}

export interface Adapter {
  id: string;
  check(): Promise<{ ok: boolean; version?: string; problem?: string }>;
  /** The command a cycle would run; writes its generated config files into spec.cycleDir. */
  command(spec: CycleSpec): { bin: string; args: string[]; env: Record<string, string> };
  start(spec: CycleSpec, hooks: CycleHooks): Cycle;
}
