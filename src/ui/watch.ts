// Polls one goal's files (inotify doesn't work on WSL's /mnt drives) and reports what changed.
import fs from 'node:fs';
import path from 'node:path';
import type { Activity } from '../adapters/types.ts';
import type { EpoptesEvent } from '../events.ts';
import { ingestInbox, type FeedbackOp } from '../feedback.ts';
import { goalPaths, type GoalPaths } from '../paths.ts';
import { reconcile, type Status } from '../status.ts';
import { JsonlTail } from './tail.ts';

export interface GoalUpdate {
  id: string;
  parts: string[];
  events: EpoptesEvent[];
  feedback: FeedbackOp[];
  activity: Activity[];
  cycle: number;
}

const stamp = (file: string) => {
  try {
    const s = fs.statSync(file);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return '-';
  }
};

export class GoalWatch {
  readonly id: string;
  readonly p: GoalPaths;
  readonly events: JsonlTail<EpoptesEvent>;
  readonly feedback: JsonlTail<FeedbackOp>;
  readonly activity = new JsonlTail<Activity>('', 2000);
  activityCycle = 0;
  status: Status | null = null;
  private stamps = new Map<string, string>();
  private files: Record<string, string>;

  constructor(id: string, project: string) {
    this.id = id;
    this.p = goalPaths(project);
    this.events = new JsonlTail(this.p.events);
    this.feedback = new JsonlTail(this.p.feedback);
    this.files = {
      status: this.p.status,
      clock: this.p.clock,
      goal: this.p.goal,
      control: this.p.control,
      done: this.p.done,
      wrapup: this.p.wrapup,
      inbox: this.p.inbox,
      handoff: path.join(this.p.state, 'handoff.md'),
      backlog: path.join(this.p.state, 'backlog.md'),
      progress: path.join(this.p.state, 'progress.md'),
      cycles: this.p.cycles,
    };
  }

  /** One poll. Returns null when nothing changed. */
  poll(): GoalUpdate | null {
    const parts: string[] = [];
    for (const [name, file] of Object.entries(this.files)) {
      const s = stamp(file);
      if (this.stamps.get(name) !== s) {
        this.stamps.set(name, s);
        parts.push(name);
      }
    }
    if (parts.includes('inbox')) {
      try {
        ingestInbox(this.p);
      } catch {
        // lock busy; next poll
      }
    }
    try {
      this.status = reconcile(this.p);
    } catch {
      this.status = null;
    }
    const cycle = this.status?.cycle ?? 0;
    if (cycle !== this.activityCycle) {
      this.activityCycle = cycle;
      this.activity.setFile(cycle ? path.join(this.p.cycleDir(cycle), 'activity.jsonl') : '');
      parts.push('cycle');
    }
    const events = this.events.read();
    const feedback = this.feedback.read();
    const activity = this.activity.read();
    if (events.length) parts.push('events');
    if (feedback.length) parts.push('feedback');
    if (activity.length) parts.push('activity');
    if (!parts.length) return null;
    return { id: this.id, parts, events, feedback, activity, cycle };
  }
}
