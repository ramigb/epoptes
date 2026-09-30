// Adapter for the user's installed and logged-in Codex CLI (`codex exec --json`).
import { execFile } from 'node:child_process';
import path from 'node:path';
import { nowIso } from '../fsx.ts';
import { startCli } from './process.ts';
import type { Activity, Adapter, CycleResult, CycleSpec, ModelUsage } from './types.ts';

const BIN = process.env.EPOPTES_CODEX_BIN ?? 'codex';
const RATE_LIMIT_TEXT = /rate.?limit|usage limit|too many requests|\b429\b/i;
const clip = (s: string, n = 120) => s.replace(/\s+/g, ' ').trim().slice(0, n);

export class CodexStreamParser {
  private model: string;
  private cwd: string;
  private session: string | null = null;
  private turns = 0;
  private completed = false;
  private error: string | null = null;
  private usage: ModelUsage | null = null;

  constructor(cwd: string, model: string) {
    this.cwd = cwd;
    this.model = model || 'codex-configured';
  }

  feed(m: any) {
    const activity: Activity[] = [];
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
      if (item?.type === 'command_execution' && m.type === 'item.started') {
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
    return { activity, warn: [], limits: null };
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
  return {
    bin: BIN,
    args: ['exec', '--json', '--skip-git-repo-check', '--sandbox', spec.permissionMode,
      '-c', 'approval_policy="never"',
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
    return startCli(spec, hooks, commandFor(spec), new CodexStreamParser(spec.cwd, spec.model));
  },
};
