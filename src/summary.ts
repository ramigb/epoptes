// Read-only views over a goal's files, shared by `epoptes status` and (later) the dashboard and reports.
import fs from 'node:fs';
import path from 'node:path';
import type { CycleResult } from './adapters/types.ts';
import type { Card, Milestone } from './board.ts';
import { readEvents, type EpoptesEvent } from './events.ts';
import { readJson } from './fsx.ts';
import type { Goal } from './goal.ts';
import type { GoalPaths } from './paths.ts';
import type { Status } from './status.ts';

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

/**
 * Strips internal implementation jargon (parenthetical notes, file:line refs, area prefixes, review ids) from a
 * raw card title so a user unfamiliar with the codebase gets a compact, readable summary.
 */
export function humanizeTask(raw: string, maxLen = 90): string {
  let s = (raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // Remove leading review/task prefixes like `R-3 [high] ` or `core+headless: `
  s = s.replace(/^R-\d+\s*(?:\[(?:high|med|low)\]\s*)?/i, '');
  s = s.replace(/^[a-z0-9_+.-]{2,24}:\s+/i, '');
  // Drop parenthetical technical notes and file:line references
  s = s.replace(/\s*\([^)]{6,}\)/g, '');
  s = s.replace(/\b[\w./-]+\.(?:rs|ts|tsx|js|jsx|py|go|cpp|c|h|md|json|toml|yaml|yml)(?::\d+(?:-\d+)?)?\b/gi, '');
  // Take only the first clause if semicolon-separated
  if (s.includes(';')) s = s.split(';')[0];
  s = s.replace(/\s*[,;:\-–—]+\s*$/, '').replace(/\s+/g, ' ').trim();
  if (!s) s = raw.replace(/\s+/g, ' ').trim();
  s = s[0].toUpperCase() + s.slice(1);
  return s.length > maxLen ? `${s.slice(0, maxLen - 1).trimEnd()}…` : s;
}

export interface GeneralStatus {
  /** Compact, plain-English overview combining what just happened and what is happening now */
  summary: string;
  last_cycle: string | null;
  current: string | null;
  source: 'orchestrator' | 'synthesized';
}

/**
 * Plain-English status for the human, combining the last cycle and the current cycle.
 * Uses the orchestrator's explicit `status` event when present, otherwise synthesizes a concise,
 * jargon-free summary from milestones, cards and events (zero extra tokens).
 */
export function generalStatus(
  status: Status | null | undefined,
  cards: Card[],
  milestones: Milestone[],
  events: EpoptesEvent[],
): GeneralStatus | null {
  const cycle = status?.cycle ?? 0;
  const state = status?.state ?? 'idle';
  if (cycle === 0 && !cards.length && state === 'idle') return null;

  const statusEv = events.findLast((e) => e.type === 'status' && typeof e.text === 'string' && e.text.trim());
  if (statusEv && (statusEv.cycle === cycle || (cycle > 0 && statusEv.cycle === cycle - 1 && state !== 'running'))) {
    const text = String(statusEv.text).trim();
    return { summary: text, last_cycle: null, current: text, source: 'orchestrator' };
  }

  // Last cycle summary
  const prevCycle = state === 'running' || state === 'pausing' ? cycle - 1 : cycle;
  let lastPart: string | null = null;
  if (prevCycle > 0) {
    const prevEnd = events.findLast((e) => e.type === 'cycle.end' && e.cycle === prevCycle);
    const prevMs = events.findLast((e) => e.type === 'milestone' && e.cycle === prevCycle);
    const prevDone = cards.filter((c) => c.column === 'done' && !c.cut && c.cycle === prevCycle);
    if (prevMs && typeof prevMs.text === 'string') {
      lastPart = `Last cycle reached ${humanizeTask(prevMs.text, 85)}.`;
    } else if (prevDone.length === 1) {
      lastPart = `Last cycle finished: ${humanizeTask(prevDone[0].title, 80)}.`;
    } else if (prevDone.length > 1) {
      lastPart = `Last cycle completed ${prevDone.length} tasks, including ${humanizeTask(prevDone[0].title, 65)}.`;
    } else if (prevEnd && prevEnd.exit !== 'ok' && prevEnd.exit !== 'interrupted') {
      lastPart = `Last cycle ended with ${String(prevEnd.exit).replace('_', ' ')}.`;
    } else if (prevEnd) {
      lastPart = `Last cycle wrapped up cleanly.`;
    }
  }

  // Current cycle / state summary
  const curMs = milestones.find((m) => m.current);
  const msLabel = curMs ? (curMs.title ? `${curMs.title} (${curMs.id})` : curMs.id) : null;
  const doing = cards.filter((c) => c.column === 'doing');
  const review = cards.filter((c) => c.column === 'review');
  const pausedMs = milestones.filter((m) => m.paused_for_user);

  let currentPart: string | null = null;
  if (state === 'done') {
    const doneEv = events.findLast((e) => e.type === 'done' && typeof e.text === 'string');
    currentPart = doneEv ? humanizeTask(String(doneEv.text), 110) : 'All checks passed and the goal is finished.';
  } else if (state === 'needs_input') {
    currentPart = `Paused and waiting for you: ${status?.needs?.reason ?? 'input needed'}.`;
  } else if (state === 'running' || state === 'pausing') {
    if (doing.length === 1) {
      currentPart = `Now working on ${humanizeTask(doing[0].title, 85)}${msLabel ? ` for ${msLabel}` : ''}.`;
    } else if (doing.length > 1) {
      currentPart = `Now working on ${doing.length} tasks${msLabel ? ` for ${msLabel}` : ''}, led by ${humanizeTask(doing[0].title, 65)}.`;
    } else if (review.length > 0) {
      currentPart = `Currently verifying ${review.length === 1 ? humanizeTask(review[0].title, 75) : `${review.length} completed tasks`}.`;
    } else {
      currentPart = `Currently planning and preparing the next step${msLabel ? ` for ${msLabel}` : ''}.`;
    }
  } else if (state === 'waiting') {
    currentPart = `Starting the next cycle shortly${msLabel ? ` on ${msLabel}` : ''}.`;
  } else if (state === 'rate_limited') {
    currentPart = 'Waiting for the usage limit to reset before continuing.';
  } else if (state === 'paused' || state === 'stopped') {
    currentPart = `Paused${msLabel ? ` during ${msLabel}` : ''}; ready to resume whenever you are.`;
  } else if (pausedMs.length > 0) {
    currentPart = `${pausedMs.map((m) => m.title || m.id).join(', ')} waiting on your input.`;
  }

  const combined = [lastPart, currentPart].filter(Boolean).join(' ');
  if (!combined) return null;
  return { summary: combined, last_cycle: lastPart, current: currentPart, source: 'synthesized' };
}
