// Small file helpers. Snapshots are written atomically (tmp + rename); logs are single-line appends.
import fs from 'node:fs';
import path from 'node:path';

export const nowIso = (ms = Date.now()) => new Date(ms).toISOString();
export const epochS = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`${file}: ${(e as Error).message}`);
  }
}

export function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function writeText(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function appendJsonl(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + '\n');
}

/** Reads a JSONL file, skipping lines that don't parse (e.g. a line being written right now). */
export function readJsonl<T>(file: string): T[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // partial or corrupt line
    }
  }
  return out;
}

export const exists = (file: string) => fs.existsSync(file);

export function touch(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

export function rm(file: string) {
  fs.rmSync(file, { force: true });
}

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number) => Atomics.wait(sleepBuf, 0, 0, ms);

/** Runs fn while holding an O_EXCL lock file. A lock older than staleMs is taken over. */
export function withLock<T>(file: string, fn: () => T, { waitMs = 5000, staleMs = 10000 } = {}): T {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(file, 'wx'));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > staleMs) rm(file);
      } catch {
        // removed by its owner meanwhile
      }
      if (Date.now() > deadline) throw new Error(`lock busy: ${file}`);
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    rm(file);
  }
}

/** "2h", "90m", "1h30m", "45s" → seconds. */
export function parseDuration(s: string): number {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s.trim());
  if (!m || !s.trim() || (!m[1] && !m[2] && !m[3])) throw new Error(`bad duration "${s}" (use e.g. 2h, 30m, 1h30m)`);
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** Seconds → "3h07m" (or "-0h12m"). */
export function hm(s: number): string {
  const sign = s < 0 ? '-' : '';
  const m = Math.round(Math.abs(s) / 60);
  return `${sign}${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}
