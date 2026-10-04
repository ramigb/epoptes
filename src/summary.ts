// Read-only views over a goal's files, shared by `epoptes status` and (later) the dashboard and reports.
import fs from 'node:fs';
import path from 'node:path';
import type { CycleResult } from './adapters/types.ts';
import { readEvents, type EpoptesEvent } from './events.ts';
import { readJson } from './fsx.ts';
import type { Goal } from './goal.ts';
import type { GoalPaths } from './paths.ts';

export interface BacklogCounts {
  todo: number;
  doing: number;
  done: number;
  blocked: number;
  cut: number;
  milestone: string | null;
}

/** Counts task markers in state/backlog.md: `- [ ]`, `[~]`, `[x]`, `[blocked: …]`, `[cut]`. */
export function backlogCounts(p: GoalPaths): BacklogCounts | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(p.state, 'backlog.md'), 'utf8');
  } catch {
    return null;
  }
  const c: BacklogCounts = { todo: 0, doing: 0, done: 0, blocked: 0, cut: 0, milestone: null };
  for (const line of text.split('\n')) {
    const m = /^\s*[-*]\s+\[([^\]]*)\]/.exec(line);
    if (m) {
      const mark = m[1].trim().toLowerCase();
      if (mark === '') c.todo++;
      else if (mark === '~') c.doing++;
      else if (mark === 'x') c.done++;
      else if (mark.startsWith('blocked')) c.blocked++;
      else if (mark === 'cut') c.cut++;
    }
    const ms = /\*\*Current milestone:\s*([^*]+)\*\*/.exec(line);
    if (ms && !c.milestone) c.milestone = ms[1].trim();
  }
  return c;
}

export interface Milestone {
  id: string;
  title: string;
  /** planned active time by which it should be done (the heading's "(target h:mm)"), or null */
  target_s: number | null;
  todo: number;
  doing: number;
  done: number;
  blocked: number;
  cut: number;
  current: boolean;
}

const MILESTONE_HEADING = /^#{2,3}\s+(M\d+[a-z]?)\b\s*[·:—–-]?\s*(.*?)\s*$/i;
const TARGET = /\(target\s+(\d+):(\d{2})\)/i;

/**
 * Milestones from state/backlog.md headings like `## M2 · Templates (target 1:20)`, with the task markers under
 * each. Any other heading (Feedback, Review fixes) ends the milestone above it.
 */
export function backlogMilestones(p: GoalPaths): Milestone[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(p.state, 'backlog.md'), 'utf8');
  } catch {
    return [];
  }
  const out: Milestone[] = [];
  let cur: Milestone | null = null;
  let current: string | null = null;
  for (const line of text.split('\n')) {
    const ms = /\*\*Current milestone:\s*([^*]+)\*\*/.exec(line);
    if (ms && !current) current = ms[1].trim().split(/[\s·:]/)[0];
    if (/^#{1,3}\s/.test(line)) {
      const h = MILESTONE_HEADING.exec(line);
      if (h) {
        const t = TARGET.exec(h[2]);
        cur = { id: h[1].toUpperCase(), title: h[2].replace(TARGET, '').trim(), target_s: t ? Number(t[1]) * 3600 + Number(t[2]) * 60 : null, todo: 0, doing: 0, done: 0, blocked: 0, cut: 0, current: false };
        out.push(cur);
      } else cur = null;
      continue;
    }
    const m = /^\s*[-*]\s+\[([^\]]*)\]/.exec(line);
    if (!m || !cur) continue;
    const mark = m[1].trim().toLowerCase();
    if (mark === '') cur.todo++;
    else if (mark === '~') cur.doing++;
    else if (mark === 'x') cur.done++;
    else if (mark.startsWith('blocked')) cur.blocked++;
    else if (mark === 'cut') cur.cut++;
  }
  for (const m of out) m.current = m.id === current?.toUpperCase();
  return out;
}

export type ReachedMilestone = Milestone & { reached: { at: string; run: string | null; active_s: number | null } | null };

/** Backlog milestones, each with when it was reached (its latest `milestone` event naming it, e.g. "M2: …"). */
export function milestonesWithReach(p: GoalPaths, events: EpoptesEvent[], run: string | null): ReachedMilestone[] {
  return backlogMilestones(p).map((m) => {
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

export interface BacklogItem {
  mark: 'todo' | 'doing' | 'done' | 'blocked' | 'cut';
  text: string;
}

/** Task lines of state/backlog.md, in file order. */
export function backlogItems(p: GoalPaths): BacklogItem[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(p.state, 'backlog.md'), 'utf8');
  } catch {
    return [];
  }
  const out: BacklogItem[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*[-*]\s+\[([^\]]*)\]\s*(.*)$/.exec(line);
    if (!m) continue;
    const mark = m[1].trim().toLowerCase();
    const kind = mark === '' ? 'todo' : mark === '~' ? 'doing' : mark === 'x' ? 'done' : mark.startsWith('blocked') ? 'blocked' : mark === 'cut' ? 'cut' : null;
    if (kind) out.push({ mark: kind, text: kind === 'blocked' && m[1].includes(':') ? `${m[2]} (${m[1].split(':').slice(1).join(':').trim()})` : m[2] });
  }
  return out;
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

/** `R-3 [low] …` / `R-4 [med] …`: review polish that never holds a goal open. */
const MINOR_FIX = /^R-\d+\s+\[(low|med)\]/i;

/**
 * What's left to do in the backlog: open tasks (todo or in progress) that aren't `low`/`med` review fixes, and
 * blocked ones. Null when there's no backlog or it has no tasks at all (nothing to judge by).
 */
export function openWork(p: GoalPaths): { open: number; blocked: number; minor: number } | null {
  const items = backlogItems(p);
  if (!items.length) return null;
  const live = items.filter((t) => t.mark === 'todo' || t.mark === 'doing');
  const minor = live.filter((t) => MINOR_FIX.test(t.text)).length;
  return { open: live.length - minor, blocked: items.filter((t) => t.mark === 'blocked').length, minor };
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
