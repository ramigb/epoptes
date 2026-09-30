// Guardrail checks for `epoptes run --dry-run`: leftovers from templates, permissions, secrets, caps.
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './adapters/claude-code.ts';
import { readJson } from './fsx.ts';
import type { Goal } from './goal.ts';
import type { GoalPaths } from './paths.ts';

export interface LintResult {
  problems: string[];
  warnings: string[];
}

// Patterns for common credentials. Matches are reported by file only, never printed.
const SECRET_PATTERNS: [string, RegExp][] = [
  ['an Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['an OpenAI-style API key', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['a GitHub token', /\b(ghp|gho|ghs|ghu)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a private key', /-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/],
  ['a password assignment', /\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"'{}<>]{12,}/i],
];

const REQUIRED_DENY = ['Bash(git push *)', 'Bash(git reset --hard *)', 'Bash(git clean -fdx *)'];

function goalFiles(p: GoalPaths): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!['run', 'cycles', 'snapshots.git'].includes(e.name)) walk(f);
      } else if (/\.(md|json|jsonl|txt)$/.test(e.name)) out.push(f);
    }
  };
  walk(p.root);
  return out;
}

export function lintGoal(p: GoalPaths, goal: Goal): LintResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const rel = (f: string) => path.relative(p.project, f);

  for (const f of goalFiles(p)) {
    const text = fs.readFileSync(f, 'utf8');
    if (/\{\{[^}]*\}\}/.test(text)) problems.push(`${rel(f)} still has {{placeholders}} from the template`);
    if (text.includes('<!-- template:')) problems.push(`${rel(f)} still has "template:" notes; delete them`);
    for (const [what, re] of SECRET_PATTERNS) {
      if (re.test(text)) warnings.push(`${rel(f)} looks like it contains ${what}; keep secrets in a secret manager, not in goal files`);
    }
  }

  if (goal.adapter.type === 'claude-code') {
    const settings = readJson<{ permissions?: { allow?: string[]; deny?: string[] } }>(p.settings);
    if (!settings) warnings.push('no .epoptes/settings.json: cycles run without an allow/deny list');
    else {
      const deny = settings.permissions?.deny ?? [];
      const missing = REQUIRED_DENY.filter((d) => !deny.includes(d));
      if (missing.length) warnings.push(`settings.json deny list is missing ${missing.join(', ')}`);
      const allow = settings.permissions?.allow ?? [];
      const risky = allow.filter((a) => a === 'Bash' || a === 'Bash(*)' || /^Bash\((git push|sudo|rm -rf)/.test(a));
      if (risky.length) warnings.push(`settings.json allows ${risky.join(', ')}; allow narrow commands instead`);
    }
  } else {
    if (fs.existsSync(p.settings)) warnings.push('Codex ignores .epoptes/settings.json; configure permissions with its sandbox and native Codex rules');
    if (goal.adapter.permission_mode === 'danger-full-access') warnings.push('Codex danger-full-access disables sandbox protection; prefer workspace-write');
  }

  try {
    const loop = fs.readFileSync(path.join(p.root, goal.adapter.prompt), 'utf8');
    if (!loop.includes('epoptes event done')) warnings.push(`${goal.adapter.prompt} never runs \`epoptes event done\`, so the run can only end on the clock`);
    if (!loop.includes('epoptes feedback')) warnings.push(`${goal.adapter.prompt} never reads \`epoptes feedback\`, so feedback is ignored`);
  } catch {
    // reported by the dry run itself
  }

  try {
    for (const f of fs.readdirSync(p.agents).filter((x) => x.endsWith('.md') && goal.adapter.type === 'claude-code')) {
      const { data } = parseFrontmatter(fs.readFileSync(path.join(p.agents, f), 'utf8'));
      if (!data.description) problems.push(`agents/${f} has no description (the orchestrator picks roles by it)`);
      if (!data.model) warnings.push(`agents/${f} sets no model; it will inherit the orchestrator's`);
    }
  } catch {
    // no role files is allowed
  }

  for (const [file, max] of Object.entries(goal.state_caps)) {
    try {
      const lines = fs.readFileSync(path.join(p.state, file), 'utf8').trimEnd().split('\n').length;
      if (lines > max) warnings.push(`state/${file} has ${lines} lines (cap ${max})`);
    } catch {
      // not created yet
    }
  }
  if (!goal.approval_required.length) warnings.push('approval_required is empty: nothing will ever wait for you');
  if (goal.done.every((d) => d.verify.type === 'manual')) warnings.push('every done check is manual, so the run can never finish on its own');
  return { problems, warnings };
}
