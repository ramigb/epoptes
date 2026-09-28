// JSON views the dashboard renders. Built only from the goal's files (via a GoalWatch's caches).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CycleResult } from '../adapters/types.ts';
import { clockState, readClock, runFinished } from '../clock.ts';
import { fold } from '../feedback.ts';
import { exists, nowIso, readJson, readJsonl, writeJson } from '../fsx.ts';
import { loadGoal, type Goal } from '../goal.ts';
import { epoptesHome } from '../paths.ts';
import { LIVE_STATES } from '../status.ts';
import { backlogCounts, backlogItems } from '../summary.ts';
import type { GoalWatch } from './watch.ts';

type Result = CycleResult & { version: 1; cycle: number; run: string };

// ---------- read cursors for unread badges (~/.epoptes/ui.json) ----------

interface Seen {
  feedback_at: string;
  events_at: string;
}
const uiFile = () => path.join(epoptesHome(), 'ui.json');

export function readSeen(id: string): Seen {
  const ui = readJson<{ version: 1; seen: Record<string, Seen> }>(uiFile()) ?? { version: 1, seen: {} };
  if (!ui.seen[id]) {
    // First sight of a goal: start from now rather than flagging its whole history.
    ui.seen[id] = { feedback_at: nowIso(), events_at: nowIso() };
    writeJson(uiFile(), ui);
  }
  return ui.seen[id];
}

export function markSeen(id: string) {
  const ui = readJson<{ version: 1; seen: Record<string, Seen> }>(uiFile()) ?? { version: 1, seen: {} };
  ui.seen[id] = { feedback_at: nowIso(), events_at: nowIso() };
  writeJson(uiFile(), ui);
}

/** Event types that count as unread and raise toasts. */
export const NOTABLE = ['milestone', 'blocked', 'done', 'warn', 'run.end'];

// ---------- cycle results (immutable once written, so cached) ----------

const resultCache = new Map<string, Result>();

export function cycleResults(w: GoalWatch): Result[] {
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(w.p.cycles).filter((d) => /^\d{6}$/.test(d)).sort();
  } catch {
    return [];
  }
  const out: Result[] = [];
  for (const d of dirs) {
    const file = path.join(w.p.cycles, d, 'result.json');
    let r = resultCache.get(file);
    if (!r) {
      r = readJson<Result>(file) ?? undefined;
      if (r) resultCache.set(file, r);
    }
    if (r) out.push(r);
  }
  return out;
}

// ---------- commits / snapshots (cached per cycle) ----------

const commitCache = new Map<string, { key: string; list: { hash: string; at: string; subject: string }[] }>();

function commits(w: GoalWatch, goal: Goal) {
  const key = `${goal.checkpoints}:${w.status?.cycle}:${w.status?.state}`;
  const hit = commitCache.get(w.id);
  if (hit?.key === key) return hit.list;
  let list: { hash: string; at: string; subject: string }[] = [];
  const args = ['log', '-n', '15', '--format=%h%x09%cI%x09%s'];
  try {
    let out = '';
    if (goal.checkpoints === 'git') out = execFileSync('git', ['-C', w.p.project, ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 5000 });
    else if (goal.checkpoints === 'shadow' && exists(w.p.snapshots)) out = execFileSync('git', ['--git-dir', w.p.snapshots, ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 5000 });
    list = out.trim().split('\n').filter(Boolean).map((l) => {
      const [hash, at, ...s] = l.split('\t');
      return { hash, at, subject: s.join('\t') };
    });
  } catch {
    // not a repo yet
  }
  commitCache.set(w.id, { key, list });
  return list;
}

// ---------- views ----------

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function summary(w: GoalWatch) {
  const p = w.p;
  let goal: Goal;
  try {
    goal = loadGoal(p);
  } catch (e) {
    return { id: w.id, path: p.project, error: (e as Error).message };
  }
  const s = w.status;
  const c = readClock(p);
  const cs = c ? clockState(c, { wrapupMarker: exists(p.wrapup) }) : null;
  const results = cycleResults(w);
  const seen = readSeen(w.id);
  const cycleEvents = w.events.items.filter((e) => e.cycle === s?.cycle);
  const round = cycleEvents.findLast((e) => e.type === 'round')?.n ?? null;
  return {
    id: w.id,
    name: goal.name,
    kind: goal.kind,
    objective: goal.objective,
    path: p.project,
    state: s?.state ?? 'idle',
    live: s ? LIVE_STATES.includes(s.state) : false,
    pid: s?.pid ?? null,
    run: s?.run ?? null,
    cycle: s?.cycle ?? 0,
    round,
    mode: s?.mode ?? null,
    // The runner only notices control.json on its heartbeat; show the request right away.
    pause_requested: Boolean(s?.pause_requested || (s && LIVE_STATES.includes(s.state) && readJson<{ pause_after_cycle?: boolean }>(p.control)?.pause_after_cycle)),
    waiting_until: s?.waiting_until ?? null,
    wait_reason: s?.wait_reason ?? null,
    cycle_started_at: s?.cycle_started_at ?? null,
    heartbeat_at: s?.heartbeat_at ?? null,
    limits: s?.limits ?? null,
    done_marker: exists(p.done),
    run_finished: runFinished(p),
    wrapup_marker: exists(p.wrapup),
    clock: c && cs ? { active: cs.active, timebox_s: c.timebox_s, wrapup_s: c.wrapup_s, grace_s: c.grace_s, to_end: cs.toEnd, paused: Boolean(c.paused_at), clock_mode: cs.mode } : null,
    backlog: backlogCounts(p),
    cycles: results.length,
    cost_usd: results.reduce((a, r) => a + (r.cost_usd ?? 0), 0),
    cost_basis: results.some((r) => r.cost_basis === 'estimate') || !results.length ? 'estimate' : 'billed',
    last_exit: results.at(-1)?.exit ?? null,
    notify: goal.notify,
    unread: {
      feedback: w.feedback.items.filter((o) => o.op !== 'add' && o.by === 'orchestrator' && o.ts > seen.feedback_at).length,
      events: w.events.items.filter((e) => NOTABLE.includes(e.type) && e.ts > seen.events_at).length,
    },
  };
}

export function detail(w: GoalWatch) {
  const base = summary(w);
  if ('error' in base) return base;
  const p = w.p;
  const goal = loadGoal(p);
  const results = cycleResults(w);
  const costs = results.map((r) => r.cost_usd ?? 0).filter((x) => x > 0);
  const med = median(costs);
  const read = (f: string) => {
    try {
      return fs.readFileSync(path.join(p.state, f), 'utf8');
    } catch {
      return null;
    }
  };
  const activityCycle = w.activityCycle;
  return {
    ...base,
    goal: { objective: goal.objective, done: goal.done, non_goals: goal.non_goals, approval_required: goal.approval_required, timebox: goal.timebox, checkpoints: goal.checkpoints, adapter: goal.adapter, cycle: goal.cycle },
    seen: readSeen(w.id),
    handoff: read('handoff.md'),
    backlog_items: backlogItems(p),
    feedback: [...fold(w.feedback.items).values()].reverse(),
    events: w.events.items.slice(-500),
    cycles_detail: results.map((r) => ({ ...r, flagged: results.length >= 3 && med > 0 && (r.cost_usd ?? 0) > 2 * med })),
    cost_median: med,
    activity_cycle: activityCycle,
    activity: w.activity.items.slice(-200),
    commits: commits(w, goal),
  };
}

export function cycleView(w: GoalWatch, n: number) {
  const dir = w.p.cycleDir(n);
  const activity = readJsonl(path.join(dir, 'activity.jsonl'));
  return { cycle: n, result: readJson(path.join(dir, 'result.json')), activity: activity.slice(-300), activity_total: activity.length };
}
