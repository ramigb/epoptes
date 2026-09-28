import fs from 'node:fs';
import path from 'node:path';
import { nowIso, readJson, writeJson } from './fsx.ts';
import { loadGoal } from './goal.ts';
import { epoptesHome, goalPaths } from './paths.ts';

export interface Registry {
  version: 1;
  goals: { id: string; path: string; added_at: string }[];
}

const file = () => path.join(epoptesHome(), 'registry.json');

export const readRegistry = (): Registry => readJson<Registry>(file()) ?? { version: 1, goals: [] };

const GITIGNORE = 'run/\ncycles/\nsnapshots.git/\n*.tmp\n.feedback.lock\n';

/** Validates a goal and registers it (idempotent). Creates the runtime folders and .epoptes/.gitignore. */
export function addGoal(project: string) {
  const p = goalPaths(project);
  const goal = loadGoal(p);
  const reg = readRegistry();
  const clash = reg.goals.find((g) => g.id === goal.id && g.path !== p.project);
  if (clash) throw new Error(`goal id "${goal.id}" is already registered for ${clash.path}`);
  for (const d of [p.state, p.run, p.cycles]) fs.mkdirSync(d, { recursive: true });
  if (!fs.existsSync(p.gitignore)) fs.writeFileSync(p.gitignore, GITIGNORE);
  if (!reg.goals.some((g) => g.path === p.project)) {
    reg.goals = reg.goals.filter((g) => g.id !== goal.id);
    reg.goals.push({ id: goal.id, path: p.project, added_at: nowIso() });
  }
  writeJson(file(), reg);
  return goal;
}

/** Finds a project directory from a registry id, a path, $EPOPTES_GOAL_DIR, or the cwd upwards. */
export function resolveGoal(ref?: string): string {
  if (ref) {
    const hit = readRegistry().goals.find((g) => g.id === ref);
    if (hit) return hit.path;
    const dir = path.resolve(ref);
    const project = path.basename(dir) === '.epoptes' ? path.dirname(dir) : dir;
    if (fs.existsSync(goalPaths(project).goal)) return project;
    throw new Error(`no goal "${ref}" (not a registered id, and no .epoptes/goal.json there)`);
  }
  const env = process.env.EPOPTES_GOAL_DIR;
  if (env) return path.basename(env) === '.epoptes' ? path.dirname(env) : env;
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    if (fs.existsSync(goalPaths(dir).goal)) return dir;
    if (path.dirname(dir) === dir) break;
  }
  throw new Error('no goal here: pass a goal id or path, or run inside a project with .epoptes/goal.json');
}
