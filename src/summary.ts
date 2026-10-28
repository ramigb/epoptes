// Read-only views over a goal's files, shared by `epoptes status` and (later) the dashboard and reports.
import fs from 'node:fs';
import path from 'node:path';
import type { CycleResult } from './adapters/types.ts';
import type { Milestone } from './board.ts';
import { readEvents, type EpoptesEvent } from './events.ts';
import { readJson } from './fsx.ts';
import type { Goal } from './goal.ts';
import type { GoalPaths } from './paths.ts';

export type ReachedMilestone = Milestone & { reached: { at: string; run: string | null; active_s: number | null } | null };

/** Board milestones, each with when it was reached (its latest `milestone` event naming it, e.g. "M2: …"). */
export function milestonesWithReach(ms: Milestone[], events: EpoptesEvent[], run: string | null): ReachedMilestone[] {
  return ms.map((m) => {
    const re = new RegExp(`^${m.id}\\b`, 'i');
    const e = events.findLast((x) => x.type === 'milestone' && re.test(String(x.text ?? '')));
    const reached = e ? { at: e.ts, run: e.run, active_s: e.run === run && typeof e.active_s === 'number' ? e.active_s : null } : null;
    return { ...m, reached };
  });
}

export interface Projection {
  /** projected active time at which the last milestone lands */
  end_s: number;
  /** actual / planned time so far (0.25 = took a quarter of the planned time) */
  pace: number;
  /** the milestone the pace is measured at */
  basis: string;
}

/**
 * Where the run is heading, from milestone pace: the latest milestone reached in this run (with its active time)
 * against its target, applied to the last milestone's target. An unreached current milestone that is already past
 * its target slows the pace to at least active / its target. Null when there's nothing to measure or project.
 */
export function projectFinish(ms: ReachedMilestone[], active: number): Projection | null {
  const last = ms.filter((m) => m.target_s != null).at(-1);
  if (!last || last.reached) return null;
  const basis = ms.filter((m) => m.target_s && m.reached?.active_s != null).at(-1);
  const overdue = ms.find((m) => m.current && !m.reached && m.target_s && active > m.target_s);
  let pace = basis ? basis.reached!.active_s! / basis.target_s! : 0;
  let at = basis?.id ?? '';
  if (overdue && active / overdue.target_s! > pace) {
    pace = active / overdue.target_s!;
    at = overdue.id;
  }
  if (!at) return null;
  return { end_s: Math.max(active, Math.round(last.target_s! * pace)), pace, basis: at };
}

export interface Output {
  kind: 'url' | 'file';
  /** the URL, or the path relative to the project */
  target: string;
  text: string | null;
  exists: boolean;
  /** where it was named: the latest `output` event, or goal.json */
  from: 'event' | 'goal';
}

/** The goal's main deliverable: the latest `epoptes event output`, else goal.json `output`. */
export function outputOf(p: GoalPaths, goal: Goal, events = readEvents(p)): Output | null {
  const e = events.findLast((x) => x.type === 'output' && typeof x.path === 'string');
  const target = (e?.path as string | undefined) ?? goal.output;
  if (!target) return null;
  if (/^https?:\/\//i.test(target)) return { kind: 'url', target, text: (e?.text as string) ?? null, exists: true, from: e ? 'event' : 'goal' };
  const rel = path.normalize(target).replace(/^(\.\/)+/, '');
  return { kind: 'file', target: rel, text: (e?.text as string) ?? null, exists: fs.existsSync(path.join(p.project, rel)), from: e ? 'event' : 'goal' };
}

export function lastResult(p: GoalPaths): (CycleResult & { cycle: number; run: string }) | null {
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(p.cycles).filter((d) => /^\d{6}$/.test(d)).sort().reverse();
  } catch {
    return null;
  }
  for (const d of dirs) {
    const r = readJson<CycleResult & { cycle: number; run: string }>(path.join(p.cycles, d, 'result.json'));
    if (r) return r;
  }
  return null;
}

export function readHead(file: string, lines: number): string[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').slice(0, lines);
  } catch {
    return [];
  }
}

/** "≈ $4.66 (estimate)" or "$4.66". */
export const money = (usd: number | null | undefined, basis: 'billed' | 'estimate' = 'estimate') =>
  usd == null ? '–' : basis === 'estimate' ? `≈ $${usd.toFixed(2)} (estimate)` : `$${usd.toFixed(2)}`;

/** An unknown cost makes the total unknown, rather than looking like free usage. */
export const totalCost = (items: { cost_usd: number | null }[]): number | null =>
  items.some((x) => x.cost_usd == null) ? null : items.reduce((sum, x) => sum + x.cost_usd!, 0);
