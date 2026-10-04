// Reports built only from recorded data: events, cycle results, feedback, state files and checkpoints.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CycleResult, ModelUsage } from './adapters/types.ts';
import { readEvents, type EpoptesEvent } from './events.ts';
import { readFeedback } from './feedback.ts';
import { exists, hm, nowIso, readJson, readJsonl } from './fsx.ts';
import { loadGoal, type Goal } from './goal.ts';
import type { GoalPaths } from './paths.ts';
import { readStatus } from './status.ts';
import { backlogItems, totalCost } from './summary.ts';

type Result = CycleResult & { cycle: number; run: string };

export interface GoalReport {
  generated_at: string;
  goal: Pick<Goal, 'id' | 'name' | 'kind' | 'objective' | 'done' | 'checkpoints'> & { path: string };
  state: string;
  estimate: boolean;
  totals: {
    wall_s: number;
    active_s: number;
    cycles: number;
    turns: number;
    cost_usd: number | null;
    cache_share: number | null;
    rate_limit_wait_s: number;
    failed_cycles: number;
    models: Record<string, ModelUsage>;
  };
  runs: { run: string; started_at: string; ended_at: string | null; end_reason: string | null; wall_s: number; active_s: number; cycles: number; cost_usd: number | null; exits: Record<string, number> }[];
  cycles: { cycle: number; run: string; started_at: string; duration_s: number; exit: string; turns: number | null; cost_usd: number | null; cache_share: number | null; flagged: boolean; models: Record<string, ModelUsage> }[];
  median_cost: number | null;
  milestones: { ts: string; run: string | null; cycle: number | null; type: string; text: string }[];
  tasks: { done: string[]; blocked: string[]; cut: string[]; open: number };
  commits: { hash: string; at: string; subject: string }[];
  snapshots: number;
  artifacts: { ts: string; path: string; text?: string }[];
  feedback: { id: string; text: string; status: string; src: string; created_at: string; closed_cycle: number | null; note: string | null }[];
  scores: { criteria: string[]; rows: { cycle: number | null; milestone: string | null; scores: Record<string, number | null> }[] };
  problems: { text: string; count: number; last: string }[];
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const cacheShare = (models: Record<string, ModelUsage>) => {
  let read = 0;
  let all = 0;
  for (const u of Object.values(models)) {
    read += u.cache_read;
    all += u.input + u.cache_read + u.cache_write;
  }
  return all ? read / all : null;
};

export function readResults(p: GoalPaths): Result[] {
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(p.cycles).filter((d) => /^\d{6}$/.test(d)).sort();
  } catch {
    return [];
  }
  return dirs.map((d) => readJson<Result>(path.join(p.cycles, d, 'result.json'))).filter((r): r is Result => Boolean(r));
}

/** Runner time per run from run.start/run.end pairs, minus rate-limit waits when those pause the clock. */
function runSpans(events: EpoptesEvent[], pauseOnRateLimit: boolean, now: number) {
  const runs = new Map<string, { started_at: string; ended_at: string | null; end_reason: string | null; active_ms: number; open: number | null }>();
  for (const e of events) {
    if (!e.run) continue;
    let r = runs.get(e.run);
    if (e.type === 'run.start') {
      if (!r) runs.set(e.run, (r = { started_at: e.ts, ended_at: null, end_reason: null, active_ms: 0, open: null }));
      r.open = Date.parse(e.ts);
    } else if (r && e.type === 'run.end') {
      if (r.open !== null) r.active_ms += Date.parse(e.ts) - r.open;
      r.open = null;
      r.ended_at = e.ts;
      r.end_reason = String(e.reason ?? '');
    } else if (r && e.type === 'wait' && e.reason === 'rate_limit' && pauseOnRateLimit) {
      r.active_ms -= Number(e.seconds ?? 0) * 1000;
    }
  }
  for (const r of runs.values()) if (r.open !== null) r.active_ms += now - r.open;
  return runs;
}

function gitLog(args: string[], cwd: string) {
  try {
    const out = execFileSync('git', [...args, 'log', '--format=%h%x09%cI%x09%s'], { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 10000 });
    return out.trim().split('\n').filter(Boolean).map((l) => {
      const [hash, at, ...s] = l.split('\t');
      return { hash, at, subject: s.join('\t') };
    });
  } catch {
    return [];
  }
}

function readScores(p: GoalPaths): GoalReport['scores'] {
  const rows: GoalReport['scores']['rows'] = [];
  const criteria = new Set<string>();
  for (const line of readJsonl<Record<string, unknown>>(path.join(p.state, 'scores.jsonl'))) {
    // Accept the spec shape {cycle, scores:{…}} and flat lines like {cycle, accuracy: 8}.
    const src = (line.scores && typeof line.scores === 'object' ? line.scores : line) as Record<string, unknown>;
    const scores: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(src)) {
      if (['cycle', 'round', 'milestone', 'elapsed', 'gates'].includes(k)) continue;
      if (typeof v === 'number' || v === null) {
        scores[k] = v as number | null;
        criteria.add(k);
      }
    }
    if (Object.keys(scores).length) rows.push({ cycle: typeof line.cycle === 'number' ? line.cycle : null, milestone: typeof line.milestone === 'string' ? line.milestone : null, scores });
  }
  return { criteria: [...criteria], rows };
}

export function buildReport(p: GoalPaths, now = Date.now()): GoalReport {
  const goal = loadGoal(p);
  const events = readEvents(p);
  const results = readResults(p);
  const status = readStatus(p);

  const costs = results.map((r) => r.cost_usd ?? 0).filter((c) => c > 0);
  const med = costs.length ? median(costs) : null;
  const models: Record<string, ModelUsage> = {};
  for (const r of results) {
    for (const [m, u] of Object.entries(r.models)) {
      const t = (models[m] ??= { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: 0 });
      t.input += u.input;
      t.output += u.output;
      t.cache_read += u.cache_read;
      t.cache_write += u.cache_write;
      t.cost_usd = totalCost([t, u]);
    }
  }

  const spans = runSpans(events, goal.timebox.pause_on_rate_limit, now);
  const followups = new Set(events.filter((e) => e.type === 'run.start' && e.followup).map((e) => e.run));
  const runs: GoalReport['runs'] = [...spans.entries()].map(([run, s]) => {
    const rs = results.filter((r) => r.run === run);
    const exits: Record<string, number> = {};
    for (const r of rs) exits[r.exit] = (exits[r.exit] ?? 0) + 1;
    const end = s.ended_at ? Date.parse(s.ended_at) : now;
    return { run: followups.has(run) ? `${run} (follow-up)` : run, started_at: s.started_at, ended_at: s.ended_at, end_reason: s.end_reason, wall_s: Math.round((end - Date.parse(s.started_at)) / 1000), active_s: Math.max(0, Math.round(s.active_ms / 1000)), cycles: rs.length, cost_usd: totalCost(rs), exits };
  });

  const first = runs[0]?.started_at ?? results[0]?.started_at;
  const lastEnd = runs.at(-1)?.ended_at ? Date.parse(runs.at(-1)!.ended_at!) : now;

  const items = backlogItems(p);
  const fb = [...readFeedback(p).values()].map((f) => {
    const closing = [...f.history].reverse().find((o) => o.op === 'status' && ['done', 'wont_do', 'blocked'].includes(o.status));
    return { id: f.id, text: f.text, status: f.status, src: f.src, created_at: f.created_at, closed_cycle: (closing && 'cycle' in closing ? closing.cycle : null) ?? null, note: closing && 'note' in closing ? (closing.note ?? null) : null };
  });

  const problems = new Map<string, { text: string; count: number; last: string }>();
  const addProblem = (text: string, ts: string) => {
    const p0 = problems.get(text) ?? { text, count: 0, last: ts };
    p0.count++;
    p0.last = ts;
    problems.set(text, p0);
  };
  for (const e of events) {
    if (e.type === 'warn' || e.type === 'blocked') addProblem(`${e.type === 'blocked' ? 'Blocked: ' : ''}${e.text}`, e.ts);
  }
  for (const r of results) if (r.exit === 'error' || r.exit === 'timeout') addProblem(`Cycle ${r.exit}${r.error ? `: ${r.error}` : ''}`, r.ended_at);

  let snapshots = 0;
  let commits: GoalReport['commits'] = [];
  if (goal.checkpoints === 'git' && first) commits = gitLog(['-C', p.project, '-c', 'log.showSignature=false'], p.project).filter((c) => Date.parse(c.at) >= Date.parse(first) - 60_000);
  if (goal.checkpoints === 'shadow' && exists(p.snapshots)) snapshots = gitLog(['--git-dir', p.snapshots], p.project).length;

  return {
    generated_at: nowIso(now),
    goal: { id: goal.id, name: goal.name, kind: goal.kind, objective: goal.objective, done: goal.done, checkpoints: goal.checkpoints, path: p.project },
    state: status?.state ?? 'idle',
    estimate: results.some((r) => r.cost_usd != null && r.cost_basis === 'estimate') || !results.length,
    totals: {
      wall_s: first ? Math.round((lastEnd - Date.parse(first)) / 1000) : 0,
      active_s: runs.reduce((a, r) => a + r.active_s, 0),
      cycles: results.length,
      turns: results.reduce((a, r) => a + (r.turns ?? 0), 0),
      cost_usd: totalCost(results),
      cache_share: cacheShare(models),
      rate_limit_wait_s: events.filter((e) => e.type === 'wait' && e.reason === 'rate_limit').reduce((a, e) => a + Number(e.seconds ?? 0), 0),
      failed_cycles: results.filter((r) => r.exit === 'error' || r.exit === 'timeout').length,
      models,
    },
    runs,
    cycles: results.map((r) => ({ cycle: r.cycle, run: r.run, started_at: r.started_at, duration_s: r.duration_s, exit: r.exit, turns: r.turns, cost_usd: r.cost_usd, cache_share: cacheShare(r.models), flagged: results.length >= 3 && med != null && med > 0 && (r.cost_usd ?? 0) > 2 * med, models: r.models })),
    median_cost: med,
    milestones: events.filter((e) => ['milestone', 'wrapup', 'done'].includes(e.type)).map((e) => ({ ts: e.ts, run: e.run, cycle: e.cycle, type: e.type, text: String(e.text ?? '') })),
    tasks: {
      done: items.filter((t) => t.mark === 'done').map((t) => t.text),
      blocked: items.filter((t) => t.mark === 'blocked').map((t) => t.text),
      cut: items.filter((t) => t.mark === 'cut').map((t) => t.text),
      open: items.filter((t) => t.mark === 'todo' || t.mark === 'doing').length,
    },
    commits: commits.slice(0, 80),
    snapshots,
    artifacts: events.filter((e) => e.type === 'artifact').map((e) => ({ ts: e.ts, path: String(e.path), ...(e.text ? { text: String(e.text) } : {}) })),
    feedback: fb,
    scores: readScores(p),
    problems: [...problems.values()].sort((a, b) => b.count - a.count),
  };
}

// ---------------------------------------------------------------- rendering helpers

const ESTIMATE_NOTE = 'API-equivalent estimate, not billed';
const ESTIMATE_HEADER = 'costs are API-equivalent estimates, not billed';
const usd = (x: number | null | undefined, est: boolean) => (x == null ? '–' : `${est ? '≈ ' : ''}$${x.toFixed(2)}`);
const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const pct = (x: number | null) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const short = (m: string) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
const day = (iso: string) => new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const shortDay = (iso: string) => new Date(iso).toISOString().slice(5, 16).replace('T', ' ');
const mdCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

// ---------------------------------------------------------------- Markdown

export function renderMarkdown(r: GoalReport): string {
  const est = r.estimate;
  const t = r.totals;
  const L: string[] = [];
  L.push(`# ${r.goal.name}: report`, '');
  L.push(`${r.goal.objective}`, '');
  L.push(`Goal \`${r.goal.id}\` · ${r.goal.kind} · state **${r.state}** · generated ${day(r.generated_at)}${est ? ` · ${ESTIMATE_HEADER}` : ''}`, '');
  L.push('## Summary', '');
  L.push('| | |', '|---|---|');
  L.push(`| Wall time | ${hm(t.wall_s)} |`, `| Active time | ${hm(t.active_s)} |`, `| Runs | ${r.runs.length} |`, `| Cycles | ${t.cycles} (${t.failed_cycles} failed) |`, `| Turns | ${t.turns} |`);
  L.push(`| Cost | ${usd(t.cost_usd, est)}${est ? ` (${ESTIMATE_NOTE})` : ''} |`, `| Cache-read share | ${pct(t.cache_share)} |`, `| Rate-limit waits | ${hm(t.rate_limit_wait_s)} |`);
  L.push(`| Tasks | ${r.tasks.done.length} done · ${r.tasks.open} open · ${r.tasks.blocked.length} blocked · ${r.tasks.cut.length} cut |`);
  L.push(`| Feedback | ${r.feedback.length} items · ${r.feedback.filter((f) => f.status === 'done').length} done |`, '');

  L.push('## Tokens and cost by model', '', '| model | input | output | cache read | cache write | cost |', '|---|---:|---:|---:|---:|---:|');
  for (const [m, u] of Object.entries(t.models)) L.push(`| ${short(m)} | ${tok(u.input)} | ${tok(u.output)} | ${tok(u.cache_read)} | ${tok(u.cache_write)} | ${usd(u.cost_usd, est)} |`);
  L.push('');

  L.push('## Runs', '', '| run | started | wall | active | cycles | ended | cost |', '|---|---|---:|---:|---:|---|---:|');
  for (const x of r.runs) L.push(`| ${x.run} | ${day(x.started_at)} | ${hm(x.wall_s)} | ${hm(x.active_s)} | ${x.cycles} | ${x.end_reason ?? 'running'} | ${usd(x.cost_usd, est)} |`);
  L.push('');

  L.push('## What was done', '');
  if (r.milestones.length) {
    L.push('**Milestones**', '');
    for (const m of r.milestones) L.push(`- ${m.type === 'done' ? '✓ ' : m.type === 'wrapup' ? '↧ ' : '★ '}${mdCell(m.text)} (${m.run ?? ''}${m.cycle ? ` c${m.cycle}` : ''}, ${day(m.ts)})`);
    L.push('');
  }
  if (r.tasks.done.length) {
    L.push(`**Tasks done (${r.tasks.done.length})**`, '');
    for (const x of r.tasks.done) L.push(`- ${mdCell(x)}`);
    L.push('');
  }
  if (r.commits.length) {
    L.push(`**Commits (${r.commits.length})**`, '');
    for (const c of r.commits) L.push(`- \`${c.hash}\` ${mdCell(c.subject)}`);
    L.push('');
  }
  if (r.snapshots) L.push(`**Snapshots:** ${r.snapshots} in \`.epoptes/snapshots.git\``, '');
  if (r.artifacts.length) {
    L.push('**Artifacts**', '');
    for (const a of r.artifacts) L.push(`- \`${a.path}\`${a.text ? ` · ${mdCell(a.text)}` : ''}`);
    L.push('');
  }

  L.push('## Feedback handled', '');
  if (!r.feedback.length) L.push('No feedback was given.', '');
  else {
    L.push('| id | feedback | status | closed in | note |', '|---|---|---|---|---|');
    for (const f of r.feedback) L.push(`| ${f.id} | ${mdCell(f.text)} | ${f.status.replace('_', ' ')} | ${f.closed_cycle ? `c${f.closed_cycle}` : '–'} | ${mdCell(f.note ?? '')} |`);
    L.push('');
  }

  L.push('## Blocked and cut', '');
  if (!r.tasks.blocked.length && !r.tasks.cut.length) L.push('Nothing was blocked or cut.', '');
  for (const x of r.tasks.blocked) L.push(`- **blocked:** ${mdCell(x)}`);
  for (const x of r.tasks.cut) L.push(`- **cut:** ${mdCell(x)}`);
  if (r.tasks.blocked.length || r.tasks.cut.length) L.push('');

  if (r.scores.rows.length) {
    L.push('## Scores', '', `| cycle | ${r.scores.criteria.join(' | ')} |`, `|---|${r.scores.criteria.map(() => '---:').join('|')}|`);
    for (const row of r.scores.rows) L.push(`| ${row.cycle ?? '–'}${row.milestone ? ` (${row.milestone})` : ''} | ${r.scores.criteria.map((c) => row.scores[c] ?? '–').join(' | ')} |`);
    L.push('');
  }

  L.push('## Cycles', '', `Median cycle cost ${usd(r.median_cost, est)}. ⚠ marks cycles over twice the median.`, '', '| # | run | exit | time | turns | cache read | cost |', '|---:|---|---|---:|---:|---:|---:|');
  for (const c of r.cycles) L.push(`| ${c.cycle}${c.flagged ? ' ⚠' : ''} | ${c.run} | ${c.exit.replace('_', ' ')} | ${hm(c.duration_s)} | ${c.turns ?? '–'} | ${pct(c.cache_share)} | ${usd(c.cost_usd, est)} |`);
  L.push('');

  if (r.problems.length) {
    L.push('## Problems and warnings', '');
    for (const x of r.problems.slice(0, 30)) L.push(`- ${mdCell(x.text)}${x.count > 1 ? ` (×${x.count})` : ''}`);
    L.push('');
  }
  L.push('---', `Built only from recorded data in \`${r.goal.path}/.epoptes\`.`, '');
  return L.join('\n');
}

// ---------------------------------------------------------------- HTML

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const CSS = `
:root{--bg:#f6f5f1;--panel:#fff;--ink:#1c1e22;--muted:#686c74;--line:#e2e0d9;--bar:#b8650c;--warn:#9a6a00;--ok:#1f7a50;--bad:#b33a2a}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--panel:#171a20;--ink:#e6e8ec;--muted:#9aa1ac;--line:#282d36;--bar:#eba33f;--warn:#e2b23e;--ok:#3ec486;--bad:#f0715d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
main{max-width:1040px;margin:0 auto;padding:32px 24px 64px}h1{font-size:26px;margin:0 0 6px}h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:32px 0 10px}
.lede{color:var(--muted);margin:0 0 4px;max-width:75ch}.meta{color:var(--muted);font-size:12.5px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:20px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.tile .k{font-size:12px;color:var(--muted)}.tile .v{font-size:21px;font-weight:650;font-variant-numeric:tabular-nums}.tile .v small{display:block;font-size:12px;font-weight:400;color:var(--muted);margin-top:2px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:var(--muted);font-weight:550;font-size:12px;border-bottom:1px solid var(--line);padding:6px 8px;white-space:nowrap}td{border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:top}td.nw{white-space:nowrap}details summary{cursor:pointer;color:var(--muted);margin:4px 0 0 20px}td.r,th.r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
ul{margin:0;padding-left:20px}li{margin:3px 0}code,.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}
.est{border-bottom:1px dotted var(--muted);cursor:help}.flag{color:var(--warn);font-weight:650}.ok{color:var(--ok)}.bad{color:var(--bad)}
.chart svg{display:block;width:100%;height:auto}.chart .axis{fill:var(--muted);font-size:11px}.chart .grid{stroke:var(--line)}.chart .bar{fill:var(--bar)}.chart .runline{stroke:var(--muted);stroke-dasharray:3 3}.chart .flagtxt{fill:var(--warn);font-size:11px;font-weight:650}
.two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}@media (max-width:760px){.two{grid-template-columns:minmax(0,1fr)}}
footer{margin-top:40px;color:var(--muted);font-size:12px}
@media print{body{background:#fff}.panel,.tile{break-inside:avoid}}
`;

/** Cost per cycle as bars (one series, one hue); run boundaries dashed; ⚠ over 2× median. Hover shows details. */
function costChart(r: GoalReport): string {
  const cs = r.cycles;
  if (!cs.length) return '<p class="meta">No cycles yet.</p>';
  if (cs.every((c) => c.cost_usd == null)) return '<p class="meta">Dollar costs are unavailable for these cycles.</p>';
  const W = 960;
  const H = 220;
  const pad = { l: 48, r: 8, t: 18, b: 26 };
  const max = Math.max(...cs.map((c) => c.cost_usd ?? 0), 0.01);
  const step = (W - pad.l - pad.r) / cs.length;
  const bw = Math.max(2, step - 2); // 2px surface gap between bars
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const out: string[] = [];
  out.push(`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cost per cycle, ${cs.length} cycles">`);
  for (const tv of ticks) out.push(`<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(tv)}" y2="${y(tv)}"/><text class="axis" x="${pad.l - 6}" y="${y(tv) + 4}" text-anchor="end">${r.estimate ? '≈' : ''}$${tv.toFixed(tv < 1 ? 2 : 0)}</text>`);
  let lastRun = '';
  cs.forEach((c, i) => {
    const x = pad.l + i * step + 1;
    if (c.run !== lastRun) {
      if (i > 0) out.push(`<line class="runline" x1="${x - 1}" x2="${x - 1}" y1="${pad.t - 10}" y2="${H - pad.b}"/>`);
      out.push(`<text class="axis" x="${x + 2}" y="${pad.t - 6}">${esc(c.run)}</text>`);
      lastRun = c.run;
    }
    if (c.cost_usd == null) {
      out.push(`<text class="axis" x="${x + bw / 2}" y="${H - pad.b - 4}" text-anchor="middle"><title>Cycle ${c.cycle}: cost unavailable</title>?</text>`);
      return;
    }
    const v = c.cost_usd;
    const top = y(v);
    const h = Math.max(1, H - pad.b - top);
    const rr = Math.min(4, bw / 2, h);
    // Rounded data end (top), square at the baseline.
    const d = `M${x},${H - pad.b} V${top + rr} Q${x},${top} ${x + rr},${top} H${x + bw - rr} Q${x + bw},${top} ${x + bw},${top + rr} V${H - pad.b} Z`;
    const models = Object.entries(c.models).map(([m, u]) => `${short(m)}: out ${tok(u.output)}, cache read ${tok(u.cache_read)}`).join('; ');
    out.push(`<path class="bar" d="${d}"><title>Cycle ${c.cycle} (${esc(c.run)}) · ${esc(c.exit)} · ${hm(c.duration_s)} · ${usd(c.cost_usd, r.estimate)}${c.flagged ? ' · over 2× median' : ''}\n${esc(models)}</title></path>`);
    if (c.flagged) out.push(`<text class="flagtxt" x="${x + bw / 2}" y="${top - 4}" text-anchor="middle">⚠</text>`);
  });
  const every = Math.max(1, Math.ceil(cs.length / 16));
  cs.forEach((c, i) => {
    if (i % every === 0) out.push(`<text class="axis" x="${pad.l + i * step + 1 + bw / 2}" y="${H - 8}" text-anchor="middle">${c.cycle}</text>`);
  });
  out.push('</svg>');
  return out.join('');
}

export function renderHtml(r: GoalReport): string {
  const est = r.estimate;
  const t = r.totals;
  const money = (x: number | null | undefined) => (est ? `<span class="est" title="${ESTIMATE_NOTE}">${usd(x, true)}</span>` : usd(x, false));
  const list = (xs: string[]) => (xs.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="meta">None.</p>');
  // Long lists show the first 12 items; the rest fold into a <details>.
  const longList = (items: string[]) => {
    if (items.length <= 14) return `<ul>${items.join('')}</ul>`;
    return `<ul>${items.slice(0, 12).join('')}</ul><details><summary>${items.length - 12} more</summary><ul>${items.slice(12).join('')}</ul></details>`;
  };
  const H: string[] = [];
  H.push(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(r.goal.name)} · Epoptes report</title><style>${CSS}</style></head><body><main>`);
  H.push(`<h1>${esc(r.goal.name)}</h1><p class="lede">${esc(r.goal.objective)}</p>`);
  H.push(`<p class="meta">Goal <code>${esc(r.goal.id)}</code> · ${esc(r.goal.kind)} · state <b>${esc(r.state)}</b> · generated ${day(r.generated_at)}${est ? ` · ${ESTIMATE_HEADER}` : ''}</p>`);
  H.push('<div class="tiles">');
  const tile = (k: string, v: string) => H.push(`<div class="tile"><div class="k">${k}</div><div class="v">${v}</div></div>`);
  tile('Active time', `${hm(t.active_s)} <small>of ${hm(t.wall_s)} wall</small>`);
  tile('Cycles', `${t.cycles} <small>${r.runs.length} run${r.runs.length === 1 ? '' : 's'}${t.failed_cycles ? ` · ${t.failed_cycles} failed` : ''}</small>`);
  tile('Cost', money(t.cost_usd));
  tile('Cache-read share', pct(t.cache_share));
  tile('Tasks done', `${r.tasks.done.length} <small>${r.tasks.open} open</small>`);
  tile('Feedback', `${r.feedback.filter((f) => f.status === 'done').length}/${r.feedback.length} <small>done</small>`);
  H.push('</div>');

  H.push(`<h2>Cost per cycle</h2><div class="panel chart">${costChart(r)}<p class="meta">Median cycle ${money(r.median_cost)}. ⚠ marks cycles over twice the median; dashed lines separate runs. The cycle table below has every value.</p></div>`);

  H.push('<div class="two"><div>');
  H.push('<h2>Tokens and cost by model</h2><div class="panel"><table><thead><tr><th>model</th><th class="r">input</th><th class="r">output</th><th class="r">cache read</th><th class="r">cache write</th><th class="r">cost</th></tr></thead><tbody>');
  for (const [m, u] of Object.entries(t.models)) H.push(`<tr><td class="nw">${esc(short(m))}</td><td class="r">${tok(u.input)}</td><td class="r">${tok(u.output)}</td><td class="r">${tok(u.cache_read)}</td><td class="r">${tok(u.cache_write)}</td><td class="r">${money(u.cost_usd)}</td></tr>`);
  H.push('</tbody></table></div></div><div>');
  H.push('<h2>Runs</h2><div class="panel"><table><thead><tr><th>run</th><th>started (UTC)</th><th class="r">wall</th><th class="r">active</th><th class="r">cycles</th><th>ended</th><th class="r">cost</th></tr></thead><tbody>');
  for (const x of r.runs) H.push(`<tr><td>${esc(x.run)}</td><td class="nw" title="${day(x.started_at)}">${shortDay(x.started_at)}</td><td class="r">${hm(x.wall_s)}</td><td class="r">${hm(x.active_s)}</td><td class="r">${x.cycles}</td><td>${esc(x.end_reason ?? 'running')}</td><td class="r">${money(x.cost_usd)}</td></tr>`);
  H.push(`</tbody></table>${t.rate_limit_wait_s ? `<p class="meta">Rate-limit waits: ${hm(t.rate_limit_wait_s)}.</p>` : ''}</div></div></div>`);

  H.push('<h2>What was done</h2><div class="panel">');
  if (r.milestones.length) H.push(`<p><b>Milestones</b></p><ul>${r.milestones.map((m) => `<li>${m.type === 'done' ? '✓' : m.type === 'wrapup' ? '↧' : '★'} ${esc(m.text)} <span class="meta">${esc(m.run ?? '')}${m.cycle ? ` c${m.cycle}` : ''} · ${day(m.ts)}</span></li>`).join('')}</ul>`);
  H.push(`<p><b>Tasks done (${r.tasks.done.length})</b></p>${r.tasks.done.length ? longList(r.tasks.done.map((x) => `<li>${esc(x)}</li>`)) : '<p class="meta">None.</p>'}`);
  if (r.commits.length) H.push(`<p><b>Commits (${r.commits.length})</b></p>${longList(r.commits.map((c) => `<li><code>${esc(c.hash)}</code> ${esc(c.subject)}</li>`))}`);
  if (r.snapshots) H.push(`<p><b>Snapshots:</b> ${r.snapshots} in <code>.epoptes/snapshots.git</code></p>`);
  if (r.artifacts.length) H.push(`<p><b>Artifacts</b></p><ul>${r.artifacts.map((a) => `<li><code>${esc(a.path)}</code>${a.text ? ` · ${esc(a.text)}` : ''}</li>`).join('')}</ul>`);
  H.push('</div>');

  H.push('<h2>Feedback handled</h2><div class="panel">');
  if (!r.feedback.length) H.push('<p class="meta">No feedback was given.</p>');
  else {
    H.push('<table><thead><tr><th>id</th><th>feedback</th><th>status</th><th>closed in</th><th>note</th></tr></thead><tbody>');
    for (const f of r.feedback) H.push(`<tr><td class="mono">${esc(f.id)}</td><td>${esc(f.text)}</td><td class="${f.status === 'done' ? 'ok' : f.status === 'blocked' ? 'bad' : ''}">${esc(f.status.replace('_', ' '))}</td><td>${f.closed_cycle ? `c${f.closed_cycle}` : '–'}</td><td>${esc(f.note ?? '')}</td></tr>`);
    H.push('</tbody></table>');
  }
  H.push('</div>');

  H.push(`<div class="two"><div><h2>Blocked</h2><div class="panel">${list(r.tasks.blocked)}</div></div><div><h2>Cut</h2><div class="panel">${list(r.tasks.cut)}</div></div></div>`);

  if (r.scores.rows.length) {
    H.push(`<h2>Scores</h2><div class="panel"><table><thead><tr><th>cycle</th>${r.scores.criteria.map((c) => `<th class="r">${esc(c)}</th>`).join('')}</tr></thead><tbody>`);
    for (const row of r.scores.rows) H.push(`<tr><td>${row.cycle ?? '–'}${row.milestone ? ` <span class="meta">${esc(row.milestone)}</span>` : ''}</td>${r.scores.criteria.map((c) => `<td class="r">${row.scores[c] ?? '–'}</td>`).join('')}</tr>`);
    H.push('</tbody></table></div>');
  }

  H.push('<h2>Cycles</h2><div class="panel"><table><thead><tr><th class="r">#</th><th>run</th><th>exit</th><th class="r">time</th><th class="r">turns</th><th class="r">cache read</th><th class="r">cost</th></tr></thead><tbody>');
  for (const c of r.cycles) H.push(`<tr><td class="r">${c.cycle}${c.flagged ? ' <span class="flag" title="over twice the median cost">⚠</span>' : ''}</td><td>${esc(c.run)}</td><td class="${c.exit === 'ok' ? 'ok' : c.exit === 'error' || c.exit === 'timeout' ? 'bad' : ''}">${esc(c.exit.replace('_', ' '))}</td><td class="r">${hm(c.duration_s)}</td><td class="r">${c.turns ?? '–'}</td><td class="r">${pct(c.cache_share)}</td><td class="r">${money(c.cost_usd)}</td></tr>`);
  H.push('</tbody></table></div>');

  if (r.problems.length) H.push(`<h2>Problems and warnings</h2><div class="panel"><ul>${r.problems.slice(0, 30).map((x) => `<li>${esc(x.text)}${x.count > 1 ? ` <span class="meta">×${x.count}</span>` : ''}</li>`).join('')}</ul></div>`);
  H.push(`<footer>Built only from recorded data in <code>${esc(r.goal.path)}/.epoptes</code> by Epoptes.</footer></main></body></html>`);
  return H.join('\n');
}

// ---------------------------------------------------------------- across goals

export function renderAllMarkdown(reports: GoalReport[]): string {
  const est = reports.some((r) => r.estimate);
  const L = ['# All goals: report', '', `Generated ${day(nowIso())}${est ? ` · ${ESTIMATE_HEADER}` : ''}`, '', '| goal | state | runs | cycles | active | tasks done | feedback done | cost |', '|---|---|---:|---:|---:|---:|---:|---:|'];
  for (const r of reports) L.push(`| ${mdCell(r.goal.name)} (\`${r.goal.id}\`) | ${r.state} | ${r.runs.length} | ${r.totals.cycles} | ${hm(r.totals.active_s)} | ${r.tasks.done.length} | ${r.feedback.filter((f) => f.status === 'done').length}/${r.feedback.length} | ${usd(r.totals.cost_usd, r.estimate)} |`);
  const total = totalCost(reports.map((r) => r.totals));
  L.push(`| **total** | | ${reports.reduce((a, r) => a + r.runs.length, 0)} | ${reports.reduce((a, r) => a + r.totals.cycles, 0)} | ${hm(reports.reduce((a, r) => a + r.totals.active_s, 0))} | | | **${usd(total, est)}** |`, '');
  const models: Record<string, ModelUsage> = {};
  for (const r of reports) for (const [m, u] of Object.entries(r.totals.models)) {
    const t = (models[m] ??= { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: 0 });
    t.input += u.input; t.output += u.output; t.cache_read += u.cache_read; t.cache_write += u.cache_write; t.cost_usd = totalCost([t, u]);
  }
  L.push('## Tokens and cost by model', '', '| model | input | output | cache read | cache write | cost |', '|---|---:|---:|---:|---:|---:|');
  for (const [m, u] of Object.entries(models)) L.push(`| ${short(m)} | ${tok(u.input)} | ${tok(u.output)} | ${tok(u.cache_read)} | ${tok(u.cache_write)} | ${usd(u.cost_usd, est)} |`);
  L.push('', '---', 'Built only from recorded data in each goal\'s `.epoptes/`.', '');
  return L.join('\n');
}

export function renderAllHtml(reports: GoalReport[]): string {
  const est = reports.some((r) => r.estimate);
  const money = (x: number | null) => (est ? `<span class="est" title="${ESTIMATE_NOTE}">${usd(x, true)}</span>` : usd(x, false));
  const rows = reports.map((r) => `<tr><td>${esc(r.goal.name)} <span class="meta">${esc(r.goal.id)}</span></td><td>${esc(r.state)}</td><td class="r">${r.runs.length}</td><td class="r">${r.totals.cycles}</td><td class="r">${hm(r.totals.active_s)}</td><td class="r">${r.tasks.done.length}</td><td class="r">${r.feedback.filter((f) => f.status === 'done').length}/${r.feedback.length}</td><td class="r">${money(r.totals.cost_usd)}</td></tr>`).join('');
  const total = totalCost(reports.map((r) => r.totals));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>All goals · Epoptes report</title><style>${CSS}</style></head><body><main>
<h1>All goals</h1><p class="meta">Generated ${day(nowIso())}${est ? ` · ${ESTIMATE_HEADER}` : ''}</p>
<div class="tiles"><div class="tile"><div class="k">Goals</div><div class="v">${reports.length}</div></div><div class="tile"><div class="k">Cycles</div><div class="v">${reports.reduce((a, r) => a + r.totals.cycles, 0)}</div></div><div class="tile"><div class="k">Active time</div><div class="v">${hm(reports.reduce((a, r) => a + r.totals.active_s, 0))}</div></div><div class="tile"><div class="k">Cost</div><div class="v">${money(total)}</div></div></div>
<h2>Goals</h2><div class="panel"><table><thead><tr><th>goal</th><th>state</th><th class="r">runs</th><th class="r">cycles</th><th class="r">active</th><th class="r">tasks done</th><th class="r">feedback done</th><th class="r">cost</th></tr></thead><tbody>${rows}</tbody></table></div>
<footer>Built only from recorded data in each goal's <code>.epoptes/</code> by Epoptes.</footer></main></body></html>`;
}
