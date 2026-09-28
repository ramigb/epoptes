// Feedback is an append-only operation log; an item's current state is the fold of its lines.
import fs from 'node:fs';
import { appendJsonl, nowIso, readJsonl, withLock, writeText } from './fsx.ts';
import type { GoalPaths } from './paths.ts';

export const STATUSES = ['new', 'seen', 'in_progress', 'done', 'blocked', 'wont_do'] as const;
export type FeedbackStatus = (typeof STATUSES)[number];
export type By = 'orchestrator' | 'user';

export type FeedbackOp =
  | { ts: string; op: 'add'; id: string; text: string; src: 'dashboard' | 'cli' | 'file' }
  | { ts: string; op: 'status'; id: string; status: FeedbackStatus; by: By; cycle?: number | null; note?: string }
  | { ts: string; op: 'note'; id: string; text: string; by: By; cycle?: number | null };

export interface FeedbackItem {
  id: string;
  text: string;
  src: string;
  status: FeedbackStatus;
  created_at: string;
  updated_at: string;
  history: FeedbackOp[];
}

export function fold(ops: FeedbackOp[]): Map<string, FeedbackItem> {
  const items = new Map<string, FeedbackItem>();
  for (const op of ops) {
    if (op.op === 'add') {
      if (!items.has(op.id)) items.set(op.id, { id: op.id, text: op.text, src: op.src, status: 'new', created_at: op.ts, updated_at: op.ts, history: [op] });
      continue;
    }
    const it = items.get(op.id);
    if (!it) continue;
    it.history.push(op);
    it.updated_at = op.ts;
    if (op.op === 'status') it.status = op.status;
  }
  return items;
}

export const readFeedback = (p: GoalPaths) => fold(readJsonl<FeedbackOp>(p.feedback));

const idNum = (id: string) => Number(id.slice(2)) || 0;

function addLocked(p: GoalPaths, text: string, src: 'dashboard' | 'cli' | 'file'): string {
  const ops = readJsonl<FeedbackOp>(p.feedback);
  const next = ops.reduce((m, o) => Math.max(m, idNum(o.id)), 0) + 1;
  const id = `F-${next}`;
  appendJsonl(p.feedback, { ts: nowIso(), op: 'add', id, text, src });
  return id;
}

export function addFeedback(p: GoalPaths, text: string, src: 'dashboard' | 'cli' | 'file'): string {
  text = text.trim();
  if (!text) throw new Error('feedback text is empty');
  return withLock(p.feedbackLock, () => addLocked(p, text, src));
}

export function setFeedbackStatus(p: GoalPaths, id: string, status: FeedbackStatus, by: By, cycle: number | null, note?: string) {
  if (!STATUSES.includes(status)) throw new Error(`unknown status "${status}" (use ${STATUSES.join(', ')})`);
  if (!readFeedback(p).has(id)) throw new Error(`no feedback item ${id}`);
  appendJsonl(p.feedback, { ts: nowIso(), op: 'status', id, status, by, cycle, ...(note ? { note } : {}) });
}

export function noteFeedback(p: GoalPaths, id: string, text: string, by: By, cycle: number | null) {
  if (!readFeedback(p).has(id)) throw new Error(`no feedback item ${id}`);
  appendJsonl(p.feedback, { ts: nowIso(), op: 'note', id, text, by, cycle });
}

const BULLET = /^(\s*[-*]\s+)(.*\S)\s*$/;
const MARKED = /→\s*F-\d+\s*$/;

/**
 * Moves new bullets from FEEDBACK.md into feedback.jsonl and marks each one `→ F-<n>`.
 * Returns the new ids. Costs no model tokens.
 */
export function ingestInbox(p: GoalPaths): string[] {
  if (!fs.existsSync(p.inbox)) return [];
  return withLock(p.feedbackLock, () => {
    const lines = fs.readFileSync(p.inbox, 'utf8').split('\n');
    const ids: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = BULLET.exec(lines[i]);
      if (!m || MARKED.test(m[2])) continue;
      const id = addLocked(p, m[2], 'file');
      lines[i] = `${m[1]}${m[2]} → ${id}`;
      ids.push(id);
    }
    if (ids.length) writeText(p.inbox, lines.join('\n'));
    return ids;
  });
}
