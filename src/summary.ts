// Read-only views over a goal's files, shared by `epoptes status` and (later) the dashboard and reports.
import fs from 'node:fs';
import path from 'node:path';
import type { CycleResult } from './adapters/types.ts';
import { readJson } from './fsx.ts';
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
