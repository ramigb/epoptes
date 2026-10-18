// A pi extension that enforces the deny rules of .epoptes/settings.json, because pi has no sandbox or approvals.
// The pi adapter loads this file with `-e` and points EPOPTES_PI_GUARD at the cycle's pi-guard.json.
// It is a tripwire for the obvious forms (`git push`, `cd x && git push`, `cat .env` via read), not a security boundary.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface GuardRule {
  tool: string;
  pattern: string | null;
  rule: string;
}

// Claude Code permission names → pi built-in tool names.
const TOOLS: Record<string, string[]> = { Bash: ['bash'], Read: ['read'], Edit: ['edit'], Write: ['write'], Grep: ['grep'], Glob: ['find'], LS: ['ls'] };

/** Parses `Tool` and `Tool(pattern)` deny entries; entries for tools pi doesn't have are dropped. */
export function guardRules(deny: string[]): GuardRule[] {
  const out: GuardRule[] = [];
  for (const rule of deny) {
    const m = /^(\w+)(?:\((.*)\))?$/.exec(rule.trim());
    if (!m) continue;
    for (const tool of TOOLS[m[1]] ?? []) out.push({ tool, pattern: m[2] ?? null, rule });
  }
  return out;
}

const escape = (s: string) => s.replace(/[.+^${}()|[\]\\?]/g, '\\$&');

/** `git push *` also matches a bare `git push`, as in Claude Code. */
function commandRegex(pattern: string) {
  const body = escape(pattern).replace(/ \*$/, '(?: .*)?').replace(/\*/g, '.*');
  return new RegExp(`^${body}$`, 's');
}

function pathRegex(pattern: string, cwd: string, home: string) {
  let p = pattern;
  if (p.startsWith('~/')) p = path.join(home, p.slice(2));
  else if (p.startsWith('//')) p = p.slice(1);
  else if (!p.startsWith('/')) p = path.join(cwd, p);
  const body = escape(p).replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*');
  return new RegExp(`^${body}$`);
}

/** The command and each part of it joined by `&&`, `||`, `;`, `|` or newlines, minus leading VAR=value assignments. */
function commandParts(command: string) {
  const parts = [command, ...command.split(/&&|\|\||[;|\n]/)];
  return parts.map((s) => s.trim().replace(/^(?:\w+=\S*\s+)+/, '')).filter(Boolean);
}

/** Returns the deny rule a tool call breaks, or null. */
export function deniedBy(rules: GuardRule[], toolName: string, input: any, cwd: string, home = os.homedir()): string | null {
  for (const r of rules) {
    if (r.tool !== toolName) continue;
    if (r.pattern === null || r.pattern === '*') return r.rule;
    if (toolName === 'bash') {
      const re = commandRegex(r.pattern);
      if (typeof input?.command === 'string' && commandParts(input.command).some((c) => re.test(c))) return r.rule;
    } else if (typeof input?.path === 'string') {
      const target = path.resolve(cwd, input.path.replace(/^~(?=\/|$)/, home));
      if (pathRegex(r.pattern, cwd, home).test(target)) return r.rule;
    }
  }
  return null;
}

export default function epoptesGuard(pi: any) {
  const file = process.env.EPOPTES_PI_GUARD;
  const rules: GuardRule[] = file ? JSON.parse(fs.readFileSync(file, 'utf8')).rules : [];
  pi.on('tool_call', (event: any) => {
    const rule = deniedBy(rules, event.toolName, event.input, process.cwd());
    if (rule) return { block: true, reason: `Blocked by the epoptes guard: ${rule} is denied in .epoptes/settings.json. Do not try to work around it; record it in the handoff instead.` };
  });
}
