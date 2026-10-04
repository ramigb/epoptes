// The Epoptes brain: what past harnesses taught, gathered across goals into ~/.epoptes/brain/ so the skill can
// design better ones. Deterministic and token-free: a digest per goal (numbers, automatic signals, the lessons
// orchestrators recorded with `epoptes lesson`) and an INDEX.md built from all digests. It never leaves this machine.
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './adapters/claude-code.ts';
import { readEvents } from './events.ts';
import { readFeedback } from './feedback.ts';
import { nowIso, readJson, writeJson, writeText } from './fsx.ts';
import { loadGoal } from './goal.ts';
import { epoptesHome, goalPaths, type GoalPaths } from './paths.ts';
import { readRegistry } from './registry.ts';
import { readResults } from './report.ts';
import { backlogMilestones } from './summary.ts';

export const LESSON_TOPICS = ['roles', 'briefs', 'cycles', 'checks', 'tools', 'state', 'cost', 'steering', 'other'] as const;
export type LessonTopic = (typeof LESSON_TOPICS)[number];

export interface Digest {
  version: 1;
  id: string;
  name: string;
  kind: string;
  objective: string;
  adapter: string;
  model: string;
  roles: { name: string; model: string | null }[];
  timebox_min: number;
  cycle_timeout_min: number;
  stats: {
    runs: number;
    followups: number;
    cycles: number;
    exits: Record<string, number>;
    active_s: number;
    median_cycle_s: number | null;
    cost_usd: number | null;
    median_cycle_cost_usd: number | null;
    rate_limit_waits: number;
    steers: number;
    approvals: number;
    waits_for_human: number;
    feedback: number;
    /** planned = milestones in the backlog; on_time/late only where the target and the reach time are both known */
    milestones: { planned: number; reached: number; on_time: number; late: number };
    done: boolean;
  };
  /** automatic observations from the numbers (no model involved) */
  signals: string[];
  /** harness lessons the orchestrator (or the human) recorded with `epoptes lesson` */
  lessons: { text: string; topic: string; at: string; by: string }[];
  /** the goal's own rules from state/lessons.md (about the work, not the harness) */
  work_lessons: string[];
  updated_at: string;
}

export const brainDir = () => path.join(epoptesHome(), 'brain');

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const hm = (s: number) => `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, '0')}m`;

/** Observations worth carrying to the next harness, from the numbers alone. */
function signalsOf(d: Omit<Digest, 'signals' | 'updated_at'>): string[] {
  const s = d.stats;
  const out: string[] = [];
  const n = s.cycles || 1;
  const timeouts = s.exits.timeout ?? 0;
  const errors = s.exits.error ?? 0;
  if (timeouts / n >= 0.2 && timeouts >= 2) out.push(`${timeouts} of ${s.cycles} cycles hit the ${d.cycle_timeout_min} min timeout: plan smaller rounds or raise cycle.timeout_min`);
  if (errors / n >= 0.2 && errors >= 2) out.push(`${errors} of ${s.cycles} cycles failed with an error`);
  if (s.rate_limit_waits >= 2) out.push(`${s.rate_limit_waits} rate-limit waits: cheaper models for routine roles, or fewer parallel workers`);
  if (s.milestones.late > s.milestones.on_time && s.milestones.reached >= 2) out.push(`milestones mostly late (${s.milestones.late} late, ${s.milestones.on_time} on time): targets were optimistic for this kind of goal`);
  if (s.milestones.planned >= 2 && s.milestones.on_time === s.milestones.planned) out.push('every milestone landed on time');
  if (s.steers >= 2) out.push(`steered ${s.steers} times: the interview likely missed what the human wanted`);
  if (s.followups >= 2) out.push(`${s.followups} follow-ups after DONE: the done checks missed things the human cared about`);
  if (s.waits_for_human >= 2) out.push(`waited for the human ${s.waits_for_human} times: settle more of the approval list up front`);
  if (s.done && s.active_s && d.timebox_min && s.active_s < d.timebox_min * 60 * 0.6) out.push(`finished in ${hm(s.active_s)} of a ${hm(d.timebox_min * 60)} time box: shorter time boxes suit this kind of goal`);
  if (!s.done && s.runs && s.exits.ok) out.push('never reached DONE');
  return out;
}

export function digestGoal(p: GoalPaths): Digest {
  const goal = loadGoal(p);
  const events = readEvents(p);
  const results = readResults(p);
  const fb = [...readFeedback(p).values()];
  const exits: Record<string, number> = {};
  for (const r of results) exits[r.exit] = (exits[r.exit] ?? 0) + 1;
  const costs = results.map((r) => r.cost_usd);
  const roles: Digest['roles'] = [];
  try {
    for (const f of fs.readdirSync(p.agents).filter((x) => x.endsWith('.md')).sort()) {
      const { data } = parseFrontmatter(fs.readFileSync(path.join(p.agents, f), 'utf8'));
      roles.push({ name: data.name || f.replace(/\.md$/, ''), model: data.model || null });
    }
  } catch {
    // no role files
  }
  // Milestones: planned from backlog targets, reached from `milestone` events that name them.
  const planned = backlogMilestones(p);
  let onTime = 0;
  let late = 0;
  let reached = 0;
  for (const m of planned) {
    const e = events.findLast((x) => x.type === 'milestone' && new RegExp(`^${m.id}\\b`, 'i').test(String(x.text ?? '')));
    if (!e) continue;
    reached++;
    if (m.target_s != null && typeof e.active_s === 'number') e.active_s > m.target_s ? late++ : onTime++;
  }
  let workLessons: string[] = [];
  try {
    workLessons = fs.readFileSync(path.join(p.state, 'lessons.md'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => /^[-*]\s+\S/.test(l)).map((l) => l.replace(/^[-*]\s+/, '')).slice(0, 30);
  } catch {
    // none yet
  }
  // Active time: each runner process's span (run.start → run.end), like the reports.
  let active = 0;
  let open: number | null = null;
  for (const e of events) {
    if (e.type === 'run.start') open = Date.parse(e.ts);
    if (e.type === 'run.end' && open != null) {
      active += (Date.parse(e.ts) - open) / 1000;
      open = null;
    }
  }
  const base: Omit<Digest, 'signals' | 'updated_at'> = {
    version: 1,
    id: goal.id,
    name: goal.name,
    kind: goal.kind,
    objective: goal.objective,
    adapter: goal.adapter.type,
    model: goal.adapter.model || '(CLI default)',
    roles,
    timebox_min: goal.timebox.total_min,
    cycle_timeout_min: goal.cycle.timeout_min,
    stats: {
      runs: events.filter((e) => e.type === 'run.start' && !e.resumed).length,
      followups: events.filter((e) => e.type === 'run.start' && e.followup && !e.resumed).length,
      cycles: results.length,
      exits,
      active_s: Math.round(active),
      median_cycle_s: median(results.map((r) => r.duration_s)),
      cost_usd: !costs.length || costs.some((c) => c == null) ? null : Math.round(costs.reduce((a: number, c) => a + c!, 0) * 100) / 100,
      median_cycle_cost_usd: median(costs.filter((c): c is number => c != null)),
      rate_limit_waits: events.filter((e) => e.type === 'wait' && e.reason === 'rate_limit').length,
      steers: events.filter((e) => e.type === 'control' && e.action === 'steer').length,
      approvals: fb.filter((f) => f.kind === 'approval').length,
      waits_for_human: events.filter((e) => e.type === 'needs_you').length,
      feedback: fb.filter((f) => f.kind === 'feedback' && f.src !== 'orchestrator').length,
      milestones: { planned: planned.length, reached, on_time: onTime, late },
      done: events.some((e) => e.type === 'done' || (e.type === 'run.end' && e.reason === 'done')),
    },
    lessons: events.filter((e) => e.type === 'lesson' && typeof e.text === 'string').map((e) => ({ text: String(e.text), topic: String(e.topic ?? 'other'), at: e.ts, by: e.src })),
    work_lessons: workLessons,
  };
  return { ...base, signals: signalsOf(base), updated_at: nowIso() };
}

/** Writes one goal's digest into the brain. Safe to call at the end of every run. */
export function gatherGoal(p: GoalPaths): Digest {
  const d = digestGoal(p);
  writeJson(path.join(brainDir(), 'goals', `${d.id}.json`), d);
  return d;
}

export function readDigests(): Digest[] {
  const dir = path.join(brainDir(), 'goals');
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  return files.map((f) => readJson<Digest>(path.join(dir, f))).filter((d): d is Digest => Boolean(d));
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Lessons across goals, grouped by topic, with near-identical ones merged (and counted). */
export function lessonIndex(digests: Digest[]) {
  const byTopic = new Map<string, { text: string; goals: Set<string>; kinds: Set<string>; last: string }[]>();
  for (const d of digests) {
    for (const l of d.lessons) {
      const list = byTopic.get(l.topic) ?? [];
      const same = list.find((x) => norm(x.text) === norm(l.text));
      if (same) {
        same.goals.add(d.id);
        same.kinds.add(d.kind);
        if (l.at > same.last) same.last = l.at;
      } else list.push({ text: l.text, goals: new Set([d.id]), kinds: new Set([d.kind]), last: l.at });
      byTopic.set(l.topic, list);
    }
  }
  const order = (t: string) => (LESSON_TOPICS as readonly string[]).indexOf(t) + 1 || 99;
  return [...byTopic.entries()]
    .sort((a, b) => order(a[0]) - order(b[0]))
    .map(([topic, list]) => ({
      topic,
      lessons: list.sort((a, b) => b.goals.size - a.goals.size || (a.last < b.last ? 1 : -1)).map((x) => ({ text: x.text, goals: [...x.goals], kinds: [...x.kinds], last: x.last })),
    }));
}

/** Per goal kind: how many goals and cycles, typical cycle length and cost, and how often things went wrong. */
export function kindTable(digests: Digest[]) {
  const kinds = [...new Set(digests.map((d) => d.kind))].sort();
  return kinds.map((kind) => {
    const ds = digests.filter((d) => d.kind === kind);
    const cycles = ds.reduce((a, d) => a + d.stats.cycles, 0);
    const timeouts = ds.reduce((a, d) => a + (d.stats.exits.timeout ?? 0), 0);
    const done = ds.filter((d) => d.stats.done).length;
    return {
      kind,
      goals: ds.length,
      done,
      cycles,
      median_cycle_s: median(ds.map((d) => d.stats.median_cycle_s).filter((x): x is number => x != null)),
      median_cycle_cost_usd: median(ds.map((d) => d.stats.median_cycle_cost_usd).filter((x): x is number => x != null)),
      timeout_share: cycles ? timeouts / cycles : 0,
      steers: ds.reduce((a, d) => a + d.stats.steers, 0),
      followups: ds.reduce((a, d) => a + d.stats.followups, 0),
    };
  });
}

/** INDEX.md: what the skill reads before designing a harness. Rebuilt from the digests; never hand-edit it. */
export function renderIndex(digests: Digest[]): string {
  const L: string[] = [];
  const day = (iso: string) => iso.slice(0, 10);
  const money = (x: number | null) => (x == null ? '–' : `≈ $${x.toFixed(2)}`);
  L.push('# Epoptes brain', '', `Built ${day(nowIso())} from ${digests.length} goal${digests.length === 1 ? '' : 's'}. Generated by \`epoptes brain\` and at the end of every run; don't edit it (curated notes go in NOTES.md next to it).`, '');
  L.push('How to use it when designing a harness: read the lessons for the topics you are deciding (roles, briefs, cycle size, checks), the numbers for this goal kind, and the signals of similar goals. Say in the design summary which lessons you applied.', '');
  const notes = path.join(brainDir(), 'NOTES.md');
  if (fs.existsSync(notes)) L.push('Curated notes: see `NOTES.md` (read it first).', '');

  L.push('## Harness lessons by topic', '');
  const idx = lessonIndex(digests);
  if (!idx.length) L.push('No lessons recorded yet. Orchestrators record them in wrap-up with `epoptes lesson "<rule>" --topic <topic>`.', '');
  for (const t of idx) {
    L.push(`### ${t.topic}`, '');
    for (const l of t.lessons) L.push(`- ${l.text}  _(${l.goals.join(', ')}${l.goals.length > 1 ? ` · ${l.goals.length} goals` : ''} · ${l.kinds.join('/')} · ${day(l.last)})_`);
    L.push('');
  }

  L.push('## Numbers by goal kind', '', '| kind | goals | done | cycles | median cycle | median cycle cost | timeouts | steers | follow-ups |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const k of kindTable(digests)) {
    L.push(`| ${k.kind} | ${k.goals} | ${k.done} | ${k.cycles} | ${k.median_cycle_s != null ? hm(k.median_cycle_s) : '–'} | ${money(k.median_cycle_cost_usd)} | ${Math.round(k.timeout_share * 100)}% | ${k.steers} | ${k.followups} |`);
  }
  L.push('', 'Costs are API-equivalent estimates unless the runs were billed.', '');

  L.push('## Goals', '');
  for (const d of [...digests].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))) {
    const s = d.stats;
    const roles = d.roles.map((r) => `${r.name}${r.model ? ` (${r.model})` : ''}`).join(', ') || 'no role files';
    L.push(`### ${d.name} (\`${d.id}\`) · ${d.kind}`, '');
    L.push(`${d.objective}`, '');
    L.push(`- ${d.adapter} · ${d.model} · roles: ${roles}`);
    L.push(`- ${s.runs} run${s.runs === 1 ? '' : 's'}${s.followups ? ` (${s.followups} follow-up)` : ''} · ${s.cycles} cycles (${Object.entries(s.exits).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}) · ${hm(s.active_s)} active of a ${hm(d.timebox_min * 60)} time box · ${money(s.cost_usd)} · ${s.done ? 'DONE' : 'not done'}`);
    const timed = s.milestones.on_time + s.milestones.late;
    if (s.milestones.planned) L.push(`- milestones: ${s.milestones.reached} of ${s.milestones.planned} reached${timed ? ` (${s.milestones.on_time} on time, ${s.milestones.late} late)` : ''}`);
    for (const x of d.signals) L.push(`- signal: ${x}`);
    if (d.work_lessons.length) L.push(`- work lessons (state/lessons.md): ${d.work_lessons.slice(0, 6).map((x) => `“${x}”`).join(' · ')}${d.work_lessons.length > 6 ? ` · +${d.work_lessons.length - 6} more` : ''}`);
    L.push('');
  }
  return L.join('\n');
}

export function rebuildIndex(): { file: string; digests: Digest[] } {
  const digests = readDigests();
  const file = path.join(brainDir(), 'INDEX.md');
  writeText(file, renderIndex(digests));
  writeJson(path.join(brainDir(), 'index.json'), { version: 1, built_at: nowIso(), lessons: lessonIndex(digests), kinds: kindTable(digests), goals: digests.map((d) => ({ id: d.id, name: d.name, kind: d.kind, signals: d.signals, stats: d.stats })) });
  return { file, digests };
}

/** Gathers every registered goal (skipping ones that can't be read) and rebuilds the index. */
export function gatherAll(): { file: string; digests: Digest[]; skipped: string[] } {
  const skipped: string[] = [];
  for (const g of readRegistry().goals) {
    try {
      gatherGoal(goalPaths(g.path));
    } catch (e) {
      skipped.push(`${g.id}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  return { ...rebuildIndex(), skipped };
}
