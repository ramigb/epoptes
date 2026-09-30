import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { nowIso } from '../fsx.ts';
import type { Limits } from '../status.ts';
import type { Activity, Adapter, Cycle, CycleHooks, CycleResult, CycleSpec } from './types.ts';

interface Parser {
  feed(message: unknown): { activity: Activity[]; warn: string[]; limits: Limits | null };
  result(meta: { startedAt: string; endedAt: string; code: number | null; signal: string | null; stderrTail: string }): CycleResult;
}

/** Shared JSONL capture and process lifecycle for installed CLIs. */
export function startCli(spec: CycleSpec, hooks: CycleHooks, { bin, args, env, stdin }: ReturnType<Adapter['command']>, parser: Parser): Cycle {
  fs.mkdirSync(spec.cycleDir, { recursive: true });
  const startedAt = nowIso();
  const raw = fs.createWriteStream(path.join(spec.cycleDir, 'stream.jsonl'));
  const errFile = fs.createWriteStream(path.join(spec.cycleDir, 'stderr.log'));
  // Own process group, so kill() takes tools and subagents down too.
  const child = spawn(bin, args, { cwd: spec.cwd, env, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: true });
  let stderrTail = '';
  child.stdin?.on('error', () => {}); // an early CLI exit can close stdin before the prompt is sent
  child.stdin?.end(stdin);

  const rl = readline.createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    raw.write(line + '\n');
    let m: unknown;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    const { activity, warn, limits } = parser.feed(m);
    for (const a of activity) hooks.activity(a);
    for (const w of warn) hooks.warn(w);
    if (limits) hooks.limits(limits);
  });
  child.stderr!.on('data', (d: Buffer) => {
    errFile.write(d);
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });

  const signal = (sig: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(sig === 'SIGKILL' ? -child.pid : child.pid, sig);
    } catch {
      // already gone
    }
  };

  const done = new Promise<CycleResult>((resolve) => {
    let settled = false;
    const finish = (code: number | null, sig: string | null) => {
      if (settled) return;
      settled = true;
      rl.close();
      raw.end();
      errFile.end();
      const tail = stderrTail.trim().split('\n').slice(-5).join(' | ');
      resolve(parser.result({ startedAt, endedAt: nowIso(), code, signal: sig, stderrTail: tail }));
    };
    child.on('error', (e) => {
      stderrTail += `\n${e.message}`;
      finish(null, null);
    });
    // 'close' waits for stdout to drain, so the last result line is parsed first.
    child.on('close', (code, sig) => finish(code, sig));
  });

  return { pid: child.pid, interrupt: () => signal('SIGINT'), kill: () => signal('SIGKILL'), done };
}
