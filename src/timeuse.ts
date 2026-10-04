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

export interface TimeUse {
  /** seconds per phase across every run: cycles, waits inside runs, and gaps between runs the human caused */
  phases: Record<Phase, number>;
  /** agent time per role inside cycles (parallel subagents add up), plus `orchestrator (alone)` */
  roles: { role: string; seconds: number; spans: number }[];
  /** time per tool, measured from each call to the same agent's next step (capped), and call counts; includes
   * `background commands` (background shell tasks, start to end) */
  tools: { tool: string; seconds: number; calls: number }[];
  cycles: number;
}

const TOOL_CAP_S = 15 * 60; // a step longer than this is waiting, not tool time
const ms = (iso: string) => Date.parse(iso);

/** `mcp__server__tool` → `mcp:tool`; everything else as recorded. */
const toolName = (t: string) => (t.startsWith('mcp__') ? `mcp:${t.split('__').at(-1)}` : t);

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
}

/** One cycle's activity: subagent spans (start→end), orchestrator-alone time, and per-tool step time. */
export function cycleUse(activity: Activity[], startedAt: number, endedAt: number): CycleUse {
  const roles = new Map<string, { seconds: number; spans: number }>();
  const tools = new Map<string, { seconds: number; calls: number }>();
  const add = <T extends { seconds: number }>(m: Map<string, T>, k: string, init: () => T, s: number) => {
    const v = m.get(k) ?? init();
    v.seconds += s;
    m.set(k, v);
    return v;
  };
  // Background shell tasks also arrive as task_started, with no subagent type, so the adapter labels them `agent#…`.
  const BG = 'background commands';
  const role = (agent: string) => (agent.split('#')[0] === 'agent' ? BG : agent.split('#')[0]);

  // Subagent spans. A subagent without an end marker ran until its last step (or the cycle end).
  const open = new Map<string, number>();
  const lastStep = new Map<string, number>();
  const spans: [number, number][] = [];
  for (const a of activity) {
    const t = ms(a.ts);
    if (!Number.isFinite(t)) continue;
    lastStep.set(a.agent, t);
    if (a.agent === 'orchestrator') continue;
    if (a.kind === 'agent.start' && !open.has(a.agent)) open.set(a.agent, t);
    if (a.kind === 'agent.end' && open.has(a.agent)) {
      const s = open.get(a.agent)!;
      if (role(a.agent) !== BG) spans.push([s, t]);
      add(roles, role(a.agent), () => ({ seconds: 0, spans: 0 }), (t - s) / 1000).spans++;
      open.delete(a.agent);
    }
  }
  for (const [agent, s] of open) {
    const e = Math.max(s, Math.min(endedAt, lastStep.get(agent) ?? endedAt));
    if (role(agent) !== BG) spans.push([s, e]);
    add(roles, role(agent), () => ({ seconds: 0, spans: 0 }), (e - s) / 1000).spans++;
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
      add(tools, toolName(a.tool), () => ({ seconds: 0, calls: 0 }), s).calls++;
    }
  }
  // Background commands overlap everything else, so they read as tool time, not as a role.
  const bg = roles.get(BG);
  if (bg) {
    roles.delete(BG);
    tools.set(BG, { seconds: bg.seconds, calls: bg.spans });
  }
  return { roles, tools };
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
  }
  const round = (x: number) => Math.round(x);
  return {
    phases: phaseTotals(events, now),
    roles: [...roles].map(([role, v]) => ({ role, seconds: round(v.seconds), spans: v.spans })).sort((a, b) => b.seconds - a.seconds),
    tools: [...tools].map(([tool, v]) => ({ tool, seconds: round(v.seconds), calls: v.calls })).sort((a, b) => b.seconds - a.seconds),
    cycles,
  };
}
