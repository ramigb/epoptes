import { readJson, writeJson } from './fsx.ts';
import type { GoalPaths } from './paths.ts';
import { validate } from './schema.ts';

export type HookName = 'onStart' | 'onEnd' | 'onPause' | 'onStop';
export type GoalHooks = Partial<Record<HookName, string | null>>;

export interface Goal {
  version: 1;
  id: string;
  name: string;
  kind: 'code' | 'research' | 'content' | 'data' | 'other';
  objective: string;
  done: { id: string; check: string; verify: { type: 'command' | 'file' | 'agent' | 'manual'; run?: string; path?: string } }[];
  non_goals: string[];
  approval_required: string[];
  /** the main deliverable: a project-relative path or an http(s) URL */
  output?: string;
  /** the current job, set by `epoptes job new` (one harness, several jobs over time) */
  job?: { id: string; title: string };
  /** total_min null = open-ended: no time box, the run goes until DONE, a pause or a stop */
  timebox: { total_min: number | null; wrapup_min: number; grace_min: number; pause_on_rate_limit: boolean };
  checkpoints: 'git' | 'shadow' | 'none';
  adapter: { type: 'claude-code' | 'codex' | 'pi' | 'antigravity'; prompt: string; model: string; effort: string; permission_mode: string; args: string[] };
  cycle: { timeout_min: number; pause_between_s: number; max_budget_usd: number | null };
  hooks: GoalHooks;
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

/** Updates cycle settings and/or lifecycle hooks in goal.json after schema validation. */
export function updateGoalSettings(
  p: GoalPaths,
  patch: { cycle?: Partial<Goal['cycle']>; hooks?: GoalHooks },
): Goal {
  const raw = readJson<Record<string, unknown>>(p.goal);
  if (!raw) throw new Error(`no goal at ${p.goal}`);
  const next = structuredClone(raw) as Record<string, any>;
  if (patch.cycle) {
    next.cycle = { ...(next.cycle ?? {}), ...patch.cycle };
  }
  if (patch.hooks) {
    const cleaned: GoalHooks = { ...(next.hooks ?? {}) };
    for (const k of ['onStart', 'onEnd', 'onPause', 'onStop'] as const) {
      if (k in patch.hooks) {
        const v = patch.hooks[k];
        if (v == null || !String(v).trim()) delete cleaned[k];
        else cleaned[k] = String(v).trim();
      }
    }
    if (Object.keys(cleaned).length) next.hooks = cleaned;
    else delete next.hooks;
  }
  const check = structuredClone(next);
  const errors = validate('goal', check);
  if (errors.length) throw new Error(`invalid settings:\n  ${errors.join('\n  ')}`);
  writeJson(p.goal, next);
  return check as Goal;
}
