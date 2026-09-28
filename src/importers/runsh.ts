// Imports a dress2impress-style harness (harness/run.sh + clock.mjs, harness/logs, harness/state, FEEDBACK.md)
// into <project>/.epoptes/, so its history shows up in the dashboard and reports. Writes nothing outside .epoptes/.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ModelUsage } from '../adapters/types.ts';
import { appendJsonl, readJson, readJsonl, touch, writeJson } from '../fsx.ts';
import { goalPaths } from '../paths.ts';

interface LogCycle {
  run: number; // 1-based run index
  local: number; // cycle number within that run (as run.sh counted)
  start: string;
  end: string | null;
  mode: string;
  model: string;
  effort: string;
  timeout_s: number;
  rc: number | null;
  timedOut: boolean;
  rateLimitWait: number | null;
}

/** watchdog.log timestamps are local time without a zone, like `[2026-09-27 03:42:38]`. */
const localIso = (s: string) => new Date(s.replace(' ', 'T')).toISOString();

export function parseWatchdog(text: string) {
  const cycles: LogCycle[] = [];
  const finished: { run: number; ts: string; mode: string; done: boolean }[] = [];
  let run = 0;
  let last = 0;
  for (const line of text.split('\n')) {
    const m = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\] (.*)$/.exec(line);
    if (!m) continue;
    const ts = localIso(m[1]);
    const msg = m[2];
    let x: RegExpExecArray | null;
    if ((x = /^cycle (\d+) start: mode=(\w+) ([\w.-]+)\/(\w+) timeout=(\d+)s/.exec(msg))) {
      const n = Number(x[1]);
      if (n <= last || run === 0) run++;
      last = n;
      cycles.push({ run, local: n, start: ts, end: null, mode: x[2], model: x[3], effort: x[4], timeout_s: Number(x[5]), rc: null, timedOut: false, rateLimitWait: null });
    } else if ((x = /^cycle (\d+) end: rc=(\d+)/.exec(msg))) {
      const c = cycles.at(-1);
      if (c && c.local === Number(x[1])) {
        c.end = ts;
        c.rc = Number(x[2]);
      }
    } else if ((x = /^cycle (\d+) hit its timeout/.exec(msg))) {
      const c = cycles.at(-1);
      if (c) c.timedOut = true;
    } else if ((x = /^rate limited: waiting (\d+)s/.exec(msg))) {
      const c = cycles.at(-1);
      if (c) c.rateLimitWait = Number(x[1]);
    } else if ((x = /^finished: mode=(\w+) done=(yes|no)/.exec(msg))) {
      finished.push({ run, ts, mode: x[1], done: x[2] === 'yes' });
      last = Infinity; // the next cycle start begins a new run
    }
  }
  return { cycles, finished, runs: run };
}

/** Where run k's per-cycle JSON lives: harness/logs/run<k>/ if it exists, else harness/logs/ for the latest run. */
function cycleJson(logs: string, run: number, runs: number, local: number) {
  const id = String(local).padStart(3, '0');
  const dirs = [path.join(logs, `run${run}`), ...(run === runs ? [logs] : [])];
  for (const d of dirs) {
    const f = path.join(d, `cycle-${id}.json`);
    if (fs.existsSync(f)) return { json: readJson<any>(f), err: fs.existsSync(path.join(d, `cycle-${id}.err`)) ? fs.readFileSync(path.join(d, `cycle-${id}.err`), 'utf8').trim() : '' };
  }
  return { json: null, err: '' };
}

export interface ImportSummary {
  runs: number;
  cycles: number;
  events: number;
  feedback: number;
  milestones: number;
}

export function importRunSh(project: string, { id, name }: { id?: string; name?: string } = {}): ImportSummary {
  const p = goalPaths(project);
  const h = path.join(p.project, 'harness');
  const logs = path.join(h, 'logs');
  const watchdog = path.join(logs, 'watchdog.log');
  if (!fs.existsSync(watchdog)) throw new Error(`no ${watchdog}: not a run.sh harness`);
  if (fs.existsSync(p.events) || fs.existsSync(p.cycles)) throw new Error(`${p.root} already has Epoptes records; import into a fresh copy`);

  const { cycles, finished, runs } = parseWatchdog(fs.readFileSync(watchdog, 'utf8'));
  const cfg = readJson<any>(path.join(h, 'config.json')) ?? {};
  const clock = readJson<any>(path.join(h, 'state', 'clock.json'));
  const events: any[] = [];
  const ev = (ts: string, run: number | null, cycle: number | null, src: string, type: string, payload: object = {}) =>
    events.push({ ts, run: run ? `r${run}` : null, cycle, src, type, ...payload });

  // Cycles: global numbering across runs, results from the per-cycle JSON, times from watchdog.log.
  const globalOf = new Map<string, number>(); // "run:local" -> global cycle
  cycles.forEach((c, i) => {
    const n = i + 1;
    globalOf.set(`${c.run}:${c.local}`, n);
    if (i === 0 || cycles[i - 1].run !== c.run) ev(c.start, c.run, null, 'runner', 'run.start', { timebox_s: 0, resumed: false });
    ev(c.start, c.run, n, 'runner', 'cycle.start', { mode: c.mode, model: c.model, effort: c.effort, timeout_s: c.timeout_s });
    const { json: r, err } = cycleJson(logs, c.run, runs, c.local);
    const ended = c.end ?? c.start;
    const models: Record<string, ModelUsage> = {};
    for (const [m, u] of Object.entries<any>(r?.modelUsage ?? {})) {
      models[m] = { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cache_read: u.cacheReadInputTokens ?? 0, cache_write: u.cacheCreationInputTokens ?? 0, cost_usd: u.costUSD ?? null };
    }
    const exit = c.timedOut || c.rc === 124 ? 'timeout' : c.rateLimitWait ? 'rate_limited' : c.rc === 0 && !r?.is_error ? 'ok' : 'error';
    const duration = Math.round((Date.parse(ended) - Date.parse(c.start)) / 1000);
    fs.mkdirSync(p.cycleDir(n), { recursive: true });
    writeJson(path.join(p.cycleDir(n), 'result.json'), {
      version: 1, cycle: n, run: `r${c.run}`, adapter: 'claude-code', started_at: c.start, ended_at: ended, duration_s: duration, exit,
      turns: r?.num_turns ?? null, session_id: r?.session_id ?? null, cost_usd: r?.total_cost_usd ?? null, cost_basis: 'estimate', models,
      rate_limit: null, error: exit === 'ok' ? null : (err.split('\n')[0] || (c.timedOut ? 'hit the cycle timeout' : `rc=${c.rc}`)).slice(0, 500),
    });
    ev(ended, c.run, n, 'runner', 'cycle.end', { exit, duration_s: duration, cost_usd: r?.total_cost_usd ?? null, turns: r?.num_turns ?? null });
    if (err) ev(ended, c.run, n, 'runner', 'warn', { text: err.split('\n')[0].slice(0, 300) });
    if (c.rateLimitWait) ev(ended, c.run, n, 'runner', 'wait', { reason: 'rate_limit', seconds: c.rateLimitWait });
    const f = finished.find((x) => x.run === c.run);
    const lastOfRun = i === cycles.length - 1 || cycles[i + 1].run !== c.run;
    if (lastOfRun) {
      if (f?.done) ev(f.ts, c.run, n, 'orchestrator', 'done', { text: `run ${c.run} finished (${f.mode})` });
      ev(f?.ts ?? ended, c.run, n, 'runner', 'run.end', { reason: f?.done ? 'done' : f?.mode === 'stop' ? 'timebox' : 'stopped' });
    }
  });

  // Milestones and releases from git tags, placed in the cycle that was running at that time.
  let milestones = 0;
  try {
    const tags = execFileSync('git', ['-C', p.project, 'tag', '-l', '--format=%(refname:short)\t%(creatordate:iso-strict)\t%(subject)'], { encoding: 'utf8', stdio: 'pipe' });
    for (const line of tags.trim().split('\n').filter(Boolean)) {
      const [tag, date, subject] = line.split('\t');
      const ts = new Date(date).toISOString();
      const idx = cycles.findIndex((c) => c.start <= ts && (c.end ?? c.start) >= ts);
      const near = idx >= 0 ? idx : cycles.reduce((best, c, i) => (c.start <= ts ? i : best), 0);
      const c = cycles[near];
      ev(ts, c?.run ?? null, near + 1, 'orchestrator', 'milestone', { text: `${/^m\d+-done$/.test(tag) ? `${tag.slice(0, -5).toUpperCase()} done` : `release ${tag}`}${subject ? `: ${subject}` : ''}` });
      milestones++;
    }
  } catch {
    // not a git repo
  }

  // Feedback: FEEDBACK.md bullets marked → F-n; closed when the backlog ticks them; the cycle from progress.md.
  const progress = fs.existsSync(path.join(h, 'state', 'progress.md')) ? fs.readFileSync(path.join(h, 'state', 'progress.md'), 'utf8') : '';
  const backlog = fs.existsSync(path.join(h, 'state', 'backlog.md')) ? fs.readFileSync(path.join(h, 'state', 'backlog.md'), 'utf8') : '';
  const cycleForLabel = (label: string) => {
    const m = /^c(\d+)(?:r(\d+))?$/.exec(label);
    return m ? globalOf.get(`${m[2] ? Number(m[2]) : 1}:${Number(m[1])}`) ?? null : null;
  };
  const fbOps: any[] = [];
  const inbox = path.join(p.project, 'FEEDBACK.md');
  if (fs.existsSync(inbox)) {
    for (const line of fs.readFileSync(inbox, 'utf8').split('\n')) {
      const m = /^\s*[-*]\s+(.*?)\s*→\s*(F-\d+)\s*$/.exec(line);
      if (!m) continue;
      const [, text, fid] = m;
      const row = progress.split('\n').find((l) => new RegExp(`\\b${fid}\\b`).test(l));
      const cyc = row ? cycleForLabel(row.split('|')[1].trim()) : null;
      const cr = cyc ? readJson<any>(path.join(p.cycleDir(cyc), 'result.json')) : null;
      const added = cr?.started_at ?? cycles[0].start;
      fbOps.push({ ts: added, op: 'add', id: fid, text, src: 'file' });
      const ticked = new RegExp(`- \\[x\\] ${fid}\\b(.*)`).exec(backlog);
      if (ticked) fbOps.push({ ts: cr?.ended_at ?? added, op: 'status', id: fid, status: 'done', by: 'orchestrator', cycle: cyc, note: ticked[1].trim().slice(0, 200) });
    }
  }
  fbOps.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  for (const o of fbOps) appendJsonl(p.feedback, o);

  // State files carry over as they are; scores.jsonl gets global cycle numbers.
  fs.mkdirSync(p.state, { recursive: true });
  for (const f of ['handoff.md', 'backlog.md', 'progress.md', 'lessons.md', 'decisions.md']) {
    const src = path.join(h, 'state', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(p.state, f));
  }
  let scoreRun = 1;
  let prevCycle = 0;
  for (const s of readJsonl<any>(path.join(h, 'state', 'scores.jsonl'))) {
    if (typeof s.cycle === 'number' && s.cycle < prevCycle) scoreRun++;
    prevCycle = s.cycle ?? prevCycle;
    appendJsonl(path.join(p.state, 'scores.jsonl'), { ...s, cycle: globalOf.get(`${scoreRun}:${s.cycle}`) ?? s.cycle });
  }

  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  for (const e of events) appendJsonl(p.events, e);

  const last = cycles.at(-1)!;
  const lastRunDone = finished.find((f) => f.run === last.run)?.done ?? false;
  writeJson(p.goal, {
    version: 1,
    id: id ?? path.basename(p.project).toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
    name: name ?? path.basename(p.project),
    kind: 'code',
    objective: `Imported from ${path.relative(p.project, h)}/ (run.sh harness): ${cycles.length} cycles over ${runs} runs.`,
    done: [{ id: 'D1', check: 'imported run: see the original harness for its done definition', verify: { type: 'manual' } }],
    non_goals: [],
    approval_required: [],
    timebox: { total_min: Math.round(((clock?.timebox_h ?? 12) * 60)), wrapup_min: Math.round((clock?.wrapup_h ?? 1) * 60), grace_min: clock?.grace_min ?? 45, pause_on_rate_limit: cfg.pause_clock_on_rate_limit ?? true },
    checkpoints: 'git',
    adapter: { type: 'claude-code', prompt: 'loop.md', model: cfg.orchestrator_model ?? 'opus', effort: cfg.orchestrator_effort ?? 'high', permission_mode: 'auto', args: [] },
    cycle: { timeout_min: Math.min(180, Math.max(20, cfg.cycle_timeout_min ?? 90)), pause_between_s: cfg.pause_between_cycles_s ?? 15, max_budget_usd: cfg.max_budget_usd_per_cycle ?? null },
  });
  if (fs.existsSync(path.join(p.project, 'loop.md'))) fs.copyFileSync(path.join(p.project, 'loop.md'), path.join(p.root, 'loop.md'));
  if (clock) writeJson(p.clock, { version: 1, run: `r${last.run}`, started_at: new Date(clock.start * 1000).toISOString(), paused_s: clock.paused_s ?? 0, paused_at: last.end ?? last.start, timebox_s: Math.round(clock.timebox_h * 3600), wrapup_s: Math.round(clock.wrapup_h * 3600), grace_s: Math.round(clock.grace_min * 60) });
  if (lastRunDone) touch(p.done);
  writeJson(p.status, {
    version: 1, state: lastRunDone ? 'done' : 'stopped', pid: null, run: `r${last.run}`, cycle: cycles.length, mode: null, cycle_started_at: null,
    heartbeat_at: last.end, waiting_until: null, wait_reason: null, pause_requested: false, fails_in_row: 0, limits: null, updated_at: last.end ?? last.start,
  });
  fs.writeFileSync(p.gitignore, 'run/\ncycles/\nsnapshots.git/\nreports/\n*.tmp\n.feedback.lock\n');
  return { runs, cycles: cycles.length, events: events.length, feedback: fbOps.filter((o) => o.op === 'add').length, milestones };
}
