// Read-only views over a goal's files, shared by `epoptes status` and (later) the dashboard and reports.
import fs from 'node:fs';
import path from 'node:path';
import type { CycleResult } from './adapters/types.ts';
import { readEvents } from './events.ts';
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
