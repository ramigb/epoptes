// Immediate, lightweight, read-only reply when the human comments on a card.
// Runs asynchronously using the goal's configured adapter (no file edits, no clock changes, does not clear `waiting`),
// so the user gets a plain-English answer right away even if actual code work starts in the next cycle.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { boardMilestones, commentCard, currentEpic, readBoard, type Card } from './board.ts';
import { loadGoal, type Goal } from './goal.ts';
import type { GoalPaths } from './paths.ts';

const QUICK_REPLY_TIMEOUT_MS = 60_000;

/** Active quick replies keyed by `<goalId>:<cardId>` so the dashboard can show "Answering…" and avoid duplicates. */
const inflight = new Map<string, Promise<string | null>>();

export function replyingCards(goalId: string): string[] {
  const prefix = `${goalId}:`;
  const out: string[] = [];
  for (const k of inflight.keys()) if (k.startsWith(prefix)) out.push(k.slice(prefix.length));
  return out;
}

function readText(file: string, maxChars = 4000): string {
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    return s.length > maxChars ? `${s.slice(0, maxChars)}\n…(truncated)` : s;
  } catch {
    return '';
  }
}

export function buildQuickReplyPrompt(goal: Goal, card: Card, milestoneLabel: string, handoff: string): string {
  const thread = card.comments
    .slice(-12)
    .map((m) => `- ${m.by === 'user' ? 'Human' : m.by}${m.cycle ? ` (c${m.cycle})` : ''}: ${m.text}`)
    .join('\n');

  return [
    `You are Epoptes replying immediately to a human's comment on card ${card.id} in goal "${goal.name}".`,
    'You are in READ-ONLY quick-reply mode: do NOT run tools, edit files, or claim you made code changes.',
    'Write in plain, concise, digestible language for someone who may not know the internal code.',
    '',
    'Rules:',
    '- Answer the human\'s latest comment directly and concretely (under 150 words).',
    '- If the card is blocked or waiting on the human, spell out clearly what they need to do or decide (in short steps or questions).',
    '- If they asked for code or plan changes, acknowledge what they want and note that the next cycle will pick up the work.',
    '- If their comment is unclear or lacks detail, ask a short clarifying question instead of guessing.',
    '- Output ONLY the reply text (no preamble like "Here is a reply:").',
    '',
    `Goal objective: ${goal.objective}`,
    milestoneLabel ? `Milestone: ${milestoneLabel}` : '',
    `Card ${card.id} [${card.column}]: ${card.title}`,
    card.blocked ? `Blocked reason: ${card.blocked}` : '',
    card.approval ? `Approval asked: ${card.approval.text}${card.approval.decision ? ` (${card.approval.decision})` : ' (pending)'}` : '',
    '',
    'Comment thread:',
    thread || '(none)',
    handoff ? `\nLatest handoff (for context):\n${handoff}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function runProcess(bin: string, args: string[], cwd: string, stdinText?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: [stdinText !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, QUICK_REPLY_TIMEOUT_MS);
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      stderr += e.message;
      finish(1);
    });
    child.on('close', (code) => finish(code));
    if (stdinText !== undefined && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdinText);
    }
  });
}

function extractReply(adapterType: Goal['adapter']['type'], stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  if (adapterType === 'claude-code') return trimmed;
  if (adapterType === 'codex') {
    const msgs: string[] = [];
    for (const line of trimmed.split('\n')) {
      try {
        const m = JSON.parse(line);
        if (m.type === 'item.completed' && m.item?.type === 'agent_message' && typeof m.item.text === 'string') msgs.push(m.item.text);
      } catch {
        // ignore non-json
      }
    }
    return msgs.at(-1)?.trim() || null;
  }
  if (adapterType === 'pi') {
    let last = '';
    for (const line of trimmed.split('\n')) {
      try {
        const m = JSON.parse(line);
        if (m.type === 'message_end' && m.message?.role === 'assistant' && Array.isArray(m.message.content)) {
          const text = m.message.content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n').trim();
          if (text) last = text;
        }
      } catch {
        // ignore
      }
    }
    return last || null;
  }
  if (adapterType === 'antigravity') {
    let delta = '';
    for (const line of trimmed.split('\n')) {
      try {
        const m = JSON.parse(line);
        if (m.event === 'result' && typeof m.result?.response === 'string' && m.result.response.trim()) return m.result.response.trim();
        if (m.event === 'step_update' && m.step_update?.step_type === 'agent_response' && typeof m.step_update.text_delta === 'string') {
          delta += m.step_update.text_delta;
        }
      } catch {
        // ignore
      }
    }
    return delta.trim() || null;
  }
  return trimmed;
}

async function invokeAdapter(goal: Goal, cwd: string, prompt: string): Promise<string | null> {
  if (process.env.EPOPTES_QUICK_REPLY_CMD) {
    const res = await runProcess('sh', ['-c', process.env.EPOPTES_QUICK_REPLY_CMD], cwd, prompt);
    return res.code === 0 ? res.stdout.trim() || null : null;
  }
  switch (goal.adapter.type) {
    case 'claude-code': {
      const bin = process.env.EPOPTES_CLAUDE_BIN ?? 'claude';
      const res = await runProcess(bin, ['-p', prompt, '--model', 'haiku', '--permission-mode', 'default', '--permission-prompts', 'none', '--output-format', 'text', '--tools', ''], cwd);
      return res.code === 0 ? extractReply('claude-code', res.stdout) : null;
    }
    case 'codex': {
      const bin = process.env.EPOPTES_CODEX_BIN ?? 'codex';
      const res = await runProcess(bin, ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-c', 'approval_policy="never"', '-'], cwd, prompt);
      return res.code === 0 ? extractReply('codex', res.stdout) : null;
    }
    case 'pi': {
      const bin = process.env.EPOPTES_PI_BIN ?? 'pi';
      const args = ['--mode', 'json', '--no-tools', ...(goal.adapter.model ? ['--model', goal.adapter.model] : [])];
      const res = await runProcess(bin, args, cwd, prompt);
      return res.code === 0 ? extractReply('pi', res.stdout) : null;
    }
    case 'antigravity': {
      const bin = process.env.EPOPTES_AGY_BIN ?? 'agy';
      const res = await runProcess(bin, ['--output-format', 'stream-json', '--model', 'flash', `-p=${prompt}`], cwd);
      return res.code === 0 ? extractReply('antigravity', res.stdout) : null;
    }
  }
}

/**
 * Generates an immediate plain-English reply to the latest human comment on `cardId` and posts it as a
 * `quick_reply: true` comment on the card. Safe to call in the background; never throws.
 */
export function triggerQuickReply(p: GoalPaths, goalId: string, cardId: string, onDone?: () => void): boolean {
  if (process.env.EPOPTES_NO_QUICK_REPLY === '1') return false;
  const key = `${goalId}:${cardId}`;
  if (inflight.has(key)) return true;

  const task = (async () => {
    try {
      const goal = loadGoal(p);
      const board = readBoard(p);
      const card = board.cards.get(cardId);
      if (!card) return null;
      const ms = card.milestone ? boardMilestones(board, currentEpic(p)).find((m) => m.id === card.milestone) : null;
      const msLabel = ms ? (ms.title ? `${ms.title} (${ms.id})${ms.description ? ` — ${ms.description}` : ''}` : ms.id) : '';
      const handoff = readText(path.join(p.state, 'handoff.md'));
      const prompt = buildQuickReplyPrompt(goal, card, msLabel, handoff);
      const reply = await invokeAdapter(goal, p.project, prompt);
      if (reply) {
        commentCard(p, cardId, reply, 'epoptes', null, false, true);
      }
      return reply;
    } catch {
      return null;
    } finally {
      inflight.delete(key);
      onDone?.();
    }
  })();

  inflight.set(key, task);
  return true;
}
