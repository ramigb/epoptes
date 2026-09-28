import { readJson } from './fsx.ts';
import type { GoalPaths } from './paths.ts';
import { validate } from './schema.ts';

export interface Goal {
  version: 1;
  id: string;
  name: string;
  kind: 'code' | 'research' | 'content' | 'data' | 'other';
  objective: string;
  done: { id: string; check: string; verify: { type: 'command' | 'file' | 'agent' | 'manual'; run?: string; path?: string } }[];
  non_goals: string[];
  approval_required: string[];
  timebox: { total_min: number; wrapup_min: number; grace_min: number; pause_on_rate_limit: boolean };
  checkpoints: 'git' | 'shadow' | 'none';
  adapter: { type: 'claude-code'; prompt: string; model: string; effort: string; permission_mode: string; args: string[] };
  cycle: { timeout_min: number; pause_between_s: number; max_budget_usd: number | null };
  failures: { cooldown_after: number; cooldown_min: number; give_up_after: number };
  rate_limit: { backoff_s: number; backoff_max_s: number };
  state_caps: Record<string, number>;
  notify: string[];
}

/** Reads goal.json, validates it and fills in defaults. Throws with every problem listed. */
export function loadGoal(p: GoalPaths): Goal {
  const raw = readJson<Goal>(p.goal);
  if (!raw) throw new Error(`no goal at ${p.goal}`);
  const errors = validate('goal', raw);
  if (errors.length) throw new Error(`${p.goal} is invalid:\n  ${errors.join('\n  ')}`);
  return raw;
}
