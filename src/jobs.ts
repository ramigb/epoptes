// Jobs: one harness, several pieces of work over time. A job is a window of the goal's history between two `job`
// events; `epoptes job new` archives the finished job's working state and opens the next window. What carries
// over (roles, permissions, lessons, decisions) stays where it is.
import fs from 'node:fs';
import path from 'node:path';
import * as control from './control.ts';
import { emit, readEvents, type EpoptesEvent } from './events.ts';
import { isOpen, readFeedback, type FeedbackItem } from './feedback.ts';
import { readJson, writeJson, writeText } from './fsx.ts';
import { loadGoal, type Goal } from './goal.ts';
import { goalPaths } from './paths.ts';
import { LIVE_STATES, reconcile } from './status.ts';

export interface Job {
  id: string;
  title: string;
  /** window start (the `job` event), or null for history before the first one */
  from: string | null;
  /** window end (the next `job` event), or null for the current job */
  to: string | null;
  current: boolean;
  /** where its state was archived, relative to .epoptes/ (finished jobs only) */
  archive: string | null;
}

/** The jobs in a goal's history, oldest first; the last one is current. A goal that never started a job has one. */
export function jobsOf(events: EpoptesEvent[], goal: Goal): Job[] {
  const marks = events.filter((e) => e.type === 'job' && typeof e.id === 'string');
  if (!marks.length) return [{ id: goal.job?.id ?? 'job-1', title: goal.job?.title ?? goal.name, from: null, to: null, current: true, archive: null }];
  const jobs: Job[] = [];
  if (events.some((e) => e.type !== 'job' && e.ts < marks[0].ts)) {
    jobs.push({ id: String(marks[0].previous ?? 'job-1'), title: String(marks[0].previous_title ?? 'first job'), from: null, to: marks[0].ts, current: false, archive: (marks[0].archived as string) ?? null });
  }
  marks.forEach((m, i) => {
    const next = marks[i + 1];
    jobs.push({ id: String(m.id), title: String(m.title ?? m.id), from: m.ts, to: next?.ts ?? null, current: !next, archive: (next?.archived as string) ?? null });
  });
  return jobs;
}

export const inJob = (ts: string, job: Pick<Job, 'from' | 'to'>) => (!job.from || ts >= job.from) && (!job.to || ts < job.to);

/** Resolves `current`, `all`, a job id, or nothing (current) to a job window; null means the whole history. */
export function pickJob(jobs: Job[], which: string | null | undefined): Job | null {
  if (which === 'all') return null;
  if (!which || which === 'current') return jobs.at(-1)!;
  const j = jobs.find((x) => x.id === which);
  if (!j) throw new Error(`no job "${which}" (jobs: ${jobs.map((x) => x.id).join(', ')})`);
  return j;
}

/** Where a job's state files are: state/ for the current job (or the whole history), its archive for a finished one. */
export function jobStateDir(root: string, job: Job | null): string {
  const state = path.join(root, 'state');
  if (!job || job.current || !job.archive) return state;
  const dir = path.join(root, job.archive);
  return fs.existsSync(dir) ? dir : state;
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'job';

/** Working state of one job; everything else in state/ (lessons, decisions) is harness memory and carries over. */
export const JOB_FILES = ['backlog.md', 'handoff.md', 'progress.md', 'scores.jsonl'];

export interface NewJob {
  id: string;
  title: string;
  previous: string;
  archived: string[];
  archiveDir: string;
  openFeedback: FeedbackItem[];
}

/**
 * Starts the next job in the same harness: archives the current job's working state, writes fresh files, resets the
 * clock (so the next start is a new run without --new-run), records the job in goal.json and marks the boundary
 * with a `job` event. Refused while a runner is live.
 */
export function newJob(project: string, title: string, idArg?: string): NewJob {
  const p = goalPaths(project);
  title = title.trim();
  if (!title) throw new Error('usage: epoptes job new "<title>" [--id <slug>]');
  const goal = loadGoal(p);
  const s = reconcile(p);
  if (LIVE_STATES.includes(s.state)) throw new Error(`can't start a new job while ${s.state}: pause or stop it first`);

  const jobs = jobsOf(readEvents(p), goal);
  const prev = jobs.at(-1)!;
  let id = slug(idArg ?? title);
  const taken = (x: string) => jobs.some((j) => j.id === x) || fs.existsSync(path.join(p.state, 'archive', x));
  for (let n = 2; taken(id); n++) id = `${slug(idArg ?? title)}-${n}`;

  // Archive the finished job's working state.
  let archiveDir = path.join(p.state, 'archive', prev.id);
  for (let n = 2; fs.existsSync(archiveDir); n++) archiveDir = path.join(p.state, 'archive', `${prev.id}-${n}`);
  const archived: string[] = [];
  for (const f of JOB_FILES) {
    const src = path.join(p.state, f);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.renameSync(src, path.join(archiveDir, f));
    archived.push(f);
  }
  const rel = path.relative(p.root, archiveDir);
  writeText(path.join(p.state, 'backlog.md'), [
    `# Backlog: ${title}`,
    '',
    '**Current milestone: M1**   (the orchestrator moves this line forward)',
    '',
    '**Markers:** `[ ]` todo · `[~]` in progress · `[x]` done · `[blocked: why]` · `[cut]`',
    '**Notes:** IDs are stable; new tasks get the next free number. Parallel tasks must own separate files.',
    '',
    '## Feedback (from `epoptes feedback`)',
    '',
    '## Review fixes',
    '',
  ].join('\n'));
  writeText(path.join(p.state, 'handoff.md'), `# Handoff\nNew job: ${title}. Nothing of it exists yet; start with the first tasks of M1 in backlog.md.\nThe previous job (${prev.title}) is archived in .epoptes/${rel}/: read it only if this job builds on it.\n`);
  writeText(path.join(p.state, 'progress.md'), '# Progress\nOne row per round, newest at the bottom.\n\n| cycle | elapsed | tasks | result | note |\n|---|---|---|---|---|\n');

  // A new job is a new run: clear the clock and the end markers.
  if (s.state !== 'idle' || fs.existsSync(p.clock)) control.resetClock(project);

  const raw = readJson<Record<string, unknown>>(p.goal)!;
  writeJson(p.goal, { ...raw, job: { id, title } });
  loadGoal(p); // still valid
  emit(p, { src: 'user', type: 'job', id, title, previous: prev.id, previous_title: prev.title, archived: rel });
  return { id, title, previous: prev.id, archived, archiveDir: rel, openFeedback: [...readFeedback(p).values()].filter(isOpen) };
}
