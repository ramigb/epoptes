// Adapter for the user's installed and logged-in Codex CLI (`codex exec --json`).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nowIso } from '../fsx.ts';
import type { Limits } from '../status.ts';
import { agentsFromDir } from './claude-code.ts';
import { startCli } from './process.ts';
import type { Activity, Adapter, CycleResult, CycleSpec, ModelUsage } from './types.ts';

const BIN = process.env.EPOPTES_CODEX_BIN ?? 'codex';
const RATE_LIMIT_TEXT = /rate.?limit|usage limit|too many requests|\b429\b/i;
const clip = (s: string, n = 120) => s.replace(/\s+/g, ' ').trim().slice(0, n);
const LIMITS_EVERY_MS = 30_000;
const WINDOW_NAMES: Record<number, string> = { 300: 'five_hour', 10080: 'seven_day' };

/** Codex plan usage from a session log's `rate_limits` (primary and secondary windows, used_percent 0–100). */
export function normalizeCodexLimits(rl: any): Limits {
  const windows: Limits['windows'] = {};
  let rejectedReset: string | null = null;
  for (const w of [rl?.primary, rl?.secondary]) {
    if (!w || typeof w.used_percent !== 'number') continue;
    const minutes = Number(w.window_minutes ?? 0);
    const resets = typeof w.resets_at === 'number' ? new Date(w.resets_at * 1000).toISOString() : null;
    windows[WINDOW_NAMES[minutes] ?? `${Math.round(minutes / 60)}h`] = { utilization: w.used_percent / 100, resets_at: resets };
    if (w.used_percent >= 100) rejectedReset ??= resets;
  }
  const rejected = Object.values(windows).some((w) => w.utilization >= 1);
  return { status: rejected ? 'rejected' : 'allowed', resets_at: rejectedReset, windows, at: nowIso(), source: 'codex' };
}

/**
 * `codex exec --json` doesn't stream plan usage, but the session log it writes does
 * (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<thread id>.jsonl`). Returns its newest rate_limits, if any.
 */
export function readCodexLimits(threadId: string, home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')): Limits | null {
  const sessions = path.join(home, 'sessions');
  const newest = (dir: string) => {
    try {
      return fs.readdirSync(dir).sort().reverse().slice(0, 2).map((d) => path.join(dir, d));
    } catch {
      return [];
    }
  };
  // The log sits under the local date the session started; look in the two newest days.
  const days = newest(sessions).flatMap(newest).flatMap(newest).sort().reverse().slice(0, 2);
  for (const day of days) {
    let file: string | undefined;
    try {
      file = fs.readdirSync(day).find((f) => f.endsWith(`${threadId}.jsonl`));
    } catch {
      continue;
    }
    if (!file) continue;
    const lines = fs.readFileSync(path.join(day, file), 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      try {
        const rl = JSON.parse(lines[i])?.payload?.rate_limits;
        if (rl) return normalizeCodexLimits(rl);
      } catch {
        // a line still being written
      }
    }
    return null;
  }
  return null;
}

export class CodexStreamParser {
  private model: string;
  private cwd: string;
  private session: string | null = null;
  private turns = 0;
  private completed = false;
  private error: string | null = null;
  private usage: ModelUsage | null = null;
  private limitsReadAt = 0;
  private codexHome: string | undefined;

  constructor(cwd: string, model: string, codexHome?: string) {
    this.cwd = cwd;
    this.model = model || 'codex-configured';
    this.codexHome = codexHome;
  }

  /** Plan usage from the session log: at the end of a turn, and every 30 s while one runs. */
  private limits(force: boolean): Limits | null {
    if (!this.session || (!force && Date.now() - this.limitsReadAt < LIMITS_EVERY_MS)) return null;
    this.limitsReadAt = Date.now();
    try {
      return readCodexLimits(this.session, this.codexHome);
    } catch {
      return null;
    }
  }

  feed(m: any) {
    const activity: Activity[] = [];
    const warn: string[] = [];
    const add = (kind: Activity['kind'], summary: string, extra = {}) =>
      activity.push({ ts: nowIso(), agent: 'orchestrator', kind, summary: clip(summary), ...extra });
    if (m?.type === 'thread.started') {
      this.session = m.thread_id ?? null;
      add('init', `${this.model} · codex`);
    } else if (m?.type === 'turn.started') {
      this.completed = false;
      this.error = null;
    } else if (m?.type === 'turn.completed') {
      // A completed turn outranks a transient error reported earlier in the same turn.
      this.completed = true;
      this.error = null;
      this.turns++;
      if (m.usage) {
        this.usage ??= { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: null };
        const cached = m.usage.cached_input_tokens ?? 0;
        // Codex includes cached tokens in input_tokens; Epoptes stores them separately.
        this.usage.input += Math.max(0, (m.usage.input_tokens ?? 0) - cached);
        this.usage.cache_read += cached;
        this.usage.output += m.usage.output_tokens ?? 0;
      }
      add('result', 'turn completed');
    } else if (m?.type === 'turn.failed' || m?.type === 'error') {
      this.error = String(m.error?.message ?? m.message ?? 'Codex failed');
      add('result', this.error);
    } else if (m?.type === 'item.started' || m?.type === 'item.completed') {
      const item = m.item;
      // Codex reports a role file it can't load (bad model, missing file) as an error item and carries on without it.
      if (item?.type === 'error' && m.type === 'item.completed') warn.push(clip(String(item.message ?? 'Codex error'), 300));
      else if (item?.type === 'collab_tool_call' && m.type === 'item.started') {
        add('tool', [item.tool, item.prompt].filter(Boolean).join(' · '), { tool: 'Agent' });
      } else if (item?.type === 'command_execution' && m.type === 'item.started') {
        add('tool', item.command ?? '', { tool: 'Bash' });
      } else if (item?.type === 'file_change' && m.type === 'item.completed') {
        for (const change of item.changes ?? []) {
          if (typeof change.path !== 'string') continue;
          const file = path.isAbsolute(change.path) ? path.relative(this.cwd, change.path) : change.path;
          add('tool', `${change.kind ?? 'update'} ${file}`, { tool: 'Edit', path: file });
        }
      } else if (item?.type === 'mcp_tool_call' && m.type === 'item.started') {
        add('tool', `${item.server ?? 'mcp'} · ${item.tool ?? 'tool'}`, { tool: item.tool ?? 'MCP' });
      } else if (item?.type === 'web_search' && m.type === 'item.completed') {
        add('tool', item.query ?? '', { tool: 'WebSearch' });
      } else if (item?.type === 'agent_message' && m.type === 'item.completed') {
        add('text', item.text ?? '');
      }
    }
    return { activity, warn, limits: this.limits(m?.type === 'turn.completed') };
  }

  result(meta: { startedAt: string; endedAt: string; code: number | null; signal: string | null; stderrTail: string }): CycleResult {
    const ok = meta.code === 0 && !meta.signal && this.completed && !this.error;
    const error = ok ? null : clip(this.error ?? `exit ${meta.code ?? '-'}${meta.signal ? ` (${meta.signal})` : ''}${meta.stderrTail ? `: ${meta.stderrTail}` : ''}${!this.completed ? ' (no completed turn)' : ''}`, 500);
    const limited = !ok && RATE_LIMIT_TEXT.test(`${this.error ?? ''} ${meta.stderrTail}`);
    return {
      adapter: 'codex', started_at: meta.startedAt, ended_at: meta.endedAt,
      duration_s: Math.round((Date.parse(meta.endedAt) - Date.parse(meta.startedAt)) / 1000),
      exit: ok ? 'ok' : meta.signal ? 'interrupted' : limited ? 'rate_limited' : 'error',
      turns: this.turns || null, session_id: this.session,
      cost_usd: null, cost_basis: 'estimate',
      models: this.usage ? { [this.model]: this.usage } : {},
      rate_limit: limited ? { status: 'rejected', resets_at: null, windows: {} } : null,
      error,
    };
  }
}

function commandFor(spec: CycleSpec) {
  if (spec.budgetUsd != null) throw new Error('Codex does not support cycle.max_budget_usd; set it to null');
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(spec.permissionMode)) {
    throw new Error('Codex permission_mode must be read-only, workspace-write or danger-full-access');
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.env)) if (v !== undefined) env[k] = v;
  // Role files become Codex custom agents for this cycle only: a TOML per role, registered with -c, nothing written to the project.
  const roles: string[] = [];
  const roleDir = path.join(spec.cycleDir, 'codex-agents');
  for (const [name, a] of Object.entries(agentsFromDir(spec.agentsDir))) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`role name "${name}" must be letters, digits, - or _ for Codex`);
    fs.mkdirSync(roleDir, { recursive: true });
    const file = path.join(roleDir, `${name}.toml`);
    // JSON strings are valid TOML basic strings.
    fs.writeFileSync(file, [
      a.model && `model = ${JSON.stringify(a.model)}`,
      a.effort && `model_reasoning_effort = ${JSON.stringify(a.effort)}`,
      `developer_instructions = ${JSON.stringify(a.prompt)}`,
    ].filter(Boolean).join('\n') + '\n');
    roles.push('-c', `agents.${name}.description=${JSON.stringify(a.description)}`, '-c', `agents.${name}.config_file=${JSON.stringify(file)}`);
  }
  return {
    bin: BIN,
    args: ['exec', '--json', '--skip-git-repo-check', '--sandbox', spec.permissionMode,
      '-c', 'approval_policy="never"', ...roles,
      ...(spec.model ? ['--model', spec.model] : []),
      ...(spec.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(spec.effort)}`] : []),
      ...spec.args, '-'],
    env, stdin: spec.prompt,
  };
}

export const codex: Adapter = {
  id: 'codex',
  check() {
    return new Promise((resolve) => {
      execFile(BIN, ['--version'], { timeout: 20000 }, (err, stdout) => {
        resolve(err ? { ok: false, problem: `\`${BIN} --version\` failed: ${err.message}. Is Codex installed and on PATH?` } : { ok: true, version: stdout.trim() });
      });
    });
  },
  command: commandFor,
  start(spec, hooks) {
    return startCli(spec, hooks, commandFor(spec), new CodexStreamParser(spec.cwd, spec.model, spec.env.CODEX_HOME));
  },
};
