// Where a goal's time went, from recorded files only: runner events (cycles, waits, pauses) and each cycle's
// activity.jsonl (which agent was working, and on which tools). Costs no tokens.
import fs from 'node:fs';
import path from 'node:path';
import type { Activity } from './adapters/types.ts';
import { readEvents, type EpoptesEvent } from './events.ts';
import { exists, readJsonl } from './fsx.ts';
import { loadGoal } from './goal.ts';
import { inJob, jobsOf } from './jobs.ts';
import type { GoalPaths } from './paths.ts';

export type Phase = 'working' | 'between_cycles' | 'rate_limit' | 'cooldown' | 'needs_you' | 'paused';

export interface ToolBreakdown {
  group: string;
  seconds: number;
  calls: number;
}

export interface TimeUse {
  /** seconds per phase across every run: cycles, waits inside runs, and gaps between runs the human caused */
  phases: Record<Phase, number>;
  /** agent time per role inside cycles (parallel subagents add up), plus `orchestrator (alone)` */
  roles: { role: string; seconds: number; spans: number }[];
  /** time per tool, measured from each call to the same agent's next step (capped), and call counts; includes
   * `background commands` (background shell tasks, start to end) and grouped `breakdown` for Bash & background commands */
  tools: { tool: string; seconds: number; calls: number; breakdown?: ToolBreakdown[] }[];
  cycles: number;
}

const TOOL_CAP_S = 15 * 60; // a step longer than this is waiting, not tool time
const BREAKDOWN_CAP = 12;
const ms = (iso: string) => Date.parse(iso);

/** `mcp__server__tool` → `mcp:tool`; everything else as recorded. */
const toolName = (t: string) => (t.startsWith('mcp__') ? `mcp:${t.split('__').at(-1)}` : t);

const SUBCMD_BINS = new Set(['git', 'epoptes', 'cargo', 'docker', 'kubectl', 'go', 'gh', 'pip', 'uv', 'poetry', 'make']);
const PKG_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx']);

/**
 * Normalizes a Bash command or background task description into a short, similarity-grouped label so the time table
 * drills into what actually ran without spamming every invocation.
 */
export function commandGroup(summary: string): string {
  let s = (summary || '').replace(/\s+/g, ' ').trim();
  if (!s) return '(unnamed command)';

  // Strip leading `cd ... &&` and `VAR=val` prefixes for shell commands.
  s = s.replace(/^(?:cd\s+\S+\s*&&\s*)+/, '').trim();
  s = s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '').trim();
  const firstSeg = s.split(/\s*(?:&&|\|\||;|\|)\s*/)[0]?.trim() || s;
  const parts = firstSeg.split(/\s+/).filter(Boolean);
  if (!parts.length) return '(unnamed command)';

  const rawBin = parts[0].replace(/^['"]|['"]$/g, '');
  const bin = rawBin.includes('/') ? path.basename(rawBin) : rawBin;
  const arg1 = parts[1]?.startsWith('-') ? undefined : parts[1];
  const arg2 = parts[2]?.startsWith('-') ? undefined : parts[2];

  if (PKG_RUNNERS.has(bin)) {
    if (arg1 === 'run' && arg2) return `${bin} run ${arg2}`;
    return arg1 ? `${bin} ${arg1}` : bin;
  }
  if (SUBCMD_BINS.has(bin)) {
    return arg1 ? `${bin} ${arg1}` : bin;
  }
  if (bin === 'node' && parts[1] === '--test') return 'node --test';
  if ((bin === 'python' || bin === 'python3') && parts[1] === '-m' && parts[2]) return `${bin} -m ${parts[2]}`;
  if (['node', 'python', 'python3', 'tsx', 'bash', 'sh'].includes(bin)) {
    return arg1 && !arg1.startsWith('-') ? `${bin} ${path.basename(arg1)}` : bin;
  }
  if (/^[a-z0-9._-]+$/.test(bin) && (parts.length === 1 || parts[1].startsWith('-') || parts[1].includes('/') || parts[1].includes('.'))) {
    return bin;
  }

  // Natural-language description (e.g. Claude Code's Bash `description` or background task description):
  // normalize out specific file paths, card IDs, quoted strings and numbers so similar tasks group together.
  const norm = s
    .replace(/["'`][^"'`]*["'`]/g, '')
    .replace(/\b[A-Z]+-\d+\b/g, '')
    .replace(/(?:\.?\/)?[\w.-]+\/[\w./-]+/g, '')
    .replace(/\b\d+\b/g, '')
    .replace(/[:;,()[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = norm.split(' ').filter(Boolean).slice(0, 4).join(' ');
  const label = (words || s).slice(0, 40).trim();
  return label || '(unnamed command)';
}

export function phaseTotals(events: EpoptesEvent[], now = Date.now()): Record<Phase, number> {
  const out: Record<Phase, number> = { working: 0, between_cycles: 0, rate_limit: 0, cooldown: 0, needs_you: 0, paused: 0 };
  let lastEnd: EpoptesEvent | null = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'cycle.end') out.working += Number(e.duration_s) || 0;
    else if (e.type === 'wait') {
      // A wait can be cut short (steering, stop): never count past the next event of the run.
      const next = events.slice(i + 1).find((x) => x.run === e.run && x.type !== 'control');
      const cut = next ? (ms(next.ts) - ms(e.ts)) / 1000 : (now - ms(e.ts)) / 1000;
      const s = Math.max(0, Math.min(Number(e.seconds) || 0, cut));
      const reason = String(e.reason) as Phase;
      if (reason in out) out[reason] += s;
    } else if (e.type === 'run.end') lastEnd = e;
    else if (e.type === 'run.start' && lastEnd) {
      // The gap between runs counts only when the human was holding the run (paused, stopped, waiting for an
      // answer). After DONE or the time box, the next run is a new effort, not waiting time.
      const gap = (ms(e.ts) - ms(lastEnd.ts)) / 1000;
      if (lastEnd.reason === 'needs_you') out.needs_you += gap;
      else if (['paused', 'stopped', 'crashed', 'failed'].includes(String(lastEnd.reason))) out.paused += gap;
      lastEnd = null;
    }
  }
  // Still waiting for the human right now.
  if (lastEnd?.reason === 'needs_you') out.needs_you += (now - ms(lastEnd.ts)) / 1000;
  for (const k of Object.keys(out) as Phase[]) out[k] = Math.round(out[k]);
  return out;
}

interface CycleUse {
  roles: Map<string, { seconds: number; spans: number }>;
  tools: Map<string, { seconds: number; calls: number }>;
  breakdowns: Map<string, Map<string, { seconds: number; calls: number }>>;
}

/** One cycle's activity: subagent spans (start→end), orchestrator-alone time, and per-tool step time. */
export function cycleUse(activity: Activity[], startedAt: number, endedAt: number): CycleUse {
  const roles = new Map<string, { seconds: number; spans: number }>();
  const tools = new Map<string, { seconds: number; calls: number }>();
  const breakdowns = new Map<string, Map<string, { seconds: number; calls: number }>>();
  const add = <T extends { seconds: number }>(m: Map<string, T>, k: string, init: () => T, s: number) => {
    const v = m.get(k) ?? init();
    v.seconds += s;
    m.set(k, v);
    return v;
  };
  const addBreakdown = (tool: string, group: string, s: number) => {
    let bm = breakdowns.get(tool);
    if (!bm) {
      bm = new Map();
      breakdowns.set(tool, bm);
    }
    add(bm, group, () => ({ seconds: 0, calls: 0 }), s).calls++;
  };
  // Background shell tasks also arrive as task_started, with no subagent type, so the adapter labels them `agent#…`.
  const BG = 'background commands';
  const role = (agent: string) => (agent.split('#')[0] === 'agent' ? BG : agent.split('#')[0]);

  // Subagent spans. A subagent without an end marker ran until its last step (or the cycle end).
  const open = new Map<string, { start: number; summary: string }>();
  const lastStep = new Map<string, number>();
  const spans: [number, number][] = [];
  for (const a of activity) {
    const t = ms(a.ts);
    if (!Number.isFinite(t)) continue;
    lastStep.set(a.agent, t);
    if (a.agent === 'orchestrator') continue;
    if (a.kind === 'agent.start' && !open.has(a.agent)) open.set(a.agent, { start: t, summary: a.summary });
    if (a.kind === 'agent.end' && open.has(a.agent)) {
      const { start: s, summary } = open.get(a.agent)!;
      const r = role(a.agent);
      const sec = (t - s) / 1000;
      if (r !== BG) spans.push([s, t]);
      else addBreakdown(BG, commandGroup(summary), sec);
      add(roles, r, () => ({ seconds: 0, spans: 0 }), sec).spans++;
      open.delete(a.agent);
    }
  }
  for (const [agent, { start: s, summary }] of open) {
    const e = Math.max(s, Math.min(endedAt, lastStep.get(agent) ?? endedAt));
    const r = role(agent);
    const sec = (e - s) / 1000;
    if (r !== BG) spans.push([s, e]);
    else addBreakdown(BG, commandGroup(summary), sec);
    add(roles, r, () => ({ seconds: 0, spans: 0 }), sec).spans++;
  }
  // Orchestrator alone = the cycle minus the union of subagent spans.
  spans.sort((a, b) => a[0] - b[0]);
  let busy = 0;
  let [cs, ce] = [NaN, NaN];
  for (const [s, e] of spans) {
    if (!(s <= ce)) {
      if (Number.isFinite(cs)) busy += ce - cs;
      [cs, ce] = [s, e];
    } else ce = Math.max(ce, e);
  }
  if (Number.isFinite(cs)) busy += ce - cs;
  const alone = Math.max(0, endedAt - startedAt - busy) / 1000;
  roles.set('orchestrator (alone)', { seconds: alone, spans: 1 });

  // Tool time: from each call to the same agent's next step.
  const byAgent = new Map<string, Activity[]>();
  for (const a of activity) byAgent.set(a.agent, [...(byAgent.get(a.agent) ?? []), a]);
  for (const steps of byAgent.values()) {
    for (let i = 0; i < steps.length; i++) {
      const a = steps[i];
      if (a.kind !== 'tool' || !a.tool) continue;
      const t = ms(a.ts);
      const next = steps[i + 1] ? ms(steps[i + 1].ts) : endedAt;
      const s = Math.max(0, Math.min(TOOL_CAP_S, (next - t) / 1000));
      const tn = toolName(a.tool);
      add(tools, tn, () => ({ seconds: 0, calls: 0 }), s).calls++;
      if (tn === 'Bash') addBreakdown('Bash', commandGroup(a.summary), s);
    }
  }
  // Background commands overlap everything else, so they read as tool time, not as a role.
  const bg = roles.get(BG);
  if (bg) {
    roles.delete(BG);
    tools.set(BG, { seconds: bg.seconds, calls: bg.spans });
  }
  return { roles, tools, breakdowns };
}

// Finished cycles never change, so their analysis is cached by directory.
const cache = new Map<string, CycleUse>();

/** The current job's time by default; `all` for the whole history. */
export function timeUse(p: GoalPaths, now = Date.now(), { all = false } = {}): TimeUse {
  let events = readEvents(p);
  let cycleIn = (_n: number) => true;
  const jobs = all ? [] : jobsOf(events, loadGoal(p));
  if (jobs.length > 1) {
    // Only with several jobs: imported histories may lack cycle.start events.
    const job = jobs.at(-1)!;
    events = events.filter((e) => inJob(e.ts, job));
    const mine = new Set(events.filter((e) => e.type === 'cycle.start').map((e) => e.cycle));
    cycleIn = (n) => mine.has(n);
  }
  const roles = new Map<string, { seconds: number; spans: number }>();
  const tools = new Map<string, { seconds: number; calls: number }>();
  const breakdowns = new Map<string, Map<string, { seconds: number; calls: number }>>();
  let cycles = 0;
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(p.cycles).filter((d) => /^\d{6}$/.test(d)).sort();
  } catch {
    // no cycles yet
  }
  for (const d of dirs) {
    if (!cycleIn(Number(d))) continue;
    const dir = path.join(p.cycles, d);
    const done = exists(path.join(dir, 'result.json'));
    let use = done ? cache.get(dir) : undefined;
    if (!use) {
      const activity = readJsonl<Activity>(path.join(dir, 'activity.jsonl'));
      if (!activity.length) continue;
      const n = Number(d);
      const start = events.find((e) => e.type === 'cycle.start' && e.cycle === n);
      const end = events.find((e) => e.type === 'cycle.end' && e.cycle === n);
      const startedAt = start ? ms(start.ts) : ms(activity[0].ts);
      const endedAt = end ? ms(end.ts) : done ? ms(activity.at(-1)!.ts) : now;
      use = cycleUse(activity, startedAt, endedAt);
      if (done) cache.set(dir, use);
    }
    cycles++;
    for (const [k, v] of use.roles) {
      const t = roles.get(k) ?? { seconds: 0, spans: 0 };
      roles.set(k, { seconds: t.seconds + v.seconds, spans: t.spans + v.spans });
    }
    for (const [k, v] of use.tools) {
      const t = tools.get(k) ?? { seconds: 0, calls: 0 };
      tools.set(k, { seconds: t.seconds + v.seconds, calls: t.calls + v.calls });
    }
    for (const [tool, bm] of use.breakdowns) {
      let into = breakdowns.get(tool);
      if (!into) {
        into = new Map();
        breakdowns.set(tool, into);
      }
      for (const [g, v] of bm) {
        const cur = into.get(g) ?? { seconds: 0, calls: 0 };
        into.set(g, { seconds: cur.seconds + v.seconds, calls: cur.calls + v.calls });
      }
    }
  }
  const round = (x: number) => Math.round(x);
  const formatBreakdown = (tool: string): ToolBreakdown[] | undefined => {
    const bm = breakdowns.get(tool);
    if (!bm?.size) return undefined;
    const sorted = [...bm].map(([group, v]) => ({ group, seconds: round(v.seconds), calls: v.calls })).sort((a, b) => b.seconds - a.seconds || b.calls - a.calls);
    if (sorted.length <= BREAKDOWN_CAP) return sorted;
    const top = sorted.slice(0, BREAKDOWN_CAP);
    const rest = sorted.slice(BREAKDOWN_CAP);
    top.push({
      group: `${rest.length} other command${rest.length === 1 ? '' : 's'}`,
      seconds: rest.reduce((a, x) => a + x.seconds, 0),
      calls: rest.reduce((a, x) => a + x.calls, 0),
    });
    return top;
  };
  return {
    phases: phaseTotals(events, now),
    roles: [...roles].map(([role, v]) => ({ role, seconds: round(v.seconds), spans: v.spans })).sort((a, b) => b.seconds - a.seconds),
    tools: [...tools]
      .map(([tool, v]) => {
        const breakdown = formatBreakdown(tool);
        return { tool, seconds: round(v.seconds), calls: v.calls, ...(breakdown ? { breakdown } : {}) };
      })
      .sort((a, b) => b.seconds - a.seconds),
    cycles,
  };
}
