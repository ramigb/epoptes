import os from 'node:os';
import path from 'node:path';

/** ~/.epoptes, or $EPOPTES_HOME (used by tests). */
export const epoptesHome = () => process.env.EPOPTES_HOME ?? path.join(os.homedir(), '.epoptes');

export type GoalPaths = ReturnType<typeof goalPaths>;

/** Every file of a goal, from its project directory (the parent of .epoptes/). */
export function goalPaths(project: string) {
  project = path.resolve(project);
  const root = path.join(project, '.epoptes');
  const run = path.join(root, 'run');
  const cycles = path.join(root, 'cycles');
  return {
    project,
    root,
    goal: path.join(root, 'goal.json'),
    agents: path.join(root, 'agents'),
    settings: path.join(root, 'settings.json'),
    inbox: path.join(root, 'FEEDBACK.md'),
    state: path.join(root, 'state'),
    feedback: path.join(root, 'feedback.jsonl'),
    feedbackLock: path.join(root, '.feedback.lock'),
    events: path.join(root, 'events.jsonl'),
    snapshots: path.join(root, 'snapshots.git'),
    gitignore: path.join(root, '.gitignore'),
    run,
    status: path.join(run, 'status.json'),
    clock: path.join(run, 'clock.json'),
    control: path.join(run, 'control.json'),
    lock: path.join(run, 'runner.lock'),
    done: path.join(run, 'DONE'),
    wrapup: path.join(run, 'WRAPUP'),
    runnerLog: path.join(run, 'runner.log'),
    cycles,
    cycleDir: (n: number) => path.join(cycles, String(n).padStart(6, '0')),
  };
}
