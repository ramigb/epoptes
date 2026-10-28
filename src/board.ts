// The board: every piece of work is a card, the human's feedback included. One board per harness; each job is an
// epic. Like events, an append-only op log (board.jsonl); a card's state is the fold of its lines.
import fs from 'node:fs';
import path from 'node:path';
import { readEvents } from './events.ts';
import { appendJsonl, exists, nowIso, readJson, readJsonl, withLock, writeText } from './fsx.ts';
import type { Goal } from './goal.ts';
import { inJob, jobsOf } from './jobs.ts';
import type { GoalPaths } from './paths.ts';

/** `backlog` holds what nobody has triaged yet (the human's feedback, agent notes); the other four are the board. */
export const COLUMNS = ['backlog', 'todo', 'doing', 'review', 'done'] as const;
export type Column = (typeof COLUMNS)[number];
export const PRIORITIES = ['high', 'med', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];
export type Src = 'dashboard' | 'cli' | 'file' | 'orchestrator';
/** `user` is the human; anything else is the orchestrator or the role acting for it (`--as worker`). */
export type By = string;
export type Decision = 'approved' | 'rejected';
/** After DONE: `tweak` = do it in place in a follow-up; `new_run` = needs a new run; `auto` = the agent triages it. */
export type Scope = 'auto' | 'tweak' | 'new_run';
export const SCOPES: Scope[] = ['auto', 'tweak', 'new_run'];

export interface Fields {
  title?: string;
  column?: Column;
  epic?: string;
  milestone?: string | null;
  assignee?: string | null;
  priority?: Priority | null;
  /** why it can't move on; null clears it */
  blocked?: string | null;
  /** with column `done`: dropped rather than done, and why. Any other move clears it. */
  cut?: string | null;
  scope?: Scope;
}
const FIELDS = ['title', 'column', 'epic', 'milestone', 'assignee', 'priority', 'blocked', 'cut', 'scope'] as const;

export type BoardOp =
  | ({ ts: string; op: 'add'; id: string; title: string; src: Src; epic: string; column: Column; cycle?: number | null; steer?: boolean } & Pick<Fields, 'milestone' | 'assignee' | 'priority'>)
  | ({ ts: string; op: 'set'; id: string; by: By; cycle?: number | null } & Fields)
  | { ts: string; op: 'comment'; id: string; text: string; by: By; cycle?: number | null; steer?: boolean }
  | { ts: string; op: 'ask'; id: string; text: string; by: By; cycle?: number | null }
  | { ts: string; op: 'decide'; id: string; decision: Decision; by: By; note?: string }
  | { ts: string; op: 'milestone'; id: string; epic: string; title: string; target_s: number | null };

export interface Comment {
  ts: string;
  by: By;
  text: string;
  cycle: number | null;
  steer: boolean;
}

export interface Card {
  id: string;
  title: string;
  src: Src;
  epic: string;
  column: Column;
  milestone: string | null;
  assignee: string | null;
  priority: Priority | null;
  blocked: string | null;
  cut: string | null;
  steer: boolean;
  scope: Scope;
  /** the orchestrator asks the human before doing something on the approval list; blocked until answered */
  approval: { text: string; decision: Decision | null; note: string | null } | null;
  comments: Comment[];
  /** the human added it, commented or answered its approval, and no agent has acted on the card since */
  waiting: boolean;
  /** ...and asked to steer: interrupt and replan around it first */
  steering: boolean;
  /** the last cycle that touched it */
  cycle: number | null;
  created_at: string;
  updated_at: string;
}

export interface MilestoneDef {
  id: string;
  epic: string;
  title: string;
  target_s: number | null;
}

export interface Board {
  cards: Map<string, Card>;
  milestones: MilestoneDef[];
}

export function fold(ops: BoardOp[]): Board {
  const cards = new Map<string, Card>();
  const milestones: MilestoneDef[] = [];
  for (const op of ops) {
    if (op.op === 'milestone') {
      const m = milestones.find((x) => x.id === op.id && x.epic === op.epic);
      if (m) Object.assign(m, { title: op.title, target_s: op.target_s });
      else milestones.push({ id: op.id, epic: op.epic, title: op.title, target_s: op.target_s });
      continue;
    }
    if (op.op === 'add') {
      const human = op.src !== 'orchestrator';
      if (!cards.has(op.id)) cards.set(op.id, { id: op.id, title: op.title, src: op.src, epic: op.epic, column: op.column, milestone: op.milestone ?? null, assignee: op.assignee ?? null, priority: op.priority ?? null, blocked: null, cut: null, steer: op.steer === true, scope: 'auto', approval: null, comments: [], waiting: human, steering: human && op.steer === true, cycle: op.cycle ?? null, created_at: op.ts, updated_at: op.ts });
      continue;
    }
    const c = cards.get(op.id);
    if (!c) continue;
    c.updated_at = op.ts;
    if ('cycle' in op && op.cycle) c.cycle = op.cycle;
    if (op.op === 'set') {
      for (const k of FIELDS) if (k in op) (c as any)[k] = op[k] ?? null;
      if (op.column && !('cut' in op)) c.cut = null;
    } else if (op.op === 'comment') c.comments.push({ ts: op.ts, by: op.by, text: op.text, cycle: op.cycle ?? null, steer: op.steer === true });
    else if (op.op === 'ask') c.approval = { text: op.text, decision: null, note: null };
    else if (op.op === 'decide' && c.approval) {
      c.approval.decision = op.decision;
      c.approval.note = op.note ?? null;
      c.comments.push({ ts: op.ts, by: op.by, text: `${op.decision}${op.note ? `: ${op.note}` : ''}`, cycle: null, steer: false });
    }
    // Whose turn it is: the human's comment or answer waits for an agent; any agent op on the card answers it, and
    // so does the human closing it themselves.
    if (op.by !== 'user' || (op.op === 'set' && op.column === 'done')) c.waiting = c.steering = false;
    else if (op.op === 'comment' || op.op === 'decide') {
      c.steering = (c.waiting && c.steering) || (op.op === 'comment' && op.steer === true);
      c.waiting = true;
    }
  }
  return { cards, milestones };
}

export const isOpen = (c: Card) => c.column !== 'done';
export const isBlocked = (c: Card) => Boolean(c.blocked) || Boolean(c.approval && !c.approval.decision);
export const isAgentNote = (c: Card) => c.src === 'orchestrator' && c.column === 'backlog';

/** Approvals the human hasn't answered yet. */
export const pendingApprovals = (cards: Card[]) => cards.filter((c) => c.approval && !c.approval.decision && isOpen(c));

/** Cards the human is steering with, not yet picked up: the next cycle replans around them first. */
export const pendingSteers = (cards: Card[]) => cards.filter((c) => c.steering);

/** What the human last asked on a card: its newest comment if that's theirs, else the card itself. */
export const lastAsk = (c: Card) => {
  const last = c.comments.at(-1);
  return last?.by === 'user' ? last.text : c.title;
};

/**
 * What a follow-up run handles: the human's open cards and every card with a human comment waiting, minus cards
 * marked `new_run`, blocked ones (e.g. flagged for a new run) and unanswered approvals.
 */
export const followUpCards = (cards: Card[]) =>
  cards.filter((c) => (c.waiting || (c.src !== 'orchestrator' && isOpen(c) && !c.blocked)) && c.scope !== 'new_run' && !(c.approval && !c.approval.decision));

/**
 * What's left to do: open cards (todo, doing, review) that aren't blocked or `low`/`med` priority, blocked ones,
 * untriaged backlog cards and cards waiting for a reply. Null when there are no cards at all (nothing to judge by).
 */
export function openWork(cards: Card[]) {
  if (!cards.length) return null;
  const live = cards.filter((c) => ['todo', 'doing', 'review'].includes(c.column) && !isBlocked(c));
  const minor = live.filter((c) => c.priority === 'low' || c.priority === 'med').length;
  return {
    open: live.length - minor,
    blocked: cards.filter((c) => isOpen(c) && isBlocked(c)).length,
    minor,
    untriaged: cards.filter((c) => c.column === 'backlog' && !isBlocked(c)).length,
    waiting: cards.filter((c) => c.waiting).length,
  };
}

export interface BoardCounts {
  backlog: number;
  todo: number;
  doing: number;
  review: number;
  done: number;
  blocked: number;
  cut: number;
  milestone: string | null;
}

/** Cards by column; blocked and cut cards count only as such. */
export function boardCounts(cards: Card[], milestones: Milestone[]): BoardCounts {
  const n: BoardCounts = { backlog: 0, todo: 0, doing: 0, review: 0, done: 0, blocked: 0, cut: 0, milestone: milestones.find((m) => m.current)?.id ?? null };
  for (const c of cards) n[c.cut ? 'cut' : isOpen(c) && isBlocked(c) ? 'blocked' : c.column]++;
  return n;
}

export interface Milestone {
  id: string;
  title: string;
  /** planned active time by which it should be done, or null */
  target_s: number | null;
  todo: number;
  doing: number;
  done: number;
  blocked: number;
  cut: number;
  current: boolean;
}

/**
 * One epic's milestones in the order they were added (plus any a card names without one), with their cards
 * counted: review counts as doing, backlog as todo. The current one is the first with work left (or no cards yet).
 */
export function boardMilestones(board: Board, epic: string): Milestone[] {
  const cards = [...board.cards.values()].filter((c) => c.epic === epic);
  const defs = board.milestones.filter((m) => m.epic === epic);
  for (const c of cards) if (c.milestone && !defs.some((d) => d.id === c.milestone)) defs.push({ id: c.milestone, epic, title: '', target_s: null });
  const out = defs.map((d): Milestone => {
    const m = { id: d.id, title: d.title, target_s: d.target_s, todo: 0, doing: 0, done: 0, blocked: 0, cut: 0, current: false };
    for (const c of cards.filter((x) => x.milestone === d.id)) m[c.cut ? 'cut' : c.column === 'done' ? 'done' : isBlocked(c) ? 'blocked' : c.column === 'backlog' || c.column === 'todo' ? 'todo' : 'doing']++;
    return m;
  });
  const cur = out.find((m) => m.todo + m.doing > 0 || m.todo + m.doing + m.done + m.blocked + m.cut === 0);
  if (cur) cur.current = true;
  return out;
}

// ---------------------------------------------------------------- reading

/** The current job's id: new cards go into its epic. Reads goal.json without validating it (cheap inside cycles). */
export function currentEpic(p: GoalPaths): string {
  const goal = readJson<Goal>(p.goal);
  if (!goal) throw new Error(`no goal at ${p.goal}`);
  return jobsOf(readEvents(p), goal).at(-1)!.id;
}

/** The board, after ingesting anything new (see `ingest`). */
export function readBoard(p: GoalPaths): Board {
  ingest(p);
  return fold(readJsonl<BoardOp>(p.board));
}

/** The current epic's cards: what the orchestrator works on. */
export function currentCards(p: GoalPaths, board = readBoard(p)): Card[] {
  const epic = currentEpic(p);
  return [...board.cards.values()].filter((c) => c.epic === epic);
}

function getCard(p: GoalPaths, id: string): Card {
  const c = fold(readJsonl<BoardOp>(p.board)).cards.get(id);
  if (!c) throw new Error(`no card ${id}`);
  return c;
}

// ---------------------------------------------------------------- writing

const cyc = (cycle: number | null | undefined) => (cycle ? { cycle } : {});

function checkFields(f: Fields) {
  if (f.title !== undefined && (typeof f.title !== 'string' || !f.title.trim())) throw new Error('a card needs a title');
  if (f.column !== undefined && !COLUMNS.includes(f.column)) throw new Error(`unknown column "${f.column}" (use ${COLUMNS.join(', ')})`);
  if (f.priority != null && !PRIORITIES.includes(f.priority)) throw new Error(`unknown priority "${f.priority}" (use ${PRIORITIES.join(', ')})`);
  if (f.scope !== undefined && !SCOPES.includes(f.scope)) throw new Error(`unknown scope "${f.scope}" (use ${SCOPES.join(', ')})`);
  for (const k of ['epic', 'milestone', 'assignee', 'blocked', 'cut'] as const) {
    if (f[k] != null && typeof f[k] !== 'string') throw new Error(`${k} must be text`);
  }
  if (f.milestone) f.milestone = f.milestone.toUpperCase();
}

const maxId = (ops: BoardOp[]) => ops.reduce((m, o) => (o.op === 'add' && /^C-\d+$/.test(o.id) ? Math.max(m, Number(o.id.slice(2))) : m), 0);

export interface AddExtra {
  column?: Column;
  epic?: string;
  milestone?: string | null;
  assignee?: string | null;
  priority?: Priority | null;
  steer?: boolean;
  cycle?: number | null;
}

/** A new card, by default untriaged in the backlog of the current epic. */
export function addCard(p: GoalPaths, title: string, src: Src, extra: AddExtra = {}): string {
  title = title.trim();
  const { steer, cycle, ...fields } = extra;
  checkFields({ title, ...fields });
  const epic = fields.epic ?? currentEpic(p);
  return withLock(p.boardLock, () => {
    const id = `C-${maxId(readJsonl<BoardOp>(p.board)) + 1}`;
    const opt = Object.fromEntries(Object.entries({ milestone: fields.milestone, assignee: fields.assignee, priority: fields.priority }).filter(([, v]) => v));
    appendJsonl(p.board, { ts: nowIso(), op: 'add', id, title, src, epic, column: fields.column ?? 'backlog', ...opt, ...cyc(cycle), ...(steer ? { steer: true } : {}) });
    return id;
  });
}

/** Moves or changes a card. */
export function setCard(p: GoalPaths, id: string, fields: Fields, by: By, cycle: number | null = null) {
  checkFields(fields);
  if (!Object.keys(fields).length) throw new Error('nothing to change');
  getCard(p, id);
  appendJsonl(p.board, { ts: nowIso(), op: 'set', id, by, ...cyc(cycle), ...fields });
}

/** A comment. The human's comment on a finished card reopens it (to TODO), so an agent looks at it again. */
export function commentCard(p: GoalPaths, id: string, text: string, by: By, cycle: number | null = null, steer = false) {
  text = text.trim();
  if (!text) throw new Error('the comment is empty');
  const c = getCard(p, id);
  const ts = nowIso();
  appendJsonl(p.board, { ts, op: 'comment', id, text, by, ...cyc(cycle), ...(steer ? { steer: true } : {}) });
  if (by === 'user' && c.column === 'done') appendJsonl(p.board, { ts, op: 'set', id, by, column: 'todo' });
}

/**
 * The orchestrator asks the human before doing something on the approval list. The approval goes on the card it
 * gates (`ref`); without one, or when `ref` isn't a card (an old-style task id), it gets a new TODO card.
 */
export function askApproval(p: GoalPaths, text: string, ref: string | undefined, by: By, cycle: number | null): string {
  text = text.trim();
  if (!text) throw new Error('say what needs approval');
  const known = ref && fold(readJsonl<BoardOp>(p.board)).cards.has(ref);
  const id = known ? ref : addCard(p, ref ? `${ref}: ${text}` : text, 'orchestrator', { column: 'todo', cycle });
  appendJsonl(p.board, { ts: nowIso(), op: 'ask', id, text, by, ...cyc(cycle) });
  return id;
}

/** The human's answer to an approval; the card waits for the next cycle to act on it. */
export function decide(p: GoalPaths, id: string, decision: Decision, note?: string) {
  const c = getCard(p, id);
  if (!c.approval) throw new Error(`${id} has no approval request`);
  appendJsonl(p.board, { ts: nowIso(), op: 'decide', id, decision, by: 'user', ...(note ? { note } : {}) });
}

const TARGET_HM = /^(\d+):(\d{2})$/;

/** Adds or renames a milestone of the current epic; `target` is active time from the start of a run, "h:mm". */
export function addMilestone(p: GoalPaths, id: string, title: string, target?: string) {
  id = id.toUpperCase();
  if (!/^M\d+[A-Z]?$/.test(id)) throw new Error(`a milestone id looks like M1, M2, M2B (got "${id}")`);
  const t = target ? TARGET_HM.exec(target) : null;
  if (target && !t) throw new Error(`target is h:mm, e.g. 1:20 (got "${target}")`);
  appendJsonl(p.board, { ts: nowIso(), op: 'milestone', id, epic: currentEpic(p), title: title.trim(), target_s: t ? Number(t[1]) * 3600 + Number(t[2]) * 60 : null });
}

// ---------------------------------------------------------------- ingest

const MILESTONE_HEADING = /^#{2,3}\s+(M\d+[a-z]?)\b\s*[·:—–-]?\s*(.*?)\s*$/i;
const TARGET = /\(target\s+(\d+):(\d{2})\)/i;
const MARK: Record<string, Fields> = { '': { column: 'todo' }, '~': { column: 'doing' }, x: { column: 'done' }, cut: { column: 'done', cut: 'cut' } };

/**
 * A backlog.md (the seed format the skill writes, and the format before the board) as ops: `## M<n> · title
 * (target h:mm)` headings become milestones, task lines cards in the column their marker says. A line naming a
 * feedback card that exists (`F-3 …`) moves that card instead of adding one.
 */
function fromBacklog(text: string, epic: string, ts: string, next: () => string, known: Set<string>): BoardOp[] {
  const ops: BoardOp[] = [];
  let milestone: string | null = null;
  for (const line of text.split('\n')) {
    if (/^#{1,3}\s/.test(line)) {
      const h = MILESTONE_HEADING.exec(line);
      milestone = h ? h[1].toUpperCase() : null;
      const t = h && TARGET.exec(h[2]);
      if (h) ops.push({ ts, op: 'milestone', id: milestone!, epic, title: h[2].replace(TARGET, '').trim(), target_s: t ? Number(t[1]) * 3600 + Number(t[2]) * 60 : null });
      continue;
    }
    const m = /^\s*[-*]\s+\[([^\]]*)\]\s*(.*\S)/.exec(line);
    if (!m || m[2].includes('{{')) continue;
    const mark = m[1].trim().toLowerCase();
    const fields: Fields | undefined = mark.startsWith('blocked') ? { column: 'todo', blocked: m[1].split(':').slice(1).join(':').trim() || 'blocked' } : MARK[mark];
    if (!fields) continue;
    const fid = /^(F-\d+)\b/.exec(m[2])?.[1];
    if (fid && known.has(fid)) {
      ops.push({ ts, op: 'set', id: fid, by: 'orchestrator', ...fields });
      continue;
    }
    const id = next();
    const priority = /^R-\d+\s+\[(high|med|low)\]/i.exec(m[2])?.[1].toLowerCase() as Priority | undefined;
    ops.push({ ts, op: 'add', id, title: m[2], src: 'orchestrator', epic, column: fields.column!, ...(milestone ? { milestone } : {}), ...(priority ? { priority } : {}) });
    if (fields.blocked || fields.cut) ops.push({ ts, op: 'set', id, by: 'orchestrator', ...fields });
  }
  return ops;
}

/** One line of the feedback.jsonl from before the board, as ops. Feedback ids (F-<n>) stay the card ids. */
function fromFeedback(o: any, epicAt: (ts: string) => string): BoardOp[] {
  const base = { ts: o.ts, id: o.id };
  const by = o.by ?? 'user';
  const note = (text: string | undefined) => (text ? [{ ...base, op: 'comment' as const, text, by, cycle: o.cycle ?? null }] : []);
  const MOVE: Record<string, Fields> = { new: { column: 'backlog' }, seen: { column: 'todo' }, in_progress: { column: 'doing' }, done: { column: 'done' }, wont_do: { column: 'done', cut: "won't do" } };
  switch (o.op) {
    case 'add':
      return [
        { ...base, op: 'add', title: o.text, src: o.src, epic: epicAt(o.ts), column: o.kind === 'approval' ? 'todo' : 'backlog', ...(o.steer ? { steer: true } : {}) },
        ...(o.kind === 'approval' ? [{ ...base, op: 'ask' as const, text: o.text, by: 'orchestrator' }] : []),
      ];
    case 'status':
      if (o.status === 'blocked') return [{ ...base, op: 'set', by, cycle: o.cycle ?? null, blocked: o.note || 'blocked' }];
      return [{ ...base, op: 'set', by, cycle: o.cycle ?? null, ...MOVE[o.status], blocked: null }, ...note(o.note)];
    case 'note':
      return note(o.text);
    case 'decide':
      return [{ ...base, op: 'decide', decision: o.decision, by, ...(o.note ? { note: o.note } : {}) }];
    case 'edit':
      return [{ ...base, op: 'set', by, title: o.text }];
    case 'scope':
      return [{ ...base, op: 'set', by, scope: o.scope }];
  }
  return [];
}

const BULLET = /^(\s*[-*]\s+)(.*\S)\s*$/;
const MARKED = /→\s*[A-Z]-\d+\s*$/;

/** Bullets in FEEDBACK.md not yet on the board; the next read turns each into a backlog card. */
export function pendingInbox(p: GoalPaths): string[] {
  if (!fs.existsSync(p.inbox)) return [];
  return fs.readFileSync(p.inbox, 'utf8').split('\n').flatMap((l) => {
    const m = BULLET.exec(l);
    return m && !MARKED.test(m[2]) ? [m[2]] : [];
  });
}

/**
 * Brings outside input onto the board, for no model tokens. Once, for a harness from before the board:
 * feedback.jsonl and every archived job's backlog.md. Always: a state/backlog.md (the skill seeds one; it's renamed
 * to backlog.md.imported) and new FEEDBACK.md bullets (marked `→ C-<n>`). Returns the ids of FEEDBACK.md cards.
 */
export function ingest(p: GoalPaths): string[] {
  const backlog = path.join(p.state, 'backlog.md');
  const fresh = !exists(p.board);
  if (!fresh && !exists(backlog) && !pendingInbox(p).length) return [];
  const goal = readJson<Goal>(p.goal);
  if (!goal) return [];
  return withLock(p.boardLock, () => {
    const jobs = jobsOf(readEvents(p), goal);
    const epic = jobs.at(-1)!.id;
    const ops = readJsonl<BoardOp>(p.board);
    let n = maxId(ops);
    const next = () => `C-${++n}`;
    const out: BoardOp[] = [];
    const known = () => new Set([...ops, ...out].filter((o) => o.op === 'add').map((o) => o.id));
    const read = (f: string) => (exists(f) ? fs.readFileSync(f, 'utf8') : '');
    if (fresh) {
      const epicAt = (ts: string) => jobs.find((j) => inJob(ts, j))?.id ?? epic;
      for (const o of readJsonl<any>(p.feedback)) out.push(...fromFeedback(o, epicAt));
      for (const j of jobs) if (!j.current && j.archive) out.push(...fromBacklog(read(path.join(p.root, j.archive, 'backlog.md')), j.id, j.to ?? nowIso(), next, known()));
    }
    if (exists(backlog)) out.push(...fromBacklog(read(backlog), epic, nowIso(), next, known()));
    const ids: string[] = [];
    let inbox: string[] | null = null;
    if (pendingInbox(p).length) {
      inbox = fs.readFileSync(p.inbox, 'utf8').split('\n');
      for (let i = 0; i < inbox.length; i++) {
        const m = BULLET.exec(inbox[i]);
        if (!m || MARKED.test(m[2])) continue;
        const id = next();
        out.push({ ts: nowIso(), op: 'add', id, title: m[2], src: 'file', epic, column: 'backlog' });
        inbox[i] = `${m[1]}${m[2]} → ${id}`;
        ids.push(id);
      }
    }
    if (out.length || fresh) fs.appendFileSync(p.board, out.map((o) => JSON.stringify(o) + '\n').join(''));
    if (inbox) writeText(p.inbox, inbox.join('\n'));
    if (exists(backlog)) fs.renameSync(backlog, `${backlog}.imported`);
    if (fresh && exists(p.feedback)) fs.renameSync(p.feedback, `${p.feedback}.imported`);
    return ids;
  });
}
