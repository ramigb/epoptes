import { appendJsonl, nowIso, readJsonl } from './fsx.ts';
import type { GoalPaths } from './paths.ts';

export type EventSrc = 'runner' | 'orchestrator' | 'user';

export interface EpoptesEvent {
  ts: string;
  run: string | null;
  cycle: number | null;
  src: EventSrc;
  type: string;
  [payload: string]: unknown;
}

export function emit(
  p: GoalPaths,
  ev: { src: EventSrc; type: string; run?: string | null; cycle?: number | null; [payload: string]: unknown },
) {
  const { src, type, run = null, cycle = null, ...payload } = ev;
  appendJsonl(p.events, { ts: nowIso(), run, cycle, src, type, ...payload });
}

export const readEvents = (p: GoalPaths) => readJsonl<EpoptesEvent>(p.events);
