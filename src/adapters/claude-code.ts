// Adapter for the user's own installed and logged-in Claude Code CLI (`claude -p`, stream-json).
// Stream facts this relies on are recorded in docs/spec.md (verified on claude 2.1.283).
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { nowIso, readJson, writeJson } from '../fsx.ts';
import type { Limits } from '../status.ts';
import type { Activity, Adapter, Cycle, CycleHooks, CycleResult, CycleSpec, ModelUsage } from './types.ts';

const BIN = process.env.EPOPTES_CLAUDE_BIN ?? 'claude';
const RATE_LIMIT_TEXT = /rate.?limit|usage limit|overloaded|too many requests|\b(429|529)\b/i;
const LIMIT_OK = new Set(['allowed', 'allowed_warning']);

// ---------- role files → --agents JSON ----------

export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) data[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return { data, body: m[2] };
}

const LIST_KEYS = new Set(['tools', 'disallowedTools', 'skills']);
const NUMBER_KEYS = new Set(['maxTurns']);

/** Converts .epoptes/agents/*.md (Claude Code agent frontmatter) into the --agents JSON object. */
export function agentsFromDir(dir: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return out;
  }
  for (const f of files) {
    const { data, body } = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
    const name = data.name || f.replace(/\.md$/, '');
    const agent: Record<string, unknown> = { description: data.description ?? '', prompt: body.trim() };
    for (const [k, v] of Object.entries(data)) {
      if (k === 'name' || k === 'description' || v === '') continue;
      agent[k] = LIST_KEYS.has(k) ? v.split(',').map((s) => s.trim()).filter(Boolean) : NUMBER_KEYS.has(k) ? Number(v) : v;
    }
    out[name] = agent;
  }
  return out;
}

// ---------- stream parsing ----------

const clip = (s: string, n = 120) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

const isoFromEpoch = (s: unknown) => (typeof s === 'number' && s > 0 ? new Date(s * 1000).toISOString() : null);

export function normalizeLimits(info: any): Limits {
  const windows: Limits['windows'] = {};
  for (const [name, w] of Object.entries<any>(info?.unifiedWindows ?? {})) {
    windows[name] = { utilization: Number(w?.utilization ?? 0), resets_at: isoFromEpoch(w?.resetsAt) };
  }
  return { status: String(info?.status ?? 'unknown'), resets_at: isoFromEpoch(info?.resetsAt), windows, at: nowIso() };
}

function toolSummary(name: string, input: any, cwd: string): { summary: string; path?: string } {
  const rel = (p: string) => (p.startsWith(cwd + path.sep) ? p.slice(cwd.length + 1) : p);
  const file = input?.file_path ?? input?.notebook_path;
  if (typeof file === 'string') return { summary: rel(file), path: rel(file) };
  switch (name) {
    case 'Bash':
      return { summary: String(input?.description || input?.command || '') };
    case 'Grep':
    case 'Glob':
      return { summary: `${input?.pattern ?? ''}${input?.path ? ` in ${rel(String(input.path))}` : ''}` };
    case 'WebFetch':
      return { summary: String(input?.url ?? '') };
    case 'WebSearch':
    case 'ToolSearch':
      return { summary: String(input?.query ?? '') };
    case 'SendMessage':
      return { summary: `→ ${input?.to ?? '?'}${input?.summary ? `: ${input.summary}` : ''}` };
    case 'Skill':
      return { summary: String(input?.skill ?? '') };
  }
  const first = Object.values(input ?? {}).find((v) => typeof v === 'string');
  return { summary: typeof first === 'string' ? first : name };
}

/** Turns stream-json messages into normalized activity, and remembers what the result needs. */
export class StreamParser {
  init: any = null;
  lastResult: any = null;
  lastLimits: Limits | null = null;
  private labels = new Map<string, string>();
  private cwd: string;
  private requestedMode: string | null;

  constructor(cwd: string, requestedMode: string | null = null) {
    this.cwd = cwd;
    this.requestedMode = requestedMode;
  }

  private label(toolUseId: string, subagentType?: string) {
    let l = this.labels.get(toolUseId);
    if (!l) {
      l = `${subagentType || 'agent'}#${toolUseId.slice(-4)}`;
      this.labels.set(toolUseId, l);
    }
    return l;
  }

  /** Returns the activity lines for one message, plus warnings and a limits update if any. */
  feed(m: any): { activity: Activity[]; warn: string[]; limits: Limits | null } {
    const out: Activity[] = [];
    const warn: string[] = [];
    let limits: Limits | null = null;
    const ts = typeof m?.timestamp === 'string' ? m.timestamp : nowIso();

    if (m?.type === 'system' && m.subtype === 'init') {
      if (!this.init) {
        this.init = m;
        out.push({ ts, agent: 'orchestrator', kind: 'init', summary: clip(`${m.model} · ${m.permissionMode} · claude ${m.claude_code_version ?? '?'}`) });
        if (this.requestedMode && m.permissionMode && m.permissionMode !== this.requestedMode) {
          warn.push(`permission mode is "${m.permissionMode}", but the goal asks for "${this.requestedMode}"`);
        }
      }
    } else if (m?.type === 'system' && m.subtype === 'task_started' && m.tool_use_id) {
      out.push({ ts, agent: this.label(m.tool_use_id, m.subagent_type), kind: 'agent.start', summary: clip(String(m.description ?? '')) });
    } else if (m?.type === 'system' && m.subtype === 'task_notification' && m.tool_use_id) {
      out.push({ ts, agent: this.label(m.tool_use_id), kind: 'agent.end', summary: clip(`${m.status ?? 'ended'}: ${m.summary ?? ''}`) });
    } else if (m?.type === 'assistant' && Array.isArray(m.message?.content)) {
      const agent = m.parent_tool_use_id ? this.label(m.parent_tool_use_id, m.subagent_type) : 'orchestrator';
      for (const b of m.message.content) {
        if (b?.type === 'tool_use') {
          if (b.name === 'Agent' || b.name === 'Task') {
            this.label(b.id, b.input?.subagent_type); // agent.start comes from task_started
            continue;
          }
          const { summary, path: p } = toolSummary(b.name, b.input, this.cwd);
          out.push({ ts, agent, kind: 'tool', tool: b.name, ...(p ? { path: p } : {}), summary: clip(summary || b.name) });
        } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          out.push({ ts, agent, kind: 'text', summary: clip(b.text) });
        }
      }
    } else if (m?.type === 'rate_limit_event') {
      limits = this.lastLimits = normalizeLimits(m.rate_limit_info);
    } else if (m?.type === 'result') {
      this.lastResult = m;
      const cost = typeof m.total_cost_usd === 'number' ? ` · ≈$${m.total_cost_usd.toFixed(2)}` : '';
      out.push({ ts, agent: 'orchestrator', kind: 'result', summary: clip(`${m.subtype ?? 'result'} · ${m.num_turns ?? '?'} turns${cost}`) });
    }
    return { activity: out, warn, limits };
  }

  /** Builds the cycle result from the last `result` event (cumulative totals) and the exit code. */
  result(meta: { startedAt: string; endedAt: string; code: number | null; signal: string | null; stderrTail: string }): CycleResult {
    const r = this.lastResult;
    const models: Record<string, ModelUsage> = {};
    for (const [model, u] of Object.entries<any>(r?.modelUsage ?? {})) {
      models[model] = {
        input: u.inputTokens ?? 0,
        output: u.outputTokens ?? 0,
        cache_read: u.cacheReadInputTokens ?? 0,
        cache_write: u.cacheCreationInputTokens ?? 0,
        cost_usd: typeof u.costUSD === 'number' ? u.costUSD : null,
      };
    }
    const failed = !r || r.is_error || (meta.code !== 0 && meta.code !== null);
    const limitHit = this.lastLimits && !LIMIT_OK.has(this.lastLimits.status);
    const text = `${r?.result ?? ''} ${r?.api_error_status ?? ''} ${meta.stderrTail}`;
    const exit = !failed ? 'ok' : limitHit || RATE_LIMIT_TEXT.test(text) ? 'rate_limited' : 'error';
    let error: string | null = null;
    if (failed) {
      error = r?.is_error
        ? clip(String(r.result ?? r.subtype ?? 'error'), 500)
        : clip(`exit ${meta.code ?? '-'}${meta.signal ? ` (${meta.signal})` : ''}${meta.stderrTail ? `: ${meta.stderrTail}` : ''}`, 500);
    }
    const apiKey = this.init?.apiKeySource;
    return {
      adapter: 'claude-code',
      started_at: meta.startedAt,
      ended_at: meta.endedAt,
      duration_s: Math.round((Date.parse(meta.endedAt) - Date.parse(meta.startedAt)) / 1000),
      exit,
      turns: typeof r?.num_turns === 'number' ? r.num_turns : null,
      session_id: r?.session_id ?? this.init?.session_id ?? null,
      cost_usd: typeof r?.total_cost_usd === 'number' ? r.total_cost_usd : null,
      cost_basis: apiKey && apiKey !== 'none' ? 'billed' : 'estimate',
      models,
      rate_limit: this.lastLimits ? { status: this.lastLimits.status, resets_at: this.lastLimits.resets_at, windows: this.lastLimits.windows } : null,
      error,
    };
  }
}

// ---------- the adapter ----------

function prepare(spec: CycleSpec) {
  fs.mkdirSync(spec.cycleDir, { recursive: true });
  const agentsFile = path.join(spec.cycleDir, 'agents.json');
  writeJson(agentsFile, agentsFromDir(spec.agentsDir));
  // Without defaultMode, a --settings file silently overrides --permission-mode back to "default".
  const settings: any = (spec.settingsFile && readJson(spec.settingsFile)) || {};
  const allow: string[] = settings.permissions?.allow ?? [];
  if (!allow.includes('Bash(epoptes *)')) allow.push('Bash(epoptes *)'); // orchestrators report through the CLI
  settings.permissions = { ...(settings.permissions ?? {}), allow, defaultMode: spec.permissionMode };
  const settingsFile = path.join(spec.cycleDir, 'settings.json');
  writeJson(settingsFile, settings);
  return { agentsFile, settingsFile };
}

function commandFor(spec: CycleSpec) {
  const { agentsFile, settingsFile } = prepare(spec);
  const args = [
    '-p', spec.prompt,
    '--model', spec.model,
    '--effort', spec.effort,
    '--permission-mode', spec.permissionMode,
    '--permission-prompts', 'none',
    '--output-format', 'stream-json',
    '--verbose',
    '--settings', settingsFile,
    '--agents', agentsFile,
    ...(spec.budgetUsd ? ['--max-budget-usd', String(spec.budgetUsd)] : []),
    ...spec.args,
  ];
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.env)) if (v !== undefined) env[k] = v;
  return { bin: BIN, args, env };
}

export const claudeCode: Adapter = {
  id: 'claude-code',

  check() {
    return new Promise((resolve) => {
      execFile(BIN, ['--version'], { timeout: 20000 }, (err, stdout) => {
        if (err) resolve({ ok: false, problem: `\`${BIN} --version\` failed: ${err.message}. Is Claude Code installed and on PATH?` });
        else resolve({ ok: true, version: stdout.trim() });
      });
    });
  },

  command: commandFor,

  start(spec: CycleSpec, hooks: CycleHooks): Cycle {
    const { bin, args, env } = commandFor(spec);
    const startedAt = nowIso();
    const raw = fs.createWriteStream(path.join(spec.cycleDir, 'stream.jsonl'));
    const errFile = fs.createWriteStream(path.join(spec.cycleDir, 'stderr.log'));
    // Own process group, so kill() takes claude's children (tools, subagents) down too.
    const child = spawn(bin, args, { cwd: spec.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const parser = new StreamParser(spec.cwd, spec.permissionMode);
    let stderrTail = '';

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
  },
};

export const adapters: Record<string, Adapter> = { 'claude-code': claudeCode };
