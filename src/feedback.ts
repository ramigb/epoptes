// Feedback is an append-only operation log; an item's current state is the fold of its lines.
import fs from 'node:fs';
import { appendJsonl, nowIso, readJsonl, withLock, writeText } from './fsx.ts';
import type { GoalPaths } from './paths.ts';

export const STATUSES = ['new', 'seen', 'in_progress', 'done', 'blocked', 'wont_do'] as const;
export type FeedbackStatus = (typeof STATUSES)[number];
export type By = 'orchestrator' | 'user';
export type Src = 'dashboard' | 'cli' | 'file' | 'orchestrator';
/** `feedback`: from the human. `approval`: the orchestrator asks before doing something on the approval list. */
export type FeedbackKind = 'feedback' | 'approval';
export type Decision = 'approved' | 'rejected';

export type FeedbackOp =
  | { ts: string; op: 'add'; id: string; text: string; src: Src; kind?: FeedbackKind; ref?: string }
  | { ts: string; op: 'status'; id: string; status: FeedbackStatus; by: By; cycle?: number | null; note?: string }
  | { ts: string; op: 'note'; id: string; text: string; by: By; cycle?: number | null }
  | { ts: string; op: 'decide'; id: string; decision: Decision; by: By; note?: string };

export interface FeedbackItem {
  id: string;
  text: string;
  src: string;
  kind: FeedbackKind;
  ref: string | null;
  status: FeedbackStatus;
  /** approvals only: the human's answer, or null while it waits */
  decision: Decision | null;
  created_at: string;
  updated_at: string;
  history: FeedbackOp[];
}

export function fold(ops: FeedbackOp[]): Map<string, FeedbackItem> {
  const items = new Map<string, FeedbackItem>();
  for (const op of ops) {
    if (op.op === 'add') {
      const kind = op.kind ?? 'feedback';
      // An approval waits for the human, so it starts blocked rather than as new work.
      if (!items.has(op.id)) items.set(op.id, { id: op.id, text: op.text, src: op.src, kind, ref: op.ref ?? null, status: kind === 'approval' ? 'blocked' : 'new', decision: null, created_at: op.ts, updated_at: op.ts, history: [op] });
      continue;
    }
    const it = items.get(op.id);
    if (!it) continue;
    it.history.push(op);
    it.updated_at = op.ts;
    if (op.op === 'status') it.status = op.status;
    if (op.op === 'decide') it.decision = op.decision;
  }
  return items;
}

export const readFeedback = (p: GoalPaths) => fold(readJsonl<FeedbackOp>(p.feedback));

const CLOSED: FeedbackStatus[] = ['done', 'wont_do'];
export const isOpen = (f: FeedbackItem) => !CLOSED.includes(f.status);

/** Approvals the human hasn't answered yet. */
export const pendingApprovals = (items: Map<string, FeedbackItem> | FeedbackItem[]) =>
  [...items.values()].filter((f) => f.kind === 'approval' && !f.decision && isOpen(f));

const idNum = (id: string) => Number(id.slice(2)) || 0;

interface AddExtra {
  kind?: FeedbackKind;
  ref?: string;
}

function addLocked(p: GoalPaths, text: string, src: Src, extra: AddExtra = {}): string {
  const ops = readJsonl<FeedbackOp>(p.feedback);
  const next = ops.reduce((m, o) => Math.max(m, idNum(o.id)), 0) + 1;
  const id = `F-${next}`;
  const kind = extra.kind && extra.kind !== 'feedback' ? { kind: extra.kind } : {};
  appendJsonl(p.feedback, { ts: nowIso(), op: 'add', id, text, src, ...kind, ...(extra.ref ? { ref: extra.ref } : {}) });
  return id;
}

export function addFeedback(p: GoalPaths, text: string, src: Src, extra: AddExtra = {}): string {
  text = text.trim();
  if (!text) throw new Error('feedback text is empty');
  return withLock(p.feedbackLock, () => addLocked(p, text, src, extra));
}

/**
 * Records the human's answer to an approval and reopens it as `new`, so the next cycle acts on it
 * (does the approved work, or cuts the task).
 */
export function decideApproval(p: GoalPaths, id: string, decision: Decision, note?: string) {
  const it = readFeedback(p).get(id);
  if (!it) throw new Error(`no feedback item ${id}`);
  if (it.kind !== 'approval') throw new Error(`${id} is not an approval request`);
  const ts = nowIso();
  appendJsonl(p.feedback, { ts, op: 'decide', id, decision, by: 'user', ...(note ? { note } : {}) });
  appendJsonl(p.feedback, { ts, op: 'status', id, status: 'new', by: 'user', cycle: null, note: `${decision}${note ? `: ${note}` : ''}` });
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
