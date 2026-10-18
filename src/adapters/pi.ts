// Adapter for the user's installed pi coding agent (`pi --mode json`), with whatever provider it is set up for.
// Event facts this relies on are recorded in docs/spec.md (verified on pi 1.3.0).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowIso, readJson, writeJson } from '../fsx.ts';
import { guardRules } from './pi-guard.ts';
import { startCli } from './process.ts';
import type { Activity, Adapter, Cycle, CycleResult, CycleSpec, ModelUsage } from './types.ts';

const BIN = process.env.EPOPTES_PI_BIN ?? 'pi';
const GUARD = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './pi-guard.ts' : './pi-guard.js', import.meta.url));
const RATE_LIMIT_TEXT = /rate.?limit|too many requests|overloaded|\b(429|529)\b/i;
const clip = (s: string, n = 120) => s.replace(/\s+/g, ' ').trim().slice(0, n);

// pi tool names → the names the dashboard already knows from Claude Code.
const TOOL_NAMES: Record<string, string> = { bash: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', grep: 'Grep', find: 'Glob', ls: 'LS' };

export class PiStreamParser {
  private cwd: string;
  private model: string;
  private budgetUsd: number | null;
  private onBudget: () => void;
  private session: string | null = null;
  private turns = 0;
  private settled = false;
  private aborted = false;
  private stop: string | null = null;
  private error: string | null = null;
  private overBudget = false;
  private cost = 0;
  private models: Record<string, ModelUsage> = {};

  constructor(cwd: string, model: string, budgetUsd: number | null = null, onBudget: () => void = () => {}) {
    this.cwd = cwd;
    this.model = model || 'pi-configured';
    this.budgetUsd = budgetUsd;
    this.onBudget = onBudget;
  }

  feed(m: any) {
    const activity: Activity[] = [];
    const warn: string[] = [];
    const add = (kind: Activity['kind'], summary: string, extra = {}) =>
      activity.push({ ts: nowIso(), agent: 'orchestrator', kind, summary: clip(summary), ...extra });
    if (m?.type === 'session') {
      this.session = m.id ?? null;
      add('init', `${this.model} · pi`);
    } else if (m?.type === 'tool_execution_start') {
      const tool = TOOL_NAMES[m.toolName] ?? String(m.toolName ?? 'tool');
      const args = m.args ?? {};
      if (typeof args.path === 'string') {
        const file = path.isAbsolute(args.path) ? path.relative(this.cwd, args.path) : args.path;
        add('tool', file, { tool, path: file });
      } else {
        add('tool', String(args.command ?? args.pattern ?? Object.values(args).find((v) => typeof v === 'string') ?? tool), { tool });
      }
    } else if (m?.type === 'tool_execution_end' && m.isError) {
      const text = (m.result?.content ?? []).map((c: any) => c?.text ?? '').join(' ');
      if (text.includes('epoptes guard')) warn.push(clip(`pi tried a denied ${m.toolName} call: ${text}`, 300));
    } else if (m?.type === 'message_end' && m.message?.role === 'assistant') {
      const msg = m.message;
      this.stop = msg.stopReason ?? null;
      this.error = msg.stopReason === 'error' || msg.stopReason === 'aborted' ? String(msg.errorMessage ?? `pi stopped: ${msg.stopReason}`) : null;
      const u = msg.usage;
      if (u) {
        const key = msg.model || this.model;
        const into = (this.models[key] ??= { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: 0 });
        // pi reports cached input separately from input, as Epoptes stores it.
        into.input += u.input ?? 0;
        into.output += u.output ?? 0;
        into.cache_read += u.cacheRead ?? 0;
        into.cache_write += u.cacheWrite ?? 0;
        into.cost_usd = (into.cost_usd ?? 0) + (u.cost?.total ?? 0);
        this.cost += u.cost?.total ?? 0;
      }
      const text = (msg.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join(' ');
      if (text.trim()) add('text', text);
      if (this.error) add('result', this.error);
      if (msg.stopReason === 'length') warn.push('pi stopped a response at the model output limit');
      if (this.budgetUsd != null && this.cost > this.budgetUsd && !this.overBudget) {
        this.overBudget = true;
        add('result', `cost ≈$${this.cost.toFixed(2)} passed max_budget_usd $${this.budgetUsd}; stopping the cycle`);
        this.onBudget();
      }
    } else if (m?.type === 'turn_end') {
      this.turns++;
    } else if (m?.type === 'auto_retry_start') {
      add('text', `retry ${m.attempt ?? '?'}/${m.maxAttempts ?? '?'}: ${m.errorMessage ?? ''}`);
    } else if (m?.type === 'auto_retry_end' && m.success === false) {
      this.error = String(m.finalError ?? this.error ?? 'pi retries failed');
    } else if (m?.type === 'agent_settled') {
      this.settled = true;
      this.aborted = Boolean(m.aborted);
      add('result', `${this.aborted ? 'aborted' : this.error ? 'failed' : 'settled'} · ${this.turns} turns · ≈$${this.cost.toFixed(2)}`);
    }
    return { activity, warn, limits: null };
  }

  result(meta: { startedAt: string; endedAt: string; code: number | null; signal: string | null; stderrTail: string }): CycleResult {
    // JSON mode exits 0 after a failed response, so success needs a settled run whose last response didn't fail.
    const ok = meta.code === 0 && !meta.signal && this.settled && !this.aborted && !this.error && this.stop !== null && !this.overBudget;
    const reason = this.overBudget
      ? `cost ≈$${this.cost.toFixed(2)} passed max_budget_usd $${this.budgetUsd}`
      : this.error ?? `exit ${meta.code ?? '-'}${meta.signal ? ` (${meta.signal})` : ''}${meta.stderrTail ? `: ${meta.stderrTail}` : ''}${!this.settled ? ' (run never settled)' : ''}`;
    const limited = !ok && !this.overBudget && RATE_LIMIT_TEXT.test(`${this.error ?? ''} ${meta.stderrTail}`);
    const priced = Object.keys(this.models).length > 0;
    return {
      adapter: 'pi', started_at: meta.startedAt, ended_at: meta.endedAt,
      duration_s: Math.round((Date.parse(meta.endedAt) - Date.parse(meta.startedAt)) / 1000),
      exit: ok ? 'ok' : this.overBudget ? 'error' : meta.signal ? 'interrupted' : limited ? 'rate_limited' : 'error',
      turns: this.turns || null, session_id: this.session,
      // pi prices tokens from its model catalog; it is not a bill.
      cost_usd: priced ? this.cost : null, cost_basis: 'estimate',
      models: this.models,
      rate_limit: limited ? { status: 'rejected', resets_at: null, windows: {} } : null,
      error: ok ? null : clip(reason, 500),
    };
  }
}

function commandFor(spec: CycleSpec) {
  if (spec.permissionMode !== 'default') throw new Error('pi permission_mode must be "default"; pi has no sandbox or approval modes');
  fs.mkdirSync(spec.cycleDir, { recursive: true });
  const settings: any = (spec.settingsFile && readJson(spec.settingsFile)) || {};
  const guardFile = path.join(spec.cycleDir, 'pi-guard.json');
  writeJson(guardFile, { rules: guardRules(settings.permissions?.deny ?? []) });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.env)) if (v !== undefined) env[k] = v;
  env.EPOPTES_PI_GUARD = guardFile;
  return {
    bin: BIN,
    // The session file lands in the cycle directory, so `pi --session <file>` can reopen any cycle.
    args: ['--mode', 'json', '--session-dir', spec.cycleDir, '-e', GUARD,
      ...(spec.model ? ['--model', spec.model] : []),
      ...(spec.effort ? ['--thinking', spec.effort] : []),
      ...spec.args],
    env, stdin: spec.prompt,
  };
}

export const pi: Adapter = {
  id: 'pi',
  check() {
    return new Promise((resolve) => {
      execFile(BIN, ['--version'], { timeout: 20000 }, (err, stdout) => {
        resolve(err ? { ok: false, problem: `\`${BIN} --version\` failed: ${err.message}. Is pi installed and on PATH?` } : { ok: true, version: `pi ${stdout.trim()}` });
      });
    });
  },
  command: commandFor,
  start(spec, hooks) {
    let cycle: Cycle | undefined;
    const parser = new PiStreamParser(spec.cwd, spec.model, spec.budgetUsd, () => cycle?.interrupt());
    cycle = startCli(spec, hooks, commandFor(spec), parser);
    return cycle;
  },
};
