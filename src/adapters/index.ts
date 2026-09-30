import { claudeCode } from './claude-code.ts';
import { codex } from './codex.ts';
import type { Adapter } from './types.ts';

export const adapters: Record<string, Adapter> = { 'claude-code': claudeCode, codex };
