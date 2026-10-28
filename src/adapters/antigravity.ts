// Adapter for the user's installed and logged-in Antigravity CLI (`agy -p --output-format stream-json`).
// Event facts this relies on are recorded in docs/spec.md (verified on agy 1.4.9).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from '../fsx.ts';
import { agentsFromDir } from './claude-code.ts';
import { startCli } from './process.ts';
import type { Activity, Adapter, CycleResult, CycleSpec, ModelUsage, UsageSoFar } from './types.ts';

const BIN = process.env.EPOPTES_AGY_BIN ?? 'agy';
const RATE_LIMIT_TEXT = /rate.?limit|quota|resource.?exhausted|too many requests|\b429\b/i;
const MODES = ['accept-edits', 'auto', 'skip-permissions'];
const clip = (s: string, n = 120) => s.replace(/\s+/g, ' ').trim().slice(0, n);

// agy tool names → the names the dashboard already knows from Claude Code.
const TOOL_NAMES: Record<string, string> = {
  run_command: 'Bash', read_file: 'Read', view_file: 'Read', write_file: 'Write', write_to_file: 'Write',
  replace_file_content: 'Edit', multi_replace_file_content: 'Edit', sed_file: 'Edit', grep_search: 'Grep',
  find_by_name: 'Glob', list_dir: 'LS', search_web: 'WebSearch', read_url_content: 'WebFetch', invoke_subagent: 'Agent',
};

// Claude tool names in role files → agy's. agy gives a subagent no tools unless listed; Claude's default is all of them.
// A name missing from agy's subagent registry stops the subagent from starting (command_status and send_command_input are).
const AGY_TOOLS: Record<string, string[]> = {
  Read: ['view_file', 'read_file'], LS: ['list_dir'], Glob: ['find_by_name'], Grep: ['grep_search'],
  Bash: ['run_command'], Edit: ['replace_file_content', 'multi_replace_file_content'],
  Write: ['write_to_file', 'write_file'], WebSearch: ['search_web'], WebFetch: ['read_url_content'],
};

/** Role files → agy custom subagents in <cycle>/.agents/agents, a folder the cycle adds to its workspace. */
function writeRoles(spec: CycleSpec): boolean {
  const roles = Object.entries(agentsFromDir(spec.agentsDir));
  if (!roles.length) return false;
  const dir = path.join(spec.cycleDir, '.agents', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, a] of roles) {
    const tools = [...new Set(((a.tools as string[] | undefined) ?? Object.keys(AGY_TOOLS)).flatMap((t) => AGY_TOOLS[t.replace(/\(.*$/, '')] ?? []))];
    // JSON strings are valid YAML double-quoted scalars. effort and maxTurns have no agy equivalent.
    const front = [`name: ${JSON.stringify(name)}`, `description: ${JSON.stringify(a.description)}`, a.model && `model: ${JSON.stringify(a.model)}`,
      'mainAgent: false', `tools: [${tools.map((t) => JSON.stringify(t)).join(', ')}]`].filter(Boolean);
    fs.writeFileSync(path.join(dir, `${name}.md`), `---\n${front.join('\n')}\n---\n${a.prompt}\n`);
  }
  return true;
}

export class AgyStreamParser {
  private cwd: string;
  private model: string;
  private session: string | null = null;
  private turns = 0;
  private text = '';
  private final: any = null;
  private models: Record<string, ModelUsage> = {};

  constructor(cwd: string, model: string) {
    this.cwd = cwd;
    this.model = model || 'antigravity-configured';
  }

  private add(u: any) {
    const into = (this.models[this.model] ??= { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: null });
    const cached = u.cache_read_tokens ?? 0;
    // Like the Gemini API, input_tokens is taken to include the cached part; Epoptes stores them separately. Thinking bills as output.
    into.input += Math.max(0, (u.input_tokens ?? 0) - cached);
    into.cache_read += cached;
    into.output += (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0);
  }

  feed(m: any) {
    const activity: Activity[] = [];
    const warn: string[] = [];
    let usage: UsageSoFar | null = null;
    const add = (kind: Activity['kind'], summary: string, extra = {}) =>
      activity.push({ ts: nowIso(), agent: 'orchestrator', kind, summary: clip(summary), ...extra });
    if (m?.event === 'init') {
      this.session = m.conversation_id ?? null;
      if (m.init?.model) this.model = m.init.model;
      add('init', `${this.model} · antigravity`);
    } else if (m?.event === 'step_update') {
      const s = m.step_update ?? {};
      if (s.step_type === 'tool' && s.state === 'ACTIVE') {
        const tool = TOOL_NAMES[s.tool_name] ?? String(s.tool_name ?? 'tool');
        const args = s.tool_info?.parameters ?? {};
        const p = args.Path ?? args.AbsolutePath ?? args.TargetFile ?? args.DirectoryPath;
        if (typeof p === 'string') {
          const file = path.isAbsolute(p) ? path.relative(this.cwd, p) || '.' : p;
          add('tool', file, { tool, path: file });
        } else {
          add('tool', String(args.CommandLine ?? args.TypeName ?? Object.values(args).find((v) => typeof v === 'string') ?? tool), { tool });
        }
      } else if (s.step_type === 'agent_response') {
        this.text += s.text_delta ?? '';
        if (s.state === 'DONE') {
          this.turns++;
          if (this.text.trim()) add('text', this.text);
          this.text = '';
          if (s.usage) {
            this.add(s.usage);
            usage = { models: structuredClone(this.models), cost_usd: null };
          }
        }
      }
    } else if (m?.event === 'result') {
      const r = (this.final = m.result ?? {});
      this.session ||= r.conversation_id || null;
      // The result's usage is the whole conversation's, subagents included; it replaces the per-step sums.
      if (r.usage?.total_tokens) {
        this.models = {};
        this.add(r.usage);
      }
      for (const d of r.denied_actions ?? []) warn.push(`agy auto-denied a ${d.action} call (${d.display_name}); headless mode can't ask, so the cycle stopped`);
      add('result', r.status === 'SUCCESS' && !r.denied_actions?.length ? `done · ${this.turns} responses` : this.error() ?? String(r.status));
    }
    return { activity, warn, limits: null, usage };
  }

  private error(): string | null {
    const r = this.final;
    if (!r) return null;
    if (r.error) return String(r.error);
    // A denied command ends the turn but agy still reports SUCCESS.
    if (r.denied_actions?.length) {
      return `agy auto-denied ${r.denied_actions.map((d: any) => d.action).join(', ')}; allow it in ~/.gemini/antigravity-cli/settings.json (e.g. command(epoptes)) or use permission_mode skip-permissions`;
    }
    return r.status === 'SUCCESS' ? null : `agy status ${r.status}`;
  }

  result(meta: { startedAt: string; endedAt: string; code: number | null; signal: string | null; stderrTail: string }): CycleResult {
    const err = this.error();
    const ok = meta.code === 0 && !meta.signal && this.final?.status === 'SUCCESS' && !err;
    const reason = err ?? `exit ${meta.code ?? '-'}${meta.signal ? ` (${meta.signal})` : ''}${meta.stderrTail ? `: ${meta.stderrTail}` : ''}${!this.final ? ' (no result)' : ''}`;
    const limited = !ok && RATE_LIMIT_TEXT.test(`${err ?? ''} ${meta.stderrTail}`);
    return {
      adapter: 'antigravity', started_at: meta.startedAt, ended_at: meta.endedAt,
      duration_s: Math.round((Date.parse(meta.endedAt) - Date.parse(meta.startedAt)) / 1000),
      exit: ok ? 'ok' : meta.signal ? 'interrupted' : limited ? 'rate_limited' : 'error',
      turns: this.turns || null, session_id: this.session,
      cost_usd: null, cost_basis: 'estimate',
      models: this.models,
      rate_limit: limited ? { status: 'rejected', resets_at: null, windows: {} } : null,
      error: ok ? null : clip(reason, 500),
    };
  }
}

function commandFor(spec: CycleSpec) {
  if (spec.budgetUsd != null) throw new Error('Antigravity does not report costs, so cycle.max_budget_usd must be null');
  if (!MODES.includes(spec.permissionMode)) throw new Error(`Antigravity permission_mode must be ${MODES.join(', ')}`);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.env)) if (v !== undefined) env[k] = v;
  return {
    bin: BIN,
    // agy reads no prompt from stdin in text mode, so it goes in the -p argument, like `claude -p`.
    args: ['--output-format', 'stream-json',
      ...(spec.permissionMode === 'skip-permissions' ? ['--dangerously-skip-permissions'] : ['--mode', spec.permissionMode]),
      ...(spec.model ? ['--model', spec.model] : []),
      ...(spec.effort ? ['--effort', spec.effort] : []),
      ...(writeRoles(spec) ? ['--add-dir', spec.cycleDir] : []),
      ...spec.args, `-p=${spec.prompt}`],
    env,
  };
}

export const antigravity: Adapter = {
  id: 'antigravity',
  check() {
    return new Promise((resolve) => {
      execFile(BIN, ['--version'], { timeout: 20000 }, (err, stdout) => {
        resolve(err ? { ok: false, problem: `\`${BIN} --version\` failed: ${err.message}. Is the Antigravity CLI installed and on PATH?` } : { ok: true, version: `agy ${stdout.trim()}` });
      });
    });
  },
  command: commandFor,
  start(spec, hooks) {
    return startCli(spec, hooks, commandFor(spec), new AgyStreamParser(spec.cwd, spec.model));
  },
};
